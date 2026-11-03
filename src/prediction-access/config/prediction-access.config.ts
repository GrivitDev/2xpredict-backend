import { CompetitionPriority } from '../../sports/enums/competition-priority.enum';
import { PredictionAccessPlan } from '../enums/prediction-access-plan.enum';
import { PREDICTION_ENGINE_CONFIG } from '../../predictions-engine/config/prediction-engine.config';

/**
 * Single source of truth for Prediction Engine visibility and subscription entitlements.
 * Counts and lock metadata are public; prediction and slip contents remain protected.
 */
export const PREDICTION_ACCESS_CONFIG = {
  publicSettledPredictions: true,
  anonymousActivePriorities: ['SELECTIVE', 'HIGH'] as const,
  /** Free members can read every priority category except REGIONAL. */
  freeActivePriorities: [
    CompetitionPriority.ELITE,
    CompetitionPriority.HIGH,
    CompetitionPriority.SELECTIVE,
  ] as const,
  freeActiveAccess: 'ALL_SUPPORTED_EXCEPT_REGIONAL_PRIORITY' as const,
  /** Regular members can read curated picks except those explicitly classified as Selective. */
  regularCuratedExcludedCategories: ['SELECTIVE'] as const,
  paidActiveAccess: 'ALL_SUPPORTED_COMPETITIONS' as const,
  selectablePriority: CompetitionPriority.SELECTIVE,
  marketPageSize: 25,
  maximumMarketPageSize: 100,
  /** Operational query safeguard, not a per-user/day product quota. */
  maximumPickCenterMatches: 1000,
  slipProducts: {
    // All standard combined-odds products are Premium-only.
    ODDS_10: {
      minOdds: 9,
      maxOdds: 10,
      requiredPlan: 'premium',
    },
    ODDS_25: {
      minOdds: 23,
      maxOdds: 25,
      requiredPlan: 'premium',
    },
    ODDS_50: {
      minOdds: 48,
      maxOdds: 50,
      requiredPlan: 'premium',
    },
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

