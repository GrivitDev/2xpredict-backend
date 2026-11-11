import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash } from 'node:crypto';
import { BET_LAB_CONFIG } from '../config/bet-lab.config';
import {
  BetLabEventCategory,
  BetLabEventLevel,
} from '../enums/bet-lab-event.enum';
import { BetLabLedgerType } from '../enums/bet-lab-ledger-type.enum';
import {
  BetLabTicketStatus,
  BET_LAB_TERMINAL_TICKET_STATUSES,
} from '../enums/bet-lab-ticket-status.enum';
import { BetLabLegStatus } from '../enums/bet-lab-leg-status.enum';
import {
  ApplyBetLabSettlementInput,
  ApplyBetLabSettlementResult,
} from '../interfaces/bet-lab-settlement.interface';
import { BetLabTicket } from '../schemas/bet-lab-ticket.schema';
import { BetLabWallet } from '../schemas/bet-lab-wallet.schema';
import { BetLabEventService } from './bet-lab-event.service';
import { BetLabWalletService } from './bet-lab-wallet.service';
import { NotificationEventsService } from '../../notifications/in-app/notification-events.service';

/**
 * Integration boundary for the independent Settlement module.
 * It accepts authoritative outcomes/returns; it does not derive football results.
 */
@Injectable()
export class BetLabSettlementAdapterService {
  constructor(
    @InjectModel(BetLabTicket.name)
    private readonly ticketModel: Model<BetLabTicket>,
    @InjectModel(BetLabWallet.name)
    private readonly walletModel: Model<BetLabWallet>,
    private readonly walletService: BetLabWalletService,
    private readonly events: BetLabEventService,
    private readonly notificationEvents: NotificationEventsService,
  ) {}

