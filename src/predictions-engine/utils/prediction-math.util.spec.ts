import { PredictionMathUtil } from './prediction-math.util';

describe('PredictionMathUtil', () => {
  it('normalizes only finite positive values', () => {
    expect(PredictionMathUtil.normalize([2, 2, -1, Number.NaN])).toEqual([
      0.5, 0.5, 0, 0,
    ]);
    expect(PredictionMathUtil.normalize([0, -1])).toEqual([0, 0]);
  });

  it('produces a normalized score matrix and 1X2 probabilities', () => {
    const matrix = PredictionMathUtil.scoreMatrix(1.6, 1.1, 8);
    const total = matrix.flat().reduce((sum, value) => sum + value, 0);
    const result = PredictionMathUtil.resultProbabilities(matrix);
    expect(total).toBeCloseTo(1, 12);
    expect(result.home + result.draw + result.away).toBeCloseTo(1, 12);
    expect(result.home).toBeGreaterThan(result.away);
  });

  it('bounds Poisson inputs and returns zero for invalid goal counts', () => {
    expect(PredictionMathUtil.poissonPmf(2, -1)).toBe(0);
    expect(PredictionMathUtil.poissonPmf(2, 1.5)).toBe(0);
    expect(PredictionMathUtil.poissonPmf(2, 0)).toBeGreaterThan(0);
    expect(PredictionMathUtil.poissonPmf(2, 1)).toBeGreaterThan(0);
  });

  it('returns fair odds only for valid probabilities', () => {
    expect(PredictionMathUtil.decimalFairOdds(0.5)).toBe(2);
    expect(PredictionMathUtil.decimalFairOdds(0)).toBeNull();
    expect(PredictionMathUtil.decimalFairOdds(1.1)).toBeNull();
  });

  it('rejects invalid expected-value inputs and calculates valid value', () => {
    expect(PredictionMathUtil.expectedValue(1.2, 2)).toBeNull();
    expect(PredictionMathUtil.expectedValue(0.5, 1)).toBeNull();
    expect(PredictionMathUtil.expectedValue(0.5, 2.2)).toBeCloseTo(0.1, 6);
  });

  it('supports American and decimal provider odds without guessing invalid values', () => {
    expect(PredictionMathUtil.americanToDecimalOdds(100)).toBe(2);
    expect(PredictionMathUtil.americanToDecimalOdds(-200)).toBe(1.5);
    expect(PredictionMathUtil.decimalFromProviderValue(2.25)).toBe(2.25);
    expect(PredictionMathUtil.decimalFromProviderValue(-110)).toBe(1.9091);
    expect(PredictionMathUtil.decimalFromProviderValue(0)).toBeNull();
  });
});
