import { hasReusableFinalMarketSnapshot } from './prediction-market-snapshot.util';

describe('hasReusableFinalMarketSnapshot', () => {
  const updatedAt = new Date('2026-11-11T10:00:00.000Z');
  const currentOdds = [{
    marketId: 'MATCH_RESULT',
    selectionKey: 'HOME_WIN',
    decimalOdds: 2.1,
    predictionReady: true,
    priceType: 'ESTIMATED' as const,
    updatedAt,
    isFresh: true,
  }];
  const market = {
    status: 'CALCULATED',
    fixtureSourceRevision: 4,
    selections: [{
      key: 'HOME_WIN',
      status: 'CALCULATED',
      isFinalSelection: true,
      recommendationEligible: true,
      oddsPredictionReady: true,
      priceType: 'ESTIMATED',
      decimalOdds: 2.1,
      oddsUpdatedAt: updatedAt,
    }],
  };

  it('retains a single final selection only while its exact current quote is unchanged', () => {
    expect(hasReusableFinalMarketSnapshot(market, 'MATCH_RESULT', 4, currentOdds)).toBe(true);
  });

  it('rejects a different Sports revision', () => {
    expect(hasReusableFinalMarketSnapshot(market, 'MATCH_RESULT', 5, currentOdds)).toBe(false);
  });

  it('rejects changed, stale or unavailable Odds quotes', () => {
    expect(hasReusableFinalMarketSnapshot(market, 'MATCH_RESULT', 4, [{
      ...currentOdds[0], decimalOdds: 2.2,
    }])).toBe(false);
    expect(hasReusableFinalMarketSnapshot(market, 'MATCH_RESULT', 4, [{
      ...currentOdds[0], isFresh: false,
    }])).toBe(false);
    expect(hasReusableFinalMarketSnapshot(market, 'MATCH_RESULT', 4, [])).toBe(false);
  });

  it('rejects ambiguous market documents with more than one final selection', () => {
    expect(hasReusableFinalMarketSnapshot({
      ...market,
      selections: [...market.selections, { ...market.selections[0], key: 'DRAW' }],
    }, 'MATCH_RESULT', 4, currentOdds)).toBe(false);
  });
});
