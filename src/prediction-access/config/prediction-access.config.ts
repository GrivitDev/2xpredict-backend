import { PredictionAccessPlan } from '../enums/prediction-access-plan.enum';
import { PREDICTION_ENGINE_CONFIG } from '../../predictions-engine/config/prediction-engine.config';
import { MarketFamily } from '../../predictions-engine/enums/market-family.enum';
import { FOOTBALL_MARKET_CATALOG } from '../../odds/catalog/football-market-catalog';

/**
 * Curated Visitor market allowance retained from the previous policy. Pick Center
 * now uses ranked per-fixture market limits defined below.
 */
const CURATED_VISITOR_MARKET_KEYS = [
  'SECOND_HALF_GOALS_OVER_UNDER',
  'BOTH_TEAMS_TO_SCORE_SECOND_HALF',
  'TOTAL_CORNERS_OVER_UNDER',
] as const;

/** Curated Free expands the Visitor set to fifteen market groups. */
const CURATED_FREE_MARKET_KEYS = [
  ...CURATED_VISITOR_MARKET_KEYS,
  'MATCH_RESULT',
  'DOUBLE_CHANCE',
  'GOALS_OVER_UNDER',
  'BOTH_TEAMS_TO_SCORE',
] as const;

/** Curated Regular expands the Free set to thirty-two market groups. */
const CURATED_REGULAR_MARKET_KEYS = [
  ...CURATED_FREE_MARKET_KEYS,
  'DRAW_NO_BET',
  'HOME_TEAM_GOALS_OVER_UNDER',
  'AWAY_TEAM_GOALS_OVER_UNDER',
  'HALF_TIME_RESULT',
  'SECOND_HALF_RESULT',
  'ASIAN_HANDICAP',
  'TOTAL_SHOTS_ON_TARGET_OVER_UNDER',
  'TOTAL_YELLOW_CARDS_OVER_UNDER',
  'TOTAL_FOULS_OVER_UNDER',
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

validateMarketTier('Curated Visitor', CURATED_VISITOR_MARKET_KEYS, 3);
validateMarketTier('Curated Free', CURATED_FREE_MARKET_KEYS, 7);
validateMarketTier('Curated Regular', CURATED_REGULAR_MARKET_KEYS, 16);

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
  /** Pick Center exposes the highest-ranked distinct market groups per fixture. */
  marketVisibility: {
    anonymous: { limit: 3, diversity: 'LIMITED' },
    free: { limit: 7, diversity: 'LIMITED' },
    regular: { limit: 16, diversity: 'EXPANDED' },
    vip: { limit: 48, diversity: 'FULL' },
    premium: { limit: null, diversity: 'FULL' },
  } satisfies Record<
    PredictionAccessPlan,
    { limit: number | null; diversity: 'LIMITED' | 'EXPANDED' | 'FULL' }
  >,
  /** Curated predictions retain their previous explicit market-key entitlements. */
  curatedMarketVisibility: {
    anonymous: {
      limit: 3,
      marketKeys: CURATED_VISITOR_MARKET_KEYS,
      families: [MarketFamily.PERIOD, MarketFamily.STATISTICS],
      diversity: 'LIMITED',
    },
    free: {
      limit: 7,
      marketKeys: CURATED_FREE_MARKET_KEYS,
      families: [
        MarketFamily.RESULT,
        MarketFamily.GOALS,
        MarketFamily.PERIOD,
        MarketFamily.STATISTICS,
      ],
      diversity: 'LIMITED',
    },
    regular: {
      limit: 16,
      marketKeys: CURATED_REGULAR_MARKET_KEYS,
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
    anonymous: 20,
    free: 30,
    regular: 60,
    vip: 95,
    premium: 100,
  } satisfies Record<PredictionAccessPlan, number>,
  /** Daily active Curated Prediction league allocation. */
  curatedLeagueVisibility: {
    anonymous: 2,
    free: 8,
    regular: 40,
    vip: 75,
    premium: 100,
  } satisfies Record<PredictionAccessPlan, number>,
  enabledMarketCount: ENABLED_PREDICTION_MARKET_KEYS.length,
  enabledMarketFamilyCount: ENABLED_MARKET_FAMILIES.length,
  slipProducts: {
    ODDS_10: { minOdds: 9, maxOdds: 10, requiredPlan: 'vip' },
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
        requiredPlan: 'premium',
      },
      SURE_7: {
        ...PREDICTION_ENGINE_CONFIG.slipCenter.sureOdds.products.SURE_7,
        requiredPlan: 'regular',
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
