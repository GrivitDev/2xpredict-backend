/** Single source of truth for the Odds Module's upcoming fixture window. */
export const ODDS_CONFIG = {
  /** Collect canonical Odds-module prices for the same three-day window as prediction queueing. */
  lookaheadHours: 72,
  /** One targeted ESPN Summary confirmation per fixture per two-hour pricing window. */
  summaryRequestCooldownMs: 2 * 60 * 60_000,
  /** Shared freshness rule for every downstream consumer of stored quotes. */
  maximumQuoteAgeHours: 72,
  futureTimestampToleranceMs: 5 * 60_000,
} as const;


/** Shared, deterministic quote-freshness policy. Consumers may validate a
 * stored snapshot but must never refresh or recalculate its price. */
export function isOddsQuoteFresh(
  value: unknown,
  now = Date.now(),
): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return false;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return false;
  const ageMs = now - timestamp;
  return ageMs >= -ODDS_CONFIG.futureTimestampToleranceMs
    && ageMs <= ODDS_CONFIG.maximumQuoteAgeHours * 3_600_000;
}
