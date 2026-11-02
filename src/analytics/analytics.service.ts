import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { User, UserDocument, UserStatus } from '../users/schemas/user.schema';
import { Subscription, SubscriptionDocument } from '../subscriptions/schemas/subscription.schema';
import { MarketPrediction, MarketPredictionDocument } from '../predictions-engine/schemas/market-prediction.schema';
import { PredictionStatus } from '../predictions-engine/enums/prediction-status.enum';
import { ActiveCompetition, ActiveCompetitionDocument } from '../sports/schemas/active-competition.schema';
import { ActiveCompetitionStatus } from '../sports/interfaces/active-competition.interface';
import { FOOTBALL_MARKET_CATALOG } from '../odds/catalog/football-market-catalog';

import { AnalyticsOverviewService } from './analytics-overview.service';
import { AnalyticsRevenueService } from './analytics-revenue.service';
import { AnalyticsLeaderboardService } from './analytics-leaderboard.service';

type CountResult = { count: number };

export interface PublicAnalyticsStats {
  registeredUsers: number;
  subscribers: number;
  marketsPredicted: number;
  totalMarkets: number;
  marketsWon: number;
  matchesPredicted: number;
  activeLeagues: number;
  settledMatches: number;
  updatedAt: string;
}

const PUBLIC_STATS_CACHE_TTL_MS = 60_000;
const PREDICTED_MARKET_STATUSES = [
  PredictionStatus.CALCULATED,
  PredictionStatus.PARTIAL,
] as const;
const PERSISTED_SETTLEMENT_OUTCOMES = [
  'WON',
  'LOST',
  'VOID',
  'PUSH',
  'HALF_WON',
  'HALF_LOST',
] as const;

@Injectable()
export class AnalyticsService {
  private publicStatsCache: { value: PublicAnalyticsStats; expiresAt: number } | null = null;
  private publicStatsInFlight: Promise<PublicAnalyticsStats> | null = null;

  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<SubscriptionDocument>,
    @InjectModel(MarketPrediction.name)
    private readonly marketPredictionModel: Model<MarketPredictionDocument>,
    @InjectModel(ActiveCompetition.name)
    private readonly activeCompetitionModel: Model<ActiveCompetitionDocument>,
    private readonly overviewService: AnalyticsOverviewService,

    private readonly revenueService: AnalyticsRevenueService,

    private readonly leaderboardService: AnalyticsLeaderboardService,
  ) {}

  /**
   * Returns only public-safe aggregate counts. Results are cached for one minute
   * so homepage refreshes do not repeatedly scan the prediction collections.
   */
  async getPublicStats(): Promise<PublicAnalyticsStats> {
    const now = Date.now();
    if (this.publicStatsCache && this.publicStatsCache.expiresAt > now) {
      return this.publicStatsCache.value;
    }

    if (this.publicStatsInFlight) return this.publicStatsInFlight;

    const request = this.calculatePublicStats();
    this.publicStatsInFlight = request;

    try {
      const value = await request;
      this.publicStatsCache = {
        value,
        expiresAt: Date.now() + PUBLIC_STATS_CACHE_TTL_MS,
      };
      return value;
    } finally {
      if (this.publicStatsInFlight === request) {
        this.publicStatsInFlight = null;
      }
    }
  }

  private async calculatePublicStats(): Promise<PublicAnalyticsStats> {
    const now = new Date();
    const predictedMarketsMatch = {
      status: { $in: PREDICTED_MARKET_STATUSES },
      selections: { $elemMatch: { isFinalSelection: true } },
    };

    const [
      registeredUsers,
      subscriberCounts,
      marketsPredicted,
      marketWinCounts,
      matchesPredictedCounts,
      activeLeagues,
      settledMatchCounts,
    ] = await Promise.all([
      this.userModel.countDocuments({
        isDeleted: { $ne: true },
        status: { $ne: UserStatus.DELETED },
      }).exec(),
      this.subscriptionModel.aggregate<CountResult>([
        {
          $match: {
            startDate: { $lte: now },
            expiryDate: { $gt: now },
            // A queued term with a due start date is activated by the existing
            // subscription service when access is checked. Count users, not rows.
            isActive: { $in: [true, false] },
          },
        },
        { $group: { _id: '$userId' } },
        { $count: 'count' },
      ]).exec(),
      this.marketPredictionModel.countDocuments(predictedMarketsMatch).exec(),
      this.marketPredictionModel.aggregate<CountResult>([
        {
          $match: {
            status: { $in: PREDICTED_MARKET_STATUSES },
            selections: {
              $elemMatch: {
                isFinalSelection: true,
                actualOutcome: 'WON',
              },
            },
          },
        },
        { $unwind: '$selections' },
        {
          $match: {
            'selections.isFinalSelection': true,
            'selections.actualOutcome': 'WON',
          },
        },
        { $count: 'count' },
      ]).exec(),
      this.marketPredictionModel.aggregate<CountResult>([
        { $match: predictedMarketsMatch },
        { $group: { _id: '$eventId' } },
        { $count: 'count' },
      ]).exec(),
      this.activeCompetitionModel.countDocuments({
        status: {
          $in: [ActiveCompetitionStatus.ACTIVE, ActiveCompetitionStatus.UPCOMING],
        },
      }).exec(),
      this.marketPredictionModel.aggregate<CountResult>([
        { $match: predictedMarketsMatch },
        { $unwind: '$selections' },
        { $match: { 'selections.isFinalSelection': true } },
        {
          $group: {
            _id: '$eventId',
            totalSelections: { $sum: 1 },
            settledSelections: {
              $sum: {
                $cond: [
                  {
                    $in: [
                      { $ifNull: ['$selections.actualOutcome', 'PENDING'] },
                      PERSISTED_SETTLEMENT_OUTCOMES,
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
        {
          $match: {
            $expr: {
              $and: [
                { $gt: ['$totalSelections', 0] },
                { $eq: ['$totalSelections', '$settledSelections'] },
              ],
            },
          },
        },
        { $count: 'count' },
      ]).exec(),
    ]);

    return {
      registeredUsers,
      subscribers: subscriberCounts[0]?.count ?? 0,
      marketsPredicted,
      totalMarkets: FOOTBALL_MARKET_CATALOG.length,
      marketsWon: marketWinCounts[0]?.count ?? 0,
      matchesPredicted: matchesPredictedCounts[0]?.count ?? 0,
      activeLeagues,
      settledMatches: settledMatchCounts[0]?.count ?? 0,
      updatedAt: new Date().toISOString(),
    };
  }

  async getDashboard() {
    const [overview, revenue, leaderboards] = await Promise.all([
      this.overviewService.getOverview(),

      this.revenueService.getRevenue(),

      this.leaderboardService.getLeaderboards(),
    ]);

    return {
      users: overview.users,

      revenue,

      subscriptions: overview.subscriptions,

      predictions: overview.predictions,

      ads: overview.ads,

      promos: overview.promos,

      referrals: overview.referrals,

      leaderboards,
    };
  }
}
