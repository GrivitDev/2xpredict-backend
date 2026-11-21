import { AnalyticsService } from './analytics.service';

function execModel(result: unknown) {
  const exec = jest.fn().mockResolvedValue(result);
  return {
    aggregate: jest.fn().mockReturnValue({ exec }),
    countDocuments: jest.fn(),
    exec,
  };
}

describe('AnalyticsService Stage 4 public statistics performance', () => {
  it('calculates all public prediction counters in one MarketPrediction aggregation', async () => {
    const userCountExec = jest.fn().mockResolvedValue(120);
    const userModel = {
      countDocuments: jest.fn().mockReturnValue({ exec: userCountExec }),
    };
    const subscriptions = execModel([{ count: 34 }]);
    const marketPredictions = execModel([
      {
        marketsPredicted: [{ count: 240 }],
        marketWinCounts: [{ count: 91 }],
        matchesPredictedCounts: [{ count: 48 }],
        settledMatchCounts: [{ count: 39 }],
      },
    ]);
    const sportsRead = {
      countCompetitions: jest.fn().mockResolvedValue(18),
    };
    const oddsRead = {
      getMarketCatalog: jest.fn().mockReturnValue([
        { pricingEnabled: true },
        { pricingEnabled: false },
        { pricingEnabled: true },
      ]),
    };

    const service = new AnalyticsService(
      userModel as any,
      subscriptions as any,
      marketPredictions as any,
      sportsRead as any,
      oddsRead as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.getPublicStats();

    expect(result).toEqual({
      registeredUsers: 120,
      subscribers: 34,
      marketsPredicted: 240,
      totalMarkets: 3,
      pricingEnabledMarkets: 2,
      marketsWon: 91,
      matchesPredicted: 48,
      activeLeagues: 18,
      settledMatches: 39,
      updatedAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(result.updatedAt))).toBe(false);

    expect(marketPredictions.aggregate).toHaveBeenCalledTimes(1);
    expect(marketPredictions.countDocuments).not.toHaveBeenCalled();
    expect(subscriptions.aggregate).toHaveBeenCalledTimes(1);
    expect(userModel.countDocuments).toHaveBeenCalledTimes(1);
    expect(sportsRead.countCompetitions).toHaveBeenCalledWith({ activeOnly: true });

    const pipeline = marketPredictions.aggregate.mock.calls[0][0];
    expect(pipeline).toHaveLength(2);
    expect(pipeline[0]).toEqual({
      $match: {
        status: { $in: ['CALCULATED', 'PARTIAL'] },
        selections: { $elemMatch: { isFinalSelection: true } },
      },
    });
    expect(Object.keys(pipeline[1].$facet)).toEqual([
      'marketsPredicted',
      'marketWinCounts',
      'matchesPredictedCounts',
      'settledMatchCounts',
    ]);
    expect(pipeline[1].$facet.marketWinCounts).toContainEqual({
      $match: {
        selections: {
          $elemMatch: {
            isFinalSelection: true,
            actualOutcome: 'WON',
          },
        },
      },
    });
    expect(pipeline[1].$facet.settledMatchCounts).toContainEqual({
      $match: { 'selections.isFinalSelection': true },
    });
  });

  it('returns zero prediction counters for empty facet results and reuses the one-minute cache', async () => {
    const users = {
      countDocuments: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(0),
      }),
    };
    const subscriptions = execModel([]);
    const marketPredictions = execModel([
      {
        marketsPredicted: [],
        marketWinCounts: [],
        matchesPredictedCounts: [],
        settledMatchCounts: [],
      },
    ]);
    const sportsRead = {
      countCompetitions: jest.fn().mockResolvedValue(0),
    };
    const oddsRead = { getMarketCatalog: jest.fn().mockReturnValue([]) };

    const service = new AnalyticsService(
      users as any,
      subscriptions as any,
      marketPredictions as any,
      sportsRead as any,
      oddsRead as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const first = await service.getPublicStats();
    const second = await service.getPublicStats();

    expect(first).toEqual({
      registeredUsers: 0,
      subscribers: 0,
      marketsPredicted: 0,
      totalMarkets: 0,
      pricingEnabledMarkets: 0,
      marketsWon: 0,
      matchesPredicted: 0,
      activeLeagues: 0,
      settledMatches: 0,
      updatedAt: expect.any(String),
    });
    expect(second).toBe(first);
    expect(marketPredictions.aggregate).toHaveBeenCalledTimes(1);
    expect(subscriptions.aggregate).toHaveBeenCalledTimes(1);
    expect(users.countDocuments).toHaveBeenCalledTimes(1);
    expect(sportsRead.countCompetitions).toHaveBeenCalledTimes(1);
  });
});
