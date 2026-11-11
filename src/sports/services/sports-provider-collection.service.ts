import { Injectable } from '@nestjs/common';

import type {
  DiscoverySeasonCollectionResult,
  FixtureCollectionResult,
  PlaysCollectionResult,
  ProviderJsonObject,
  TeamCatalogueResult,
} from '../interfaces/provider-response.interface';
import type {
  SportsCompetitionRecord,
  SportsFixtureRecord,
  SportsSeasonRecord,
  SportsTeamRecord,
} from '../interfaces/sports-domain.interface';
import { EspnV2Client } from '../providers/espn-v2.client';
import { SportsProviderRequestError } from '../providers/sports-provider-request.error';
import {
  EspnV2Normalizer,
  FixtureNormalizationContext,
} from '../providers/espn-v2.normalizer';

@Injectable()
export class SportsProviderCollectionService {
  constructor(
    private readonly espn: EspnV2Client,
    private readonly normalizer: EspnV2Normalizer,
  ) {}

  async discoverLeagueCatalogue(): Promise<{
    leagueIds: string[];
    endpoint: string;
    totalCount?: number;
    rawResponse?: ProviderJsonObject;
  }> {
    const collection = await this.espn.getLeagueCatalogue();
    const leagueIds = [
      ...new Set(
        collection.items
          .map((item) => this.normalizer.readLeagueId(item))
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    return {
      leagueIds,
      endpoint: collection.endpoint,
      totalCount: collection.totalCount,
      rawResponse: collection.rawResponse,
    };
  }

  async collectLeagueDetails(
    leagueId: string,
  ): Promise<SportsCompetitionRecord> {
    const response = await this.espn.getLeagueDetails(leagueId);
    return this.normalizer.normalizeCompetition(response, leagueId);
  }

  async collectSeasonCatalogue(
    leagueId: string,
    competition: SportsCompetitionRecord,
  ): Promise<DiscoverySeasonCollectionResult> {
    // The persisted competition resource already identifies its current
    // season. Do not enumerate the historical seasons endpoint: Sports keeps
    // one season row per competition and only bootstraps that season's fixtures.
    const leaguePayload = this.asRecord(competition.rawPayload);
    const currentSeasonPayload = this.asRecord(leaguePayload?.season) ?? {};
    const currentYear = competition.currentSeasonYear ??
      this.normalizer.readSeasonYear(currentSeasonPayload);
    if (!currentYear) {
      throw new Error(`ESPN league ${leagueId} does not identify a current season year.`);
    }

    const currentSeason = this.normalizer.normalizeSeason(
      {
        ...currentSeasonPayload,
        id: currentSeasonPayload.id ?? String(currentYear),
        year: currentSeasonPayload.year ?? currentYear,
        startDate:
          currentSeasonPayload.startDate ??
          competition.currentSeasonStartDate?.toISOString(),
        endDate:
          currentSeasonPayload.endDate ??
          competition.currentSeasonEndDate?.toISOString(),
      },
      competition.id,
      true,
    );

    return {
      items: [currentSeason],
      endpoint: `${competition.source.endpoint}#current-season`,
      totalCount: 1,
      rawResponse: currentSeasonPayload,
    };
  }

  async collectTeamCatalogue(
    leagueId: string,
    competition: SportsCompetitionRecord,
  ): Promise<TeamCatalogueResult> {
    const rawLeague = this.asRecord(competition.rawPayload);
    const currentSeason = this.asRecord(rawLeague?.season);
    // Verified ESPN league-details payload places the season-scoped teams
    // resource at the league root (`teams`), beside `season` and `seasons`.
    // Keep the season.teams lookup only as a defensive compatibility fallback.
    const teamsResource =
      this.asRecord(rawLeague?.teams) ?? this.asRecord(currentSeason?.teams);
    const catalogueReference = this.readString(teamsResource?.$ref);
    const response = await this.espn.getCompetitionTeams(
      leagueId,
      catalogueReference,
    );
    const teamReferences: Record<string, string> = {};
    const teamIds = [
      ...new Set(
        response.items
          .map((item) => this.normalizer.readTeamId(item))
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    for (const item of response.items) {
      const row = this.asRecord(item);
      const teamId = this.normalizer.readTeamId(item);
      const reference = this.readString(row?.$ref);
      if (teamId && reference) teamReferences[teamId] = reference;
    }
    return {
      teamIds,
      teamReferences,
      endpoint: response.endpoint,
      totalCount: response.totalCount,
      rawResponse: response.rawResponse,
    };
  }

  async collectTeamDetails(
    leagueId: string,
    teamId: string,
    teamReference?: string,
  ): Promise<SportsTeamRecord> {
    const response = await this.espn.getTeamDetails(
      leagueId,
      teamId,
      teamReference,
    );
    const endpoint = teamReference ?? `/leagues/${leagueId}/teams/${teamId}`;
    return this.normalizer.normalizeTeam(
      response,
      leagueId,
      new Date(),
      endpoint,
    );
  }

  async collectMonthlyFixtures(
    leagueId: string,
    month: string,
    context: Omit<FixtureNormalizationContext, 'leagueId' | 'collectedAt'>,
  ): Promise<FixtureCollectionResult> {
    const response = await this.espn.getMonthlyScoreboard(leagueId, month);
    return this.normalizeScoreboard(
      response,
      leagueId,
      context,
      `/scoreboard?dates=${month.replace('-', '')}`,
    );
  }

  async collectDailyFixtures(
    leagueId: string,
    date: string,
    context: Omit<FixtureNormalizationContext, 'leagueId' | 'collectedAt'>,
  ): Promise<FixtureCollectionResult> {
    const response = await this.espn.getDailyScoreboard(leagueId, date);
    return this.normalizeScoreboard(
      response,
      leagueId,
      context,
      `/scoreboard?dates=${date.replace(/-/g, '')}`,
    );
  }

  async collectLiveScoreboard(
    leagueId: string,
    context: Omit<FixtureNormalizationContext, 'leagueId' | 'collectedAt'>,
  ): Promise<FixtureCollectionResult> {
    // Live monitoring always calls the unfiltered Site /scoreboard route. The
    // date remains only a local queue/continuation scope, not a provider filter.
    const response = await this.espn.getLiveScoreboard(leagueId);
    return this.normalizeScoreboard(response, leagueId, context, '/scoreboard');
  }

  async collectFixtureSummary(
    leagueId: string,
    eventId: string,
    context: Omit<FixtureNormalizationContext, 'leagueId' | 'collectedAt'>,
  ): Promise<{
    fixture: SportsFixtureRecord | null;
    rawResponse: ProviderJsonObject;
  }> {
    const rawResponse = await this.espn.getMatchSummary(leagueId, eventId);
    return {
      fixture: this.normalizer.normalizeSummaryFixture(rawResponse, {
        ...context,
        leagueId,
      }),
      rawResponse,
    };
  }

  async collectMatchPlays(input: {
    fixtureId: string;
    leagueId: string;
    eventId: string;
    competitionId: string;
  }): Promise<PlaysCollectionResult> {
    const endpoint = `/leagues/${input.leagueId}/events/${input.eventId}/competitions/${input.competitionId}/plays`;
    const context = { ...input };
    let primaryError: unknown;
    let coreRequestCompleted = false;
    let coreReceivedCount: number | undefined;
    let coreNormalizedCount = 0;
    let coreCollectionDiagnostics: unknown;
    try {
      const core = await this.espn.getMatchPlays(
        input.leagueId,
        input.eventId,
        input.competitionId,
      );
      coreRequestCompleted = true;
      coreReceivedCount = core.items.length;
      coreCollectionDiagnostics = core.rawResponse?.playsCollectionDiagnostics;
      const items = this.normalizer.normalizeMatchTimeline(
        { items: core.items },
        context,
      );
      coreNormalizedCount = items.length;
      if (items.length > 0 && items.length === core.items.length) {
        return {
          items,
          receivedCount: core.items.length,
          endpoint,
          fallbackUsed: false,
          rawResponse: core.rawResponse ?? { items: core.items },
        };
      }
      primaryError = new Error(
        `ESPN Core Plays was incomplete after normalization (${items.length}/${core.items.length} usable plays).`,
      );
    } catch (error) {
      primaryError = error;
    }

    let summary: ProviderJsonObject;
    try {
      summary = await this.espn.getMatchSummary(
        input.leagueId,
        input.eventId,
      );
    } catch (summaryError) {
      // A real transport/provider error must remain retryable. Prefer whichever
      // provider explicitly classifies its failure as retryable; never turn a
      // timeout, 429 or 5xx response into an expected no-data result.
      if (
        primaryError instanceof SportsProviderRequestError &&
        primaryError.retryable
      ) throw primaryError;
      if (
        summaryError instanceof SportsProviderRequestError &&
        summaryError.retryable
      ) throw summaryError;
      if (!(primaryError instanceof SportsProviderRequestError)) throw primaryError;
      throw summaryError;
    }

    const fallback = this.normalizer.normalizeSummaryTimeline(summary, context);
    if (!fallback.length) {
      // A successful empty Core collection plus an empty Summary is a valid
      // no-data outcome for an event/competition without a public timeline.
      if (coreRequestCompleted && coreReceivedCount === 0) {
        return {
          items: [],
          receivedCount: 0,
          endpoint: `/summary?event=${input.eventId}#plays`,
          fallbackUsed: true,
          rawResponse: {
            playsCollectionDiagnostics: {
              outcome: 'NO_TIMELINE_DATA',
              coreReceivedCount,
              coreNormalizedCount,
              coreCollectionDiagnostics,
              summaryKeys: Object.keys(summary),
            },
          },
          noDataReason: 'ESPN Core Plays and match Summary contained no usable timeline events.',
        };
      }

      // A failed provider request remains retryable. If ESPN did return play
      // records but the normalizer rejected all of them, mark it as a parser
      // contract failure rather than retrying the same malformed payload 20x.
      if (!coreRequestCompleted && primaryError) throw primaryError;
      throw new SportsProviderRequestError(
        `ESPN returned ${coreReceivedCount ?? 'unknown'} Core play record(s), but only ${coreNormalizedCount} could be normalized and Summary contained no usable plays.`,
        {
          provider: 'ESPN',
          endpoint: `/leagues/${input.leagueId}/events/${input.eventId}/competitions/${input.competitionId}/plays`,
          retryable: false,
        },
        primaryError instanceof Error ? { cause: primaryError } : undefined,
      );
    }
    return {
      items: fallback,
      receivedCount: fallback.length,
      endpoint: `/summary?event=${input.eventId}#plays`,
      fallbackUsed: true,
      rawResponse: summary,
    };
  }

  private normalizeScoreboard(
    response: ProviderJsonObject,
    leagueId: string,
    context: Omit<FixtureNormalizationContext, 'leagueId' | 'collectedAt'>,
    endpoint: string,
  ): FixtureCollectionResult {
    const rawEvents = this.extractScoreboardEvents(response, endpoint);
    const items: SportsFixtureRecord[] = [];
    const rejected: Array<{ eventId?: string; reason: string }> = [];
    const seenEventIds = new Set<string>();
    const collectedAt = new Date();

    for (const value of rawEvents) {
      const row = this.asRecord(value);
      const eventId = this.readString(row?.id ?? row?.uid);
      if (eventId && seenEventIds.has(eventId)) continue;
      if (eventId) seenEventIds.add(eventId);
      try {
        items.push(
          this.normalizer.normalizeFixture(value, {
            ...context,
            leagueId,
            collectedAt,
          }),
        );
      } catch (error) {
        rejected.push({ eventId, reason: this.errorMessage(error) });
      }
    }

    return {
      items,
      receivedCount: rawEvents.length,
      rejected,
      endpoint,
      rawResponse: response,
    };
  }

  private extractScoreboardEvents(response: ProviderJsonObject, endpoint: string): unknown[] {
    // An explicitly empty events[] is a valid no-fixtures response. A missing
    // events envelope is not: treating a changed/invalid ESPN payload as empty
    // would silently confirm missing fixture data.
    if (Array.isArray(response.events)) return response.events;
    const content = this.asRecord(response.content);
    if (Array.isArray(content?.events)) return content.events;
    const scoreboard = this.asRecord(response.scoreboard);
    if (Array.isArray(scoreboard?.events)) return scoreboard.events;
    throw new SportsProviderRequestError(
      `ESPN scoreboard response did not contain a recognized events array (${endpoint}).`,
      { provider: 'ESPN', endpoint, retryable: true },
    );
  }

  private asRecord(value: unknown): ProviderJsonObject | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as ProviderJsonObject)
      : undefined;
  }

  private readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}




