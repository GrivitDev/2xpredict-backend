import { AnalyticsLeaderboardService } from './analytics-leaderboard.service';

describe('AnalyticsLeaderboardService aggregation consolidation', () => {
  it('runs all subscription leaderboards in one aggregation and keeps referrals separate', async () => {
    const subscriptionFacetResult = [{
      topSubscribers: [{ userId: 'all-user', totalSubscriptions: 9 }],
      topVipSubscribers: [{ userId: 'vip-user', totalVipSubscriptions: 5 }],
      topRegularSubscribers: [{ userId: 'regular-user', totalRegularSubscriptions: 4 }],
      topPremiumSubscribers: [{ userId: 'premium-user', totalPremiumSubscriptions: 3 }],
    }];
    const subscriptionExec = jest.fn().mockResolvedValue(subscriptionFacetResult);
    const referralRows = [{ userId: 'referrer', successfulReferrals: 7 }];
    const referralExec = jest.fn().mockResolvedValue(referralRows);
    const subscriptionModel = {
      aggregate: jest.fn().mockReturnValue({ exec: subscriptionExec }),
    };
    const referralModel = {
      aggregate: jest.fn().mockReturnValue({ exec: referralExec }),
    };

    const service = new AnalyticsLeaderboardService(
      subscriptionModel as any,
      referralModel as any,
    );

    await expect(service.getLeaderboards()).resolves.toEqual({
      topSubscribers: subscriptionFacetResult[0].topSubscribers,
      topVipSubscribers: subscriptionFacetResult[0].topVipSubscribers,
      topRegularSubscribers: subscriptionFacetResult[0].topRegularSubscribers,
      topPremiumSubscribers: subscriptionFacetResult[0].topPremiumSubscribers,
      topReferrers: referralRows,
    });
    expect(subscriptionModel.aggregate).toHaveBeenCalledTimes(1);
    expect(referralModel.aggregate).toHaveBeenCalledTimes(1);

    const pipeline = subscriptionModel.aggregate.mock.calls[0][0];
    expect(pipeline[0].$facet).toHaveProperty('topSubscribers');
    expect(pipeline[0].$facet).toHaveProperty('topVipSubscribers');
    expect(pipeline[0].$facet).toHaveProperty('topRegularSubscribers');
    expect(pipeline[0].$facet).toHaveProperty('topPremiumSubscribers');
  });
});
