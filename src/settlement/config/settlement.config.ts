export const SETTLEMENT_CONFIG = {
  queue: {
    /** Retry unresolved live/half-time markets promptly while Sports continues updating. */
    partialRetryDelayMs: 3 * 60_000,
    /** Retry exhausted transient failures instead of leaving them terminal forever. */
    failedRecoveryIntervalMs: 30 * 60_000,
    /** Revisit skipped jobs conservatively in case Sports later confirms a usable lifecycle. */
    skippedRecoveryIntervalMs: 60 * 60_000,
    /** Cooldown before revisiting a completed snapshot; new source fingerprints bypass it. */
    completedTargetRecoveryIntervalMs: 15 * 60_000,
    /** Safety-critical lease renewal prevents a slow but active job from being reclaimed. */
    leaseHeartbeatIntervalMs: 60_000,
    /** Re-scan unresolved Prediction/Bet Lab targets to recover missed enqueue handoffs. */
    targetReconciliationIntervalMs: 5 * 60_000,
    /** A worker claim is considered abandoned after this lease expires. */
    processingLeaseMinutes: 5,
    maximumAttempts: 5,
    initialRetryDelayMs: 30_000,
    maximumRetryDelayMs: 30 * 60_000,
    /** Bound one drain so a busy instance yields back to the event loop. */
    maximumJobsPerDrain: 100,
  },
  evidence: {
    /** Maximum age for a scoreboard source before it can settle a market early. */
    inPlayFixtureFreshnessMs: 20 * 60_000,
    /** Statistics need tighter freshness before being used as live lower bounds. */
    inPlayStatisticsFreshnessMs: 10 * 60_000,
    /** Full-time box-score markets require fresh snapshots from both teams. */
    fullTimeStatisticsFreshnessMs: 20 * 60_000,
    /** Timeline events also need fresh source evidence for early event-market wins. */
    inPlayTimelineFreshnessMs: 20 * 60_000,
  },
  processing: {
    modelVersion: 'sports-native-settlement-v2',
  },
  monitor: {
    defaultPageSize: 50,
    maximumPageSize: 200,
    recentEvents: 100,
    eventRetentionDays: 90,
  },
} as const;

