import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Subscription, SubscriptionDocument } from '../subscriptions/schemas/subscription.schema';
import { Referral, ReferralDocument } from '../referrals/schemas/referral.schema';

@Injectable()
export class AnalyticsLeaderboardService {
  constructor(
    @InjectModel(Subscription.name) private readonly subscriptionModel: Model<SubscriptionDocument>,
    @InjectModel(Referral.name) private readonly referralModel: Model<ReferralDocument>,
  ) {}

  async getLeaderboards() {
    const [topSubscribers, topVipSubscribers, topRegularSubscribers, topPremiumSubscribers, topReferrers] =
      await Promise.all([
        this.getTopSubscribers(),
        this.getTopPlanSubscribers('vip', 'totalVipSubscriptions'),
        this.getTopPlanSubscribers('regular', 'totalRegularSubscriptions'),
        this.getTopPlanSubscribers('premium', 'totalPremiumSubscriptions'),
        this.getTopReferrers(),
      ]);

    return { topSubscribers, topVipSubscribers, topRegularSubscribers, topPremiumSubscribers, topReferrers };
  }

  private async getTopSubscribers() {
    return this.subscriptionModel.aggregate([
      {
        $group: {
          _id: '$userId',
          totalSubscriptions: { $sum: 1 },
        },
      },
      { $sort: { totalSubscriptions: -1, _id: 1 } },
      { $limit: 5 },
      ...this.lookupUser(),
    ]).exec();
  }

  private async getTopPlanSubscribers(plan: 'vip' | 'regular' | 'premium', countField: string) {
    return this.subscriptionModel.aggregate([
      { $match: { plan } },
      { $group: { _id: '$userId', [countField]: { $sum: 1 } } },
      { $sort: { [countField]: -1, _id: 1 } },
      { $limit: 5 },
      ...this.lookupUser(),
    ]).exec();
  }

  private async getTopReferrers() {
    return this.referralModel.aggregate([
      { $group: { _id: '$referrerId', successfulReferrals: { $sum: 1 } } },
      { $sort: { successfulReferrals: -1, _id: 1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },
      {
        $project: {
          _id: 0,
          userId: '$user._id',
          fullName: '$user.fullName',
          username: '$user.username',
          email: '$user.email',
          successfulReferrals: 1,
        },
      },
    ]).exec();
  }

  private lookupUser() {
    return [
      {
        $addFields: {
          userObjectId: {
            $convert: { input: '$_id', to: 'objectId', onError: null, onNull: null },
          },
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'userObjectId',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },
      {
        $project: {
          _id: 0,
          userId: '$user._id',
          fullName: '$user.fullName',
          username: '$user.username',
          email: '$user.email',
          totalSubscriptions: 1,
          totalVipSubscriptions: 1,
          totalRegularSubscriptions: 1,
          totalPremiumSubscriptions: 1,
        },
      },
    ];
  }
}
