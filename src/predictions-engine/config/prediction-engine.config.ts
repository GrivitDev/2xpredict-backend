export const PREDICTION_ENGINE_CONFIG = {
  enabled: true,
  modelVersion: '2XP-FOOTBALL-2.3.0',
  queue: {
    /** Full fixture queue reconciliation is periodic; event-driven triggers may enqueue earlier. */
    syncIntervalMs: 10 * 60_000,
    /** Drain one available prediction job on each two-minute worker tick. */
    workerIntervalMs: 2 * 60_000,
    /** Two workers improve throughput without flooding the database or providers. */
    workerConcurrency: 2,
    /** Recalculate unchanged upcoming fixtures periodically so queues do not stay idle indefinitely. */
    completedRefreshIntervalMs: 2 * 60 * 60 * 1000,
    /** Retry exhausted jobs after a cooldown, even if source timestamps did not change. */
    failedRecoveryIntervalMs: 30 * 60 * 1000,
    /** Market-engine fixtures are forecast within a rolling 72-hour kickoff window. */
    forwardWindowHours: 72,
    maxAttempts: 4,
    retryBaseMs: 30_000,
    maxRetryMs: 10 * 60_000,
    staleProcessingMs: 10 * 60_000,
    batchSize: 100,
  },
  model: {
    maxGoals: 8,
    minimumHistoricalMatchesPerTeam: 3,
    historicalMatchesPerTeam: 7,
    recentFormMatchesPerTeam: 5,
    maximumHeadToHeadMatches: 10,
    leagueMatches: 120,
    /** Pseudo-match count used to shrink small league samples toward default goal averages. */
    leaguePriorMatches: 12,
    firstHalfGoalShare: 0.45,
    /** Provider prices are a modest prior, never a substitute for the statistical model. */
    oddsBlendWeight: 0.25,
    maximumConfidence: 98,
    defaultLeagueHomeGoals: 1.45,
    defaultLeagueAwayGoals: 1.15,
    minimumExpectedGoals: 0.15,
    maximumExpectedGoals: 4.25,
    sourceSummaryStaleHours: 48,
  },
  selectionEligibility: {
    /** Broad input-sanity bounds only; do not use these as betting-price bands. */
    // Technical validity bounds only. These are not betting-odds bands:
    // priced selections below 1.20 or above 5.00 still get calculated.
    minimumDecimalOdds: 1.02,
    maximumDecimalOdds: 1000,
    minimumFairOdds: 1.02,
    maximumFairOdds: 1000,
    minimumProbability: 0.11,
    maximumProbability: 0.98222,
    /** Product/ranking reference values only; they do not block base market predictions. */
    minimumExpectedValue: 0.02,
    minimumConfidence: 50,
    minimumDataQuality: 0.5,
  },
  calibration: {
    minimumSettledSamples: 30,
    /** Refit from newly settled results at most every six hours per active model version. */
    refreshIntervalMs: 6 * 60 * 60 * 1000,
    /** Strong enough to correct demonstrated bias while retaining shrinkage for limited samples. */
    maximumCorrectionBlendWeight: 0.8,
  },
  curatedPredictions: {
    enabled: true,
    /** Publish curated recommendations only during the final 48 hours before kickoff, plus live fixtures. */
    horizonHours: 48,
    /** Curated product refresh is deliberately paced to ten minutes. */
    refreshIntervalMs: 10 * 60_000,
    minimumSelectionsPerMatch: 1,
    maximumSelectionsPerMatch: 3,
    minimumProbability: 0.4,
    minimumConfidence: 60,
    /** Data quality and safety/ranking scores inform ordering; they do not reject a priced selection. */
    minimumDataQuality: 0,
    minimumSafetyScore: 0,
  },
  pickCenter: {
    enabled: true,
    /** Reconcile Pick Center independently of market worker success, on a ten-minute cadence. */
    refreshIntervalMs: 10 * 60_000,
    refreshBatchSize: 20,
    minimumMarketsPerMatch: 2,
    minimumConfidence: 0,
    minimumDataQuality: 0,
    requireProviderOdds: true,
    minimumExpectedValue: -1,
    excludedMarketKeys: [] as string[],
    excludedMarketFamilies: [] as string[],
    oneSelectionPerMarket: true,
    marketPriority: [
      'MATCH_RESULT',
      'BOTH_TEAMS_TO_SCORE',
      'DRAW_NO_BET',
      'DOUBLE_CHANCE',
      'OVER_UNDER',
      'OTHER',
    ] as const,
  },
  slipCenter: {
    enabled: true,
    /** Retry every ten minutes until both kickoff-date quotas are satisfied. */
    refreshIntervalMs: 10 * 60_000,
    minimumLegs: 1,
    defaultLegs: 1,
    /** Maximum total selections per slip. */
    maximumLegs: 20,
    /** Shared across normal odds products and every Sure Odds product. */
    maximumSelectionsPerMatch: 3,
    minimumLegProbability: 0.3,
    minimumLegConfidence: 60,
    /** Data quality and safety scores are metadata/ranking signals, not eligibility gates. */
    minimumLegDataQuality: 0,
    minimumSafetyScore: 0,
    autoCreate: true,
    /** Hard ceiling per fixture kickoff date; the six product targets sum to 30 each day. */
    maxAutoSlipsPerDate: 30,
    dailySlipTarget: 30,
    categoryTargets: {
      ODDS_10: 7,
      ODDS_25: 7,
      ODDS_50: 7,
    },
    oddsBands: {
      ODDS_10: { minOdds: 9, maxOdds: 10 },
      ODDS_25: { minOdds: 23, maxOdds: 25 },
      ODDS_50: { minOdds: 48, maxOdds: 50 },
    },
    sureOdds: {
      vipDailyTarget: 3,
      premiumDailyTarget: 6,
      /** Same per-selection threshold used by ODDS_10, ODDS_25, and ODDS_50. */
      minimumProbability: 0.3,
      minimumConfidence: 60,
      minimumDataQuality: 0,
      minimumLegs: 1,
      maximumLegs: 12,
      maximumSelectionsPerMatch: 3,
      products: {
        SURE_2: {
          minOdds: 1.8,
          maxOdds: 2.0,
          dailyTarget: 3,
          requiredPlan: 'vip',
        },
        SURE_5: {
          minOdds: 4.5,
          maxOdds: 5.0,
          dailyTarget: 3,
          requiredPlan: 'premium',
        },
        SURE_7: {
          minOdds: 6.2,
          maxOdds: 7.0,
          dailyTarget: 3,
          requiredPlan: 'premium',
        },
      },
      // Legacy ceiling aliases kept for older callers.
      vipMaximumCombinedOdds: 2.0,
      premiumMaximumCombinedOdds: 7.0,
    },
  },
  monitor: {
    recentEventsLimit: 100,
    alertOnUnavailableMarket: false,
    retainEventDays: 45,
  },
} as const;

export type PredictionEngineConfig = typeof PREDICTION_ENGINE_CONFIG;
