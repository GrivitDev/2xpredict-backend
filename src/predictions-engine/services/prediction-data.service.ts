import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { SportsDomainReadService } from '../../sports/services/sports-domain-read.service';
import type {
  SportsFixtureRecord,
  SportsFixtureCompetitor,
} from '../../sports/interfaces/sports-domain.interface';
import type {
  SportsTeamFormRecord,
} from '../../sports/interfaces/sports-derived-data.interface';
import { OddsReadService } from '../../odds/services/odds-read.service';
import { SportsDataChangeEventService } from '../../sports/services/sports-data-change-event.service';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import type {
  PredictionCurrentMatchStatistics,
  PredictionFixtureCore,
  PredictionMatchContext,
  PredictionStandingEntry,
  PredictionStandingsSnapshot,
  PredictionTeamCore,
  StoredFixtureOdds,
} from '../interfaces/prediction-match-context.interface';

const asDate = (value: unknown): Date | null => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
};

const asRecord = (value: unknown): Record<string, any> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;

/** A source revision changed during calculation; the queue must re-run, not skip the fixture. */
export class PredictionSourceRevisionChangedError extends UnprocessableEntityException {
  constructor(eventId: string, expectedRevision: number, currentRevision: number) {
    super(
      `Sports fixture ${eventId} changed during prediction generation (source revision ${expectedRevision} -> ${currentRevision}); the result must be recalculated.`,
    );
    this.name = 'PredictionSourceRevisionChangedError';
  }
}

const finite = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
};

const uniqueFixtures = (rows: SportsFixtureRecord[]): SportsFixtureRecord[] => {
  const byId = new Map<string, SportsFixtureRecord>();
  for (const fixture of rows) {
    if (fixture?.id) byId.set(String(fixture.id), fixture);
  }
  return [...byId.values()];
};

@Injectable()
export class PredictionDataService {
  constructor(
    private readonly sportsRead: SportsDomainReadService,
    private readonly oddsService: OddsReadService,
    private readonly sportsRevisions: SportsDataChangeEventService,
  ) {}

  /** Re-read Sports immediately before prediction persistence to prevent a run
   * that started pre-kickoff from committing after the fixture has started.
   */
  async assertFixtureStillPreMatch(eventId: string): Promise<void> {
    const requestedId = String(eventId ?? '').trim();
    if (!requestedId) throw new NotFoundException('A Sports fixture ID is required.');

    const fixture = await this.sportsRead.getFixture(requestedId);
    if (!fixture) throw new NotFoundException(`Sports fixture ${requestedId} was not found.`);
    this.requirePreMatchKickoff(fixture);
  }

  /**
   * Ensure the normalized fixture facts used by a prediction still belong to
   * the current Sports source generation. This is separate from the kickoff gate.
   */
  async assertFixtureSourceRevision(
    eventId: string,
    expectedRevision: number,
  ): Promise<void> {
    const requestedId = String(eventId ?? '').trim();
    if (!requestedId) throw new NotFoundException('A Sports fixture ID is required.');

    const currentRevision = await this.sportsRevisions.getCurrentRevision(
      'FIXTURE',
      requestedId,
    );
    if (currentRevision !== expectedRevision) {
      throw new PredictionSourceRevisionChangedError(
        requestedId,
        expectedRevision,
        currentRevision,
      );
    }
  }

  /** Current Sports source revision used to suppress stale market snapshots. */
  async getCurrentFixtureSourceRevision(eventId: string): Promise<number> {
    const requestedId = String(eventId ?? '').trim();
    if (!requestedId) throw new NotFoundException('A Sports fixture ID is required.');
    return this.sportsRevisions.getCurrentRevision('FIXTURE', requestedId);
  }

  /** Return the exact season-relative retention deadline maintained by Sports. */
  async getFixtureRetentionExpiresAt(eventId: string): Promise<Date | null> {
    const requestedId = String(eventId ?? '').trim();
    if (!requestedId) return null;
    const fixture = await this.sportsRead.getFixture(requestedId);
    return asDate(fixture?.retentionExpiresAt);
  }

