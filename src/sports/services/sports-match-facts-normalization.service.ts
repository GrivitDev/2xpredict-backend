import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';

import type { SportsFixtureRecord } from '../interfaces/sports-domain.interface';
import type {
  SportsMatchFactLeader,
  SportsMatchFactSectionStatus,
  SportsMatchFactsNormalizationInput,
  SportsMatchFactsWrite,
  SportsMatchResultFacts,
  SportsMatchSummaryEvent,
  SportsNormalizedPeriodScore,
  SportsNormalizedPlayerAppearance,
  SportsNormalizedStatistic,
  SportsNormalizedTeamStatistics,
} from '../interfaces/sports-match-facts.interface';
import { SportsPersistenceService } from './sports-persistence.service';

type UnknownRecord = Record<string, unknown>;

const NORMALIZATION_VERSION = '1.1.0';

const STATISTIC_ALIASES: Record<string, string> = {
  totalshots: 'shots',
  shots: 'shots',
  shotsattempted: 'shots',
  totalshotattempts: 'shots',
  shotsongoal: 'shotsOnTarget',
  shotsontarget: 'shotsOnTarget',
  ongoal: 'shotsOnTarget',
  ontargetattempts: 'shotsOnTarget',
  shotsofftarget: 'shotsOffTarget',
  offgoal: 'shotsOffTarget',
  offtargetattempts: 'shotsOffTarget',
  woncorners: 'corners',
  cornerkick: 'corners',
  corners: 'corners',
  cornerkicks: 'corners',
  cornerkickswon: 'corners',
  foulscommitted: 'fouls',
  fouls: 'fouls',
  yellowcards: 'yellowCards',
  yellowcard: 'yellowCards',
  redcards: 'redCards',
  redcard: 'redCards',
  offsides: 'offsides',
  offside: 'offsides',
  saves: 'saves',
  goalkeepersaves: 'saves',
  possessionpct: 'possession',
  possession: 'possession',
  totalpasses: 'passes',
  passes: 'passes',
  accuratepasses: 'accuratePasses',
  passescompleted: 'accuratePasses',
  passpct: 'passAccuracy',
  passcompletionpct: 'passAccuracy',
  passaccuracy: 'passAccuracy',
  totalcrosses: 'crosses',
  crosses: 'crosses',
  accuratecrosses: 'accurateCrosses',
  crosspct: 'crossAccuracy',
  crossaccuracy: 'crossAccuracy',
  tackles: 'tackles',
  totaltackles: 'tackles',
  interceptions: 'interceptions',
  blocks: 'blocks',
  shotsblocked: 'shotsBlocked',
  clearances: 'clearances',
  effectiveclearances: 'clearances',
  effectiveinterceptions: 'interceptions',
  defensiveinterventions: 'defensiveInterventions',
  ballrecoveries: 'ballRecoveries',
  effectivetackles: 'tacklesWon',
  tackleswon: 'tacklesWon',
  duelswon: 'duelsWon',
  aerialduelswon: 'aerialDuelsWon',
  bigchancecreated: 'bigChancesCreated',
  bigchancescreated: 'bigChancesCreated',
  bigchancesmissed: 'bigChancesMissed',
  expectedgoals: 'expectedGoals',
  expectedgoalsconceded: 'expectedGoalsConceded',
  shotpct: 'shotAccuracy',
  shotsongoalagainst: 'shotsOnTargetAgainst',
  penaltykickgoals: 'penaltiesScored',
  penaltiesscored: 'penaltiesScored',
  penaltykickshots: 'penaltiesTaken',
  appearances: 'appearances',
  appearance: 'appearances',
  app: 'appearances',
  minutes: 'minutesPlayed',
  minutesplayed: 'minutesPlayed',
  totalgoals: 'goals',
  goals: 'goals',
  goal: 'goals',
  goalassists: 'assists',
  assists: 'assists',
  assist: 'assists',
  owngoals: 'ownGoals',
  owngoal: 'ownGoals',
  penaltiesmissed: 'penaltiesMissed',
  penaltymissed: 'penaltiesMissed',
  penaltymisses: 'penaltiesMissed',
};

