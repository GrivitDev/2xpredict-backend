import { Injectable, Logger } from '@nestjs/common';

import type {
  FixtureCollectionResult,
  OddsCollectionResult,
  PlaysCollectionResult,
  TeamCatalogueResult,
} from '../interfaces/provider-response.interface';
import { getOddsApiSportKey } from '../config/odds-api-sport-key.map';
import { SPORTS_COLLECTION_SCHEDULE } from '../config/sports-collection-schedule.config';
import type {
  SportsCompetitionRecord,
  SportsFixtureRecord,
  SportsMatchTimelineEventRecord,
  SportsSeasonRecord,
  SportsTeamRecord,
} from '../interfaces/sports-domain.interface';
import type { SportsFixtureReadResult } from '../interfaces/sports-read.interface';
import { SportsCollectionStateService } from './sports-collection-state.service';
import { SportsPersistenceService } from './sports-persistence.service';
import { SportsProviderCollectionService } from './sports-provider-collection.service';
import { SportsOddsCollectionService } from './sports-odds-collection.service';
import { SportsMatchFactsNormalizationService } from './sports-match-facts-normalization.service';

const timestampOf = (value: unknown): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : Number.NaN;
  }
  return Number.NaN;
};

const HOUR = 60 * 60_000;
const STALE_FIXTURE_RECOVERY_AFTER_MS = 4 * HOUR;
const SUMMARY_RECOVERY_COOLDOWN_MS = 6 * HOUR;
const MAX_SUMMARY_RECOVERIES_PER_PASS = 2;

/**
 * Coordinates provider collection, normalization, persistence and freshness state.
 * Scheduling is owned by the durable queue processor, not this service.
 */
@Injectable()
export class SportsDomainCollectionService {
  private readonly logger = new Logger(SportsDomainCollectionService.name);

  constructor(
    private readonly provider: SportsProviderCollectionService,
    private readonly persistence: SportsPersistenceService,
    private readonly state: SportsCollectionStateService,
    private readonly oddsCollection: SportsOddsCollectionService,
    private readonly matchFactsNormalization: SportsMatchFactsNormalizationService,
  ) {}

  async discoverLeagueCatalogue(): Promise<{
    leagueIds: string[];
    endpoint: string;
    totalCount?: number;
    rawResponse?: Record<string, unknown>;
  }> {
    const input = this.stateInput(
      'LEAGUE_CATALOGUE',
      'GLOBAL',
      'ESPN_SOCCER',
      '/leagues',
      7 * 24 * 60 * 60_000,
    );
    await this.state.markStarted(input);
    try {
      const result = await this.provider.discoverLeagueCatalogue();
      await this.state.markSucceeded(
        input,
        result.rawResponse,
        result.endpoint,
      );
      return result;
    } catch (error) {
      await this.state.markFailed(input, error);
      throw error;
    }
  }

  async collectLeagueDetails(
    leagueId: string,
  ): Promise<SportsCompetitionRecord> {
    const input = this.stateInput(
      'LEAGUE_DETAILS',
      'GLOBAL',
      leagueId,
      `/leagues/${leagueId}`,
      7 * 24 * 60 * 60_000,
    );
    await this.state.markStarted(input);
    try {
      const competition = await this.provider.collectLeagueDetails(leagueId);
      await this.persistence.saveCompetitions([competition]);
      await this.state.markSucceeded(input, competition.rawPayload);
      return competition;
    } catch (error) {
      await this.state.markFailed(input, error);
      throw error;
    }
  }

  async getCompetition(
    competitionId: string,
  ): Promise<SportsCompetitionRecord | null> {
    return this.persistence.getCompetitionById(competitionId);
  }

  async getAllCompetitions(): Promise<SportsCompetitionRecord[]> {
    return this.persistence.getAllCompetitions();
  }

  async getAllSeasons(): Promise<SportsSeasonRecord[]> {
    return this.persistence.getAllSeasons();
  }

  async collectSeasonCatalogue(
    leagueId: string,
    competitionId: string,
  ): Promise<{
    items: SportsSeasonRecord[];
    newlyDiscovered: SportsSeasonRecord[];
    endpoint: string;
    rawResponse?: Record<string, unknown>;
  }> {
    const competition =
      await this.persistence.getCompetitionById(competitionId);
    if (!competition)
      throw new Error(
        `Cannot collect seasons: competition ${competitionId} is not persisted.`,
      );
    const input = this.stateInput(
      'SEASON_CATALOGUE',
      'COMPETITION',
      competitionId,
      `/leagues/${leagueId}#current-season`,
      7 * 24 * 60 * 60_000,
    );
    await this.state.markStarted(input);
    try {
      const existing =
        await this.persistence.getAllSeasonsForCompetition(competitionId);
      const result = await this.provider.collectSeasonCatalogue(
        leagueId,
        competition,
      );
      const currentSeason =
        result.items.find(
          (season) => season.year === competition.currentSeasonYear,
        ) ?? result.items.find((season) => season.isCurrent);
      if (!currentSeason) {
        throw new Error(
          `ESPN did not provide a current season for ${leagueId}; historical seasons were not persisted.`,
        );
      }
      const persistedCurrentSeason = { ...currentSeason, isCurrent: true };
      await this.persistence.saveCurrentSeason(persistedCurrentSeason);
      await this.state.markSucceeded(
        input,
        result.rawResponse,
        result.endpoint,
      );
      return {
        items: [persistedCurrentSeason],
        newlyDiscovered: existing.some(
          (season) => season.id === persistedCurrentSeason.id,
        )
          ? []
          : [persistedCurrentSeason],
        endpoint: result.endpoint,
        rawResponse: result.rawResponse,
      };
    } catch (error) {
      await this.state.markFailed(input, error);
      throw error;
    }
  }

  async getSeason(seasonId: string): Promise<SportsSeasonRecord | null> {
    return this.persistence.getSeasonById(seasonId);
  }

