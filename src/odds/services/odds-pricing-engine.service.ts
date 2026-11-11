import { Injectable } from '@nestjs/common';
import { FOOTBALL_MARKET_CATALOG, expandCanonicalSelections } from '../catalog/football-market-catalog';
import type { CanonicalMarketDefinition, CanonicalExpandedSelection } from '../catalog/football-market-catalog';
import { ODDS_CONFIG } from '../config/odds.config';
import type {
  SportsMatchReadModel,
} from '../../sports/interfaces/sports-read.interface';
import type {
  SportsTeamHomeAwayRecord,
  SportsTeamScoringRecord,
  SportsCompetitionScoringTotalsRecord,
  SportsTeamStatisticsAggregateRecord,
  SportsHeadToHeadRecord,
} from '../../sports/interfaces/sports-derived-data.interface';
import type { SportsTeamReadModel } from '../../sports/interfaces/sports-read.interface';
import type { SportsFixtureReadiness } from '../../sports/interfaces/sports-readiness.interface';

export interface OddsPricingContext {
  match: SportsMatchReadModel;
  homeScoring: SportsTeamScoringRecord | null;
  awayScoring: SportsTeamScoringRecord | null;
  homeAwayRecord: SportsTeamHomeAwayRecord | null;
  awayAwayRecord: SportsTeamHomeAwayRecord | null;
  competitionScoring: SportsCompetitionScoringTotalsRecord | null;
  homeStatistics: SportsTeamStatisticsAggregateRecord | null;
  awayStatistics: SportsTeamStatisticsAggregateRecord | null;
  homeTeamData: SportsTeamReadModel | null;
  awayTeamData: SportsTeamReadModel | null;
  headToHead: SportsHeadToHeadRecord | null;
  readiness: SportsFixtureReadiness;
}

export interface ModelSelectionPrice {
  marketId: string;
  selectionKey: string;
  line?: number;
  fairProbability: number;
  fairOdds: number;
  dataQuality: number;
  sampleSize: number;
  calculationMethod: string;
  predictionReady: boolean;
}

interface ScoreMatrix {
  values: number[][];
  homeMean: number;
  awayMean: number;
}

interface CountModelInputs {
  total: number;
  home: number;
  away: number;
  sampleSize: number;
  dataQuality: number;
}

interface StatisticEstimate {
  average: number;
  sampleSize: number;
}

const round = (value: number, places = 6): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const normalizeKey = (value: unknown): string => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

@Injectable()
export class OddsPricingEngineService {
  constructor() {
    this.assertCanonicalMarketCoverage();
  }

  /** Fail fast when a newly enabled catalogue market has no Sports-backed pricing path. */
  private assertCanonicalMarketCoverage(): void {
    const timelineMarkets = new Set(['RED_CARD', 'PENALTY_AWARDED', 'OWN_GOAL_SCORED']);
    const goalOrderMarkets = new Set(['TEAM_TO_SCORE_FIRST', 'TEAM_TO_SCORE_LAST']);
    const unsupported: string[] = [];

    for (const market of FOOTBALL_MARKET_CATALOG) {
      if (market.pricingEnabled === false) continue;
      if (market.family === 'PLAYER') {
        unsupported.push(market.id);
        continue;
      }
      if (market.family === 'STATISTICS') {
        const supportedSelectionMode = market.selectionMode === 'OVER_UNDER'
          || (market.selectionMode === 'STATIC' && market.selections.every((selection) =>
            ['ODD', 'EVEN', 'HOME_WIN', 'DRAW', 'AWAY_WIN'].includes(selection.key),
          ));
        if (market.model !== 'COUNT_MODEL' || !market.statisticKey || !supportedSelectionMode) unsupported.push(market.id);
        continue;
      }
      if (market.family === 'EVENTS' && market.model === 'COUNT_MODEL') {
        if (!timelineMarkets.has(market.id)) unsupported.push(market.id);
        continue;
      }
      if (market.family === 'EVENTS' && market.model === 'SCORE_MATRIX') {
        if (!goalOrderMarkets.has(market.id)) unsupported.push(market.id);
        continue;
      }
      if (market.model !== 'SCORE_MATRIX' && market.model !== 'PERIOD_MATRIX') {
        unsupported.push(market.id);
      }
    }

    if (unsupported.length) {
      throw new Error(`Enabled canonical Odds markets have no Sports-backed pricing implementation: ${unsupported.join(', ')}`);
    }
  }

  calculate(context: OddsPricingContext): ModelSelectionPrice[] {
    if (!context.readiness?.fixtureEligible) return [];
    const fixture = context.match.fixture;
    const home = fixture.competitors.find((item) => item.homeAway === 'HOME');
    const away = fixture.competitors.find((item) => item.homeAway === 'AWAY');
    if (!home || !away) return [];

    const goals = this.buildGoalModel(context);
    const prices = new Map<string, ModelSelectionPrice>();
    if (goals) this.priceScoreMarkets(context, goals, prices);
    this.priceStatMarkets(context, prices);
    this.priceEventMarkets(context, prices);
    return [...prices.values()];
  }

