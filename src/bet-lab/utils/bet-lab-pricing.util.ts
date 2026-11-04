export type BetLabPricingQuoteSelection = {
  code?: string;
  selectionCode?: string;
  decimalOdds?: number | null;
  odds?: number | null;
  line?: number | null;
  handicap?: number | null;
  available?: boolean;
  isStale?: boolean;
};

export type BetLabPricingMarket = {
  code?: string;
  marketCode?: string;
  selections?: BetLabPricingQuoteSelection[];
};

export type BetLabFixturePricingModel = {
  homeGoalMean: number;
  awayGoalMean: number;
  firstHalfShare: number;
  totalShotsMean: number;
  shotsOnTargetRate: number;
};

export type BetLabSelectionPricing = {
  fairProbability: number;
  marketMargin: number;
  model: BetLabFixturePricingModel;
};

export type BetLabPricingPick = {
  eventId: string;
  marketCode: string;
  selectionCode: string;
  odds: number;
  pricing?: BetLabSelectionPricing;
};

export type BetLabPricingGroup = 'MATCH';

export type BetLabFixturePricingAdjustment = {
  eventId: string;
  group: BetLabPricingGroup;
  factor: number;
};

export type BetLabSlipPricing = {
  combinedOdds: number;
  adjustments: BetLabFixturePricingAdjustment[];
};

type ScenarioOutcome = 'WIN' | 'PUSH' | 'LOSE';

type ScoreState = {
  home: number;
  away: number;
  halfHome: number;
  halfAway: number;
  weight: number;
};

type CountState = {
  total: number;
  onTarget: number;
  weight: number;
};

const EPSILON = 1e-10;
const SCORE_CEILING = 12;
const SHOTS_CEILING = 60;
const MAX_DECIMAL_ODDS = Number.MAX_SAFE_INTEGER;
const SCORE_MARKETS = new Set([
  'MATCH_RESULT',
  'DOUBLE_CHANCE',
  'DRAW_NO_BET',
  'TOTAL_GOALS_OVER_UNDER',
  'HOME_TEAM_GOALS_OVER_UNDER',
  'AWAY_TEAM_GOALS_OVER_UNDER',
  'ASIAN_HANDICAP',
  'BOTH_TEAMS_TO_SCORE',
  'FIRST_HALF_TOTAL_GOALS',
  'HALF_TIME_RESULT',
]);

function marketCodeOf(market: BetLabPricingMarket): string {
  return String(market.code ?? market.marketCode ?? '').toUpperCase();
}

function selectionCodeOf(selection: BetLabPricingQuoteSelection): string {
  return String(selection.code ?? selection.selectionCode ?? '').toUpperCase();
}

function oddsOf(selection: BetLabPricingQuoteSelection): number {
  const odds = Number(selection.decimalOdds ?? selection.odds);
  return Number.isFinite(odds) && odds > 1 ? odds : 0;
}

function usable(selection: BetLabPricingQuoteSelection): boolean {
  return selection.available !== false && selection.isStale !== true && oddsOf(selection) > 1;
}

function lineOf(selection: BetLabPricingQuoteSelection, code = selectionCodeOf(selection)): number | null {
  const explicit = Number(selection.line ?? selection.handicap);
  if (Number.isFinite(explicit)) return explicit;
  const match = code.match(/(?:OVER|UNDER)_((?:MINUS_)?\d+_\d+)|^(?:HOME|AWAY)_(MINUS_\d+_\d+|\d+_\d+)$/);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return null;
  const negative = raw.startsWith('MINUS_');
  const parsed = Number(raw.replace(/^MINUS_/, '').replace('_', '.'));
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : null;
}

function overUnderSide(code: string): 'OVER' | 'UNDER' | null {
  if (code.startsWith('OVER_')) return 'OVER';
  if (code.startsWith('UNDER_')) return 'UNDER';
  return null;
}

function normalizeProbabilities(
  selections: BetLabPricingQuoteSelection[],
): { probabilities: Map<string, number>; margin: number } | null {
  const eligible = selections.filter(usable);
  if (eligible.length < 2) return null;
  const inverse = eligible.map((selection) => 1 / oddsOf(selection));
  const total = inverse.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  const probabilities = new Map<string, number>();
  eligible.forEach((selection, index) => {
    probabilities.set(selectionCodeOf(selection), inverse[index] / total);
  });
  return { probabilities, margin: clamp(total, 1, 1.35) };
}

function staticMarketProbability(
  market: BetLabPricingMarket | undefined,
  selectionCode: string,
): { probability: number; margin: number } | null {
  if (!market?.selections) return null;
  const normalized = normalizeProbabilities(market.selections);
  if (!normalized) return null;
  const probability = normalized.probabilities.get(selectionCode.toUpperCase());
  return probability === undefined
    ? null
    : { probability, margin: normalized.margin };
}

