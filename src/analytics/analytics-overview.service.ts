import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { User, UserDocument, UserStatus } from '../users/schemas/user.schema';
import { Subscription, SubscriptionDocument } from '../subscriptions/schemas/subscription.schema';
import { Ad, AdDocument } from '../ads/schemas/ad.schema';
import { Promo, PromoDocument } from '../promos/schemas/promo.schema';
import { Referral, ReferralDocument } from '../referrals/schemas/referral.schema';
import { MarketPrediction, MarketPredictionDocument } from '../predictions-engine/schemas/market-prediction.schema';
import { CuratedPrediction, CuratedPredictionDocument } from '../predictions-engine/schemas/curated-prediction.schema';
import { PredictionStatus } from '../predictions-engine/enums/prediction-status.enum';

type UserOverviewRow = {
  totalUsers: number;
  activeUsers: number;
  suspendedUsers: number;
  deletedUsers: number;
  verifiedUsers: number;
  unverifiedUsers: number;
};

type SubscriptionOverviewRow = {
  totalSubscriptions: number;
  activeSubscriptions: number;
  vipSubscriptions: number;
  activeVipSubscriptions: number;
  regularSubscriptions: number;
  activeRegularSubscriptions: number;
  premiumSubscriptions: number;
  activePremiumSubscriptions: number;
};

type PredictionCountRow = {
  totalMarketPredictions: number;
  calculatedMarketPredictions: number;
  partialMarketPredictions: number;
  unavailableMarketPredictions: number;
  failedMarketPredictions: number;
};

type SelectionOutcomeRow = { _id: string | null; count: number };
type PredictionOverviewFacet = {
  counts: PredictionCountRow[];
  selectionOutcomes: SelectionOutcomeRow[];
};

type CuratedOverviewRow = {
  totalCuratedPredictions: number;
  readyCuratedPredictions: number;
  publishedCuratedPredictions: number;
  settledCuratedPredictions: number;
  cancelledCuratedPredictions: number;
};

type AdOverviewRow = {
  totalAds: number;
  activeAds: number;
  impressions: number;
  clicks: number;
};

type PromoOverviewRow = {
  totalPromos: number;
  activePromos: number;
  expiredPromos: number;
};

type ReferralOverviewRow = {
  totalReferrals: number;
  registeredReferrals: number;
  regularReferralSubscribers: number;
  vipReferralSubscribers: number;
  premiumReferralSubscribers: number;
  rewardedReferrals: number;
  unclaimedReferrals: number;
  paidReferralSubscribers: number;
};

const ZERO_USER_OVERVIEW: UserOverviewRow = {
  totalUsers: 0,
  activeUsers: 0,
  suspendedUsers: 0,
  deletedUsers: 0,
  verifiedUsers: 0,
  unverifiedUsers: 0,
};

const ZERO_SUBSCRIPTION_OVERVIEW: SubscriptionOverviewRow = {
  totalSubscriptions: 0,
  activeSubscriptions: 0,
  vipSubscriptions: 0,
  activeVipSubscriptions: 0,
  regularSubscriptions: 0,
  activeRegularSubscriptions: 0,
  premiumSubscriptions: 0,
  activePremiumSubscriptions: 0,
};

const ZERO_PREDICTION_OVERVIEW: PredictionCountRow = {
  totalMarketPredictions: 0,
  calculatedMarketPredictions: 0,
  partialMarketPredictions: 0,
  unavailableMarketPredictions: 0,
  failedMarketPredictions: 0,
};

const ZERO_CURATED_OVERVIEW: CuratedOverviewRow = {
  totalCuratedPredictions: 0,
  readyCuratedPredictions: 0,
  publishedCuratedPredictions: 0,
  settledCuratedPredictions: 0,
  cancelledCuratedPredictions: 0,
};

const ZERO_AD_OVERVIEW: AdOverviewRow = {
  totalAds: 0,
  activeAds: 0,
  impressions: 0,
  clicks: 0,
};

const ZERO_PROMO_OVERVIEW: PromoOverviewRow = {
  totalPromos: 0,
  activePromos: 0,
  expiredPromos: 0,
};