  private buildGoalModel(context: OddsPricingContext): { full: ScoreMatrix; first: ScoreMatrix; second: ScoreMatrix; quality: number; sampleSize: number; observedPeriodSplit: boolean } | null {
    const homeTeamId = context.match.fixture.competitors.find((item) => item.homeAway === 'HOME')?.teamId;
    const awayTeamId = context.match.fixture.competitors.find((item) => item.homeAway === 'AWAY')?.teamId;
    if (!homeTeamId || !awayTeamId) return null;

    const homeHomeSplit = context.homeAwayRecord?.home;
    const awayAwaySplit = context.awayAwayRecord?.away;
    const homeAttack = this.valueOrUndefined(
      homeHomeSplit && homeHomeSplit.played >= 3 ? homeHomeSplit.goalsFor / homeHomeSplit.played : undefined,
      context.homeScoring?.averageGoalsFor ?? undefined,
    );
    const awayDefence = this.valueOrUndefined(
      awayAwaySplit && awayAwaySplit.played >= 3 ? awayAwaySplit.goalsAgainst / awayAwaySplit.played : undefined,
      context.awayScoring?.averageGoalsAgainst ?? undefined,
    );
    const awayAttack = this.valueOrUndefined(
      awayAwaySplit && awayAwaySplit.played >= 3 ? awayAwaySplit.goalsFor / awayAwaySplit.played : undefined,
      context.awayScoring?.averageGoalsFor ?? undefined,
    );
    const homeDefence = this.valueOrUndefined(
      homeHomeSplit && homeHomeSplit.played >= 3 ? homeHomeSplit.goalsAgainst / homeHomeSplit.played : undefined,
      context.homeScoring?.averageGoalsAgainst ?? undefined,
    );
    const compHome = context.competitionScoring && context.competitionScoring.fixturesPlayed >= 5
      ? context.competitionScoring.homeGoals / context.competitionScoring.fixturesPlayed
      : undefined;
    const compAway = context.competitionScoring && context.competitionScoring.fixturesPlayed >= 5
      ? context.competitionScoring.awayGoals / context.competitionScoring.fixturesPlayed
      : undefined;

    const baseHomeMean = this.weightedMean([
      { value: homeAttack, weight: 0.45 },
      { value: awayDefence, weight: 0.35 },
      { value: compHome, weight: 0.20 },
    ]);
    const baseAwayMean = this.weightedMean([
      { value: awayAttack, weight: 0.45 },
      { value: homeDefence, weight: 0.35 },
      { value: compAway, weight: 0.20 },
    ]);
    if (baseHomeMean === null || baseAwayMean === null) return null;

    const homeRecent = this.recentGoalRates(context.homeTeamData, homeTeamId, context.match.fixture.competitionId);
    const awayRecent = this.recentGoalRates(context.awayTeamData, awayTeamId, context.match.fixture.competitionId);
    const homeMean = homeRecent && awayRecent
      ? baseHomeMean * 0.70 + homeRecent.goalsFor * 0.15 + awayRecent.goalsAgainst * 0.15
      : baseHomeMean;
    const awayMean = awayRecent && homeRecent
      ? baseAwayMean * 0.70 + awayRecent.goalsFor * 0.15 + homeRecent.goalsAgainst * 0.15
      : baseAwayMean;

    const h2h = context.headToHead?.matches ?? [];
    const recentH2h = h2h.slice(0, 8);
    let adjustedHome = homeMean;
    let adjustedAway = awayMean;
    if (recentH2h.length >= 3) {
      const weights = recentH2h.map((item, index) => item.recencyWeight ?? 1 / (index + 1));
      const totalWeight = weights.reduce((sum, value) => sum + value, 0);
      if (totalWeight > 0) {
        const h2hHome = recentH2h.reduce((sum, item, index) =>
          sum + (item.homeTeamId === homeTeamId ? item.homeScore : item.awayScore) * weights[index], 0) / totalWeight;
        const h2hAway = recentH2h.reduce((sum, item, index) =>
          sum + (item.homeTeamId === homeTeamId ? item.awayScore : item.homeScore) * weights[index], 0) / totalWeight;
        adjustedHome = homeMean * 0.90 + h2hHome * 0.10;
        adjustedAway = awayMean * 0.90 + h2hAway * 0.10;
      }
    }

    const homeSamples = Math.max(context.homeScoring?.fixturesPlayed ?? 0, context.homeAwayRecord?.home.played ?? 0);
    const awaySamples = Math.max(context.awayScoring?.fixturesPlayed ?? 0, context.awayAwayRecord?.away.played ?? 0);
    const sampleSize = Math.min(homeSamples, awaySamples);
    if (sampleSize < ODDS_CONFIG.minimumHistoricalSampleSize) return null;

    const seasonCoverage = Math.min(1, sampleSize / 10);
    const venueCoverage = context.homeAwayRecord && context.awayAwayRecord ? 1 : 0;
    const competitionCoverage = context.competitionScoring && context.competitionScoring.fixturesPlayed >= 10 ? 1 : 0;
    const h2hCoverage = recentH2h.length >= 3 ? 1 : 0;
    const recentCoverage = homeRecent && awayRecent ? 1 : 0;
    const quality = clamp(
      0.35 * seasonCoverage + 0.20 * venueCoverage + 0.20 * competitionCoverage + 0.10 * h2hCoverage + 0.15 * recentCoverage,
      0,
      0.96,
    );

    const observedHomeShare = this.periodShare(context.homeTeamData, homeTeamId, 'FIRST_HALF');
    const observedAwayShare = this.periodShare(context.awayTeamData, awayTeamId, 'FIRST_HALF');
    const observedPeriodSplit = observedHomeShare !== null && observedAwayShare !== null;
    const firstHomeShare = observedHomeShare ?? ODDS_CONFIG.firstHalfGoalShare;
    const firstAwayShare = observedAwayShare ?? ODDS_CONFIG.firstHalfGoalShare;
    const firstHomeMean = adjustedHome * clamp(firstHomeShare, 0.32, 0.60);
    const firstAwayMean = adjustedAway * clamp(firstAwayShare, 0.32, 0.60);
    const secondHomeMean = Math.max(0.05, adjustedHome - firstHomeMean);
    const secondAwayMean = Math.max(0.05, adjustedAway - firstAwayMean);

    return {
      full: this.scoreMatrix(adjustedHome, adjustedAway),
      first: this.scoreMatrix(firstHomeMean, firstAwayMean),
      second: this.scoreMatrix(secondHomeMean, secondAwayMean),
      quality,
      sampleSize,
      observedPeriodSplit,
    };
  }

