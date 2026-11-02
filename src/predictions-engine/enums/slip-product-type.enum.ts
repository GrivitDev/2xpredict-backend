export enum SlipProductType {
  /** New commercial products; combined bookmaker odds are validated inclusively. */
  ODDS_10 = 'ODDS_10',
  ODDS_25 = 'ODDS_25',
  ODDS_50 = 'ODDS_50',
  SURE_ODDS = 'SURE_ODDS',

  /** Legacy values are retained so settled historical records remain readable. */
  STANDARD = 'STANDARD',
  MEDIUM_ODDS = 'MEDIUM_ODDS',
  HIGH_ODDS = 'HIGH_ODDS',
  EXTENDED_ODDS = 'EXTENDED_ODDS',
  UNLIMITED_ODDS = 'UNLIMITED_ODDS',
}
