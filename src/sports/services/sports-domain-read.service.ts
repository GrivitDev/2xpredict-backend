import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import type {
  SportsCompetitionRecord,
  SportsFixtureRecord,
  SportsMatchOddsSnapshotRecord,
  SportsMatchTimelineEventRecord,
  SportsSeasonRecord,
  SportsTeamRecord,
} from '../interfaces/sports-domain.interface';
import type {
  SportsCompetitionListQuery,
  SportsFixtureContextReadModel,
  SportsFixtureQuery,
  SportsFixtureReadResult,
  SportsMatchReadModel,
  SportsTeamListQuery,
  SportsTeamReadModel,
} from '../interfaces/sports-read.interface';
import type {
  SportsTeamFormRecord,
  SportsTeamHomeAwayRecord,
  SportsTeamScoringRecord,
  SportsTeamStatisticsAggregateRecord,
  SportsCompetitionScoringTotalsRecord,
  SportsHeadToHeadRecord,
  SportsPlayerEventTotalsRecord,
} from '../interfaces/sports-derived-data.interface';
import { SportsDerivedProjectionService } from './sports-derived-projection.service';
import {
  SportsCompetition,
  SportsFixture,
  SportsMatchOddsSnapshot,
  SportsMatchTimelineEvent,
  SportsMatchFacts,
  SportsMatchSummary,
  SportsSeason,
  SportsTeam,
} from '../schemas';

/** Read-only API for normalized ESPN domain records. */
@Injectable()
export class SportsDomainReadService {
  constructor(
    @InjectModel(SportsCompetition.name) private readonly competitionModel: Model<any>,
    @InjectModel(SportsSeason.name) private readonly seasonModel: Model<any>,
    @InjectModel(SportsTeam.name) private readonly teamModel: Model<any>,
    @InjectModel(SportsFixture.name) private readonly fixtureModel: Model<any>,
    @InjectModel(SportsMatchTimelineEvent.name) private readonly timelineModel: Model<any>,
    @InjectModel(SportsMatchOddsSnapshot.name) private readonly oddsModel: Model<any>,
    @InjectModel(SportsMatchFacts.name) private readonly matchFactsModel: Model<any>,
    @InjectModel(SportsMatchSummary.name) private readonly matchSummaryModel: Model<any>,
    private readonly derived: SportsDerivedProjectionService,
  ) {}

  async countCompetitions(query: SportsCompetitionListQuery = {}): Promise<number> {
    return this.competitionModel.countDocuments(this.competitionFilter(query)).exec();
  }

  async getCompetitions(query: SportsCompetitionListQuery = {}): Promise<SportsCompetitionRecord[]> {
    const limit = Math.max(1, Math.min(query.limit ?? 250, 1_000));
    const rows = await this.competitionModel.find(this.competitionFilter(query))
      .sort({ name: 1, id: 1 }).limit(limit).select('-_id').lean().exec();
    return rows as SportsCompetitionRecord[];
  }

  async getCompetition(competitionId: string): Promise<SportsCompetitionRecord | null> {
    const row = await this.competitionModel.findOne({ $or: [{ id: competitionId }, { slug: competitionId }] })
      .select('-_id').lean().exec();
    return (row as SportsCompetitionRecord | null) ?? null;
  }

  async getSeasons(competitionId?: string): Promise<SportsSeasonRecord[]> {
    const filter = competitionId ? { competitionId } : {};
    const rows = await this.seasonModel.find(filter).sort({ competitionId: 1, year: -1 }).select('-_id').lean().exec();
    return rows as SportsSeasonRecord[];
  }

  async getSeason(seasonId: string): Promise<SportsSeasonRecord | null> {
    const row = await this.seasonModel.findOne({ id: seasonId }).select('-_id').lean().exec();
    return (row as SportsSeasonRecord | null) ?? null;
  }

