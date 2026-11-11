export const PREDICTION_ENGINE_CONFIG = {
  enabled: true,
  modelVersion: '2XP-FOOTBALL-3.1.0',
  queue: {
    /** Periodic full-inventory reconciliation; Stage 2 adds direct Sports/Odds event enqueueing. */
    syncIntervalMs: 10 * 60_000,
    /** Poll quickly and dispatch the full configured worker concurrency per tick. */
    workerIntervalMs: 5_000,
    /** Bounded parallelism keeps full-season backfills moving without unbounded DB pressure. */
    workerConcurrency: 2,
    /** Temporary safety-net refresh; Stage 2 will make source-change events the primary trigger. */
    completedRefreshIntervalMs: 12 * 60 * 60 * 1000,
    /** Retry exhausted jobs after a cooldown, even if source timestamps did not change. */
    failedRecoveryIntervalMs: 30 * 60 * 1000,
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
    sourceDataStaleHours: 48,
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
    /** Do not fit a market calibrator until it has a meaningful settled sample. */
    minimumSettledSamples: 30,
    /** Check for new calibration work every five minutes. */
    checkIntervalMs: 5 * 60_000,
    /** Refit every 15 minutes when settled data changes; regularization protects sparse markets. */
    refreshIntervalMs: 15 * 60_000,
    /** Strong enough to correct demonstrated bias while retaining shrinkage for limited samples. */
    maximumCorrectionBlendWeight: 0.8,
  },
  curatedPredictions: {
    enabled: true,
    /** Create the immutable curated snapshot during the final 48 hours before kickoff. */
    horizonHours: 48,
    /** Recheck on the configured ten-minute cadence; published snapshots are never supplemented. */
    refreshIntervalMs: 10 * 60_000,
    minimumSelectionsPerMatch: 1,
    maximumSelectionsPerMatch: 7,
    /** Use final market probabilities after any active market-specific calibration correction. */
    minimumProbability: 0.6,
    minimumConfidence: 70,
    /** Data quality and safety/ranking scores inform ordering; they do not reject a priced selection. */
    minimumDataQuality: 0,
    minimumSafetyScore: 0,
  },
  pickCenter: {
    enabled: true,
    /** Reconcile Pick Center independently of market worker success, on a ten-minute cadence. */
    refreshIntervalMs: 10 * 60_000,
    /** Reconcile a larger bounded batch because Pick Center now covers the full upcoming season. */
    refreshBatchSize: 100,
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
    maximumLegs: 80,
    /** Shared across normal odds products and every Sure Odds product. */
    maximumSelectionsPerMatch: 7,
    /** Slip products apply stricter per-leg standards than the base Pick Center. */
    minimumLegProbability: 0.4,
    minimumLegConfidence: 70,
    minimumLegDecimalOdds: 1.1,
    /** Data quality and safety scores are metadata/ranking signals, not eligibility gates. */
    minimumLegDataQuality: 0,
    minimumSafetyScore: 0,
    autoCreate: true,
    /** Hard ceiling per fixture kickoff date; the configured product targets sum to 210. */
    maxAutoSlipsPerDate: 250,
    dailySlipTarget: 210,
    categoryTargets: {
      ODDS_10: 50,
      ODDS_25: 50,
      ODDS_50: 50,
    },
    oddsBands: {
      ODDS_10: { minOdds: 9, maxOdds: 10 },
      ODDS_25: { minOdds: 23, maxOdds: 25 },
      ODDS_50: { minOdds: 48, maxOdds: 50 },
    },
    sureOdds: {
      vipDailyTarget: 20,
      premiumDailyTarget: 40,
      /** Sure Odds uses the same per-leg standards as the standard Slip Center products. */
      minimumProbability: 0.4,
      minimumConfidence: 70,
      minimumDataQuality: 0,
      minimumLegs: 1,
      maximumLegs: 12,
      maximumSelectionsPerMatch: 3,
      products: {
        SURE_2: {
          minOdds: 1.8,
          maxOdds: 2.0,
          dailyTarget: 20,
          requiredPlan: 'vip',
        },
        SURE_5: {
          minOdds: 4.5,
          maxOdds: 5.0,
          dailyTarget: 20,
          requiredPlan: 'premium',
        },
        SURE_7: {
          minOdds: 6.2,
          maxOdds: 7.0,
          dailyTarget: 20,
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
