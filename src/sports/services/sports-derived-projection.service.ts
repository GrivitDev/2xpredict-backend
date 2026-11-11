import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import type {
  SportsFixtureCompetitor,
  SportsFixtureRecord,
  SportsMatchTimelineEventRecord,
} from '../interfaces/sports-domain.interface';
import type { SportsMatchFactsRecord } from '../interfaces/sports-match-facts.interface';
import { SportsCollectionState } from '../schemas/operations/sports-collection-state.schema';
import {
  SportsCalculatedStandings,
  SportsCompetitionScoringTotals,
  SportsHeadToHead,
  SportsPlayerEventTotals,
  SportsTeamForm,
  SportsTeamHomeAwayRecord,
  SportsTeamScoringRecord,
  SportsTeamStatisticsAggregate,
  SportsFixture,
  SportsMatchTimelineEvent,
  SportsMatchFacts,
  SportsSeason,
} from '../schemas';

type Match = {
  fixture: SportsFixtureRecord;
  home: SportsFixtureCompetitor;
  away: SportsFixtureCompetitor;
  homeGoals: number;
  awayGoals: number;
};
type TeamTally = {
  teamId: string; played: number; won: number; drawn: number; lost: number;
  goalsFor: number; goalsAgainst: number; points: number;
};
type NumericStat = { key: string; label?: string; value: number };

/**
 * Event-triggered factual projections. Only completed fixtures are used; this
 * service never calls ESPN and never fabricates values for absent source stats.
 */
@Injectable()
export class SportsDerivedProjectionService {
  private readonly logger = new Logger(SportsDerivedProjectionService.name);

  constructor(
    @InjectModel(SportsFixture.name) private readonly fixtureModel: Model<any>,
    @InjectModel(SportsSeason.name) private readonly seasonModel: Model<any>,
    @InjectModel(SportsMatchFacts.name) private readonly matchFactsModel: Model<any>,
    @InjectModel(SportsMatchTimelineEvent.name) private readonly timelineModel: Model<any>,
    @InjectModel(SportsCollectionState.name) private readonly collectionStateModel: Model<any>,
    @InjectModel(SportsCalculatedStandings.name) private readonly standingsModel: Model<any>,
    @InjectModel(SportsTeamForm.name) private readonly formModel: Model<any>,
    @InjectModel(SportsTeamHomeAwayRecord.name) private readonly homeAwayModel: Model<any>,
    @InjectModel(SportsTeamScoringRecord.name) private readonly scoringModel: Model<any>,
    @InjectModel(SportsHeadToHead.name) private readonly h2hModel: Model<any>,
    @InjectModel(SportsCompetitionScoringTotals.name) private readonly competitionScoringModel: Model<any>,
    @InjectModel(SportsTeamStatisticsAggregate.name) private readonly statisticsModel: Model<any>,
    @InjectModel(SportsPlayerEventTotals.name) private readonly playerEventsModel: Model<any>,
  ) {}