  async getTeams(query: SportsTeamListQuery = {}): Promise<SportsTeamRecord[]> {
    const filter: Record<string, unknown> = {};
    if (query.leagueId) filter.leagueIds = query.leagueId.trim().toLowerCase();
    if (query.country) filter.country = new RegExp(this.escapeRegex(query.country), 'i');
    if (query.search?.trim()) {
      const expression = new RegExp(this.escapeRegex(query.search.trim()), 'i');
      filter.$or = [{ name: expression }, { displayName: expression }, { abbreviation: expression }];
    }
    const rows = await this.teamModel.find(filter).sort({ name: 1, id: 1 })
      .limit(Math.max(1, Math.min(query.limit ?? 250, 1_000))).select('-_id').lean().exec();
    return rows as SportsTeamRecord[];
  }

  async getTeam(teamId: string): Promise<SportsTeamRecord | null> {
    const row = await this.teamModel.findOne({ $or: [{ id: teamId }, { espnId: teamId }] }).select('-_id').lean().exec();
    return (row as SportsTeamRecord | null) ?? null;
  }

  async getFixture(fixtureId: string): Promise<SportsFixtureRecord | null> {
    const row = await this.fixtureModel.findOne({ $or: [{ id: fixtureId }, { espnEventId: fixtureId }] })
      .select('-_id').lean().exec();
    return (row as SportsFixtureRecord | null) ?? null;
  }

