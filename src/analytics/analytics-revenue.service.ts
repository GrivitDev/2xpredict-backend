import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Payment, PaymentDocument } from '../payments/schemas/payment.schema';
import { RevenueBreakdown } from './interfaces/revenue-breakdown.interface';

const VALID_PAYMENT_TYPES = [
  'subscription',
  'vip_upgrade',
  'premium_upgrade',
] as const;

type PaymentStatusCounts = {
  totalPayments: number;
  approvedPayments: number;
  pendingPayments: number;
  processingPayments: number;
  rejectedPayments: number;
};

type CurrencyRevenueRow = {
  _id: string | null;
  totalRevenue: number;
  regularRevenue: number;
  vipRevenue: number;
  premiumRevenue: number;
};

type RevenueFacetResult = {
  paymentCounts: PaymentStatusCounts[];
  revenueByCurrency: CurrencyRevenueRow[];
};

type ExtendedRevenueBreakdown = RevenueBreakdown & Record<string, number>;

function emptyRevenue(): ExtendedRevenueBreakdown {
  return { NGN: 0, USD: 0 } as ExtendedRevenueBreakdown;
}

/** Read-only payment reporting consolidated into one MongoDB aggregation. */
@Injectable()
export class AnalyticsRevenueService {
  constructor(
    @InjectModel(Payment.name)
    private readonly paymentModel: Model<PaymentDocument>,
  ) {}

  async getRevenue() {
    const [result] = await this.paymentModel
      .aggregate<RevenueFacetResult>([
        // All dashboard payment counters have always been limited to these
        // payment types. Keeping the initial match preserves that boundary.
        { $match: { type: { $in: VALID_PAYMENT_TYPES } } },
        {
          $facet: {
            paymentCounts: [
              {
                $group: {
                  _id: null,
                  totalPayments: { $sum: 1 },
                  approvedPayments: {
                    $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] },
                  },
                  pendingPayments: {
                    $sum: {
                      $cond: [
                        { $in: ['$status', ['pending', 'processing']] },
                        1,
                        0,
                      ],
                    },
                  },
                  processingPayments: {
                    $sum: { $cond: [{ $eq: ['$status', 'processing'] }, 1, 0] },
                  },
                  rejectedPayments: {
                    $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] },
                  },
                },
              },
              { $project: { _id: 0 } },
            ],
            revenueByCurrency: [
              { $match: { status: 'approved' } },
              {
                $group: {
                  _id: '$currency',
                  totalRevenue: { $sum: '$amount' },
                  regularRevenue: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ['$type', 'subscription'] },
                            { $eq: ['$target', 'regular'] },
                          ],
                        },
                        '$amount',
                        0,
                      ],
                    },
                  },
                  vipRevenue: {
                    $sum: {
                      $cond: [
                        {
                          $or: [
                            { $eq: ['$type', 'vip_upgrade'] },
                            {
                              $and: [
                                { $eq: ['$type', 'subscription'] },
                                { $eq: ['$target', 'vip'] },
                              ],
                            },
                          ],
                        },
                        '$amount',
                        0,
                      ],
                    },
                  },
                  premiumRevenue: {
                    $sum: {
                      $cond: [
                        {
                          $or: [
                            { $eq: ['$type', 'premium_upgrade'] },
                            {
                              $and: [
                                { $eq: ['$type', 'subscription'] },
                                { $eq: ['$target', 'premium'] },
                              ],
                            },
                          ],
                        },
                        '$amount',
                        0,
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      ])
      .exec();

    const counts = result?.paymentCounts?.[0] ?? {
      totalPayments: 0,
      approvedPayments: 0,
      pendingPayments: 0,
      processingPayments: 0,
      rejectedPayments: 0,
    };

    const totalRevenue = emptyRevenue();
    const regularRevenue = emptyRevenue();
    const vipRevenue = emptyRevenue();
    const premiumRevenue = emptyRevenue();

    // Preserve the previous currency-key behaviour, including currencies
    // other than NGN/USD if such records exist in the payments collection.
    for (const row of result?.revenueByCurrency ?? []) {
      const currency = String(row._id);
      totalRevenue[currency] = row.totalRevenue ?? 0;
      regularRevenue[currency] = row.regularRevenue ?? 0;
      vipRevenue[currency] = row.vipRevenue ?? 0;
      premiumRevenue[currency] = row.premiumRevenue ?? 0;
    }

    return {
      totalRevenue,
      regularRevenue,
      vipRevenue,
      premiumRevenue,
      totalPayments: counts.totalPayments,
      approvedPayments: counts.approvedPayments,
      pendingPayments: counts.pendingPayments,
      processingPayments: counts.processingPayments,
      rejectedPayments: counts.rejectedPayments,
    };
  }
}
