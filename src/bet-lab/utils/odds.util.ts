/**
 * Generic decimal rounding for virtual ticket totals.
 * Individual selection prices, provider normalization, vig removal and fair
 * pricing belong exclusively to the Odds module.
 */
export function roundDecimal(value: number, decimalPlaces = 4): number {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** decimalPlaces;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
