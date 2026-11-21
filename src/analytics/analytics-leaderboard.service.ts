import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Subscription, SubscriptionDocument } from '../subscriptions/schemas/subscription.schema';
import { Referral, ReferralDocument } from '../referrals/schemas/referral.schema';

type SubscriptionLeaderboardFacet = {
  topSubscribers: unknown[];
  topVipSubscribers: unknown[];
  topRegularSubscribers: unknown[];
  topPremiumSubscribers: unknown[];
};

@Injectable()
export class AnalyticsLeaderboardService {
  constructor(
    @InjectModel(Subscription.name) private readonly subscriptionModel: Model<SubscriptionDocument>,
    @InjectModel(Referral.name) private readonly referralModel: Model<ReferralDocument>,
  ) {}

  async getLeaderboards() {
    // Four subscription rankings previously scanned the same collection in
    // four separate aggregate commands. A $facet shares the input scan while
    // retaining each ranking's original grouping, tie-break and top-five limit.
    const [subscriptionFacets, topReferrers] = await Promise.all([
      this.subscriptionModel.aggregate<SubscriptionLeaderboardFacet>([
        {
          $facet: {
            topSubscribers: this.topSubscribersPipeline(),
            topVipSubscribers: this.topPlanSubscribersPipeline(
              'vip',
              'totalVipSubscriptions',
            ),
            topRegularSubscribers: this.topPlanSubscribersPipeline(
              'regular',
              'totalRegularSubscriptions',
            ),
            topPremiumSubscribers: this.topPlanSubscribersPipeline(
              'premium',
              'totalPremiumSubscriptions',
            ),
          },
        },
      ]).exec(),
      this.getTopReferrers(),
    ]);

    const rankings = subscriptionFacets[0];
    return {
      topSubscribers: rankings?.topSubscribers ?? [],
      topVipSubscribers: rankings?.topVipSubscribers ?? [],
      topRegularSubscribers: rankings?.topRegularSubscribers ?? [],
      topPremiumSubscribers: rankings?.topPremiumSubscribers ?? [],
      topReferrers,
    };
  }

  private topSubscribersPipeline(): any[] {
    return [
      {
        $group: {
          _id: '$userId',
          totalSubscriptions: { $sum: 1 },
        },
      },
      { $sort: { totalSubscriptions: -1, _id: 1 } },
      { $limit: 5 },
      ...this.lookupUser(),
    ];
  }

  private topPlanSubscribersPipeline(
    plan: 'vip' | 'regular' | 'premium',
    countField: string,
  ): any[] {
    return [
      { $match: { plan } },
      { $group: { _id: '$userId', [countField]: { $sum: 1 } } },
      { $sort: { [countField]: -1, _id: 1 } },
      { $limit: 5 },
      ...this.lookupUser(),
    ];
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

  private lookupUser(): any[] {
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
