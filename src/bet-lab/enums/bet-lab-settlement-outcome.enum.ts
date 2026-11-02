/** Outcomes are supplied by the separate Settlement module; Bet Lab does not derive them. */
export enum BetLabSettlementOutcome {
  WON = 'WON',
  LOST = 'LOST',
  VOID = 'VOID',
  PUSH = 'PUSH',
  HALF_WON = 'HALF_WON',
  HALF_LOST = 'HALF_LOST',
  PARTIALLY_WON = 'PARTIALLY_WON',
  PARTIALLY_LOST = 'PARTIALLY_LOST',
}