const COUNT_STATISTICS = new Set([
  'shots', 'shotsOnTarget', 'shotsOffTarget', 'corners', 'fouls',
  'yellowCards', 'redCards', 'offsides', 'saves', 'passes',
  'accuratePasses', 'crosses', 'accurateCrosses', 'tackles',
  'interceptions', 'blocks', 'shotsBlocked', 'clearances',
  'penaltiesScored', 'penaltiesTaken', 'appearances', 'goals',
  'assists', 'ownGoals', 'penaltiesMissed', 'defensiveInterventions',
  'ballRecoveries', 'tacklesWon', 'duelsWon', 'aerialDuelsWon',
  'bigChancesCreated', 'bigChancesMissed', 'shotsOnTargetAgainst',
]);

@Injectable()
export class SportsMatchFactsNormalizationService {
  constructor(private readonly persistence: SportsPersistenceService) {}

  async normalizeAndPersist(
    input: SportsMatchFactsNormalizationInput,
  ): Promise<{ revision: number; changed: boolean; sectionStatus: SportsMatchFactsWrite['sectionStatus'] }> {
    const normalized = this.normalize(input);
    const saved = await this.persistence.saveMatchFacts(normalized);
    return {
      revision: saved.revision,
      changed: saved.changed,
      sectionStatus: normalized.sectionStatus,
    };
  }

  normalize(input: SportsMatchFactsNormalizationInput): SportsMatchFactsWrite {
    const summary = this.asRecord(input.rawPayload);
    const fixture = input.fixture ?? null;
    const diagnostics: string[] = [];
    const participants = this.resolveParticipants(summary, fixture);

    const matchResult = this.normalizeMatchResult(summary, fixture, participants);
    const periodScores = this.normalizePeriodScores(summary, fixture, participants);
    const teamStatistics = this.normalizeTeamStatistics(summary, participants, diagnostics);
    const playerAppearances = this.normalizePlayerAppearances(summary, participants, diagnostics);
    const leaders = this.normalizeLeaders(summary, participants);
    const summaryEvents = this.normalizeSummaryEvents(summary, participants);

    const teamStatsWithValues = teamStatistics.filter((team) => team.statistics.length > 0);
    const teamsWithRoster = new Set(playerAppearances.map((player) => player.teamId).filter((teamId): teamId is string => Boolean(teamId)));
    const playersWithStats = playerAppearances.filter((player) => player.statistics.length > 0);
    const playerStatsTeams = new Set(playersWithStats.map((player) => player.teamId).filter((teamId): teamId is string => Boolean(teamId)));

    const sectionStatus = {
      matchResult: matchResult.available
        ? (matchResult.isFinal ? 'COMPLETE' : 'AVAILABLE')
        : 'NOT_PROVIDED',
      periodScores: this.periodScoreStatus(periodScores, participants),
      teamStatistics: this.teamSectionStatus(teamStatsWithValues, participants),
      playerAppearances: this.teamCoverageStatus(teamsWithRoster, participants),
      playerStatistics: this.teamCoverageStatus(playerStatsTeams, participants),
      leaders: leaders.length ? 'AVAILABLE' : 'NOT_PROVIDED',
      // Summary keyEvents are useful supplemental facts, never complete Plays coverage.
      summaryEvents: summaryEvents.length ? 'PARTIAL' : 'NOT_PROVIDED',
    } satisfies SportsMatchFactsWrite['sectionStatus'];

    if (!fixture) diagnostics.push('FIXTURE_CONTEXT_UNAVAILABLE');
    if (teamStatistics.length === 0) diagnostics.push('SUMMARY_TEAM_STATISTICS_NOT_FOUND');
    if (playerAppearances.length === 0) diagnostics.push('SUMMARY_ROSTERS_NOT_FOUND');
    if (leaders.length === 0) diagnostics.push('SUMMARY_LEADERS_NOT_FOUND');
    if (summaryEvents.length === 0) diagnostics.push('SUMMARY_KEY_EVENTS_NOT_FOUND');

    const base = {
      fixtureId: input.fixtureId,
      espnEventId: input.espnEventId,
      competitionId: input.competitionId,
      seasonId: input.seasonId,
      seasonYear: input.seasonYear,
      provider: 'ESPN' as const,
      endpoint: input.endpoint,
      sourcePayloadHash: input.sourcePayloadHash,
      sourceRevision: Math.max(1, Math.floor(input.sourceRevision || 1)),
      sourceCollectedAt: input.sourceCollectedAt,
      normalizationVersion: NORMALIZATION_VERSION,
      normalizedAt: new Date(),
      matchResult,
      periodScores,
      teamStatistics,
      playerAppearances,
      leaders,
      summaryEvents,
      sectionStatus,
      diagnostics,
    };

    const normalizationHash = createHash('sha256')
      .update(JSON.stringify({
        matchResult,
        periodScores,
        teamStatistics,
        playerAppearances,
        leaders,
        summaryEvents,
        sectionStatus,
        normalizationVersion: NORMALIZATION_VERSION,
      }))
      .digest('hex');

    return { ...base, normalizationHash };
  }