  async applyResolvedTicket(
    input: ApplyBetLabSettlementInput,
  ): Promise<ApplyBetLabSettlementResult> {
    if (!/^[a-f\d]{24}$/i.test(input.ticketId))
      throw new ConflictException('Invalid Bet Lab ticket ID');
    const settlementId = String(input.settlementId ?? '').trim();
    if (!settlementId || settlementId.length > 160)
      throw new ConflictException('A valid settlementId is required');
    if (!Array.isArray(input.resolvedLegs) || input.resolvedLegs.length === 0) {
      throw new ConflictException(
        'Settlement must provide a resolved result for every ticket leg',
      );
    }
    const settlementFingerprint = this.createSettlementFingerprint(
      input,
      settlementId,
    );
    const settleableStatuses = [
      BetLabTicketStatus.WON,
      BetLabTicketStatus.LOST,
      BetLabTicketStatus.VOID,
      BetLabTicketStatus.PUSH,
      BetLabTicketStatus.PARTIALLY_WON,
      BetLabTicketStatus.PARTIALLY_LOST,
    ] as const;
    if (!settleableStatuses.includes(input.ticketStatus)) {
      throw new ConflictException(
        'Settlement must supply a supported resolved ticket status',
      );
    }
    if (
      !Number.isSafeInteger(input.grossReturn) ||
      input.grossReturn < 0 ||
      input.grossReturn > BET_LAB_CONFIG.virtualPoints.maximumPotentialReturn
    ) {
      throw new ConflictException(
        'Settlement supplied an invalid gross return',
      );
    }
    if (
      input.ticketStatus === BetLabTicketStatus.LOST &&
      input.grossReturn !== 0
    ) {
      throw new ConflictException(
        'A lost ticket must have a gross return of zero',
      );
    }
    if (
      [
        BetLabTicketStatus.WON,
        BetLabTicketStatus.VOID,
        BetLabTicketStatus.PUSH,
        BetLabTicketStatus.PARTIALLY_WON,
        BetLabTicketStatus.PARTIALLY_LOST,
      ].includes(input.ticketStatus) &&
      input.grossReturn <= 0
    ) {
      throw new ConflictException(
        'A non-losing, voided, pushed, or partially settled ticket with a return must return a positive amount',
      );
    }

    const session = await this.ticketModel.db.startSession();
    let result: ApplyBetLabSettlementResult | null = null;
    let eventToWrite: { userId: string; ticketNumber: string; stake: number } | null = null;
    try {
      await session.withTransaction(async () => {
        const ticket = await this.ticketModel
          .findById(input.ticketId)
          .session(session)
          .exec();
        if (!ticket)
          throw new NotFoundException('Bet Lab ticket was not found');

        if (
          ticket.settlementId === settlementId &&
          BET_LAB_TERMINAL_TICKET_STATUSES.includes(ticket.status)
        ) {
          if (
            ticket.settlementFingerprint &&
            ticket.settlementFingerprint !== settlementFingerprint
          ) {
            throw new ConflictException(
              'This settlement ID was already applied with different result details.',
            );
          }
          result = {
            ticketId: String(ticket._id),
            status: ticket.status,
            grossReturn: ticket.settledGrossReturn,
            alreadyApplied: true,
          };
          return;
        }
        if (BET_LAB_TERMINAL_TICKET_STATUSES.includes(ticket.status)) {
          throw new ConflictException(
            'Ticket has already been settled using a different settlementId',
          );
        }

        this.validateResolvedLegs(ticket.legs, input);
        const wallet = await this.walletModel
          .findOne({ userId: ticket.userId })
          .session(session)
          .exec();
        if (!wallet)
          throw new InternalServerErrorException(
            'Bet Lab wallet is missing for a ticket being settled',
          );

        const settledAt = input.settledAt
          ? new Date(input.settledAt)
          : new Date();
        if (Number.isNaN(settledAt.getTime()))
          throw new ConflictException('Invalid settledAt timestamp');
        for (const leg of ticket.legs) {
          const resolved = input.resolvedLegs.find(
            (item) => item.legId === leg.legId,
          );
          if (!resolved)
            throw new ConflictException(
              `Settlement is missing ticket leg ${leg.legId}`,
            );
          const legSettledAt = resolved.settledAt
            ? new Date(resolved.settledAt)
            : settledAt;
          if (Number.isNaN(legSettledAt.getTime())) {
            throw new ConflictException(
              `Settlement supplied an invalid settledAt timestamp for ticket leg ${leg.legId}`,
            );
          }
          leg.status = resolved.status;
          leg.settlementOutcome = String(
            resolved.outcomeLabel ?? resolved.status,
          ).slice(0, 120);
          leg.settledAt = legSettledAt;
        }

        const ledgerType =
          input.ticketStatus === BetLabTicketStatus.VOID ||
          input.ticketStatus === BetLabTicketStatus.PUSH
            ? BetLabLedgerType.VOID_OR_PUSH_RETURN
            : BetLabLedgerType.SETTLEMENT_RETURN;
        await this.walletService.creditSettlementReturnInSession(
          wallet,
          ticket.userId,
          String(ticket._id),
          settlementId,
          input.grossReturn,
          ledgerType,
          session,
        );

        wallet.ticketsSettled += 1;
        if (input.ticketStatus === BetLabTicketStatus.WON)
          wallet.ticketsWon += 1;
        if (input.ticketStatus === BetLabTicketStatus.LOST)
          wallet.ticketsLost += 1;
        if (input.ticketStatus === BetLabTicketStatus.VOID)
          wallet.ticketsVoided += 1;
        if (input.ticketStatus === BetLabTicketStatus.PUSH)
          wallet.ticketsPushed += 1;
        if (input.ticketStatus === BetLabTicketStatus.PARTIALLY_WON)
          wallet.ticketsPartiallyWon += 1;
        if (input.ticketStatus === BetLabTicketStatus.PARTIALLY_LOST)
          wallet.ticketsPartiallyLost =
            Number(wallet.ticketsPartiallyLost ?? 0) + 1;
        await wallet.save({ session });

        ticket.status = input.ticketStatus;
        ticket.settlementId = settlementId;
        ticket.settlementFingerprint = settlementFingerprint;
        ticket.settledAt = settledAt;
        ticket.visibleUntil = new Date(
          settledAt.getTime() +
            BET_LAB_CONFIG.tickets.settledTicketRetentionDays *
              24 *
              60 *
              60 *
              1000,
        );
        ticket.settledGrossReturn = input.grossReturn;
        ticket.settlementNote = input.note?.slice(0, 500);
        await ticket.save({ session });

        result = {
          ticketId: String(ticket._id),
          status: ticket.status,
          grossReturn: input.grossReturn,
          alreadyApplied: false,
        };
        eventToWrite = {
          userId: ticket.userId,
          ticketNumber: ticket.ticketNumber,
          stake: Number(ticket.stake ?? 0),
        };
      });
    } finally {
      await session.endSession();
    }

    const finalResult = result as ApplyBetLabSettlementResult | null;
    const finalEvent = eventToWrite as {
      userId: string;
      ticketNumber: string;
      stake: number;
    } | null;
    if (!finalResult)
      throw new InternalServerErrorException(
        'Settlement integration did not produce a result',
      );
    if (finalEvent && !finalResult.alreadyApplied) {
      // These are post-commit integrations. A notification failure must never
      // make the caller believe that an already-settled ticket was rejected.
      try {
        await this.notificationEvents.betLabTicketSettled({
          userId: finalEvent.userId,
          ticketId: finalResult.ticketId,
          ticketNumber: finalEvent.ticketNumber,
          status: String(finalResult.status),
          stake: finalEvent.stake,
          grossReturn: finalResult.grossReturn,
        });
        if (finalResult.grossReturn > 0) {
          await this.notificationEvents.walletCredited({
            userId: finalEvent.userId,
            transactionId: `${finalResult.ticketId}:${settlementId}`,
            amount: finalResult.grossReturn,
            description: `Settlement return for Bet Lab ticket #${finalEvent.ticketNumber}.`,
            source: 'BET_LAB_SETTLEMENT',
          });
        }
      } catch {
        // NotificationEventsService is backed by its own idempotent event queue.
        // Failures here are operational and must not reverse settlement success.
      }
      await this.events.record({
        level: BetLabEventLevel.INFO,
        category: BetLabEventCategory.SETTLEMENT_INTEGRATION,
        action: 'BET_LAB_TICKET_SETTLED',
        message: `Settlement ${settlementId} applied to Bet Lab ticket ${finalEvent.ticketNumber}.`,
        userId: finalEvent.userId,
        metadata: {
          ticketId: finalResult.ticketId,
          status: finalResult.status,
          grossReturn: finalResult.grossReturn,
        },
      });
    }
    return finalResult;
  }