  async getSeasonByYear(
    competitionId: string,
    year: number,
  ): Promise<SportsSeasonRecord | null> {
    return this.persistence.getSeasonByYear(competitionId, year);
  }

  async collectTeamCatalogue(
    leagueId: string,
    competitionId: string,
  ): Promise<TeamCatalogueResult> {
    const competition =
      await this.persistence.getCompetitionById(competitionId);
    if (!competition)
      throw new Error(
        `Cannot collect teams: competition ${competitionId} is not persisted.`,
      );
    const input = this.stateInput(
      'TEAM_CATALOGUE',
      'COMPETITION',
      competitionId,
      `/leagues/${leagueId}/seasons/${competition.currentSeasonYear ?? ''}/teams`,
      7 * 24 * 60 * 60_000,
    );
    await this.state.markStarted(input);
    try {
      const result = await this.provider.collectTeamCatalogue(
        leagueId,
        competition,
      );
      // Team membership is season-scoped. Keep only current-season participants
      // attached to this league while preserving memberships in other leagues.
      await this.persistence.reconcileTeamsForLeague(leagueId, result.teamIds);
      await this.state.markSucceeded(
        input,
        result.rawResponse,
        result.endpoint,
      );
      return result;
    } catch (error) {
      await this.state.markFailed(input, error);
      throw error;
    }
  }

  async getTeamsForLeague(leagueId: string): Promise<SportsTeamRecord[]> {
    return this.persistence.getTeamsForLeague(leagueId);
  }

  async collectTeamDetails(
    leagueId: string,
    espnTeamId: string,
    teamReference?: string,
  ): Promise<SportsTeamRecord> {
    const input = this.stateInput(
      'TEAM_DETAILS',
      'TEAM',
      `team:${espnTeamId}`,
      teamReference ?? `/leagues/${leagueId}/teams/${espnTeamId}`,
      30 * 24 * 60 * 60_000,
    );
    await this.state.markStarted(input);
    try {
      const result = await this.provider.collectTeamDetails(
        leagueId,
        espnTeamId,
        teamReference,
      );
      await this.persistence.saveTeams([result]);
      await this.state.markSucceeded(input, result.rawPayload);
      return result;
    } catch (error) {
      await this.state.markFailed(input, error);
      throw error;
    }
  }

  async collectMonthlyFixtures(
    leagueId: string,
    month: string,
    scope: { competitionId: string; seasonId: string; seasonYear: number },
  ): Promise<FixtureCollectionResult> {
    const monthKey = `${scope.seasonId}:${month.replace('-', '')}`;
    const input = this.stateInput(
      'FIXTURE_MONTHLY_BOOTSTRAP',
      'SEASON',
      monthKey,
      `/leagues/${leagueId}/scoreboard?dates=${month.replace('-', '')}`,
      0,
    );
    await this.state.markStarted(input);
    try {
      const result = await this.provider.collectMonthlyFixtures(
        leagueId,
        month,
        scope,
      );
      const unresolved: string[] = [];
      const recovered: SportsFixtureRecord[] = [];
      let retryableFallbackError: unknown;
      for (const rejected of result.rejected) {
        if (!rejected.eventId) {
          unresolved.push(`unknown-event:${rejected.reason}`);
          continue;
        }
        try {
          const summaryFixture = await this.collectFixtureSummary(
            leagueId,
            rejected.eventId,
            scope,
          );
          if (summaryFixture) recovered.push(summaryFixture);
          else unresolved.push(rejected.eventId);
        } catch (error) {
          unresolved.push(rejected.eventId);
          if (this.isRetryableProviderError(error))
            retryableFallbackError ??= error;
        }
      }
      if (recovered.length) result.items.push(...recovered);
      if (unresolved.length) {
        if (retryableFallbackError) throw retryableFallbackError;
        throw new Error(
          `Monthly fixture collection ${leagueId}/${month} has ${unresolved.length} unresolved event(s): ${unresolved.slice(0, 10).join(', ')}.`,
        );
      }
      const saved = await this.persistence.saveFixtures(result.items);
      result.previousStates = saved.previousStates;
      await this.state.markSucceeded(input, undefined, result.endpoint);
      return result;
    } catch (error) {
      await this.state.markFailed(input, error);
      throw error;
    }
  }

  async collectDailyFixtures(
    leagueId: string,
    date: string,
    scope: { competitionId: string; seasonId: string; seasonYear: number },
  ): Promise<FixtureCollectionResult> {
    const input = this.stateInput(
      'FIXTURE_DAILY_SCOREBOARD',
      'COMPETITION',
      `${scope.competitionId}:${scope.seasonId}:${date}`,
      `/leagues/${leagueId}/scoreboard?dates=${date.replace(/-/g, '')}`,
      0,
    );
    await this.state.markStarted(input);
    try {
      const result = await this.provider.collectDailyFixtures(
        leagueId,
        date,
        scope,
      );
      const saved = await this.persistence.saveFixtures(result.items);
      result.previousStates = saved.previousStates;
      await this.state.markSucceeded(input, undefined, result.endpoint);
      return result;
    } catch (error) {
      await this.state.markFailed(input, error);
      throw error;
    }
  }

  async isFixtureSummaryFallbackFresh(
    eventId: string,
    maxAgeMs = 24 * 60 * 60_000,
    requiredAfter?: Date,
  ): Promise<boolean> {
    const state = await this.state.getState(
      'MATCH_SUMMARY_FALLBACK',
      'FIXTURE',
      `fixture:${eventId}`,
    );
    if (state?.status !== 'SUCCEEDED' || !state.lastSuccessfulAt) return false;

    const succeededAt = timestampOf(state.lastSuccessfulAt);
    const startedAt = timestampOf(state.lastStartedAt);
    const requiredAfterAt = timestampOf(requiredAfter);
    const collectionStartedAt = Number.isFinite(startedAt)
      ? startedAt
      : succeededAt;

    return (
      Number.isFinite(succeededAt) &&
      Date.now() >= succeededAt &&
      Date.now() - succeededAt < Math.max(0, maxAgeMs) &&
      (!Number.isFinite(requiredAfterAt) || collectionStartedAt >= requiredAfterAt)
    );
  }

