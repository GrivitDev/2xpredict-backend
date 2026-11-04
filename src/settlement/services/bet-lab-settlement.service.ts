import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BetLabTicket } from '../../bet-lab/schemas/bet-lab-ticket.schema';
import { BetLabLegStatus } from '../../bet-lab/enums/bet-lab-leg-status.enum';
import { BetLabTicketStatus } from '../../bet-lab/enums/bet-lab-ticket-status.enum';
import { BetLabSettlementOutcome } from '../../bet-lab/enums/bet-lab-settlement-outcome.enum';
import { BetLabSettlementAdapterService } from '../../bet-lab/services/bet-lab-settlement-adapter.service';
import {
  SettlementEventFacts,
  SettlementTargetCounts,
  SettlementSelectionInput,
} from '../interfaces/settlement-context.interface';
import { SettlementOutcome } from '../enums/settlement-outcome.enum';
import { MarketSettlementService } from './market-settlement.service';
import { SettlementEventLogService } from './settlement-event-log.service';
import { SettlementEventLevel } from '../enums/settlement-event-level.enum';

interface BetLabSettlementLeg {
  eventId: unknown;
  status: BetLabLegStatus;
  matchSettlementStatus?: BetLabLegStatus;
  subjectTeamId?: unknown;
  subjectId?: unknown;
  subjectName?: unknown;
  selectionCode?: unknown;
  settlementKey?: unknown;
  selectionJsonVariable?: unknown;
  selectionFullName?: unknown;
  selectionAbbreviation?: unknown;
  line?: unknown;
  handicap?: unknown;
  homeGoals?: unknown;
  awayGoals?: unknown;
  marketCode?: unknown;
  settlementOutcome?: unknown;
  settledAt?: unknown;
  settlementMethod?: unknown;
  settlementNote?: unknown;
  decimalOdds?: unknown;
  fixturePricingGroup?: unknown;
  fixturePricingAdjustment?: unknown;
  legId?: unknown;
}

interface BetLabSettlementTicket {
  legs: BetLabSettlementLeg[];
  status: BetLabTicketStatus;
  settledAt?: unknown;
  settlementId?: unknown;
  settlementNote?: unknown;
  stake: unknown;
  _id: unknown;
  ticketNumber?: unknown;
}

@Injectable()
export class BetLabSettlementService {
  private readonly logger = new Logger(BetLabSettlementService.name);

  constructor(
    @InjectModel(BetLabTicket.name)
    private readonly ticketModel: Model<BetLabTicket>,
    private readonly marketSettlementService: MarketSettlementService,
    private readonly adapter: BetLabSettlementAdapterService,
    private readonly eventLog: SettlementEventLogService,
  ) {}