  private recentGoalRates(
    teamData: SportsTeamReadModel | null,
    teamId: string,
    competitionId: string,
  ): { goalsFor: number; goalsAgainst: number; sampleSize: number } | null {
    if (!teamData?.form?.length) return null;
    const results = teamData.form
      .filter((record) => !record.competitionId || record.competitionId === competitionId)
      .flatMap((record) => record.results ?? [])
      .sort((left, right) => right.kickoffAt.getTime() - left.kickoffAt.getTime())
      .slice(0, 5);
    if (results.length < 3) return null;
    let weightedGoalsFor = 0;
    let weightedGoalsAgainst = 0;
    let totalWeight = 0;
    results.forEach((item, index) => {
      const weight = 1 / (1 + index * 0.18);
      weightedGoalsFor += item.goalsFor * weight;
      weightedGoalsAgainst += item.goalsAgainst * weight;
      totalWeight += weight;
    });
    if (!totalWeight) return null;
    return {
      goalsFor: weightedGoalsFor / totalWeight,
      goalsAgainst: weightedGoalsAgainst / totalWeight,
      sampleSize: results.length,
    };
  }

  private periodShare(teamData: SportsTeamReadModel | null, teamId: string, period: 'FIRST_HALF'): number | null {
    if (!teamData?.recentFixtures?.length) return null;
    const observations: number[] = [];
    for (const fixture of teamData.recentFixtures) {
      const total = fixture.periodScores.reduce((sum, item) => sum + (item.teamId === teamId && item.period === 1 ? item.score : 0), 0);
      const full = fixture.competitors.find((item) => item.teamId === teamId)?.score;
      if (typeof full === 'number' && full > 0 && fixture.periodScores.some((item) => item.teamId === teamId && item.period === 1)) {
        observations.push(clamp(total / full, 0.05, 0.95));
      }
    }
    if (observations.length < 4) return null;
    return observations.reduce((sum, value) => sum + value, 0) / observations.length;
  }

  /**
   * Sports is the authority on market-specific evidence coverage. The model
   * may calculate a probability only after the corresponding coverage contract
   * has approved that market; unrelated missing statistics do not block other
   * markets.
   */
  private isMarketReady(
    market: CanonicalMarketDefinition,
    readiness: SportsFixtureReadiness,
  ): boolean {
    if (!readiness.fixtureEligible) return false;
    if (market.family === 'PLAYER') return false;
    if (market.family === 'STATISTICS') {
      return market.statisticKey
        ? readiness.teamStatistics[market.statisticKey]?.ready === true
        : false;
    }
    if (market.family === 'EVENTS' && market.model === 'COUNT_MODEL') {
      const eventReadiness = market.id === 'RED_CARD'
        ? readiness.eventMarkets.redCard
        : market.id === 'PENALTY_AWARDED'
          ? readiness.eventMarkets.penaltyAwarded
          : market.id === 'OWN_GOAL_SCORED'
            ? readiness.eventMarkets.ownGoal
            : null;
      return eventReadiness?.ready === true;
    }
    if (market.model === 'PERIOD_MATRIX') return readiness.periodMatrix.ready;
    if (market.model === 'SCORE_MATRIX') return readiness.scoreMatrix.ready;
    return false;
  }

  private priceScoreMarkets(context: OddsPricingContext, model: { full: ScoreMatrix; first: ScoreMatrix; second: ScoreMatrix; quality: number; sampleSize: number; observedPeriodSplit: boolean }, out: Map<string, ModelSelectionPrice>): void {
    const homeTeam = context.match.homeTeam?.displayName ?? context.match.homeTeam?.name ?? 'Home Team';
    const awayTeam = context.match.awayTeam?.displayName ?? context.match.awayTeam?.name ?? 'Away Team';
    for (const market of FOOTBALL_MARKET_CATALOG) {
      const isSportsStatisticsMarket = market.family === 'STATISTICS';
      const isTimelineFrequencyMarket = market.family === 'EVENTS' && market.model === 'COUNT_MODEL';
      if (market.pricingEnabled === false || isSportsStatisticsMarket || isTimelineFrequencyMarket || market.family === 'PLAYER') continue;
      if (!this.isMarketReady(market, context.readiness)) continue;
      const selections = expandCanonicalSelections(market, homeTeam, awayTeam);
      for (const selection of selections) {
        const probability = market.id === 'TEAM_TO_SCORE_FIRST' || market.id === 'TEAM_TO_SCORE_LAST'
          ? this.goalOrderProbability(context, market.id, selection.key, model.full)
          : this.scoreMarketProbability(market, selection, model.full, model.first, model.second);
        if (probability === null) continue;
        const periodQuality = market.model === 'PERIOD_MATRIX' && !model.observedPeriodSplit ? model.quality * 0.55 : model.quality;
        this.addPrice(out, market, selection, probability, periodQuality, model.sampleSize, this.scoreMethod(market));
      }
    }
  }