  /** Used by downstream snapshot services that must preserve the last pre-match state. */
  async isFixturePreMatch(eventId: string): Promise<boolean> {
    const requestedId = String(eventId ?? '').trim();
    if (!requestedId) return false;

    const fixture = await this.sportsRead.getFixture(requestedId);
    if (!fixture) return false;

    try {
      this.requirePreMatchKickoff(fixture);
      return true;
    } catch (error) {
      if (error instanceof UnprocessableEntityException) return false;
      throw error;
    }
  }

  async loadForPrediction(eventId: string): Promise<PredictionMatchContext> {
    const requestedId = String(eventId ?? '').trim();
    if (!requestedId) throw new NotFoundException('A Sports fixture ID is required.');

    // Resolve both canonical Sports IDs and retained ESPN event IDs first. The
    // revision ledger is keyed by the normalized Sports fixture ID, which may
    // differ from the provider event ID supplied by an admin or caller.
    const initiallyResolvedFixture = await this.sportsRead.getFixture(requestedId);
    if (!initiallyResolvedFixture) {
      throw new NotFoundException(`Sports fixture ${requestedId} was not found.`);
    }
    const canonicalFixtureId = String(initiallyResolvedFixture.id ?? '').trim();
    if (!canonicalFixtureId) {
      throw new UnprocessableEntityException(
        `Sports fixture ${requestedId} does not have a normalized fixture ID.`,
      );
    }

    // Capture the revision for the canonical source entity, then reload the
    // fixture. If Sports changes during context assembly, the final revision
    // assertion rejects the mixed-generation result and the queue retries it.
    const fixtureSourceRevision = await this.sportsRevisions.getCurrentRevision(
      'FIXTURE',
      canonicalFixtureId,
    );
    const fixture = await this.sportsRead.getFixture(canonicalFixtureId);
    if (!fixture) {
      throw new NotFoundException(`Sports fixture ${canonicalFixtureId} was not found.`);
    }

    const kickoff = this.requirePreMatchKickoff(fixture);

    const homeCompetitor = fixture.competitors.find((item) => item.homeAway === 'HOME');
    const awayCompetitor = fixture.competitors.find((item) => item.homeAway === 'AWAY');
    if (!homeCompetitor?.teamId || !awayCompetitor?.teamId) {
      throw new UnprocessableEntityException('The Sports fixture is missing a normalized home or away team.');
    }

    const [match, homeData, awayData, storedOdds] = await Promise.all([
      this.sportsRead.getMatch(fixture.id),
      this.sportsRead.getTeamData(homeCompetitor.teamId),
      this.sportsRead.getTeamData(awayCompetitor.teamId),
      this.oddsService.getFixturePrices(fixture.id),
    ]);
    if (!match) throw new NotFoundException(`Normalized Sports match ${fixture.id} was not found.`);

    const competition = match.competition ?? await this.sportsRead.getCompetition(fixture.competitionId);
    const seasonId = fixture.seasonId ?? match.season?.id;

    const [
      homeAwayHome,
      homeAwayAway,
      scoringHome,
      scoringAway,
      competitionScoring,
      statsHome,
      statsAway,
      standingsRows,
      headToHead,
    ] = await Promise.all([
      seasonId
        ? this.sportsRead.getTeamHomeAwayRecord(homeCompetitor.teamId, fixture.competitionId, seasonId)
        : Promise.resolve(null),
      seasonId
        ? this.sportsRead.getTeamHomeAwayRecord(awayCompetitor.teamId, fixture.competitionId, seasonId)
        : Promise.resolve(null),
      seasonId
        ? this.sportsRead.getTeamScoringRecord(homeCompetitor.teamId, fixture.competitionId, seasonId, 'SEASON')
        : Promise.resolve(null),
      seasonId
        ? this.sportsRead.getTeamScoringRecord(awayCompetitor.teamId, fixture.competitionId, seasonId, 'SEASON')
        : Promise.resolve(null),
      seasonId
        ? this.sportsRead.getCompetitionScoringTotals(fixture.competitionId, seasonId)
        : Promise.resolve(null),
      // Match Odds' pricing context uses venue-specific windows. Predictions use
      // the same Sports projection scopes so count markets see comparable samples.
      seasonId
        ? this.sportsRead.getTeamStatisticsAggregate(homeCompetitor.teamId, fixture.competitionId, seasonId, 'HOME')
        : Promise.resolve(null),
      seasonId
        ? this.sportsRead.getTeamStatisticsAggregate(awayCompetitor.teamId, fixture.competitionId, seasonId, 'AWAY')
        : Promise.resolve(null),
      seasonId
        ? this.sportsRead.getStandings(fixture.competitionId, seasonId)
        : Promise.resolve([]),
      this.sportsRead.getHeadToHead(homeCompetitor.teamId, awayCompetitor.teamId, fixture.competitionId),
    ]);

    const standings = this.toStandingsSnapshot(
      standingsRows,
      fixture.competitionId,
      seasonId,
    );

    const leagueFixtures = await this.loadLeagueHistory(
      fixture,
      PREDICTION_ENGINE_CONFIG.model.leagueMatches,
    );
    const teamHistory = [
      ...(homeData?.recentFixtures ?? []),
      ...(awayData?.recentFixtures ?? []),
    ];
    const history = uniqueFixtures([...teamHistory, ...leagueFixtures])
      .filter((row) => this.isCompletedBefore(row, kickoff))
      .sort((a, b) => new Date(b.kickoffAt).getTime() - new Date(a.kickoffAt).getTime());

    // H2H projections can contain older fixtures from other competitions. Add
    // their normalized score facts without duplicating fixture identities.
    for (const meeting of headToHead?.matches ?? []) {
      const meetingKickoff = asDate(meeting.kickoffAt);
      if (!meetingKickoff || meetingKickoff.getTime() >= kickoff.getTime()) continue;
      if (history.some((row) => row.id === meeting.fixtureId)) continue;
      history.push({
        ...fixture,
        id: meeting.fixtureId,
        espnEventId: meeting.fixtureId,
        kickoffAt: meetingKickoff,
        status: { ...fixture.status, state: 'COMPLETED', isFinal: true },
        competitors: [
          { teamId: meeting.homeTeamId, homeAway: 'HOME', score: meeting.homeScore },
          { teamId: meeting.awayTeamId, homeAway: 'AWAY', score: meeting.awayScore },
        ],
        // H2H supplies full-time scores only; do not copy this fixture's period split.
        periodScores: [],
        source: fixture.source,
      } as SportsFixtureRecord);
    }

    const core = this.toFixtureCore(fixture);
    const homeTeam = this.toTeamCore(match.homeTeam ?? homeData?.team, homeCompetitor.teamId, 'Home Team');
    const awayTeam = this.toTeamCore(match.awayTeam ?? awayData?.team, awayCompetitor.teamId, 'Away Team');
    const priceRows = (storedOdds ?? []).map((quote): StoredFixtureOdds => ({
      marketId: String(quote.marketId),
      selectionKey: String(quote.selectionKey),
      ...(quote.line !== undefined && quote.line !== null && Number.isFinite(Number(quote.line))
        ? { line: Number(quote.line) }
        : {}),
      decimalOdds: Number(quote.decimalOdds),
      predictionReady: quote.predictionReady === true,
      priceType: quote.priceType === 'PROVIDER' ? 'PROVIDER' : 'ESTIMATED',
      provider: quote.provider === 'ESPN' || quote.provider === 'THE_ODDS_API' ? quote.provider : null,
      bookmaker: typeof quote.bookmaker === 'string' ? quote.bookmaker : null,
      providerUpdatedAt: asDate(quote.providerUpdatedAt),
      updatedAt: asDate(quote.updatedAt),
      isFresh: quote.isFresh === true,
      fairOdds: finite(quote.fairOdds) ?? null,
      oddsBasis: ['BOOKMAKER_ONLY', 'BOOKMAKER_PLUS_HISTORY', 'HISTORICAL_ONLY', 'PRIOR_ONLY'].includes(String(quote.oddsBasis))
        ? quote.oddsBasis
        : null,
      oddsCalculationMethod: typeof quote.oddsCalculationMethod === 'string' ? quote.oddsCalculationMethod : null,
      dataQuality: finite(quote.dataQuality),
      sampleSize: finite(quote.sampleSize),
    }));

    // Current-match statistics are embedded in the normalized Sports fixture's
    // home/away competitor records. Sports does not return match.statistics.
    const currentMatchStatistics = this.toCurrentMatchStatistics(fixture, homeCompetitor, awayCompetitor);

    // Those competitor statistics share the fixture source metadata; do not
    // fabricate a separate statistics timestamp or call an old statistics model.
    const sourceUpdatedAt = this.latestDate([
      fixture.source?.providerUpdatedAt,
      fixture.source?.collectedAt,
      fixture.updatedAt,
    ]) ?? new Date(fixture.createdAt ?? kickoff);
    const sportsDataAgeHours = Math.max(0, (Date.now() - sourceUpdatedAt.getTime()) / 3_600_000);
    const usableOdds = priceRows.some((quote) =>
      quote.predictionReady && quote.isFresh && Number.isFinite(quote.decimalOdds) && quote.decimalOdds > 1,
    );

    const completedHistoryHome = history.filter((item) =>
      item.competitors.some((team) => team.teamId === homeCompetitor.teamId),
    ).length;
    const completedHistoryAway = history.filter((item) =>
      item.competitors.some((team) => team.teamId === awayCompetitor.teamId),
    ).length;
    const usableH2H = (headToHead?.matches ?? []).some((item) => {
      const date = asDate(item.kickoffAt);
      return Boolean(date && date.getTime() < kickoff.getTime());
    }) || history.some((item) =>
      item.competitors.some((team) => team.teamId === homeCompetitor.teamId)
      && item.competitors.some((team) => team.teamId === awayCompetitor.teamId),
    );
    const homeForm = this.selectForm(homeData?.form ?? [], fixture);
    const awayForm = this.selectForm(awayData?.form ?? [], fixture);

    await this.assertFixtureSourceRevision(canonicalFixtureId, fixtureSourceRevision);

    return {
      fixture: core,
      fixtureSourceRevision,
      summary: {
        source: 'NORMALIZED_SPORTS_DOMAIN',
        competition: competition?.displayName ?? competition?.name ?? null,
        season: match.season?.year ?? fixture.seasonYear ?? null,
        neutralSite: fixture.neutralSite === true,
        homePeriods: fixture.periodScores.filter((item) => item.teamId === homeCompetitor.teamId),
        awayPeriods: fixture.periodScores.filter((item) => item.teamId === awayCompetitor.teamId),
      },
      summaryAvailable: true,
      standings,
      standingsFetchedAt: standings?.computedAt ?? null,
      storedOdds: priceRows,
      homeTeam,
      awayTeam,
      historicalFixtures: history.slice(0, 240).map((row) => this.toFixtureCore(row)),
      leagueFixtures: leagueFixtures.map((row) => this.toFixtureCore(row)),
      homeForm,
      awayForm,
      homeAwayRecords: { home: homeAwayHome, away: homeAwayAway },
      scoringRecords: { home: scoringHome, away: scoringAway },
      competitionScoring,
      teamStatisticsAggregates: { home: statsHome, away: statsAway },
      headToHead,
      currentMatchStatistics,
      currentTimeline: match.timeline ?? [],
      sportsMatch: { homeTeam: match.homeTeam, awayTeam: match.awayTeam },
      loadedAt: new Date(),
      sourceUpdatedAt,
      sportsDataAgeHours,
      hasOdds: usableOdds,
      hasPickCenter: false,
      hasHeadToHead: usableH2H,
      hasLastFive: (homeForm?.results.length ?? completedHistoryHome) > 0
        && (awayForm?.results.length ?? completedHistoryAway) > 0,
      hasStandings: Boolean(standings?.entries.length),
      // The current Sports read contract has no confirmed lineup/roster or
      // validated pre-match per-appearance denominator. Keep player props gated.
      hasPlayerAppearanceEvidence: false,
    };
  }