  async settleEvent(
    eventId: string,
    facts: SettlementEventFacts,
    settlementId: string,
    counts: SettlementTargetCounts,
    unresolvedReasons: string[],
  ): Promise<void> {
    const tickets = (await this.ticketModel
      .find({
        'legs.eventId': eventId,
        status: {
          $in: [BetLabTicketStatus.OPEN, BetLabTicketStatus.PENDING_SETTLEMENT],
        },
        // Include pending tickets even when this event's last leg was persisted
        // before a worker crash. The retry still needs to run aggregate/payout
        // finalization even if there are no OPEN legs left for this event.
      })
      .exec()) as unknown as BetLabSettlementTicket[];
    counts.betLabTicketsFound += tickets.length;

    for (const originalTicket of tickets) {
      const ticketId = this.asString(originalTicket._id);
      if (!ticketId) continue;

      for (const leg of originalTicket.legs) {
        if (
          this.asString(leg.eventId) !== eventId ||
          leg.status !== BetLabLegStatus.OPEN
        ) continue;

        const legId = this.asString(leg.legId);
        if (!legId) {
          counts.betLabLegsUnresolved += 1;
          const reason = `BET_LAB/${this.asString(leg.marketCode)}/${this.asString(leg.selectionCode)}: ticket leg has no stable legId and was not settled.`;
          if (unresolvedReasons.length < 100 && !unresolvedReasons.includes(reason)) unresolvedReasons.push(reason);
          continue;
        }

        const selection: SettlementSelectionInput = {
          key: this.asString(leg.selectionCode ?? leg.settlementKey ?? ''),
          code: this.asString(leg.selectionCode ?? ''),
          settlementKey: this.asString(leg.settlementKey ?? leg.selectionCode ?? ''),
          jsonVariable: this.asString(leg.selectionJsonVariable ?? ''),
          fullName: this.asString(leg.selectionFullName ?? ''),
          abbreviation: this.asString(leg.selectionAbbreviation ?? ''),
          line: typeof leg.line === 'number' ? leg.line : undefined,
          handicap: typeof leg.handicap === 'number' ? leg.handicap : undefined,
          homeGoals: typeof leg.homeGoals === 'number' ? leg.homeGoals : undefined,
          awayGoals: typeof leg.awayGoals === 'number' ? leg.awayGoals : undefined,
          subjectId: typeof leg.subjectId === 'string' ? leg.subjectId : undefined,
          subjectName: typeof leg.subjectName === 'string' ? leg.subjectName : undefined,
          subjectTeamId: typeof leg.subjectTeamId === 'string' ? leg.subjectTeamId : undefined,
        };
        const result = this.marketSettlementService.settle(
          this.asString(leg.marketCode),
          selection,
          facts,
        );
        if (result.outcome === SettlementOutcome.UNRESOLVED) {
          counts.betLabLegsUnresolved += 1;
          const reason = `BET_LAB/${this.asString(leg.marketCode)}/${this.asString(leg.selectionCode)}: ${result.reason ?? 'insufficient settlement evidence'}`;
          if (unresolvedReasons.length < 100 && !unresolvedReasons.includes(reason)) unresolvedReasons.push(reason);
          continue;
        }

        const update = await this.ticketModel.updateOne(
          {
            _id: originalTicket._id,
            status: { $in: [BetLabTicketStatus.OPEN, BetLabTicketStatus.PENDING_SETTLEMENT] },
            legs: { $elemMatch: { eventId, legId, status: BetLabLegStatus.OPEN } },
          },
          {
            $set: {
              'legs.$.status': this.toBetLabLegStatus(result.outcome),
              'legs.$.settlementOutcome': result.outcome,
              'legs.$.settledAt': new Date(),
              'legs.$.settlementMethod': result.method,
              'legs.$.settlementNote': result.reason ?? undefined,
              status: BetLabTicketStatus.PENDING_SETTLEMENT,
            },
          },
        ).exec();

        if ((update.modifiedCount ?? 0) > 0) {
          counts.betLabLegsSettled += 1;
        }
      }

      // Re-read current ticket state and update only the per-match summary fields.
      // Individual leg outcomes are atomic writes, so parallel jobs for different
      // fixtures cannot silently overwrite each other's array changes.
      const ticket = await this.refreshMatchStatuses(ticketId);
      if (!ticket || !Array.isArray(ticket.legs) || ticket.legs.length === 0) continue;
      const legs = ticket.legs;
      const allLegsResolved = legs.every((item) => this.isResolvedLegStatus(item.status));
      if (!allLegsResolved) {
        if (ticket.status === BetLabTicketStatus.OPEN) {
          await this.ticketModel.updateOne(
            { _id: ticket._id, status: BetLabTicketStatus.OPEN },
            { $set: { status: BetLabTicketStatus.PENDING_SETTLEMENT } },
          ).exec();
        }
        continue;
      }

      // A second event job may have finalized this accumulator while this one was
      // running. Never attempt a second wallet credit after terminal state.
      const terminalStatuses = [
        BetLabTicketStatus.WON,
        BetLabTicketStatus.LOST,
        BetLabTicketStatus.VOID,
        BetLabTicketStatus.PUSH,
        BetLabTicketStatus.PARTIALLY_WON,
        BetLabTicketStatus.PARTIALLY_LOST,
        BetLabTicketStatus.CANCELLED,
      ];
      if (terminalStatuses.includes(ticket.status)) continue;
      if (ticket.settledAt || (typeof ticket.settlementId === 'string' && ticket.settlementId.trim())) continue;

      const payout = this.calculateTicketReturn(Number(ticket.stake), legs);
      const status = this.calculateTicketStatus(Number(ticket.stake), payout.grossReturn, legs);
      const ticketSettlementId = `SETTLEMENT:${settlementId}:${ticketId}`.slice(0, 159);
      const resolvedLegs = legs.map((item) => ({
        legId: this.asString(item.legId),
        status: this.toAdapterLegStatus(this.asString(item.status)),
        outcomeLabel: this.asString(item.settlementOutcome ?? item.status),
        settledAt: this.asDate(item.settledAt, new Date()),
      }));

      try {
        const result = await this.adapter.applyResolvedTicket({
          ticketId,
          settlementId: ticketSettlementId,
          ticketStatus: status,
          grossReturn: payout.grossReturn,
          resolvedLegs,
          settledAt: new Date(),
          outcome: this.toOverallOutcome(status),
          note: `Settled by event-triggered Settlement worker. Partial-line outcomes: ${payout.partialOutcomes}.`,
        });
        if (!result.alreadyApplied) counts.betLabTicketsFinalized += 1;
      } catch (error) {
        // Another event job may have committed the ticket transaction first. The
        // adapter guarantees one wallet credit; a terminal ticket means this job
        // should treat the competing finalization as idempotent success.
        const latest = (await this.ticketModel.findById(ticketId).lean().exec()) as any;
        const latestTerminal = latest && [
          BetLabTicketStatus.WON,
          BetLabTicketStatus.LOST,
          BetLabTicketStatus.VOID,
          BetLabTicketStatus.PUSH,
          BetLabTicketStatus.PARTIALLY_WON,
          BetLabTicketStatus.PARTIALLY_LOST,
          BetLabTicketStatus.CANCELLED,
        ].includes(latest.status);
        if (latestTerminal && latest.settlementId && latest.settledAt) continue;
        this.logger.error(
          `Failed to finalize Bet Lab ticket ${this.asString(ticket.ticketNumber ?? ticket._id)} after event ${eventId}: ${this.errorMessage(error)}`,
        );
        throw error;
      }
    }
  }

