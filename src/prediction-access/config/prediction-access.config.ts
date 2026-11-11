import { PredictionAccessPlan } from '../enums/prediction-access-plan.enum';
import { PREDICTION_ENGINE_CONFIG } from '../../predictions-engine/config/prediction-engine.config';
import { MarketFamily } from '../../predictions-engine/enums/market-family.enum';
import { FOOTBALL_MARKET_CATALOG } from '../../odds/catalog/football-market-catalog';

/**
 * Visitor market allowance: seven useful, less-prominent markets across two
 * market families. The count refers to canonical market groups, not outcomes.
 */
const VISITOR_MARKET_KEYS = [
  'FIRST_HALF_GOALS_OVER_UNDER',
  'SECOND_HALF_GOALS_OVER_UNDER',
  'BOTH_TEAMS_TO_SCORE_FIRST_HALF',
  'BOTH_TEAMS_TO_SCORE_SECOND_HALF',
  'TOTAL_CORNERS_OVER_UNDER',
  'HOME_TEAM_CORNERS_OVER_UNDER',
  'AWAY_TEAM_CORNERS_OVER_UNDER',
] as const;

/** Free expands the Visitor set to fifteen market groups. */
const FREE_MARKET_KEYS = [
  ...VISITOR_MARKET_KEYS,
  'MATCH_RESULT',
  'DOUBLE_CHANCE',
  'GOALS_OVER_UNDER',
  'BOTH_TEAMS_TO_SCORE',
  'HOME_TEAM_TO_SCORE',
  'AWAY_TEAM_TO_SCORE',
  'TOTAL_CARDS_OVER_UNDER',
  'TOTAL_SHOTS_OVER_UNDER',
] as const;

/** Regular expands the Free set to thirty-two market groups. */
const REGULAR_MARKET_KEYS = [
  ...FREE_MARKET_KEYS,
  'DRAW_NO_BET',
  'HOME_TEAM_GOALS_OVER_UNDER',
  'AWAY_TEAM_GOALS_OVER_UNDER',
  'HALF_TIME_RESULT',
  'SECOND_HALF_RESULT',
  'ASIAN_HANDICAP',
  'TOTAL_SHOTS_ON_TARGET_OVER_UNDER',
  'TOTAL_YELLOW_CARDS_OVER_UNDER',
  'TOTAL_FOULS_OVER_UNDER',
  'TOTAL_OFFSIDES_OVER_UNDER',
  'ASIAN_TOTAL_GOALS',
  'ODD_EVEN_TOTAL_GOALS',
  'EXACT_TOTAL_GOALS',
  'HOME_TEAM_CLEAN_SHEET',
  'AWAY_TEAM_CLEAN_SHEET',
  'HOME_TEAM_CARDS_OVER_UNDER',
  'TOTAL_RED_CARDS_OVER_UNDER',
] as const;

/** Only priceable canonical market groups can be exposed to active predictions. */
export const ENABLED_PREDICTION_MARKET_KEYS: readonly string[] = Object.freeze([
  ...new Set(
    FOOTBALL_MARKET_CATALOG.filter(
      (market) => market.pricingEnabled !== false,
    ).map((market) => market.predictionMarketKey),
  ),
]);

const ENABLED_MARKET_SET = new Set(ENABLED_PREDICTION_MARKET_KEYS);
const validateMarketTier = (
  name: string,
  keys: readonly string[],
  expected: number,
): void => {
  if (new Set(keys).size !== expected) {
    throw new Error(
      `${name} prediction market tier must contain exactly ${expected} unique markets.`,
    );
  }
  for (const marketKey of keys) {
    if (!ENABLED_MARKET_SET.has(marketKey)) {
      throw new Error(
        `Prediction access market policy references a non-priceable canonical market: ${marketKey}`,
      );
    }
  }
};

validateMarketTier('Visitor', VISITOR_MARKET_KEYS, 7);
validateMarketTier('Free', FREE_MARKET_KEYS, 15);
validateMarketTier('Regular', REGULAR_MARKET_KEYS, 32);

export const PREDICTION_MARKET_FAMILY_BY_KEY: ReadonlyMap<
  string,
  MarketFamily
> = new Map(
  FOOTBALL_MARKET_CATALOG.filter(
    (market) => market.pricingEnabled !== false,
  ).map((market) => [
    market.predictionMarketKey,
    market.family as MarketFamily,
  ]),
);

const ENABLED_MARKET_FAMILIES = Object.freeze([
  ...new Set(PREDICTION_MARKET_FAMILY_BY_KEY.values()),
]);

/**
 * Single source of truth for Prediction Engine visibility and subscription
 * entitlements. Market counts are catalogue-group limits, not daily quotas.
 * League percentages are applied to leagues with published active predictions
 * per Africa/Lagos fixture date, never to every competition in the Sports DB.
 */