  private requirePreMatchKickoff(fixture: SportsFixtureRecord): Date {
    const kickoff = asDate(fixture.kickoffAt);
    if (!kickoff) {
      throw new UnprocessableEntityException('The Sports fixture has no valid kickoff time.');
    }

    const state = String(fixture.status?.state ?? 'UNKNOWN')
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');
    const terminalStates = new Set([
      'COMPLETED', 'POSTPONED', 'CANCELLED', 'CANCELED', 'ABANDONED',
    ]);
    if (fixture.status?.isFinal === true || terminalStates.has(state)) {
      throw new UnprocessableEntityException(
        'Predictions are unavailable for a completed, postponed, cancelled, or abandoned fixture.',
      );
    }

    const inPlayStates = new Set([
      'LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES',
      'IN_PROGRESS', 'INPLAY', 'IN_PLAY', 'PLAYING', 'SUSPENDED', 'INTERRUPTED',
    ]);
    if (inPlayStates.has(state) || kickoff.getTime() <= Date.now()) {
      throw new UnprocessableEntityException(
        'Predictions are frozen at kickoff. In-play and post-kickoff prediction generation or recalculation is disabled.',
      );
    }

    return kickoff;
  }

  private toCurrentMatchStatistics(
    fixture: SportsFixtureRecord,
    home: SportsFixtureCompetitor,
    away: SportsFixtureCompetitor,
  ): PredictionCurrentMatchStatistics[] {
    const collectedAt = asDate(fixture.source?.collectedAt);
    const providerUpdatedAt = asDate(fixture.source?.providerUpdatedAt);
    return [home, away].map((competitor) => ({
      fixtureId: fixture.id,
      teamId: competitor.teamId,
      homeAway: competitor.homeAway,
      statistics: Array.isArray(competitor.statistics) ? competitor.statistics : [],
      sourceCollectedAt: collectedAt,
      sourceUpdatedAt: providerUpdatedAt ?? collectedAt,
    }));
  }