  async listOverdueOpenLegs(query: {
    olderThanHours?: number;
    page?: number;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    const olderThanHours = Math.max(
      0,
      Math.min(720, Number(query.olderThanHours ?? 3.5) || 0),
    );
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const limit = Math.max(
      1,
      Math.min(200, Math.floor(Number(query.limit) || 50)),
    );
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60_000);

    const result = (await this.ticketModel
      .aggregate([
        {
          $match: {
            status: {
              $in: [
                BetLabTicketStatus.OPEN,
                BetLabTicketStatus.PENDING_SETTLEMENT,
              ],
            },
          },
        },
        { $unwind: '$legs' },
        {
          $match: {
            'legs.status': BetLabLegStatus.OPEN,
            'legs.fixtureDate': { $lte: cutoff },
          },
        },
        { $sort: { 'legs.fixtureDate': 1, placedAt: 1 } },
        {
          $facet: {
            items: [
              { $skip: (page - 1) * limit },
              { $limit: limit },
              {
                $project: {
                  _id: 0,
                  ticketId: { $toString: '$_id' },
                  ticketNumber: 1,
                  userId: 1,
                  ticketStatus: '$status',
                  ticketType: 1,
                  stake: 1,
                  placedAt: 1,
                  leg: '$legs',
                },
              },
            ],
            total: [{ $count: 'count' }],
          },
        },
      ])
      .exec()) as unknown as Array<{
      items: Array<{
        [key: string]: unknown;
        leg: { [key: string]: unknown; fixtureDate?: unknown };
      }>;
      total: Array<{ count: number }>;
    }>;

    const items = result[0]?.items ?? [];
    return {
      items: items.map((item) => ({
        ...item,
        overdueHours: Math.max(
          0,
          Math.round(
            ((Date.now() - this.asDate(item.leg.fixtureDate).getTime()) /
              36_00_000) *
              100,
          ) / 100,
        ),
      })),
      page,
      limit,
      total: result[0]?.total?.[0]?.count ?? 0,
      olderThanHours,
      cutoff,
    };
  }