  private resolveParticipants(
    summary: UnknownRecord,
    fixture: SportsFixtureRecord | null,
  ): Map<string, { teamId: string; side: 'HOME' | 'AWAY' | 'UNKNOWN' }> {
    const output = new Map<string, { teamId: string; side: 'HOME' | 'AWAY' | 'UNKNOWN' }>();
    for (const competitor of fixture?.competitors ?? []) {
      const espnId = String(
        competitor.espnCompetitorId ?? competitor.teamId.replace(/^team:/, ''),
      ).trim();
      if (espnId) output.set(espnId, { teamId: competitor.teamId, side: competitor.homeAway });
    }

    for (const competitor of this.summaryCompetitors(summary)) {
      const team = this.asRecord(competitor.team);
      const espnId = this.text(team.id ?? competitor.teamId ?? competitor.id);
      if (!espnId || output.has(espnId)) continue;
      const sideText = (this.text(competitor.homeAway) ?? '').toUpperCase();
      const side = sideText === 'HOME' ? 'HOME' : sideText === 'AWAY' ? 'AWAY' : 'UNKNOWN';
      output.set(espnId, { teamId: `team:${espnId}`, side });
    }
    return output;
  }

  private normalizeMatchResult(
    summary: UnknownRecord,
    fixture: SportsFixtureRecord | null,
    participants: Map<string, { teamId: string; side: 'HOME' | 'AWAY' | 'UNKNOWN' }>,
  ): SportsMatchResultFacts {
    const fixtureHome = fixture?.competitors.find((item) => item.homeAway === 'HOME');
    const fixtureAway = fixture?.competitors.find((item) => item.homeAway === 'AWAY');
    let homeScore: number | null = null;
    let awayScore: number | null = null;
    let summaryHomeScoreAvailable = false;
    let summaryAwayScoreAvailable = false;
    let homeTeamId = fixtureHome?.teamId;
    let awayTeamId = fixtureAway?.teamId;

    // Summary data is the match-detail source. Use the fixture only as a fallback
    // so a stale scoreboard value cannot overwrite a newer final Summary score.
    for (const competitor of this.summaryCompetitors(summary)) {
      const team = this.asRecord(competitor.team);
      const espnId = this.text(team.id ?? competitor.teamId ?? competitor.id);
      const mapped = espnId ? participants.get(espnId) : undefined;
      const sideText = (this.text(competitor.homeAway) ?? '').toUpperCase();
      const side = mapped?.side ?? (sideText === 'HOME' ? 'HOME' : sideText === 'AWAY' ? 'AWAY' : 'UNKNOWN');
      const score = this.number(competitor.score ?? competitor.displayValue);
      if (score === null) continue;
      if (side === 'HOME') {
        homeScore = score;
        summaryHomeScoreAvailable = true;
        homeTeamId = mapped?.teamId ?? homeTeamId ?? (espnId ? `team:${espnId}` : undefined);
      } else if (side === 'AWAY') {
        awayScore = score;
        summaryAwayScoreAvailable = true;
        awayTeamId = mapped?.teamId ?? awayTeamId ?? (espnId ? `team:${espnId}` : undefined);
      }
    }

    const fixtureHomeScoreAvailable = this.number(fixtureHome?.score) !== null;
    const fixtureAwayScoreAvailable = this.number(fixtureAway?.score) !== null;
    homeScore ??= this.number(fixtureHome?.score);
    awayScore ??= this.number(fixtureAway?.score);

    const available = homeScore !== null && awayScore !== null;
    const scoreSource = summaryHomeScoreAvailable && summaryAwayScoreAvailable
      ? 'ESPN_SUMMARY' as const
      : summaryHomeScoreAvailable || summaryAwayScoreAvailable
        ? 'MIXED' as const
        : fixtureHomeScoreAvailable && fixtureAwayScoreAvailable
          ? 'FIXTURE_FALLBACK' as const
          : available
            ? 'MIXED' as const
            : 'UNAVAILABLE' as const;
    const isFinal =
      fixture?.status?.isFinal === true ||
      fixture?.status?.state === 'COMPLETED' ||
      this.summaryIndicatesFinal(summary);

    return { homeTeamId, awayTeamId, homeScore, awayScore, isFinal, available, scoreSource };
  }

