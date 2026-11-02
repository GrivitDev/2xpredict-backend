export const SETTLEMENT_CONFIG = {
  queue: {
    /** Settlement eligibility still begins at kickoff +180 minutes; missed targets are recovered within the five-minute discovery cadence. Event triggers can enqueue eligible targets immediately. */
    kickoffSettlementDelayMinutes: 180,
    /** A targeted Summary request is retried only after this cooldown. */
    summaryRequestCooldownMs: 30 * 60_000,
    /** Cached league standings are considered current for this long. */
    standingsFreshnessHours: 6,
    /** Five-minute recovery scan is a safety net; target and Summary events still enqueue immediately. */
    discoveryIntervalMs: 5 * 60_000,
    /** Keep each recovery scan bounded so it does not overload MongoDB. */
    discoveryBatchSize: 10,
    /** Retry incomplete results when fresh provider evidence may have appeared. */
    partialRetryDelayMs: 15 * 60_000,
    /** Retry exhausted transient failures instead of leaving them terminal forever. */
    failedRecoveryIntervalMs: 30 * 60_000,
    /** Revisit skipped jobs conservatively in case the source later becomes usable. */
    skippedRecoveryIntervalMs: 60 * 60_000,
    /** Safety net for missed target-created events after a previously completed run. */
    completedTargetRecoveryIntervalMs: 15 * 60_000,
    /** Periodic lease renewal prevents a slow but active job from being reclaimed. */
    /** Safety-critical lease renewal; do not align this heartbeat with the five-minute discovery cadence. */
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