  /**
   * Admin-only override for one unresolved Bet Lab leg when provider evidence
   * remains unavailable. Wallet credit still goes through the transactional,
   * idempotent adapter and only happens once every ticket leg is resolved.
   */
  async manuallySettleLeg(input: {
    ticketId: string;
    legId: string;
    outcome: SettlementOutcome;
    reason: string;
    adminId?: string;
  }): Promise<Record<string, unknown>> {
    const ticketId = String(input.ticketId ?? '').trim();
    const legId = String(input.legId ?? '').trim();
    if (!/^[0-9a-fA-F]{24}$/.test(ticketId)) throw new BadRequestException('Invalid Bet Lab ticket ID.');
    if (!legId) throw new BadRequestException('A valid ticket leg ID is required.');

    const allowedManualOutcomes = new Set<string>([
      SettlementOutcome.WON,
      SettlementOutcome.LOST,
      SettlementOutcome.VOID,
      SettlementOutcome.PUSH,
      SettlementOutcome.HALF_WON,
      SettlementOutcome.HALF_LOST,
    ]);
    if (!allowedManualOutcomes.has(String(input.outcome))) {
      throw new BadRequestException(
        'Manual settlement requires a resolved outcome: WON, LOST, VOID, PUSH, HALF_WON or HALF_LOST.',
      );
    }

    const reason = String(input.reason ?? '').trim();
    if (reason.length < 5 || reason.length > 500) {
      throw new BadRequestException('A settlement reason of 5–500 characters is required.');
    }

    let ticket = (await this.ticketModel.findById(ticketId).exec()) as unknown as BetLabSettlementTicket | null;
    if (!ticket) throw new NotFoundException('Bet Lab ticket was not found.');
    const leg = ticket.legs.find((item) => this.asString(item.legId) === legId);
    if (!leg) throw new NotFoundException('Bet Lab ticket leg was not found.');
    const targetStatus = this.toBetLabLegStatus(input.outcome);
    const terminalStatuses = [
      BetLabTicketStatus.WON,
      BetLabTicketStatus.LOST,
      BetLabTicketStatus.VOID,
      BetLabTicketStatus.PUSH,
      BetLabTicketStatus.PARTIALLY_WON,
      BetLabTicketStatus.PARTIALLY_LOST,
      BetLabTicketStatus.CANCELLED,
    ];
    const matchingManualOutcome =
      leg.settlementMethod === 'MANUAL_ADMIN' &&
      leg.status === targetStatus &&
      this.asString(leg.settlementOutcome) === input.outcome &&
      this.asString(leg.settlementNote) === reason;

    if (terminalStatuses.includes(ticket.status)) {
      if (matchingManualOutcome) {
        return {
          success: true,
          ticketId,
          ticketNumber: ticket.ticketNumber,
          legId,
          outcome: leg.settlementOutcome,
          ticketStatus: ticket.status,
          grossReturn: Number((ticket as unknown as { settledGrossReturn?: number }).settledGrossReturn ?? 0),
          finalized: true,
          alreadyApplied: true,
        };
      }
      throw new ConflictException('This Bet Lab ticket is already in a terminal state.');
    }

    let newlyApplied = false;
    if (leg.status === BetLabLegStatus.OPEN) {
      const manualNote = reason;
      const update = await this.ticketModel.updateOne(
        {
          _id: ticketId,
          status: { $in: [BetLabTicketStatus.OPEN, BetLabTicketStatus.PENDING_SETTLEMENT] },
          legs: { $elemMatch: { legId, status: BetLabLegStatus.OPEN } },
        },
        {
          $set: {
            'legs.$.status': targetStatus,
            'legs.$.settlementOutcome': input.outcome,
            'legs.$.settlementMethod': 'MANUAL_ADMIN',
            'legs.$.settlementNote': manualNote,
            'legs.$.settledAt': new Date(),
            status: BetLabTicketStatus.PENDING_SETTLEMENT,
            settlementNote: `Manual leg settlement by ${input.adminId ?? 'admin'}: ${reason}`.slice(0, 500),
          },
        },
      ).exec();
      newlyApplied = (update.modifiedCount ?? 0) > 0;
      if (!newlyApplied) {
        const refreshed = (await this.ticketModel.findById(ticketId).exec()) as unknown as BetLabSettlementTicket | null;
        if (!refreshed) throw new NotFoundException('Bet Lab ticket was not found.');
        ticket = refreshed;
        const currentLeg = ticket.legs.find((item) => this.asString(item.legId) === legId);
        const alreadyApplied = currentLeg?.settlementMethod === 'MANUAL_ADMIN' &&
          currentLeg.status === targetStatus &&
          this.asString(currentLeg.settlementOutcome) === input.outcome &&
          this.asString(currentLeg.settlementNote) === reason;
        if (!alreadyApplied) {
          throw new ConflictException('This leg changed while manual settlement was being applied. Refresh the ticket and retry.');
        }
      }
    } else if (!matchingManualOutcome) {
      throw new ConflictException('This leg is already settled. Manual settlement cannot overwrite an existing result.');
    }

    ticket = await this.refreshMatchStatuses(ticketId);
    if (!ticket) throw new NotFoundException('Bet Lab ticket was not found after settlement update.');
    const currentLeg = ticket.legs.find((item) => this.asString(item.legId) === legId);
    if (!currentLeg || currentLeg.status !== targetStatus || this.asString(currentLeg.settlementOutcome) !== input.outcome) {
      throw new ConflictException('The requested manual result was not persisted; reload the ticket before retrying.');
    }
    const allResolved = ticket.legs.length > 0 && ticket.legs.every((item) => this.isResolvedLegStatus(item.status));
    const adminId = String(input.adminId ?? 'admin').trim() || 'admin';

    if (!allResolved) {
      await this.ticketModel.updateOne(
        { _id: ticketId, status: BetLabTicketStatus.OPEN },
        { $set: { status: BetLabTicketStatus.PENDING_SETTLEMENT } },
      ).exec();
      if (newlyApplied) {
        await this.eventLog.write({
          level: SettlementEventLevel.WARN,
          action: 'BET_LAB_LEG_MANUALLY_SETTLED',
          message: `Bet Lab leg ${legId} was manually settled; ticket remains pending other legs.`,
          eventId: this.asString(currentLeg.eventId),
          metadata: { ticketId, ticketNumber: ticket.ticketNumber, legId, outcome: input.outcome, reason, adminId, ticketFinalized: false },
        });
      }
      return {
        success: true,
        ticketId,
        ticketNumber: ticket.ticketNumber,
        legId,
        outcome: input.outcome,
        ticketStatus: BetLabTicketStatus.PENDING_SETTLEMENT,
        finalized: false,
        alreadyApplied: !newlyApplied,
      };
    }

    const payout = this.calculateTicketReturn(Number(ticket.stake), ticket.legs);
    const status = this.calculateTicketStatus(Number(ticket.stake), payout.grossReturn, ticket.legs);
    const settlementId = `MANUAL:${ticketId}:${legId}`.slice(0, 159);
    const resolvedLegs = ticket.legs.map((item) => ({
      legId: this.asString(item.legId),
      status: this.toAdapterLegStatus(this.asString(item.status)),
      outcomeLabel: this.asString(item.settlementOutcome ?? item.status),
      settledAt: this.asDate(item.settledAt, new Date()),
    }));

    let result: Awaited<ReturnType<BetLabSettlementAdapterService['applyResolvedTicket']>>;
    try {
      result = await this.adapter.applyResolvedTicket({
        ticketId,
        settlementId,
        ticketStatus: status,
        grossReturn: payout.grossReturn,
        resolvedLegs,
        settledAt: new Date(),
        outcome: this.toOverallOutcome(status),
        note: `Manually settled by ${adminId}. Reason: ${reason}. Partial-line outcomes: ${payout.partialOutcomes}.`,
      });
    } catch (error) {
      // Another event/manual worker may have won the finalization race. If this
      // exact leg result is persisted and the ticket is now terminal, treat the
      // retried action as idempotent; never issue a second wallet credit.
      const latest = (await this.ticketModel.findById(ticketId).exec()) as unknown as BetLabSettlementTicket | null;
      const latestLeg = latest?.legs.find((item) => this.asString(item.legId) === legId);
      if (latest && terminalStatuses.includes(latest.status) &&
          latestLeg?.settlementMethod === 'MANUAL_ADMIN' &&
          latestLeg.status === targetStatus &&
          this.asString(latestLeg.settlementOutcome) === input.outcome &&
          this.asString(latestLeg.settlementNote) === reason) {
        return {
          success: true,
          ticketId,
          ticketNumber: latest.ticketNumber,
          legId,
          outcome: input.outcome,
          ticketStatus: latest.status,
          grossReturn: Number((latest as unknown as { settledGrossReturn?: number }).settledGrossReturn ?? 0),
          finalized: true,
          alreadyApplied: true,
        };
      }
      throw error;
    }

    if (newlyApplied) {
      await this.eventLog.write({
        level: SettlementEventLevel.WARN,
        action: 'BET_LAB_TICKET_MANUALLY_FINALIZED',
        message: `Bet Lab ticket ${this.asString(ticket.ticketNumber ?? ticketId)} was manually finalized.`,
        eventId: this.asString(currentLeg.eventId),
        metadata: { ticketId, ticketNumber: ticket.ticketNumber, legId, outcome: input.outcome, reason, adminId, ticketStatus: result.status, grossReturn: result.grossReturn, alreadyApplied: result.alreadyApplied },
      });
    }

    return {
      success: true,
      ticketId,
      ticketNumber: ticket.ticketNumber,
      legId,
      outcome: input.outcome,
      ticketStatus: result.status,
      grossReturn: result.grossReturn,
      finalized: true,
      alreadyApplied: result.alreadyApplied || !newlyApplied,
    };
  }