  private normalizePeriodScores(
    summary: UnknownRecord,
    fixture: SportsFixtureRecord | null,
    participants: Map<string, { teamId: string; side: 'HOME' | 'AWAY' | 'UNKNOWN' }>,
  ): SportsNormalizedPeriodScore[] {
    const output: SportsNormalizedPeriodScore[] = [];
    for (const competitor of this.summaryCompetitors(summary)) {
      const team = this.asRecord(competitor.team);
      const espnId = this.text(team.id ?? competitor.teamId ?? competitor.id);
      const mapped = espnId ? participants.get(espnId) : undefined;
      const sideText = (this.text(competitor.homeAway) ?? '').toUpperCase();
      const side = mapped?.side ?? (sideText === 'HOME' ? 'HOME' : sideText === 'AWAY' ? 'AWAY' : 'UNKNOWN');
      const teamId = mapped?.teamId ?? (espnId ? `team:${espnId}` : undefined);
      if (!teamId || side === 'UNKNOWN') continue;
      const linescores = this.asArray(competitor.linescores ?? competitor.lineScores);
      linescores.forEach((lineValue, index) => {
        const line = this.asRecord(lineValue);
        const score = this.number(line.value ?? line.score ?? line.displayValue);
        if (score === null) return;
        const period = this.number(line.period ?? line.periodNumber) ?? index + 1;
        if (!Number.isInteger(period) || period < 1) return;
        output.push({ teamId, period, score });
      });
    }
    if (output.length) return output;

    return (fixture?.periodScores ?? [])
      .filter((item) => Number.isInteger(item.period) && item.period > 0 && Number.isFinite(item.score))
      .map((item) => ({ teamId: item.teamId, period: item.period, score: item.score }));
  }

  private summaryIndicatesFinal(summary: UnknownRecord): boolean {
    const header = this.asRecord(summary.header);
    const event = this.asRecord(summary.event ?? header.event);
    const competition = this.asRecord(
      this.asArray(header.competitions)[0] ??
      this.asArray(event.competitions)[0] ??
      summary.competition,
    );
    const status = this.asRecord(competition.status ?? event.status ?? header.status);
    const type = this.asRecord(status.type);
    if (type.completed === true || status.completed === true) return true;

    const state = (this.text(type.state ?? type.name ?? status.state ?? status.description ?? status.detail) ?? '').toLowerCase();
    return /post|final|complete|full time|match finished/.test(state);
  }