  private createSettlementFingerprint(
    input: ApplyBetLabSettlementInput,
    settlementId: string,
  ): string {
    const resolvedLegs = [...input.resolvedLegs]
      .map((leg) => ({
        legId: String(leg.legId ?? '').trim(),
        status: String(leg.status ?? '').trim(),
        outcomeLabel: String(leg.outcomeLabel ?? leg.status ?? '').trim(),
      }))
      .sort((left, right) => left.legId.localeCompare(right.legId));
    const canonical = {
      ticketId: String(input.ticketId).trim(),
      settlementId,
      ticketStatus: input.ticketStatus,
      grossReturn: input.grossReturn,
      outcome: input.outcome ?? null,
      note: String(input.note ?? '').slice(0, 500),
      resolvedLegs,
    };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  private validateResolvedLegs(
    ticketLegs: Array<{ legId: string }>,
    input: ApplyBetLabSettlementInput,
  ): void {
    const expected = new Set(ticketLegs.map((leg) => leg.legId));
    const received = new Set<string>();
    const allowedStatuses = new Set<string>(
      Object.values(BetLabLegStatus).filter(
        (status) => status !== BetLabLegStatus.OPEN,
      ),
    );
    for (const leg of input.resolvedLegs) {
      if (!leg.legId || !expected.has(leg.legId))
        throw new ConflictException(`Unknown ticket leg ${leg.legId}`);
      if (!allowedStatuses.has(String(leg.status))) {
        throw new ConflictException(
          `Settlement supplied an invalid resolved status for ticket leg ${leg.legId}`,
        );
      }
      if (received.has(leg.legId))
        throw new ConflictException(
          `Duplicate settlement result for ticket leg ${leg.legId}`,
        );
      received.add(leg.legId);
    }
    if (received.size !== expected.size)
      throw new ConflictException(
        'Settlement must provide a resolved outcome for every ticket leg',
      );
  }
}