function pairedMarketProbability(
  market: BetLabPricingMarket | undefined,
  selectionCode: string,
): { probability: number; margin: number } | null {
  if (!market?.selections) return null;
  const selected = market.selections.find((item) => selectionCodeOf(item) === selectionCode.toUpperCase());
  if (!selected || !usable(selected)) return null;

  const side = overUnderSide(selectionCode);
  if (side) {
    const line = lineOf(selected, selectionCode);
    if (line === null) return null;
    const counterpart = market.selections.find((item) =>
      overUnderSide(selectionCodeOf(item)) === (side === 'OVER' ? 'UNDER' : 'OVER')
      && Math.abs((lineOf(item) ?? Number.NaN) - line) < EPSILON
      && usable(item),
    );
    if (!counterpart) return null;
    const selectedInverse = 1 / oddsOf(selected);
    const otherInverse = 1 / oddsOf(counterpart);
    const margin = selectedInverse + otherInverse;
    return {
      probability: selectedInverse / margin,
      margin: clamp(margin, 1, 1.35),
    };
  }

  if (selectionCode.startsWith('HOME_') || selectionCode.startsWith('AWAY_')) {
    const line = lineOf(selected, selectionCode);
    if (line === null) return null;
    const counterpartSide = selectionCode.startsWith('HOME_') ? 'AWAY_' : 'HOME_';
    // The opposing Asian Handicap price uses the opposite signed line:
    // Home -1.5 is paired with Away +1.5, not Away -1.5.
    const counterpart = market.selections.find((item) =>
      selectionCodeOf(item).startsWith(counterpartSide)
      && Math.abs((lineOf(item) ?? Number.NaN) + line) < EPSILON
      && usable(item),
    );
    if (!counterpart) return null;
    const selectedInverse = 1 / oddsOf(selected);
    const otherInverse = 1 / oddsOf(counterpart);
    const margin = selectedInverse + otherInverse;
    return {
      probability: selectedInverse / margin,
      margin: clamp(margin, 1, 1.35),
    };
  }

  return staticMarketProbability(market, selectionCode);
}

function doubleChanceProbability(
  markets: BetLabPricingMarket[],
  selectionCode: string,
): { probability: number; margin: number } | null {
  const matchResult = markets.find((market) => marketCodeOf(market) === 'MATCH_RESULT');
  const result = staticMarketProbability(matchResult, 'HOME_WIN');
  const draw = staticMarketProbability(matchResult, 'DRAW');
  const away = staticMarketProbability(matchResult, 'AWAY_WIN');
  if (!result || !draw || !away) return null;

  const probabilityByCode = new Map<string, number>([
    ['HOME_WIN', result.probability],
    ['DRAW', draw.probability],
    ['AWAY_WIN', away.probability],
  ]);
  const pHome = probabilityByCode.get('HOME_WIN') ?? 0;
  const pDraw = probabilityByCode.get('DRAW') ?? 0;
  const pAway = probabilityByCode.get('AWAY_WIN') ?? 0;
  const dcProbability = selectionCode === 'HOME_OR_DRAW'
    ? pHome + pDraw
    : selectionCode === 'DRAW_OR_AWAY'
      ? pDraw + pAway
      : selectionCode === 'HOME_OR_AWAY'
        ? pHome + pAway
        : 0;
  const dcMarket = markets.find((market) => marketCodeOf(market) === 'DOUBLE_CHANCE');
  const dcPrices = dcMarket?.selections?.filter(usable) ?? [];
  const inverseTotal = dcPrices.reduce((sum, selection) => sum + 1 / oddsOf(selection), 0);
  return dcProbability > 0
    ? { probability: clamp(dcProbability, 0.001, 0.999), margin: clamp(inverseTotal / 2, 1, 1.35) }
    : null;
}

function marketProbabilityForSelection(
  markets: BetLabPricingMarket[],
  marketCode: string,
  selectionCode: string,
): { probability: number; margin: number } | null {
  const market = markets.find((item) => marketCodeOf(item) === marketCode.toUpperCase());
  if (marketCode.toUpperCase() === 'DOUBLE_CHANCE') {
    return doubleChanceProbability(markets, selectionCode.toUpperCase());
  }
  return pairedMarketProbability(market, selectionCode);
}

function getOverUnderPairs(
  markets: BetLabPricingMarket[],
  marketCode: string,
): Array<{ line: number; overProbability: number }> {
  const market = markets.find((item) => marketCodeOf(item) === marketCode.toUpperCase());
  if (!market?.selections) return [];
  const pairs: Array<{ line: number; overProbability: number }> = [];
  const lines = new Set<number>();

  for (const selection of market.selections) {
    if (!usable(selection)) continue;
    const side = overUnderSide(selectionCodeOf(selection));
    const line = lineOf(selection);
    if (side && line !== null) lines.add(line);
  }

  for (const line of [...lines].sort((a, b) => a - b)) {
    const over = market.selections.find((item) =>
      overUnderSide(selectionCodeOf(item)) === 'OVER'
      && Math.abs((lineOf(item) ?? Number.NaN) - line) < EPSILON
      && usable(item),
    );
    const under = market.selections.find((item) =>
      overUnderSide(selectionCodeOf(item)) === 'UNDER'
      && Math.abs((lineOf(item) ?? Number.NaN) - line) < EPSILON
      && usable(item),
    );
    if (!over || !under) continue;
    const overInverse = 1 / oddsOf(over);
    const underInverse = 1 / oddsOf(under);
    const total = overInverse + underInverse;
    if (total > 0) pairs.push({ line, overProbability: overInverse / total });
  }
  return pairs;
}

function fitPoissonMean(
  pairs: Array<{ line: number; overProbability: number }>,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (!pairs.length) return fallback;
  let bestMean = fallback;
  let bestError = Number.POSITIVE_INFINITY;
  const steps = 500;
  for (let index = 0; index <= steps; index += 1) {
    const mean = minimum + ((maximum - minimum) * index) / steps;
    const error = pairs.reduce((sum, pair) => {
      const predicted = poissonOverProbability(mean, pair.line);
      const delta = predicted - pair.overProbability;
      return sum + delta * delta;
    }, 0) / pairs.length;
    if (error < bestError) {
      bestError = error;
      bestMean = mean;
    }
  }
  return bestMean;
}

