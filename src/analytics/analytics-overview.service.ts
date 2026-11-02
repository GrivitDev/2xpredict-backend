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

type CountRow = { _id: string; count: number };
type TotalRow = { total: number };

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
    const activeSubscriptionWindow = { startDate: { $lte: now }, expiryDate: { $gt: now } };

    const [
      totalUsers,
      activeUsers,
      suspendedUsers,
      deletedUsers,
      verifiedUsers,
      unverifiedUsers,
      totalSubscriptions,
      activeSubscriptions,
      vipSubscriptions,
      activeVipSubscriptions,
      regularSubscriptions,
      activeRegularSubscriptions,
      premiumSubscriptions,
      activePremiumSubscriptions,
      totalMarketPredictions,
      calculatedMarketPredictions,
      partialMarketPredictions,
      unavailableMarketPredictions,
      failedMarketPredictions,
      selectionOutcomes,
      totalCuratedPredictions,
      readyCuratedPredictions,
      publishedCuratedPredictions,
      settledCuratedPredictions,
      cancelledCuratedPredictions,
      totalAds,
      activeAds,
      impressionTotals,
      clickTotals,
      totalPromos,
      activePromos,
      expiredPromos,
      totalReferrals,
      registeredReferrals,
      regularReferralSubscribers,
      vipReferralSubscribers,
      premiumReferralSubscribers,
      rewardedReferrals,
      unclaimedReferrals,
      paidReferralSubscribers,
    ] = await Promise.all([
      this.userModel.countDocuments().exec(),
      this.userModel.countDocuments({ status: UserStatus.ACTIVE, isDeleted: { $ne: true } }).exec(),
      this.userModel.countDocuments({ status: UserStatus.SUSPENDED }).exec(),
      this.userModel.countDocuments({ isDeleted: true }).exec(),
      this.userModel.countDocuments({ isVerified: true }).exec(),
      this.userModel.countDocuments({ isVerified: { $ne: true } }).exec(),

      this.subscriptionModel.countDocuments().exec(),
      this.subscriptionModel.countDocuments({ isActive: true, ...activeSubscriptionWindow }).exec(),
      this.subscriptionModel.countDocuments({ plan: 'vip' }).exec(),
      this.subscriptionModel.countDocuments({ plan: 'vip', isActive: true, ...activeSubscriptionWindow }).exec(),
      this.subscriptionModel.countDocuments({ plan: 'regular' }).exec(),
      this.subscriptionModel.countDocuments({ plan: 'regular', isActive: true, ...activeSubscriptionWindow }).exec(),
      this.subscriptionModel.countDocuments({ plan: 'premium' }).exec(),
      this.subscriptionModel.countDocuments({ plan: 'premium', isActive: true, ...activeSubscriptionWindow }).exec(),

      this.marketPredictionModel.countDocuments().exec(),
      this.marketPredictionModel.countDocuments({ status: PredictionStatus.CALCULATED }).exec(),
      this.marketPredictionModel.countDocuments({ status: PredictionStatus.PARTIAL }).exec(),
      this.marketPredictionModel.countDocuments({ status: PredictionStatus.UNAVAILABLE }).exec(),
      this.marketPredictionModel.countDocuments({ status: PredictionStatus.FAILED }).exec(),
      this.marketPredictionModel.aggregate<CountRow>([
        { $unwind: '$selections' },
        {
          $group: {
            _id: { $ifNull: ['$selections.actualOutcome', 'PENDING'] },
            count: { $sum: 1 },
          },
        },
      ]).exec(),
      this.curatedPredictionModel.countDocuments().exec(),
      this.curatedPredictionModel.countDocuments({ status: 'READY' }).exec(),
      this.curatedPredictionModel.countDocuments({ status: 'PUBLISHED' }).exec(),
      this.curatedPredictionModel.countDocuments({ status: 'SETTLED' }).exec(),
      this.curatedPredictionModel.countDocuments({ status: 'CANCELLED' }).exec(),

      this.adModel.countDocuments().exec(),
      this.adModel.countDocuments({ isActive: true }).exec(),
      this.adModel.aggregate<TotalRow>([
        { $group: { _id: null, total: { $sum: '$impressions' } } },
      ]).exec(),
      this.adModel.aggregate<TotalRow>([
        { $group: { _id: null, total: { $sum: '$clicks' } } },
      ]).exec(),

      this.promoModel.countDocuments().exec(),
      this.promoModel.countDocuments({ isActive: true, startDate: { $lte: now }, endDate: { $gte: now } }).exec(),
      this.promoModel.countDocuments({ endDate: { $lt: now } }).exec(),

      this.referralModel.countDocuments().exec(),
      this.referralModel.countDocuments({ registered: true }).exec(),
      this.referralModel.countDocuments({ regularSubscription: true }).exec(),
      this.referralModel.countDocuments({ vipSubscription: true }).exec(),
      this.referralModel.countDocuments({ premiumSubscription: true }).exec(),
      this.referralModel.countDocuments({ rewardClaimed: true }).exec(),
      this.referralModel.countDocuments({ rewardClaimed: { $ne: true } }).exec(),
      this.referralModel.countDocuments({
        $or: [
          { regularSubscription: true },
          { vipSubscription: true },
          { premiumSubscription: true },
        ],
      }).exec(),
    ]);

    const outcomeCounts = new Map<string, number>(
      selectionOutcomes.map(({ _id, count }) => [String(_id).toUpperCase(), count] as [string, number]),
    );
    const totalSelections = selectionOutcomes.reduce((sum, row) => sum + row.count, 0);
    const impressions = impressionTotals[0]?.total ?? 0;
    const clicks = clickTotals[0]?.total ?? 0;

    return {
      users: {
        totalUsers,
        activeUsers,
        suspendedUsers,
        deletedUsers,
        verifiedUsers,
        unverifiedUsers,
      },
      subscriptions: {
        totalSubscriptions,
        activeSubscriptions,
        vipSubscriptions,
        activeVipSubscriptions,
        regularSubscriptions,
        activeRegularSubscriptions,
        premiumSubscriptions,
        activePremiumSubscriptions,
      },
      predictions: {
        totalPredictions: totalMarketPredictions,
        calculatedMarketPredictions,
        partialMarketPredictions,
        unavailableMarketPredictions,
        failedMarketPredictions,
        totalSelections,
        pendingSelections: outcomeCounts.get('PENDING') ?? 0,
        wonSelections: outcomeCounts.get('WON') ?? 0,
        lostSelections: outcomeCounts.get('LOST') ?? 0,
        voidSelections: outcomeCounts.get('VOID') ?? 0,
        pushSelections: outcomeCounts.get('PUSH') ?? 0,
        halfWonSelections: outcomeCounts.get('HALF_WON') ?? 0,
        halfLostSelections: outcomeCounts.get('HALF_LOST') ?? 0,
        totalCuratedPredictions,
        readyCuratedPredictions,
        publishedCuratedPredictions,
        settledCuratedPredictions,
        cancelledCuratedPredictions,
      },
      ads: {
        totalAds,
        activeAds,
        impressions,
        clicks,
        ctr: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
      },
      promos: { totalPromos, activePromos, expiredPromos },
      referrals: {
        totalReferrals,
        registeredReferrals,
        regularSubscribers: regularReferralSubscribers,
        vipSubscribers: vipReferralSubscribers,
        premiumSubscribers: premiumReferralSubscribers,
        paidSubscribers: paidReferralSubscribers,
        rewardedReferrals,
        unclaimedReferrals,
      },
    };
  }
}
