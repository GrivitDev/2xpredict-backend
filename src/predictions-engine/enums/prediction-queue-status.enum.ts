export enum PredictionQueueStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  RETRY = 'RETRY',
  /** Legacy state retained for migration; reconciliation promotes it to PENDING without waiting for Odds. */
  WAITING_FOR_ODDS = 'WAITING_FOR_ODDS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