const ZERO_REFERRAL_OVERVIEW: ReferralOverviewRow = {
  totalReferrals: 0,
  registeredReferrals: 0,
  regularReferralSubscribers: 0,
  vipReferralSubscribers: 0,
  premiumReferralSubscribers: 0,
  rewardedReferrals: 0,
  unclaimedReferrals: 0,
  paidReferralSubscribers: 0,
};

/**
 * Read-only administrator overview. Related counters are grouped into one
 * aggregation per collection instead of issuing a separate count for every
 * card on the dashboard. The returned object is deliberately kept compatible
 * with the previous dashboard response.
 */
@Injectable()
export class AnalyticsOverviewService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Subscription.name) private readonly subscriptionModel: Model<SubscriptionDocument>,
    @InjectModel(Ad.name) private readonly adModel: Model<AdDocument>,
    @InjectModel(Promo.name) private readonly promoModel: Model<PromoDocument>,
    @InjectModel(Referral.name) private readonly referralModel: Model<ReferralDocument>,
    @InjectModel(MarketPrediction.name) private readonly marketPredictionModel: Model<MarketPredictionDocument>,
    @InjectModel(CuratedPrediction.name) private readonly curatedPredictionModel: Model<CuratedPredictionDocument>,
  ) {}

  async getOverview() {
    const now = new Date();

    // Each collection is scanned once. Independent collection aggregations run
    // concurrently; no domain records are mutated or materialized in memory.
    const [
      userRows,
      subscriptionRows,
      predictionFacets,
      curatedRows,
      adRows,
      promoRows,
      referralRows,
    ] = await Promise.all([
      this.userModel.aggregate<UserOverviewRow>([
        {
          $group: {
            _id: null,
            totalUsers: { $sum: 1 },
            activeUsers: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$status', UserStatus.ACTIVE] },
                      { $ne: ['$isDeleted', true] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            suspendedUsers: {
              $sum: { $cond: [{ $eq: ['$status', UserStatus.SUSPENDED] }, 1, 0] },
            },
            deletedUsers: {
              $sum: { $cond: [{ $eq: ['$isDeleted', true] }, 1, 0] },
            },
            verifiedUsers: {
              $sum: { $cond: [{ $eq: ['$isVerified', true] }, 1, 0] },
            },
            unverifiedUsers: {
              $sum: { $cond: [{ $ne: ['$isVerified', true] }, 1, 0] },
            },
          },
        },
        { $project: { _id: 0 } },
      ]).exec(),

      this.subscriptionModel.aggregate<SubscriptionOverviewRow>([
        {
          $group: {
            _id: null,
            totalSubscriptions: { $sum: 1 },
            activeSubscriptions: {
              $sum: { $cond: [this.activeSubscriptionExpression(now), 1, 0] },
            },
            vipSubscriptions: {
              $sum: { $cond: [{ $eq: ['$plan', 'vip'] }, 1, 0] },
            },
            activeVipSubscriptions: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$plan', 'vip'] },
                      this.activeSubscriptionExpression(now),
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            regularSubscriptions: {
              $sum: { $cond: [{ $eq: ['$plan', 'regular'] }, 1, 0] },
            },
            activeRegularSubscriptions: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$plan', 'regular'] },
                      this.activeSubscriptionExpression(now),
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            premiumSubscriptions: {
              $sum: { $cond: [{ $eq: ['$plan', 'premium'] }, 1, 0] },
            },
            activePremiumSubscriptions: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$plan', 'premium'] },
                      this.activeSubscriptionExpression(now),
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
        { $project: { _id: 0 } },
      ]).exec(),

      this.marketPredictionModel.aggregate<PredictionOverviewFacet>([
        {
          $facet: {
            counts: [
              {
                $group: {
                  _id: null,
                  totalMarketPredictions: { $sum: 1 },
                  calculatedMarketPredictions: {
                    $sum: {
                      $cond: [{ $eq: ['$status', PredictionStatus.CALCULATED] }, 1, 0],
                    },
                  },
                  partialMarketPredictions: {
                    $sum: {
                      $cond: [{ $eq: ['$status', PredictionStatus.PARTIAL] }, 1, 0],
                    },
                  },
                  unavailableMarketPredictions: {
                    $sum: {
                      $cond: [{ $eq: ['$status', PredictionStatus.UNAVAILABLE] }, 1, 0],
                    },
                  },
                  failedMarketPredictions: {
                    $sum: {
                      $cond: [{ $eq: ['$status', PredictionStatus.FAILED] }, 1, 0],
                    },
                  },
                },
              },
              { $project: { _id: 0 } },
            ],
            selectionOutcomes: [
              { $unwind: '$selections' },
              {
                $group: {
                  _id: { $ifNull: ['$selections.actualOutcome', 'PENDING'] },
                  count: { $sum: 1 },
                },
              },
            ],
          },
        },
      ]).exec(),

      this.curatedPredictionModel.aggregate<CuratedOverviewRow>([
        {
          $group: {
            _id: null,
            totalCuratedPredictions: { $sum: 1 },
            readyCuratedPredictions: {
              $sum: { $cond: [{ $eq: ['$status', 'READY'] }, 1, 0] },
            },
            publishedCuratedPredictions: {
              $sum: { $cond: [{ $eq: ['$status', 'PUBLISHED'] }, 1, 0] },
            },
            settledCuratedPredictions: {
              $sum: { $cond: [{ $eq: ['$status', 'SETTLED'] }, 1, 0] },
            },
            cancelledCuratedPredictions: {
              $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] },
            },
          },
        },
        { $project: { _id: 0 } },
      ]).exec(),

      this.adModel.aggregate<AdOverviewRow>([
        {
          $group: {
            _id: null,
            totalAds: { $sum: 1 },
            activeAds: {
              $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] },
            },
            impressions: { $sum: '$impressions' },
            clicks: { $sum: '$clicks' },
          },
        },
        { $project: { _id: 0 } },
      ]).exec(),

      this.promoModel.aggregate<PromoOverviewRow>([
        {
          $group: {
            _id: null,
            totalPromos: { $sum: 1 },
            activePromos: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$isActive', true] },
                      { $lte: ['$startDate', now] },
                      { $gte: ['$endDate', now] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            expiredPromos: {
              $sum: { $cond: [{ $lt: ['$endDate', now] }, 1, 0] },
            },
          },
        },
        { $project: { _id: 0 } },
      ]).exec(),

      this.referralModel.aggregate<ReferralOverviewRow>([
        {
          $group: {
            _id: null,
            totalReferrals: { $sum: 1 },
            registeredReferrals: {
              $sum: { $cond: [{ $eq: ['$registered', true] }, 1, 0] },
            },
            regularReferralSubscribers: {
              $sum: { $cond: [{ $eq: ['$regularSubscription', true] }, 1, 0] },
            },
            vipReferralSubscribers: {
              $sum: { $cond: [{ $eq: ['$vipSubscription', true] }, 1, 0] },
            },
            premiumReferralSubscribers: {
              $sum: { $cond: [{ $eq: ['$premiumSubscription', true] }, 1, 0] },
            },
            rewardedReferrals: {
              $sum: { $cond: [{ $eq: ['$rewardClaimed', true] }, 1, 0] },
            },
            unclaimedReferrals: {
              $sum: { $cond: [{ $ne: ['$rewardClaimed', true] }, 1, 0] },
            },
            paidReferralSubscribers: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $eq: ['$regularSubscription', true] },
                      { $eq: ['$vipSubscription', true] },
                      { $eq: ['$premiumSubscription', true] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
        { $project: { _id: 0 } },
      ]).exec(),
    ]);

    const users = userRows[0] ?? ZERO_USER_OVERVIEW;
    const subscriptions = subscriptionRows[0] ?? ZERO_SUBSCRIPTION_OVERVIEW;
    const predictionFacet = predictionFacets[0];
    const predictionCounts = predictionFacet?.counts?.[0] ?? ZERO_PREDICTION_OVERVIEW;
    const selectionOutcomes = predictionFacet?.selectionOutcomes ?? [];
    const curated = curatedRows[0] ?? ZERO_CURATED_OVERVIEW;
    const ads = adRows[0] ?? ZERO_AD_OVERVIEW;
    const promos = promoRows[0] ?? ZERO_PROMO_OVERVIEW;
    const referrals = referralRows[0] ?? ZERO_REFERRAL_OVERVIEW;

    const outcomeCounts = new Map<string, number>(
      selectionOutcomes.map(({ _id, count }) => [
        String(_id ?? 'PENDING').toUpperCase(),
        count,
      ] as [string, number]),
    );
    const totalSelections = selectionOutcomes.reduce(
      (sum, row) => sum + row.count,
      0,
    );
    const impressions = ads.impressions ?? 0;
    const clicks = ads.clicks ?? 0;

    return {
      users: {
        totalUsers: users.totalUsers,
        activeUsers: users.activeUsers,
        suspendedUsers: users.suspendedUsers,
        deletedUsers: users.deletedUsers,
        verifiedUsers: users.verifiedUsers,
        unverifiedUsers: users.unverifiedUsers,
      },
      subscriptions: {
        totalSubscriptions: subscriptions.totalSubscriptions,
        activeSubscriptions: subscriptions.activeSubscriptions,
        vipSubscriptions: subscriptions.vipSubscriptions,
        activeVipSubscriptions: subscriptions.activeVipSubscriptions,
        regularSubscriptions: subscriptions.regularSubscriptions,
        activeRegularSubscriptions: subscriptions.activeRegularSubscriptions,
        premiumSubscriptions: subscriptions.premiumSubscriptions,
        activePremiumSubscriptions: subscriptions.activePremiumSubscriptions,
      },
      predictions: {
        totalPredictions: predictionCounts.totalMarketPredictions,
        calculatedMarketPredictions: predictionCounts.calculatedMarketPredictions,
        partialMarketPredictions: predictionCounts.partialMarketPredictions,
        unavailableMarketPredictions: predictionCounts.unavailableMarketPredictions,
        failedMarketPredictions: predictionCounts.failedMarketPredictions,
        totalSelections,
        pendingSelections: outcomeCounts.get('PENDING') ?? 0,
        wonSelections: outcomeCounts.get('WON') ?? 0,
        lostSelections: outcomeCounts.get('LOST') ?? 0,
        voidSelections: outcomeCounts.get('VOID') ?? 0,
        pushSelections: outcomeCounts.get('PUSH') ?? 0,
        halfWonSelections: outcomeCounts.get('HALF_WON') ?? 0,
        halfLostSelections: outcomeCounts.get('HALF_LOST') ?? 0,
        totalCuratedPredictions: curated.totalCuratedPredictions,
        readyCuratedPredictions: curated.readyCuratedPredictions,
        publishedCuratedPredictions: curated.publishedCuratedPredictions,
        settledCuratedPredictions: curated.settledCuratedPredictions,
        cancelledCuratedPredictions: curated.cancelledCuratedPredictions,
      },
      ads: {
        totalAds: ads.totalAds,
        activeAds: ads.activeAds,
        impressions,
        clicks,
        ctr: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
      },
      promos: {
        totalPromos: promos.totalPromos,
        activePromos: promos.activePromos,
        expiredPromos: promos.expiredPromos,
      },
      referrals: {
        totalReferrals: referrals.totalReferrals,
        registeredReferrals: referrals.registeredReferrals,
        regularSubscribers: referrals.regularReferralSubscribers,
        vipSubscribers: referrals.vipReferralSubscribers,
        premiumSubscribers: referrals.premiumReferralSubscribers,
        paidSubscribers: referrals.paidReferralSubscribers,
        rewardedReferrals: referrals.rewardedReferrals,
        unclaimedReferrals: referrals.unclaimedReferrals,
      },
    };
  }

  private activeSubscriptionExpression(now: Date): any {
    return {
      $and: [
        { $eq: ['$isActive', true] },
        { $lte: ['$startDate', now] },
        { $gt: ['$expiryDate', now] },
      ],
    };
  }
}
