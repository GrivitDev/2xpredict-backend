import {
  canonicalLineSlug,
  expandCanonicalSelections,
  FOOTBALL_MARKET_BY_BET_LAB_CODE,
  FOOTBALL_MARKET_BY_ID,
  FOOTBALL_MARKET_BY_PREDICTION_KEY,
  FOOTBALL_MARKET_CATALOG,
  validateFootballMarketCatalog,
} from './football-market-catalog';

describe('canonical football market catalogue', () => {
  it('passes its integrity validator', () => {
    expect(() => validateFootballMarketCatalog()).not.toThrow();
  });

  it('has unique market identifiers across all canonical lookup maps', () => {
    expect(new Set(FOOTBALL_MARKET_CATALOG.map((item) => item.id)).size).toBe(
      FOOTBALL_MARKET_CATALOG.length,
    );
    for (const market of FOOTBALL_MARKET_CATALOG) {
      expect(FOOTBALL_MARKET_BY_ID.get(market.id)).toBe(market);
      expect(FOOTBALL_MARKET_BY_PREDICTION_KEY.get(market.predictionMarketKey)).toBe(market);
      expect(FOOTBALL_MARKET_BY_BET_LAB_CODE.get(market.betLabMarketCode)).toBe(market);
    }
  });

  it('generates stable line slugs for positive and negative lines', () => {
    expect(canonicalLineSlug(2.5)).toBe('2_5');
    expect(canonicalLineSlug(-1.5)).toBe('MINUS_1_5');
  });

  it('expands unique selections for each market', () => {
    for (const market of FOOTBALL_MARKET_CATALOG) {
      const selections = expandCanonicalSelections(market);
      const keys = selections.map((selection) => selection.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(selections.every((selection) => selection.key.length > 0)).toBe(true);
    }
  });

  it('keeps disabled player markets registered but not enabled for pricing', () => {
    const disabledPlayerMarkets = FOOTBALL_MARKET_CATALOG.filter(
      (market) => market.family === 'PLAYER' && market.pricingEnabled === false,
    );
    expect(disabledPlayerMarkets.length).toBeGreaterThan(0);
    expect(disabledPlayerMarkets.every((market) => FOOTBALL_MARKET_BY_ID.has(market.id))).toBe(true);
  });
});