  private normalizeTeamStatistics(
    summary: UnknownRecord,
    participants: Map<string, { teamId: string; side: 'HOME' | 'AWAY' | 'UNKNOWN' }>,
    diagnostics: string[],
  ): SportsNormalizedTeamStatistics[] {
    const boxscore = this.asRecord(summary.boxscore);
    const teams = this.asArray(boxscore.teams);
    const output: SportsNormalizedTeamStatistics[] = [];
    const seen = new Set<string>();

    for (const value of teams) {
      const row = this.asRecord(value);
      const team = this.asRecord(row.team ?? value);
      const espnTeamId = this.text(team.id ?? row.teamId);
      if (!espnTeamId) {
        diagnostics.push('SUMMARY_TEAM_STATISTICS_ROW_WITHOUT_TEAM_ID');
        continue;
      }
      const mapped = participants.get(espnTeamId);
      if (participants.size && !mapped) continue;
      const teamId = mapped?.teamId ?? `team:${espnTeamId}`;
      const statistics = this.asArray(row.statistics).map((stat) => this.normalizeStatistic(stat));
      const key = `${teamId}:${mapped?.side ?? 'UNKNOWN'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        teamId,
        espnTeamId,
        side: mapped?.side ?? 'UNKNOWN',
        statistics,
      });
    }
    return output;
  }

  private normalizePlayerAppearances(
    summary: UnknownRecord,
    participants: Map<string, { teamId: string; side: 'HOME' | 'AWAY' | 'UNKNOWN' }>,
    diagnostics: string[],
  ): SportsNormalizedPlayerAppearance[] {
    const rosterSections = this.asArray(summary.rosters).length
      ? this.asArray(summary.rosters)
      : this.asArray(this.asRecord(summary.boxscore).rosters);
    if (!rosterSections.length) return [];

    const output: SportsNormalizedPlayerAppearance[] = [];
    const seen = new Set<string>();
    for (const sectionValue of rosterSections) {
      const section = this.asRecord(sectionValue);
      const team = this.asRecord(section.team);
      const espnTeamId = this.text(team.id ?? section.teamId);
      const sideText = (this.text(section.homeAway) ?? '').toUpperCase();
      const mapped = espnTeamId ? participants.get(espnTeamId) : undefined;
      const inferredSide = mapped?.side ?? (sideText === 'HOME' ? 'HOME' : sideText === 'AWAY' ? 'AWAY' : 'UNKNOWN');
      const teamId = mapped?.teamId ?? (espnTeamId ? `team:${espnTeamId}` : undefined);
      if (participants.size && espnTeamId && !mapped) continue;

      const roster = this.asArray(section.roster ?? section.players);
      for (const rowValue of roster) {
        const row = this.asRecord(rowValue);
        const athlete = this.asRecord(row.athlete ?? row.player);
        const espnPlayerId = this.text(athlete.id ?? row.athleteId ?? row.playerId);
        if (!espnPlayerId) {
          diagnostics.push('SUMMARY_ROSTER_PLAYER_WITHOUT_ATHLETE_ID');
          continue;
        }
        const playerId = `athlete:${espnPlayerId}`;
        const dedupeKey = `${playerId}:${teamId ?? ''}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const statistics = this.asArray(row.stats ?? row.statistics).map((stat) => this.normalizeStatistic(stat));
        const appearanceStat = statistics.find((stat) => stat.canonicalKey === 'appearances' && stat.value !== null);
        const starter = this.boolean(row.starter);
        const subbedIn = this.boolean(row.subbedIn ?? row.subbed_in);
        const subbedOut = this.boolean(row.subbedOut ?? row.subbed_out);
        const active = this.boolean(row.active);
        const appearances = appearanceStat?.value ?? (starter === true || subbedIn === true ? 1 : null);
        const appearanceBasis = appearanceStat
          ? 'PROVIDER_STATISTIC'
          : appearances !== null
            ? 'LINEUP_PARTICIPATION'
            : 'UNKNOWN';
        const position = this.asRecord(row.position);

        output.push({
          playerId,
          espnPlayerId,
          teamId,
          name: this.text(athlete.displayName ?? athlete.fullName),
          shortName: this.text(athlete.shortName),
          jersey: this.text(row.jersey ?? athlete.jersey),
          position: this.text(position.displayName ?? position.name),
          positionId: this.text(position.id ?? position.abbreviation),
          starter,
          subbedIn,
          subbedOut,
          active,
          appearances,
          appearanceBasis,
          statistics,
        });
      }

      if (!teamId && roster.length) diagnostics.push(`SUMMARY_ROSTER_SECTION_WITHOUT_TEAM_ID:${inferredSide}`);
    }
    return output;
  }

  private normalizeLeaders(
    summary: UnknownRecord,
    participants: Map<string, { teamId: string; side: 'HOME' | 'AWAY' | 'UNKNOWN' }>,
  ): SportsMatchFactLeader[] {
    const raw = summary.leaders;
    const output: SportsMatchFactLeader[] = [];

    const resolveTeamId = (value: UnknownRecord, fallback?: string): string | undefined => {
      const rawTeamId = this.text(this.asRecord(value.team).id ?? value.teamId);
      return rawTeamId
        ? (participants.get(rawTeamId)?.teamId ?? `team:${rawTeamId}`)
        : fallback;
    };

    const appendLeader = (
      entryValue: unknown,
      categoryKey?: string,
      categoryName?: string,
      fallbackTeamId?: string,
    ): void => {
      const entry = this.asRecord(entryValue);
      const athlete = this.asRecord(entry.athlete ?? entry.player);
      const espnAthleteId = this.text(athlete.id ?? entry.athleteId);
      const teamId = resolveTeamId(entry, fallbackTeamId);
      const mainStat = this.asRecord(entry.mainStat);
      const value = this.number(entry.value ?? entry.displayValue ?? mainStat.value);
      output.push({
        categoryKey,
        categoryName,
        athleteId: espnAthleteId ? `athlete:${espnAthleteId}` : undefined,
        teamId,
        name: this.text(athlete.displayName ?? athlete.fullName ?? entry.displayName ?? entry.name),
        value,
        displayValue: this.text(entry.displayValue ?? mainStat.value),
        rank: this.number(entry.rank ?? entry.sortOrder) ?? undefined,
      });
    };

    const appendCategory = (categoryValue: unknown, fallbackTeamId?: string): void => {
      const category = this.asRecord(categoryValue);
      const categoryKey = this.text(category.name ?? category.key);
      const categoryName = this.text(category.displayName ?? category.shortDisplayName ?? category.abbreviation);
      const entries = this.asArray(category.leaders ?? category.items ?? category.athletes);
      if (entries.length) {
        entries.forEach((entry) => appendLeader(entry, categoryKey, categoryName, fallbackTeamId));
        return;
      }
      if (category.athlete || category.player) {
        appendLeader(category, categoryKey, categoryName, fallbackTeamId);
      }
    };

    if (Array.isArray(raw)) {
      for (const sectionValue of raw) {
        const section = this.asRecord(sectionValue);
        const teamId = resolveTeamId(section);
        const categories = this.asArray(section.leaders);
        if (categories.length) {
          categories.forEach((category) => appendCategory(category, teamId));
        } else {
          appendCategory(section);
        }
      }
    } else if (raw !== null && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw as UnknownRecord)) {
        const section = this.asRecord(value);
        if (Array.isArray(value)) {
          value.forEach((category) => appendCategory({ name: key, leaders: [category] }));
        } else if (Array.isArray(section.leaders)) {
          section.leaders.forEach((category) => appendCategory(category, resolveTeamId(section)));
        } else {
          appendCategory({ ...section, name: section.name ?? key });
        }
      }
    }

    return output.filter((leader) => Boolean(leader.categoryKey || leader.athleteId || leader.name));
  }

  private normalizeSummaryEvents(
    summary: UnknownRecord,
    participants: Map<string, { teamId: string; side: 'HOME' | 'AWAY' | 'UNKNOWN' }>,
  ): SportsMatchSummaryEvent[] {
    const boxscore = this.asRecord(summary.boxscore);
    const rows = this.asArray(summary.keyEvents).length
      ? this.asArray(summary.keyEvents)
      : this.asArray(boxscore.keyEvents);
    return rows.map((rowValue) => {
      const row = this.asRecord(rowValue);
      const type = this.asRecord(row.type);
      const clock = this.asRecord(row.clock);
      const periodValue = this.asRecord(row.period);
      const team = this.asRecord(row.team);
      const espnTeamId = this.text(team.id ?? row.teamId);
      const athletes = this.asArray(row.athletesInvolved ?? row.participants ?? row.athletes);
      const athleteIds = athletes.map((athleteValue) => {
        const athlete = this.asRecord(athleteValue);
        const person = this.asRecord(athlete.athlete ?? athlete.player);
        const id = this.text(person.id ?? athlete.id ?? athlete.athleteId);
        return id ? `athlete:${id}` : '';
      }).filter(Boolean);
      const period = this.number(periodValue.number ?? row.periodNumber ?? row.period);
      const homeScore = this.number(row.homeScore ?? this.asRecord(row.score).home);
      const awayScore = this.number(row.awayScore ?? this.asRecord(row.score).away);
      return {
        eventId: this.text(row.id ?? row.eventId),
        type: this.text(type.text ?? type.type ?? type.name ?? row.name ?? row.displayName ?? row.type),
        description: this.text(row.text ?? row.description ?? row.shortText),
        clock: this.text(clock.displayValue ?? row.displayClock ?? row.time),
        period: period ?? undefined,
        teamId: espnTeamId ? (participants.get(espnTeamId)?.teamId ?? `team:${espnTeamId}`) : undefined,
        athleteIds,
        homeScore: homeScore ?? undefined,
        awayScore: awayScore ?? undefined,
        sourceCoverage: 'PARTIAL' as const,
      };
    });
  }

  private normalizeStatistic(value: unknown): SportsNormalizedStatistic {
    const row = this.asRecord(value);
    const providerKey = this.text(row.name ?? row.displayName ?? row.shortDisplayName ?? row.abbreviation) ?? 'unknown';
    const normalizedKey = this.key(providerKey);
    const canonicalKey = STATISTIC_ALIASES[normalizedKey] ?? null;
    const displayValue = this.text(row.displayValue ?? row.valueText);
    const valueSource = displayValue?.includes('%') ? displayValue : row.value ?? row.displayValue ?? row.valueText;
    const parsedValue = this.number(valueSource);
    const unit = this.statisticUnit(canonicalKey);
    const numericValue = unit === 'RATIO' && parsedValue !== null && parsedValue > 1
      ? parsedValue / 100
      : parsedValue;
    return {
      canonicalKey,
      providerKey,
      providerLabel: this.text(row.label ?? row.displayName ?? row.shortDisplayName),
      value: numericValue,
      displayValue,
      unit,
    };
  }

  private statisticUnit(canonicalKey: string | null): SportsNormalizedStatistic['unit'] {
    if (!canonicalKey) return 'UNKNOWN';
    if (canonicalKey === 'possession') return 'PERCENT';
    if (canonicalKey === 'passAccuracy' || canonicalKey === 'crossAccuracy' || canonicalKey === 'shotAccuracy') return 'RATIO';
    if (canonicalKey === 'minutesPlayed') return 'MINUTES';
    if (COUNT_STATISTICS.has(canonicalKey)) return 'COUNT';
    return 'UNKNOWN';
  }

  private teamSectionStatus(
    rows: SportsNormalizedTeamStatistics[],
    participants: Map<string, { teamId: string; side: 'HOME' | 'AWAY' | 'UNKNOWN' }>,
  ): SportsMatchFactSectionStatus {
    const required = [...participants.values()].filter((item) => item.side === 'HOME' || item.side === 'AWAY');
    if (!required.length) return rows.length ? 'AVAILABLE' : 'NOT_PROVIDED';
    const covered = new Set(rows.filter((row) => row.statistics.length).map((row) => row.teamId));
    const coveredCount = required.filter((item) => covered.has(item.teamId)).length;
    return coveredCount === required.length ? 'COMPLETE' : coveredCount > 0 ? 'PARTIAL' : 'NOT_PROVIDED';
  }

  private teamCoverageStatus(
    coveredTeams: Set<string>,
    participants: Map<string, { teamId: string; side: 'HOME' | 'AWAY' | 'UNKNOWN' }>,
  ): SportsMatchFactSectionStatus {
    const required = [...participants.values()].filter((item) => item.side === 'HOME' || item.side === 'AWAY');
    if (!coveredTeams.size) return 'NOT_PROVIDED';
    if (!required.length) return 'AVAILABLE';
    const coveredCount = required.filter((item) => coveredTeams.has(item.teamId)).length;
    // ESPN roster/leader sections can be partial. Presence on both sides is
    // availability, not proof that every player row was returned.
    return coveredCount === required.length ? 'AVAILABLE' : 'PARTIAL';
  }

  private periodScoreStatus(
    rows: SportsNormalizedPeriodScore[],
    participants: Map<string, { teamId: string; side: 'HOME' | 'AWAY' | 'UNKNOWN' }>,
  ): SportsMatchFactSectionStatus {
    if (!rows.length) return 'NOT_PROVIDED';
    const knownSides = new Set([...participants.values()].filter((item) => item.side !== 'UNKNOWN').map((item) => item.teamId));
    if (knownSides.size < 2) return 'AVAILABLE';
    const covered = new Set(rows.map((row) => row.teamId));
    return [...knownSides].every((teamId) => covered.has(teamId)) ? 'COMPLETE' : 'PARTIAL';
  }

  private summaryCompetitors(summary: UnknownRecord): UnknownRecord[] {
    const header = this.asRecord(summary.header);
    const event = this.asRecord(summary.event ?? header.event);
    const competition = this.asRecord(
      this.asArray(header.competitions)[0] ??
      this.asArray(event.competitions)[0] ??
      summary.competition,
    );
    return this.asArray(competition.competitors).map((item) => this.asRecord(item));
  }

  private asRecord(value: unknown): UnknownRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as UnknownRecord
      : {};
  }

  private asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private text(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
  }

  private number(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const normalized = value.replace(/,/g, '').replace(/%/g, '').trim();
    if (!normalized || !/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private boolean(value: unknown): boolean | undefined {
    if (value === true || value === 1 || value === 'true' || value === '1') return true;
    if (value === false || value === 0 || value === 'false' || value === '0') return false;
    return undefined;
  }

  private key(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
  }
}
