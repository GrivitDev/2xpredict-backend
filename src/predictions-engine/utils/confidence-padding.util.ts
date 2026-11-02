/**
 * Legacy export retained for callers compiled against the previous utility.
 * This function no longer pads confidence. It only bounds the supplied evidence
 * score, because adding synthetic points would misrepresent model reliability.
 */
export const CONFIDENCE_MIN = 0;
export const CONFIDENCE_MAX = 98;

/** @deprecated Use an evidence-derived confidence score directly. */
export function padConfidence(value: unknown, _seed?: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(CONFIDENCE_MIN, Math.min(CONFIDENCE_MAX, Math.round(parsed)));
}