  private goalOrderProbability(
    context: OddsPricingContext,
    marketId: 'TEAM_TO_SCORE_FIRST' | 'TEAM_TO_SCORE_LAST',
    selectionKey: string,
    matrix: ScoreMatrix,
  ): number | null {
    const noGoal = this.matrixProbability(matrix.values, (home, away) => home === 0 && away === 0);
    if (selectionKey === 'NO_GOAL') return noGoal;
    if (selectionKey !== 'HOME' && selectionKey !== 'AWAY') return null;

    const homeMetrics = context.homeScoring?.metrics?.eventMetrics as Record<string, unknown> | undefined;
    const awayMetrics = context.awayScoring?.metrics?.eventMetrics as Record<string, unknown> | undefined;
    const coverageField = 'matchesWithTimeline';
    const rateField = marketId === 'TEAM_TO_SCORE_FIRST' ? 'firstGoalRate' : 'lastGoalRate';
    const homeCoverage = this.numberValue(homeMetrics?.[coverageField]) ?? 0;
    const awayCoverage = this.numberValue(awayMetrics?.[coverageField]) ?? 0;
    const homeRate = this.numberValue(homeMetrics?.[rateField]);
    const awayRate = this.numberValue(awayMetrics?.[rateField]);
    const modelShare = matrix.homeMean + matrix.awayMean > 0
      ? matrix.homeMean / (matrix.homeMean + matrix.awayMean)
      : 0.5;

    let homeShare = modelShare;
    if (
      homeCoverage >= ODDS_CONFIG.minimumEventTimelineSampleSize &&
      awayCoverage >= ODDS_CONFIG.minimumEventTimelineSampleSize &&
      homeRate !== null && awayRate !== null && homeRate >= 0 && awayRate >= 0 &&
      homeRate + awayRate > 0
    ) {
      const empiricalShare = homeRate / (homeRate + awayRate);
      const empiricalWeight = clamp(Math.min(homeCoverage, awayCoverage) / 20, 0.20, 0.45);
      homeShare = modelShare * (1 - empiricalWeight) + empiricalShare * empiricalWeight;
    }

    const scoredProbability = 1 - noGoal;
    return selectionKey === 'HOME'
      ? scoredProbability * homeShare
      : scoredProbability * (1 - homeShare);
  }