  private toStandingsSnapshot(
    value: unknown,
    competitionId: string,
    seasonId: string | undefined,
  ): PredictionStandingsSnapshot | null {
    if (!Array.isArray(value) || !seasonId) return null;

    const entries: PredictionStandingEntry[] = value.flatMap((candidate) => {
      const row = asRecord(candidate);
      if (!row) return [];
      const metrics = asRecord(row.metrics) ?? {};
      const teamId = String(row.teamId ?? '').trim();
      if (!teamId) return [];

      const played = finite(row.played) ?? finite(metrics.played) ?? finite(row.sourceFixtureCount) ?? 0;
      const won = finite(row.won) ?? finite(metrics.won) ?? 0;
      const drawn = finite(row.drawn) ?? finite(metrics.drawn) ?? 0;
      const lost = finite(row.lost) ?? finite(metrics.lost) ?? 0;
      const goalsFor = finite(row.goalsFor) ?? finite(metrics.goalsFor) ?? 0;
      const goalsAgainst = finite(row.goalsAgainst) ?? finite(metrics.goalsAgainst) ?? 0;
      const goalDifference = Number.isFinite(Number(row.goalDifference ?? metrics.goalDifference))
        ? Number(row.goalDifference ?? metrics.goalDifference)
        : goalsFor - goalsAgainst;
      const points = finite(row.points) ?? finite(metrics.points) ?? 0;
      const position = finite(row.position);

      return [{
        teamId,
        ...(position !== undefined ? { position } : {}),
        played,
        won,
        drawn,
        lost,
        goalsFor,
        goalsAgainst,
        goalDifference,
        points,
      }];
    });

    const computedAt = this.latestDate(value.map((candidate) => {
      const row = asRecord(candidate);
      return row?.calculatedAt ?? row?.computedAt;
    }));

    return { competitionId, seasonId, entries, computedAt };
  }

