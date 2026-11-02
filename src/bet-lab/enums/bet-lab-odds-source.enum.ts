/**
 * Provenance of the odds snapshot used for a simulated Bet Lab selection.
 * These sources only price virtual tickets; they are not Prediction Engine
 * probabilities, betting recommendations, or real-money stakes.
 */
export enum BetLabOddsSource {
  API_FOOTBALL = 'API_FOOTBALL',
  THE_ODDS_API = 'THE_ODDS_API',
  ESPN_ODDS = 'ESPN_ODDS',
  UNKNOWN_PROVIDER = 'UNKNOWN_PROVIDER',
  ESTIMATED = 'ESTIMATED',

  /** Legacy persisted source values retained for existing ticket history. */
  ESPN_PICKCENTER = 'ESPN_PICKCENTER',
  DERIVED_FAIR = 'DERIVED_FAIR',
}

export type BetLabPriceType = 'PROVIDER' | 'ESTIMATED';

export type BetLabOddsTimestampBasis =
  | 'PROVIDER_UPDATED_AT'
  | 'INGESTED_AT'
  | 'MODEL_GENERATED';
