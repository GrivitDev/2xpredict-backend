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

@Injectable()
export class AnalyticsRevenueService {
  constructor(
    @InjectModel(Payment.name)
    private readonly paymentModel: Model<PaymentDocument>,
  ) {}

  async getRevenue() {
    const approved = { status: 'approved', type: { $in: VALID_PAYMENT_TYPES } };
    const [
      totalRevenue,
      vipRevenue,
      regularRevenue,
      premiumRevenue,
      totalPayments,
      approvedPayments,
      pendingPayments,
      rejectedPayments,
    ] = await Promise.all([
      this.sumRevenue(approved),
      this.sumRevenue({
        status: 'approved',
        $or: [{ type: 'vip_upgrade' }, { type: 'subscription', target: 'vip' }],
      }),
      this.sumRevenue({
        status: 'approved',
        type: 'subscription',
        target: 'regular',
      }),
      this.sumRevenue({
        status: 'approved',
        $or: [
          { type: 'premium_upgrade' },
          { type: 'subscription', target: 'premium' },
        ],
      }),
      this.paymentModel.countDocuments({ type: { $in: VALID_PAYMENT_TYPES } }),
      this.paymentModel.countDocuments({
        status: 'approved',
        type: { $in: VALID_PAYMENT_TYPES },
      }),
      this.paymentModel.countDocuments({
        status: 'pending',
        type: { $in: VALID_PAYMENT_TYPES },
      }),
      this.paymentModel.countDocuments({
        status: 'rejected',
        type: { $in: VALID_PAYMENT_TYPES },
      }),
    ]);

    return {
      totalRevenue,
      regularRevenue,
      vipRevenue,
      premiumRevenue,
      totalPayments,
      approvedPayments,
      pendingPayments,
      rejectedPayments,
    };
  }

  private async sumRevenue(
    match: Record<string, unknown>,
  ): Promise<RevenueBreakdown> {
    const result = await this.paymentModel.aggregate<{
      _id: 'NGN' | 'USD';
      total: number;
    }>([
      { $match: match },
      { $group: { _id: '$currency', total: { $sum: '$amount' } } },
    ]);

    const revenue: RevenueBreakdown = { NGN: 0, USD: 0 };
    for (const item of result) revenue[item._id] = item.total;
    return revenue;
  }
}