  async countFixtures(query: SportsFixtureQuery = {}): Promise<number> {
    const filter: Record<string, unknown> = {};
    if (query.competitionId) filter.competitionId = query.competitionId;
    if (query.seasonId) filter.seasonId = query.seasonId;
    if (query.state) filter['status.state'] = query.state;
    if (query.teamId) filter['competitors.teamId'] = query.teamId;
    if (query.from || query.to) {
      filter.kickoffAt = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      };
    }
    if (query.retainedOnly) {
      filter.$and = [{
        $or: [
          { retentionExpiresAt: { $gt: new Date() } },
          { retentionExpiresAt: { $exists: false } },
          { retentionExpiresAt: null },
        ],
      }];
    }
    return this.fixtureModel.countDocuments(filter).exec();
  }

  async getFixtures(query: SportsFixtureQuery = {}): Promise<SportsFixtureReadResult> {
    const filter: Record<string, unknown> = {};
    if (query.competitionId) filter.competitionId = query.competitionId;
    if (query.seasonId) filter.seasonId = query.seasonId;
    if (query.state) filter['status.state'] = query.state;
    if (query.teamId) filter['competitors.teamId'] = query.teamId;
    if (query.from || query.to) {
      filter.kickoffAt = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      };
    }

    const andConditions: Record<string, unknown>[] = [];
    if (query.retainedOnly) {
      andConditions.push({
        $or: [
          { retentionExpiresAt: { $gt: new Date() } },
          { retentionExpiresAt: { $exists: false } },
          { retentionExpiresAt: null },
        ],
      });
    }

    const limit = Math.max(1, Math.min(query.limit ?? 100, 500));
    const sortDirection = query.sortOrder === 'ASC' ? 1 : -1;
    if (query.cursor) {
      const decoded = this.decodeCursor(query.cursor);
      if (!decoded) throw new Error('Invalid fixture cursor.');
      const comparison = sortDirection === 1 ? '$gt' : '$lt';
      andConditions.push({
        $or: [
          { kickoffAt: { [comparison]: decoded.kickoffAt } },
          { kickoffAt: decoded.kickoffAt, id: { [comparison]: decoded.id } },
        ],
      });
    }
    if (andConditions.length) filter.$and = andConditions;

    const rows = await this.fixtureModel.find(filter).sort({ kickoffAt: sortDirection, id: sortDirection })
      .limit(limit + 1).select('-_id').lean().exec();
    const hasMore = rows.length > limit;
    const page = (hasMore ? rows.slice(0, limit) : rows) as SportsFixtureRecord[];
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor: hasMore && last ? this.encodeCursor({ kickoffAt: new Date(last.kickoffAt).toISOString(), id: last.id }) : undefined,
    };
  }

  async getFixtureContexts(fixtureIds: string[]): Promise<SportsFixtureContextReadModel[]> {
    if (!fixtureIds.length) return [];
    const fixtures = await this.fixtureModel.find({ $or: [{ id: { $in: fixtureIds } }, { espnEventId: { $in: fixtureIds } }] })
      .select('-_id').lean().exec() as SportsFixtureRecord[];
    const competitionIds = [...new Set(fixtures.map((item) => item.competitionId))];
    const seasonIds = [...new Set(fixtures.map((item) => item.seasonId).filter((id): id is string => Boolean(id)))];
    const teamIds = [...new Set(fixtures.flatMap((item) => item.competitors.map((competitor) => competitor.teamId)))];

    const [competitions, seasons, teams] = await Promise.all([
      this.competitionModel.find({ id: { $in: competitionIds } }).select('-_id').lean().exec(),
      this.seasonModel.find({ id: { $in: seasonIds } }).select('-_id').lean().exec(),
      this.teamModel.find({ id: { $in: teamIds } }).select('-_id').lean().exec(),
    ]);
    const competitionMap = new Map<string, SportsCompetitionRecord>(competitions.map((item: any) => [String(item.id), item]));
    const seasonMap = new Map<string, SportsSeasonRecord>(seasons.map((item: any) => [String(item.id), item]));
    const teamMap = new Map<string, SportsTeamRecord>(teams.map((item: any) => [String(item.id), item]));

    return fixtures.map((fixture) => ({
      fixture,
      competition: competitionMap.get(fixture.competitionId) ?? null,
      season: fixture.seasonId ? seasonMap.get(fixture.seasonId) ?? null : null,
      homeTeam: teamMap.get(fixture.competitors.find((item) => item.homeAway === 'HOME')?.teamId ?? '') ?? null,
      awayTeam: teamMap.get(fixture.competitors.find((item) => item.homeAway === 'AWAY')?.teamId ?? '') ?? null,
    }));
  }

  async getMatch(fixtureId: string): Promise<SportsMatchReadModel | null> {
    const fixture = await this.getFixture(fixtureId);
    if (!fixture) return null;
    const [context] = await this.getFixtureContexts([fixture.id]);
    if (!context) return null;
    const [timeline, latestOdds, matchFacts, matchSummary] = await Promise.all([
      this.getMatchTimeline(fixture.id),
      this.getMatchOdds(fixture.id),
      this.matchFactsModel
        .findOne({ fixtureId: fixture.id })
        .select('-_id -__v')
        .lean()
        .exec(),
      this.matchSummaryModel
        .findOne({ fixtureId: fixture.id })
        .select({ _id: 0, __v: 0, rawPayload: 0 })
        .lean()
        .exec(),
    ]);
    return {
      ...context,
      timeline,
      latestOdds,
      matchFacts: (matchFacts as SportsMatchReadModel['matchFacts']) ?? null,
      matchSummary: (matchSummary as SportsMatchReadModel['matchSummary']) ?? null,
    };
  }

  /** Read the completed match history and team identity from normalized Sports facts. */
  async getTeamData(
    teamId: string,
    limit = 40,
    competitionId?: string,
    seasonId?: string,
  ): Promise<SportsTeamReadModel | null> {
    const team = await this.getTeam(teamId);
    if (!team) return null;

    const fixturesPage = await this.getFixtures({
      teamId: team.id,
      state: 'COMPLETED',
      retainedOnly: true,
      limit: Math.max(5, Math.min(100, Math.floor(limit) || 40)),
    });
    const recentFixtures = fixturesPage.items
      .filter((fixture) => fixture.status?.state === 'COMPLETED' || fixture.status?.isFinal === true)
      .sort((left, right) => new Date(right.kickoffAt).getTime() - new Date(left.kickoffAt).getTime());

    // Read all retained season projections once. A requested current season may
    // not have a completed fixture yet, so the latest prior-season rolling form
    // is a valid fallback until the current season projection is recalculated.
    const projectionRows = (await this.derived.getTeamFormsForTeam(team.id, competitionId))
      .map((value) => this.asRecord(value))
      .filter((record): record is Record<string, any> => Boolean(record));
    const targetScopes = new Map<string, { competitionId: string; seasonId?: string }>();
    if (competitionId) {
      targetScopes.set(competitionId, { competitionId, seasonId });
    } else {
      // recentFixtures is newest-first; the first fixture for each competition
      // identifies the season whose rolling snapshot should be returned.
      for (const fixture of recentFixtures) {
        if (!fixture.competitionId || targetScopes.has(fixture.competitionId)) continue;
        targetScopes.set(fixture.competitionId, {
          competitionId: fixture.competitionId,
          seasonId: fixture.seasonId,
        });
      }
    }

    const form: SportsTeamFormRecord[] = [];
    for (const scope of targetScopes.values()) {
      const candidates = projectionRows.filter((record) =>
        String(record.competitionId ?? '') === scope.competitionId,
      );
      const exact = scope.seasonId
        ? candidates.find((record) => String(record.seasonId ?? '') === scope.seasonId)
        : undefined;
      const historySeasonIds = [...new Set(
        recentFixtures
          .filter((fixture) => fixture.competitionId === scope.competitionId)
          .map((fixture) => fixture.seasonId)
          .filter((value): value is string => Boolean(value)),
      )];
      const latestHistoryProjection = historySeasonIds
        .map((historySeasonId) => candidates.find(
          (record) => String(record.seasonId ?? '') === historySeasonId,
        ))
        .find((record) => Boolean(record));
      const source = exact
        ?? latestHistoryProjection
        ?? [...candidates].sort((a, b) =>
          (this.date(b.calculatedAt)?.getTime() ?? 0) - (this.date(a.calculatedAt)?.getTime() ?? 0),
        )[0];
      if (!source) continue;

      const metrics = this.asRecord(source.metrics) ?? {};
      const rows = Array.isArray(metrics.recentMatchFacts) ? metrics.recentMatchFacts : [];
      const results = rows.flatMap((candidate) => {
        const row = this.asRecord(candidate);
        if (!row) return [];
        const fixtureId = String(row.fixtureId ?? '').trim();
        const kickoffAt = this.date(row.kickoffAt);
        const goalsFor = this.number(row.goalsFor);
        const goalsAgainst = this.number(row.goalsAgainst);
        const homeAway = row.homeAway === 'HOME' || row.homeAway === 'AWAY' ? row.homeAway : null;
        if (!fixtureId || !kickoffAt || goalsFor === null || goalsAgainst === null || !homeAway) return [];
        const result = row.result === 'W' || row.result === 'D' || row.result === 'L'
          ? row.result
          : goalsFor > goalsAgainst ? 'W' as const : goalsFor < goalsAgainst ? 'L' as const : 'D' as const;
        return [{ fixtureId, kickoffAt, result, goalsFor, goalsAgainst, homeAway }];
      }).sort((a, b) => b.kickoffAt.getTime() - a.kickoffAt.getTime()).slice(0, 40);
      if (!results.length) continue;

      form.push({
        teamId: team.id,
        competitionId: scope.competitionId,
        // Preserve the requested season key so prediction consumers can select
        // the correct season snapshot even when the previous season is fallback.
        seasonId: scope.seasonId ?? String(source.seasonId ?? ''),
        lastN: results.length,
        results,
        computedAt: this.date(source.calculatedAt) ?? new Date(0),
        sourceRevision: this.number(source.sourceRevision) ?? 0,
      });
    }

    return { team, form, recentFixtures };
  }

  /**
   * Compatibility read contract for consumers that need one explicit scoring
   * window. The source of truth remains the Sports derived projection document.
   */
  async getTeamScoringRecord(
    teamId: string,
    competitionId: string,
    seasonId: string,
    scope: 'SEASON' | 'HOME' | 'AWAY' | 'LAST5' | 'LAST10' = 'SEASON',
  ): Promise<SportsTeamScoringRecord | null> {
    const source = this.asRecord(await this.derived.getTeamScoring(teamId, competitionId, seasonId));
    if (!source) return null;
    const metrics = this.asRecord(source.metrics) ?? {};
    const window = this.asRecord(metrics[scope.toLowerCase()]);
    if (!window) return null;
    const played = this.number(window.played) ?? 0;
    const averageGoalsFor = this.number(window.averageGoalsScored);
    const averageGoalsAgainst = this.number(window.averageGoalsConceded);
    // An empty or malformed scoring window is unavailable data, not a 0-goal
    // scoring rate. Keep the existing consumer contract non-null by returning
    // null for the whole window when no valid denominator/rates exist.
    if (played < 1 || averageGoalsFor === null || averageGoalsAgainst === null) return null;
    return {
      id: String(source.id ?? `scoring:${competitionId}:${seasonId}:${teamId}:${scope}`),
      teamId,
      competitionId,
      seasonId,
      fixturesPlayed: played,
      goalsFor: this.number(window.goalsScored) ?? 0,
      goalsAgainst: this.number(window.goalsConceded) ?? 0,
      averageGoalsFor,
      averageGoalsAgainst,
      cleanSheets: this.number(window.cleanSheets) ?? 0,
      failedToScore: this.number(window.failedToScore) ?? 0,
      computedAt: this.date(source.calculatedAt) ?? new Date(0),
      sourceRevision: this.number(source.sourceRevision) ?? 0,
      metrics,
    } as SportsTeamScoringRecord;
  }

  /** Read the canonical season/home/away record and all retained recent venue windows. */
  async getTeamHomeAwayRecord(
    teamId: string,
    competitionId: string,
    seasonId: string,
  ): Promise<SportsTeamHomeAwayRecord | null> {
    const source = this.asRecord(await this.derived.getTeamHomeAway(teamId, competitionId, seasonId));
    if (!source) return null;
    const metrics = this.asRecord(source.metrics) ?? {};
    const season = this.asRecord(metrics.season);
    if (!season) return null;
    const home = this.recordWindow(this.asRecord(season.home));
    const away = this.recordWindow(this.asRecord(season.away));
    if (!home || !away) return null;
    return {
      teamId,
      competitionId,
      seasonId,
      home,
      away,
      computedAt: this.date(source.calculatedAt) ?? new Date(0),
      sourceRevision: this.number(source.sourceRevision) ?? 0,
      last5Home: this.recordWindow(this.asRecord(metrics.last5Home)),
      last10Home: this.recordWindow(this.asRecord(metrics.last10Home)),
      last5Away: this.recordWindow(this.asRecord(metrics.last5Away)),
      last10Away: this.recordWindow(this.asRecord(metrics.last10Away)),
      metrics,
    } as SportsTeamHomeAwayRecord;
  }

  async getCompetitionScoringTotals(
    competitionId: string,
    seasonId: string,
  ): Promise<SportsCompetitionScoringTotalsRecord | null> {
    const source = this.asRecord(await this.derived.getCompetitionScoring(competitionId, seasonId));
    if (!source) return null;
    const metrics = this.asRecord(source.metrics) ?? {};
    const totalGoals = this.number(metrics.totalGoals) ?? 0;
    return {
      id: String(source.id ?? `competition-scoring:${competitionId}:${seasonId}`),
      competitionId,
      seasonId,
      fixturesPlayed: this.number(metrics.matches) ?? this.number(source.sourceFixtureCount) ?? 0,
      totalGoals,
      homeGoals: this.number(metrics.homeGoals) ?? 0,
      awayGoals: this.number(metrics.awayGoals) ?? 0,
      averageGoalsPerFixture: this.number(metrics.averageGoalsPerMatch) ?? 0,
      computedAt: this.date(source.calculatedAt) ?? new Date(0),
      sourceRevision: this.number(source.sourceRevision) ?? 0,
      bttsRate: this.number(metrics.bttsRate),
      over15Rate: this.number(metrics.over15Rate),
      over25Rate: this.number(metrics.over25Rate),
      over35Rate: this.number(metrics.over35Rate),
      under25Rate: this.number(metrics.under25Rate),
      cleanSheetRate: this.number(metrics.cleanSheetRate),
      eventMetrics: this.asRecord(metrics.eventMetrics) ?? {},
      metrics,
    } as SportsCompetitionScoringTotalsRecord;
  }

  async getTeamStatisticsAggregate(
    teamId: string,
    competitionId: string,
    seasonId: string,
    scope: 'SEASON' | 'HOME' | 'AWAY' | 'LAST5' | 'LAST10' = 'SEASON',
  ): Promise<SportsTeamStatisticsAggregateRecord | null> {
    const source = this.asRecord(await this.derived.getTeamStatistics(teamId, competitionId, seasonId));
    if (!source) return null;
    const metrics = this.asRecord(source.metrics) ?? {};
    const window = this.asRecord(metrics[scope.toLowerCase()]);
    if (!window) return null;
    const rawStats = this.asRecord(window.statistics) ?? {};
    const statistics = new Map<string, any>();

    for (const [key, value] of Object.entries(rawStats)) {
      const row = this.asRecord(value);
      if (!row) continue;
      const average = this.number(row.average);
      const sampleSize = this.number(row.samples) ?? 0;
      const total = this.number(row.total) ?? (average !== null ? average * sampleSize : 0);
      const varianceValue = this.number(row.variance);
      const minimumValue = this.number(row.minimum);
      const maximumValue = this.number(row.maximum);
      if (average === null || sampleSize < 1) continue;
      statistics.set(this.normalizeStatisticKey(key), {
        key,
        name: key,
        label: typeof row.label === 'string' ? row.label : key,
        sampleSize,
        total,
        average,
        ...(varianceValue !== null && varianceValue >= 0 ? { variance: varianceValue } : {}),
        ...(minimumValue !== null ? { minimum: minimumValue } : {}),
        ...(maximumValue !== null ? { maximum: maximumValue } : {}),
      });
    }

    const canonical = this.asRecord(window.canonicalAverages) ?? {};
    for (const [key, value] of Object.entries(canonical)) {
      const average = this.number(value);
      if (average === null) continue;
      const normalized = this.normalizeStatisticKey(key);
      if (statistics.has(normalized)) continue;
      const related = [...statistics.values()].filter((item) => this.statisticAliases(key).includes(this.normalizeStatisticKey(item.key)));
      const sampleSize = related.length ? Math.min(...related.map((item) => item.sampleSize)) : 0;
      if (sampleSize < 1) continue;
      statistics.set(normalized, { key, name: key, label: key, sampleSize, total: average * sampleSize, average });
    }

    const rows = [...statistics.values()];
    return {
      id: String(source.id ?? `team-statistics:${competitionId}:${seasonId}:${teamId}`),
      teamId,
      competitionId,
      seasonId,
      fixturesWithStatistics: rows.reduce((maximum, row) => Math.max(maximum, row.sampleSize), 0),
      statistics: rows,
      computedAt: this.date(source.calculatedAt) ?? new Date(0),
      sourceRevision: this.number(source.sourceRevision) ?? 0,
      scope,
      scopeMetrics: window,
      metrics,
    } as SportsTeamStatisticsAggregateRecord;
  }

  async getHeadToHead(teamAId: string, teamBId: string, competitionId: string): Promise<SportsHeadToHeadRecord | null> {
    const source = this.asRecord(await this.derived.getHeadToHead(teamAId, teamBId, competitionId));
    if (!source) return null;
    const storedTeamA = String(source.teamAId ?? teamAId);
    const storedTeamB = String(source.teamBId ?? teamBId);
    const metrics = this.asRecord(source.metrics) ?? {};
    const recent = Array.isArray(metrics.last10) ? metrics.last10 : [];
    const matches = recent.flatMap((candidate) => {
      const row = this.asRecord(candidate);
      if (!row) return [];
      const homeTeamId = String(row.homeTeamId ?? '');
      const fixtureId = String(row.fixtureId ?? '');
      const kickoffAt = this.date(row.kickoffAt);
      const scoreA = this.number(row.teamAScore);
      const scoreB = this.number(row.teamBScore);
      if (!fixtureId || !kickoffAt || !homeTeamId || scoreA === null || scoreB === null) return [];
      const aIsHome = homeTeamId === storedTeamA;
      return [{
        fixtureId,
        kickoffAt,
        homeTeamId,
        awayTeamId: aIsHome ? storedTeamB : storedTeamA,
        homeScore: aIsHome ? scoreA : scoreB,
        awayScore: aIsHome ? scoreB : scoreA,
        recencyRank: this.number(row.recencyRank) ?? 0,
        recencyWeight: this.number(row.recencyWeight) ?? 1,
      }];
    });
    return {
      teamAId: storedTeamA,
      teamBId: storedTeamB,
      competitionId,
      matches,
      computedAt: this.date(source.calculatedAt) ?? new Date(0),
      sourceRevision: this.number(source.sourceRevision) ?? 0,
      metrics,
    } as SportsHeadToHeadRecord;
  }

  async getPlayerEventTotals(
    playerId: string,
    competitionId: string,
    seasonId: string,
  ): Promise<SportsPlayerEventTotalsRecord | null> {
    return this.derived.getPlayerEventTotals(playerId, competitionId, seasonId) as Promise<SportsPlayerEventTotalsRecord | null>;
  }

  async getStandings(competitionId: string, seasonId: string): Promise<unknown[]> {
    return this.derived.getStandings(competitionId, seasonId);
  }

  private recordWindow(value: Record<string, unknown> | null): SportsTeamHomeAwayRecord['home'] | null {
    if (!value) return null;
    return {
      played: this.number(value.played) ?? 0,
      won: this.number(value.won) ?? 0,
      drawn: this.number(value.drawn) ?? 0,
      lost: this.number(value.lost) ?? 0,
      goalsFor: this.number(value.goalsScored) ?? 0,
      goalsAgainst: this.number(value.goalsConceded) ?? 0,
    };
  }

  private asRecord(value: unknown): Record<string, any> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, any>
      : null;
  }

  private number(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private date(value: unknown): Date | null {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    if (typeof value === 'string' || typeof value === 'number') {
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed : null;
    }
    return null;
  }

  private normalizeStatisticKey(value: unknown): string {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private statisticAliases(value: string): string[] {
    const key = this.normalizeStatisticKey(value);
    const aliases: Record<string, string[]> = {
      corners: ['corners', 'woncorners', 'cornerkicks', 'cornerkickswon', 'totalcorners'],
      shots: ['shots', 'totalshots', 'shotsattempted'],
      shotsontarget: ['shotsontarget', 'shotsongoal', 'ontargetattempts'],
      possession: ['possession', 'possessionpct'],
      fouls: ['fouls', 'foulscommitted', 'totalfouls'],
      yellowcards: ['yellowcards', 'yellowcard'],
      redcards: ['redcards', 'redcard'],
      offsides: ['offsides', 'offside'],
      saves: ['saves', 'savesmade'],
      cards: ['cards', 'totalcards'],
    };
    return aliases[key] ?? [key];
  }

  async getMatchTimeline(fixtureId: string): Promise<SportsMatchTimelineEventRecord[]> {
    const rows = await this.timelineModel.find({ fixtureId }).sort({ sequence: 1, id: 1 }).select('-_id').lean().exec();
    return rows as SportsMatchTimelineEventRecord[];
  }

  async getMatchOdds(fixtureId: string): Promise<SportsMatchOddsSnapshotRecord | null> {
    const row = await this.oddsModel.findOne({ fixtureId }).sort({ collectedAt: -1 }).select('-_id').lean().exec();
    return (row as SportsMatchOddsSnapshotRecord | null) ?? null;
  }

  async getMatchOddsHistory(fixtureId: string, requestedLimit = 20): Promise<SportsMatchOddsSnapshotRecord[]> {
    const rows = await this.oddsModel.find({ fixtureId }).sort({ collectedAt: -1 })
      .limit(Math.max(1, Math.min(requestedLimit, 100))).select('-_id').lean().exec();
    return rows as SportsMatchOddsSnapshotRecord[];
  }

  private competitionFilter(query: SportsCompetitionListQuery): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (query.activeOnly !== false) filter.isActive = true;
    if (query.region) filter.region = query.region;
    if (query.type) filter.type = query.type;
    if (query.search?.trim()) {
      const expression = new RegExp(this.escapeRegex(query.search.trim()), 'i');
      filter.$or = [{ name: expression }, { displayName: expression }, { slug: expression }];
    }
    return filter;
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private encodeCursor(value: { kickoffAt: string; id: string }): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  private decodeCursor(value: string): { kickoffAt: Date; id: string } | null {
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { kickoffAt?: string; id?: string };
      const kickoffAt = new Date(String(parsed.kickoffAt ?? ''));
      if (Number.isNaN(kickoffAt.getTime()) || !parsed.id) return null;
      return { kickoffAt, id: String(parsed.id) };
    } catch {
      return null;
    }
  }
}