  /**
   * Whether another Summary snapshot is required. A recent success is fresh
   * for maxAgeMs, but when requiredAfter is supplied the successful collection
   * must also have started at or after that boundary (normally full time).
   * Active or recently failed attempts retain their retry cooldown so
   * settlement retries do not hammer ESPN.
   */
  async shouldCollectFixtureSummary(
    eventId: string,
    maxAgeMs = 20 * 60_000,
    retryCooldownMs = 5 * 60_000,
    requiredAfter?: Date,
  ): Promise<boolean> {
    const storedSummary =
      await this.persistence.getMatchSummaryByEventId(eventId);
    const rawCollectedAt = timestampOf(storedSummary?.lastCollectedAt);
    const now = Date.now();
    const requiredAfterAt = timestampOf(requiredAfter);
    const storedSummaryIsRecent =
      Number.isFinite(rawCollectedAt) &&
      now >= rawCollectedAt &&
      now - rawCollectedAt < Math.max(0, maxAgeMs);

    // Preserve the original fast path for callers that do not care about the
    // match lifecycle boundary (for example, generic recovery checks).
    if (storedSummaryIsRecent && !Number.isFinite(requiredAfterAt)) return false;

    const state = await this.state.getState(
      'MATCH_SUMMARY_FALLBACK',
      'FIXTURE',
      `fixture:${eventId}`,
    );
    if (!state) {
      // Legacy snapshots may not have a state-ledger row. Their collection time
      // is the best available signal that the raw payload is post-match.
      return !(
        storedSummaryIsRecent &&
        (!Number.isFinite(requiredAfterAt) || rawCollectedAt >= requiredAfterAt)
      );
    }

    const successfulAt = timestampOf(state.lastSuccessfulAt);
    const startedAt = timestampOf(state.lastStartedAt);
    const collectionStartedAt = Number.isFinite(startedAt)
      ? startedAt
      : successfulAt;
    const successfulAttemptIsAfterBoundary =
      !Number.isFinite(requiredAfterAt) ||
      collectionStartedAt >= requiredAfterAt;
    const successfulStateIsRecent =
      state.status === 'SUCCEEDED' &&
      Number.isFinite(successfulAt) &&
      now >= successfulAt &&
      now - successfulAt < Math.max(0, maxAgeMs) &&
      successfulAttemptIsAfterBoundary;

    if (successfulStateIsRecent) return false;

    // NO_DATA is a completed attempt too; it must not be retried on every monitor pass.
    if (['PROCESSING', 'FAILED', 'NO_DATA'].includes(String(state.status))) {
      const recentAttemptValue =
        state.status === 'PROCESSING'
          ? (state.lastStartedAt ?? state.updatedAt)
          : (state.updatedAt ?? state.lastStartedAt);
      const recentAttemptAt = timestampOf(recentAttemptValue);
      if (
        Number.isFinite(recentAttemptAt) &&
        now >= recentAttemptAt &&
        now - recentAttemptAt < Math.max(0, retryCooldownMs)
      ) {
        return false;
      }
    }
    return true;
  }

  async collectFixtureSummary(
    leagueId: string,
    eventId: string,
    scope: { competitionId: string; seasonId?: string; seasonYear?: number },
  ): Promise<SportsFixtureRecord | null> {
    const input = this.stateInput(
      'MATCH_SUMMARY_FALLBACK',
      'FIXTURE',
      `fixture:${eventId}`,
      `/leagues/${leagueId}/summary?event=${eventId}`,
      0,
    );
    await this.state.markStarted(input);
    try {
      const result = await this.provider.collectFixtureSummary(
        leagueId,
        eventId,
        scope,
      );
      const existingFixture = await this.persistence.getFixtureById(eventId);
      const fixtureId =
        result.fixture?.id ?? existingFixture?.id ?? `fixture:${eventId}`;
      const endpoint = `/leagues/${leagueId}/summary?event=${eventId}`;

      // Persist the complete provider response before attempting fixture fallback persistence.
      const collectedAt = new Date();
      const storedSummary = await this.persistence.saveMatchSummary({
        fixtureId,
        espnEventId: eventId,
        competitionId: scope.competitionId,
        seasonId:
          result.fixture?.seasonId ??
          scope.seasonId ??
          existingFixture?.seasonId,
        seasonYear:
          result.fixture?.seasonYear ??
          scope.seasonYear ??
          existingFixture?.seasonYear,
        endpoint,
        rawPayload: result.rawResponse,
        collectedAt,
      });

      // Normalize the retained Summary independently of fixture normalization.
      // Missing provider sections remain unavailable; they are never coerced to zero.
      await this.matchFactsNormalization.normalizeAndPersist({
        fixtureId,
        espnEventId: eventId,
        competitionId: scope.competitionId,
        seasonId:
          result.fixture?.seasonId ??
          scope.seasonId ??
          existingFixture?.seasonId,
        seasonYear:
          result.fixture?.seasonYear ??
          scope.seasonYear ??
          existingFixture?.seasonYear,
        endpoint,
        sourcePayloadHash: storedSummary.payloadHash,
        sourceRevision: storedSummary.revision,
        sourceCollectedAt: collectedAt,
        rawPayload: result.rawResponse,
        fixture: result.fixture ?? existingFixture,
      });

      await this.normalizeAndPersistOfficialStandings({
        competitionId: scope.competitionId,
        seasonId:
          result.fixture?.seasonId ??
          scope.seasonId ??
          existingFixture?.seasonId,
        endpoint,
        sourcePayloadHash: storedSummary.payloadHash,
        sourceRevision: storedSummary.revision,
        sourceCollectedAt: collectedAt,
        rawPayload: result.rawResponse,
      });

      if (result.fixture) {
        await this.persistence.saveFixtures([result.fixture]);
        await this.state.markSucceeded(input, undefined, endpoint);
      } else {
        await this.state.markNoData(
          input,
          'Raw ESPN Summary was persisted, but the payload could not be normalized into a fixture fallback.',
          endpoint,
          'RAW_SUMMARY_STORED_NORMALIZATION_FAILED',
        );
      }
      return result.fixture;
    } catch (error) {
      await this.state.markFailed(input, error);
      throw error;
    }
  }

