import { Injectable } from '@nestjs/common';
import type { SportsMatchReadModel } from '../../sports/interfaces/sports-read.interface';
import { SettlementEventFacts } from '../interfaces/settlement-context.interface';
import { createSettlementSourceFingerprint } from '../utils/sports-settlement-fingerprint.util';

type NumericMap = Record<string, number>;

const normalizedSummaryPlayerKey = (value: unknown): string | undefined => {
  const key = String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliases: Record<string, string> = {
    goals: 'goals', totalgoals: 'goals', goal: 'goals',
    assists: 'assists', goalassists: 'assists', assist: 'assists',
    yellowcards: 'yellowcards', yellowcard: 'yellowcards',
    redcards: 'redcards', redcard: 'redcards',
    shots: 'shots', totalshots: 'shots',
    shotsontarget: 'shotsontarget', shotsongoal: 'shotsontarget',
    minutes: 'minutesplayed', minutesplayed: 'minutesplayed',
    appearances: 'appearances', appearance: 'appearances', app: 'appearances',
    owngoals: 'owngoals', penaltiesmissed: 'penaltiesmissed', penaltiesscored: 'penaltiesscored',
  };
  return aliases[key] ?? (key || undefined);
};
const asDate = (value: unknown): Date | undefined => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }
  return undefined;
};
const numberValue = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const safeScore = (value: unknown): number | undefined => {
  const parsed = numberValue(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
};
const normalize = (value: unknown): string => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const compactType = (value: unknown): string => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
const maxDate = (...values: Array<Date | undefined>): Date | undefined => {
  const dates = values.filter((item): item is Date => Boolean(item));
  return dates.length ? new Date(Math.max(...dates.map((item) => item.getTime()))) : undefined;
};

function canonicalStatisticKey(key: string, name: string, category?: string): string | undefined {
  const source = normalize(`${key} ${name} ${category ?? ''}`);
  if (source.includes('shotsontarget') || source.includes('shotsongoal')) return 'shotsontarget';
  if (source.includes('corner')) return 'corners';
  if (source.includes('yellowcard') || source.includes('yellowcards')) return 'yellowcards';
  if (source.includes('redcard') || source.includes('redcards') || source.includes('sentoff')) return 'redcards';
  if (source.includes('card')) return 'cards';
  if (source.includes('offside')) return 'offsides';
  if (source.includes('foul')) return 'fouls';
  if (source.includes('possession')) return 'possession';
  if (source.includes('shot')) return 'shots';
  if (source.includes('penalt')) return 'penaltiesawarded';
  return undefined;
}

function parseMinute(clock: string | undefined, period: number | undefined): number | undefined {
  if (!clock) return undefined;
  const text = clock.trim();
  const match = text.match(/(?:^|\D)(\d{1,3})(?:\s*\+\s*(\d{1,2}))?/);
  if (!match) return undefined;
  const base = Number(match[1]);
  const added = Number(match[2] ?? 0);
  if (!Number.isFinite(base)) return undefined;
  // Sports timeline clocks can be period-relative. Convert later periods to
  // absolute match minutes only when the clock is clearly <= a normal period.
  if (period === 2 && base <= 45) return 45 + base + added / 100;
  if (period === 3 && base <= 15) return 90 + base + added / 100;
  if (period === 4 && base <= 15) return 105 + base + added / 100;
  return base + added / 100;
}

function sourceDateOf(value: { source?: { collectedAt?: Date; providerUpdatedAt?: Date }; updatedAt?: Date; createdAt?: Date }): Date | undefined {
  return maxDate(asDate(value.source?.collectedAt), asDate(value.source?.providerUpdatedAt), asDate(value.updatedAt), asDate(value.createdAt));
}

@Injectable()
export class FootballMatchFactsService {
  extract(
    match: SportsMatchReadModel,
    options: { timelineCoverageComplete?: boolean } = {},
  ): SettlementEventFacts {
    const fixture = match.fixture;
    const normalizedSummary = match.matchFacts ?? null;
    const home = fixture.competitors.find((item) => item.homeAway === 'HOME');
    const away = fixture.competitors.find((item) => item.homeAway === 'AWAY');
    const homeTeamId = String(home?.teamId ?? '').trim();
    const awayTeamId = String(away?.teamId ?? '').trim();
    const homeTeamName = String(match.homeTeam?.displayName ?? match.homeTeam?.name ?? fixture.name ?? 'Home Team').trim();
    const awayTeamName = String(match.awayTeam?.displayName ?? match.awayTeam?.name ?? 'Away Team').trim();
    const state = fixture.status.state;
    const statusText = compactType([
      fixture.status.providerState,
      fixture.status.name,
      fixture.status.description,
      fixture.status.shortDescription,
    ].filter(Boolean).join(' '));
    const isFinished = state === 'COMPLETED' || fixture.status.isFinal === true;
    const afterExtraTime = ['EXTRA_TIME', 'PENALTIES'].includes(state) ||
      /after extra time|after penalties|aet|penalties/.test(statusText) ||
      fixture.periodScores.some((item) => item.period > 2) ||
      (normalizedSummary?.periodScores ?? []).some((item) => item.period > 2);
    const firstHalfComplete = isFinished || afterExtraTime || state === 'HALFTIME' ||
      (typeof fixture.status.period === 'number' && fixture.status.period >= 2);
    const secondHalfComplete = isFinished || afterExtraTime ||
      (typeof fixture.status.period === 'number' && fixture.status.period >= 3);

    const blockers: string[] = [];
    const diagnostics: string[] = [];
    const conflictingStats: string[] = [];
    if (!homeTeamId || !awayTeamId) blockers.push('Normalized Sports fixture does not contain both home and away team IDs.');
    else if (homeTeamId === awayTeamId) blockers.push('Normalized Sports fixture resolves home and away to the same team ID.');
    if (normalize(homeTeamName) && normalize(awayTeamName) && normalize(homeTeamName) === normalize(awayTeamName)) {
      blockers.push('Normalized Sports fixture resolves home and away to the same team name.');
    }

    const periodMap = new Map<string, Map<number, number>>();
    const summaryPeriodKeys = new Set<string>();
    const summaryPeriodScores = Array.isArray(normalizedSummary?.periodScores)
      ? normalizedSummary.periodScores
      : [];
    for (const row of summaryPeriodScores) {
      const score = safeScore(row.score);
      if (score === undefined || !row.teamId || !Number.isInteger(row.period)) continue;
      const byPeriod = periodMap.get(row.teamId) ?? new Map<number, number>();
      if (byPeriod.has(row.period) && byPeriod.get(row.period) !== score) {
        blockers.push(`Conflicting ESPN Summary period-score records for team ${row.teamId}, period ${row.period}.`);
      }
      byPeriod.set(row.period, score);
      periodMap.set(row.teamId, byPeriod);
      summaryPeriodKeys.add(`${row.teamId}:${row.period}`);
    }
    for (const row of fixture.periodScores ?? []) {
      const score = safeScore(row.score);
      if (score === undefined || !row.teamId || !Number.isInteger(row.period)) continue;
      // A normalized Summary period score outranks an older scoreboard period row.
      if (summaryPeriodKeys.has(`${row.teamId}:${row.period}`)) continue;
      const byPeriod = periodMap.get(row.teamId) ?? new Map<number, number>();
      if (byPeriod.has(row.period) && byPeriod.get(row.period) !== score) {
        blockers.push(`Conflicting Sports period-score records for team ${row.teamId}, period ${row.period}.`);
      }
      byPeriod.set(row.period, score);
      periodMap.set(row.teamId, byPeriod);
    }
    const homePeriods = periodMap.get(homeTeamId) ?? new Map<number, number>();
    const awayPeriods = periodMap.get(awayTeamId) ?? new Map<number, number>();
    let halfTimeHomeGoals = homePeriods.get(1);
    let halfTimeAwayGoals = awayPeriods.get(1);
    let secondHalfHomeGoals = homePeriods.get(2);
    let secondHalfAwayGoals = awayPeriods.get(2);
    if (halfTimeHomeGoals === undefined && state === 'HALFTIME') halfTimeHomeGoals = safeScore(home?.score);
    if (halfTimeAwayGoals === undefined && state === 'HALFTIME') halfTimeAwayGoals = safeScore(away?.score);
    const periodScoresAvailable = [
      halfTimeHomeGoals, halfTimeAwayGoals, secondHalfHomeGoals, secondHalfAwayGoals,
    ].every((item) => item !== undefined);

    const summaryResult = normalizedSummary?.matchResult;
    const summaryResultIsAuthoritative = Boolean(
      isFinished &&
      summaryResult?.available === true &&
      summaryResult.isFinal === true &&
      summaryResult.scoreSource === 'ESPN_SUMMARY' &&
      safeScore(summaryResult.homeScore) !== undefined &&
      safeScore(summaryResult.awayScore) !== undefined,
    );
    const officialHomeScore = summaryResultIsAuthoritative
      ? safeScore(summaryResult?.homeScore)
      : safeScore(home?.score);
    const officialAwayScore = summaryResultIsAuthoritative
      ? safeScore(summaryResult?.awayScore)
      : safeScore(away?.score);
    const scoreSource = summaryResultIsAuthoritative
      ? 'ESPN_SUMMARY'
      : 'SPORTS_NORMALIZED_FIXTURE';
    const regulationScoreAvailable = !afterExtraTime || periodScoresAvailable;
    // Canonical football full-time markets are regulation-time markets. When
    // extra time occurred, never reuse the aggregate final score as a substitute
    // for the 90-minute score: doing so can incorrectly grade goals/result.
    const homeGoals = afterExtraTime
      ? periodScoresAvailable
        ? halfTimeHomeGoals! + secondHalfHomeGoals!
        : undefined
      : officialHomeScore;
    const awayGoals = afterExtraTime
      ? periodScoresAvailable
        ? halfTimeAwayGoals! + secondHalfAwayGoals!
        : undefined
      : officialAwayScore;
    if (isFinished && afterExtraTime && !periodScoresAvailable) {
      diagnostics.push('EXTRA_TIME_FIXTURE_WITHOUT_REGULATION_PERIOD_SPLIT');
    }
    if (periodScoresAvailable && !afterExtraTime && isFinished &&
      officialHomeScore !== undefined && officialAwayScore !== undefined) {
      const homePeriodTotal = halfTimeHomeGoals! + secondHalfHomeGoals!;
      const awayPeriodTotal = halfTimeAwayGoals! + secondHalfAwayGoals!;
      if (homePeriodTotal !== officialHomeScore || awayPeriodTotal !== officialAwayScore) {
        blockers.push('Sports period scores do not reconcile with the official final fixture score.');
      }
    }

    const homeStats: NumericMap = {};
    const awayStats: NumericMap = {};
    const statisticSources: Date[] = [];
    const statisticsSourceByTeam = new Map<string, Date>();
    const statisticsOriginByTeam = new Map<string, 'ESPN_SUMMARY' | 'SPORTS_NORMALIZED_FIXTURE' | 'UNAVAILABLE'>();
    const fixtureStatisticsSourceAt = sourceDateOf(fixture);
    const summaryStatisticsSourceAt = asDate(normalizedSummary?.sourceCollectedAt);
    const normalizedTeamStatistics = Array.isArray(normalizedSummary?.teamStatistics)
      ? normalizedSummary.teamStatistics
      : [];
    const teamStatisticInputs = [
      { teamId: homeTeamId, side: 'home', rows: home?.statistics ?? [], target: homeStats },
      { teamId: awayTeamId, side: 'away', rows: away?.statistics ?? [], target: awayStats },
    ];
    for (const input of teamStatisticInputs) {
      if (!input.teamId) continue;
      const summaryTeam = normalizedTeamStatistics.find((row) => String(row.teamId ?? '') === input.teamId);
      const summaryRows = Array.isArray(summaryTeam?.statistics)
        ? summaryTeam.statistics
        : [];
      const usableSummaryRows = summaryRows.filter((row) =>
        row && typeof row === 'object' && numberValue(row.value) !== undefined && numberValue(row.value)! >= 0,
      );
      if (usableSummaryRows.length > 0) {
        const seen = new Map<string, number>();
        for (const statistic of usableSummaryRows) {
          const key = canonicalStatisticKey(
            String(statistic.canonicalKey ?? statistic.providerKey ?? ''),
            String(statistic.providerLabel ?? ''),
            '',
          );
          const parsed = numberValue(statistic.value);
          if (!key || parsed === undefined || parsed < 0) continue;
          if (seen.has(key) && seen.get(key) !== parsed) conflictingStats.push(`${input.side}:${key}`);
          seen.set(key, parsed);
          input.target[key] = parsed;
        }
        if (summaryStatisticsSourceAt) {
          statisticSources.push(summaryStatisticsSourceAt);
          statisticsSourceByTeam.set(input.teamId, summaryStatisticsSourceAt);
          statisticsOriginByTeam.set(input.teamId, 'ESPN_SUMMARY');
        } else {
          statisticsOriginByTeam.set(input.teamId, 'UNAVAILABLE');
        }
        // Do not blend older scoreboard values into a Summary team row. Missing
        // Summary fields remain unavailable instead of silently taking stale values.
        continue;
      }

      if (!Array.isArray(input.rows) || input.rows.length === 0) {
        statisticsOriginByTeam.set(input.teamId, 'UNAVAILABLE');
        continue;
      }
      const seen = new Map<string, number>();
      for (const candidate of input.rows) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const statistic = candidate as Record<string, unknown>;
        const key = canonicalStatisticKey(
          String(statistic.key ?? statistic.abbreviation ?? ''),
          String(statistic.name ?? statistic.label ?? statistic.displayName ?? ''),
          String(statistic.category ?? ''),
        );
        const parsed = numberValue(statistic.value ?? statistic.displayValue ?? statistic.valueText);
        if (!key || parsed === undefined || parsed < 0) continue;
        if (seen.has(key) && seen.get(key) !== parsed) conflictingStats.push(`${input.side}:${key}`);
        seen.set(key, parsed);
        input.target[key] = parsed;
      }
      if (seen.size > 0 && fixtureStatisticsSourceAt) {
        statisticSources.push(fixtureStatisticsSourceAt);
        statisticsSourceByTeam.set(input.teamId, fixtureStatisticsSourceAt);
        statisticsOriginByTeam.set(input.teamId, 'SPORTS_NORMALIZED_FIXTURE');
      } else {
        statisticsOriginByTeam.set(input.teamId, 'UNAVAILABLE');
      }
    }
    const uniqueConflicts = [...new Set(conflictingStats)];
    if (uniqueConflicts.length) diagnostics.push('CONFLICTING_NORMALIZED_TEAM_STATISTICS');

    const goals: SettlementEventFacts['goals'] = [];
    const cards: SettlementEventFacts['cards'] = [];
    const playerStats: Record<string, NumericMap> = {};
    const playerNames: Record<string, string> = {};
    for (const player of normalizedSummary?.playerAppearances ?? []) {
      const playerId = String(player.playerId ?? '').trim();
      if (!playerId) continue;
      const name = String(player.name ?? player.shortName ?? '').trim();
      if (name) playerNames[playerId] = name;
      const stats = playerStats[playerId] ?? {};
      if (typeof player.appearances === 'number' && Number.isFinite(player.appearances)) {
        stats.appearances = player.appearances;
      }
      for (const statistic of player.statistics ?? []) {
        if (statistic.value === null || statistic.value === undefined) continue;
        const key = normalizedSummaryPlayerKey(statistic.canonicalKey ?? statistic.providerKey);
        const value = numberValue(statistic.value);
        if (!key || value === undefined || value < 0) continue;
        stats[key] = value;
      }
      playerStats[playerId] = stats;
    }
    let observedPenalties = 0;
    const timelineSources: Date[] = [];
    const seenEventIds = new Set<string>();
    const timeline = [...(match.timeline ?? [])].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    let previousScore: { home: number; away: number } | undefined = { home: 0, away: 0 };
    for (const event of timeline) {
      if (seenEventIds.has(event.id)) continue;
      seenEventIds.add(event.id);
      // Invalid/overturned provider plays and shootout kicks are not regulation
      // match events for ordinary football markets.
      if (event.valid === false || event.shootout === true) continue;

      const collected = sourceDateOf(event);
      if (collected) timelineSources.push(collected);
      const type = compactType(`${event.typeKey ?? ''} ${event.type ?? ''}`);
      const description = compactType(event.description);
      const combined = `${type} ${description}`;
      const minute = parseMinute(event.clock, event.period);
      const isVoided = /overturned|rescinded|no goal|goal disallowed|cancelled goal|canceled goal|card rescinded|booking rescinded|dismissal overturned/.test(combined);
      const ownGoal = !isVoided && (event.ownGoal !== undefined
        ? event.ownGoal === true
        : /\bown goal\b|\bog\b/.test(combined));
      const isGoal = !isVoided && (
        event.scoringPlay === true ||
        ownGoal ||
        /\bgoal\b/.test(combined) ||
        /score change/.test(combined)
      ) && !/goal kick|goalkeeper/.test(combined);
      const isPenalty = !isVoided && (
        event.penaltyKick === true || /penalt/.test(combined)
      );

      const involved = Array.isArray(event.involvedAthletes) ? event.involvedAthletes : [];
      for (const person of involved) {
        const athleteId = String(person.athleteId ?? '').trim();
        const name = String(person.name ?? person.shortName ?? '').trim();
        if (athleteId && name) playerNames[athleteId] = name;
      }
      const assistPerson = involved.find((person) => /assist/.test(String(person.role ?? '').toLowerCase()));
      const scorerPerson = involved.find((person) => /scor|goal/.test(String(person.role ?? '').toLowerCase()));
      const cardPerson = involved.find((person) => /card|book|offender|recipient/.test(String(person.role ?? '').toLowerCase()));
      const scorerId = String(event.athleteId ?? scorerPerson?.athleteId ?? '').trim();
      const assistId = String(assistPerson?.athleteId ?? event.relatedAthleteId ?? '').trim();
      const cardAthleteId = String(event.athleteId ?? cardPerson?.athleteId ?? '').trim();
      if (event.athleteId && involved.length) {
        const primary = involved.find((person) => person.athleteId === event.athleteId);
        const name = String(primary?.name ?? primary?.shortName ?? '').trim();
        if (name) playerNames[event.athleteId] = name;
      }

      const scoreAfterHome = safeScore(event.scoreAfter?.home ?? event.homeScore);
      const scoreAfterAway = safeScore(event.scoreAfter?.away ?? event.awayScore);
      let scoreAfterCreditedTeamId: string | undefined;
      if (scoreAfterHome !== undefined && scoreAfterAway !== undefined && previousScore) {
        const homeDelta = scoreAfterHome - previousScore.home;
        const awayDelta = scoreAfterAway - previousScore.away;
        if (homeDelta > 0 && awayDelta === 0) scoreAfterCreditedTeamId = homeTeamId;
        else if (awayDelta > 0 && homeDelta === 0) scoreAfterCreditedTeamId = awayTeamId;
      }
      if (isGoal) {
        const creditedTeamId = scoreAfterCreditedTeamId ?? (ownGoal ? undefined : event.teamId);
        goals.push({
          eventKey: event.id,
          teamId: event.teamId,
          creditedTeamId,
          // The explicit scorer is preferred; relatedAthleteId is only used as
          // an assist fallback and must never be credited as the goal scorer.
          playerIds: scorerId ? [scorerId] : [],
          minute,
          order: event.sequence,
          ownGoal,
          penalty: isPenalty,
        });
        if (isPenalty) observedPenalties += 1;
        if (assistId) {
          const stats = playerStats[assistId] ?? {};
          stats.assists = (stats.assists ?? 0) + 1;
          playerStats[assistId] = stats;
        }
      } else if (isPenalty && /award|given|conced|foul|decision|penalty/.test(combined)) {
        observedPenalties += 1;
      }

      const red = !isVoided && (
        event.redCard === true ||
        /red card|sent off|sending off|dismissed|second yellow/.test(combined)
      );
      const yellow = !isVoided && (
        event.yellowCard === true ||
        (!red && /yellow card|booked|caution/.test(combined)) ||
        /second yellow/.test(combined)
      );
      if (red || yellow) {
        cards.push({
          playerIds: cardAthleteId ? [cardAthleteId] : [],
          teamId: event.teamId ?? cardPerson?.teamId,
          red,
          yellow: yellow || /second yellow/.test(combined),
          minute,
        });
        if (cardAthleteId) {
          const stats = playerStats[cardAthleteId] ?? {};
          if (red) stats.redcards = (stats.redcards ?? 0) + 1;
          if (yellow) stats.yellowcards = (stats.yellowcards ?? 0) + 1;
          playerStats[cardAthleteId] = stats;
        }
      }
      if (scoreAfterHome !== undefined && scoreAfterAway !== undefined) {
        previousScore = { home: scoreAfterHome, away: scoreAfterAway };
      }
    }

    const isInExtraTime = afterExtraTime;
    const regulationGoals = isInExtraTime
      ? goals.filter((goal) => goal.minute !== undefined && goal.minute <= 90.99)
      : goals;
    const creditedHomeGoals = regulationGoals.filter((goal) => goal.creditedTeamId === homeTeamId).length;
    const creditedAwayGoals = regulationGoals.filter((goal) => goal.creditedTeamId === awayTeamId).length;
    const timelineCoverageComplete = options.timelineCoverageComplete === true;
    const goalEventsComplete = isFinished && timelineCoverageComplete &&
      homeGoals !== undefined && awayGoals !== undefined &&
      (!isInExtraTime || regulationScoreAvailable === true) &&
      regulationGoals.length === homeGoals + awayGoals &&
      creditedHomeGoals === homeGoals && creditedAwayGoals === awayGoals &&
      (!isInExtraTime || goals.every((goal) => goal.minute !== undefined));
    if (isFinished && !timelineCoverageComplete) diagnostics.push('MATCH_PLAYS_COVERAGE_NOT_CONFIRMED');
    if (isFinished && timelineCoverageComplete && !goalEventsComplete) diagnostics.push('GOAL_TIMELINE_DOES_NOT_FULLY_RECONCILE_WITH_REGULATION_SCORE');

    const statHomeYellow = homeStats.yellowcards;
    const statAwayYellow = awayStats.yellowcards;
    const statHomeRed = homeStats.redcards;
    const statAwayRed = awayStats.redcards;
    const redCards = statHomeRed !== undefined && statAwayRed !== undefined
      ? statHomeRed + statAwayRed
      : isFinished && !afterExtraTime && cards.length > 0 ? cards.filter((item) => item.red).length : undefined;
    const yellowCards = statHomeYellow !== undefined && statAwayYellow !== undefined
      ? statHomeYellow + statAwayYellow
      : isFinished && !afterExtraTime && cards.length > 0 ? cards.filter((item) => item.yellow).length : undefined;
    const penaltiesStatHome = homeStats.penaltiesawarded;
    const penaltiesStatAway = awayStats.penaltiesawarded;
    const penaltiesAwarded = observedPenalties > 0
      ? observedPenalties
      : penaltiesStatHome !== undefined && penaltiesStatAway !== undefined
        ? penaltiesStatHome + penaltiesStatAway
        : undefined;

    const fixtureSourceCollectedAt = fixtureStatisticsSourceAt;
    const timelineCollectedAt = maxDate(...timelineSources);
    const statisticsCollectedAt = maxDate(...statisticSources);
    const summaryFactsCollectedAt = asDate(normalizedSummary?.sourceCollectedAt);
    const sourceDataCollectedAt = maxDate(fixtureSourceCollectedAt, timelineCollectedAt, statisticsCollectedAt, summaryFactsCollectedAt);
    if (!fixtureSourceCollectedAt) diagnostics.push('SPORTS_FIXTURE_SOURCE_TIMESTAMP_MISSING');
    if (normalizedSummary?.summaryEvents?.length) diagnostics.push('SUMMARY_KEY_EVENTS_ARE_PARTIAL_NOT_PLAY_COVERAGE');
    const currentMinute = parseMinute(fixture.status.clock ?? fixture.status.displayClock, fixture.status.period);
    const sourceFingerprint = createSettlementSourceFingerprint(match);

    return {
      eventId: fixture.id || fixture.espnEventId,
      leagueId: fixture.competitionId,
      fixtureDate: asDate(fixture.kickoffAt),
      homeTeamId,
      awayTeamId,
      homeTeamName: homeTeamName || 'Home Team',
      awayTeamName: awayTeamName || 'Away Team',
      isFinished,
      fixtureState: state,
      fixtureStatus: [fixture.status.name, fixture.status.description, fixture.status.shortDescription].filter(Boolean).join(' | '),
      firstHalfComplete,
      secondHalfComplete,
      currentPeriod: fixture.status.period,
      currentMinute,
      afterExtraTime,
      regulationScoreAvailable,
      homeGoals,
      awayGoals,
      halfTimeHomeGoals,
      halfTimeAwayGoals,
      secondHalfHomeGoals,
      secondHalfAwayGoals,
      periodScoresAvailable,
      goalEventsComplete,
      eventDetailsAvailable: timeline.length > 0,
      timelineCoverageComplete,
      homeStats,
      awayStats,
      playerStats,
      playerNames,
      goals,
      cards,
      penaltiesAwarded,
      ownGoals: goals.filter((goal) => goal.ownGoal).length,
      redCards,
      yellowCards,
      sourceSummaryCollectedAt: sourceDataCollectedAt,
      sourceDataCollectedAt,
      fixtureSourceCollectedAt,
      timelineCollectedAt,
      statisticsCollectedAt,
      homeStatisticsCollectedAt: statisticsSourceByTeam.get(homeTeamId),
      awayStatisticsCollectedAt: statisticsSourceByTeam.get(awayTeamId),
      settlementBlockers: [...new Set(blockers)],
      sourceDiagnostics: [...new Set(diagnostics)],
      conflictingStats: uniqueConflicts,
      scoreSource,
      summaryFactsRevision: normalizedSummary?.revision,
      summaryFactsSourcePayloadHash: normalizedSummary?.sourcePayloadHash,
      summaryFactsCollectedAt,
      summaryFactsNormalizationVersion: normalizedSummary?.normalizationVersion,
      summaryFactsSectionStatus: normalizedSummary?.sectionStatus as unknown as Record<string, string> | undefined,
      homeStatisticsSource: statisticsOriginByTeam.get(homeTeamId) ?? 'UNAVAILABLE',
      awayStatisticsSource: statisticsOriginByTeam.get(awayTeamId) ?? 'UNAVAILABLE',
      sourceFingerprint,
    };
  }
}