export const PREDICTION_ACCESS_CONFIG = {
  publicSettledPredictions: true,
  marketPageSize: 25,
  maximumMarketPageSize: 100,
  /** Operational query safeguard, not a per-user/day product quota. */
  maximumPickCenterMatches: 1000,
  marketVisibility: {
    anonymous: {
      limit: 7,
      marketKeys: VISITOR_MARKET_KEYS,
      families: [MarketFamily.PERIOD, MarketFamily.STATISTICS],
      diversity: 'LIMITED',
    },
    free: {
      limit: 15,
      marketKeys: FREE_MARKET_KEYS,
      families: [
        MarketFamily.RESULT,
        MarketFamily.GOALS,
        MarketFamily.PERIOD,
        MarketFamily.STATISTICS,
      ],
      diversity: 'LIMITED',
    },
    regular: {
      limit: 32,
      marketKeys: REGULAR_MARKET_KEYS,
      families: [
        MarketFamily.RESULT,
        MarketFamily.GOALS,
        MarketFamily.PERIOD,
        MarketFamily.STATISTICS,
        MarketFamily.HANDICAP,
        MarketFamily.EVENTS,
      ],
      diversity: 'EXPANDED',
    },
    vip: {
      limit: null,
      marketKeys: ENABLED_PREDICTION_MARKET_KEYS,
      families: ENABLED_MARKET_FAMILIES,
      diversity: 'FULL',
    },
    premium: {
      limit: null,
      marketKeys: ENABLED_PREDICTION_MARKET_KEYS,
      families: ENABLED_MARKET_FAMILIES,
      diversity: 'FULL',
    },
  } satisfies Record<
    PredictionAccessPlan,
    {
      limit: number | null;
      marketKeys: readonly string[];
      families: readonly MarketFamily[];
      diversity: 'LIMITED' | 'EXPANDED' | 'FULL';
    }
  >,
  /**
   * Daily league access. A date's denominator is the count of distinct leagues
   * with active Prediction Center picks on that date. The allocation is stable
   * for the day and nested across plans.
   */
  leagueVisibility: {
    anonymous: 10,
    free: 20,
    regular: 60,
    vip: 85,
    premium: 100,
  } satisfies Record<PredictionAccessPlan, number>,
  /** Curated picks are locked for Visitor/Free and proportionally allocated for paid tiers. */
  curatedLeagueVisibility: {
    anonymous: 0,
    free: 0,
    regular: 60,
    vip: 85,
    premium: 100,
  } satisfies Record<PredictionAccessPlan, number>,
  enabledMarketCount: ENABLED_PREDICTION_MARKET_KEYS.length,
  enabledMarketFamilyCount: ENABLED_MARKET_FAMILIES.length,
  slipProducts: {
    // All standard combined-odds products are Premium-only.
    ODDS_10: { minOdds: 9, maxOdds: 10, requiredPlan: 'premium' },
    ODDS_25: { minOdds: 23, maxOdds: 25, requiredPlan: 'premium' },
    ODDS_50: { minOdds: 48, maxOdds: 50, requiredPlan: 'premium' },
  } as const,
  sureOdds: {
    vipDailyTarget: PREDICTION_ENGINE_CONFIG.slipCenter.sureOdds.vipDailyTarget,
    premiumDailyTarget:
      PREDICTION_ENGINE_CONFIG.slipCenter.sureOdds.premiumDailyTarget,
    products: {
      SURE_2: {
        ...PREDICTION_ENGINE_CONFIG.slipCenter.sureOdds.products.SURE_2,
        requiredPlan: 'regular',
      },
      SURE_5: {
        ...PREDICTION_ENGINE_CONFIG.slipCenter.sureOdds.products.SURE_5,
        requiredPlan: 'vip',
      },
      SURE_7: {
        ...PREDICTION_ENGINE_CONFIG.slipCenter.sureOdds.products.SURE_7,
        requiredPlan: 'vip',
      },
    },
    // Compatibility values for older callers; product-specific ranges are authoritative.
    vipMinimumCombinedOdds:
      PREDICTION_ENGINE_CONFIG.slipCenter.sureOdds.products.SURE_2.minOdds,
    vipMaximumCombinedOdds:
      PREDICTION_ENGINE_CONFIG.slipCenter.sureOdds.products.SURE_2.maxOdds,
    premiumMinimumCombinedOdds:
      PREDICTION_ENGINE_CONFIG.slipCenter.sureOdds.products.SURE_5.minOdds,
    premiumMaximumCombinedOdds:
      PREDICTION_ENGINE_CONFIG.slipCenter.sureOdds.products.SURE_7.maxOdds,
    minimumProbability:
      PREDICTION_ENGINE_CONFIG.slipCenter.sureOdds.minimumProbability,
    minimumConfidence:
      PREDICTION_ENGINE_CONFIG.slipCenter.sureOdds.minimumConfidence,
  },
  planRank: {
    anonymous: 0,
    free: 1,
    regular: 2,
    vip: 3,
    premium: 4,
  } satisfies Record<PredictionAccessPlan, number>,
} as const;
