import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type HydratedDocument } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import { BET_LAB_CONFIG } from '../config/bet-lab.config';
import { BET_LAB_MARKET_BY_CODE } from '../catalog/bet-lab-market-catalog';
import {
  BetLabEventCategory,
  BetLabEventLevel,
} from '../enums/bet-lab-event.enum';
import { BetLabLegStatus } from '../enums/bet-lab-leg-status.enum';
import { BetLabTicketStatus } from '../enums/bet-lab-ticket-status.enum';
import { BetLabTicketType } from '../enums/bet-lab-ticket-type.enum';
import { BetLabSelectionRequest } from '../interfaces/bet-lab-market.interface';
import { BetLabMarketCode } from '../enums/bet-lab-market-code.enum';
import { BetLabTicket } from '../schemas/bet-lab-ticket.schema';
import { BetLabWalletLedger } from '../schemas/bet-lab-wallet-ledger.schema';
import { PlaceBetLabTicketDto } from '../dto/place-bet-lab-ticket.dto';
import { PlaceBetLabSlipDto } from '../dto/place-bet-lab-slip.dto';
import { BetLabEventService } from './bet-lab-event.service';
import { BetLabMarketService } from './bet-lab-market.service';
import { BetLabWalletService } from './bet-lab-wallet.service';
import { roundDecimal } from '../utils/odds.util';
import { AdminGateway } from '../../realtime/admin.gateway';
import { SettlementTriggerService } from '../../settlement/services/settlement-trigger.service';

@Injectable()
export class BetLabTicketService {
  private readonly logger = new Logger(BetLabTicketService.name);

  constructor(
    @InjectModel(BetLabTicket.name)
    private readonly ticketModel: Model<BetLabTicket>,
    @InjectModel(BetLabWalletLedger.name)
    private readonly ledgerModel: Model<BetLabWalletLedger>,
    private readonly marketService: BetLabMarketService,
    private readonly walletService: BetLabWalletService,
    private readonly events: BetLabEventService,
    private readonly adminGateway: AdminGateway,
    @Inject(forwardRef(() => SettlementTriggerService))
    private readonly settlementTrigger: SettlementTriggerService,
  ) {}

  async placeSingle(userId: string, dto: PlaceBetLabTicketDto) {
    this.validateStake(dto.stake);
    const requests: BetLabSelectionRequest[] = [
      this.normalizeSelectionRequest({
        eventId: dto.eventId,
        marketCode: dto.marketCode,
        selectionCode: dto.selectionCode,
      }),
    ];
    const eventId = requests[0].eventId;
    const fingerprint = this.fingerprint(
      BetLabTicketType.SINGLE,
      dto.stake,
      requests,
    );
    const existing = await this.findExistingByIdempotency(
      userId,
      dto.idempotencyKey,
      fingerprint,
    );
    if (existing) {
      await this.settlementTrigger.onTargetsCreated(
        [eventId],
        'BET_LAB_TICKET_CREATED',
      );
      return {
        ticket: existing,
        alreadyPlaced: true,
        wallet: await this.walletService.getWallet(userId),
      };
    }

    try {
      const quotes = await this.resolveSelectionQuotes(requests);
      const ticket = await this.placeTicketAtomic(
        userId,
        BetLabTicketType.SINGLE,
        dto.stake,
        dto.idempotencyKey,
        fingerprint,
        quotes,
      );
      await this.settlementTrigger.onTargetsCreated([eventId], 'BET_LAB_TICKET_CREATED');
      this.adminGateway.publishModuleEvent('bet-lab', 'bet-lab:ticket-placed', { ticketId: String((ticket as any)?.ticket?._id ?? ''), status: (ticket as any)?.ticket?.status, occurredAt: new Date().toISOString() });
      return ticket;
    } catch (error) {
      await this.logPlacementFailure(userId, eventId, error);
      throw error;
    }
  }