  async collectLiveScoreboard(
    leagueId: string,
    scope: { competitionId: string; seasonId?: string; seasonYear?: number },
    date?: string,
  ): Promise<FixtureCollectionResult> {
    const normalizedDate = date?.trim();
    const endpoint = normalizedDate
      ? `/scoreboard?dates=${normalizedDate.replace(/-/g, '')}`
      : '/scoreboard';
    const input = this.stateInput(
      'LIVE_SCOREBOARD',
      'COMPETITION',
      `${scope.competitionId}:${normalizedDate ?? 'CURRENT'}`,
      endpoint,
      2 * 60_000,
    );
    await this.state.markStarted(input);
    try {
      if (
        normalizedDate &&
        !/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)
      ) {
        throw new Error(`Invalid live scoreboard date: ${normalizedDate}`);
      }

      // Read the already-known fixtures for this date once. The same rows are
      // used to detect old matches that ESPN omitted or returned without a
      // final score; normal, complete scoreboard responses need no Summary
      // fallback requests.
      const knownFixtures = normalizedDate
        ? await this.persistence.getFixturesForCompetitionDate(
            scope.competitionId,
            normalizedDate,
          )
        : [];

      const result = await this.provider.collectLiveScoreboard(
        leagueId,
        scope,
        normalizedDate,
      );

      // Persist the date-scoped scoreboard once. Summary fallback persists its
      // own recovered fixture, so including those rows in a second bulk write
      // would duplicate database work for the same match.
      const saved = await this.persistence.saveFixtures(result.items);
      result.previousStates = saved.previousStates;

      const candidates = new Map<
        string,
        { eventId: string; fixture?: SportsFixtureRecord; reason: string }
      >();

      // A malformed scoreboard event can still be recovered from its ESPN
      // Summary. Keep these ahead of general stale-fixture recovery.
      for (const rejected of result.rejected) {
        const eventId = String(rejected.eventId ?? '').trim();
        if (!eventId) {
          this.logger.warn(
            `Live scoreboard ${leagueId}/${normalizedDate ?? 'CURRENT'} rejected an event without an ESPN event ID: ${rejected.reason}`,
          );
          continue;
        }
        const knownFixture = knownFixtures.find(
          (fixture) => fixture.espnEventId === eventId,
        );
        candidates.set(eventId, {
          eventId,
          fixture: knownFixture,
          reason: 'scoreboard event could not be normalized',
        });
      }

      if (normalizedDate && knownFixtures.length) {
        const incomingById = new Map(
          result.items.map((fixture) => [fixture.id, fixture] as const),
        );
        const returnedEventIds = new Set(
          result.items.map((fixture) => fixture.espnEventId),
        );
        const staleBefore = Date.now() - STALE_FIXTURE_RECOVERY_AFTER_MS;
        const staleFixtures = [...knownFixtures].sort(
          (left, right) =>
            timestampOf(left.kickoffAt) - timestampOf(right.kickoffAt),
        );

        for (const storedFixture of staleFixtures) {
          const fixture =
            incomingById.get(storedFixture.id) ?? storedFixture;
          const kickoffAt = timestampOf(fixture.kickoffAt);
          if (!Number.isFinite(kickoffAt) || kickoffAt > staleBefore) continue;

          const state = String(fixture.status?.state ?? 'UNKNOWN');
          if (['POSTPONED', 'CANCELLED', 'ABANDONED'].includes(state)) continue;

          const isCompleted =
            fixture.status?.isFinal === true || state === 'COMPLETED';
          const hasFinalScores =
            Array.isArray(fixture.competitors) &&
            fixture.competitors.length === 2 &&
            fixture.competitors.every(
              (competitor) =>
                competitor.score !== null &&
                competitor.score !== undefined &&
                Number.isFinite(Number(competitor.score)),
            );
          const isMissingFromScoreboard = !returnedEventIds.has(
            fixture.espnEventId,
          );
          const isStillNonTerminal = !isCompleted;
          const isCompletedWithoutScores = isCompleted && !hasFinalScores;

          if (!isStillNonTerminal && !isCompletedWithoutScores) continue;
          if (!fixture.espnEventId) continue;

          const reason = isCompletedWithoutScores
            ? 'completed fixture has an incomplete final score'
            : isMissingFromScoreboard
              ? 'old fixture was omitted from its date-specific scoreboard'
              : 'fixture still has a non-terminal status long after kickoff';

          if (!candidates.has(fixture.espnEventId)) {
            candidates.set(fixture.espnEventId, {
              eventId: fixture.espnEventId,
              fixture,
              reason,
            });
          }
        }
      }

      const recovered: SportsFixtureRecord[] = [];
      const candidateList = [...candidates.values()];
      // Rotate the small recovery sample every six-hour recovery window.
      // A fixture whose Summary cooldown is active therefore cannot occupy
      // the recovery slots forever and starve other stale fixtures.
      const rotation = candidateList.length
        ? (
            Math.floor(Date.now() / SUMMARY_RECOVERY_COOLDOWN_MS) *
            MAX_SUMMARY_RECOVERIES_PER_PASS
          ) % candidateList.length
        : 0;
      const selectedCandidates = candidateList.length
        ? candidateList
            .slice(rotation)
            .concat(candidateList.slice(0, rotation))
            .slice(0, MAX_SUMMARY_RECOVERIES_PER_PASS)
        : [];

      for (const candidate of selectedCandidates) {
        const kickoffAt = candidate.fixture
          ? timestampOf(candidate.fixture.kickoffAt)
          : Number.NaN;
        const completedAt = candidate.fixture?.completedAt
          ? timestampOf(candidate.fixture.completedAt)
          : Number.NaN;
        const requiredAfter = Number.isFinite(completedAt)
          ? new Date(completedAt)
          : Number.isFinite(kickoffAt)
            ? new Date(kickoffAt + 2 * HOUR)
            : undefined;

        // A Summary request is permitted only when no recent post-match
        // snapshot/attempt exists. NO_DATA and FAILED attempts also observe
        // the cooldown, so suspended/omitted fixtures cannot cause a request
        // every time the recurring scoreboard monitor runs.
        const shouldCollect = await this.shouldCollectFixtureSummary(
          candidate.eventId,
          SUMMARY_RECOVERY_COOLDOWN_MS,
          SUMMARY_RECOVERY_COOLDOWN_MS,
          requiredAfter,
        );
        if (!shouldCollect) continue;

        const summaryScope = candidate.fixture
          ? {
              ...scope,
              seasonId: candidate.fixture.seasonId ?? scope.seasonId,
              seasonYear: candidate.fixture.seasonYear ?? scope.seasonYear,
            }
          : scope;
        try {
          const summaryFixture = await this.collectFixtureSummary(
            leagueId,
            candidate.eventId,
            summaryScope,
          );
          if (summaryFixture) {
            recovered.push(summaryFixture);
          } else {
            this.logger.warn(
              `Summary recovery for ${candidate.eventId} did not produce a normalized fixture (${candidate.reason}).`,
            );
          }
        } catch (error) {
          // The date-specific scoreboard itself succeeded. Do not fail and
          // repeat that entire request because an optional Summary fallback
          // failed; the six-hour cooldown and next monitoring pass handle it.
          this.logger.warn(
            `Summary recovery failed for ${candidate.eventId} (${candidate.reason}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      // Summary collection persists its fixture immediately. Include recovered
      // fixtures in this result as well so downstream scheduling sees their
      // newly confirmed state without another database scan.
      const mergedItems = new Map<string, SportsFixtureRecord>();
      for (const fixture of [...result.items, ...recovered]) {
        mergedItems.set(fixture.id, fixture);
      }
      result.items = [...mergedItems.values()];

      await this.state.markSucceeded(input, undefined, result.endpoint);
      return result;
    } catch (error) {
      await this.state.markFailed(input, error);
      throw error;
    }
  }

  async collectMatchOdds(
    fixture: SportsFixtureRecord,
  ): Promise<OddsCollectionResult> {
    if (
      fixture.status.isFinal ||
      fixture.status.state !== 'SCHEDULED' ||
      Date.now() >= fixture.kickoffAt.getTime()
    ) {
      return {
        snapshot: null,
        endpoint: 'pre-match-only',
        fallbackUsed: false,
      };
    }
    const home = fixture.competitors.find((item) => item.homeAway === 'HOME');
    const away = fixture.competitors.find((item) => item.homeAway === 'AWAY');
    if (!home || !away)
      throw new Error(
        `Fixture ${fixture.id} has no home/away team context for odds.`,
      );
    const [homeTeam, awayTeam] = await Promise.all([
      this.persistence.getTeamById(home.teamId),
      this.persistence.getTeamById(away.teamId),
    ]);
    const league = await this.persistence.getCompetitionById(
      fixture.competitionId,
    );
    if (!league)
      throw new Error(
        `Fixture ${fixture.id} references missing competition ${fixture.competitionId}.`,
      );
    const input = this.stateInput(
      'MATCH_ODDS',
      'FIXTURE',
      fixture.id,
      `/leagues/${league.slug}/events/${fixture.espnEventId}/competitions/${fixture.espnCompetitionId ?? fixture.espnEventId}/odds`,
      0,
    );
    await this.state.markStarted(input);
    try {
      const result = await this.oddsCollection.collectFixtureOdds({
        fixtureId: fixture.id,
        homeTeam: homeTeam?.displayName ?? homeTeam?.name ?? home.teamId,
        awayTeam: awayTeam?.displayName ?? awayTeam?.name ?? away.teamId,
        kickoffAt: fixture.kickoffAt,
        espnLeagueId: league.slug,
        espnEventId: fixture.espnEventId,
        espnCompetitionId: fixture.espnCompetitionId ?? fixture.espnEventId,
        oddsApiSportKey: getOddsApiSportKey(league.slug) ?? null,
      });

      if (!result.snapshot) {
        const reason =
          result.reason ||
          `ESPN and configured fallback providers have no usable odds for fixture ${fixture.id}.`;
        // A successfully completed lookup with no published prices is an
        // expected checkpoint outcome, not a failed collection. Do not throw:
        // the next 24h/18h milestone is already queued independently.
        await this.state.markNoData(input, reason, input.endpoint);
        this.logger.debug(
          `Odds checkpoint completed without published prices for ${fixture.id}: ${reason}`,
        );
        return {
          snapshot: null,
          endpoint: input.endpoint,
          fallbackUsed: result.fallbackUsed,
          reason,
        };
      }

      await this.persistence.saveOddsSnapshot(result.snapshot);
      const endpoint = result.snapshot.source.endpoint;
      await this.state.markSucceeded(
        {
          ...input,
          provider: result.provider === 'ODDS_API' ? 'ODDS_API' : 'ESPN',
        },
        undefined,
        endpoint,
      );
      return {
        snapshot: result.snapshot,
        endpoint,
        fallbackUsed: result.fallbackUsed,
      };
    } catch (error) {
      await this.state.markFailed(input, error);
      throw error;
    }
  }

  async collectMatchPlays(
    fixture: SportsFixtureRecord,
  ): Promise<PlaysCollectionResult | null> {
    if (!(fixture.status.isFinal || fixture.status.state === 'COMPLETED'))
      return null;
    const competition = await this.persistence.getCompetitionById(
      fixture.competitionId,
    );
    if (!competition)
      throw new Error(
        `Fixture ${fixture.id} references a missing competition.`,
      );
    const input = this.stateInput(
      'MATCH_PLAYS',
      'FIXTURE',
      fixture.id,
      `/leagues/${competition.slug}/events/${fixture.espnEventId}/competitions/${fixture.espnCompetitionId ?? fixture.espnEventId}/plays`,
      0,
    );
    await this.state.markStarted(input);
    try {
      const result = await this.provider.collectMatchPlays({
        fixtureId: fixture.id,
        leagueId: competition.slug,
        eventId: fixture.espnEventId,
        competitionId: fixture.espnCompetitionId ?? fixture.espnEventId,
      });
      if (result.noDataReason || result.items.length === 0) {
        const reason =
          result.noDataReason ||
          'ESPN Core Plays and Summary returned no normalizable timeline events.';
        await this.state.markNoData(
          input,
          reason,
          result.endpoint,
          'NO_PLAYS_AVAILABLE',
        );
        this.logger.debug(
          `Match Plays checkpoint completed without timeline data for ${fixture.id}: ${reason}`,
        );
        return result;
      }

      if (result.fallbackUsed) {
        // Summary keyEvents may be a partial extract; never prune a previously
        // complete Core Plays timeline with fallback-only facts.
        await this.persistence.saveTimelineEvents(result.items);
      } else {
        await this.persistence.replaceTimelineEvents(fixture.id, result.items);
      }
      await this.state.markSucceeded(input, undefined, result.endpoint);
      return result;
    } catch (error) {
      await this.state.markFailed(input, error);
      throw error;
    }
  }

  async markSeasonMonthlyBootstrapCompleted(
    seasonId: string,
    endpoint: string,
  ): Promise<void> {
    const input = this.stateInput(
      'FIXTURE_MONTHLY_BOOTSTRAP_COMPLETE',
      'SEASON',
      seasonId,
      endpoint,
      0,
    );
    await this.state.markSucceeded(input);
  }

  async isSeasonMonthlyBootstrapComplete(seasonId: string): Promise<boolean> {
    const state = await this.state.getSeasonMonthlyBootstrapState(seasonId);
    return state?.status === 'SUCCEEDED';
  }

  async isMonthlyFixtureMonthCollected(
    seasonId: string,
    month: string,
  ): Promise<boolean> {
    const scopeId = `${seasonId}:${month.replace('-', '')}`;
    const state = await this.state.getState(
      'FIXTURE_MONTHLY_BOOTSTRAP',
      'SEASON',
      scopeId,
    );
    return state?.status === 'SUCCEEDED';
  }

  async isDailyValidationComplete(
    competitionId: string,
    seasonId: string,
    date: string,
  ): Promise<boolean> {
    const state = await this.state.getFixtureDayValidation(
      competitionId,
      seasonId,
      date,
    );
    return [
      'FIXTURES_FOUND',
      'NO_FIXTURES_CONFIRMED',
      'RECOVERED_FROM_SUMMARY',
    ].includes(String(state?.validationResult));
  }

  async isSeasonDailyValidationComplete(
    competitionId: string,
    seasonId: string,
    fixedEndDate?: string,
  ): Promise<boolean> {
    const season = await this.persistence.getSeasonById(seasonId);
    if (!season) return false;
    if (!season.startDate) return false;
    const start = new Date(
      Date.UTC(
        new Date(season.startDate).getUTCFullYear(),
        new Date(season.startDate).getUTCMonth(),
        new Date(season.startDate).getUTCDate(),
      ),
    );
    const rawEnd = fixedEndDate
      ? new Date(`${fixedEndDate}T00:00:00.000Z`)
      : (season.endDate ?? (season.isCurrent ? new Date() : undefined));
    if (!rawEnd) return false;
    const endDate = new Date(rawEnd);
    const end = new Date(
      Date.UTC(
        endDate.getUTCFullYear(),
        endDate.getUTCMonth(),
        endDate.getUTCDate(),
      ),
    );
    const existingFixtureDates = new Set(
      await this.persistence.getFixtureDateKeysForSeason(
        competitionId,
        seasonId,
      ),
    );
    const validatedDates = new Set(
      await this.state.getSeasonValidatedDates(competitionId, seasonId),
    );
    // Bootstrap validation is required only for dates with zero persisted
    // fixtures. Dates that already contain fixtures are reconciled by their
    // scheduled date-level refresh jobs (48h, 18h and post-match).
    for (
      const cursor = new Date(start);
      cursor <= end;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      const date = cursor.toISOString().slice(0, 10);
      if (!existingFixtureDates.has(date) && !validatedDates.has(date))
        return false;
    }
    return true;
  }

  async hasCollectedMatchPlays(fixtureId: string): Promise<boolean> {
    const state = await this.state.getState(
      'MATCH_PLAYS',
      'FIXTURE',
      fixtureId,
    );
    return state?.status === 'SUCCEEDED';
  }

  /**
   * A successful Summary keyEvents fallback is useful partial evidence, but it
   * is not proof that the complete Core Plays collection was obtained.
   */
  async hasCompleteMatchPlays(fixtureId: string): Promise<boolean> {
    const state = await this.state.getState(
      'MATCH_PLAYS',
      'FIXTURE',
      fixtureId,
    );
    return (
      state?.status === 'SUCCEEDED' &&
      /\/plays(?:[?#]|$)/i.test(String(state.endpoint ?? ''))
    );
  }

  /**
   * Permit Settlement to accelerate missing Plays evidence while suppressing
   * duplicate provider calls during active/recent attempts. Summary-only
   * fallback collections remain eligible for a later Core Plays retry.
   */
  async shouldCollectMatchPlays(
    fixtureId: string,
    retryCooldownMs = 30 * 60_000,
  ): Promise<boolean> {
    const state = await this.state.getState(
      'MATCH_PLAYS',
      'FIXTURE',
      fixtureId,
    );
    if (!state) return true;
    if (
      state.status === 'SUCCEEDED' &&
      /\/plays(?:[?#]|$)/i.test(String(state.endpoint ?? ''))
    ) {
      return false;
    }

    const attemptValue =
      state.status === 'PROCESSING'
        ? (state.lastStartedAt ?? state.updatedAt)
        : state.status === 'SUCCEEDED'
          ? (state.lastSuccessfulAt ?? state.updatedAt)
          : (state.updatedAt ?? state.lastStartedAt);
    const attemptAt = timestampOf(attemptValue);
    const now = Date.now();
    if (
      Number.isFinite(attemptAt) &&
      now >= attemptAt &&
      now - attemptAt < Math.max(0, retryCooldownMs)
    ) {
      return false;
    }
    return true;
  }

  async getLiveScoreboardMonitoringState(
    competitionId: string,
    date: string,
    expectedKickoffAt?: string,
    now = Date.now(),
  ): Promise<{ shouldContinue: boolean; intervalMs?: number; anchorKickoffAt?: string }> {
    const fixtures = await this.persistence.getFixturesForCompetitionDate(
      competitionId,
      date,
    );
    if (!fixtures.length) return { shouldContinue: false };

    // Only provider-confirmed terminal states with the required result data
    // end the monitoring chain. A stale SCHEDULED/LIVE state after kickoff is
    // not terminal, and a COMPLETED fixture without both scores still needs
    // low-frequency verification.
    const terminalWithoutScore = new Set([
      'POSTPONED',
      'CANCELLED',
      'ABANDONED',
    ]);
    const hasUnconfirmedFixture = fixtures.some((fixture) => {
      const state = String(fixture.status?.state ?? 'UNKNOWN');
      if (terminalWithoutScore.has(state)) return false;

      const completed =
        fixture.status?.isFinal === true || state === 'COMPLETED';
      if (!completed) return true;

      return !(
        Array.isArray(fixture.competitors) &&
        fixture.competitors.length === 2 &&
        fixture.competitors.every(
          (competitor) =>
            competitor.score !== null &&
            competitor.score !== undefined &&
            Number.isFinite(Number(competitor.score)),
        )
      );
    });
    if (!hasUnconfirmedFixture) return { shouldContinue: false };

    const expectedKickoff = timestampOf(expectedKickoffAt);
    const fixtureKickoffs = fixtures
      .map((fixture) => timestampOf(fixture.kickoffAt))
      .filter(Number.isFinite);
    const fixtureAnchor = fixtureKickoffs.length
      ? Math.min(...fixtureKickoffs)
      : Number.NaN;
    const dateAnchor = timestampOf(`${date}T00:00:00.000Z`);
    const anchor = Number.isFinite(expectedKickoff)
      ? expectedKickoff
      : Number.isFinite(fixtureAnchor)
        ? fixtureAnchor
        : dateAnchor;

    // A malformed scope must not silently retain the two-minute cadence.
    // The calendar date is the final fallback anchor; if even that is invalid,
    // continue only at the low verification cadence.
    const elapsedMs = Number.isFinite(anchor)
      ? Math.max(0, now - anchor)
      : Number.POSITIVE_INFINITY;
    const liveSchedule = SPORTS_COLLECTION_SCHEDULE.liveScoreboard;
    const intervalMs =
      elapsedMs >= liveSchedule.historicalVerificationAfterMs
        ? liveSchedule.historicalVerificationIntervalMs
        : elapsedMs >= liveSchedule.activeMonitoringWindowMs
          ? liveSchedule.finalVerificationIntervalMs
          : liveSchedule.intervalMs;

    return {
      shouldContinue: true,
      intervalMs,
      anchorKickoffAt: Number.isFinite(anchor)
        ? new Date(anchor).toISOString()
        : undefined,
    };
  }

  async getSummaryBackfillPage(input: {
    competitionId: string;
    seasonId?: string;
    cursorKickoffAt?: string;
    cursorFixtureId?: string;
    limit: number;
  }): Promise<
    Array<{
      fixture: SportsFixtureRecord;
      summaryPayloadHash?: string;
      factsPayloadHash?: string;
    }>
  > {
    return this.persistence.getSummaryBackfillPage(input);
  }

  /** Rebuild normalized facts from a retained raw Summary without an ESPN call. */
  async normalizeStoredMatchSummary(
    fixture: SportsFixtureRecord,
  ): Promise<boolean> {
    const summary = await this.persistence.getMatchSummaryByFixtureId(
      fixture.id,
    );
    if (
      !summary ||
      !summary.rawPayload ||
      typeof summary.rawPayload !== 'object'
    )
      return false;

    const endpoint = String(
      summary.endpoint ?? `/summary?event=${fixture.espnEventId}`,
    );
    const sourceCollectedAt = new Date(
      summary.lastCollectedAt ??
        summary.firstCollectedAt ??
        fixture.completedAt ??
        fixture.kickoffAt,
    );
    const rawPayload = summary.rawPayload as Record<string, unknown>;
    const normalized = await this.matchFactsNormalization.normalizeAndPersist({
      fixtureId: fixture.id,
      espnEventId: fixture.espnEventId,
      competitionId: fixture.competitionId,
      seasonId: fixture.seasonId ?? summary.seasonId,
      seasonYear: fixture.seasonYear ?? summary.seasonYear,
      endpoint,
      sourcePayloadHash: String(summary.payloadHash ?? ''),
      sourceRevision: Math.max(1, Number(summary.revision ?? 1)),
      sourceCollectedAt,
      rawPayload,
      fixture,
    });
    await this.normalizeAndPersistOfficialStandings({
      competitionId: fixture.competitionId,
      seasonId: fixture.seasonId ?? summary.seasonId,
      endpoint,
      sourcePayloadHash: String(summary.payloadHash ?? ''),
      sourceRevision: Math.max(1, Number(summary.revision ?? 1)),
      sourceCollectedAt,
      rawPayload,
    });
    return Boolean(normalized);
  }

  private async normalizeAndPersistOfficialStandings(input: {
    competitionId: string;
    seasonId?: string;
    endpoint: string;
    sourcePayloadHash: string;
    sourceRevision: number;
    sourceCollectedAt: Date;
    rawPayload: Record<string, unknown>;
  }): Promise<boolean> {
    const seasonId = String(input.seasonId ?? '').trim();
    if (!seasonId) return false;

    const snapshot = this.matchFactsNormalization.normalizeOfficialStandings({
      competitionId: input.competitionId,
      seasonId,
      endpoint: input.endpoint,
      sourcePayloadHash: input.sourcePayloadHash,
      sourceRevision: input.sourceRevision,
      sourceCollectedAt: input.sourceCollectedAt,
      rawPayload: input.rawPayload,
    });
    if (!snapshot) return false;

    const result = await this.persistence.saveOfficialStandings(snapshot);
    if (!result.saved && result.reason === 'INCOMPLETE') {
      this.logger.warn(
        `Official ESPN standings were not published for ${input.competitionId}/${seasonId}; the last valid snapshot was retained.`,
      );
    }
    return result.saved || result.reason === 'UNCHANGED';
  }

  /**
   * Extract official standings from an already-retained Summary document.
   * This path deliberately does not rewrite Match Facts or call ESPN, avoiding
   * unnecessary source-change events and provider requests during backfill.
   */
  async normalizeStoredOfficialStandings(
    fixture: SportsFixtureRecord,
  ): Promise<boolean> {
    const summary = await this.persistence.getMatchSummaryByFixtureId(fixture.id);
    if (!summary || !summary.rawPayload || typeof summary.rawPayload !== 'object') {
      return false;
    }

    const sourceCollectedAt = new Date(
      summary.lastCollectedAt ??
        summary.firstCollectedAt ??
        fixture.completedAt ??
        fixture.kickoffAt,
    );
    if (!Number.isFinite(sourceCollectedAt.getTime())) return false;

    return this.normalizeAndPersistOfficialStandings({
      competitionId: fixture.competitionId,
      seasonId: fixture.seasonId ?? summary.seasonId,
      endpoint: String(summary.endpoint ?? `/summary?event=${fixture.espnEventId}`),
      sourcePayloadHash: String(summary.payloadHash ?? ''),
      sourceRevision: Math.max(1, Number(summary.revision ?? 1)),
      sourceCollectedAt,
      rawPayload: summary.rawPayload as Record<string, unknown>,
    });
  }

  async getFixture(fixtureId: string): Promise<SportsFixtureRecord | null> {
    return this.persistence.getFixtureById(fixtureId);
  }

  async getFixturesForCompetitionDate(
    competitionId: string,
    date: string,
  ): Promise<SportsFixtureRecord[]> {
    return this.persistence.getFixturesForCompetitionDate(competitionId, date);
  }

  async getCompletedFixturesPage(query: {
    competitionId?: string;
    seasonId?: string;
    cursor?: string;
    limit?: number;
    includeProjectionData?: boolean;
  } = {}): Promise<SportsFixtureReadResult> {
    return this.persistence.getCompletedFixturesPage(query);
  }

  async pruneExpiredFixtures(
    batchSize = 250,
  ): Promise<{ deletedCount: number; affectedCompetitionIds: string[] }> {
    return this.persistence.pruneExpiredFixtures(batchSize);
  }

  async getCurrentSeasonCompetitions(): Promise<SportsCompetitionRecord[]> {
    return this.persistence.getCurrentSeasonCompetitions();
  }

  async getCurrentSeasonFixtures(
    competitionId: string,
    seasonId: string,
  ): Promise<SportsFixtureRecord[]> {
    return this.persistence.getCurrentSeasonFixtures(competitionId, seasonId);
  }

  async getFixtureDateKeysForSeason(
    competitionId: string,
    seasonId: string,
  ): Promise<string[]> {
    return this.persistence.getFixtureDateKeysForSeason(
      competitionId,
      seasonId,
    );
  }

  async recordFixtureDayValidation(input: {
    competitionId: string;
    seasonId: string;
    leagueId: string;
    date: string;
    endpoint: string;
    result:
      | 'FIXTURES_FOUND'
      | 'NO_FIXTURES_CONFIRMED'
      | 'RECOVERED_FROM_SUMMARY'
      | 'INCOMPLETE';
    receivedCount: number;
    persistedCount: number;
    missingCount: number;
    resultSummary?: Record<string, unknown>;
  }): Promise<void> {
    await this.state.recordFixtureDayValidation(input);
  }

  private isRetryableProviderError(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'retryable' in error &&
      (error as { retryable?: unknown }).retryable === true,
    );
  }

  private stateInput(
    collectionType: string,
    scopeType: 'GLOBAL' | 'COMPETITION' | 'SEASON' | 'TEAM' | 'FIXTURE',
    scopeId: string,
    endpoint: string,
    intervalMs: number,
  ) {
    return {
      collectionType,
      scopeType,
      scopeId,
      endpoint,
      intervalMs,
      provider: 'ESPN' as const,
      enabled: true,
    };
  }
}