  private async refreshMatchStatuses(ticketId: string): Promise<BetLabSettlementTicket | null> {
    const initial = (await this.ticketModel.findById(ticketId).exec()) as unknown as BetLabSettlementTicket | null;
    if (!initial) return null;
    const groups = new Map<string, BetLabSettlementLeg[]>();
    for (const leg of initial.legs ?? []) {
      const eventId = this.asString(leg.eventId);
      if (!eventId) continue;
      const group = groups.get(eventId) ?? [];
      group.push(leg);
      groups.set(eventId, group);
    }
    for (const [eventId, legs] of groups) {
      const matchStatus = this.aggregateBetLabMatchStatus(legs.map((item) => item.status));
      // Match aggregates only move from OPEN to a resolved state. Never allow a
      // stale read from a concurrent fixture job to revert a final match result.
      if (matchStatus === BetLabLegStatus.OPEN) continue;
      await this.ticketModel.updateOne(
        {
          _id: ticketId,
          legs: { $elemMatch: { eventId, matchSettlementStatus: { $in: [BetLabLegStatus.OPEN, null] } } },
        },
        { $set: { 'legs.$[leg].matchSettlementStatus': matchStatus } },
        { arrayFilters: [{ 'leg.eventId': eventId, 'leg.matchSettlementStatus': { $in: [BetLabLegStatus.OPEN, null] } }] },
      ).exec();
    }
    return (await this.ticketModel.findById(ticketId).exec()) as unknown as BetLabSettlementTicket | null;
  }

