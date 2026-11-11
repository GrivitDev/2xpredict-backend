import { PredictionMarket } from '../enums/prediction-market.enum';
import {
  FOOTBALL_MARKET_CATALOG,
  isCanonicalPredictionMarketKey,
  isPricingEnabledPredictionMarketKey,
  LEGACY_PREDICTION_MARKET_KEYS,
  validatePredictionEngineMarketCatalog,
} from './football-market-catalog';

describe('prediction engine market catalogue contract', () => {
  it('passes the canonical-versus-legacy identifier validator', () => {
    expect(() => validatePredictionEngineMarketCatalog()).not.toThrow();
  });

  it('classifies every enum value exactly once as canonical or legacy', () => {
    const enumKeys = Object.values(PredictionMarket);
    const canonical = FOOTBALL_MARKET_CATALOG.map((market) => String(market.key));
    const legacy = LEGACY_PREDICTION_MARKET_KEYS.map(String);
    const classified = [...canonical, ...legacy];
    expect(new Set(classified).size).toBe(classified.length);
    expect(new Set(classified)).toEqual(new Set(enumKeys));
  });

  it('allows canonical active keys and rejects legacy keys for active pricing', () => {
    const activeKey = String(FOOTBALL_MARKET_CATALOG[0].key);
    expect(isCanonicalPredictionMarketKey(activeKey)).toBe(true);
    expect(isPricingEnabledPredictionMarketKey(activeKey)).toBe(true);
    for (const legacyKey of LEGACY_PREDICTION_MARKET_KEYS) {
      expect(isCanonicalPredictionMarketKey(legacyKey)).toBe(false);
      expect(isPricingEnabledPredictionMarketKey(legacyKey)).toBe(false);
    }
  });

  it('rejects empty and non-string identifiers safely', () => {
    expect(isCanonicalPredictionMarketKey('  ')).toBe(false);
    expect(isCanonicalPredictionMarketKey(null)).toBe(false);
    expect(isPricingEnabledPredictionMarketKey(undefined)).toBe(false);
  });
});
