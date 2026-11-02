import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BET_LAB_CONFIG } from '../config/bet-lab.config';
import { BET_LAB_MARKET_CATALOG } from '../catalog/bet-lab-market-catalog';
import { BetLabEvent } from '../schemas/bet-lab-event.schema';
import { BetLabTicket } from '../schemas/bet-lab-ticket.schema';
import { BetLabWallet } from '../schemas/bet-lab-wallet.schema';
import { BetLabWalletLedger } from '../schemas/bet-lab-wallet-ledger.schema';
import { EspnFixture } from '../../sports/schemas/espn/espn-fixture.schema';

type WalletTotals = {
  totalBalance: number;
  totalWelcomeBalance: number;
  totalMonthlyBalance: number;
  totalWinningsBalance: number;
  totalBonusBalance: number;
  totalStaked: number;
  totalReturns: number;
  netProfitLoss: number;
  lifetimeTicketsPlaced: number;
  lifetimeTicketsSettled: number;
  lifetimeTicketsWon: number;
  lifetimeTicketsLost: number;
};

type MonitorQueryFailure = {
  check: string;
  message: string;
};

type MonitorCheck = {
  name: string;
  status: 'OK' | 'DEGRADED' | 'UNKNOWN';
  message: string;
};

type MonitorEvent = Pick<
  BetLabEvent,
  'action' | 'level' | 'message' | 'metadata'
> & { createdAt: Date };

@Injectable()
export class BetLabMonitorService {
  constructor(
    @InjectModel(BetLabWallet.name)
    private readonly walletModel: Model<BetLabWallet>,
    @InjectModel(BetLabWalletLedger.name)
    private readonly ledgerModel: Model<BetLabWalletLedger>,
    @InjectModel(BetLabTicket.name)
    private readonly ticketModel: Model<BetLabTicket>,
    @InjectModel(BetLabEvent.name)
    private readonly eventModel: Model<BetLabEvent>,
    @InjectModel(EspnFixture.name)
    private readonly fixtureModel: Model<EspnFixture>,
  ) {}