  private aggregateBetLabMatchStatus(statuses: BetLabLegStatus[]): BetLabLegStatus {
    if (!statuses.length) return BetLabLegStatus.OPEN;
    if (statuses.includes(BetLabLegStatus.LOST)) return BetLabLegStatus.LOST;
    if (statuses.includes(BetLabLegStatus.OPEN)) return BetLabLegStatus.OPEN;
    if (statuses.some((status) => !this.isResolvedLegStatus(status))) return BetLabLegStatus.OPEN;
    if (statuses.includes(BetLabLegStatus.HALF_LOST)) return BetLabLegStatus.HALF_LOST;
    if (statuses.includes(BetLabLegStatus.HALF_WON)) return BetLabLegStatus.HALF_WON;
    if (statuses.every((status) => status === BetLabLegStatus.VOID)) return BetLabLegStatus.VOID;
    if (statuses.every((status) => status === BetLabLegStatus.VOID || status === BetLabLegStatus.PUSH)) return BetLabLegStatus.PUSH;
    return BetLabLegStatus.WON;
  }

  private isResolvedLegStatus(status: BetLabLegStatus): boolean {
    return [
      BetLabLegStatus.WON,
      BetLabLegStatus.LOST,
      BetLabLegStatus.VOID,
      BetLabLegStatus.PUSH,
      BetLabLegStatus.HALF_WON,
      BetLabLegStatus.HALF_LOST,
    ].includes(status);
  }

