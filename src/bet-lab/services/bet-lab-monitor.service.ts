import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BET_LAB_CONFIG } from '../config/bet-lab.config';
import { BET_LAB_MARKET_CATALOG } from '../catalog/bet-lab-market-catalog';
import { BetLabEvent } from '../schemas/bet-lab-event.schema';
import { BetLabTicket } from '../schemas/bet-lab-ticket.schema';
import { BetLabWallet } from '../schemas/bet-lab-wallet.schema';
import { BetLabWalletLedger } from '../schemas/bet-lab-wallet-ledger.schema';
import { SportsDomainReadService } from '../../sports/services/sports-domain-read.service';
import { OddsReadService } from '../../odds/services/odds-read.service';
import { SystemMonitorService } from '../../system-monitor/system-monitor.service';

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
export class BetLabMonitorService implements OnModuleInit {
  onModuleInit(): void {
    this.systemMonitor.registerModule('bet-lab');
  }

  constructor(
    @InjectModel(BetLabWallet.name)
    private readonly walletModel: Model<BetLabWallet>,
    @InjectModel(BetLabWalletLedger.name)
    private readonly ledgerModel: Model<BetLabWalletLedger>,
    @InjectModel(BetLabTicket.name)
    private readonly ticketModel: Model<BetLabTicket>,
    @InjectModel(BetLabEvent.name)
    private readonly eventModel: Model<BetLabEvent>,
    private readonly sportsRead: SportsDomainReadService,
    private readonly oddsRead: OddsReadService,
    private readonly systemMonitor: SystemMonitorService,
  ) {}

  /**
   * Read-only operational overview. Individual queries fail independently so a
   * failed diagnostic does not erase every other useful monitoring result.
   * This service must never create, update, settle, or delete business records.
   */
  async getOverview() {
    try {
      return await this.buildOverview();
    } catch (error) {
      this.systemMonitor.reportMonitorSnapshot('bet-lab', {
        status: 'FAILED',
        checkedAt: new Date(),
        checks: [{ name: 'getOverview', status: 'FAILED', error: error instanceof Error ? error.message : String(error) }],
      });
      throw error;
    }
  }

