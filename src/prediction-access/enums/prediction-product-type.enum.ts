/** Product identifiers used by the current real-world Prediction Engine. */
export enum PredictionProductType {
  ODDS_10 = 'ODDS_10',
  ODDS_25 = 'ODDS_25',
  ODDS_50 = 'ODDS_50',
  SURE_ODDS = 'SURE_ODDS',

  /** Legacy persisted values retained for historical/admin compatibility only. */
  STANDARD = 'STANDARD',
  MEDIUM_ODDS = 'MEDIUM_ODDS',
  HIGH_ODDS = 'HIGH_ODDS',
  EXTENDED_ODDS = 'EXTENDED_ODDS',
  UNLIMITED_ODDS = 'UNLIMITED_ODDS',
}

export enum SureOddsTier {
  VIP = 'VIP',
  PREMIUM = 'PREMIUM',
}

export type SlipAccessPlan = 'regular' | 'vip' | 'premium';