  async placeSlip(userId: string, dto: PlaceBetLabSlipDto) {
    this.validateStake(dto.stake);
    if (
      !Array.isArray(dto.legs) ||
      dto.legs.length < BET_LAB_CONFIG.tickets.minimumAccumulatorLegs ||
      dto.legs.length > BET_LAB_CONFIG.tickets.maximumAccumulatorLegs
    ) {
      throw new BadRequestException(
        `Accumulator slips must contain ${BET_LAB_CONFIG.tickets.minimumAccumulatorLegs}–${BET_LAB_CONFIG.tickets.maximumAccumulatorLegs} selections.`,
      );
    }
    const requests: BetLabSelectionRequest[] = dto.legs.map((leg) =>
      this.normalizeSelectionRequest({
        eventId: leg.eventId,
        marketCode: leg.marketCode,
        selectionCode: leg.selectionCode,
      }),
    );

    // Standard accumulators are independently priced across separate fixtures.
    // A same-match combination has correlated outcomes and cannot safely use
    // multiplied standalone prices. It must wait for a true joint-priced
    // Bet Builder rather than silently overstate a ticket's odds.
    const eventIds = requests.map((request) => request.eventId);
    if (new Set(eventIds).size !== eventIds.length) {
      throw new BadRequestException(
        'Ordinary accumulators allow only one selection per match. Same-match combinations require a separately joint-priced Bet Builder.',
      );
    }
    const fingerprint = this.fingerprint(
      BetLabTicketType.ACCUMULATOR,
      dto.stake,
      requests,
    );
    const existing = await this.findExistingByIdempotency(
      userId,
      dto.idempotencyKey,
      fingerprint,
    );
    if (existing) {
      await this.settlementTrigger.onTargetsCreated(
        [...new Set(requests.map((item) => item.eventId))],
        'BET_LAB_TICKET_CREATED',
      );
      return {
        ticket: existing,
        alreadyPlaced: true,
        wallet: await this.walletService.getWallet(userId),
      };
    }

    try {
      const quotes = await this.resolveSelectionQuotes(requests);
      const ticket = await this.placeTicketAtomic(
        userId,
        BetLabTicketType.ACCUMULATOR,
        dto.stake,
        dto.idempotencyKey,
        fingerprint,
        quotes,
      );
      await this.settlementTrigger.onTargetsCreated(
        [...new Set(requests.map((item) => item.eventId))],
        'BET_LAB_TICKET_CREATED',
      );
      this.adminGateway.publishModuleEvent('bet-lab', 'bet-lab:ticket-placed', { ticketId: String((ticket as any)?.ticket?._id ?? ''), status: (ticket as any)?.ticket?.status, occurredAt: new Date().toISOString() });
      return ticket;
    } catch (error) {
      await this.logPlacementFailure(
        userId,
        requests.map((item) => item.eventId).join(','),
        error,
      );
      throw error;
    }
  }