  async recalculateSeason(competitionId: string, seasonId: string): Promise<{
    fixtures: number; teams: number; headToHeadPairs: number; players: number;
  }> {
    const retainedAt = new Date();
    const retainedFixtureCondition = {
      $or: [
        { retentionExpiresAt: { $gt: retainedAt } },
        { retentionExpiresAt: { $exists: false } },
        { retentionExpiresAt: null },
      ],
    };
    const [season, seasonFixtures] = await Promise.all([
      this.seasonModel.findOne({ competitionId, id: seasonId }).select('-_id').lean().exec(),
      this.fixtureModel.find({ competitionId, seasonId, ...retainedFixtureCondition })
        .sort({ kickoffAt: 1 }).select('-_id').lean().exec() as Promise<SportsFixtureRecord[]>,
    ]);
    if (!season) {
      this.logger.warn(`Skipping derived recalculation for unknown season ${competitionId}/${seasonId}.`);
      return { fixtures: 0, teams: 0, headToHeadPairs: 0, players: 0 };
    }

    // Season-scoped tables (standings, home/away splits, scoring and statistics)
    // remain scoped to this season. Rolling team form is deliberately different:
    // it includes the retained completed history from this and every earlier
    // season, so the first matches of a new season still have useful form data.
    const seasonYear = Number(season.year);
    const seasonStartAt = season.startDate ? new Date(season.startDate) : null;
    const hasSeasonStart = Boolean(seasonStartAt && Number.isFinite(seasonStartAt.getTime()));
    const historicalSeasonFilter = hasSeasonStart
      ? {
          competitionId,
          $or: [
            { year: { $lt: seasonYear } },
            { year: seasonYear, startDate: { $lte: seasonStartAt } },
            { id: seasonId },
          ],
        }
      : { competitionId, year: { $lte: seasonYear } };
    const historicalSeasons = await this.seasonModel.find(historicalSeasonFilter)
      .sort({ year: 1, startDate: 1 }).select({ id: 1, year: 1, startDate: 1 }).lean().exec() as Array<{ id?: string }>;
    const historicalSeasonIds = [...new Set([
      seasonId,
      ...historicalSeasons.map((row) => String(row.id ?? '').trim()).filter(Boolean),
    ])];
    const historyFixtures = await this.fixtureModel.find({
      competitionId,
      seasonId: { $in: historicalSeasonIds },
      $and: [
        { $or: [{ 'status.state': 'COMPLETED' }, { 'status.isFinal': true }] },
        retainedFixtureCondition,
      ],
    }).sort({ kickoffAt: -1 }).select('id competitionId seasonId kickoffAt status competitors')
      .lean().exec() as SportsFixtureRecord[];
    const historicalFixtureIds = historyFixtures.map((fixture) => fixture.id);
    const factRows = historicalFixtureIds.length
      ? await this.matchFactsModel.find({ fixtureId: { $in: historicalFixtureIds } })
        .select('fixtureId matchResult teamStatistics playerAppearances')
        .lean().exec() as SportsMatchFactsRecord[]
      : [];
    const matchFactsByFixture = new Map(
      factRows.map((facts) => [facts.fixtureId, facts] as const),
    );

    const matches = seasonFixtures
      .map((fixture) => this.toCompletedMatch(fixture, matchFactsByFixture.get(fixture.id)))
      .filter((item): item is Match => Boolean(item));
    const historicalMatches = historyFixtures
      .map((fixture) => this.toCompletedMatch(fixture, matchFactsByFixture.get(fixture.id)))
      .filter((item): item is Match => Boolean(item));
    const calculatedAt = new Date();
    const teamIds = new Set<string>();
    for (const fixture of seasonFixtures) {
      for (const competitor of fixture.competitors ?? []) {
        if (competitor.teamId) teamIds.add(competitor.teamId);
      }
    }
    const forms = this.calculateTeamForms(
      historicalMatches,
      calculatedAt,
      competitionId,
      seasonId,
      teamIds,
    );
    const h2h = await this.calculateHeadToHead(competitionId, calculatedAt);

    if (!matches.length) {
      await Promise.all([
        this.prune(this.standingsModel, { competitionId, seasonId }, []),
        this.upsertRows(this.formModel, forms),
        this.prune(this.formModel, { competitionId, seasonId }, forms),
        this.prune(this.homeAwayModel, { competitionId, seasonId }, []),
        this.prune(this.scoringModel, { competitionId, seasonId }, []),
        this.prune(this.competitionScoringModel, { competitionId, seasonId }, []),
        this.prune(this.statisticsModel, { competitionId, seasonId }, []),
        this.prune(this.playerEventsModel, { competitionId, seasonId }, []),
        this.upsertRows(this.h2hModel, h2h),
        this.prune(this.h2hModel, { competitionId }, h2h),
      ]);
      this.logger.debug(
        `No completed fixtures to project for ${competitionId}/${seasonId}; retained ${forms.length} rolling team-form projections from ${historicalMatches.length} historical matches.`,
      );
      return { fixtures: 0, teams: teamIds.size, headToHeadPairs: h2h.length, players: 0 };
    }

    const fixtureIds = matches.map((item) => item.fixture.id);
    const [timeline, playsCoverageRows] = await Promise.all([
      this.timelineModel.find({ fixtureId: { $in: fixtureIds } })
        .sort({ fixtureId: 1, sequence: 1 }).select('-_id').lean().exec() as Promise<SportsMatchTimelineEventRecord[]>,
      this.collectionStateModel.find({
        collectionType: 'MATCH_PLAYS',
        scopeType: 'FIXTURE',
        scopeId: { $in: fixtureIds },
        status: 'SUCCEEDED',
      }).select({ scopeId: 1, endpoint: 1 }).lean().exec(),
    ]);
    // A completed Plays job is a coverage fact even when ESPN returned an
    // empty event list. Summary keyEvents are a partial fallback, so they must
    // not inflate the denominator used to price event-frequency markets.
    const timelineCoverageFixtureIds = new Set<string>(
      (playsCoverageRows as Array<{ scopeId?: string; endpoint?: string }>)
        .filter((row) => /\/plays(?:[?#]|$)/i.test(String(row.endpoint ?? '')))
        .map((row) => String(row.scopeId ?? '').trim())
        .filter(Boolean),
    );
    const timelineByFixture = this.groupBy(timeline, (item) => item.fixtureId);

    const standings = this.calculateStandings(matches, calculatedAt);
    const homeAway = this.calculateHomeAway(matches, calculatedAt);
    const scoring = this.calculateTeamScoring(matches, timelineByFixture, timelineCoverageFixtureIds, calculatedAt);
    const competitionScoring = this.calculateCompetitionScoring(matches, timelineByFixture, timelineCoverageFixtureIds, calculatedAt);
    const statistics = this.calculateTeamStatistics(matches, calculatedAt, matchFactsByFixture);
    const playerEvents = this.calculatePlayerEventTotals(matches, timelineByFixture, calculatedAt, matchFactsByFixture);

    await Promise.all([
      this.upsertRows(this.standingsModel, standings),
      this.upsertRows(this.formModel, forms),
      this.upsertRows(this.homeAwayModel, homeAway),
      this.upsertRows(this.scoringModel, scoring),
      this.upsertRows(this.competitionScoringModel, [competitionScoring]),
      this.upsertRows(this.statisticsModel, statistics),
      this.upsertRows(this.playerEventsModel, playerEvents),
      this.upsertRows(this.h2hModel, h2h),
    ]);

    await Promise.all([
      this.prune(this.standingsModel, { competitionId, seasonId }, standings),
      this.prune(this.formModel, { competitionId, seasonId }, forms),
      this.prune(this.homeAwayModel, { competitionId, seasonId }, homeAway),
      this.prune(this.scoringModel, { competitionId, seasonId }, scoring),
      this.prune(this.competitionScoringModel, { competitionId, seasonId }, [competitionScoring]),
      this.prune(this.statisticsModel, { competitionId, seasonId }, statistics),
      this.prune(this.playerEventsModel, { competitionId, seasonId }, playerEvents),
      this.prune(this.h2hModel, { competitionId }, h2h),
    ]);

    const result = {
      fixtures: matches.length,
      teams: teamIds.size,
      headToHeadPairs: h2h.length,
      players: playerEvents.length,
    };
    this.logger.log(
      `Derived projections refreshed for ${competitionId}/${seasonId}: ${JSON.stringify(result)}; rolling form used ${historicalMatches.length} retained matches.`,
    );
    return result;
  }

  /**
   * Historical derived projections are part of the rolling-form source of truth.
   * This compatibility method is intentionally non-destructive; retention cleanup
   * removes expired source fixtures and recalculation refreshes affected projections.
   */
  async prunePreviousSeasons(_competitionId: string, _currentSeasonId: string): Promise<void> {
    this.logger.debug('Previous-season derived projections are retained; no pruning was performed.');
  }

  async getStandings(competitionId: string, seasonId: string): Promise<unknown[]> {
    return this.standingsModel.find({ competitionId, seasonId }).sort({ position: 1 }).select('-_id -__v').lean().exec();
  }

  async getTeamFormsForTeam(teamId: string, competitionId?: string): Promise<unknown[]> {
    return this.formModel.find({ teamId, ...(competitionId ? { competitionId } : {}) }).sort({ competitionId: 1, calculatedAt: -1 })
      .select('-_id -__v').lean().exec();
  }

  async getTeamForm(teamId: string, competitionId: string, seasonId: string): Promise<unknown | null> {
    return this.formModel.findOne({ teamId, competitionId, seasonId }).select('-_id -__v').lean().exec();
  }

  async getTeamHomeAway(teamId: string, competitionId: string, seasonId: string): Promise<unknown | null> {
    return this.homeAwayModel.findOne({ teamId, competitionId, seasonId }).select('-_id -__v').lean().exec();
  }

  async getTeamScoring(teamId: string, competitionId: string, seasonId: string): Promise<unknown | null> {
    return this.scoringModel.findOne({ teamId, competitionId, seasonId }).select('-_id -__v').lean().exec();
  }

  async getTeamStatistics(teamId: string, competitionId: string, seasonId: string): Promise<unknown | null> {
    return this.statisticsModel.findOne({ teamId, competitionId, seasonId }).select('-_id -__v').lean().exec();
  }

  async getHeadToHead(teamAId: string, teamBId: string, competitionId: string): Promise<unknown | null> {
    const [a, b] = [teamAId, teamBId].sort();
    return this.h2hModel.findOne({ competitionId, teamAId: a, teamBId: b }).select('-_id -__v').lean().exec();
  }

  async getCompetitionScoring(competitionId: string, seasonId: string): Promise<unknown | null> {
    return this.competitionScoringModel.findOne({ competitionId, seasonId }).select('-_id -__v').lean().exec();
  }

  async getPlayerEventTotals(playerId: string, competitionId: string, seasonId: string): Promise<unknown | null> {
    return this.playerEventsModel.findOne({ playerId, competitionId, seasonId }).select('-_id -__v').lean().exec();
  }

  private toCompletedMatch(
    fixture: SportsFixtureRecord,
    matchFacts?: SportsMatchFactsRecord,
  ): Match | null {
    if (!(fixture.status?.state === 'COMPLETED' || fixture.status?.isFinal)) return null;
    if (['POSTPONED', 'CANCELLED', 'ABANDONED'].includes(fixture.status.state)) return null;
    const home = fixture.competitors?.find((item) => item.homeAway === 'HOME');
    const away = fixture.competitors?.find((item) => item.homeAway === 'AWAY');
    const normalizedResult = matchFacts?.matchResult;
    const normalizedTeamsMatch = Boolean(home && away)
      && (!normalizedResult?.homeTeamId || normalizedResult.homeTeamId === home?.teamId)
      && (!normalizedResult?.awayTeamId || normalizedResult.awayTeamId === away?.teamId);
    const useNormalizedResult = normalizedTeamsMatch
      && normalizedResult?.available === true
      && normalizedResult.isFinal === true
      && normalizedResult.homeScore !== null
      && normalizedResult.awayScore !== null
      && Number.isFinite(Number(normalizedResult.homeScore))
      && Number.isFinite(Number(normalizedResult.awayScore));
    const homeGoals = useNormalizedResult ? normalizedResult!.homeScore : home?.score;
    const awayGoals = useNormalizedResult ? normalizedResult!.awayScore : away?.score;
    if (!home || !away || homeGoals === null || awayGoals === null || homeGoals === undefined || awayGoals === undefined) return null;
    if (!Number.isFinite(Number(homeGoals)) || !Number.isFinite(Number(awayGoals))) return null;
    return { fixture, home, away, homeGoals: Number(homeGoals), awayGoals: Number(awayGoals) };
  }

  private calculateStandings(matches: Match[], calculatedAt: Date): any[] {
    const table = new Map<string, TeamTally>();
    const ensure = (teamId: string): TeamTally => {
      let row = table.get(teamId);
      if (!row) {
        row = { teamId, played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, points: 0 };
        table.set(teamId, row);
      }
      return row;
    };
    for (const match of matches) {
      const home = ensure(match.home.teamId);
      const away = ensure(match.away.teamId);
      home.played += 1; away.played += 1;
      home.goalsFor += match.homeGoals; home.goalsAgainst += match.awayGoals;
      away.goalsFor += match.awayGoals; away.goalsAgainst += match.homeGoals;
      if (match.homeGoals > match.awayGoals) { home.won += 1; home.points += 3; away.lost += 1; }
      else if (match.homeGoals < match.awayGoals) { away.won += 1; away.points += 3; home.lost += 1; }
      else { home.drawn += 1; away.drawn += 1; home.points += 1; away.points += 1; }
    }
    const ranked = [...table.values()].sort((a, b) =>
      b.points - a.points || (b.goalsFor - b.goalsAgainst) - (a.goalsFor - a.goalsAgainst) || b.goalsFor - a.goalsFor || a.teamId.localeCompare(b.teamId),
    );
    return ranked.map((row, index) => ({
      id: `standings:${matches[0].fixture.competitionId}:${matches[0].fixture.seasonId}:${row.teamId}`,
      competitionId: matches[0].fixture.competitionId,
      seasonId: matches[0].fixture.seasonId,
      teamId: row.teamId,
      position: index + 1,
      calculatedAt,
      sourceFixtureCount: row.played,
      metrics: {
        ...row,
        goalDifference: row.goalsFor - row.goalsAgainst,
        pointsPerMatch: this.ratio(row.points, row.played),
        winRate: this.percent(row.won, row.played),
        drawRate: this.percent(row.drawn, row.played),
        lossRate: this.percent(row.lost, row.played),
      },
    }));
  }

  private calculateTeamForms(
    matches: Match[],
    calculatedAt: Date,
    competitionId: string,
    seasonId: string,
    targetTeamIds: Set<string>,
  ): any[] {
    const byTeam = new Map<string, Match[]>();
    for (const match of matches) {
      for (const teamId of [match.home.teamId, match.away.teamId]) {
        const rows = byTeam.get(teamId) ?? [];
        rows.push(match);
        byTeam.set(teamId, rows);
      }
    }

    return [...targetTeamIds].sort().map((teamId) => {
      const rows = byTeam.get(teamId) ?? [];
      const ordered = [...rows].sort(
        (a, b) => b.fixture.kickoffAt.getTime() - a.fixture.kickoffAt.getTime(),
      );
      const metrics = {
        // These rolling windows intentionally cross season boundaries.
        last5: this.formWindow(ordered.slice(0, 5), teamId),
        last10: this.formWindow(ordered.slice(0, 10), teamId),
        recentResults: ordered.slice(0, 10).map((match) => this.resultFor(match, teamId)),
        // Keep up to forty observations per season projection. This is enough
        // for read consumers to use the exact target-season snapshot without
        // merging duplicate rolling histories from multiple seasons.
        recentMatchFacts: ordered.slice(0, 40).map((match) => this.formResultFor(match, teamId)),
      };
      return {
        id: `form:${competitionId}:${seasonId}:${teamId}`,
        competitionId,
        seasonId,
        teamId,
        calculatedAt,
        sourceFixtureCount: rows.length,
        metrics,
      };
    });
  }

  private formWindow(matches: Match[], teamId: string): Record<string, unknown> {
    let won = 0, drawn = 0, lost = 0, goalsFor = 0, goalsAgainst = 0, points = 0;
    for (const match of matches) {
      const isHome = match.home.teamId === teamId;
      const gf = isHome ? match.homeGoals : match.awayGoals;
      const ga = isHome ? match.awayGoals : match.homeGoals;
      goalsFor += gf; goalsAgainst += ga;
      if (gf > ga) { won += 1; points += 3; }
      else if (gf === ga) { drawn += 1; points += 1; }
      else lost += 1;
    }
    const played = matches.length;
    return { played, results: matches.map((match) => this.resultFor(match, teamId)), won, drawn, lost, points, winRate: this.percent(won, played), goalsScored: goalsFor, goalsConceded: goalsAgainst, averageGoalsScored: this.ratio(goalsFor, played), averageGoalsConceded: this.ratio(goalsAgainst, played) };
  }

  private resultFor(match: Match, teamId: string): 'W' | 'D' | 'L' {
    const gf = match.home.teamId === teamId ? match.homeGoals : match.awayGoals;
    const ga = match.home.teamId === teamId ? match.awayGoals : match.homeGoals;
    return gf > ga ? 'W' : gf === ga ? 'D' : 'L';
  }

  private formResultFor(match: Match, teamId: string): Record<string, unknown> {
    const isHome = match.home.teamId === teamId;
    const goalsFor = isHome ? match.homeGoals : match.awayGoals;
    const goalsAgainst = isHome ? match.awayGoals : match.homeGoals;
    return {
      fixtureId: match.fixture.id,
      kickoffAt: match.fixture.kickoffAt,
      result: goalsFor > goalsAgainst ? 'W' : goalsFor < goalsAgainst ? 'L' : 'D',
      goalsFor,
      goalsAgainst,
      homeAway: isHome ? 'HOME' : 'AWAY',
    };
  }

  private calculateHomeAway(matches: Match[], calculatedAt: Date): any[] {
    const byTeam = new Map<string, Match[]>();
    for (const match of matches) for (const teamId of [match.home.teamId, match.away.teamId]) {
      const rows = byTeam.get(teamId) ?? []; rows.push(match); byTeam.set(teamId, rows);
    }
    return [...byTeam.entries()].map(([teamId, allRows]) => {
      const rows = [...allRows].sort((a, b) => b.fixture.kickoffAt.getTime() - a.fixture.kickoffAt.getTime());
      const homeRows = rows.filter((m) => m.home.teamId === teamId);
      const awayRows = rows.filter((m) => m.away.teamId === teamId);
      const metrics = {
        season: { home: this.recordWindow(homeRows, teamId), away: this.recordWindow(awayRows, teamId) },
        last5Home: this.recordWindow(homeRows.slice(0, 5), teamId),
        last10Home: this.recordWindow(homeRows.slice(0, 10), teamId),
        last5Away: this.recordWindow(awayRows.slice(0, 5), teamId),
        last10Away: this.recordWindow(awayRows.slice(0, 10), teamId),
      };
      return { id: `home-away:${rows[0].fixture.competitionId}:${rows[0].fixture.seasonId}:${teamId}`, competitionId: rows[0].fixture.competitionId, seasonId: rows[0].fixture.seasonId, teamId, calculatedAt, sourceFixtureCount: rows.length, metrics };
    });
  }

  private recordWindow(matches: Match[], teamId: string): Record<string, unknown> {
    const summary = this.formWindow(matches, teamId);
    return { ...summary, homeWins: matches.filter((m) => m.home.teamId === teamId && m.homeGoals > m.awayGoals).length, homeDraws: matches.filter((m) => m.home.teamId === teamId && m.homeGoals === m.awayGoals).length, homeLosses: matches.filter((m) => m.home.teamId === teamId && m.homeGoals < m.awayGoals).length, awayWins: matches.filter((m) => m.away.teamId === teamId && m.awayGoals > m.homeGoals).length, awayDraws: matches.filter((m) => m.away.teamId === teamId && m.awayGoals === m.homeGoals).length, awayLosses: matches.filter((m) => m.away.teamId === teamId && m.awayGoals < m.homeGoals).length };
  }

  private calculateTeamScoring(
    matches: Match[],
    timelineByFixture: Map<string, SportsMatchTimelineEventRecord[]>,
    timelineCoverageFixtureIds: Set<string>,
    calculatedAt: Date,
  ): any[] {
    const byTeam = new Map<string, Match[]>();
    for (const match of matches) for (const teamId of [match.home.teamId, match.away.teamId]) {
      const rows = byTeam.get(teamId) ?? []; rows.push(match); byTeam.set(teamId, rows);
    }
    return [...byTeam.entries()].map(([teamId, rows]) => {
      const ordered = [...rows].sort((a, b) => b.fixture.kickoffAt.getTime() - a.fixture.kickoffAt.getTime());
      const all = this.teamScoringWindow(ordered, teamId);
      const home = this.teamScoringWindow(ordered.filter((m) => m.home.teamId === teamId), teamId);
      const away = this.teamScoringWindow(ordered.filter((m) => m.away.teamId === teamId), teamId);
      const events = ordered.map((match) => ({ match, events: timelineByFixture.get(match.fixture.id) ?? [] }));
      const eventMetrics = this.teamEventMetrics(events, teamId, timelineCoverageFixtureIds);
      return { id: `scoring:${rows[0].fixture.competitionId}:${rows[0].fixture.seasonId}:${teamId}`, competitionId: rows[0].fixture.competitionId, seasonId: rows[0].fixture.seasonId, teamId, calculatedAt, sourceFixtureCount: rows.length, metrics: { season: all, home, away, last5: this.teamScoringWindow(ordered.slice(0, 5), teamId), last10: this.teamScoringWindow(ordered.slice(0, 10), teamId), eventMetrics } };
    });
  }

  private teamScoringWindow(matches: Match[], teamId: string): Record<string, unknown> {
    let goalsFor = 0, goalsAgainst = 0, scoredIn = 0, failedToScore = 0, cleanSheets = 0, concededIn = 0, highestScored = 0, highestConceded = 0;
    let teamOver05 = 0, teamOver15 = 0, teamOver25 = 0, btts = 0, over15 = 0, over25 = 0, under25 = 0;
    for (const match of matches) {
      const home = match.home.teamId === teamId;
      const gf = home ? match.homeGoals : match.awayGoals;
      const ga = home ? match.awayGoals : match.homeGoals;
      const total = match.homeGoals + match.awayGoals;
      goalsFor += gf; goalsAgainst += ga;
      highestScored = Math.max(highestScored, gf); highestConceded = Math.max(highestConceded, ga);
      if (gf > 0) scoredIn += 1; else failedToScore += 1;
      if (ga === 0) cleanSheets += 1;
      if (ga > 0) concededIn += 1;
      if (gf > 0) teamOver05 += 1;
      if (gf > 1) teamOver15 += 1;
      if (gf > 2) teamOver25 += 1;
      if (match.homeGoals > 0 && match.awayGoals > 0) btts += 1;
      if (total > 1.5) over15 += 1;
      if (total > 2.5) over25 += 1;
      if (total < 2.5) under25 += 1;
    }
    const played = matches.length;
    return { played, matchesScoredIn: scoredIn, failedToScore, cleanSheets, matchesConcededIn: concededIn, goalsScored: goalsFor, goalsConceded: goalsAgainst, averageGoalsScored: this.ratio(goalsFor, played), averageGoalsConceded: this.ratio(goalsAgainst, played), highestGoalsScored: highestScored, highestGoalsConceded: highestConceded, teamOver05Rate: this.percent(teamOver05, played), teamOver15Rate: this.percent(teamOver15, played), teamOver25Rate: this.percent(teamOver25, played), bttsRate: this.percent(btts, played), over15TotalGoalsRate: this.percent(over15, played), over25TotalGoalsRate: this.percent(over25, played), under25TotalGoalsRate: this.percent(under25, played), cleanSheetRate: this.percent(cleanSheets, played) };
  }

  private calculateCompetitionScoring(
    matches: Match[],
    timelineByFixture: Map<string, SportsMatchTimelineEventRecord[]>,
    timelineCoverageFixtureIds: Set<string>,
    calculatedAt: Date,
  ): any {
    const homeGoals = matches.reduce((sum, m) => sum + m.homeGoals, 0);
    const awayGoals = matches.reduce((sum, m) => sum + m.awayGoals, 0);
    const btts = matches.filter((m) => m.homeGoals > 0 && m.awayGoals > 0).length;
    const over15 = matches.filter((m) => m.homeGoals + m.awayGoals > 1.5).length;
    const over25 = matches.filter((m) => m.homeGoals + m.awayGoals > 2.5).length;
    const over35 = matches.filter((m) => m.homeGoals + m.awayGoals > 3.5).length;
    const under25 = matches.filter((m) => m.homeGoals + m.awayGoals < 2.5).length;
    const cleanSheetMatches = matches.filter((m) => m.homeGoals === 0 || m.awayGoals === 0).length;
    const events = matches.map((match) => ({
      match,
      covered: timelineCoverageFixtureIds.has(match.fixture.id),
      events: timelineCoverageFixtureIds.has(match.fixture.id)
        ? (timelineByFixture.get(match.fixture.id) ?? []).filter((play) => play.valid !== false)
        : [],
    }));
    const firstGoalsByMatch = events.map((row) => ({
      ...row,
      firstGoal: row.events.filter((play) => this.isGoal(play)).sort((a, b) => this.minute(a) - this.minute(b))[0],
    }));
    const firstGoals = firstGoalsByMatch.filter((row) => Boolean(row.firstGoal));
    const lastGoalsByMatch = events.map((row) => ({
      ...row,
      lastGoal: row.events.filter((play) => this.isGoal(play)).sort((a, b) => this.minute(a) - this.minute(b)).at(-1),
    }));
    const lastGoals = lastGoalsByMatch.filter((row) => Boolean(row.lastGoal));
    const homeFirstGoals = firstGoals.filter((row) => row.firstGoal?.teamId === row.match.home.teamId).length;
    const awayFirstGoals = firstGoals.filter((row) => row.firstGoal?.teamId === row.match.away.teamId).length;
    const homeLastGoals = lastGoals.filter((row) => row.lastGoal?.teamId === row.match.home.teamId).length;
    const awayLastGoals = lastGoals.filter((row) => row.lastGoal?.teamId === row.match.away.teamId).length;
    const noGoalMatches = events.filter((row) => row.covered && !row.events.some((play) => this.isGoal(play))).length;
    const redCardMatches = events.filter(({ events: plays }) => plays.some((p) => this.isRedCard(p))).length;
    const penaltyAwardedMatches = events.filter(({ events: plays }) => plays.some((p) => this.isPenaltyEvent(p))).length;
    const penaltyAwardedEvents = events.reduce((sum, row) => sum + row.events.filter((p) => this.isPenaltyEvent(p)).length, 0);
    const ownGoalMatches = events.filter(({ events: plays }) => plays.some((p) => p.ownGoal === true)).length;
    const ownGoalEvents = events.reduce((sum, row) => sum + row.events.filter((p) => p.ownGoal === true).length, 0);
    const substitutionCount = events.reduce((sum, row) => sum + row.events.filter((p) => p.substitution || /substitution/i.test(`${p.type} ${p.typeKey ?? ''}`)).length, 0);
    const firstHalfGoals = events.reduce((sum, row) => sum + row.events.filter((p) => this.isGoal(p) && (p.period ?? this.periodFromMinute(p)) <= 1).length, 0);
    const secondHalfGoals = events.reduce((sum, row) => sum + row.events.filter((p) => this.isGoal(p) && (p.period ?? this.periodFromMinute(p)) >= 2).length, 0);
    const timelineGoals = events.flatMap(({ events: plays }) => plays.filter((play) => this.isGoal(play)));
    const earlyGoals = timelineGoals.filter((play) => this.minute(play) <= 30).length;
    const lateGoals = timelineGoals.filter((play) => this.minute(play) >= 76).length;
    const after75Goals = timelineGoals.filter((play) => this.minute(play) > 75).length;
    const earlyGoalMatches = events.filter(({ events: plays }) => plays.some((play) => this.isGoal(play) && this.minute(play) <= 30)).length;
    const lateGoalMatches = events.filter(({ events: plays }) => plays.some((play) => this.isGoal(play) && this.minute(play) >= 76)).length;
    const after75Matches = events.filter(({ events: plays }) => plays.some((play) => this.isGoal(play) && this.minute(play) > 75)).length;
    const sourceTimelineMatches = events.filter((row) => row.covered).length;
    const fixtureCount = matches.length;
    const comp = matches[0].fixture.competitionId;
    const season = matches[0].fixture.seasonId;
    return {
      id: `competition-scoring:${comp}:${season}`, competitionId: comp, seasonId: season, calculatedAt, sourceFixtureCount: fixtureCount,
      metrics: {
        matches: fixtureCount, totalGoals: homeGoals + awayGoals, homeGoals, awayGoals,
        averageGoalsPerMatch: this.ratio(homeGoals + awayGoals, fixtureCount), averageHomeGoals: this.ratio(homeGoals, fixtureCount), averageAwayGoals: this.ratio(awayGoals, fixtureCount),
        bttsRate: this.percent(btts, fixtureCount), over15Rate: this.percent(over15, fixtureCount), over25Rate: this.percent(over25, fixtureCount), over35Rate: this.percent(over35, fixtureCount), under25Rate: this.percent(under25, fixtureCount), cleanSheetRate: this.percent(cleanSheetMatches, fixtureCount),
        eventMetrics: {
          firstGoalTimeAverageMinutes: firstGoals.length ? firstGoals.reduce((sum, row) => sum + this.minute(row.firstGoal!), 0) / firstGoals.length : null,
          firstGoalRecordedMatches: firstGoals.length,
          homeFirstGoalMatches: homeFirstGoals,
          awayFirstGoalMatches: awayFirstGoals,
          homeFirstGoalRate: this.percent(homeFirstGoals, sourceTimelineMatches),
          awayFirstGoalRate: this.percent(awayFirstGoals, sourceTimelineMatches),
          lastGoalRecordedMatches: lastGoals.length,
          homeLastGoalMatches: homeLastGoals,
          awayLastGoalMatches: awayLastGoals,
          homeLastGoalRate: this.percent(homeLastGoals, sourceTimelineMatches),
          awayLastGoalRate: this.percent(awayLastGoals, sourceTimelineMatches),
          noGoalMatches,
          noGoalMatchRate: this.percent(noGoalMatches, sourceTimelineMatches),
          firstHalfGoals, secondHalfGoals,
          earlyGoals, lateGoals, goalsAfter75Minutes: after75Goals,
          earlyGoalRate: this.percent(earlyGoals, timelineGoals.length),
          lateGoalRate: this.percent(lateGoals, timelineGoals.length),
          goalAfter75MinutesRate: this.percent(after75Goals, timelineGoals.length),
          matchesWithEarlyGoal: earlyGoalMatches,
          matchesWithEarlyGoalRate: this.percent(earlyGoalMatches, sourceTimelineMatches),
          matchesWithLateGoal: lateGoalMatches,
          matchesWithLateGoalRate: this.percent(lateGoalMatches, sourceTimelineMatches),
          matchesWithGoalAfter75: after75Matches,
          matchesWithGoalAfter75Rate: this.percent(after75Matches, sourceTimelineMatches),
          totalTimelineGoals: timelineGoals.length,
          redCardMatches,
          redCardMatchRate: this.percent(redCardMatches, sourceTimelineMatches),
          penaltyAwardedMatches,
          penaltyAwardedEvents,
          penaltyAwardedMatchRate: this.percent(penaltyAwardedMatches, sourceTimelineMatches),
          ownGoalMatches,
          ownGoalEvents,
          ownGoalMatchRate: this.percent(ownGoalMatches, sourceTimelineMatches),
          substitutionCount,
          timelineCoverageMatches: sourceTimelineMatches,
          timelineCoverageRate: this.percent(sourceTimelineMatches, fixtureCount),
        },
      },
    };
  }

  private teamEventMetrics(
    rows: Array<{ match: Match; events: SportsMatchTimelineEventRecord[] }>,
    teamId: string,
    timelineCoverageFixtureIds: Set<string>,
  ): Record<string, unknown> {
    let firstGoalMatches = 0, firstGoals = 0, firstHalfGoals = 0, secondHalfGoals = 0, earlyGoals = 0, lateGoals = 0, goalsAfter75 = 0, redCardMatches = 0, penaltyAwardedMatches = 0, penaltyAwardedEvents = 0, ownGoalMatches = 0, ownGoalEvents = 0, substitutions = 0, timelineMatches = 0;
    let firstGoalMinutesTotal = 0;
    let lastGoalMatches = 0;
    timelineMatches = rows.filter((row) => timelineCoverageFixtureIds.has(row.match.fixture.id)).length;
    for (const row of rows) {
      if (!timelineCoverageFixtureIds.has(row.match.fixture.id)) continue;
      const validEvents = row.events.filter((play) => play.valid !== false);
      const goals = validEvents.filter((p) => this.isGoal(p)).sort((a, b) => this.minute(a) - this.minute(b));
      if (goals.length) {
        const first = goals[0];
        const last = goals[goals.length - 1];
        if (first.teamId === teamId) { firstGoalMatches += 1; firstGoals += 1; firstGoalMinutesTotal += this.minute(first); }
        if (last.teamId === teamId) lastGoalMatches += 1;
      }
      firstHalfGoals += goals.filter((p) => (p.period ?? this.periodFromMinute(p)) <= 1 && p.teamId === teamId).length;
      secondHalfGoals += goals.filter((p) => (p.period ?? this.periodFromMinute(p)) >= 2 && p.teamId === teamId).length;
      earlyGoals += goals.filter((p) => this.minute(p) <= 30 && p.teamId === teamId).length;
      lateGoals += goals.filter((p) => this.minute(p) >= 76 && p.teamId === teamId).length;
      goalsAfter75 += goals.filter((p) => this.minute(p) > 75 && p.teamId === teamId).length;
      if (validEvents.some((p) => this.isRedCard(p) && p.teamId === teamId)) redCardMatches += 1;
      const penalties = validEvents.filter((p) => this.isPenaltyEvent(p));
      if (penalties.some((p) => p.teamId === teamId)) penaltyAwardedMatches += 1;
      penaltyAwardedEvents += penalties.filter((p) => p.teamId === teamId).length;
      const ownGoals = validEvents.filter((p) => p.ownGoal === true);
      if (ownGoals.some((p) => p.teamId === teamId)) ownGoalMatches += 1;
      ownGoalEvents += ownGoals.filter((p) => p.teamId === teamId).length;
      substitutions += validEvents.filter((p) => (p.substitution || /substitution/i.test(`${p.type} ${p.typeKey ?? ''}`)) && p.teamId === teamId).length;
    }
    return { matchesWithTimeline: timelineMatches, firstGoalMatches, firstGoalRate: this.percent(firstGoalMatches, timelineMatches), lastGoalMatches, lastGoalRate: this.percent(lastGoalMatches, timelineMatches), averageFirstGoalMinute: firstGoals ? firstGoalMinutesTotal / firstGoals : null, firstHalfGoals, secondHalfGoals, earlyGoals, lateGoals, goalsAfter75, redCardMatches, redCardMatchRate: this.percent(redCardMatches, timelineMatches), penaltyAwardedMatches, penaltyAwardedEvents, penaltyAwardedMatchRate: this.percent(penaltyAwardedMatches, timelineMatches), ownGoalMatches, ownGoalEvents, ownGoalMatchRate: this.percent(ownGoalMatches, timelineMatches), substitutions };
  }

  private async calculateHeadToHead(competitionId: string, calculatedAt: Date): Promise<any[]> {
    const retainedAt = new Date();
    const history = await this.fixtureModel.find({
      competitionId,
      $and: [
        { $or: [{ 'status.state': 'COMPLETED' }, { 'status.isFinal': true }] },
        { $or: [
          { retentionExpiresAt: { $gt: retainedAt } },
          { retentionExpiresAt: { $exists: false } },
          { retentionExpiresAt: null },
        ] },
      ],
    }).sort({ kickoffAt: 1 }).select('id competitionId seasonId kickoffAt status competitors').lean().exec() as SportsFixtureRecord[];
    const historyIds = history.map((fixture) => fixture.id);
    const factRows = historyIds.length
      ? await this.matchFactsModel.find({ fixtureId: { $in: historyIds } })
        .select('fixtureId matchResult').lean().exec() as SportsMatchFactsRecord[]
      : [];
    const factsByFixture = new Map(factRows.map((facts) => [facts.fixtureId, facts] as const));
    const matches = history
      .map((fixture) => this.toCompletedMatch(fixture, factsByFixture.get(fixture.id)))
      .filter((item): item is Match => Boolean(item));
    const pairs = new Map<string, Match[]>();
    for (const match of matches) {
      const [a, b] = [match.home.teamId, match.away.teamId].sort();
      const key = `${a}|${b}`;
      const rows = pairs.get(key) ?? []; rows.push(match); pairs.set(key, rows);
    }
    return [...pairs.entries()].map(([key, rows]) => {
      const [teamAId, teamBId] = key.split('|');
      let teamAWins = 0, teamBWins = 0, draws = 0, teamAGoals = 0, teamBGoals = 0, btts = 0, over25 = 0;
      const teamAHome: Match[] = [], teamAAway: Match[] = [];
      for (const match of rows) {
        const aIsHome = match.home.teamId === teamAId;
        const aGoals = aIsHome ? match.homeGoals : match.awayGoals;
        const bGoals = aIsHome ? match.awayGoals : match.homeGoals;
        teamAGoals += aGoals; teamBGoals += bGoals;
        if (aGoals > bGoals) teamAWins += 1; else if (aGoals < bGoals) teamBWins += 1; else draws += 1;
        if (aGoals > 0 && bGoals > 0) btts += 1;
        if (aGoals + bGoals > 2.5) over25 += 1;
        (aIsHome ? teamAHome : teamAAway).push(match);
      }
      const recent = [...rows].sort((a, b) => b.fixture.kickoffAt.getTime() - a.fixture.kickoffAt.getTime());
      // Rank-decay weighting gives the latest meeting weight 1, the previous
      // meeting 1/2, then 1/3, etc. The weighting is explicit in the payload so
      // prediction consumers can use the weighted values or apply another policy.
      const weightedRows = recent.map((match, index) => ({ match, weight: 1 / (index + 1) }));
      const totalWeight = weightedRows.reduce((sum, row) => sum + row.weight, 0);
      let weightedTeamAWins = 0, weightedTeamBWins = 0, weightedDraws = 0;
      let weightedTeamAGoals = 0, weightedTeamBGoals = 0, weightedBtts = 0, weightedOver25 = 0;
      for (const { match, weight } of weightedRows) {
        const aIsHome = match.home.teamId === teamAId;
        const aGoals = aIsHome ? match.homeGoals : match.awayGoals;
        const bGoals = aIsHome ? match.awayGoals : match.homeGoals;
        weightedTeamAGoals += aGoals * weight;
        weightedTeamBGoals += bGoals * weight;
        if (aGoals > bGoals) weightedTeamAWins += weight;
        else if (aGoals < bGoals) weightedTeamBWins += weight;
        else weightedDraws += weight;
        if (aGoals > 0 && bGoals > 0) weightedBtts += weight;
        if (aGoals + bGoals > 2.5) weightedOver25 += weight;
      }
      const recencyWeighted = {
        method: 'rank-decay: 1 / (recencyRank + 1)',
        sampleSize: rows.length,
        totalWeight: Number(totalWeight.toFixed(4)),
        teamAWinRate: this.percent(weightedTeamAWins, totalWeight),
        teamBWinRate: this.percent(weightedTeamBWins, totalWeight),
        drawRate: this.percent(weightedDraws, totalWeight),
        averageTeamAGoals: this.ratio(weightedTeamAGoals, totalWeight),
        averageTeamBGoals: this.ratio(weightedTeamBGoals, totalWeight),
        averageTotalGoals: this.ratio(weightedTeamAGoals + weightedTeamBGoals, totalWeight),
        bttsRate: this.percent(weightedBtts, totalWeight),
        over25Rate: this.percent(weightedOver25, totalWeight),
      };
      const winSummary = (items: Match[], focalTeamId: string) => {
        let wins = 0, draws = 0, losses = 0, goalsFor = 0, goalsAgainst = 0;
        for (const item of items) {
          const focalIsHome = item.home.teamId === focalTeamId;
          const gf = focalIsHome ? item.homeGoals : item.awayGoals;
          const ga = focalIsHome ? item.awayGoals : item.homeGoals;
          goalsFor += gf; goalsAgainst += ga;
          if (gf > ga) wins += 1; else if (gf === ga) draws += 1; else losses += 1;
        }
        return { played: items.length, wins, draws, losses, winRate: this.percent(wins, items.length), goalsFor, goalsAgainst, averageGoalsFor: this.ratio(goalsFor, items.length), averageGoalsAgainst: this.ratio(goalsAgainst, items.length) };
      };
      const teamBHome = rows.filter((match) => match.home.teamId === teamBId);
      const teamBAway = rows.filter((match) => match.away.teamId === teamBId);
      return {
        id: `h2h:${competitionId}:${teamAId}:${teamBId}`, competitionId, teamAId, teamBId, calculatedAt, sourceFixtureCount: rows.length,
        metrics: { totalMeetings: rows.length, teamAWins, teamBWins, draws, teamAWinRate: this.percent(teamAWins, rows.length), teamBWinRate: this.percent(teamBWins, rows.length), drawRate: this.percent(draws, rows.length), teamAGoals, teamBGoals, averageTotalGoals: this.ratio(teamAGoals + teamBGoals, rows.length), bttsRate: this.percent(btts, rows.length), over25Rate: this.percent(over25, rows.length), recencyWeighted, last5: recent.slice(0, 5).map((m, index) => this.h2hResult(m, teamAId, teamBId, index)), last10: recent.slice(0, 10).map((m, index) => this.h2hResult(m, teamAId, teamBId, index)), homeAway: { teamAHome: winSummary(teamAHome, teamAId), teamAAway: winSummary(teamAAway, teamAId), teamBHome: winSummary(teamBHome, teamBId), teamBAway: winSummary(teamBAway, teamBId) } },
      };
    });
  }

  private h2hResult(match: Match, teamAId: string, teamBId: string, recencyRank = 0): Record<string, unknown> {
    const aGoals = match.home.teamId === teamAId ? match.homeGoals : match.awayGoals;
    const bGoals = match.home.teamId === teamAId ? match.awayGoals : match.homeGoals;
    return {
      fixtureId: match.fixture.id,
      kickoffAt: match.fixture.kickoffAt,
      teamAScore: aGoals,
      teamBScore: bGoals,
      result: aGoals > bGoals ? 'A' : aGoals < bGoals ? 'B' : 'D',
      homeTeamId: match.home.teamId,
      recencyRank,
      recencyWeight: Number((1 / (recencyRank + 1)).toFixed(4)),
    };
  }

  private calculateTeamStatistics(
    matches: Match[],
    calculatedAt: Date,
    matchFactsByFixture: Map<string, SportsMatchFactsRecord>,
  ): any[] {
    const byTeam = new Map<string, Match[]>();
    for (const match of matches) for (const teamId of [match.home.teamId, match.away.teamId]) {
      const rows = byTeam.get(teamId) ?? []; rows.push(match); byTeam.set(teamId, rows);
    }
    return [...byTeam.entries()].map(([teamId, rows]) => {
      const ordered = [...rows].sort((a, b) => b.fixture.kickoffAt.getTime() - a.fixture.kickoffAt.getTime());
      const aggregate = (selected: Match[]) => this.averageStats(selected, teamId, matchFactsByFixture);
      return { id: `team-statistics:${rows[0].fixture.competitionId}:${rows[0].fixture.seasonId}:${teamId}`, competitionId: rows[0].fixture.competitionId, seasonId: rows[0].fixture.seasonId, teamId, calculatedAt, sourceFixtureCount: rows.length, metrics: { season: aggregate(ordered), last5: aggregate(ordered.slice(0, 5)), last10: aggregate(ordered.slice(0, 10)), home: aggregate(ordered.filter((m) => m.home.teamId === teamId)), away: aggregate(ordered.filter((m) => m.away.teamId === teamId)) } };
    });
  }

  private averageStats(
    matches: Match[],
    teamId: string,
    matchFactsByFixture: Map<string, SportsMatchFactsRecord>,
  ): Record<string, unknown> {
    const values = new Map<string, { label?: string; samples: number[] }>();
    for (const match of matches) {
      const side = match.home.teamId === teamId ? match.home : match.away;
      const rawStats = this.getMatchTeamStatistics(
        match, teamId, side.statistics ?? [], matchFactsByFixture.get(match.fixture.id),
      );
      for (const raw of rawStats) {
        const key = String(raw.name ?? raw.abbreviation ?? raw.key ?? '').trim();
        if (!key) continue;
        const value = this.numeric(raw.value ?? raw.displayValue ?? raw.valueText);
        if (value === null) continue;
        const entry = values.get(key) ?? { label: typeof (raw.label ?? raw.providerLabel) === 'string' ? String(raw.label ?? raw.providerLabel) : undefined, samples: [] };
        entry.samples.push(value); values.set(key, entry);
      }
    }
    const result: Record<string, unknown> = { matchesConsidered: matches.length, statistics: {} };
    const statistics: Record<string, unknown> = {};
    for (const [key, item] of values) {
      const sampleCount = item.samples.length;
      const total = item.samples.reduce((sum, value) => sum + value, 0);
      const average = sampleCount > 0 ? total / sampleCount : 0;
      const squaredDeviationTotal = item.samples.reduce(
        (sum, value) => sum + (value - average) ** 2,
        0,
      );
      // Sample variance is persisted only when at least two actual observations exist.
      const variance = sampleCount > 1
        ? squaredDeviationTotal / (sampleCount - 1)
        : null;
      statistics[key] = {
        label: item.label,
        average,
        samples: sampleCount,
        total,
        variance,
        minimum: sampleCount ? Math.min(...item.samples) : null,
        maximum: sampleCount ? Math.max(...item.samples) : null,
      };
    }
    result.statistics = statistics;
    const average = (...keys: string[]): number | null => {
      for (const key of keys) {
        const entry = statistics[key] as { average?: number } | undefined;
        if (entry && typeof entry.average === 'number' && Number.isFinite(entry.average)) return entry.average;
      }
      return null;
    };
    const totalShots = average('totalShots', 'shots');
    const shotsOnTarget = average('shotsOnTarget', 'shotsOnGoal');
    const directShotsOffTarget = average('shotsOffTarget', 'shotsOffGoal');
    const blockedShots = average('blockedShots');
    result.canonicalAverages = {
      shots: totalShots,
      shotsOnTarget,
      shotsOffTarget: directShotsOffTarget !== null
        ? directShotsOffTarget
        : (totalShots !== null && shotsOnTarget !== null && blockedShots !== null
          ? Math.max(0, totalShots - shotsOnTarget - blockedShots)
          : null),
      possession: average('possessionPct', 'possession'),
      corners: average('wonCorners', 'cornerKicks'),
      fouls: average('foulsCommitted', 'fouls'),
      yellowCards: average('yellowCards'),
      redCards: average('redCards'),
      offsides: average('offsides'),
      saves: average('saves'),
    };
    return result;
  }

  private getMatchTeamStatistics(
    match: Match,
    teamId: string,
    primary: Array<Record<string, unknown>>,
    matchFacts?: SportsMatchFactsRecord,
  ): Array<Record<string, unknown>> {
    const normalizedTeam = matchFacts?.teamStatistics?.find((row) => row.teamId === teamId);
    const normalized = (normalizedTeam?.statistics ?? [])
      .filter((stat) => stat.value !== null && Number.isFinite(Number(stat.value)))
      .map((stat) => ({
        name: stat.canonicalKey ?? stat.providerKey,
        key: stat.canonicalKey ?? stat.providerKey,
        label: stat.providerLabel,
        providerLabel: stat.providerLabel,
        value: stat.value,
        displayValue: stat.displayValue,
      }));
    if (normalized.length && primary.length) {
      // Summary facts fill gaps in scoreboard statistics. Canonical aliases are
      // compared before merging so one observation is never counted twice.
      const canonicalize = (value: unknown): string => {
        const key = String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const aliases: Record<string, string> = {
          totalshots: 'shots', shotsattempted: 'shots',
          shotsongoal: 'shotsontarget', ongoal: 'shotsontarget',
          cornerkicks: 'corners', cornerkick: 'corners', woncorners: 'corners',
          possessionpct: 'possession',
          foulscommitted: 'fouls',
          passpct: 'passaccuracy', passcompletionpct: 'passaccuracy',
          totalpasses: 'passes',
          totalcrosses: 'crosses', crosspct: 'crossaccuracy',
          shotpct: 'shotaccuracy', shotsblocked: 'shotsblocked',
          penaltykickgoals: 'penaltiesscored',
        };
        return aliases[key] ?? key;
      };
      const normalizedKeys = new Set(normalized.map((row) => canonicalize(row.name)));
      const supplemental = primary.filter((row) =>
        !normalizedKeys.has(canonicalize(row.name ?? row.abbreviation ?? row.key)),
      );
      return [...normalized, ...supplemental];
    }
    if (normalized.length) return normalized;
    if (primary.length) return primary;
    const rawPayload = match.fixture.rawPayload as any;
    const summary = rawPayload?.summaryFallback ?? rawPayload;
    const boxscoreTeams = Array.isArray(summary?.boxscore?.teams) ? summary.boxscore.teams : [];
    const summaryTeam = boxscoreTeams.find((entry: any) => {
      const candidate = entry?.team ?? entry;
      const rawId = String(candidate?.id ?? '').trim();
      return rawId && `team:${rawId}` === teamId;
    });
    return Array.isArray(summaryTeam?.statistics) ? summaryTeam.statistics : [];
  }

  private calculatePlayerEventTotals(
    matches: Match[],
    timelineByFixture: Map<string, SportsMatchTimelineEventRecord[]>,
    calculatedAt: Date,
    matchFactsByFixture: Map<string, SportsMatchFactsRecord>,
  ): any[] {
    type PlayerMetric = 'goals' | 'assists' | 'ownGoals' | 'yellowCards' | 'redCards' | 'penaltiesScored' | 'penaltiesMissed';
    type PlayerMatchActivity = {
      date: Date;
      goals: number;
      assists: number;
      ownGoals: number;
      yellowCards: number;
      redCards: number;
      penaltiesScored: number;
      penaltiesMissed: number;
      appearances: number | null;
      appearanceKnown: boolean;
      eventInvolved: boolean;
    };
    type PlayerAggregate = {
      playerId: string;
      name?: string;
      matches: Map<string, PlayerMatchActivity>;
    };

    const players = new Map<string, PlayerAggregate>();
    const rosterCoverageFixtures = new Set<string>();
    const getPlayer = (playerId: string, name?: string): PlayerAggregate => {
      let player = players.get(playerId);
      if (!player) {
        player = { playerId, name, matches: new Map() };
        players.set(playerId, player);
      } else if (!player.name && name) {
        player.name = name;
      }
      return player;
    };
    const getActivity = (playerId: string, match: Match, name?: string): PlayerMatchActivity => {
      const player = getPlayer(playerId, name);
      let activity = player.matches.get(match.fixture.id);
      if (!activity) {
        activity = {
          date: new Date(match.fixture.kickoffAt),
          goals: 0,
          assists: 0,
          ownGoals: 0,
          yellowCards: 0,
          redCards: 0,
          penaltiesScored: 0,
          penaltiesMissed: 0,
          appearances: null,
          appearanceKnown: false,
          eventInvolved: false,
        };
        player.matches.set(match.fixture.id, activity);
      }
      return activity;
    };

    for (const match of matches) {
      const plays = timelineByFixture.get(match.fixture.id) ?? [];
      for (const event of plays) {
        if (event.valid === false) continue;
        const people = event.involvedAthletes?.length
          ? event.involvedAthletes
          : [event.athleteId ? { athleteId: event.athleteId, role: 'participant' } : undefined]
              .filter(Boolean) as NonNullable<SportsMatchTimelineEventRecord['involvedAthletes']>;
        if (!people.length) continue;

        const goalPeople = people.filter((person) => /scor|goal.?scorer|finisher/.test(String(person.role ?? '').toLowerCase()));
        const assistPeople = people.filter((person) => /assist/.test(String(person.role ?? '').toLowerCase()));
        const cardPeople = people.filter((person) => /carded|offender|recipient/.test(String(person.role ?? '').toLowerCase()));
        const penaltyPeople = people.filter((person) => /penalt|shooter|taker/.test(String(person.role ?? '').toLowerCase()));

        // Plays participants are event involvement, not proof of an appearance.
        for (const person of people) {
          if (!person.athleteId) continue;
          getActivity(person.athleteId, match, person.name).eventInvolved = true;
        }

        if (this.isGoal(event)) {
          if (event.ownGoal) {
            const ownGoalPlayer = goalPeople[0] ?? people[0];
            if (ownGoalPlayer?.athleteId) {
              getActivity(ownGoalPlayer.athleteId, match, ownGoalPlayer.name).ownGoals += 1;
            }
          } else {
            const scorer = goalPeople[0] ?? (assistPeople.length ? undefined : people[0]);
            if (scorer?.athleteId) {
              const activity = getActivity(scorer.athleteId, match, scorer.name);
              activity.goals += 1;
              if (event.penaltyKick && event.scoringPlay) activity.penaltiesScored += 1;
            }
          }
        }

        for (const assister of assistPeople) {
          if (assister.athleteId) getActivity(assister.athleteId, match, assister.name).assists += 1;
        }

        if (event.yellowCard || event.redCard) {
          const carded = cardPeople[0] ?? people[0];
          if (carded?.athleteId) {
            const activity = getActivity(carded.athleteId, match, carded.name);
            if (event.yellowCard) activity.yellowCards += 1;
            if (event.redCard) activity.redCards += 1;
          }
        }

        if (event.penaltyKick && !this.isGoal(event) && /miss|saved|wide|off target|failed/i.test(`${event.description ?? ''} ${event.type}`)) {
          const taker = penaltyPeople[0] ?? people[0];
          if (taker?.athleteId) getActivity(taker.athleteId, match, taker.name).penaltiesMissed += 1;
        }
      }

      const roster = this.extractSummaryRosterRows(match, matchFactsByFixture.get(match.fixture.id));
      if (roster.length) rosterCoverageFixtures.add(match.fixture.id);
      for (const row of roster) {
        // An explicit zero appearance is retained only when the player also has
        // event involvement or a non-zero match statistic. Unused bench players
        // are not added to the player projection as active participants.
        const hasNonZeroMetric = Object.values(row.metrics).some((value) => value > 0);
        if ((row.appearances ?? 0) <= 0 && !hasNonZeroMetric && !players.get(row.playerId)?.matches.has(match.fixture.id)) continue;

        const activity = getActivity(row.playerId, match, row.name);
        if (row.appearances !== null) {
          activity.appearances = row.appearances;
          activity.appearanceKnown = true;
        }
        // Summary player statistics are match totals and are more complete than
        // isolated play participants. A supplied zero is authoritative too, so
        // it replaces any conflicting partial Plays count rather than doubling it.
        for (const metric of Object.keys(row.metrics) as PlayerMetric[]) {
          activity[metric] = row.metrics[metric]!;
        }
      }
    }

    const completedFixtureCount = matches.length;
    return [...players.values()].map((player) => {
      const allActivities = [...player.matches.entries()]
        .map(([fixtureId, activity]) => ({ fixtureId, ...activity }))
        .sort((a, b) => b.date.getTime() - a.date.getTime());
      const appearanceActivities = allActivities.filter((item) => item.appearanceKnown && (item.appearances ?? 0) > 0);
      const appearanceDataAvailable = appearanceActivities.length > 0
        || allActivities.some((item) => item.appearanceKnown);
      // Once ESPN supplies appearance facts for a player, recent appearance
      // windows must not silently mix in event-only matches without roster data.
      const recentActivities = appearanceDataAvailable
        ? appearanceActivities
        : allActivities.filter((item) => item.eventInvolved);
      const lastFive = recentActivities.slice(0, 5);
      const total = (key: PlayerMetric) => allActivities.reduce((sum, item) => sum + item[key], 0);
      const appearances = appearanceActivities.reduce((sum, item) => sum + (item.appearances ?? 0), 0);
      const goals = total('goals');
      const assists = total('assists');
      const yellowCards = total('yellowCards');
      const redCards = total('redCards');
      // Per-appearance rates use only match rows where ESPN actually supplied
      // appearance facts. Event-only totals remain available separately and
      // are not divided by a partial appearance denominator.
      const appearanceGoals = appearanceActivities.reduce((sum, item) => sum + item.goals, 0);
      const appearanceAssists = appearanceActivities.reduce((sum, item) => sum + item.assists, 0);
      const appearanceYellowCards = appearanceActivities.reduce((sum, item) => sum + item.yellowCards, 0);
      const appearanceRedCards = appearanceActivities.reduce((sum, item) => sum + item.redCards, 0);
      const cardedAppearances = appearanceActivities.filter((item) => item.yellowCards > 0 || item.redCards > 0).length;
      const recentGoals = lastFive.reduce((sum, item) => sum + item.goals, 0);
      const recentYellowCards = lastFive.reduce((sum, item) => sum + item.yellowCards, 0);
      const recentRedCards = lastFive.reduce((sum, item) => sum + item.redCards, 0);
      const recentCardMatches = lastFive.filter((item) => item.yellowCards > 0 || item.redCards > 0).length;
      const knownAppearanceFixtureCount = allActivities.filter((item) => item.appearanceKnown).length;
      const involvementMatchCount = allActivities.filter((item) => item.eventInvolved).length;
      const lastFiveAppearanceIds = new Set(lastFive.map((item) => item.fixtureId));
      const recentAppearanceActivities = appearanceActivities.filter((item) => lastFiveAppearanceIds.has(item.fixtureId));
      const recentCardedAppearanceCount = recentAppearanceActivities.filter((item) => item.yellowCards > 0 || item.redCards > 0).length;
      const playerMetrics: Record<string, unknown> = {
        goals,
        assists,
        ownGoals: total('ownGoals'),
        yellowCards,
        redCards,
        penaltiesScored: total('penaltiesScored'),
        penaltiesMissed: total('penaltiesMissed'),
        goalInvolvements: goals + assists,
        eventInvolvementMatches: involvementMatchCount,
        appearances: appearanceDataAvailable ? appearances : null,
        goalsPerAppearance: appearanceDataAvailable ? this.ratio(appearanceGoals, appearances) : null,
        assistsPerAppearance: appearanceDataAvailable ? this.ratio(appearanceAssists, appearances) : null,
        goalInvolvementsPerAppearance: appearanceDataAvailable ? this.ratio(appearanceGoals + appearanceAssists, appearances) : null,
        cardsPerAppearance: appearanceDataAvailable ? this.ratio(appearanceYellowCards + appearanceRedCards, appearances) : null,
        cardedAppearances,
        cardFrequencyPerAppearance: appearanceDataAvailable ? this.ratio(cardedAppearances, appearances) : null,
        appearanceDataAvailable,
        appearanceSource: appearanceDataAvailable ? 'ESPN_SUMMARY_ROSTERS' : null,
        appearanceCoverageFixtures: knownAppearanceFixtureCount,
        rosterCoverageFixtures: rosterCoverageFixtures.size,
        appearanceCoverageRate: this.percent(rosterCoverageFixtures.size, completedFixtureCount),
        recentScoringForm: lastFive.map((item) => ({
          fixtureId: item.fixtureId,
          kickoffAt: item.date,
          goals: item.goals,
          appearances: item.appearances,
        })),
        recentGoalsLast5Appearances: appearanceDataAvailable ? recentGoals : null,
        recentAssistsLast5Appearances: appearanceDataAvailable ? lastFive.reduce((sum, item) => sum + item.assists, 0) : null,
        recentGoalsLast5InvolvedMatches: recentGoals,
        recentYellowCardsLast5InvolvedMatches: recentYellowCards,
        recentRedCardsLast5InvolvedMatches: recentRedCards,
        recentCardMatchesLast5InvolvedMatches: recentCardMatches,
        recentCardFrequencyLast5InvolvedMatches: this.percent(recentCardMatches, lastFive.length),
        recentCardEventsLast5InvolvedMatches: recentYellowCards + recentRedCards,
        recentCardEventsLast5Appearances: appearanceDataAvailable ? recentYellowCards + recentRedCards : null,
        recentCardFrequencyLast5Appearances: appearanceDataAvailable
          ? this.percent(recentCardedAppearanceCount, recentAppearanceActivities.length)
          : null,
        totalCardEvents: yellowCards + redCards,
        recentCardEvents: recentYellowCards + recentRedCards,
      };

      return {
        id: `player-events:${matches[0].fixture.competitionId}:${matches[0].fixture.seasonId}:${player.playerId}`,
        competitionId: matches[0].fixture.competitionId,
        seasonId: matches[0].fixture.seasonId,
        playerId: player.playerId,
        calculatedAt,
        sourceFixtureCount: allActivities.length,
        metrics: playerMetrics,
      };
    });
  }

  private extractSummaryRosterRows(match: Match, matchFacts?: SportsMatchFactsRecord): Array<{

    playerId: string;
    name?: string;
    appearances: number | null;
    metrics: Partial<Record<'goals' | 'assists' | 'ownGoals' | 'yellowCards' | 'redCards' | 'penaltiesScored' | 'penaltiesMissed', number>>;
  }> {
    const normalizedPlayers = matchFacts?.playerAppearances ?? [];
    if (normalizedPlayers.length) {
      const supportedMetrics = new Set([
        'goals', 'assists', 'ownGoals', 'yellowCards', 'redCards',
        'penaltiesScored', 'penaltiesMissed',
      ]);
      return normalizedPlayers.map((player) => {
        const metrics: Partial<Record<'goals' | 'assists' | 'ownGoals' | 'yellowCards' | 'redCards' | 'penaltiesScored' | 'penaltiesMissed', number>> = {};
        for (const statistic of player.statistics ?? []) {
          const key = String(statistic.canonicalKey ?? '').trim();
          if (!supportedMetrics.has(key) || statistic.value === null || !Number.isFinite(Number(statistic.value))) continue;
          metrics[key as keyof typeof metrics] = Number(statistic.value);
        }
        return {
          playerId: player.playerId,
          name: player.name,
          appearances: player.appearances,
          metrics,
        };
      });
    }

    const rawPayload = match.fixture.rawPayload as any;
    const summary = rawPayload?.summaryFallback ?? rawPayload;
    const rosterSections = Array.isArray(summary?.rosters)
      ? summary.rosters
      : Array.isArray(summary?.boxscore?.rosters)
        ? summary.boxscore.rosters
        : [];
    if (!rosterSections.length) return [];

    const output: Array<{
      playerId: string;
      name?: string;
      appearances: number | null;
      metrics: Partial<Record<'goals' | 'assists' | 'ownGoals' | 'yellowCards' | 'redCards' | 'penaltiesScored' | 'penaltiesMissed', number>>;
    }> = [];
    const metricAliases: Record<string, string[]> = {
      goals: ['totalgoals', 'goals', 'goal'],
      assists: ['goalassists', 'assists', 'assist'],
      ownGoals: ['owngoals', 'owngoal'],
      yellowCards: ['yellowcards', 'yellowcard'],
      redCards: ['redcards', 'redcard'],
      penaltiesScored: ['penaltiesscored', 'penaltyscored', 'penaltygoals'],
      penaltiesMissed: ['penaltiesmissed', 'penaltymissed', 'penaltymisses'],
    };

    for (const section of rosterSections) {
      const teamId = String(section?.team?.id ?? section?.teamId ?? '');
      const knownTeamIds = [match.home.teamId.replace(/^team:/, ''), match.away.teamId.replace(/^team:/, '')];
      if (teamId && !knownTeamIds.includes(teamId)) continue;
      const roster = Array.isArray(section?.roster) ? section.roster : Array.isArray(section?.players) ? section.players : [];
      for (const row of roster) {
        const athlete = row?.athlete ?? row?.player ?? {};
        const espnPlayerId = String(athlete?.id ?? row?.athleteId ?? '').trim();
        if (!espnPlayerId) continue;
        const stats = Array.isArray(row?.stats) ? row.stats : Array.isArray(row?.statistics) ? row.statistics : [];
        const values = new Map<string, number>();
        for (const stat of stats) {
          const keys = [stat?.name, stat?.displayName, stat?.shortDisplayName, stat?.abbreviation]
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.toLowerCase().replace(/[^a-z0-9]/g, ''));
          const statValue = this.numeric(stat?.value ?? stat?.displayValue);
          if (statValue === null) continue;
          for (const key of keys) values.set(key, statValue);
        }

        const appearanceStat = values.get('appearances') ?? values.get('appearance') ?? values.get('app');
        const started = row?.starter === true || row?.starter === 1;
        const substitutedIn = row?.subbedIn === true || row?.subbed_in === true;
        const appearances = appearanceStat !== undefined
          ? appearanceStat
          : (started || substitutedIn ? 1 : null);
        const metrics: Partial<Record<'goals' | 'assists' | 'ownGoals' | 'yellowCards' | 'redCards' | 'penaltiesScored' | 'penaltiesMissed', number>> = {};
        for (const [metric, aliases] of Object.entries(metricAliases)) {
          const value = aliases.map((alias) => values.get(alias)).find((candidate) => candidate !== undefined);
          if (value !== undefined) metrics[metric as keyof typeof metrics] = value;
        }
        output.push({
          playerId: `athlete:${espnPlayerId}`,
          name: typeof athlete?.displayName === 'string' ? athlete.displayName : (typeof athlete?.fullName === 'string' ? athlete.fullName : undefined),
          appearances,
          metrics,
        });
      }
    }
    return output;
  }

  private isRedCard(event: SportsMatchTimelineEventRecord): boolean {
    return event.redCard === true || /red\s*card|sent\s*off|dismissal/i.test(`${event.typeKey ?? ''} ${event.type ?? ''} ${event.description ?? ''}`);
  }

  private isPenaltyEvent(event: SportsMatchTimelineEventRecord): boolean {
    if (event.shootout) return false;
    return event.penaltyKick === true || /penalt(y|ies)(?:\s*kick)?/i.test(`${event.typeKey ?? ''} ${event.type ?? ''} ${event.description ?? ''}`);
  }

  private isGoal(event: SportsMatchTimelineEventRecord): boolean {
    if (event.shootout) return false;
    return Boolean(event.scoringPlay || (!event.ownGoal && /goal/i.test(`${event.typeKey ?? ''} ${event.type ?? ''}`)) || event.ownGoal);
  }

  private minute(event: SportsMatchTimelineEventRecord): number {
    const clockText = String(event.clock ?? '');
    const addedText = String(event.addedClock ?? '');
    const parseMinute = (value: string): number | undefined => {
      const match = value.match(/(\d+)(?:\s*['′]?)?(?:\s*\+\s*(\d+))?/);
      if (!match) return undefined;
      return Number(match[1]) + Number(match[2] ?? 0);
    };
    if (typeof event.clockSeconds === 'number') {
      const base = Math.max(0, Math.floor(event.clockSeconds / 60));
      const added = parseMinute(addedText);
      return base + (added === undefined ? 0 : (added > 45 ? Math.floor(added / 60) : added));
    }
    return parseMinute(clockText || addedText) ?? 0;
  }

  private periodFromMinute(event: SportsMatchTimelineEventRecord): number { return this.minute(event) <= 45 ? 1 : 2; }

  private numeric(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return null;
    const normalized = value.replace(/,/g, '').replace(/%/g, '').trim();
    if (!normalized || !/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private percent(numerator: number, denominator: number): number | null {
    return denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(2)) : null;
  }

  private ratio(numerator: number, denominator: number): number | null {
    return denominator > 0 ? Number((numerator / denominator).toFixed(3)) : null;
  }

  private groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
    const result = new Map<string, T[]>();
    for (const item of items) { const key = keyOf(item); const rows = result.get(key) ?? []; rows.push(item); result.set(key, rows); }
    return result;
  }

  private async upsertRows(model: Model<any>, rows: any[]): Promise<void> {
    if (!rows.length) return;
    await model.bulkWrite(rows.map((row) => ({ updateOne: { filter: { id: row.id }, update: { $set: row, $setOnInsert: { createdAt: new Date() } }, upsert: true } })), { ordered: false });
  }

  private async prune(model: Model<any>, scope: Record<string, unknown>, rows: any[]): Promise<void> {
    const ids = rows.map((row) => row.id);
    if (!ids.length) {
      await model.deleteMany(scope).exec();
      return;
    }
    await model.deleteMany({ ...scope, id: { $nin: ids } }).exec();
  }
}



