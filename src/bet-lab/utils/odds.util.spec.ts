import { roundDecimal } from './odds.util';

describe('roundDecimal', () => {
  it('rounds ticket totals to four decimal places by default', () => {
    expect(roundDecimal(1.234567)).toBe(1.2346);
  });

  it('supports a caller-selected precision', () => {
    expect(roundDecimal(1.234567, 2)).toBe(1.23);
  });

  it('preserves non-finite values for the caller to validate', () => {
    expect(roundDecimal(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(roundDecimal(Number.NaN))).toBe(true);
  });
});