  private async buildOverview() {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
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
      ledgerTransitionInconsistencyCount,
      sportsCoverage,
      retentionDueCount,
      errorEvents24h,
      rejectedPlacements24h,
      inconsistentWalletCount,
      walletLedgerMismatchCount,
      ticketsMissingStakeLedger,
      settledTicketsMissingReturnLedger,
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
        'ledger.balanceTransitions',
        () =>
          this.ledgerModel
            .aggregate<{ count: number }>([
              {
                $addFields: {
                  _deltaNumber: {
                    $convert: { input: '$delta', to: 'double', onError: 0, onNull: 0 },
                  },
                  _amountNumber: {
                    $convert: { input: '$amount', to: 'double', onError: 0, onNull: 0 },
                  },
                  _balanceBeforeNumber: {
                    $convert: { input: '$balanceBefore', to: 'double', onError: 0, onNull: 0 },
                  },
                  _balanceAfterNumber: {
                    $convert: { input: '$balanceAfter', to: 'double', onError: 0, onNull: 0 },
                  },
                  _hasInvalidLedgerNumber: {
                    $or: [
                      { $not: [{ $isNumber: '$delta' }] },
                      { $not: [{ $isNumber: '$amount' }] },
                      { $not: [{ $isNumber: '$balanceBefore' }] },
                      { $not: [{ $isNumber: '$balanceAfter' }] },
                    ],
                  },
                },
              },
              {
                $match: {
                  $expr: {
                    $or: [
                      '$_hasInvalidLedgerNumber',
                      {
                        $ne: [
                          '$_balanceAfterNumber',
                          { $add: ['$_balanceBeforeNumber', '$_deltaNumber'] },
                        ],
                      },
                      { $ne: ['$_amountNumber', { $abs: '$_deltaNumber' }] },
                      { $lt: ['$_amountNumber', 0] },
                      { $lt: ['$_balanceBeforeNumber', 0] },
                      { $lt: ['$_balanceAfterNumber', 0] },
                      {
                        $gt: [
                          { $abs: '$_deltaNumber' },
                          9007199254740991,
                        ],
                      },
                      {
                        $gt: [
                          '$_amountNumber',
                          9007199254740991,
                        ],
                      },
                      {
                        $ne: [
                          { $mod: ['$_deltaNumber', 1] },
                          0,
                        ],
                      },
                      {
                        $ne: [
                          { $mod: ['$_amountNumber', 1] },
                          0,
                        ],
                      },
                      {
                        $ne: [
                          { $mod: ['$_balanceBeforeNumber', 1] },
                          0,
                        ],
                      },
                      {
                        $ne: [
                          { $mod: ['$_balanceAfterNumber', 1] },
                          0,
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
        'sports.oddsCoverage',
        () => this.getSportsCoverage(now),
        {
          eligibleUpcomingFixturesNext14Days: 0,
          fixturesWithSportsContext: 0,
          fixturesWithOddsQuotes: 0,
          fixturesWithProviderOdds: 0,
          inspectedFixtures: 0,
          coverageComplete: false,
        },
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
                $addFields: {
                  _walletBalanceNumber: {
                    $convert: { input: '$balance', to: 'double', onError: 0, onNull: 0 },
                  },
                  _welcomeBalanceNumber: {
                    $convert: { input: '$welcomeBalance', to: 'double', onError: 0, onNull: 0 },
                  },
                  _monthlyBalanceNumber: {
                    $convert: { input: '$monthlyBalance', to: 'double', onError: 0, onNull: 0 },
                  },
                  _winningsBalanceNumber: {
                    $convert: { input: '$winningsBalance', to: 'double', onError: 0, onNull: 0 },
                  },
                  _bonusBalanceNumber: {
                    $convert: {
                      input: { $ifNull: ['$bonusBalance', 0] },
                      to: 'double',
                      onError: 0,
                      onNull: 0,
                    },
                  },
                  _hasInvalidWalletNumber: {
                    $or: [
                      { $not: [{ $isNumber: '$balance' }] },
                      { $not: [{ $isNumber: '$welcomeBalance' }] },
                      { $not: [{ $isNumber: '$monthlyBalance' }] },
                      { $not: [{ $isNumber: '$winningsBalance' }] },
                      {
                        $and: [
                          { $ne: [{ $type: '$bonusBalance' }, 'missing'] },
                          { $not: [{ $isNumber: '$bonusBalance' }] },
                        ],
                      },
                    ],
                  },
                },
              },
              {
                $match: {
                  $expr: {
                    $or: [
                      '$_hasInvalidWalletNumber',
                      {
                        $ne: [
                          '$_walletBalanceNumber',
                          {
                            $add: [
                              '$_welcomeBalanceNumber',
                              '$_monthlyBalanceNumber',
                              '$_winningsBalanceNumber',
                              '$_bonusBalanceNumber',
                            ],
                          },
                        ],
                      },
                      { $lt: ['$_walletBalanceNumber', 0] },
                      { $lt: ['$_welcomeBalanceNumber', 0] },
                      { $lt: ['$_monthlyBalanceNumber', 0] },
                      { $lt: ['$_winningsBalanceNumber', 0] },
                      { $lt: ['$_bonusBalanceNumber', 0] },
                      {
                        $gt: [
                          { $abs: '$_walletBalanceNumber' },
                          9007199254740991,
                        ],
                      },
                      {
                        $gt: [
                          { $abs: '$_welcomeBalanceNumber' },
                          9007199254740991,
                        ],
                      },
                      {
                        $gt: [
                          { $abs: '$_monthlyBalanceNumber' },
                          9007199254740991,
                        ],
                      },
                      {
                        $gt: [
                          { $abs: '$_winningsBalanceNumber' },
                          9007199254740991,
                        ],
                      },
                      {
                        $gt: [
                          { $abs: '$_bonusBalanceNumber' },
                          9007199254740991,
                        ],
                      },
                      { $ne: [{ $mod: ['$_walletBalanceNumber', 1] }, 0] },
                      { $ne: [{ $mod: ['$_welcomeBalanceNumber', 1] }, 0] },
                      { $ne: [{ $mod: ['$_monthlyBalanceNumber', 1] }, 0] },
                      { $ne: [{ $mod: ['$_winningsBalanceNumber', 1] }, 0] },
                      { $ne: [{ $mod: ['$_bonusBalanceNumber', 1] }, 0] },
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
        'wallet.ledgerReconciliation',
        () =>
          this.walletModel
            .aggregate<{ count: number }>([
              {
                $lookup: {
                  from: this.ledgerModel.collection.name,
                  let: {
                    walletUserId: '$userId',
                    walletId: { $toString: '$_id' },
                  },
                  pipeline: [
                    {
                      $match: {
                        $expr: {
                          $and: [
                            { $eq: ['$userId', '$$walletUserId'] },
                            { $eq: ['$walletId', '$$walletId'] },
                          ],
                        },
                      },
                    },
                    {
                      $group: {
                        _id: null,
                        ledgerBalance: { $sum: '$delta' },
                        ledgerEntries: { $sum: 1 },
                      },
                    },
                  ],
                  as: 'ledgerSummary',
                },
              },
              {
                $addFields: {
                  _ledgerBalance: {
                    $ifNull: [
                      { $arrayElemAt: ['$ledgerSummary.ledgerBalance', 0] },
                      0,
                    ],
                  },
                },
              },
              { $match: { $expr: { $ne: ['$balance', '$_ledgerBalance'] } } },
              { $count: 'count' },
            ])
            .exec(),
        [],
      ),
      safeQuery(
        'tickets.missingStakeLedger',
        () =>
          this.ticketModel
            .aggregate<{ count: number }>([
              {
                $lookup: {
                  from: this.ledgerModel.collection.name,
                  let: { ticketId: { $toString: '$_id' }, ticketUserId: '$userId' },
                  pipeline: [
                    {
                      $match: {
                        $expr: {
                          $and: [
                            { $eq: ['$ticketId', '$$ticketId'] },
                            { $eq: ['$userId', '$$ticketUserId'] },
                            { $eq: ['$transactionType', 'STAKE_DEBIT'] },
                          ],
                        },
                      },
                    },
                    { $project: { _id: 0, delta: 1, amount: 1 } },
                  ],
                  as: 'stakeLedgerEntries',
                },
              },
              {
                $addFields: {
                  _stakeLedgerCount: { $size: '$stakeLedgerEntries' },
                  _stakeLedgerDelta: {
                    $ifNull: [
                      { $arrayElemAt: ['$stakeLedgerEntries.delta', 0] },
                      0,
                    ],
                  },
                  _stakeLedgerAmount: {
                    $ifNull: [
                      { $arrayElemAt: ['$stakeLedgerEntries.amount', 0] },
                      0,
                    ],
                  },
                },
              },
              {
                $match: {
                  $expr: {
                    $or: [
                      { $ne: ['$_stakeLedgerCount', 1] },
                      { $ne: ['$_stakeLedgerDelta', { $multiply: ['$stake', -1] }] },
                      { $ne: ['$_stakeLedgerAmount', '$stake'] },
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
        'tickets.missingSettlementReturnLedger',
        () =>
          this.ticketModel
            .aggregate<{ count: number }>([
              {
                $match: {
                  status: {
                    $in: [
                      'WON',
                      'LOST',
                      'VOID',
                      'PUSH',
                      'PARTIALLY_WON',
                      'PARTIALLY_LOST',
                    ],
                  },
                },
              },
              {
                $lookup: {
                  from: this.ledgerModel.collection.name,
                  let: { ticketId: { $toString: '$_id' }, ticketUserId: '$userId' },
                  pipeline: [
                    {
                      $match: {
                        $expr: {
                          $and: [
                            { $eq: ['$ticketId', '$$ticketId'] },
                            { $eq: ['$userId', '$$ticketUserId'] },
                            {
                              $in: [
                                '$transactionType',
                                ['SETTLEMENT_RETURN', 'VOID_OR_PUSH_RETURN'],
                              ],
                            },
                          ],
                        },
                      },
                    },
                    {
                      $group: {
                        _id: null,
                        count: { $sum: 1 },
                        delta: { $sum: '$delta' },
                        amount: { $sum: '$amount' },
                      },
                    },
                  ],
                  as: 'settlementLedgerSummary',
                },
              },
              {
                $addFields: {
                  _settlementLedgerCount: {
                    $ifNull: [
                      { $arrayElemAt: ['$settlementLedgerSummary.count', 0] },
                      0,
                    ],
                  },
                  _settlementLedgerDelta: {
                    $ifNull: [
                      { $arrayElemAt: ['$settlementLedgerSummary.delta', 0] },
                      0,
                    ],
                  },
                  _settlementLedgerAmount: {
                    $ifNull: [
                      { $arrayElemAt: ['$settlementLedgerSummary.amount', 0] },
                      0,
                    ],
                  },
                },
              },
              {
                $match: {
                  $expr: {
                    $or: [
                      { $ne: ['$_settlementLedgerCount', 1] },
                      { $ne: ['$_settlementLedgerDelta', '$settledGrossReturn'] },
                      { $ne: ['$_settlementLedgerAmount', '$settledGrossReturn'] },
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
    const walletLedgerInconsistencies = walletLedgerMismatchCount[0]?.count ?? 0;
    const ledgerTransitionInconsistencies =
      ledgerTransitionInconsistencyCount[0]?.count ?? 0;
    const ticketsMissingStakeLedgerCount = ticketsMissingStakeLedger[0]?.count ?? 0;
    const settledTicketsMissingReturnLedgerCount =
      settledTicketsMissingReturnLedger[0]?.count ?? 0;
    const databaseReady = Number(this.walletModel.db.readyState) === 1;
    const schemaCoverage = [
      this.describeModel('BetLabWallet', this.walletModel),
      this.describeModel('BetLabWalletLedger', this.ledgerModel),
      this.describeModel('BetLabTicket', this.ticketModel),
      this.describeModel('BetLabEvent', this.eventModel),
    ];

    checks.unshift({
      name: 'database.connection',
      status: databaseReady ? 'OK' : 'DEGRADED',
      message: databaseReady
        ? 'The Bet Lab MongoDB connection is ready.'
        : `MongoDB connection is not ready (Mongoose readyState=${this.walletModel.db.readyState}).`,
    });

    const overallStatus =
      !databaseReady ||
      failures.length > 0 ||
      walletInconsistencies > 0 ||
      walletLedgerInconsistencies > 0 ||
      ledgerTransitionInconsistencies > 0 ||
      ticketsMissingStakeLedgerCount > 0 ||
      settledTicketsMissingReturnLedgerCount > 0
        ? 'DEGRADED'
        : 'OK';

    const warnings: string[] = [];
    if (walletInconsistencies > 0) {
      warnings.push(
        `${walletInconsistencies} wallet balance invariant violation(s) detected.`,
      );
    }
    if (walletLedgerInconsistencies > 0) {
      warnings.push(
        `${walletLedgerInconsistencies} wallet(s) do not reconcile to the sum of their ledger entries.`,
      );
    }
    if (ledgerTransitionInconsistencies > 0) {
      warnings.push(
        `${ledgerTransitionInconsistencies} wallet ledger entry/entries have invalid balance transitions or non-integer amounts.`,
      );
    }
    if (ticketsMissingStakeLedgerCount > 0) {
      warnings.push(
        `${ticketsMissingStakeLedgerCount} ticket(s) have no matching stake-debit ledger entry.`,
      );
    }
    if (settledTicketsMissingReturnLedgerCount > 0) {
      warnings.push(
        `${settledTicketsMissingReturnLedgerCount} settled ticket(s) have no matching settlement-return ledger entry.`,
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

    const overview = {
      generatedAt: now,
      health: {
        status: overallStatus,
        databaseConnected: databaseReady,
        walletBalanceInconsistencies: walletInconsistencies,
        walletLedgerInconsistencies,
        ledgerTransitionInconsistencies,
        ticketsMissingStakeLedger: ticketsMissingStakeLedgerCount,
        settledTicketsMissingReturnLedger: settledTicketsMissingReturnLedgerCount,
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
        ticketsMissingStakeLedger: ticketsMissingStakeLedgerCount,
        settledTicketsMissingReturnLedger: settledTicketsMissingReturnLedgerCount,
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
        invalidBalanceTransitions: ledgerTransitionInconsistencies,
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
        pricingEnabledMarketCount: BET_LAB_MARKET_CATALOG.filter((market) => market.pricingEnabled !== false).length,
        disabledMarketCount: BET_LAB_MARKET_CATALOG.filter((market) => market.pricingEnabled === false).length,
        markets: BET_LAB_MARKET_CATALOG.map((market) => ({
          code: market.code,
          jsonVariable: market.jsonVariable,
          fullName: market.fullName,
          abbreviation: market.abbreviation,
          category: market.category,
          period: market.period,
          selectionMode: market.selectionMode,
          pricingEnabled: market.pricingEnabled !== false,
          notes: market.notes,
        })),
      },
      sportsDataCoverage: {
        ...sportsCoverage,
      },
      recentEvents,
    };

    this.systemMonitor.reportMonitorSnapshot('bet-lab', {
      status: overview.health.status,
      checkedAt: now,
      checks: [
        ...checks,
        ...failures.map((failure) => ({
          name: failure.check,
          status: 'FAILED',
          error: failure.message,
        })),
      ],
      warnings: overview.health.warnings,
      details: {
        databaseConnected: databaseReady,
        walletBalanceInconsistencies: walletInconsistencies,
        openTickets: openTicketCount,
        unresolvedSettlementIdCount: ticketsMissingSettlementId,
        failedChecks: failures.length,
        sampledUpcomingFixtures: Number(sportsCoverage.inspectedFixtures ?? 0),
      },
    });
    return overview;
  }


  /**
   * Sample all upcoming fixtures over the existing 14-day product window using
   * normalized Sports records and canonical Odds quotes. The hard scan ceiling
   * prevents the admin dashboard from becoming an unbounded database workload.
   */
  private async getSportsCoverage(now: Date) {
    const to = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const batchSize = 200;
    const maximumInspected = 1000;
    let cursor: string | undefined;
    let eligibleUpcomingFixturesNext14Days = 0;
    let inspectedFixtures = 0;
    let coverageComplete = true;
    const sportsContextIds = new Set<string>();
    const oddsQuoteIds = new Set<string>();
    const providerOddsIds = new Set<string>();

    do {
      const page = await this.sportsRead.getFixtures({
        from: now,
        to,
        state: 'SCHEDULED',
        limit: batchSize,
        cursor,
      });
      if (inspectedFixtures === 0) {
        eligibleUpcomingFixturesNext14Days = page.total ?? page.items.length;
      }
      if (!page.items.length) {
        cursor = undefined;
        break;
      }

      const contexts = await this.sportsRead.getFixtureContexts(
        page.items.map((fixture) => fixture.id),
      );
      for (const context of contexts) {
        const home = context.fixture.competitors.find((item) => item.homeAway === 'HOME');
        const away = context.fixture.competitors.find((item) => item.homeAway === 'AWAY');
        if (context.competition && context.homeTeam && context.awayTeam && home && away) {
          sportsContextIds.add(context.fixture.id);
        }
      }

      const prices = await this.oddsRead.getPricesForFixtures(
        page.items.map((fixture) => fixture.id),
      );
      for (const price of prices) {
        const decimalOdds = Number(price.decimalOdds);
        if (
          price.predictionReady !== true ||
          price.isFresh !== true ||
          !Number.isFinite(decimalOdds) ||
          decimalOdds < BET_LAB_CONFIG.odds.minimumDecimalOdds ||
          decimalOdds > BET_LAB_CONFIG.odds.maximumDecimalOdds ||
          (price.priceType !== 'PROVIDER' && price.priceType !== 'ESTIMATED')
        ) continue;
        oddsQuoteIds.add(price.eventId);
        if (price.priceType === 'PROVIDER') providerOddsIds.add(price.eventId);
      }

      inspectedFixtures += page.items.length;
      cursor = page.nextCursor;
      if (cursor && inspectedFixtures >= maximumInspected) {
        coverageComplete = false;
        break;
      }
    } while (cursor);

    return {
      eligibleUpcomingFixturesNext14Days,
      fixturesWithSportsContext: sportsContextIds.size,
      fixturesWithOddsQuotes: oddsQuoteIds.size,
      fixturesWithProviderOdds: providerOddsIds.size,
      inspectedFixtures,
      coverageComplete,
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
        responsibility: 'Canonical Sports fixture reads and Odds-module quote retrieval',
        healthProbe: 'normalized Sports context, fresh Odds quotes and event telemetry',
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

