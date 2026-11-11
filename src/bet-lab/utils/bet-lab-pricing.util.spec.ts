import {
  buildBetLabFixturePricingModel,
  buildBetLabSelectionPricing,
  calculateBetLabCombinedOdds,
  calculateBetLabSlipPricing,
  getBetLabPricingGroup,
} from './bet-lab-pricing.util';

describe('Bet Lab slip pricing', () => {
  it('returns neutral combined odds for an empty slip', () => {
    expect(calculateBetLabSlipPricing([])).toEqual({
      combinedOdds: 1,
      adjustments: [],
    });
  });

  it('multiplies independent markets and separate fixtures', () => {
    const combined = calculateBetLabCombinedOdds([
      { eventId: 'fixture-a', marketCode: 'TOTAL_CORNERS_OVER_UNDER', selectionCode: 'OVER_8_5', odds: 1.8 },
      { eventId: 'fixture-a', marketCode: 'TOTAL_CARDS_OVER_UNDER', selectionCode: 'OVER_3_5', odds: 2.1 },
      { eventId: 'fixture-b', marketCode: 'TOTAL_OFFSIDES_OVER_UNDER', selectionCode: 'OVER_2_5', odds: 1.5 },
    ]);
    expect(combined).toBeCloseTo(5.67, 4);
  });

  it('recognises only the configured related match markets', () => {
    expect(getBetLabPricingGroup('MATCH_RESULT')).toBe('MATCH');
    expect(getBetLabPricingGroup('TOTAL_SHOTS_OVER_UNDER')).toBe('MATCH');
    expect(getBetLabPricingGroup('TOTAL_CORNERS_OVER_UNDER')).toBeNull();
  });

  it('creates bounded fallback fixture-model parameters when no market rows exist', () => {
    const model = buildBetLabFixturePricingModel([]);
    expect(model.homeGoalMean).toBeGreaterThan(0);
    expect(model.awayGoalMean).toBeGreaterThan(0);
    expect(model.firstHalfShare).toBeGreaterThanOrEqual(0.25);
    expect(model.firstHalfShare).toBeLessThanOrEqual(0.65);
    expect(model.totalShotsMean).toBeGreaterThan(0);
    expect(model.shotsOnTargetRate).toBeGreaterThanOrEqual(0.1);
    expect(model.shotsOnTargetRate).toBeLessThanOrEqual(0.7);
  });

  it('does not infer fair probabilities when the Odds module has no matching price row', () => {
    const result = buildBetLabSelectionPricing(
      [],
      'MATCH_RESULT',
      'HOME_WIN',
      2.1,
    );
    expect(result.fairProbability).toBeNull();
  });
});