  /**
   * Read-only operational overview. Individual queries fail independently so a
   * failed diagnostic does not erase every other useful monitoring result.
   * This service must never create, update, settle, or delete business records.
   */
  async getOverview() {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const upcomingFilter = {
      fixtureDate: {
        $gte: now,
        $lt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
      },
      live: false,
      completed: { $ne: true },
    };

    const failures: MonitorQueryFailure[] = [];
    const checks: MonitorCheck[] = [];

    const safeQuery = async <T>(
      check: string,
      operation: () => Promise<T>,
      fallback: T,
    ): Promise<T> => {
      try {
        const value = await operation();
        checks.push({
          name: check,
          status: 'OK',
          message: 'Query completed successfully.',
        });
        return value;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ check, message: message.slice(0, 500) });
        checks.push({
          name: check,
          status: 'DEGRADED',
          message: 'Query failed. See diagnostics for details.',
        });
        return fallback;
      }
    };

    const [
      walletCount,
      walletTotalsResult,
      ticketCount,
      ticketStatusRows,
      ledgerCount,
      ledgerTypeRows,
      upcomingFixtureCount,
      fixturesWithSummaryCount,
      fixturesWithAnyOddsCount,
      retentionDueCount,
      errorEvents24h,
      rejectedPlacements24h,
      inconsistentWalletCount,
      recentEvents,
      marketVolumeRows,
      walletsByPlanRows,
      eventLevelRows,
      eventCategoryRows,
      lastSettlementEvent,
      lastRetentionEvent,
      openTicketCount,
      ticketsMissingSettlementId,
    ] = await Promise.all([
      safeQuery(
        'wallet.count',
        () => this.walletModel.countDocuments({}).exec(),
        0,
      ),
      safeQuery(
        'wallet.totals',
        () =>
          this.walletModel
            .aggregate<WalletTotals>([
              {
                $group: {
                  _id: null,
                  totalBalance: { $sum: '$balance' },
                  totalWelcomeBalance: { $sum: '$welcomeBalance' },
                  totalMonthlyBalance: { $sum: '$monthlyBalance' },
                  totalWinningsBalance: { $sum: '$winningsBalance' },
                  totalBonusBalance: { $sum: '$bonusBalance' },
                  totalStaked: { $sum: '$totalStaked' },
                  totalReturns: { $sum: '$totalReturns' },
                  netProfitLoss: { $sum: '$netProfitLoss' },
                  lifetimeTicketsPlaced: { $sum: '$ticketsPlaced' },
                  lifetimeTicketsSettled: { $sum: '$ticketsSettled' },
                  lifetimeTicketsWon: { $sum: '$ticketsWon' },
                  lifetimeTicketsLost: { $sum: '$ticketsLost' },
                },
              },
            ])
            .exec(),
        [],
      ),
      safeQuery(
        'tickets.count',
        () => this.ticketModel.countDocuments({}).exec(),
        0,
      ),
      safeQuery(
        'tickets.statusBreakdown',
        () =>
          this.ticketModel
            .aggregate([
              {
                $group: {
                  _id: '$status',
                  count: { $sum: 1 },
                  stakePoints: { $sum: '$stake' },
                  potentialReturnPoints: { $sum: '$potentialReturn' },
                },
              },
              { $sort: { count: -1 } },
            ])
            .exec(),
        [],
      ),
      safeQuery(
        'ledger.count',
        () => this.ledgerModel.countDocuments({}).exec(),
        0,
      ),
      safeQuery(
        'ledger.transactionBreakdown',
        () =>
          this.ledgerModel
            .aggregate([
              {
                $group: {
                  _id: '$transactionType',
                  count: { $sum: 1 },
                  totalDelta: { $sum: '$delta' },
                },
              },
              { $sort: { count: -1 } },
            ])
            .exec(),
        [],
      ),
      safeQuery(
        'fixtures.upcomingCount',
        () => this.fixtureModel.countDocuments(upcomingFilter).exec(),
        0,
      ),
      safeQuery(
        'fixtures.withSummary',
        () =>
          this.fixtureModel
            .countDocuments({
              ...upcomingFilter,
              'payload.summary': { $exists: true, $ne: null },
            })
            .exec(),
        0,
      ),
      safeQuery(
        'fixtures.withOdds',
        () =>
          this.fixtureModel
            .countDocuments({
              ...upcomingFilter,
              $or: [
                {
                  'payload.summary.pickcenter.0': { $exists: true, $ne: null },
                },
                { 'payload.summary.odds.0': { $exists: true, $ne: null } },
                {
                  'payload.competitions.0.odds.0': { $exists: true, $ne: null },
                },
              ],
            })
            .exec(),
        0,
      ),
      safeQuery(
        'tickets.retentionDue',
        () =>
          this.ticketModel
            .countDocuments({
              status: {
                $in: [
                  'WON',
                  'LOST',
                  'VOID',
                  'PUSH',
                  'PARTIALLY_WON',
                  'PARTIALLY_LOST',
                  'CANCELLED',
                ] as BetLabTicket['status'][],
              },
              visibleUntil: { $lte: now },
            })
            .exec(),
        0,
      ),
      safeQuery(
        'events.errors24h',
        () =>
          this.eventModel
            .countDocuments({
              level: 'ERROR' as BetLabEvent['level'],
              createdAt: { $gte: dayAgo },
            })
            .exec(),
        0,
      ),
      safeQuery(
        'tickets.rejectedPlacements24h',
        () =>
          this.eventModel
            .countDocuments({
              action: 'TICKET_PLACEMENT_REJECTED',
              createdAt: { $gte: dayAgo },
            })
            .exec(),
        0,
      ),
      safeQuery(
        'wallet.balanceInvariants',
        () =>
          this.walletModel
            .aggregate<{ count: number }>([
              {
                $match: {
                  $expr: {
                    $ne: [
                      '$balance',
                      {
                        $add: [
                          '$welcomeBalance',
                          '$monthlyBalance',
                          '$winningsBalance',
                          { $ifNull: ['$bonusBalance', 0] },
                        ],
                      },
                    ],
                  },
                },
              },
              { $count: 'count' },
            ])
            .exec(),
        [],
      ),
      safeQuery(
        'events.recent',
        () =>
          this.eventModel
            .find()
            .sort({ createdAt: -1 })
            .limit(BET_LAB_CONFIG.monitor.recentEventsLimit)
            .lean()
            .exec(),
        [],
      ),
      safeQuery(
        'tickets.marketVolume',
        () =>
          this.ticketModel
            .aggregate([
              { $unwind: '$legs' },
              {
                $group: {
                  _id: '$legs.marketCode',
                  selectionCount: { $sum: 1 },
                  ticketStakeExposurePoints: { $sum: '$stake' },
                },
              },
              { $sort: { selectionCount: -1 } },
            ])
            .exec(),
        [],
      ),
      safeQuery(
        'wallets.byAllowancePlan',
        () =>
          this.walletModel
            .aggregate([
              {
                $group: {
                  _id: '$monthlyAllowancePlan',
                  walletCount: { $sum: 1 },
                  activeBalance: { $sum: '$balance' },
                  monthlyCreditsRemaining: { $sum: '$monthlyBalance' },
                },
              },
              { $sort: { walletCount: -1 } },
            ])
            .exec(),
        [],
      ),
      safeQuery(
        'events.levelBreakdown24h',
        () =>
          this.eventModel
            .aggregate([
              { $match: { createdAt: { $gte: dayAgo } } },
              { $group: { _id: '$level', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ])
            .exec(),
        [],
      ),
      safeQuery(
        'events.categoryBreakdown24h',
        () =>
          this.eventModel
            .aggregate([
              { $match: { createdAt: { $gte: dayAgo } } },
              { $group: { _id: '$category', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ])
            .exec(),
        [],
      ),
      safeQuery(
        'settlement.lastEvent',
        () =>
          this.eventModel
            .findOne({
              category: 'SETTLEMENT_INTEGRATION' as BetLabEvent['category'],
            })
            .sort({ createdAt: -1 })
            .lean<MonitorEvent>()
            .exec(),
        null,
      ),
      safeQuery(
        'retention.lastEvent',
        () =>
          this.eventModel
            .findOne({ category: 'RETENTION' as BetLabEvent['category'] })
            .sort({ createdAt: -1 })
            .lean<MonitorEvent>()
            .exec(),
        null,
      ),
      safeQuery(
        'tickets.openCount',
        () =>
          this.ticketModel
            .countDocuments({
              status: {
                $in: ['OPEN', 'PENDING_SETTLEMENT'] as BetLabTicket['status'][],
              },
            })
            .exec(),
        0,
      ),
      safeQuery(
        'tickets.missingSettlementId',
        () =>
          this.ticketModel
            .countDocuments({
              status: {
                $in: [
                  'WON',
                  'LOST',
                  'VOID',
                  'PUSH',
                  'PARTIALLY_WON',
                  'PARTIALLY_LOST',
                ] as BetLabTicket['status'][],
              },
              $or: [
                { settlementId: { $exists: false } },
                { settlementId: null },
                { settlementId: '' },
              ],
            })
            .exec(),
        0,
      ),
    ]);

    const walletTotals = walletTotalsResult[0] ?? {
      totalBalance: 0,
      totalWelcomeBalance: 0,
      totalMonthlyBalance: 0,
      totalWinningsBalance: 0,
      totalBonusBalance: 0,
      totalStaked: 0,
      totalReturns: 0,
      netProfitLoss: 0,
      lifetimeTicketsPlaced: 0,
      lifetimeTicketsSettled: 0,
      lifetimeTicketsWon: 0,
      lifetimeTicketsLost: 0,
    };

    const walletInconsistencies = inconsistentWalletCount[0]?.count ?? 0;
    const databaseReady = Number(this.walletModel.db.readyState) === 1;
    const schemaCoverage = [
      this.describeModel('BetLabWallet', this.walletModel),
      this.describeModel('BetLabWalletLedger', this.ledgerModel),
      this.describeModel('BetLabTicket', this.ticketModel),
      this.describeModel('BetLabEvent', this.eventModel),
      this.describeModel('EspnFixture', this.fixtureModel),
    ];

    checks.unshift({
      name: 'database.connection',
      status: databaseReady ? 'OK' : 'DEGRADED',
      message: databaseReady
        ? 'The Bet Lab MongoDB connection is ready.'
        : `MongoDB connection is not ready (Mongoose readyState=${this.walletModel.db.readyState}).`,
    });

    const overallStatus =
      !databaseReady || failures.length > 0 || walletInconsistencies > 0
        ? 'DEGRADED'
        : 'OK';

    const warnings: string[] = [];
    if (walletInconsistencies > 0) {
      warnings.push(
        `${walletInconsistencies} wallet balance invariant violation(s) detected.`,
      );
    }
    if (failures.length > 0) {
      warnings.push(`${failures.length} monitoring query/check(s) failed.`);
    }
    if (errorEvents24h > 0) {
      warnings.push(
        `${errorEvents24h} ERROR event(s) were recorded in the last 24 hours.`,
      );
    }
    if (ticketsMissingSettlementId > 0) {
      warnings.push(
        `${ticketsMissingSettlementId} resolved ticket(s) have no settlement ID; review before assuming they are invalid.`,
      );
    }

    return {
      generatedAt: now,
      health: {
        status: overallStatus,
        databaseConnected: databaseReady,
        walletBalanceInconsistencies: walletInconsistencies,
        systemErrorsLast24Hours: errorEvents24h,
        ticketPlacementsRejectedLast24Hours: rejectedPlacements24h,
        checks,
        warnings,
      },
      diagnostics: {
        failedChecks: failures,
        successfulChecks: checks.filter((check) => check.status === 'OK')
          .length,
        degradedChecks: checks.filter((check) => check.status === 'DEGRADED')
          .length,
        schemaCoverage,
        serviceInventory: this.getServiceInventory(),
        controllerInventory: this.getControllerInventory(),
      },
      usersAndWallets: {
        wallets: walletCount,
        balanceByCreditSource: {
          totalAvailablePoints: walletTotals.totalBalance,
          welcomePointsRemaining: walletTotals.totalWelcomeBalance,
          monthlyPointsRemaining: walletTotals.totalMonthlyBalance,
          winningsPointsRemaining: walletTotals.totalWinningsBalance,
          bonusPointsRemaining: walletTotals.totalBonusBalance,
        },
        bySubscriptionAllowancePlan: walletsByPlanRows,
      },
      tickets: {
        currentlyStoredTicketDocuments: ticketCount,
        statuses: ticketStatusRows,
        openTickets: openTicketCount,
        resolvedTicketsMissingSettlementId: ticketsMissingSettlementId,
        lifetimeTicketsPlaced: walletTotals.lifetimeTicketsPlaced,
        lifetimeTicketsSettled: walletTotals.lifetimeTicketsSettled,
        lifetimeTicketsWon: walletTotals.lifetimeTicketsWon,
        lifetimeTicketsLost: walletTotals.lifetimeTicketsLost,
        totalStakedPoints: walletTotals.totalStaked,
        totalReturnedPoints: walletTotals.totalReturns,
        netVirtualProfitLoss: walletTotals.netProfitLoss,
        ticketsDueForRetentionCleanup: retentionDueCount,
        topMarketFamilies: marketVolumeRows,
      },
      ledger: {
        totalEntries: ledgerCount,
        transactionTypes: ledgerTypeRows,
      },
      operations: {
        eventsByLevelLast24Hours: eventLevelRows,
        eventsByCategoryLast24Hours: eventCategoryRows,
        lastSettlementEvent: lastSettlementEvent
          ? {
              action: lastSettlementEvent.action,
              level: lastSettlementEvent.level,
              createdAt: lastSettlementEvent.createdAt,
              message: lastSettlementEvent.message,
            }
          : null,
        lastRetentionEvent: lastRetentionEvent
          ? {
              action: lastRetentionEvent.action,
              level: lastRetentionEvent.level,
              createdAt: lastRetentionEvent.createdAt,
              message: lastRetentionEvent.message,
              metadata: lastRetentionEvent.metadata,
            }
          : null,
      },
      marketCatalog: {
        marketFamilyCount: BET_LAB_MARKET_CATALOG.length,
        markets: BET_LAB_MARKET_CATALOG.map((market) => ({
          code: market.code,
          jsonVariable: market.jsonVariable,
          fullName: market.fullName,
          abbreviation: market.abbreviation,
          category: market.category,
          period: market.period,
          selectionMode: market.selectionMode,
        })),
      },
      sportsDataCoverage: {
        eligibleUpcomingFixturesNext14Days: upcomingFixtureCount,
        fixturesWithSummary: fixturesWithSummaryCount,
        fixturesWithProviderOdds: fixturesWithAnyOddsCount,
      },
      recentEvents,
    };
  }

  async getRecentEvents(limitValue?: number) {
    const limit = Math.min(
      200,
      Math.max(
        1,
        Math.floor(
          Number(limitValue) || BET_LAB_CONFIG.monitor.recentEventsLimit,
        ),
      ),
    );

    return this.eventModel
      .find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
  }

  private describeModel<T>(name: string, model: Model<T>) {
    const paths = Object.keys(model.schema.paths);
    const indexes = model.schema.indexes();

    return {
      model: name,
      registered: Boolean(model),
      collection: model.collection.collectionName,
      connectionReady: Number(model.db.readyState) === 1,
      schemaPathCount: paths.length,
      requiredPathCount: paths.filter(
        (path) => model.schema.path(path)?.options?.required === true,
      ).length,
      declaredIndexCount: indexes.length,
      declaredIndexes: indexes.map(([keys, options]) => ({
        keys,
        unique: Boolean(options?.unique),
        sparse: Boolean(options?.sparse),
      })),
    };
  }

  private getServiceInventory() {
    // Inventory is intentionally descriptive: provider registration does not
    // claim that a service has executed successfully at runtime.
    return [
      {
        service: 'BetLabEventService',
        responsibility: 'Operational event persistence',
        healthProbe: 'event persistence query results',
      },
      {
        service: 'BetLabMarketService',
        responsibility: 'Fixture markets and odds retrieval',
        healthProbe: 'market/fixture coverage plus event telemetry',
      },
      {
        service: 'BetLabMonitorService',
        responsibility: 'Monitoring overview and diagnostics',
        healthProbe: 'dashboard query results',
      },
      {
        service: 'BetLabRetentionService',
        responsibility: 'Expired ticket and event cleanup',
        healthProbe: 'last retention event',
      },
      {
        service: 'BetLabSettlementAdapterService',
        responsibility: 'Settlement integration boundary',
        healthProbe: 'last settlement event and resolved-ticket diagnostics',
      },
      {
        service: 'BetLabSlipService',
        responsibility: 'Accumulator slip placement',
        healthProbe: 'ticket operation telemetry where recorded',
      },
      {
        service: 'BetLabStatisticsService',
        responsibility: 'User statistics',
        healthProbe:
          'service query failures are not currently recorded separately',
      },
      {
        service: 'BetLabTicketService',
        responsibility: 'Ticket placement and retrieval',
        healthProbe: 'ticket counts and ticket event telemetry',
      },
      {
        service: 'BetLabWalletHistoryService',
        responsibility: 'Wallet ledger history',
        healthProbe: 'ledger query results',
      },
      {
        service: 'BetLabWalletService',
        responsibility: 'Wallet and virtual-point operations',
        healthProbe: 'wallet invariants and ledger totals',
      },
    ];
  }

  private getControllerInventory() {
    // Route inventory documents the controller surface from the supplied
    // module. It does not pretend to be a live router introspection result.
    return [
      {
        controller: 'BetLabController',
        basePath: '/bet-lab',
        routes: [
          'GET /catalog',
          'GET /fixtures',
          'GET /fixtures/:eventId/markets',
          'GET /fixtures/:eventId/odds',
          'POST /tickets',
          'POST /slips',
          'GET /tickets',
          'GET /tickets/:ticketId',
          'GET /statistics',
        ],
      },
      {
        controller: 'BetLabWalletController',
        basePath: '/bet-lab/wallet',
        routes: ['GET /', 'GET /ledger'],
      },
      {
        controller: 'BetLabAdminController',
        basePath: '/bet-lab/admin',
        routes: ['GET /monitor', 'GET /events'],
      },
    ];
  }
}
