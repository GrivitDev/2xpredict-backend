/** Runtime policy for a Sports-backed Odds module. No provider/API settings live here. */
export const ODDS_CONFIG = {
  enabled: true,
  /** Admin/monitor readiness sample only; never limits the pricing scan. */
  predictionCoverageWindowHours: 72,
  /** Full catalogue scan; this is not limited to a pre-match lookahead. */
  workerIntervalMs: 60_000,
  workerBatchSize: 100,
  workerConcurrency: 1,
  /** Maximum age of an external bookmaker reference, never a Grivit price. */
  maximumQuoteAgeHours: 72,
  futureTimestampToleranceMs: 5 * 60_000,
  /** Bounded safety cleanup; primary expiry is the Sports fixture deadline. */
  cleanupIntervalMs: 30 * 60_000,
  expiredPriceCleanupBatchSize: 500,
  seasonRetentionGraceMonths: 3,
  maximumReadBatchSize: 500,
  minimumHistoricalSampleSize: 5,
  minimumStatisticalSampleSize: 5,
  /** Event markets require a sufficiently large and representative Plays sample. */
  minimumEventTimelineSampleSize: 8,
  minimumEventTimelineCoverage: 0.65,
  minimumPredictionDataQuality: 0.62,
  /** Grivit's bookmaker margin applied to no-vig model probabilities. */
  grivitOverroundPercent: 5,
  maximumDecimalOdds: 100_000,
  maximumModelGoals: 10,
  modelVersion: '2XP-ODDS-4.1.0',
  modelProbabilityFloor: 0.00001,
  modelProbabilityCeiling: 0.99999,
  /** Period split is a model assumption applied to Sports-derived expected goals. */
  firstHalfGoalShare: 0.45,
  secondHalfGoalShare: 0.55,
  /** Periodic full scan guarantees initial and recovery backfill; source events accelerate recalculation. */
  candidateRecheckIntervalMs: 60_000,
} as const;

export function toValidDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function isOddsQuoteFresh(value: unknown, now = Date.now()): boolean {
  const timestamp = toValidDate(value)?.getTime();
  if (timestamp === undefined || timestamp === null) return false;
  const age = now - timestamp;
  return age >= -ODDS_CONFIG.futureTimestampToleranceMs &&
    age <= ODDS_CONFIG.maximumQuoteAgeHours * 3_600_000;
}



