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
import { BetLabWalletService, type BetLabWalletSnapshot } from './bet-lab-wallet.service';
import { roundDecimal } from '../utils/odds.util';
import { findBetLabSelectionCompatibilityError } from '../utils/bet-lab-selection-compatibility.util';
import {
  buildBetLabFixturePricingModel,
  buildBetLabSelectionPricing,
  calculateBetLabSlipPricing,
  getBetLabPricingGroup,
  type BetLabPricingMarket,
  type BetLabSlipPricing,
} from '../utils/bet-lab-pricing.util';
import { AdminGateway } from '../../realtime/admin.gateway';
import { SettlementTriggerService } from '../../settlement/services/settlement-trigger.service';
import { NotificationEventsService } from '../../notifications/in-app/notification-events.service';
import { assertBetLabPreMatchFixture } from '../utils/fixture.util';
import {
  areBetLabOddsSnapshotsIdentical,
  BET_LAB_PRICING_SNAPSHOT_VERSION,
  createBetLabOddsSnapshotFingerprint,
  createBetLabTicketPricingSnapshotFingerprint,
} from '../utils/bet-lab-pricing-snapshot.util';

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
    private readonly notificationEvents: NotificationEventsService,
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
      const replay = {
        ticket: existing,
        alreadyPlaced: true,
        wallet: await this.getWalletSnapshotSafely(userId),
      };
      await this.afterTicketCommitted(userId, replay, [eventId]);
      return replay;
    }

    let placed: Awaited<ReturnType<BetLabTicketService['placeTicketAtomic']>>;
    try {
      const quotes = await this.resolveSelectionQuotes(requests);
      placed = await this.placeTicketAtomic(
        userId,
        BetLabTicketType.SINGLE,
        dto.stake,
        dto.idempotencyKey,
        fingerprint,
        quotes,
      );
    } catch (error) {
      await this.logPlacementFailure(userId, eventId, error);
      throw error;
    }

    // The ticket and stake debit have committed. Post-commit integrations are
    // best-effort and must never turn a successful placement into an API error.
    await this.afterTicketCommitted(userId, placed, [eventId]);
    return placed;
  }

  async placeSlip(userId: string, dto: PlaceBetLabSlipDto) {
    this.validateStake(dto.stake);
    if (
      !Array.isArray(dto.legs) ||
      dto.legs.length < BET_LAB_CONFIG.tickets.minimumAccumulatorLegs
    ) {
      throw new BadRequestException(
        `Accumulator slips must contain at least ${BET_LAB_CONFIG.tickets.minimumAccumulatorLegs} selections.`,
      );
    }
    const requests: BetLabSelectionRequest[] = dto.legs.map((leg) =>
      this.normalizeSelectionRequest({
        eventId: leg.eventId,
        marketCode: leg.marketCode,
        selectionCode: leg.selectionCode,
      }),
    );

    // Multiple compatible selections from the same fixture are valid. The
    // server rechecks the complete combination after resolving canonical
    // market selections, so clients cannot bypass contradiction validation.
    const eventIds = requests.map((request) => request.eventId);
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
    const targetEventIds = [...new Set(requests.map((item) => item.eventId))];
    if (existing) {
      const replay = {
        ticket: existing,
        alreadyPlaced: true,
        wallet: await this.getWalletSnapshotSafely(userId),
      };
      await this.afterTicketCommitted(userId, replay, targetEventIds);
      return replay;
    }

    let placed: Awaited<ReturnType<BetLabTicketService['placeTicketAtomic']>>;
    try {
      const quotes = await this.resolveSelectionQuotes(requests);
      const compatibilityError = findBetLabSelectionCompatibilityError(quotes);
      if (compatibilityError) throw new BadRequestException(compatibilityError);
      const pricing = await this.calculateSlipPricing(quotes);

      placed = await this.placeTicketAtomic(
        userId,
        BetLabTicketType.ACCUMULATOR,
        dto.stake,
        dto.idempotencyKey,
        fingerprint,
        quotes,
        pricing,
      );
    } catch (error) {
      await this.logPlacementFailure(
        userId,
        requests.map((item) => item.eventId).join(','),
        error,
      );
      throw error;
    }

    await this.afterTicketCommitted(userId, placed, targetEventIds);
    return placed;
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
    pricing?: BetLabSlipPricing,
  ) {
    this.validateStake(stake);
    if (!String(idempotencyKey ?? '').trim() || idempotencyKey.length > 120) {
      throw new ConflictException('A valid ticket idempotency key is required.');
    }
    if (!Array.isArray(quotes) || quotes.length === 0) {
      throw new ConflictException('A ticket requires at least one verified price.');
    }

    // Re-read the exact canonical prices immediately before the write transaction.
    // A stale boolean captured during the initial quote/pricing work is not enough
    // to authorise a later ticket write.
    const replayedBeforeRevalidation = await this.findExistingByIdempotency(
      userId,
      idempotencyKey,
      fingerprint,
    );
    if (replayedBeforeRevalidation) {
      return {
        ticket: replayedBeforeRevalidation,
        alreadyPlaced: true,
        wallet: await this.getWalletSnapshotSafely(userId),
      };
    }
    await this.revalidateSelectionQuotes(quotes);
    let verifiedPricing = pricing;
    if (pricing) {
      const currentPricing = await this.calculateSlipPricing(quotes);
      if (!this.areSlipPricingsEquivalent(currentPricing, pricing)) {
        throw new ConflictException(
          'Accumulator pricing changed while the ticket was being prepared. Refresh the slip and confirm the updated combined odds.',
        );
      }
      verifiedPricing = currentPricing;
    }

    const entitlement = await this.walletService.getCurrentEntitlement(userId);
    const allowanceNotificationWindowStart = new Date();
    const session = await this.ticketModel.db.startSession();
    let placedTicket: HydratedDocument<BetLabTicket> | null = null;
    let walletSnapshot: BetLabWalletSnapshot | null = null;
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
        // Mongoose may retry this callback after a transient transaction error.
        // Reset callback-scoped results so an aborted attempt cannot leak into
        // the response from a later attempt.
        placedTicket = null;
        walletSnapshot = null;
        alreadyPlaced = false;
        placementEvent = null;

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
          walletSnapshot = await this.walletService.getExistingWalletSnapshotInSession(
            userId,
            session,
          );
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
        const combinedOdds = verifiedPricing
          ? roundDecimal(verifiedPricing.combinedOdds, BET_LAB_CONFIG.odds.decimalPlaces)
          : this.calculateCombinedOdds(quotes.map((quote) => quote.decimalOdds));
        if (
          !Number.isFinite(combinedOdds) ||
          combinedOdds < BET_LAB_CONFIG.odds.minimumDecimalOdds
        ) {
          throw new BadRequestException('The combined selection price is invalid.');
        }
        const potentialReturn = Math.round(stake * combinedOdds);
        if (
          !Number.isSafeInteger(potentialReturn) ||
          potentialReturn > BET_LAB_CONFIG.virtualPoints.maximumPotentialReturn
        ) {
          throw new BadRequestException(
            'Potential return exceeds the configured virtual-point limit. Reduce the stake or choose a lower-odds selection.',
          );
        }
        // Re-read the complete Odds-approved quote set inside the transaction,
        // immediately before persisting the immutable ticket snapshots.
        await this.revalidateSelectionQuotes(quotes);
        if (verifiedPricing) {
          // Recheck correlated full-market inputs as well as the selected legs.
          // A non-selected quote can change the relationship adjustment while
          // all selected single prices remain unchanged.
          const finalPricing = await this.calculateSlipPricing(quotes);
          if (!this.areSlipPricingsEquivalent(finalPricing, verifiedPricing)) {
            throw new ConflictException(
              'Accumulator relationship pricing changed before the ticket could be committed. Refresh the slip and confirm the updated combined odds.',
            );
          }
          verifiedPricing = finalPricing;
        }
        const now = new Date();
        this.assertQuoteSnapshotsFresh(quotes, now);
        const ticketNumber = this.createTicketNumber();
        const adjustments = new Map(
          (verifiedPricing?.adjustments ?? []).map((adjustment) => [
            `${adjustment.eventId}:${adjustment.group}`,
            adjustment.factor,
          ]),
        );
        const adjustmentAssigned = new Set<string>();
        const legSnapshots = quotes.map((quote) => {
          const pricingGroup = getBetLabPricingGroup(String(quote.market.code));
          const adjustmentKey = pricingGroup
            ? `${quote.fixture.eventId}:${pricingGroup}`
            : '';
          const adjustment = adjustmentKey
            ? adjustments.get(adjustmentKey)
            : undefined;
          const assignAdjustment = adjustment !== undefined
            && !adjustmentAssigned.has(adjustmentKey);
          if (assignAdjustment) adjustmentAssigned.add(adjustmentKey);

          return {
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
            oddsRecordUpdatedAt: quote.oddsRecordUpdatedAt ?? undefined,
            oddsBasis: quote.oddsBasis ?? undefined,
            oddsCalculationMethod: quote.oddsCalculationMethod ?? undefined,
            fairOdds: quote.fairOdds ?? undefined,
            fairOddsBasis: quote.fairOddsBasis ?? undefined,
            marketFairOdds: quote.marketFairOdds ?? undefined,
            impliedProbability: quote.impliedProbability ?? undefined,
            fairProbability: quote.fairProbability ?? undefined,
            valuePercent: quote.valuePercent ?? undefined,
            dataQuality: quote.dataQuality ?? undefined,
            sampleSize: quote.sampleSize ?? undefined,
            calculationVersion: quote.calculationVersion ?? undefined,
            sourceRevision: quote.sourceRevision ?? undefined,
            fixtureSourceRevision: quote.fixtureSourceRevision ?? undefined,
            sourceDataUpdatedAt: quote.sourceDataUpdatedAt ?? undefined,
            provider: quote.provider ?? undefined,
            oddsFreshUntil: quote.oddsFreshUntil ?? undefined,
            oddsSnapshotFingerprint: createBetLabOddsSnapshotFingerprint(quote),
            ...(adjustment !== undefined && pricingGroup
              ? {
                  fixturePricingGroup: pricingGroup,
                  ...(assignAdjustment
                    ? { fixturePricingAdjustment: adjustment }
                    : {}),
                }
              : {}),
            status: BetLabLegStatus.OPEN,
          };
        });

        const pricingSnapshotFingerprint = createBetLabTicketPricingSnapshotFingerprint({
          ticketType,
          combinedOdds,
          legs: legSnapshots.map((leg) => ({
            oddsSnapshotFingerprint: leg.oddsSnapshotFingerprint,
            fixturePricingGroup: leg.fixturePricingGroup,
            fixturePricingAdjustment: leg.fixturePricingAdjustment,
          })),
        });
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
              pricingSnapshotVersion: BET_LAB_PRICING_SNAPSHOT_VERSION,
              pricingSnapshotFingerprint,
              pricingSnapshotCapturedAt: now,
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
        // Capture the post-debit wallet from the same transaction. A separate
        // read after commit must not turn a committed ticket into an API failure.
        walletSnapshot = this.walletService.toSnapshot(wallet);
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
            wallet: await this.getWalletSnapshotSafely(userId),
          };
        throw new ConflictException(
          'This request was already processed. Generate a new idempotency key for another ticket.',
        );
      }
      throw error;
    } finally {
      await session.endSession();
    }
    await this.walletService.dispatchRecentAllowanceNotifications(
      userId,
      allowanceNotificationWindowStart,
    );
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
    return {
      ticket: placedTicket,
      alreadyPlaced,
      wallet: walletSnapshot,
    };
  }

  private async getWalletSnapshotSafely(
    userId: string,
  ): Promise<BetLabWalletSnapshot | null> {
    try {
      return await this.walletService.getWallet(userId);
    } catch (error) {
      this.logger.warn(
        `Could not refresh Bet Lab wallet snapshot after ticket idempotency recovery for user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        return await this.walletService.getExistingWalletSnapshot(userId);
      } catch (fallbackError) {
        this.logger.error(
          `Could not read existing Bet Lab wallet snapshot for user ${userId}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        );
        return null;
      }
    }
  }

  private async afterTicketCommitted(
    userId: string,
    result: {
      ticket?: any;
      alreadyPlaced?: boolean;
      wallet?: { balance?: number } | null;
    },
    eventIds: string[],
  ): Promise<void> {
    try {
      await this.notifyTicketPlacement(userId, result);
    } catch (error) {
      this.logger.error(
        `Bet Lab placement notification failed for user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      await this.settlementTrigger.onTargetsCreated(
        [...new Set(eventIds.filter(Boolean))],
        'BET_LAB_TICKET_CREATED',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Settlement trigger could not be queued for committed Bet Lab ticket(s) belonging to user ${userId}: ${message}`,
      );
      try {
        await this.events.record({
          level: BetLabEventLevel.ERROR,
          category: BetLabEventCategory.SETTLEMENT_INTEGRATION,
          action: 'BET_LAB_TICKET_SETTLEMENT_TRIGGER_FAILED',
          message: message.slice(0, 2000),
          userId,
          metadata: { eventIds: [...new Set(eventIds.filter(Boolean))] },
        });
      } catch (eventError) {
        // Ticket placement and the wallet debit are already committed. A
        // secondary audit-event failure must not turn that success into an API
        // error; the recurring Settlement reconciliation will still recover it.
        this.logger.error(
          `Could not persist the Bet Lab settlement-handoff audit event for user ${userId}: ${eventError instanceof Error ? eventError.message : String(eventError)}`,
        );
      }
    }

    if (!result.alreadyPlaced && result.ticket) {
      try {
        this.adminGateway.publishModuleEvent(
          'bet-lab',
          'bet-lab:ticket-placed',
          {
            ticketId: String(result.ticket._id ?? ''),
            status: result.ticket.status,
            occurredAt: new Date().toISOString(),
          },
        );
      } catch (error) {
        this.logger.warn(
          `Admin realtime ticket event could not be published: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private areSlipPricingsEquivalent(
    left: BetLabSlipPricing,
    right: BetLabSlipPricing,
  ): boolean {
    const canonicalAdjustments = (items: BetLabSlipPricing['adjustments']) =>
      [...items]
        .map((item) => ({
          eventId: String(item.eventId),
          group: String(item.group),
          factor: Number(item.factor),
        }))
        .sort((a, b) => `${a.eventId}:${a.group}`.localeCompare(`${b.eventId}:${b.group}`));

    return left.combinedOdds === right.combinedOdds
      && JSON.stringify(canonicalAdjustments(left.adjustments))
        === JSON.stringify(canonicalAdjustments(right.adjustments));
  }

  private async revalidateSelectionQuotes(
    originalQuotes: Awaited<ReturnType<BetLabTicketService['resolveSelectionQuotes']>>,
  ): Promise<void> {
    const requests: BetLabSelectionRequest[] = originalQuotes.map((quote) => ({
      eventId: String(quote.fixture.eventId),
      marketCode: quote.market.code,
      selectionCode: String(quote.selection.code),
    }));
    const currentQuotes = await this.resolveSelectionQuotes(requests);
    if (currentQuotes.length !== originalQuotes.length) {
      throw new ConflictException(
        'The selected markets changed while the ticket was being prepared. Refresh the markets and try again.',
      );
    }

    for (let index = 0; index < originalQuotes.length; index += 1) {
      const original = originalQuotes[index];
      const current = currentQuotes[index];
      const unchanged = areBetLabOddsSnapshotsIdentical(original, current);

      if (!unchanged || current.isFresh !== true) {
        throw new ConflictException(
          'One or more Odds-approved prices, source revisions, market lines or fixture states changed while the ticket was being prepared. Refresh the markets and confirm the updated selections.',
        );
      }
    }
  }

  private assertQuoteSnapshotsFresh(
    quotes: Awaited<ReturnType<BetLabTicketService['resolveSelectionQuotes']>>,
    now: Date,
  ): void {
    for (const quote of quotes) {
      if (quote.isFresh !== true) {
        throw new ConflictException(
          'One or more selection prices became stale before the ticket could be committed. Refresh the markets and try again.',
        );
      }

      const odds = Number(quote.decimalOdds);
      if (
        !Number.isFinite(odds) ||
        odds < BET_LAB_CONFIG.odds.minimumDecimalOdds ||
        odds > BET_LAB_CONFIG.odds.maximumDecimalOdds
      ) {
        throw new ConflictException(
          'One or more selection prices are no longer valid.',
        );
      }

      if (quote.oddsFreshUntil) {
        const freshUntil = new Date(quote.oddsFreshUntil);
        if (
          Number.isNaN(freshUntil.getTime()) ||
          freshUntil.getTime() <= now.getTime()
        ) {
          throw new ConflictException(
            'One or more selection prices expired before the ticket could be committed. Refresh the markets and try again.',
          );
        }
      }

      assertBetLabPreMatchFixture(quote.fixture, now);
    }
  }

  private async notifyTicketPlacement(
    userId: string,
    result: {
      ticket?: any;
      alreadyPlaced?: boolean;
      wallet?: { balance?: number } | null;
    },
  ): Promise<void> {
    if (result.alreadyPlaced || !result.ticket) return;
    const ticket = result.ticket;
    const ticketId = String(ticket._id ?? '');
    if (!ticketId) return;
    await this.notificationEvents.betLabTicketPlaced({
      userId,
      ticketId,
      ticketNumber: String(ticket.ticketNumber ?? ticketId),
      ticketType: String(ticket.ticketType ?? 'SINGLE'),
      stake: Number(ticket.stake ?? 0),
      combinedOdds: Number(ticket.combinedOdds ?? 0),
      potentialReturn: Number(ticket.potentialReturn ?? 0),
      selectionCount: Array.isArray(ticket.legs) ? ticket.legs.length : 1,
    });
    await this.notificationEvents.walletDebited({
      userId,
      transactionId: ticketId,
      amount: Number(ticket.stake ?? 0),
      balanceAfter: Number(result.wallet?.balance ?? 0),
      description: `Stake for Bet Lab ticket #${String(ticket.ticketNumber ?? ticketId)}.`,
      source: 'BET_LAB_STAKE',
    });
  }

  private resolveSelectionQuotes(requests: BetLabSelectionRequest[]) {
    return this.marketService.getSelectionQuotes(requests);
  }

  /**
   * Builds the same relationship-aware accumulator price shown by the frontend.
   * Only fixtures with at least two selections in a correlated pricing group
   * need the complete market snapshot; unrelated markets remain independent.
   */
  private async calculateSlipPricing(
    quotes: Awaited<ReturnType<BetLabTicketService['resolveSelectionQuotes']>>,
  ): Promise<BetLabSlipPricing> {
    const quotesByEvent = new Map<string, typeof quotes>();
    for (const quote of quotes) {
      const eventId = String(quote.fixture.eventId);
      const group = quotesByEvent.get(eventId) ?? [];
      group.push(quote);
      quotesByEvent.set(eventId, group);
    }

    const pricingEventIds = [...quotesByEvent.entries()]
      .filter(([, fixtureQuotes]) => fixtureQuotes.filter(
        (quote) => getBetLabPricingGroup(String(quote.market.code)) === 'MATCH',
      ).length > 1)
      .map(([eventId]) => eventId);

    const snapshots = await Promise.all(
      pricingEventIds.map(async (eventId) => {
        const snapshot = await this.marketService.getMarketsForFixture(eventId);
        const selectedQuotes = quotesByEvent.get(eventId) ?? [];
        const selectedByKey = new Map(
          selectedQuotes.map((quote) => [
            `${quote.market.code}:${quote.selection.code}`,
            quote,
          ]),
        );
        const markets: BetLabPricingMarket[] = snapshot.markets.map((market) => ({
          code: String(market.code),
          selections: market.selections.map((selection) => {
            const selectedQuote = selectedByKey.get(
              `${market.code}:${selection.code}`,
            );
            return selectedQuote
              ? {
                  ...selection,
                  decimalOdds: selectedQuote.decimalOdds,
                  fairProbability: selectedQuote.fairProbability,
                  impliedProbability: selectedQuote.impliedProbability,
                  available: true,
                  isStale: false,
                }
              : selection;
          }),
        }));
        const model = buildBetLabFixturePricingModel(markets);
        return [eventId, { markets, model }] as const;
      }),
    );
    const snapshotByEvent = new Map(snapshots);

    const pricingPicks = quotes.map((quote) => {
      const eventId = String(quote.fixture.eventId);
      const snapshot = snapshotByEvent.get(eventId);
      const pricing = snapshot
        ? buildBetLabSelectionPricing(
            snapshot.markets,
            String(quote.market.code),
            String(quote.selection.code),
            quote.decimalOdds,
            snapshot.model,
          )
        : undefined;
      return {
        eventId,
        marketCode: String(quote.market.code),
        selectionCode: String(quote.selection.code),
        odds: quote.decimalOdds,
        pricing,
      };
    });

    return calculateBetLabSlipPricing(pricingPicks);
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
      if (!Number.isFinite(combined)) {
        throw new BadRequestException(
          'Combined odds exceed the supported numeric range.',
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








