import { AnalyticsRevenueService } from './analytics-revenue.service';

describe('AnalyticsRevenueService aggregation consolidation', () => {
  it('returns the existing currency breakdowns and payment counters from one aggregation', async () => {
    const exec = jest.fn().mockResolvedValue([{
      paymentCounts: [{
        totalPayments: 100,
        approvedPayments: 60,
        pendingPayments: 20,
        processingPayments: 5,
        rejectedPayments: 15,
      }],
      revenueByCurrency: [
        {
          _id: 'NGN',
          totalRevenue: 1_000_000,
          regularRevenue: 300_000,
          vipRevenue: 400_000,
          premiumRevenue: 300_000,
        },
        {
          _id: 'USD',
          totalRevenue: 200,
          regularRevenue: 50,
          vipRevenue: 100,
          premiumRevenue: 50,
        },
      ],
    }]);
    const paymentModel = {
      aggregate: jest.fn().mockReturnValue({ exec }),
      countDocuments: jest.fn(),
    };

    const service = new AnalyticsRevenueService(paymentModel as any);

    await expect(service.getRevenue()).resolves.toEqual({
      totalRevenue: { NGN: 1_000_000, USD: 200 },
      regularRevenue: { NGN: 300_000, USD: 50 },
      vipRevenue: { NGN: 400_000, USD: 100 },
      premiumRevenue: { NGN: 300_000, USD: 50 },
      totalPayments: 100,
      approvedPayments: 60,
      pendingPayments: 20,
      processingPayments: 5,
      rejectedPayments: 15,
    });
    expect(paymentModel.aggregate).toHaveBeenCalledTimes(1);
    expect(paymentModel.countDocuments).not.toHaveBeenCalled();
  });

  it('returns empty NGN/USD breakdowns and zero counters when no payments match', async () => {
    const paymentModel = {
      aggregate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([{ paymentCounts: [], revenueByCurrency: [] }]),
      }),
      countDocuments: jest.fn(),
    };

    const service = new AnalyticsRevenueService(paymentModel as any);
    await expect(service.getRevenue()).resolves.toEqual({
      totalRevenue: { NGN: 0, USD: 0 },
      regularRevenue: { NGN: 0, USD: 0 },
      vipRevenue: { NGN: 0, USD: 0 },
      premiumRevenue: { NGN: 0, USD: 0 },
      totalPayments: 0,
      approvedPayments: 0,
      pendingPayments: 0,
      processingPayments: 0,
      rejectedPayments: 0,
    });
  });
});