  async listTickets(
    userId: string,
    query: { status?: BetLabTicketStatus; page?: number; limit?: number },
  ) {
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const limit = Math.min(
      BET_LAB_CONFIG.monitor.maximumHistoryPageSize,
      Math.max(
        1,
        Math.floor(
          Number(query.limit) || BET_LAB_CONFIG.monitor.defaultHistoryPageSize,
        ),
      ),
    );
    const now = new Date();
    const filter: Record<string, unknown> = {
      userId,
      $or: [
        { visibleUntil: { $exists: false } },
        { visibleUntil: { $gt: now } },
      ],
    };
    if (query.status) filter.status = query.status;
    const [items, total] = await Promise.all([
      this.ticketModel
        .find(filter)
        .sort({ placedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.ticketModel.countDocuments(filter).exec(),
    ]);
    return {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async getTicket(userId: string, ticketId: string) {
    if (!/^[a-f\d]{24}$/i.test(ticketId))
      throw new BadRequestException('Invalid ticket ID');
    const ticket = await this.ticketModel
      .findOne({ _id: ticketId, userId })
      .lean()
      .exec();
    if (!ticket) throw new NotFoundException('Bet Lab ticket was not found');
    if (
      ticket.visibleUntil &&
      new Date(ticket.visibleUntil).getTime() <= Date.now()
    ) {
      throw new NotFoundException(
        'This settled ticket has expired from the normal history',
      );
    }
    return ticket;
  }

  private async placeTicketAtomic(
    userId: string,
    ticketType: BetLabTicketType,
    stake: number,
    idempotencyKey: string,
    fingerprint: string,
    quotes: Awaited<ReturnType<BetLabTicketService['resolveSelectionQuotes']>>,
  ) {
    const entitlement = await this.walletService.getCurrentEntitlement(userId);
    const session = await this.ticketModel.db.startSession();
    let placedTicket: HydratedDocument<BetLabTicket> | null = null;
    let alreadyPlaced = false;
    let placementEvent: {
      ticketId: string;
      ticketNumber: string;
      stake: number;
      combinedOdds: number;
      potentialReturn: number;
      selectionCount: number;
    } | null = null;
    try {
      await session.withTransaction(async () => {
        const existing = await this.ticketModel
          .findOne({ userId, idempotencyKey })
          .session(session)
          .exec();
        if (existing) {
          if (existing.requestFingerprint !== fingerprint) {
            throw new ConflictException(
              'This idempotency key was already used for a different ticket.',
            );
          }
          placedTicket = existing;
          alreadyPlaced = true;
          return;
        }

        const oldLedgerEntry = await this.ledgerModel
          .findOne({
            userId,
            idempotencyKey: this.stakeLedgerKey(idempotencyKey),
          })
          .session(session)
          .exec();
        if (oldLedgerEntry) {
          throw new ConflictException(
            'This idempotency key was already used. Generate a new key for a new ticket.',
          );
        }

        const wallet = await this.walletService.ensureWalletInSession(
          userId,
          entitlement,
          session,
        );
        const combinedOdds = this.calculateCombinedOdds(
          quotes.map((quote) => quote.decimalOdds),
        );
        const potentialReturn = Math.round(stake * combinedOdds);
        if (
          !Number.isSafeInteger(potentialReturn) ||
          potentialReturn > BET_LAB_CONFIG.virtualPoints.maximumPotentialReturn
        ) {
          throw new BadRequestException(
            'Potential return exceeds the configured virtual-point limit. Reduce the stake or choose a lower-odds selection.',
          );
        }
        const now = new Date();
        const ticketNumber = this.createTicketNumber();
        const legSnapshots = quotes.map((quote) => ({
          legId: randomUUID(),
          eventId: quote.fixture.eventId,
          leagueId: quote.fixture.leagueId,
          leagueName: quote.fixture.leagueName,
          fixtureDate: quote.fixture.fixtureDate,
          homeTeamId: quote.fixture.homeTeamId,
          homeTeamName: quote.fixture.homeTeamName,
          awayTeamId: quote.fixture.awayTeamId,
          awayTeamName: quote.fixture.awayTeamName,
          marketCode: quote.market.code,
          marketJsonVariable: quote.market.jsonVariable,
          marketFullName: quote.market.fullName,
          marketAbbreviation: quote.market.abbreviation,
          selectionCode: quote.selection.code,
          selectionJsonVariable: quote.selection.jsonVariable,
          selectionFullName: quote.selection.fullName,
          selectionAbbreviation: quote.selection.abbreviation,
          settlementKey: quote.selection.settlementKey || quote.selection.code,
          line: quote.selection.line,
          handicap: quote.selection.handicap,
          homeGoals: quote.selection.homeGoals,
          awayGoals: quote.selection.awayGoals,
          subjectId: quote.selection.subjectId,
          subjectName: quote.selection.subjectName,
          subjectTeamId: quote.selection.subjectTeamId,
          decimalOdds: quote.decimalOdds,
          oddsSource: quote.oddsSource,
          priceType: quote.priceType,
          bookmaker: quote.bookmaker ?? undefined,
          providerUpdatedAt: quote.providerUpdatedAt ?? undefined,
          oddsTimestampBasis: quote.oddsTimestampBasis,
          oddsCapturedAt: quote.oddsCapturedAt,
          oddsBasis: quote.oddsBasis ?? undefined,
          oddsCalculationMethod: quote.oddsCalculationMethod ?? undefined,
          status: BetLabLegStatus.OPEN,
        }));
        const created = await this.ticketModel.create(
          [
            {
              userId,
              ticketNumber,
              ticketType,
              status: BetLabTicketStatus.OPEN,
              stake,
              combinedOdds,
              potentialReturn,
              potentialProfit: potentialReturn - stake,
              legs: legSnapshots,
              idempotencyKey,
              requestFingerprint: fingerprint,
              placedAt: now,
              settledGrossReturn: 0,
            },
          ],
          { session },
        );
        const createdTicket = created[0];
        placedTicket = createdTicket;
        await this.walletService.debitStakeInSession(
          wallet,
          userId,
          String(createdTicket._id),
          stake,
          this.stakeLedgerKey(idempotencyKey),
          session,
        );
        placementEvent = {
          ticketId: String(createdTicket._id),
          ticketNumber,
          stake,
          combinedOdds,
          potentialReturn,
          selectionCount: quotes.length,
        };
      });
    } catch (error) {
      if (this.isDuplicateKey(error)) {
        const existing = await this.findExistingByIdempotency(
          userId,
          idempotencyKey,
          fingerprint,
        );
        if (existing)
          return {
            ticket: existing,
            alreadyPlaced: true,
            wallet: await this.walletService.getWallet(userId),
          };
        throw new ConflictException(
          'This request was already processed. Generate a new idempotency key for another ticket.',
        );
      }
      throw error;
    } finally {
      await session.endSession();
    }
    if (!placedTicket)
      throw new ConflictException('Ticket could not be placed');
    if (placementEvent && !alreadyPlaced) {
      await this.events.record({
        level: BetLabEventLevel.INFO,
        category: BetLabEventCategory.TICKET,
        action: 'TICKET_PLACED',
        message: `${ticketType} ticket placed successfully.`,
        userId,
        metadata: placementEvent,
      });
    }
    const wallet = await this.walletService.getWallet(userId);
    return {
      ticket: placedTicket,
      alreadyPlaced,
      wallet,
    };
  }

  private resolveSelectionQuotes(requests: BetLabSelectionRequest[]) {
    return this.marketService.getSelectionQuotes(requests);
  }

  private normalizeSelectionRequest(
    request: BetLabSelectionRequest,
  ): BetLabSelectionRequest {
    const eventId = String(request.eventId ?? '').trim();
    const selectionCode = String(request.selectionCode ?? '').trim();
    if (!eventId || !selectionCode) {
      throw new BadRequestException(
        'Every selection must include a valid fixture and selection code.',
      );
    }
    if (!BET_LAB_MARKET_BY_CODE.has(request.marketCode)) {
      throw new BadRequestException(
        `Unsupported Bet Lab market code: ${String(request.marketCode)}.`,
      );
    }
    return { eventId, marketCode: request.marketCode as BetLabMarketCode, selectionCode };
  }

  private calculateCombinedOdds(prices: number[]): number {
    if (!prices.length)
      throw new BadRequestException(
        'A ticket must contain at least one selection.',
      );
    let combined = 1;
    for (const price of prices) {
      if (
        !Number.isFinite(price) ||
        price < BET_LAB_CONFIG.odds.minimumDecimalOdds ||
        price > BET_LAB_CONFIG.odds.maximumDecimalOdds
      ) {
        throw new BadRequestException(
          'One or more selections have invalid odds.',
        );
      }
      combined *= price;
      if (
        !Number.isFinite(combined) ||
        combined > BET_LAB_CONFIG.tickets.maximumCombinedOdds
      ) {
        throw new BadRequestException(
          'Combined odds exceed the configured limit.',
        );
      }
    }
    return roundDecimal(combined, BET_LAB_CONFIG.odds.decimalPlaces);
  }

  private validateStake(stake: number): void {
    if (
      !Number.isSafeInteger(stake) ||
      stake < BET_LAB_CONFIG.virtualPoints.minimumStake ||
      stake > BET_LAB_CONFIG.virtualPoints.maximumStake
    ) {
      throw new BadRequestException(
        'Stake must be a positive whole number of virtual points.',
      );
    }
  }

  private fingerprint(
    type: BetLabTicketType,
    stake: number,
    requests: BetLabSelectionRequest[],
  ): string {
    const normalized = {
      type,
      stake,
      // Preserve submitted leg order in the idempotency fingerprint. This
      // keeps retries compatible with tickets created before this stage.
      selections: requests.map((request) => ({
        eventId: String(request.eventId).trim(),
        marketCode: request.marketCode,
        selectionCode: String(request.selectionCode).trim(),
      })),
    };
    return JSON.stringify(normalized);
  }

  private async findExistingByIdempotency(
    userId: string,
    key: string,
    fingerprint: string,
  ) {
    const existing = await this.ticketModel
      .findOne({ userId, idempotencyKey: key })
      .lean()
      .exec();
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new ConflictException(
          'This idempotency key was already used for a different ticket.',
        );
      }
      return existing;
    }
    const ledger = await this.ledgerModel
      .findOne({
        userId,
        idempotencyKey: this.stakeLedgerKey(key),
      })
      .lean()
      .exec();
    if (ledger)
      throw new ConflictException(
        'This idempotency key has already been consumed. Generate a new key for a new ticket.',
      );
    return null;
  }

  private stakeLedgerKey(key: string): string {
    return `TICKET_STAKE:${key}`;
  }

  private createTicketNumber(): string {
    return `BL-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`;
  }

  private async logPlacementFailure(
    userId: string,
    eventId: string,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(
      `Bet Lab ticket placement rejected for user ${userId}: ${message}`,
    );
    await this.events.record({
      level: BetLabEventLevel.WARN,
      category: BetLabEventCategory.TICKET,
      action: 'TICKET_PLACEMENT_REJECTED',
      message,
      userId,
      eventId,
    });
  }

  private isDuplicateKey(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 11000,
    );
  }
}