  private scoreMarketProbability(market: CanonicalMarketDefinition, selection: CanonicalExpandedSelection, full: ScoreMatrix, first: ScoreMatrix, second: ScoreMatrix): number | null {
    const key = selection.key;
    const result = (matrix: ScoreMatrix, selected: 'HOME' | 'DRAW' | 'AWAY') => this.matrixProbability(matrix.values, (h, a) => selected === 'HOME' ? h > a : selected === 'AWAY' ? a > h : h === a);
    const total = (matrix: ScoreMatrix, selected: (h: number, a: number) => boolean) => this.matrixProbability(matrix.values, selected);
    const staticProbability = (selected: string, yesProbability: number) => selected === 'YES' ? yesProbability : selected === 'NO' ? 1 - yesProbability : null;

    if (market.selectionMode === 'OVER_UNDER' && selection.line !== undefined) {
      const matrix = market.id === 'FIRST_HALF_TOTAL_GOALS' ? first
        : market.id === 'SECOND_HALF_TOTAL_GOALS' ? second
        : full;
      const over = selection.key.startsWith('OVER_');
      const target = (h: number, a: number): number =>
        market.id === 'HOME_TEAM_GOALS_OVER_UNDER' ? h
          : market.id === 'AWAY_TEAM_GOALS_OVER_UNDER' ? a
          : h + a;
      if (market.id === 'ASIAN_TOTAL_GOALS') {
        let win = 0;
        let loss = 0;
        for (let h = 0; h < matrix.values.length; h += 1) for (let a = 0; a < matrix.values[h].length; a += 1) {
          const goals = target(h, a);
          if (over ? goals > selection.line! : goals < selection.line!) win += matrix.values[h][a];
          else if (goals !== selection.line) loss += matrix.values[h][a];
        }
        return win + loss > 0 ? win / (win + loss) : null;
      }
      return this.matrixProbability(matrix.values, (h, a) => over
        ? target(h, a) > selection.line!
        : target(h, a) < selection.line!);
    }
    if (market.selectionMode === 'ASIAN_HANDICAP' && selection.handicap !== undefined && selection.side) {
      let win = 0; let loss = 0;
      for (let h = 0; h < full.values.length; h += 1) for (let a = 0; a < full.values[h].length; a += 1) {
        const difference = selection.side === 'HOME' ? h + selection.handicap - a : a + selection.handicap - h;
        const probability = full.values[h][a];
        if (difference > 0) win += probability; else if (difference < 0) loss += probability;
      }
      const decisive = win + loss;
      return decisive > 0 ? win / decisive : null;
    }
    if (market.selectionMode === 'EUROPEAN_HANDICAP' && selection.handicap !== undefined) {
      return this.matrixProbability(full.values, (home, away) => {
        const adjusted = home + selection.handicap!;
        const resultKey = adjusted > away ? 'HOME_WIN' : adjusted < away ? 'AWAY_WIN' : 'DRAW';
        return selection.key.startsWith(resultKey);
      });
    }

    switch (market.id) {
      case 'MATCH_RESULT':
      case 'CORNER_MATCH_RESULT':
        return key === 'HOME_WIN' ? result(full, 'HOME') : key === 'DRAW' ? result(full, 'DRAW') : key === 'AWAY_WIN' ? result(full, 'AWAY') : null;
      case 'DOUBLE_CHANCE':
        return key === 'HOME_OR_DRAW' ? result(full, 'HOME') + result(full, 'DRAW') : key === 'DRAW_OR_AWAY' ? result(full, 'DRAW') + result(full, 'AWAY') : key === 'HOME_OR_AWAY' ? result(full, 'HOME') + result(full, 'AWAY') : null;
      case 'FIRST_HALF_DOUBLE_CHANCE':
        return key === 'HOME_OR_DRAW' ? result(first, 'HOME') + result(first, 'DRAW') : key === 'DRAW_OR_AWAY' ? result(first, 'DRAW') + result(first, 'AWAY') : key === 'HOME_OR_AWAY' ? result(first, 'HOME') + result(first, 'AWAY') : null;
      case 'DRAW_NO_BET': {
        const homeWin = result(full, 'HOME');
        const awayWin = result(full, 'AWAY');
        const decisive = homeWin + awayWin;
        return decisive > 0 ? (key === 'HOME_DNB' ? homeWin / decisive : key === 'AWAY_DNB' ? awayWin / decisive : null) : null;
      }
      case 'BOTH_TEAMS_TO_SCORE':
        return staticProbability(key, total(full, (h, a) => h > 0 && a > 0));
      case 'BOTH_TEAMS_TO_SCORE_AND_RESULT': {
        const expectedResult = key.startsWith('HOME_') ? 'HOME' : key.startsWith('DRAW_') ? 'DRAW' : key.startsWith('AWAY_') ? 'AWAY' : null;
        const expectedBtts = key.endsWith('_YES') ? true : key.endsWith('_NO') ? false : null;
        if (!expectedResult || expectedBtts === null) return null;
        return total(full, (h, a) => {
          const actualResult = h > a ? 'HOME' : a > h ? 'AWAY' : 'DRAW';
          return actualResult === expectedResult && ((h > 0 && a > 0) === expectedBtts);
        });
      }
      case 'BOTH_TEAMS_TO_SCORE_AND_TOTAL_GOALS': {
        if (selection.line === undefined || !selection.side) return null;
        const expectedBtts = key.startsWith('YES_');
        return total(full, (h, a) => {
          const btts = h > 0 && a > 0;
          const goals = h + a;
          const lineOutcome = selection.side === 'OVER' ? goals > selection.line! : goals < selection.line!;
          return btts === expectedBtts && lineOutcome;
        });
      }
      case 'HOME_TEAM_TO_SCORE':
        return staticProbability(key, total(full, (h) => h > 0));
      case 'AWAY_TEAM_TO_SCORE':
        return staticProbability(key, total(full, (_h, a) => a > 0));
      case 'HOME_TEAM_CLEAN_SHEET':
        return staticProbability(key, total(full, (_h, a) => a === 0));
      case 'AWAY_TEAM_CLEAN_SHEET':
        return staticProbability(key, total(full, (h) => h === 0));
      case 'HOME_TEAM_TO_WIN_TO_NIL':
        return staticProbability(key, total(full, (h, a) => h > a && a === 0));
      case 'AWAY_TEAM_TO_WIN_TO_NIL':
        return staticProbability(key, total(full, (h, a) => a > h && h === 0));
      case 'TOTAL_GOALS_ODD_EVEN':
        return this.oddEvenProbability(full, key === 'ODD');
      case 'EXACT_TOTAL_GOALS': {
        const count = key === 'GOALS_6_PLUS' ? null : Number(key.replace('GOALS_', ''));
        return count === null ? total(full, (h, a) => h + a >= 6) : Number.isFinite(count) ? total(full, (h, a) => h + a === count) : null;
      }
      case 'TOTAL_GOALS_RANGE': {
        const match = key.match(/^GOALS_(\d+)_(\d+)$/);
        if (key === 'GOALS_6_PLUS') return total(full, (h, a) => h + a >= 6);
        if (!match) return null;
        const low = Number(match[1]); const high = Number(match[2]);
        return total(full, (h, a) => h + a >= low && h + a <= high);
      }
      case 'CORRECT_SCORE':
      case 'HALF_TIME_CORRECT_SCORE': {
        const matrix = market.id === 'HALF_TIME_CORRECT_SCORE' ? first : full;
        const max = market.id === 'HALF_TIME_CORRECT_SCORE' ? 3 : 5;
        if (selection.homeGoals !== undefined && selection.awayGoals !== undefined) return total(matrix, (h, a) => h === selection.homeGoals && a === selection.awayGoals);
        if (key === 'ANY_OTHER_HOME') return total(matrix, (h, a) => (h > max || a > max) && h > a);
        if (key === 'ANY_OTHER_DRAW') return total(matrix, (h, a) => (h > max || a > max) && h === a);
        if (key === 'ANY_OTHER_AWAY') return total(matrix, (h, a) => (h > max || a > max) && a > h);
        return null;
      }
      case 'WINNING_MARGIN': {
        if (key === 'DRAW') return result(full, 'DRAW');
        if (key.startsWith('HOME_BY_1')) return total(full, (h, a) => h - a === 1);
        if (key.startsWith('HOME_BY_2')) return total(full, (h, a) => h - a === 2);
        if (key.startsWith('HOME_BY_3')) return total(full, (h, a) => h - a >= 3);
        if (key.startsWith('AWAY_BY_1')) return total(full, (h, a) => a - h === 1);
        if (key.startsWith('AWAY_BY_2')) return total(full, (h, a) => a - h === 2);
        if (key.startsWith('AWAY_BY_3')) return total(full, (h, a) => a - h >= 3);
        return null;
      }
      case 'TEAM_TO_SCORE_FIRST':
      case 'TEAM_TO_SCORE_LAST': {
        const sum = full.homeMean + full.awayMean;
        const noGoal = total(full, (h, a) => h === 0 && a === 0);
        const scored = 1 - noGoal;
        const homeShare = sum > 0 ? full.homeMean / sum : 0.5;
        return key === 'HOME' ? scored * homeShare : key === 'AWAY' ? scored * (1 - homeShare) : key === 'NO_GOAL' ? noGoal : null;
      }
      case 'HALF_TIME_RESULT':
        return key === 'HOME_WIN' ? result(first, 'HOME') : key === 'DRAW' ? result(first, 'DRAW') : key === 'AWAY_WIN' ? result(first, 'AWAY') : null;
      case 'SECOND_HALF_RESULT':
        return key === 'HOME_WIN' ? result(second, 'HOME') : key === 'DRAW' ? result(second, 'DRAW') : key === 'AWAY_WIN' ? result(second, 'AWAY') : null;
      case 'HALF_TIME_GOALS_ODD_EVEN':
        return this.oddEvenProbability(first, key === 'ODD');
      case 'GOAL_IN_BOTH_HALVES': {
        const firstGoal = 1 - total(first, (h, a) => h === 0 && a === 0);
        const secondGoal = 1 - total(second, (h, a) => h === 0 && a === 0);
        return staticProbability(key, firstGoal * secondGoal);
      }
      case 'HOME_TEAM_TO_SCORE_IN_BOTH_HALVES': {
        const p = (1 - total(first, (h) => h === 0)) * (1 - total(second, (h) => h === 0));
        return staticProbability(key, p);
      }
      case 'AWAY_TEAM_TO_SCORE_IN_BOTH_HALVES': {
        const p = (1 - total(first, (_h, a) => a === 0)) * (1 - total(second, (_h, a) => a === 0));
        return staticProbability(key, p);
      }
      case 'BOTH_TEAMS_TO_SCORE_FIRST_HALF':
        return staticProbability(key, total(first, (h, a) => h > 0 && a > 0));
      case 'BOTH_TEAMS_TO_SCORE_SECOND_HALF':
        return staticProbability(key, total(second, (h, a) => h > 0 && a > 0));
      case 'MOST_GOALS_HALF': {
        const probabilities = this.comparePeriodMatrices(first, second);
        return key === 'FIRST_HALF' ? probabilities.first : key === 'SECOND_HALF' ? probabilities.second : key === 'EQUAL' ? probabilities.equal : null;
      }
      case 'HALF_TIME_FULL_TIME': {
        const ht = key.split('_')[0]; const ft = key.split('_')[1];
        if (!ht || !ft) return null;
        return this.jointHalfFullProbability(first, second, ht, ft);
      }
      default:
        return null;
    }
  }