  private calculateTicketReturn(
    stake: number,
    legs: BetLabSettlementLeg[],
  ): { grossReturn: number; partialOutcomes: number } {
    let multiplier = 1;
    let partialOutcomes = 0;
    for (const leg of legs) {
      const odds = Number(leg.decimalOdds);
      switch (leg.status) {
        case BetLabLegStatus.WON:
          multiplier *= odds;
          break;
        case BetLabLegStatus.VOID:
        case BetLabLegStatus.PUSH:
          multiplier *= 1;
          break;
        case BetLabLegStatus.HALF_WON:
          multiplier *= (odds + 1) / 2;
          partialOutcomes += 1;
          break;
        case BetLabLegStatus.HALF_LOST:
          multiplier *= 0.5;
          partialOutcomes += 1;
          break;
        case BetLabLegStatus.LOST:
          return { grossReturn: 0, partialOutcomes };
        default:
          throw new Error(
            `Cannot calculate accumulator return with unresolved leg status ${this.asString(leg.status)}`,
          );
      }
      if (!Number.isFinite(multiplier) || multiplier < 0)
        throw new Error('Calculated ticket return is invalid.');
    }
    // Correlated selections were priced together when the ticket was created.
    // Apply each relationship adjustment once, but only while every selection
    // in that group is a full win. A push/void removes that leg and restores the
    // remaining selections to their individual quoted prices.
    const pricingGroups = new Map<
      string,
      { legs: BetLabSettlementLeg[]; adjustment?: number }
    >();
    for (const leg of legs) {
      const group = String(leg.fixturePricingGroup ?? '').toUpperCase();
      const eventId = this.asString(leg.eventId);
      if (!eventId || !['MATCH', 'SCORE', 'SHOTS'].includes(group)) continue;
      const key = `${eventId}:${group}`;
      const entry = pricingGroups.get(key) ?? { legs: [] };
      entry.legs.push(leg);
      const adjustment = Number(leg.fixturePricingAdjustment);
      if (Number.isFinite(adjustment) && adjustment > 0) {
        entry.adjustment = adjustment;
      }
      pricingGroups.set(key, entry);
    }
    for (const entry of pricingGroups.values()) {
      if (
        entry.adjustment !== undefined &&
        entry.legs.length > 1 &&
        entry.legs.every((leg) => leg.status === BetLabLegStatus.WON)
      ) {
        multiplier *= entry.adjustment;
      }
    }

    const grossReturn = Math.round(stake * multiplier);
    if (!Number.isSafeInteger(grossReturn) || grossReturn < 0)
      throw new Error(
        'Calculated ticket return is outside the safe virtual-point range.',
      );
    return { grossReturn, partialOutcomes };
  }