  private async loadLeagueHistory(fixture: SportsFixtureRecord, targetCount: number): Promise<SportsFixtureRecord[]> {
    const kickoff = new Date(fixture.kickoffAt);
    const from = new Date(kickoff.getTime() - 180 * 24 * 60 * 60_000);
    const rows: SportsFixtureRecord[] = [];
    let cursor: string | undefined;

    // Keep the historical competition scan bounded and consume Sports keyset
    // cursors exactly as returned. All history remains pre-kickoff only.
    for (let page = 0; page < 4; page += 1) {
      const result = await this.sportsRead.getFixtures({
        competitionId: fixture.competitionId,
        ...(fixture.seasonId ? { seasonId: fixture.seasonId } : {}),
        state: 'COMPLETED',
        from,
        to: kickoff,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      rows.push(...result.items);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    return uniqueFixtures(rows)
      .filter((row) => this.isCompletedBefore(row, kickoff))
      .sort((a, b) => new Date(b.kickoffAt).getTime() - new Date(a.kickoffAt).getTime())
      .slice(0, Math.max(targetCount, 40));
  }

  private isCompletedBefore(fixture: SportsFixtureRecord, kickoff: Date): boolean {
    const date = asDate(fixture.kickoffAt);
    const home = fixture.competitors?.find((item) => item.homeAway === 'HOME');
    const away = fixture.competitors?.find((item) => item.homeAway === 'AWAY');
    return Boolean(
      date
      && date.getTime() < kickoff.getTime()
      && fixture.status?.state === 'COMPLETED'
      && fixture.status?.isFinal === true
      && finite(home?.score) !== undefined
      && finite(away?.score) !== undefined,
    );
  }

  private toFixtureCore(row: SportsFixtureRecord): PredictionFixtureCore {
    const home = row.competitors.find((item) => item.homeAway === 'HOME');
    const away = row.competitors.find((item) => item.homeAway === 'AWAY');
    const collectedAt = asDate(row.source?.collectedAt) ?? asDate(row.updatedAt) ?? new Date(row.kickoffAt);
    const sourceUpdatedAt = asDate(row.source?.providerUpdatedAt) ?? collectedAt;
    const period = Number(row.status?.period);
    return {
      eventId: String(row.id),
      leagueId: String(row.competitionId),
      seasonId: row.seasonId,
      season: Number(row.seasonYear ?? 0),
      fixtureDate: new Date(row.kickoffAt),
      retentionExpiresAt: asDate(row.retentionExpiresAt),
      live: ['LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES', 'IN_PROGRESS', 'INPLAY', 'IN_PLAY', 'PLAYING', 'SUSPENDED', 'INTERRUPTED'].includes(String(row.status?.state ?? '').toUpperCase().replace(/[\s-]+/g, '_')),
      completed: row.status?.state === 'COMPLETED' || row.status?.isFinal === true,
      status: row.status?.state ?? 'UNKNOWN',
      statusDetail: row.status?.description,
      statusShortDetail: row.status?.shortDescription,
      statusState: row.status?.state,
      ...(Number.isFinite(period) && period > 0 ? { period } : {}),
      clock: row.status?.clock,
      displayClock: row.status?.displayClock,
      homeTeamId: String(home?.teamId ?? ''),
      awayTeamId: String(away?.teamId ?? ''),
      homeScore: finite(home?.score),
      awayScore: finite(away?.score),
      neutralSite: row.neutralSite === true,
      periodScores: row.periodScores ?? [],
      collectedAt,
      sourceUpdatedAt,
      summaryCollectedAt: sourceUpdatedAt,
      payload: {
        status: row.status,
        source: row.source,
        periodScores: row.periodScores ?? [],
      },
    };
  }

  private toTeamCore(team: any, fallbackId: string, fallbackName: string): PredictionTeamCore {
    return {
      id: String(team?.id ?? fallbackId),
      name: String(team?.displayName ?? team?.name ?? team?.shortName ?? fallbackName),
      abbreviation: typeof team?.abbreviation === 'string' ? team.abbreviation : undefined,
      logo: typeof team?.logo === 'string' ? team.logo : undefined,
      country: typeof team?.country === 'string' ? team.country : undefined,
    };
  }

  private selectForm(forms: SportsTeamFormRecord[], fixture: SportsFixtureRecord): SportsTeamFormRecord | null {
    const matching = forms.filter((item) =>
      (!item.competitionId || item.competitionId === fixture.competitionId)
      && (!fixture.seasonId || !item.seasonId || item.seasonId === fixture.seasonId),
    );
    return matching.sort((a, b) => new Date(b.computedAt).getTime() - new Date(a.computedAt).getTime())[0] ?? null;
  }

  private latestDate(values: unknown[]): Date | null {
    return values.map(asDate).filter((item): item is Date => item !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  }
}