  /**
   * Prices every enabled team-stat market from the actual statistic sample
   * stored by Sports. A missing metric or insufficient per-metric sample keeps
   * that market unpriced; unrelated available statistics are not substituted.
   */
  private priceStatMarkets(context: OddsPricingContext, out: Map<string, ModelSelectionPrice>): void {
    for (const market of FOOTBALL_MARKET_CATALOG) {
      if (
        market.pricingEnabled === false ||
        market.family !== 'STATISTICS' ||
        market.model !== 'COUNT_MODEL' ||
        !market.statisticKey ||
        !this.isMarketReady(market, context.readiness)
      ) continue;

      const input = this.countModelInputs(market, context);
      if (!input) continue;
      for (const selection of expandCanonicalSelections(market)) {
        let probability: number | null = null;
        if (market.selectionMode === 'OVER_UNDER' && selection.line !== undefined) {
          const mean = this.statisticScope(market.id) === 'HOME'
            ? input.home
            : this.statisticScope(market.id) === 'AWAY'
              ? input.away
              : input.total;
          probability = selection.key.startsWith('OVER_')
            ? this.poissonOver(mean, selection.line)
            : 1 - this.poissonOver(mean, selection.line);
        } else if (selection.key === 'ODD' || selection.key === 'EVEN') {
          probability = this.poissonOddProbability(input.total, selection.key === 'ODD');
        } else if (market.id === 'CORNER_MATCH_RESULT') {
          const matrix = this.scoreMatrix(input.home, input.away);
          probability = selection.key === 'HOME_WIN'
            ? this.matrixProbability(matrix.values, (home, away) => home > away)
            : selection.key === 'AWAY_WIN'
              ? this.matrixProbability(matrix.values, (home, away) => away > home)
              : selection.key === 'DRAW'
                ? this.matrixProbability(matrix.values, (home, away) => home === away)
                : null;
        }
        if (probability === null) continue;
        this.addPrice(
          out,
          market,
          selection,
          probability,
          input.dataQuality,
          input.sampleSize,
          'SPORTS_DERIVED_TEAM_STATISTICS_POISSON',
        );
      }
    }
  }

  /** Prices match-event markets only when Sports has sufficient Plays coverage. */
  private priceEventMarkets(context: OddsPricingContext, out: Map<string, ModelSelectionPrice>): void {
    const metrics = context.competitionScoring?.eventMetrics;
    if (!metrics) return;

    const coverage = this.numberValue(metrics.timelineCoverageMatches) ?? 0;
    const completedFixtures = context.competitionScoring?.fixturesPlayed ?? 0;
    const coverageRate = completedFixtures > 0 ? coverage / completedFixtures : 0;
    if (
      coverage < ODDS_CONFIG.minimumEventTimelineSampleSize ||
      coverageRate < ODDS_CONFIG.minimumEventTimelineCoverage
    ) return;

    const eventFields: Record<string, string> = {
      RED_CARD: 'redCardMatches',
      PENALTY_AWARDED: 'penaltyAwardedMatches',
      OWN_GOAL_SCORED: 'ownGoalMatches',
    };
    for (const market of FOOTBALL_MARKET_CATALOG) {
      if (
        market.pricingEnabled === false ||
        market.family !== 'EVENTS' ||
        market.model !== 'COUNT_MODEL' ||
        !this.isMarketReady(market, context.readiness)
      ) continue;
      const field = eventFields[market.id];
      if (!field) continue;
      const eventMatches = this.numberValue(metrics[field]);
      if (eventMatches === null || eventMatches < 0 || eventMatches > coverage) continue;

      // Jeffreys-style smoothing avoids an artificial 0% or 100% from a finite
      // event sample while retaining the observed Sports frequency.
      const yesProbability = clamp((eventMatches + 0.5) / (coverage + 1), 0.005, 0.995);
      const sampleSize = Math.floor(coverage);
      const quality = clamp(
        0.55 + 0.30 * Math.min(1, coverageRate) + 0.10 * Math.min(1, sampleSize / 20),
        0,
        0.95,
      );
      for (const selection of expandCanonicalSelections(market)) {
        const probability = selection.key === 'YES'
          ? yesProbability
          : selection.key === 'NO'
            ? 1 - yesProbability
            : null;
        if (probability === null) continue;
        this.addPrice(
          out,
          market,
          selection,
          probability,
          quality,
          sampleSize,
          'SPORTS_MATCH_TIMELINE_EVENT_FREQUENCY',
        );
      }
    }
  }