function estimateHomeShare(
  totalMean: number,
  markets: BetLabPricingMarket[],
): number {
  const market = markets.find((item) => marketCodeOf(item) === 'MATCH_RESULT');
  const result = normalizeProbabilities(market?.selections ?? []);
  if (!result) return 0.56;
  const pHome = result.probabilities.get('HOME_WIN');
  const pDraw = result.probabilities.get('DRAW');
  const pAway = result.probabilities.get('AWAY_WIN');
  if (pHome === undefined || pDraw === undefined || pAway === undefined) return 0.56;

  let bestShare = 0.56;
  let bestError = Number.POSITIVE_INFINITY;
  for (let share = 0.25; share <= 0.75001; share += 0.0025) {
    const probabilities = scoreResultProbabilities(totalMean * share, totalMean * (1 - share));
    const error = (probabilities.home - pHome) ** 2
      + (probabilities.draw - pDraw) ** 2
      + (probabilities.away - pAway) ** 2;
    if (error < bestError) {
      bestError = error;
      bestShare = share;
    }
  }
  return bestShare;
}

export function buildBetLabFixturePricingModel(
  marketRows: BetLabPricingMarket[],
): BetLabFixturePricingModel {
  const totalMean = fitPoissonMean(
    getOverUnderPairs(marketRows, 'TOTAL_GOALS_OVER_UNDER'),
    0.5,
    5.5,
    2.55,
  );
  const directHomeMean = fitPoissonMean(
    getOverUnderPairs(marketRows, 'HOME_TEAM_GOALS_OVER_UNDER'),
    0.1,
    4.2,
    Number.NaN,
  );
  const directAwayMean = fitPoissonMean(
    getOverUnderPairs(marketRows, 'AWAY_TEAM_GOALS_OVER_UNDER'),
    0.1,
    4.2,
    Number.NaN,
  );
  const homeAvailable = getOverUnderPairs(marketRows, 'HOME_TEAM_GOALS_OVER_UNDER').length > 0;
  const awayAvailable = getOverUnderPairs(marketRows, 'AWAY_TEAM_GOALS_OVER_UNDER').length > 0;
  const share = estimateHomeShare(totalMean, marketRows);

  let homeGoalMean = homeAvailable ? directHomeMean : totalMean * share;
  let awayGoalMean = awayAvailable ? directAwayMean : totalMean * (1 - share);
  if (homeAvailable && !awayAvailable) awayGoalMean = Math.max(0.15, totalMean - homeGoalMean);
  if (awayAvailable && !homeAvailable) homeGoalMean = Math.max(0.15, totalMean - awayGoalMean);
  if (!Number.isFinite(homeGoalMean) || homeGoalMean <= 0) homeGoalMean = 1.42;
  if (!Number.isFinite(awayGoalMean) || awayGoalMean <= 0) awayGoalMean = 1.13;

  const halfPairs = getOverUnderPairs(marketRows, 'FIRST_HALF_TOTAL_GOALS');
  const estimatedHalfMean = fitPoissonMean(
    halfPairs,
    0.1,
    Math.max(1.8, (homeGoalMean + awayGoalMean) * 0.7),
    (homeGoalMean + awayGoalMean) * 0.45,
  );
  const firstHalfShare = clamp(
    estimatedHalfMean / Math.max(0.1, homeGoalMean + awayGoalMean),
    0.25,
    0.65,
  );

  const totalShotsMean = fitPoissonMean(
    getOverUnderPairs(marketRows, 'TOTAL_SHOTS_OVER_UNDER'),
    8,
    38,
    22,
  );
  const shotsOnTargetPairs = getOverUnderPairs(marketRows, 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER');
  const shotsOnTargetRate = fitShotsOnTargetRate(totalShotsMean, shotsOnTargetPairs);

  return {
    homeGoalMean,
    awayGoalMean,
    firstHalfShare,
    totalShotsMean,
    shotsOnTargetRate,
  };
}

export function buildBetLabSelectionPricing(
  marketRows: BetLabPricingMarket[],
  marketCode: string,
  selectionCode: string,
  decimalOdds: number,
  model: BetLabFixturePricingModel = buildBetLabFixturePricingModel(marketRows),
): BetLabSelectionPricing {
  const quote = marketProbabilityForSelection(marketRows, marketCode, selectionCode);
  return {
    fairProbability: clamp(quote?.probability ?? 1 / decimalOdds, 0.001, 0.999),
    marketMargin: clamp(quote?.margin ?? 1, 1, 1.35),
    model,
  };
}

export function getBetLabPricingGroup(marketCode: string): BetLabPricingGroup | null {
  const normalized = marketCode.toUpperCase();
  if (
    SCORE_MARKETS.has(normalized)
    || normalized === 'TOTAL_SHOTS_OVER_UNDER'
    || normalized === 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER'
  ) return 'MATCH';
  return null;
}

/**
 * Calculates a full slip by fixture and by related market group.
 *
 * - Result/goal/half-time/handicap and shots/SOT picks from one fixture
 *   share a joint model (goals <= shots on target <= total shots).
 * - Other statistic markets have no deterministic dependency in the active
 *   catalogue and retain their individual market prices as independent legs.
 * - Separate fixtures always multiply independently.
 *
 * The adjustment factors are persisted by the backend so settlement returns
 *   the same price when every selection in a correlated group wins.
 */
export function calculateBetLabSlipPricing(
  picks: readonly BetLabPricingPick[],
): BetLabSlipPricing {
  if (!picks.length) return { combinedOdds: 1, adjustments: [] };

  const byFixture = new Map<string, BetLabPricingPick[]>();
  for (const pick of picks) {
    const group = byFixture.get(pick.eventId) ?? [];
    group.push(pick);
    byFixture.set(pick.eventId, group);
  }

  let combinedOdds = 1;
  const adjustments: BetLabFixturePricingAdjustment[] = [];

  for (const [eventId, fixturePicks] of byFixture) {
    const relatedPicks = fixturePicks.filter(
      (pick) => getBetLabPricingGroup(pick.marketCode) === 'MATCH',
    );
    const independentPicks = fixturePicks.filter(
      (pick) => getBetLabPricingGroup(pick.marketCode) === null,
    );

    if (relatedPicks.length > 1) {
      const baseOdds = productOfOdds(relatedPicks);
      const jointOdds = priceRelatedMatchCombination(relatedPicks);
      combinedOdds *= jointOdds;
      addAdjustment(adjustments, eventId, 'MATCH', jointOdds, baseOdds);
    } else if (relatedPicks.length === 1) {
      combinedOdds *= relatedPicks[0].odds;
    }

    // Corners, cards, fouls and offsides have no deterministic relationship
    // with the score/shots outcomes in the current canonical market catalogue.
    for (const pick of independentPicks) combinedOdds *= pick.odds;
  }

  return {
    combinedOdds: roundOdds(combinedOdds),
    adjustments,
  };
}

export function calculateBetLabCombinedOdds(picks: readonly BetLabPricingPick[]): number {
  return calculateBetLabSlipPricing(picks).combinedOdds;
}

function productOfOdds(picks: readonly BetLabPricingPick[]): number {
  return picks.reduce((product, pick) => product * pick.odds, 1);
}

function addAdjustment(
  adjustments: BetLabFixturePricingAdjustment[],
  eventId: string,
  group: BetLabPricingGroup,
  jointOdds: number,
  baseOdds: number,
): void {
  if (!Number.isFinite(jointOdds) || !Number.isFinite(baseOdds) || baseOdds <= 0) return;
  const factor = jointOdds / baseOdds;
  if (Number.isFinite(factor) && factor > 0) adjustments.push({ eventId, group, factor });
}

function priceRelatedMatchCombination(picks: readonly BetLabPricingPick[]): number {
  const model = picks.find((pick) => pick.pricing?.model)?.pricing?.model
    ?? buildBetLabFixturePricingModel([]);
  const scorePicks = picks.filter((pick) => SCORE_MARKETS.has(pick.marketCode.toUpperCase()));
  const shotPicks = picks.filter((pick) =>
    ['TOTAL_SHOTS_OVER_UNDER', 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER'].includes(pick.marketCode.toUpperCase()),
  );

  if (scorePicks.length && shotPicks.length) {
    return priceScoreAndShotsCombination(scorePicks, shotPicks, model);
  }
  if (scorePicks.length > 1) return priceScoreCombination(scorePicks);
  if (shotPicks.length > 1) return priceShotsCombination(shotPicks);
  return picks[0]?.odds ?? 1.01;
}

/**
 * Scorelines and shot counts are not independent: scored goals are shots on
 * target, and shots on target are a subset of total shots. This prices both
 * market families on one shared outcome space, conditioned on goals <= SOT.
 * The marginals are calibrated against the selected market prices first.
 */
function priceScoreAndShotsCombination(
  scorePicks: readonly BetLabPricingPick[],
  shotPicks: readonly BetLabPricingPick[],
  model: BetLabFixturePricingModel,
): number {
  const scoreStates = buildScoreStates(model);
  const scoreOutcomes = scorePicks.map((pick) =>
    scoreStates.map((state) => evaluateScorePick(pick, state)),
  );
  const shotStates = buildShotStates(model);
  const shotOutcomes = shotPicks.map((pick) =>
    shotStates.map((state) => evaluateShotsPick(pick, state)),
  );
  const { scoreWeights, shotWeights } = calibrateScoreAndShotWeights(
    scoreStates,
    scoreOutcomes,
    scorePicks.map((pick) => pick.pricing?.fairProbability ?? 1 / pick.odds),
    shotStates,
    shotOutcomes,
    shotPicks.map((pick) => pick.pricing?.fairProbability ?? 1 / pick.odds),
  );

  const maxGoals = SCORE_CEILING * 2;
  const maxShotsOnTarget = SHOTS_CEILING;
  const scoreMass = new Array<number>(maxGoals + 1).fill(0);
  const scorePassMass = new Array<number>(maxGoals + 1).fill(0);
  const scoreWinMass = new Array<number>(maxGoals + 1).fill(0);
  for (let index = 0; index < scoreStates.length; index += 1) {
    const state = scoreStates[index];
    const weight = scoreWeights[index];
    const goals = state.home + state.away;
    scoreMass[goals] += weight;

    let hasLoss = false;
    let hasWin = false;
    for (const outcomeSet of scoreOutcomes) {
      const outcome = outcomeSet[index];
      if (outcome === 'LOSE') { hasLoss = true; break; }
      if (outcome === 'WIN') hasWin = true;
    }
    if (!hasLoss) {
      scorePassMass[goals] += weight;
      if (hasWin) scoreWinMass[goals] += weight;
    }
  }

  const shotMass = new Array<number>(maxShotsOnTarget + 1).fill(0);
  const shotPassMass = new Array<number>(maxShotsOnTarget + 1).fill(0);
  const shotWinMass = new Array<number>(maxShotsOnTarget + 1).fill(0);
  for (let index = 0; index < shotStates.length; index += 1) {
    const state = shotStates[index];
    const weight = shotWeights[index];
    shotMass[state.onTarget] += weight;

    let hasLoss = false;
    let hasWin = false;
    for (const outcomeSet of shotOutcomes) {
      const outcome = outcomeSet[index];
      if (outcome === 'LOSE') { hasLoss = true; break; }
      if (outcome === 'WIN') hasWin = true;
    }
    if (!hasLoss) {
      shotPassMass[state.onTarget] += weight;
      if (hasWin) shotWinMass[state.onTarget] += weight;
    }
  }

  let physicallyPossibleMass = 0;
  let successfulMass = 0;
  for (let goals = 0; goals <= maxGoals; goals += 1) {
    if (scoreMass[goals] <= EPSILON) continue;
    for (let onTarget = goals; onTarget <= maxShotsOnTarget; onTarget += 1) {
      const physicalMass = scoreMass[goals] * shotMass[onTarget];
      if (physicalMass <= EPSILON) continue;
      physicallyPossibleMass += physicalMass;

      // A combined selection wins when none of its legs loses and at least
      // one leg wins. PUSH outcomes remain neutral.
      const scoreWin = scoreWinMass[goals];
      const scoreNeutral = Math.max(0, scorePassMass[goals] - scoreWin);
      const shotWin = shotWinMass[onTarget];
      successfulMass += scoreWin * shotPassMass[onTarget]
        + scoreNeutral * shotWin;
    }
  }

  const jointProbability = physicallyPossibleMass > EPSILON
    ? successfulMass / physicallyPossibleMass
    : 0;
  return priceFromJointProbability(jointProbability, [...scorePicks, ...shotPicks]);
}

function calibrateScoreAndShotWeights(
  scoreStates: readonly ScoreState[],
  scoreOutcomes: readonly ScenarioOutcome[][],
  scoreTargets: readonly number[],
  shotStates: readonly CountState[],
  shotOutcomes: readonly ScenarioOutcome[][],
  shotTargets: readonly number[],
): { scoreWeights: number[]; shotWeights: number[] } {
  const scoreWeights = scoreStates.map((state) => state.weight);
  const shotWeights = shotStates.map((state) => state.weight);
  normalizeWeights(scoreWeights);
  normalizeWeights(shotWeights);

  for (let iteration = 0; iteration < 100; iteration += 1) {
    let largestError = 0;

    // The chance of a valid shot outcome depends on the final goal total.
    const shotMassByCount = new Array<number>(SHOTS_CEILING + 1).fill(0);
    for (let index = 0; index < shotStates.length; index += 1) {
      shotMassByCount[shotStates[index].onTarget] += shotWeights[index];
    }
    const shotTail = new Array<number>(SHOTS_CEILING + 2).fill(0);
    for (let count = SHOTS_CEILING; count >= 0; count -= 1) {
      shotTail[count] = shotTail[count + 1] + shotMassByCount[count];
    }

    for (let pickIndex = 0; pickIndex < scoreOutcomes.length; pickIndex += 1) {
      let winMass = 0;
      let loseMass = 0;
      for (let stateIndex = 0; stateIndex < scoreStates.length; stateIndex += 1) {
        const goals = scoreStates[stateIndex].home + scoreStates[stateIndex].away;
        const mass = scoreWeights[stateIndex] * shotTail[Math.min(goals, SHOTS_CEILING + 1)];
        const outcome = scoreOutcomes[pickIndex][stateIndex];
        if (outcome === 'WIN') winMass += mass;
        else if (outcome === 'LOSE') loseMass += mass;
      }
      const decidedMass = winMass + loseMass;
      if (winMass <= EPSILON || loseMass <= EPSILON || decidedMass <= EPSILON) continue;
      const target = clamp(scoreTargets[pickIndex], 0.001, 0.999);
      const observed = winMass / decidedMass;
      largestError = Math.max(largestError, Math.abs(observed - target));
      const winFactor = (target * decidedMass) / winMass;
      const loseFactor = ((1 - target) * decidedMass) / loseMass;
      for (let stateIndex = 0; stateIndex < scoreWeights.length; stateIndex += 1) {
        const outcome = scoreOutcomes[pickIndex][stateIndex];
        if (outcome === 'WIN') scoreWeights[stateIndex] *= winFactor;
        else if (outcome === 'LOSE') scoreWeights[stateIndex] *= loseFactor;
      }
      normalizeWeights(scoreWeights);
    }

    // Conversely, the valid score mass for a given SOT count is the mass of
    // scorelines whose total goals do not exceed that count.
    const scoreMassByGoals = new Array<number>(SCORE_CEILING * 2 + 1).fill(0);
    for (let index = 0; index < scoreStates.length; index += 1) {
      const goals = scoreStates[index].home + scoreStates[index].away;
      scoreMassByGoals[goals] += scoreWeights[index];
    }
    const scorePrefixByShots = new Array<number>(SHOTS_CEILING + 1).fill(0);
    let prefix = 0;
    for (let count = 0; count <= SHOTS_CEILING; count += 1) {
      if (count < scoreMassByGoals.length) prefix += scoreMassByGoals[count];
      scorePrefixByShots[count] = prefix;
    }

    for (let pickIndex = 0; pickIndex < shotOutcomes.length; pickIndex += 1) {
      let winMass = 0;
      let loseMass = 0;
      for (let stateIndex = 0; stateIndex < shotStates.length; stateIndex += 1) {
        const mass = shotWeights[stateIndex] * scorePrefixByShots[shotStates[stateIndex].onTarget];
        const outcome = shotOutcomes[pickIndex][stateIndex];
        if (outcome === 'WIN') winMass += mass;
        else if (outcome === 'LOSE') loseMass += mass;
      }
      const decidedMass = winMass + loseMass;
      if (winMass <= EPSILON || loseMass <= EPSILON || decidedMass <= EPSILON) continue;
      const target = clamp(shotTargets[pickIndex], 0.001, 0.999);
      const observed = winMass / decidedMass;
      largestError = Math.max(largestError, Math.abs(observed - target));
      const winFactor = (target * decidedMass) / winMass;
      const loseFactor = ((1 - target) * decidedMass) / loseMass;
      for (let stateIndex = 0; stateIndex < shotWeights.length; stateIndex += 1) {
        const outcome = shotOutcomes[pickIndex][stateIndex];
        if (outcome === 'WIN') shotWeights[stateIndex] *= winFactor;
        else if (outcome === 'LOSE') shotWeights[stateIndex] *= loseFactor;
      }
      normalizeWeights(shotWeights);
    }

    if (largestError < 0.0005) break;
  }

  return { scoreWeights, shotWeights };
}

function normalizeWeights(weights: number[]): void {
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  for (let index = 0; index < weights.length; index += 1) weights[index] /= total;
}

function priceScoreCombination(picks: readonly BetLabPricingPick[]): number {
  const model = picks.find((pick) => pick.pricing?.model)?.pricing?.model
    ?? buildBetLabFixturePricingModel([]);
  const states = buildScoreStates(model);
  const outcomes = picks.map((pick) => states.map((state) => evaluateScorePick(pick, state)));
  const weights = calibrateScenarioWeights(
    states.map((state) => state.weight),
    outcomes,
    picks.map((pick) => pick.pricing?.fairProbability ?? 1 / pick.odds),
  );

  let successfulProbability = 0;
  for (let stateIndex = 0; stateIndex < states.length; stateIndex += 1) {
    let hasWin = false;
    let hasLoss = false;
    for (const outcomeSet of outcomes) {
      const outcome = outcomeSet[stateIndex];
      if (outcome === 'LOSE') { hasLoss = true; break; }
      if (outcome === 'WIN') hasWin = true;
    }
    if (!hasLoss && hasWin) successfulProbability += weights[stateIndex];
  }

  return priceFromJointProbability(successfulProbability, picks);
}

function priceShotsCombination(picks: readonly BetLabPricingPick[]): number {
  const model = picks.find((pick) => pick.pricing?.model)?.pricing?.model
    ?? buildBetLabFixturePricingModel([]);
  const states = buildShotStates(model);
  const outcomes = picks.map((pick) => states.map((state) => evaluateShotsPick(pick, state)));
  const weights = calibrateScenarioWeights(
    states.map((state) => state.weight),
    outcomes,
    picks.map((pick) => pick.pricing?.fairProbability ?? 1 / pick.odds),
  );

  let successfulProbability = 0;
  for (let index = 0; index < states.length; index += 1) {
    const allCanWin = outcomes.every((outcomeSet) => outcomeSet[index] !== 'LOSE');
    const hasWin = outcomes.some((outcomeSet) => outcomeSet[index] === 'WIN');
    if (allCanWin && hasWin) successfulProbability += weights[index];
  }
  return priceFromJointProbability(successfulProbability, picks);
}

function priceFromJointProbability(
  probability: number,
  picks: readonly BetLabPricingPick[],
): number {
  if (!Number.isFinite(probability) || probability <= EPSILON) {
    return MAX_DECIMAL_ODDS;
  }
  const margins = picks
    .map((pick) => Number(pick.pricing?.marketMargin ?? 1))
    .filter((value) => Number.isFinite(value) && value >= 1 && value <= 1.35);
  const margin = margins.length
    ? margins.reduce((sum, value) => sum + value, 0) / margins.length
    : 1;
  return roundOdds(clamp(1 / (probability * margin), 1.01, MAX_DECIMAL_ODDS));
}

function calibrateScenarioWeights(
  baseWeights: number[],
  outcomes: ScenarioOutcome[][],
  targets: number[],
): number[] {
  const weights = [...baseWeights];
  const normalizedTotal = weights.reduce((sum, value) => sum + value, 0) || 1;
  for (let index = 0; index < weights.length; index += 1) weights[index] /= normalizedTotal;

  for (let iteration = 0; iteration < 100; iteration += 1) {
    let largestError = 0;
    for (let pickIndex = 0; pickIndex < outcomes.length; pickIndex += 1) {
      const target = clamp(targets[pickIndex], 0.001, 0.999);
      const outcomeSet = outcomes[pickIndex];
      let winMass = 0;
      let loseMass = 0;
      for (let stateIndex = 0; stateIndex < weights.length; stateIndex += 1) {
        const outcome = outcomeSet[stateIndex];
        if (outcome === 'WIN') winMass += weights[stateIndex];
        else loseMass += weights[stateIndex];
      }

      const decidedMass = winMass + loseMass;
      if (winMass <= EPSILON || loseMass <= EPSILON || decidedMass <= EPSILON) continue;
      const observed = winMass / decidedMass;
      largestError = Math.max(largestError, Math.abs(observed - target));
      const desiredWin = target * decidedMass;
      const desiredLose = (1 - target) * decidedMass;
      const winFactor = desiredWin / winMass;
      const loseFactor = desiredLose / loseMass;

      for (let stateIndex = 0; stateIndex < weights.length; stateIndex += 1) {
        const outcome = outcomeSet[stateIndex];
        if (outcome === 'WIN') weights[stateIndex] *= winFactor;
        else if (outcome === 'LOSE') weights[stateIndex] *= loseFactor;
      }
    }
    if (largestError < 0.0005) break;
  }
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  return weights.map((value) => value / total);
}

function buildScoreStates(model: BetLabFixturePricingModel): ScoreState[] {
  const halfHomeMean = Math.max(0.05, model.homeGoalMean * model.firstHalfShare);
  const halfAwayMean = Math.max(0.05, model.awayGoalMean * model.firstHalfShare);
  const secondHomeMean = Math.max(0.05, model.homeGoalMean - halfHomeMean);
  const secondAwayMean = Math.max(0.05, model.awayGoalMean - halfAwayMean);
  const homeHalf = poissonTable(halfHomeMean, SCORE_CEILING);
  const awayHalf = poissonTable(halfAwayMean, SCORE_CEILING);
  const homeSecond = poissonTable(secondHomeMean, SCORE_CEILING);
  const awaySecond = poissonTable(secondAwayMean, SCORE_CEILING);
  const states: ScoreState[] = [];

  for (let home = 0; home <= SCORE_CEILING; home += 1) {
    for (let away = 0; away <= SCORE_CEILING; away += 1) {
      for (let halfHomeGoals = 0; halfHomeGoals <= home; halfHomeGoals += 1) {
        for (let halfAwayGoals = 0; halfAwayGoals <= away; halfAwayGoals += 1) {
          states.push({
            home,
            away,
            halfHome: halfHomeGoals,
            halfAway: halfAwayGoals,
            weight: homeHalf[halfHomeGoals] * homeSecond[home - halfHomeGoals]
              * awayHalf[halfAwayGoals] * awaySecond[away - halfAwayGoals],
          });
        }
      }
    }
  }

  const total = states.reduce((sum, state) => sum + state.weight, 0) || 1;
  for (const state of states) state.weight /= total;
  return states;
}

function buildShotStates(model: BetLabFixturePricingModel): CountState[] {
  const totalShots = poissonTable(model.totalShotsMean, SHOTS_CEILING);
  const states: CountState[] = [];
  for (let total = 0; total <= SHOTS_CEILING; total += 1) {
    const onTargetMean = clamp(model.shotsOnTargetRate, 0.05, 0.75);
    const binomial = binomialTable(total, onTargetMean);
    for (let onTarget = 0; onTarget <= total; onTarget += 1) {
      states.push({ total, onTarget, weight: totalShots[total] * binomial[onTarget] });
    }
  }
  const totalWeight = states.reduce((sum, state) => sum + state.weight, 0) || 1;
  for (const state of states) state.weight /= totalWeight;
  return states;
}

function evaluateScorePick(pick: BetLabPricingPick, state: ScoreState): ScenarioOutcome {
  const market = pick.marketCode.toUpperCase();
  const code = pick.selectionCode.toUpperCase();
  const line = parseLineFromCode(code);
  const home = state.home;
  const away = state.away;

  switch (market) {
    case 'MATCH_RESULT':
      return resultOf(home, away) === code ? 'WIN' : 'LOSE';
    case 'HALF_TIME_RESULT':
      return resultOf(state.halfHome, state.halfAway) === code ? 'WIN' : 'LOSE';
    case 'DOUBLE_CHANCE': {
      const result = resultOf(home, away);
      if (code === 'HOME_OR_DRAW') return result !== 'AWAY_WIN' ? 'WIN' : 'LOSE';
      if (code === 'DRAW_OR_AWAY') return result !== 'HOME_WIN' ? 'WIN' : 'LOSE';
      if (code === 'HOME_OR_AWAY') return result !== 'DRAW' ? 'WIN' : 'LOSE';
      return 'LOSE';
    }
    case 'DRAW_NO_BET':
      if (home === away) return 'PUSH';
      if (code === 'HOME_DNB') return home > away ? 'WIN' : 'LOSE';
      if (code === 'AWAY_DNB') return away > home ? 'WIN' : 'LOSE';
      return 'LOSE';
    case 'BOTH_TEAMS_TO_SCORE': {
      const both = home > 0 && away > 0;
      if (code === 'YES') return both ? 'WIN' : 'LOSE';
      if (code === 'NO') return both ? 'LOSE' : 'WIN';
      return 'LOSE';
    }
    case 'TOTAL_GOALS_OVER_UNDER':
      return overUnderResult(code, line, home + away);
    case 'HOME_TEAM_GOALS_OVER_UNDER':
      return overUnderResult(code, line, home);
    case 'AWAY_TEAM_GOALS_OVER_UNDER':
      return overUnderResult(code, line, away);
    case 'FIRST_HALF_TOTAL_GOALS':
      return overUnderResult(code, line, state.halfHome + state.halfAway);
    case 'ASIAN_HANDICAP':
      if (line === null) return 'LOSE';
      if (code.startsWith('HOME_')) return compareWithPush(home + line, away);
      if (code.startsWith('AWAY_')) return compareWithPush(away + line, home);
      return 'LOSE';
    default:
      return 'LOSE';
  }
}

function evaluateShotsPick(pick: BetLabPricingPick, state: CountState): ScenarioOutcome {
  const value = pick.marketCode.toUpperCase() === 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER'
    ? state.onTarget
    : state.total;
  return overUnderResult(pick.selectionCode.toUpperCase(), parseLineFromCode(pick.selectionCode), value);
}

function parseLineFromCode(code: string): number | null {
  const match = code.toUpperCase().match(/(?:OVER|UNDER)_((?:MINUS_)?\d+_\d+)|^(?:HOME|AWAY)_(MINUS_\d+_\d+|\d+_\d+)$/);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return null;
  const negative = raw.startsWith('MINUS_');
  const line = Number(raw.replace(/^MINUS_/, '').replace('_', '.'));
  return Number.isFinite(line) ? (negative ? -line : line) : null;
}

function overUnderResult(code: string, line: number | null, value: number): ScenarioOutcome {
  if (line === null) return 'LOSE';
  if (code.startsWith('OVER_')) return compareWithPush(value, line);
  if (code.startsWith('UNDER_')) return compareWithPush(line, value);
  return 'LOSE';
}

function compareWithPush(left: number, right: number): ScenarioOutcome {
  if (Math.abs(left - right) <= EPSILON) return 'PUSH';
  return left > right ? 'WIN' : 'LOSE';
}

function resultOf(home: number, away: number): 'HOME_WIN' | 'DRAW' | 'AWAY_WIN' {
  if (home > away) return 'HOME_WIN';
  if (home < away) return 'AWAY_WIN';
  return 'DRAW';
}

function poissonTable(mean: number, maximum: number): number[] {
  const lambda = Math.max(0.001, mean);
  const probabilities = new Array<number>(maximum + 1).fill(0);
  probabilities[0] = Math.exp(-lambda);
  for (let count = 1; count <= maximum; count += 1) {
    probabilities[count] = probabilities[count - 1] * lambda / count;
  }
  return probabilities;
}

function poissonOverProbability(mean: number, line: number): number {
  const cutoff = Math.max(0, Math.floor(line));
  const probabilities = poissonTable(mean, Math.max(24, cutoff + 8));
  let cumulative = 0;
  for (let count = 0; count <= cutoff; count += 1) cumulative += probabilities[count];
  return clamp(1 - cumulative, 0, 1);
}

function scoreResultProbabilities(homeMean: number, awayMean: number): {
  home: number;
  draw: number;
  away: number;
} {
  const home = poissonTable(homeMean, SCORE_CEILING);
  const away = poissonTable(awayMean, SCORE_CEILING);
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let total = 0;
  for (let h = 0; h <= SCORE_CEILING; h += 1) {
    for (let a = 0; a <= SCORE_CEILING; a += 1) {
      const probability = home[h] * away[a];
      total += probability;
      if (h > a) homeWin += probability;
      else if (h === a) draw += probability;
      else awayWin += probability;
    }
  }
  const denominator = total || 1;
  return { home: homeWin / denominator, draw: draw / denominator, away: awayWin / denominator };
}

function fitShotsOnTargetRate(
  totalShotsMean: number,
  pairs: Array<{ line: number; overProbability: number }>,
): number {
  if (!pairs.length) return 0.34;
  const totalDistribution = poissonTable(totalShotsMean, SHOTS_CEILING);
  let bestRate = 0.34;
  let bestError = Number.POSITIVE_INFINITY;
  for (let rate = 0.1; rate <= 0.70001; rate += 0.0025) {
    let error = 0;
    for (const pair of pairs) {
      const threshold = Math.floor(pair.line) + 1;
      let predicted = 0;
      for (let total = 0; total <= SHOTS_CEILING; total += 1) {
        const binomial = binomialTailProbability(total, rate, threshold);
        predicted += totalDistribution[total] * binomial;
      }
      error += (predicted - pair.overProbability) ** 2;
    }
    error /= pairs.length;
    if (error < bestError) {
      bestError = error;
      bestRate = rate;
    }
  }
  return bestRate;
}

function binomialTable(trials: number, probability: number): number[] {
  if (trials === 0) return [1];
  const p = clamp(probability, 0.0001, 0.9999);
  const values = new Array<number>(trials + 1).fill(0);
  values[0] = (1 - p) ** trials;
  for (let success = 1; success <= trials; success += 1) {
    values[success] = values[success - 1]
      * ((trials - success + 1) / success)
      * (p / (1 - p));
  }
  return values;
}

function binomialTailProbability(trials: number, probability: number, threshold: number): number {
  if (threshold <= 0) return 1;
  if (threshold > trials) return 0;
  const probabilities = binomialTable(trials, probability);
  let cumulative = 0;
  for (let count = 0; count < threshold; count += 1) cumulative += probabilities[count];
  return clamp(1 - cumulative, 0, 1);
}

function roundOdds(value: number): number {
  if (Number.isNaN(value) || value <= 1) return 1.01;
  if (!Number.isFinite(value) || value > MAX_DECIMAL_ODDS) return Number.POSITIVE_INFINITY;
  return Math.round(value * 10_000) / 10_000;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
