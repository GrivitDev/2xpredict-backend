/** Single source of truth for the Odds Module's upcoming fixture window. */
export const ODDS_CONFIG = {
  /** Collect canonical Odds-module prices for the same three-day window as prediction queueing. */
  lookaheadHours: 72,
  /** One targeted ESPN Summary confirmation per fixture per two-hour pricing window. */
  summaryRequestCooldownMs: 2 * 60 * 60_000,
} as const;