  private countModelInputs(market: CanonicalMarketDefinition, context: OddsPricingContext): CountModelInputs | null {
    const home = this.statAverage(context.homeStatistics, market.statisticKey);
    const away = this.statAverage(context.awayStatistics, market.statisticKey);
    if (!home || !away) return null;
    const sampleSize = Math.min(home.sampleSize, away.sampleSize);
    if (sampleSize < (market.minimumSampleSize ?? ODDS_CONFIG.minimumStatisticalSampleSize)) return null;

    const completedSamples = Math.min(
      context.homeStatistics?.fixturesWithStatistics ?? sampleSize,
      context.awayStatistics?.fixturesWithStatistics ?? sampleSize,
    );
    const dataQuality = clamp(
      0.48 + 0.38 * Math.min(1, sampleSize / 10) + 0.08 * Math.min(1, completedSamples / 10) + (context.competitionScoring ? 0.06 : 0),
      0,
      0.96,
    );
    return {
      home: home.average,
      away: away.average,
      total: home.average + away.average,
      sampleSize,
      dataQuality,
    };
  }

  private statisticScope(marketId: string): 'HOME' | 'AWAY' | 'TOTAL' {
    if (marketId.startsWith('HOME_')) return 'HOME';
    if (marketId.startsWith('AWAY_')) return 'AWAY';
    return 'TOTAL';
  }

