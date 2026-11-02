import { BetLabLegStatus } from '../enums/bet-lab-leg-status.enum';
import { BetLabSettlementOutcome } from '../enums/bet-lab-settlement-outcome.enum';
import { BetLabTicketStatus } from '../enums/bet-lab-ticket-status.enum';

/** Internal contract for the separate Settlement module. Never accept this payload from a public client. */
export interface BetLabResolvedLeg {
  legId: string;
  status: Exclude<BetLabLegStatus, BetLabLegStatus.OPEN>;
  outcomeLabel?: string;
  settledAt?: Date;
}

export interface ApplyBetLabSettlementInput {
  ticketId: string;
  settlementId: string;
  ticketStatus:
    | BetLabTicketStatus.WON
    | BetLabTicketStatus.LOST
    | BetLabTicketStatus.VOID
    | BetLabTicketStatus.PUSH
    | BetLabTicketStatus.PARTIALLY_WON
    | BetLabTicketStatus.PARTIALLY_LOST;
  /** Authoritative gross return calculated by Settlement, including returned stake. */
  grossReturn: number;
  resolvedLegs: BetLabResolvedLeg[];
  settledAt?: Date;
  note?: string;
  outcome?: BetLabSettlementOutcome;
}

export interface ApplyBetLabSettlementResult {
  ticketId: string;
  status: BetLabTicketStatus;
  grossReturn: number;
  alreadyApplied: boolean;
}
