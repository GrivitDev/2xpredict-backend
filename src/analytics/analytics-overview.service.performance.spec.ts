import { AnalyticsOverviewService } from './analytics-overview.service';

function aggregateModel(result: unknown) {
  return {
    aggregate: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(result),
    }),
    countDocuments: jest.fn(),
  };
}

describe('AnalyticsOverviewService aggregation consolidation', () => {
  it('returns the existing dashboard overview shape using one aggregate per collection', async () => {
    const users = aggregateModel([{
      totalUsers: 100,
      activeUsers: 80,
      suspendedUsers: 5,
      deletedUsers: 3,
      verifiedUsers: 70,
      unverifiedUsers: 30,
    }]);
    const subscriptions = aggregateModel([{
      totalSubscriptions: 40,
      activeSubscriptions: 20,
      vipSubscriptions: 10,
      activeVipSubscriptions: 5,
      regularSubscriptions: 20,
      activeRegularSubscriptions: 10,
      premiumSubscriptions: 10,
      activePremiumSubscriptions: 5,
    }]);
    const marketPredictions = aggregateModel([{
      counts: [{
        totalMarketPredictions: 500,
        calculatedMarketPredictions: 400,
        partialMarketPredictions: 30,
        unavailableMarketPredictions: 50,
        failedMarketPredictions: 20,
      }],
      selectionOutcomes: [
        { _id: null, count: 100 },
        { _id: 'WON', count: 200 },
        { _id: 'LOST', count: 150 },
      ],
    }]);
    const curated = aggregateModel([{
      totalCuratedPredictions: 12,
      readyCuratedPredictions: 2,
      publishedCuratedPredictions: 4,
      settledCuratedPredictions: 5,
      cancelledCuratedPredictions: 1,
    }]);
    const ads = aggregateModel([{ totalAds: 8, activeAds: 6, impressions: 1000, clicks: 25 }]);
    const promos = aggregateModel([{ totalPromos: 9, activePromos: 3, expiredPromos: 2 }]);
    const referrals = aggregateModel([{
      totalReferrals: 30,
      registeredReferrals: 20,
      regularReferralSubscribers: 8,
      vipReferralSubscribers: 5,
      premiumReferralSubscribers: 2,
      rewardedReferrals: 10,
      unclaimedReferrals: 20,
      paidReferralSubscribers: 15,
    }]);

    const service = new AnalyticsOverviewService(
      users as any,
      subscriptions as any,
      ads as any,
      promos as any,
      referrals as any,
      marketPredictions as any,
      curated as any,
    );

    await expect(service.getOverview()).resolves.toEqual({
      users: {
        totalUsers: 100,
        activeUsers: 80,
        suspendedUsers: 5,
        deletedUsers: 3,
        verifiedUsers: 70,
        unverifiedUsers: 30,
      },
      subscriptions: {
        totalSubscriptions: 40,
        activeSubscriptions: 20,
        vipSubscriptions: 10,
        activeVipSubscriptions: 5,
        regularSubscriptions: 20,
        activeRegularSubscriptions: 10,
        premiumSubscriptions: 10,
        activePremiumSubscriptions: 5,
      },
      predictions: {
        totalPredictions: 500,
        calculatedMarketPredictions: 400,
        partialMarketPredictions: 30,
        unavailableMarketPredictions: 50,
        failedMarketPredictions: 20,
        totalSelections: 450,
        pendingSelections: 100,
        wonSelections: 200,
        lostSelections: 150,
        voidSelections: 0,
        pushSelections: 0,
        halfWonSelections: 0,
        halfLostSelections: 0,
        totalCuratedPredictions: 12,
        readyCuratedPredictions: 2,
        publishedCuratedPredictions: 4,
        settledCuratedPredictions: 5,
        cancelledCuratedPredictions: 1,
      },
      ads: {
        totalAds: 8,
        activeAds: 6,
        impressions: 1000,
        clicks: 25,
        ctr: 2.5,
      },
      promos: { totalPromos: 9, activePromos: 3, expiredPromos: 2 },
      referrals: {
        totalReferrals: 30,
        registeredReferrals: 20,
        regularSubscribers: 8,
        vipSubscribers: 5,
        premiumSubscribers: 2,
        paidSubscribers: 15,
        rewardedReferrals: 10,
        unclaimedReferrals: 20,
      },
    });

    for (const model of [users, subscriptions, marketPredictions, curated, ads, promos, referrals]) {
      expect(model.aggregate).toHaveBeenCalledTimes(1);
      expect(model.countDocuments).not.toHaveBeenCalled();
    }
  });

  it('returns zero-valued counters when every collection is empty', async () => {
    const models = Array.from({ length: 7 }, () => aggregateModel([]));
    const [users, subscriptions, ads, promos, referrals, predictions, curated] = models;
    predictions.aggregate.mockReturnValue({
      exec: jest.fn().mockResolvedValue([{ counts: [], selectionOutcomes: [] }]),
    });

    const service = new AnalyticsOverviewService(
      users as any,
      subscriptions as any,
      ads as any,
      promos as any,
      referrals as any,
      predictions as any,
      curated as any,
    );

    const result = await service.getOverview();
    expect(result.users).toEqual({
      totalUsers: 0,
      activeUsers: 0,
      suspendedUsers: 0,
      deletedUsers: 0,
      verifiedUsers: 0,
      unverifiedUsers: 0,
    });
    expect(result.ads).toEqual({
      totalAds: 0,
      activeAds: 0,
      impressions: 0,
      clicks: 0,
      ctr: 0,
    });
  });
});