  private statAverage(aggregate: SportsTeamStatisticsAggregateRecord | null, key?: string): StatisticEstimate | null {
    if (!aggregate || !key) return null;
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalizedKey === 'cards') {
      const yellow = this.findStatistic(aggregate, this.statAliases('yellowCards'));
      const red = this.findStatistic(aggregate, this.statAliases('redCards'));
      if (yellow && red) {
        return {
          average: yellow.average + red.average,
          sampleSize: Math.min(yellow.sampleSize, red.sampleSize),
        };
      }
      // An explicit total is acceptable; a single card colour is not a total.
      return this.findStatistic(aggregate, ['cards', 'totalcards']);
    }
    return this.findStatistic(aggregate, this.statAliases(key));
  }

  private findStatistic(aggregate: SportsTeamStatisticsAggregateRecord, keys: string[]): StatisticEstimate | null {
    const accepted = new Set(keys.map(normalizeKey));
    const stat = aggregate.statistics.find((item) =>
      accepted.has(normalizeKey(item.key)) || accepted.has(normalizeKey(item.name)) ||
      (item.category ? accepted.has(normalizeKey(item.category)) : false),
    );
    if (!stat || !Number.isFinite(stat.average) || stat.average < 0 || !Number.isFinite(stat.sampleSize) || stat.sampleSize < 1) return null;
    return { average: stat.average, sampleSize: Math.floor(stat.sampleSize) };
  }

  private statAliases(key: string): string[] {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const aliases: Record<string, string[]> = {
      corners: ['corners', 'woncorners', 'cornerkicks', 'cornerkickswon', 'totalcorners'],
      shots: ['shots', 'totalshots', 'shotsattempted'],
      shotsontarget: ['shotsontarget', 'shotsongoal', 'ontargetattempts'],
      cards: ['cards', 'yellowcards', 'redcards', 'totalcards'],
      yellowcards: ['yellowcards', 'yellowcard'],
      redcards: ['redcards', 'redcard'],
      fouls: ['fouls', 'foulscommitted', 'totalfouls'],
      offsides: ['offsides', 'offside'],
    };
    return aliases[normalizedKey] ?? [normalizeKey(key)];
  }

  private numberValue(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private addPrice(out: Map<string, ModelSelectionPrice>, market: CanonicalMarketDefinition, selection: CanonicalExpandedSelection, probability: number, quality: number, sampleSize: number, method: string): void {
    if (!Number.isFinite(probability)) return;

    // Do not persist speculative prices. A market is priced only when its own
    // minimum sample and the shared data-quality floor are both satisfied.
    const configuredMinimum = market.minimumSampleSize ?? (
      market.family === 'STATISTICS'
        ? ODDS_CONFIG.minimumStatisticalSampleSize
        : market.family === 'EVENTS'
          ? ODDS_CONFIG.minimumEventTimelineSampleSize
          : ODDS_CONFIG.minimumHistoricalSampleSize
    );
    const requiredSampleSize = Math.max(
      ODDS_CONFIG.minimumHistoricalSampleSize,
      configuredMinimum,
    );
    if (
      !Number.isFinite(sampleSize) ||
      sampleSize < requiredSampleSize ||
      !Number.isFinite(quality) ||
      quality < ODDS_CONFIG.minimumPredictionDataQuality
    ) return;

    const safeProbability = clamp(probability, ODDS_CONFIG.modelProbabilityFloor, ODDS_CONFIG.modelProbabilityCeiling);
    const fairOdds = round(1 / safeProbability, 4);
    if (!Number.isFinite(fairOdds) || fairOdds < 1.01 || fairOdds > ODDS_CONFIG.maximumDecimalOdds) return;
    const key = `${market.id}:${selection.key}:${selection.line ?? '-'}`;
    const dataQuality = round(quality, 4);
    out.set(key, {
      marketId: market.id,
      selectionKey: selection.key,
      ...(selection.line !== undefined ? { line: selection.line } : {}),
      fairProbability: round(safeProbability),
      fairOdds,
      dataQuality,
      sampleSize,
      calculationMethod: method,
      predictionReady: true,
    });
  }

  private scoreMethod(market: CanonicalMarketDefinition): string {
    return market.model === 'PERIOD_MATRIX'
      ? 'SPORTS_SCORE_MATRIX_PERIOD_SPLIT'
      : market.selectionMode === 'ASIAN_HANDICAP'
        ? 'SPORTS_SCORE_MATRIX_ASIAN_HANDICAP'
        : market.selectionMode === 'EUROPEAN_HANDICAP'
          ? 'SPORTS_SCORE_MATRIX_EUROPEAN_HANDICAP'
          : 'SPORTS_SCORE_MATRIX_POISSON';
  }

  private scoreMatrix(homeMean: number, awayMean: number): ScoreMatrix {
    const max = ODDS_CONFIG.maximumModelGoals;
    const home = Array.from({ length: max + 1 }, (_, goals) => this.poissonPmf(goals, homeMean));
    const away = Array.from({ length: max + 1 }, (_, goals) => this.poissonPmf(goals, awayMean));
    const values = home.map((homeProbability) => away.map((awayProbability) => homeProbability * awayProbability));
    const total = values.flat().reduce((sum, value) => sum + value, 0);
    if (total > 0) for (let h = 0; h < values.length; h += 1) for (let a = 0; a < values[h].length; a += 1) values[h][a] /= total;
    return { values, homeMean, awayMean };
  }

  private poissonPmf(k: number, mean: number): number {
    if (mean <= 0) return k === 0 ? 1 : 0;
    let factorial = 1;
    for (let i = 2; i <= k; i += 1) factorial *= i;
    return Math.exp(-mean) * mean ** k / factorial;
  }

  private poissonOver(mean: number, line: number): number {
    if (!Number.isFinite(mean) || mean < 0) return 0.5;
    const firstWinningCount = Math.floor(line) + 1;
    let cumulative = 0;
    for (let k = 0; k < firstWinningCount; k += 1) cumulative += this.poissonPmf(k, mean);
    return clamp(1 - cumulative, 0, 1);
  }

  private poissonOddProbability(mean: number, odd: boolean): number {
    const evenProbability = (1 + Math.exp(-2 * Math.max(0, mean))) / 2;
    return odd ? 1 - evenProbability : evenProbability;
  }

  private oddEvenProbability(matrix: ScoreMatrix, odd: boolean): number {
    const pOdd = this.matrixProbability(matrix.values, (h, a) => (h + a) % 2 === 1);
    return odd ? pOdd : 1 - pOdd;
  }

  private matrixProbability(matrix: number[][], predicate: (home: number, away: number) => boolean): number {
    let probability = 0;
    for (let home = 0; home < matrix.length; home += 1) for (let away = 0; away < matrix[home].length; away += 1) if (predicate(home, away)) probability += matrix[home][away];
    return clamp(probability, 0, 1);
  }

  private comparePeriodMatrices(first: ScoreMatrix, second: ScoreMatrix): { first: number; second: number; equal: number } {
    let firstWins = 0; let secondWins = 0; let equal = 0;
    for (let h1 = 0; h1 < first.values.length; h1 += 1) for (let a1 = 0; a1 < first.values[h1].length; a1 += 1) {
      const p1 = first.values[h1][a1]; const total1 = h1 + a1;
      for (let h2 = 0; h2 < second.values.length; h2 += 1) for (let a2 = 0; a2 < second.values[h2].length; a2 += 1) {
        const probability = p1 * second.values[h2][a2]; const total2 = h2 + a2;
        if (total1 > total2) firstWins += probability; else if (total2 > total1) secondWins += probability; else equal += probability;
      }
    }
    return { first: firstWins, second: secondWins, equal };
  }

  private jointHalfFullProbability(first: ScoreMatrix, second: ScoreMatrix, ht: string, ft: string): number {
    const token = (home: number, away: number): string => home > away ? 'HOME' : away > home ? 'AWAY' : 'DRAW';
    let probability = 0;
    for (let h1 = 0; h1 < first.values.length; h1 += 1) for (let a1 = 0; a1 < first.values[h1].length; a1 += 1) {
      if (token(h1, a1) !== ht) continue;
      for (let h2 = 0; h2 < second.values.length; h2 += 1) for (let a2 = 0; a2 < second.values[h2].length; a2 += 1) {
        if (token(h1 + h2, a1 + a2) === ft) probability += first.values[h1][a1] * second.values[h2][a2];
      }
    }
    return probability;
  }

  private valueOrUndefined(...values: Array<number | undefined>): number | undefined {
    return values.find((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  }

  private weightedMean(items: Array<{ value: number | undefined; weight: number }>): number | null {
    const valid = items.filter((item) => item.value !== undefined && Number.isFinite(item.value));
    if (!valid.length) return null;
    const weight = valid.reduce((sum, item) => sum + item.weight, 0);
    const mean = valid.reduce((sum, item) => sum + item.value! * item.weight, 0) / weight;
    return clamp(mean, 0.10, 5.0);
  }
}

