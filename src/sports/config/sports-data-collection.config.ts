export const SPORTS_DATA_COLLECTION_CONFIG = {
  // ==========================================================
  // ESPN
  // ==========================================================

  ESPN: {
    enabled: true,

    /**
     * ESPN exposes no published application quota. We therefore use
     * a small process-local start interval and a bounded concurrency
     * pool. The rate-limit service applies adaptive backoff when ESPN
     * returns throttling or transient server errors.
     */
    rateLimit: {
      minIntervalSeconds: 0.1,
      normalConcurrency: 4,
      liveConcurrency: 1,
    },

    /**
     * Complete ESPN soccer league catalogue.
     *
     * The catalogue is refreshed weekly.
     */
    catalogue: {
      refreshIntervalDays: 7,
    },

    /**
     * Active competition matching.
     */
    activeCompetitions: {
      enabled: true,
      refreshIntervalMinutes: 10,
    },

    /** Explicit endpoint gates; standalone standings is enabled for league tables. */
    endpoints: {
      globalLiveScoreboardEnabled: false,
      // The dedicated endpoint is the primary source for ordinary league tables.
      dedicatedStandingsEnabled: true,
    },

    /**
     * Fixture collection.
     *
     * Startup covers every calendar month from season start through season
     * end. Normal refresh jobs also use monthly scoreboard requests, grouped
     * by month, while the sync ledger can still track individual dates.
     * A month is never split into per-day ESPN requests as a fallback.
     */
    fixtures: {
      enabled: true,

      /** Fixture-index refresh window only; Summary, Odds, and Prediction use their own explicit timing contracts. */
      forwardDays: 8,

      /** Minimum freshness guarantee for active competitions. */
      staleAfterHours: 6,

      /** Refresh the near-term three-day fixture window throughout the day. */
      nearTermRefreshIntervalHours: 6,

      /** Refresh the outer days of the eight-day horizon once daily. */
      farTermRefreshIntervalHours: 24,

      /** Queue spacing between normal fixture work slots. */
      slotIntervalMinutes: 0.02,

      /** Maximum scoreboard events requested from ESPN for one month. */
      startupMonthLimit: 500000,

      /** Maximum simultaneous startup scoreboard requests. */
      startupConcurrency: 2,
    },

    /**
     * ESPN Summary collection.
     */
    summary: {
      enabled: true,

      /** Bounded startup Summary lookahead, measured in elapsed hours from now. */
      startupWindowHours: 72,

      /** Runtime upcoming Summary window; aligned with the 72-hour startup horizon. */
      upcomingWindowHours: 72,

      /** First post-kickoff Summary refresh. 160 minutes is close to three hours. */
      finishedMatchDelayMinutes: 160,

      /**
       * Additional post-kickoff result checks if the persisted fixture remains
       * incomplete after a successful Summary response. These are offsets from
       * kickoff, not repeated delays from the time the previous job completed.
       */
      postMatchRecoveryCheckpointsMinutes: [180, 210, 240, 360, 720, 1440],

      /**
       * Daily integrity recovery scans only this recent history window. The
       * queue builder rotates through bounded batches instead of scanning the
       * full fixture collection or issuing provider requests from a timer.
       */
      integrityRecoveryLookbackDays: 30,
      integrityRecoveryBatchSize: 100,
      integrityRecoveryMaxQueuedPerPass: 20,

      /** Summary queue-write batch size; provider calls execute in the durable worker after startup unlocks. */
      startupBatchSize: 10,

      /** Maximum transient retry attempts inside the ESPN client. */
      maxRetries: 3,
    },

    /** Queue safety. */
    queue: {
      enabled: true,
      maxAttempts: 3,
      /** Eight execution slots: six normal and two reserved for recovery. */
      maxConcurrentJobs: 8,
      normalReservedConcurrency: 6,
      retryReservedConcurrency: 2,
      /** A renewable lease prevents a healthy long-running job being stolen. */
      leaseMinutes: 8,
      heartbeatSeconds: 60,
      staleProcessingMinutes: 8,
      retryDelayMinutes: 1,
      retryDelaysMinutes: [1, 2, 5, 10, 20, 40, 60, 180, 360, 720, 1440],
      retryJitterPercent: 20,
      retryRecoveryBatchSize: 100,
    },
  },

  // ==========================================================
  // FOOTBALL-DATA
  // ==========================================================

  FOOTBALL_DATA: {
    enabled: false,

    rateLimit: {
      minIntervalSeconds: 60,
    },

    live: {
      intervalMinutes: 5,
    },
  },

  // ==========================================================
  // YOUTUBE
  // ==========================================================

  YOUTUBE: {
    enabled: true,

    /**
     * Internal daily search safety budget.
     *
     * This remains separate from ESPN.
     */
    dailyRequestLimit: 90,

    rateLimit: {
      minIntervalSeconds: 200,
    },

    /**
     * Each durable YouTube job executes exactly one provider search. The
     * worker schedules retry/fallback timing from YOUTUBE_CONFIG.searchWorkflow.
     * The interval/retryDelay fields remain for config-shape compatibility;
     * they do not control the bounded highlight search sequence.
     */
    queue: {
      enabled: true,
      intervalMinutes: 20,
      maxAttempts: 1,
      retryDelayMinutes: 20,
    },
  },
} as const;

export type SportsDataCollectionConfig = typeof SPORTS_DATA_COLLECTION_CONFIG;
