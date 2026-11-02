export enum PredictionQueueStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  RETRY = 'RETRY',
  /** Stored separately from actionable queue states until Odds marks the fixture ready. */
  WAITING_FOR_ODDS = 'WAITING_FOR_ODDS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}