  private calculateTicketStatus(
    stake: number,
    grossReturn: number,
    legs: BetLabSettlementLeg[],
  ):
    | BetLabTicketStatus.WON
    | BetLabTicketStatus.LOST
    | BetLabTicketStatus.VOID
    | BetLabTicketStatus.PUSH
    | BetLabTicketStatus.PARTIALLY_WON
    | BetLabTicketStatus.PARTIALLY_LOST {
    const statuses = legs.map((leg) => leg.status);
    if (statuses.every((status) => status === BetLabLegStatus.VOID))
      return BetLabTicketStatus.VOID;
    if (statuses.every((status) => status === BetLabLegStatus.PUSH))
      return BetLabTicketStatus.PUSH;
    if (grossReturn === 0) return BetLabTicketStatus.LOST;
    if (grossReturn < stake) return BetLabTicketStatus.PARTIALLY_LOST;
    if (grossReturn === stake) return BetLabTicketStatus.PUSH;
    if (
      statuses.some(
        (status) =>
          status === BetLabLegStatus.HALF_WON ||
          status === BetLabLegStatus.HALF_LOST,
      )
    )
      return BetLabTicketStatus.PARTIALLY_WON;
    return BetLabTicketStatus.WON;
  }

  private toBetLabLegStatus(outcome: SettlementOutcome): BetLabLegStatus {
    switch (outcome) {
      case SettlementOutcome.WON:
        return BetLabLegStatus.WON;
      case SettlementOutcome.LOST:
        return BetLabLegStatus.LOST;
      case SettlementOutcome.VOID:
        return BetLabLegStatus.VOID;
      case SettlementOutcome.PUSH:
        return BetLabLegStatus.PUSH;
      case SettlementOutcome.HALF_WON:
        return BetLabLegStatus.HALF_WON;
      case SettlementOutcome.HALF_LOST:
        return BetLabLegStatus.HALF_LOST;
      default:
        throw new Error(
          `Cannot store unresolved outcome ${outcome} on a Bet Lab leg.`,
        );
    }
  }

  private toAdapterLegStatus(
    value: string,
  ): Exclude<BetLabLegStatus, BetLabLegStatus.OPEN> {
    const normalized = this.asString(value);
    const allowedStatuses = Object.values(BetLabLegStatus) as string[];
    if (
      allowedStatuses.includes(normalized) &&
      normalized !== String(BetLabLegStatus.OPEN)
    )
      return normalized as Exclude<BetLabLegStatus, BetLabLegStatus.OPEN>;
    throw new Error(`Invalid resolved Bet Lab leg status ${normalized}`);
  }

  private toOverallOutcome(
    status:
      | BetLabTicketStatus.WON
      | BetLabTicketStatus.LOST
      | BetLabTicketStatus.VOID
      | BetLabTicketStatus.PUSH
      | BetLabTicketStatus.PARTIALLY_WON
      | BetLabTicketStatus.PARTIALLY_LOST,
  ): BetLabSettlementOutcome {
    switch (status) {
      case BetLabTicketStatus.WON:
        return BetLabSettlementOutcome.WON;
      case BetLabTicketStatus.LOST:
        return BetLabSettlementOutcome.LOST;
      case BetLabTicketStatus.VOID:
        return BetLabSettlementOutcome.VOID;
      case BetLabTicketStatus.PUSH:
        return BetLabSettlementOutcome.PUSH;
      case BetLabTicketStatus.PARTIALLY_WON:
        return BetLabSettlementOutcome.PARTIALLY_WON;
      case BetLabTicketStatus.PARTIALLY_LOST:
        return BetLabSettlementOutcome.PARTIALLY_LOST;
      default:
        throw new Error(
          `Unsupported Bet Lab overall status: ${this.asString(status)}`,
        );
    }
  }

  private asString(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    )
      return String(value);
    return '';
  }

  private asDate(value: unknown, fallback = new Date()): Date {
    if (value instanceof Date) return value;
    if (typeof value === 'string' || typeof value === 'number') {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return new Date(fallback);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : this.asString(error);
  }
}


