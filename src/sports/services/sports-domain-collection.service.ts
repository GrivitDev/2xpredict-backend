import { Injectable, Logger } from '@nestjs/common';

import type {
  FixtureCollectionResult,
  OddsCollectionResult,
  PlaysCollectionResult,
  TeamCatalogueResult,
} from '../interfaces/provider-response.interface';
import { getOddsApiSportKey } from '../config/odds-api-sport-key.map';
import type {
  SportsCompetitionRecord,
  SportsFixtureRecord,
  SportsMatchTimelineEventRecord,
  SportsSeasonRecord,
  SportsTeamRecord,
} from '../interfaces/sports-domain.interface';
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

  async discoverLeagueCatalogue(): Promise<{ leagueIds: string[]; endpoint: string; totalCount?: number; rawResponse?: Record<string, unknown> }> {
    const input = this.stateInput('LEAGUE_CATALOGUE', 'GLOBAL', 'ESPN_SOCCER', '/leagues', 7 * 24 * 60 * 60_000);
    await this.state.markStarted(input);
    try {
      const result = await this.provider.discoverLeagueCatalogue();
      await this.state.markSucceeded(input, result.rawResponse, result.endpoint);
      return result;
    } catch (error) {
      await this.state.markFailed(input, error);
      throw error;
    }
  }

  async collectLeagueDetails(leagueId: string): Promise<SportsCompetitionRecord> {
    const input = this.stateInput('LEAGUE_DETAILS', 'GLOBAL', leagueId, `/leagues/${leagueId}`, 7 * 24 * 60 * 60_000);
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

  async getCompetition(competitionId: string): Promise<SportsCompetitionRecord | null> {
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
  ): Promise<{ items: SportsSeasonRecord[]; newlyDiscovered: SportsSeasonRecord[]; endpoint: string; rawResponse?: Record<string, unknown> }> {
    const competition = await this.persistence.getCompetitionById(competitionId);
    if (!competition) throw new Error(`Cannot collect seasons: competition ${competitionId} is not persisted.`);
    const input = this.stateInput('SEASON_CATALOGUE', 'COMPETITION', competitionId, `/leagues/${leagueId}#current-season`, 7 * 24 * 60 * 60_000);
    await this.state.markStarted(input);
    try {
      const existing = await this.persistence.getAllSeasonsForCompetition(competitionId);
      const result = await this.provider.collectSeasonCatalogue(leagueId, competition);
      const currentSeason = result.items.find(
        (season) => season.year === competition.currentSeasonYear,
      ) ?? result.items.find((season) => season.isCurrent);
      if (!currentSeason) {
        throw new Error(`ESPN did not provide a current season for ${leagueId}; historical seasons were not persisted.`);
      }
      const persistedCurrentSeason = { ...currentSeason, isCurrent: true };
      await this.persistence.saveCurrentSeason(persistedCurrentSeason);
      await this.state.markSucceeded(input, result.rawResponse, result.endpoint);
      return {
        items: [persistedCurrentSeason],
        newlyDiscovered: existing.some((season) => season.id === persistedCurrentSeason.id)
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

  async getSeasonByYear(competitionId: string, year: number): Promise<SportsSeasonRecord | null> {
    return this.persistence.getSeasonByYear(competitionId, year);
  }

  async collectTeamCatalogue(leagueId: string, competitionId: string): Promise<TeamCatalogueResult> {
    const competition = await this.persistence.getCompetitionById(competitionId);
    if (!competition) throw new Error(`Cannot collect teams: competition ${competitionId} is not persisted.`);
    const input = this.stateInput('TEAM_CATALOGUE', 'COMPETITION', competitionId, `/leagues/${leagueId}/seasons/${competition.currentSeasonYear ?? ''}/teams`, 7 * 24 * 60 * 60_000);
    await this.state.markStarted(input);
    try {
      const result = await this.provider.collectTeamCatalogue(leagueId, competition);
      // Team membership is season-scoped. Keep only current-season participants
      // attached to this league while preserving memberships in other leagues.
      await this.persistence.reconcileTeamsForLeague(leagueId, result.teamIds);
      await this.state.markSucceeded(input, result.rawResponse, result.endpoint);
      return result;
    } catch (error) {
      await this.state.markFailed(input, error);
      throw error;
    }
  }

  async getTeamsForLeague(leagueId: string): Promise<SportsTeamRecord[]> {
    return this.persistence.getTeamsForLeague(leagueId);
  }

  async collectTeamDetails(leagueId: string, espnTeamId: string, teamReference?: string): Promise<SportsTeamRecord> {
    const input = this.stateInput('TEAM_DETAILS', 'TEAM', `team:${espnTeamId}`, teamReference ?? `/leagues/${leagueId}/teams/${espnTeamId}`, 30 * 24 * 60 * 60_000);
    await this.state.markStarted(input);
    try {
      const result = await this.provider.collectTeamDetails(leagueId, espnTeamId, teamReference);
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
    const input = this.stateInput('FIXTURE_MONTHLY_BOOTSTRAP', 'SEASON', monthKey, `/leagues/${leagueId}/scoreboard?dates=${month.replace('-', '')}`, 0);
    await this.state.markStarted(input);
    try {
      const result = await this.provider.collectMonthlyFixtures(leagueId, month, scope);
      const unresolved: string[] = [];
      const recovered: SportsFixtureRecord[] = [];
      let retryableFallbackError: unknown;
      for (const rejected of result.rejected) {
        if (!rejected.eventId) {
          unresolved.push(`unknown-event:${rejected.reason}`);
          continue;
        }
        try {
          const summaryFixture = await this.collectFixtureSummary(leagueId, rejected.eventId, scope);
          if (summaryFixture) recovered.push(summaryFixture);
          else unresolved.push(rejected.eventId);
        } catch (error) {
          unresolved.push(rejected.eventId);
          if (this.isRetryableProviderError(error)) retryableFallbackError ??= error;
        }
      }
      if (recovered.length) result.items.push(...recovered);
      if (unresolved.length) {
        if (retryableFallbackError) throw retryableFallbackError;
        throw new Error(`Monthly fixture collection ${leagueId}/${month} has ${unresolved.length} unresolved event(s): ${unresolved.slice(0, 10).join(', ')}.`);
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
    const input = this.stateInput('FIXTURE_DAILY_SCOREBOARD', 'COMPETITION', `${scope.competitionId}:${scope.seasonId}:${date}`, `/leagues/${leagueId}/scoreboard?dates=${date.replace(/-/g, '')}`, 0);
    await this.state.markStarted(input);
    try {
      const result = await this.provider.collectDailyFixtures(leagueId, date, scope);
      const saved = await this.persistence.saveFixtures(result.items);
      result.previousStates = saved.previousStates;
      await this.state.markSucceeded(input, undefined, result.endpoint);
      return result;
    } catch (error) {
      await this.state.markFailed(input, error);
      throw error;
    }
  }

  async isFixtureSummaryFallbackFresh(eventId: string, maxAgeMs = 24 * 60 * 60_000): Promise<boolean> {
    const state = await this.state.getState('MATCH_SUMMARY_FALLBACK', 'FIXTURE', `fixture:${eventId}`);
    if (state?.status !== 'SUCCEEDED' || !state.lastSuccessfulAt) return false;
    const succeededAt = new Date(state.lastSuccessfulAt).getTime();
    return Number.isFinite(succeededAt) && Date.now() - succeededAt < Math.max(0, maxAgeMs);
  }

  /**
   * Whether Settlement may safely request another Summary snapshot. A recent
   * success is fresh for maxAgeMs; active or recently failed attempts observe
   * a retry cooldown so partial settlement retries do not hammer ESPN.
   */
  async shouldCollectFixtureSummary(
    eventId: string,
    maxAgeMs = 20 * 60_000,
    retryCooldownMs = 5 * 60_000,
  ): Promise<boolean> {
    const storedSummary = await this.persistence.getMatchSummaryByEventId(eventId);
    const rawCollectedAt = timestampOf(storedSummary?.lastCollectedAt);
    const now = Date.now();
    if (
      Number.isFinite(rawCollectedAt) &&
      now >= rawCollectedAt &&
      now - rawCollectedAt < Math.max(0, maxAgeMs)
    ) return false;

    const state = await this.state.getState(
      'MATCH_SUMMARY_FALLBACK',
      'FIXTURE',
      `fixture:${eventId}`,
    );
    if (!state) return true;

    const successfulAt = timestampOf(state.lastSuccessfulAt);
    if (
      state.status === 'SUCCEEDED' &&
      Number.isFinite(successfulAt) &&
      now >= successfulAt &&
      now - successfulAt < Math.max(0, maxAgeMs)
    ) {
      return false;
    }

    if (state.status === 'PROCESSING' || state.status === 'FAILED') {
      const recentAttemptValue = state.status === 'PROCESSING'
        ? state.lastStartedAt ?? state.updatedAt
        : state.updatedAt ?? state.lastStartedAt;
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
      const result = await this.provider.collectFixtureSummary(leagueId, eventId, scope);
      const existingFixture = await this.persistence.getFixtureById(eventId);
      const fixtureId = result.fixture?.id ?? existingFixture?.id ?? `fixture:${eventId}`;
      const endpoint = `/leagues/${leagueId}/summary?event=${eventId}`;

      // Persist the complete provider response before attempting fixture fallback persistence.
      const collectedAt = new Date();
      const storedSummary = await this.persistence.saveMatchSummary({
        fixtureId,
        espnEventId: eventId,
        competitionId: scope.competitionId,
        seasonId: result.fixture?.seasonId ?? scope.seasonId ?? existingFixture?.seasonId,
        seasonYear: result.fixture?.seasonYear ?? scope.seasonYear ?? existingFixture?.seasonYear,
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
        seasonId: result.fixture?.seasonId ?? scope.seasonId ?? existingFixture?.seasonId,
        seasonYear: result.fixture?.seasonYear ?? scope.seasonYear ?? existingFixture?.seasonYear,
        endpoint,
        sourcePayloadHash: storedSummary.payloadHash,
        sourceRevision: storedSummary.revision,
        sourceCollectedAt: collectedAt,
        rawPayload: result.rawResponse,
        fixture: result.fixture ?? existingFixture,
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
    const endpoint = '/scoreboard';
    const input = this.stateInput('LIVE_SCOREBOARD', 'COMPETITION', `${scope.competitionId}:${date ?? 'CURRENT'}`, endpoint, 2 * 60_000);
    await this.state.markStarted(input);
    try {
      const result = await this.provider.collectLiveScoreboard(leagueId, scope);
      const recovered: SportsFixtureRecord[] = [];
      const unresolved: string[] = [];
      let retryableFallbackError: unknown;
      for (const rejected of result.rejected) {
        if (!rejected.eventId) {
          unresolved.push(`unknown-event:${rejected.reason}`);
          continue;
        }
        try {
          const summaryFixture = await this.collectFixtureSummary(leagueId, rejected.eventId, scope);
          if (summaryFixture) recovered.push(summaryFixture);
          else unresolved.push(rejected.eventId);
        } catch (error) {
          unresolved.push(rejected.eventId);
          if (this.isRetryableProviderError(error)) retryableFallbackError ??= error;
        }
      }
      if (unresolved.length) {
        if (retryableFallbackError) throw retryableFallbackError;
        throw new Error(`Live scoreboard ${leagueId} has ${unresolved.length} event(s) that could not be recovered from Summary.`);
      }
      if (recovered.length) result.items.push(...recovered);
      const saved = await this.persistence.saveFixtures(result.items);
      result.previousStates = saved.previousStates;
      await this.state.markSucceeded(input, undefined, result.endpoint);
      return result;
    } catch (error) {
      await this.state.markFailed(input, error);
      throw error;
    }
  }

  async collectMatchOdds(fixture: SportsFixtureRecord): Promise<OddsCollectionResult> {
    if (fixture.status.isFinal || fixture.status.state !== 'SCHEDULED' || Date.now() >= fixture.kickoffAt.getTime()) {
      return { snapshot: null, endpoint: 'pre-match-only', fallbackUsed: false };
    }
    const home = fixture.competitors.find((item) => item.homeAway === 'HOME');
    const away = fixture.competitors.find((item) => item.homeAway === 'AWAY');
    if (!home || !away) throw new Error(`Fixture ${fixture.id} has no home/away team context for odds.`);
    const [homeTeam, awayTeam] = await Promise.all([
      this.persistence.getTeamById(home.teamId),
      this.persistence.getTeamById(away.teamId),
    ]);
    const league = await this.persistence.getCompetitionById(fixture.competitionId);
    if (!league) throw new Error(`Fixture ${fixture.id} references missing competition ${fixture.competitionId}.`);
    const input = this.stateInput('MATCH_ODDS', 'FIXTURE', fixture.id, `/leagues/${league.slug}/events/${fixture.espnEventId}/competitions/${fixture.espnCompetitionId ?? fixture.espnEventId}/odds`, 0);
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
        const reason = result.reason ||
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

  async collectMatchPlays(fixture: SportsFixtureRecord): Promise<PlaysCollectionResult | null> {
    if (!(fixture.status.isFinal || fixture.status.state === 'COMPLETED')) return null;
    const competition = await this.persistence.getCompetitionById(fixture.competitionId);
    if (!competition) throw new Error(`Fixture ${fixture.id} references a missing competition.`);
    const input = this.stateInput('MATCH_PLAYS', 'FIXTURE', fixture.id, `/leagues/${competition.slug}/events/${fixture.espnEventId}/competitions/${fixture.espnCompetitionId ?? fixture.espnEventId}/plays`, 0);
    await this.state.markStarted(input);
    try {
      const result = await this.provider.collectMatchPlays({
        fixtureId: fixture.id,
        leagueId: competition.slug,
        eventId: fixture.espnEventId,
        competitionId: fixture.espnCompetitionId ?? fixture.espnEventId,
      });
      if (result.noDataReason || result.items.length === 0) {
        const reason = result.noDataReason ||
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


  async markSeasonMonthlyBootstrapCompleted(seasonId: string, endpoint: string): Promise<void> {
    const input = this.stateInput('FIXTURE_MONTHLY_BOOTSTRAP_COMPLETE', 'SEASON', seasonId, endpoint, 0);
    await this.state.markSucceeded(input);
  }

  async isSeasonMonthlyBootstrapComplete(seasonId: string): Promise<boolean> {
    const state = await this.state.getSeasonMonthlyBootstrapState(seasonId);
    return state?.status === 'SUCCEEDED';
  }

  async isMonthlyFixtureMonthCollected(seasonId: string, month: string): Promise<boolean> {
    const scopeId = `${seasonId}:${month.replace('-', '')}`;
    const state = await this.state.getState('FIXTURE_MONTHLY_BOOTSTRAP', 'SEASON', scopeId);
    return state?.status === 'SUCCEEDED';
  }

  async isDailyValidationComplete(competitionId: string, seasonId: string, date: string): Promise<boolean> {
    const state = await this.state.getFixtureDayValidation(competitionId, seasonId, date);
    return ['FIXTURES_FOUND', 'NO_FIXTURES_CONFIRMED', 'RECOVERED_FROM_SUMMARY'].includes(String(state?.validationResult));
  }

  async isSeasonDailyValidationComplete(competitionId: string, seasonId: string, fixedEndDate?: string): Promise<boolean> {
    const season = await this.persistence.getSeasonById(seasonId);
    if (!season) return false;
    if (!season.startDate) return false;
    const start = new Date(Date.UTC(new Date(season.startDate).getUTCFullYear(), new Date(season.startDate).getUTCMonth(), new Date(season.startDate).getUTCDate()));
    const rawEnd = fixedEndDate ? new Date(`${fixedEndDate}T00:00:00.000Z`) : season.endDate ?? (season.isCurrent ? new Date() : undefined);
    if (!rawEnd) return false;
    const endDate = new Date(rawEnd);
    const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));
    const existingFixtureDates = new Set(await this.persistence.getFixtureDateKeysForSeason(competitionId, seasonId));
    const validatedDates = new Set(await this.state.getSeasonValidatedDates(competitionId, seasonId));
    // Bootstrap validation is required only for dates with zero persisted
    // fixtures. Dates that already contain fixtures are reconciled by their
    // scheduled date-level refresh jobs (48h, 18h and post-match).
    for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const date = cursor.toISOString().slice(0, 10);
      if (!existingFixtureDates.has(date) && !validatedDates.has(date)) return false;
    }
    return true;
  }

  async hasCollectedMatchPlays(fixtureId: string): Promise<boolean> {
    const state = await this.state.getState('MATCH_PLAYS', 'FIXTURE', fixtureId);
    return state?.status === 'SUCCEEDED';
  }

  /**
   * A successful Summary keyEvents fallback is useful partial evidence, but it
   * is not proof that the complete Core Plays collection was obtained.
   */
  async hasCompleteMatchPlays(fixtureId: string): Promise<boolean> {
    const state = await this.state.getState('MATCH_PLAYS', 'FIXTURE', fixtureId);
    return state?.status === 'SUCCEEDED' && /\/plays(?:[?#]|$)/i.test(String(state.endpoint ?? ''));
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
    const state = await this.state.getState('MATCH_PLAYS', 'FIXTURE', fixtureId);
    if (!state) return true;
    if (
      state.status === 'SUCCEEDED' &&
      /\/plays(?:[?#]|$)/i.test(String(state.endpoint ?? ''))
    ) {
      return false;
    }

    const attemptValue = state.status === 'PROCESSING'
      ? state.lastStartedAt ?? state.updatedAt
      : state.status === 'SUCCEEDED'
        ? state.lastSuccessfulAt ?? state.updatedAt
        : state.updatedAt ?? state.lastStartedAt;
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

  async shouldContinueLiveScoreboard(competitionId: string, date: string): Promise<boolean> {
    const fixtures = await this.persistence.getFixturesForCompetitionDate(competitionId, date);
    if (!fixtures.length) return false;
    const terminal = new Set(['COMPLETED', 'POSTPONED', 'CANCELLED', 'ABANDONED']);
    return fixtures.some((fixture) => !terminal.has(fixture.status.state));
  }

  async getSummaryBackfillPage(input: {
    competitionId: string;
    cursorKickoffAt?: string;
    cursorFixtureId?: string;
    limit: number;
  }): Promise<Array<{
    fixture: SportsFixtureRecord;
    summaryPayloadHash?: string;
    factsPayloadHash?: string;
  }>> {
    return this.persistence.getSummaryBackfillPage(input);
  }

  /** Rebuild normalized facts from a retained raw Summary without an ESPN call. */
  async normalizeStoredMatchSummary(fixture: SportsFixtureRecord): Promise<boolean> {
    const summary = await this.persistence.getMatchSummaryByFixtureId(fixture.id);
    if (!summary || !summary.rawPayload || typeof summary.rawPayload !== 'object') return false;

    const normalized = await this.matchFactsNormalization.normalizeAndPersist({
      fixtureId: fixture.id,
      espnEventId: fixture.espnEventId,
      competitionId: fixture.competitionId,
      seasonId: fixture.seasonId ?? summary.seasonId,
      seasonYear: fixture.seasonYear ?? summary.seasonYear,
      endpoint: String(summary.endpoint ?? `/summary?event=${fixture.espnEventId}`),
      sourcePayloadHash: String(summary.payloadHash ?? ''),
      sourceRevision: Math.max(1, Number(summary.revision ?? 1)),
      sourceCollectedAt: new Date(
        summary.lastCollectedAt ?? summary.firstCollectedAt ?? fixture.completedAt ?? fixture.kickoffAt,
      ),
      rawPayload: summary.rawPayload as Record<string, unknown>,
      fixture,
    });
    return Boolean(normalized);
  }

  async getFixture(fixtureId: string): Promise<SportsFixtureRecord | null> {
    return this.persistence.getFixtureById(fixtureId);
  }

  async getFixturesForCompetitionDate(competitionId: string, date: string): Promise<SportsFixtureRecord[]> {
    return this.persistence.getFixturesForCompetitionDate(competitionId, date);
  }

  async getAllCompletedFixtures(): Promise<SportsFixtureRecord[]> {
    return this.persistence.getAllCompletedFixtures();
  }

  async pruneExpiredFixtures(batchSize = 250): Promise<{ deletedCount: number; affectedCompetitionIds: string[] }> {
    return this.persistence.pruneExpiredFixtures(batchSize);
  }

  async getCurrentSeasonCompetitions(): Promise<SportsCompetitionRecord[]> {
    return this.persistence.getCurrentSeasonCompetitions();
  }

  async getCurrentSeasonFixtures(competitionId: string, seasonId: string): Promise<SportsFixtureRecord[]> {
    return this.persistence.getCurrentSeasonFixtures(competitionId, seasonId);
  }

  async getFixtureDateKeysForSeason(competitionId: string, seasonId: string): Promise<string[]> {
    return this.persistence.getFixtureDateKeysForSeason(competitionId, seasonId);
  }

  async recordFixtureDayValidation(input: {
    competitionId: string;
    seasonId: string;
    leagueId: string;
    date: string;
    endpoint: string;
    result: 'FIXTURES_FOUND' | 'NO_FIXTURES_CONFIRMED' | 'RECOVERED_FROM_SUMMARY' | 'INCOMPLETE';
    receivedCount: number;
    persistedCount: number;
    missingCount: number;
    resultSummary?: Record<string, unknown>;
  }): Promise<void> {
    await this.state.recordFixtureDayValidation(input);
  }

  private isRetryableProviderError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'retryable' in error
      && (error as { retryable?: unknown }).retryable === true);
  }

  private stateInput(
    collectionType: string,
    scopeType: 'GLOBAL' | 'COMPETITION' | 'SEASON' | 'TEAM' | 'FIXTURE',
    scopeId: string,
    endpoint: string,
    intervalMs: number,
  ) {
    return { collectionType, scopeType, scopeId, endpoint, intervalMs, provider: 'ESPN' as const, enabled: true };
  }
}


