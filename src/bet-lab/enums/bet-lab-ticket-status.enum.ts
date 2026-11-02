export enum BetLabTicketStatus {
  OPEN = 'OPEN',
  PENDING_SETTLEMENT = 'PENDING_SETTLEMENT',
  WON = 'WON',
  LOST = 'LOST',
  VOID = 'VOID',
  PUSH = 'PUSH',
  PARTIALLY_WON = 'PARTIALLY_WON',
  PARTIALLY_LOST = 'PARTIALLY_LOST',
  CANCELLED = 'CANCELLED',
}

export const BET_LAB_TERMINAL_TICKET_STATUSES: readonly BetLabTicketStatus[] = [
  BetLabTicketStatus.WON,
  BetLabTicketStatus.LOST,
  BetLabTicketStatus.VOID,
  BetLabTicketStatus.PUSH,
  BetLabTicketStatus.PARTIALLY_WON,
  BetLabTicketStatus.PARTIALLY_LOST,
  BetLabTicketStatus.CANCELLED,
];
