export const SETTLEMENT_CONFIG = {
  queue: {
    /** A targeted Summary request is retried only after this cooldown. */
    summaryRequestCooldownMs: 30 * 60_000,
    /** Cached league standings are considered current for this long. */
    standingsFreshnessHours: 6,
    /** Retry incomplete results when fresh provider evidence may have appeared. */
    partialRetryDelayMs: 15 * 60_000,
    /** Retry exhausted transient failures instead of leaving them terminal forever. */
    failedRecoveryIntervalMs: 30 * 60_000,
    /** Revisit skipped jobs conservatively in case the source later becomes usable. */
    skippedRecoveryIntervalMs: 60 * 60_000,
    /** Cooldown before revisiting a completed snapshot; new targets and changed fixture/summary fingerprints bypass it. */
    completedTargetRecoveryIntervalMs: 15 * 60_000,
    /** Safety-critical lease renewal prevents a slow but active job from being reclaimed. */
    leaseHeartbeatIntervalMs: 60_000,
    /** A worker claim is considered abandoned after this lease expires. */
    processingLeaseMinutes: 5,
    maximumAttempts: 5,
    initialRetryDelayMs: 30_000,
    maximumRetryDelayMs: 30 * 60_000,
    /** Bound one drain so a busy instance yields back to the event loop. */
    maximumJobsPerDrain: 100,
  },
  processing: {
    modelVersion: 'football-settlement-v1',
  },
  monitor: {
    defaultPageSize: 50,
    maximumPageSize: 200,
    recentEvents: 100,
    eventRetentionDays: 90,
  },
} as const;
