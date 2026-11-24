import { hasReusableFinalMarketSnapshot } from './prediction-market-snapshot.util';
import type { StoredFixtureOdds } from '../interfaces/prediction-match-context.interface';

describe('hasReusableFinalMarketSnapshot source generation', () => {
  it('does not reuse a final market calculated from an older Sports source fingerprint', () => {
    const updatedAt = new Date('2026-11-23T08:00:00.000Z');
    const currentOdds: StoredFixtureOdds[] = [{
      marketId: 'full-time-result',
      selectionKey: 'HOME_WIN',
      decimalOdds: 1.85,
      predictionReady: true,
      priceType: 'ESTIMATED',
      updatedAt,
      isFresh: true,
    }];
    const existing = {
      status: 'CALCULATED',
      fixtureSourceRevision: 2,
      sourceRevisionFingerprint: 'old-source-generation',
      selections: [{
        key: 'HOME_WIN',
        status: 'CALCULATED',
        isFinalSelection: true,
        recommendationEligible: true,
        oddsPredictionReady: true,
        priceType: 'ESTIMATED',
        decimalOdds: 1.85,
        oddsUpdatedAt: updatedAt,
      }],
    };

    expect(hasReusableFinalMarketSnapshot(
      existing,
      'full-time-result',
      2,
      currentOdds,
      'new-source-generation',
    )).toBe(false);
    expect(hasReusableFinalMarketSnapshot(
      { ...existing, sourceRevisionFingerprint: 'new-source-generation' },
      'full-time-result',
      2,
      currentOdds,
      'new-source-generation',
    )).toBe(true);
    expect(hasReusableFinalMarketSnapshot(
      { ...existing, sourceRevisionFingerprint: 'new-source-generation' },
      'full-time-result',
      2,
      currentOdds,
      'new-source-generation',
      true,
    )).toBe(false);
  });
});
