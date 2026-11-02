import { Injectable, BadRequestException } from '@nestjs/common';

import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';

import { Payment, PaymentDocument } from './schemas/payment.schema';

import { SubscriptionsService } from '../subscriptions/subscriptions.service';

import { AdminGateway } from '../realtime/admin.gateway';
import { ReferralsService } from '../referrals/referrals.service';
import { PlanConfigService } from '../plan-config/plan-config.service';
import { EmailService } from '../notifications/email.service';
import { TelegramService } from '../telegram/telegram.service';
import { UsersService } from '../users/users.service';
import { PromosService, PromoPricingResult } from '../promos/promos.service';

const ACTIVE_PAYMENT_TYPES = [
  'subscription',
  'vip_upgrade',
  'premium_upgrade',
] as const satisfies readonly Payment['type'][];
type PaidPlan = 'regular' | 'vip' | 'premium';

@Injectable()
export class PaymentsService {
  constructor(
    @InjectModel(Payment.name)
    private paymentModel: Model<PaymentDocument>,

    private usersService: UsersService,

    private subscriptionsService: SubscriptionsService,

    private adminGateway: AdminGateway,

    private referralsService: ReferralsService,

    private telegramService: TelegramService,

    private readonly planConfigService: PlanConfigService,

    private emailService: EmailService,
    private readonly promosService: PromosService,
  ) {}

  private validatePaymentTypeAndTarget(type: string, target: string): void {
    if (
      !ACTIVE_PAYMENT_TYPES.includes(
        type as (typeof ACTIVE_PAYMENT_TYPES)[number],
      )
    ) {
      throw new BadRequestException('Unsupported payment type.');
    }

    if (type === 'subscription') {
      if (!['regular', 'vip', 'premium'].includes(target)) {
        throw new BadRequestException('Invalid subscription plan.');
      }
      return;
    }

    if (type === 'vip_upgrade' && target !== 'vip') {
      throw new BadRequestException('Invalid VIP upgrade target.');
    }

    if (type === 'premium_upgrade' && target !== 'premium') {
      throw new BadRequestException('Invalid Premium upgrade target.');
    }
  }

  private async getUserPricing(userId: string) {
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new BadRequestException('User not found');
    }

    const config = await this.planConfigService.get();

    return {
      currency: user.currency,
      pricing:
        user.currency === 'USD'
          ? {
              regular: config.regularPriceUSD,
              vip: config.vipPriceUSD,
              premium: config.premiumPriceUSD,
            }
          : {
              regular: config.regularPrice,
              vip: config.vipPrice,
              premium: config.premiumPrice,
            },
    };
  }

  // =====================================
  // CREATE MANUAL PAYMENT
  // =====================================
  async createPayment(dto: {
    userId: string;
    email: string;
    type: 'subscription' | 'vip_upgrade' | 'premium_upgrade';
    target: string;

    transferReference?: string;
    proofImageUrl?: string;
    proofPublicId?: string;
    proofMessage?: string;
    promoCode?: string;
  }) {
    this.validatePaymentTypeAndTarget(dto.type, dto.target);
    const existingPending = await this.paymentModel.findOne({
      userId: dto.userId,
      type: dto.type,
      target: dto.target,
      status: 'pending',
    });

    if (existingPending) {
      throw new BadRequestException(
        'You already have a pending payment request',
      );
    }

    const pricing = await this.calculateGatewayPaymentAmount({
      userId: dto.userId, type: dto.type, target: dto.target, promoCode: dto.promoCode,
    });
    const { amount, currency } = pricing;

    const reference = randomUUID();

    const payment = await this.paymentModel.create({
      userId: dto.userId,
      email: dto.email,

      amount,
      baseAmount: pricing.baseAmount,
      discountAmount: pricing.discountAmount,
      promoCode: pricing.promoCode,
      promoId: pricing.promoId,
      discountType: pricing.discountType,
      discountValue: pricing.discountValue,
      pointsReward: pricing.pointsReward,
      currency,

      type: dto.type,
      target: dto.target,

      reference,

      status: 'pending',

      transferReference: dto.transferReference || '',
      proofImageUrl: dto.proofImageUrl || '',
      proofPublicId: dto.proofPublicId || '',
      proofMessage: dto.proofMessage || '',

      processedAt: undefined,
      processedBy: undefined,
      adminNote: '',
    });

    try {
      await this.promosService.reserveRedemption({
        promoId: pricing.promoId, userId: dto.userId, paymentReference: reference,
        baseAmount: pricing.baseAmount, discountAmount: pricing.discountAmount,
        finalAmount: amount, pointsReward: pricing.pointsReward, currency,
      });
    } catch (error) {
      await this.paymentModel.deleteOne({ reference }).exec();
      throw error;
    }

    await this.emailService.sendPaymentReceivedEmail({
      email: payment.email,

      amount: payment.amount,
      currency: payment.currency,

      paymentType:
        payment.type === 'subscription'
          ? `${payment.target.toUpperCase()} Subscription`
          : payment.type === 'vip_upgrade'
            ? 'VIP Upgrade'
            : 'Premium Upgrade',

      reference: payment.reference,
    });

    await this.telegramService.notifyNewPayment({
      fullName: dto.email,
      email: dto.email,

      amount,
      currency,

      type: dto.type,

      target: dto.target,

      proofImageUrl: dto.proofImageUrl,
    });

    this.adminGateway.emitNewPayment(payment);
    return {
      message: 'Payment submitted',
      reference,
      payment,
    };
  }

  // =====================================
  // CALCULATE GATEWAY PAYMENT AMOUNT
  // =====================================
  async calculateGatewayPaymentAmount(dto: {
    userId: string;

    type: 'subscription' | 'vip_upgrade' | 'premium_upgrade';

    target: string;
    promoCode?: string;
  }): Promise<PromoPricingResult & { currency: 'NGN' | 'USD' }> {
    this.validatePaymentTypeAndTarget(dto.type, dto.target);
    const { currency, pricing } = await this.getUserPricing(dto.userId);

    let amount = 0;

    const prices = {
      regular: pricing.regular,
      vip: pricing.vip,
      premium: pricing.premium,
    };

    if (dto.type === 'subscription') {
      if (!['regular', 'vip', 'premium'].includes(dto.target)) {
        throw new BadRequestException('Invalid subscription plan.');
      }
      amount = prices[dto.target as PaidPlan];
    } else {
      const targetPlan: PaidPlan =
        dto.type === 'vip_upgrade' ? 'vip' : 'premium';
      if (dto.target !== targetPlan) {
        throw new BadRequestException(`Invalid ${targetPlan} upgrade target.`);
      }

      const upgrade = await this.subscriptionsService.calculatePlanUpgradePrice(
        dto.userId,
        prices,
        targetPlan,
        30,
        currency,
      );

      if (!upgrade.canUpgrade) {
        throw new BadRequestException(
          `You are not eligible for a ${targetPlan} upgrade.`,
        );
      }
      amount = upgrade.amount;
    }

    const plan = dto.target as PaidPlan;
    const discounted = await this.promosService.calculateDiscount({
      userId: dto.userId,
      promoCode: dto.promoCode,
      plan,
      purchaseType: dto.type,
      baseAmount: amount,
      currency,
    });
    return { ...discounted, currency };
  }

  // =====================================
  // CREATE GATEWAY PAYMENT RECORD
  // =====================================
  async createGatewayPaymentRecord(dto: {
    userId: string;

    email: string;

    type: 'subscription' | 'vip_upgrade' | 'premium_upgrade';

    target: string;

    gateway: 'paystack';

    amount: number;
    baseAmount: number;
    discountAmount: number;
    promoId?: string;
    promoCode?: string;
    discountType?: 'percentage' | 'fixed_amount';
    discountValue?: number;
    pointsReward?: number;
    currency: 'NGN' | 'USD';

    gatewayAmount: number;

    gatewayCurrency: 'NGN';

    exchangeRate?: number;
  }) {
    this.validatePaymentTypeAndTarget(dto.type, dto.target);
    const existingPending = await this.paymentModel.findOne({
      userId: dto.userId,
      type: dto.type,
      target: dto.target,
      status: 'pending',
    });

    if (existingPending) {
      throw new BadRequestException(
        'You already have a pending payment. If not activated, try again after 30 minutes or contact the admin.',
      );
    }

    const payment = await this.paymentModel.create({
      userId: dto.userId,

      email: dto.email,

      // Final customer amount after server-side discount calculation
      amount: dto.amount,
      baseAmount: dto.baseAmount,
      discountAmount: dto.discountAmount,
      promoId: dto.promoId,
      promoCode: dto.promoCode,
      discountType: dto.discountType,
      discountValue: dto.discountValue,
      pointsReward: dto.pointsReward ?? 0,

      // Original customer currency
      currency: dto.currency,

      // Actual amount sent to gateway
      gatewayAmount: dto.gatewayAmount,

      // Gateway currency
      gatewayCurrency: dto.gatewayCurrency,

      // Exchange rate used
      exchangeRate: dto.exchangeRate,

      type: dto.type,

      target: dto.target,

      reference: randomUUID(),

      gateway: dto.gateway,

      status: 'pending',

      transferReference: '',
      proofImageUrl: '',
      proofPublicId: '',
      proofMessage: '',
      adminNote: '',

      gatewayTransactionId: '',
      gatewayResponse: null,
    });

    try {
      await this.promosService.reserveRedemption({
        promoId: dto.promoId, userId: dto.userId, paymentReference: payment.reference,
        baseAmount: dto.baseAmount, discountAmount: dto.discountAmount,
        finalAmount: dto.amount, pointsReward: dto.pointsReward, currency: dto.currency,
      });
    } catch (error) {
      await this.paymentModel.deleteOne({ reference: payment.reference }).exec();
      throw error;
    }

    await this.telegramService.notifyNewPayment({
      fullName: dto.email,

      email: dto.email,

      amount: dto.amount,

      currency: dto.currency,

      type: dto.type,

      target: dto.target,
    });

    this.adminGateway.emitNewPayment(payment);

    return payment;
  }
  // =====================================
  // FIND PAYMENT
  // =====================================
  async findPaymentByReference(reference: string) {
    return this.paymentModel.findOne({
      reference,
    });
  }

  // =====================================
  // APPROVE VERIFIED GATEWAY PAYMENT
  // =====================================
  async approveGatewayPayment(
    reference: string,
    gatewayTransactionId: string,
    gatewayResponse: Record<string, any>,
  ) {
    const payment = await this.paymentModel.findOne({
      reference,
    });

    if (!payment) {
      throw new BadRequestException('Payment not found.');
    }

    if (payment.status === 'approved') return payment;

    if (payment.status !== 'pending') {
      throw new BadRequestException('Payment has already been processed.');
    }

    this.validatePaymentTypeAndTarget(payment.type, payment.target);

    // Entitlements are granted idempotently by payment reference first. The
    // payment is marked approved only after the core entitlement operation succeeds.
    const config = await this.planConfigService.get();

    // =====================================
    // SUBSCRIPTION
    // =====================================
    if (payment.type === 'subscription') {
      const plan = payment.target?.trim();

      if (plan !== 'regular' && plan !== 'vip' && plan !== 'premium') {
        throw new BadRequestException('Invalid subscription plan.');
      }

      const subscription = await this.subscriptionsService.activatePlan({
        userId: payment.userId,
        email: payment.email,
        plan,
        amount: payment.amount,
        durationDays: config.subscriptionDurationDays,
        sourceReference: `payment:${String(payment._id)}`,
      });

      await this.emailService.sendSubscriptionActivatedEmail({
        email: payment.email,

        plan: subscription.plan,

        amount: payment.amount,
        currency: payment.currency,

        activatedDate: subscription.startDate,

        expiryDate: subscription.expiryDate,
      });

      if (plan === 'regular') {
        await this.referralsService.markRegularSubscription(payment.userId);
      }

      if (plan === 'vip') {
        await this.referralsService.markVipSubscription(payment.userId);
      }
      if (plan === 'premium') {
        await this.referralsService.markPremiumSubscription(payment.userId);
      }
    }

    // =====================================
    // VIP / PREMIUM UPGRADE
    // =====================================
    if (payment.type === 'vip_upgrade' || payment.type === 'premium_upgrade') {
      const plan: PaidPlan = payment.type === 'vip_upgrade' ? 'vip' : 'premium';
      if (payment.target !== plan) {
        throw new BadRequestException(`Invalid ${plan} upgrade target.`);
      }

      const subscription = await this.subscriptionsService.activatePlan({
        userId: payment.userId,
        email: payment.email,
        plan,
        amount: payment.amount,
        durationDays: 30,
        sourceReference: `payment:${String(payment._id)}`,
      });

      await this.emailService.sendSubscriptionActivatedEmail({
        email: payment.email,
        plan: subscription.plan,
        amount: payment.amount,
        currency: payment.currency,
        activatedDate: subscription.startDate,
        expiryDate: subscription.expiryDate,
      });

      if (plan === 'vip') {
        await this.referralsService.markVipSubscription(payment.userId);
      } else {
        await this.referralsService.markPremiumSubscription(payment.userId);
      }
    }

    await this.promosService.completeSuccessfulRedemption({
      promoId: payment.promoId, userId: payment.userId, reference: payment.reference, pointsReward: payment.pointsReward,
    });

    payment.status = 'approved';
    payment.gatewayTransactionId = gatewayTransactionId;
    payment.gatewayResponse = gatewayResponse;
    payment.processedAt = new Date();
    await payment.save();

    this.adminGateway.emitPaymentUpdate(payment);
    return payment;
  }

  // =====================================
  // REJECT GATEWAY PAYMENT
  // =====================================
  async rejectGatewayPayment(
    reference: string,
    gatewayResponse?: Record<string, any>,
  ) {
    const payment = await this.paymentModel.findOne({
      reference,
    });

    if (!payment) {
      throw new BadRequestException('Payment not found.');
    }

    if (payment.status !== 'pending') {
      return payment;
    }

    this.validatePaymentTypeAndTarget(payment.type, payment.target);

    payment.status = 'rejected';

    payment.gatewayResponse = gatewayResponse ?? null;

    payment.processedAt = new Date();

    await payment.save();
    await this.promosService.releaseRedemption(payment.reference);

    return payment;
  }

  // =====================================
  // APPROVE MANUAL PAYMENT
  // =====================================
  async approvePayment(paymentId: string, adminId: string) {
    const payment = await this.paymentModel.findById(paymentId);

    if (!payment) {
      throw new BadRequestException('Payment not found');
    }

    if (payment.status !== 'pending') {
      throw new BadRequestException('Already processed');
    }

    this.validatePaymentTypeAndTarget(payment.type, payment.target);

    // Grant the entitlement first; sourceReference makes retries idempotent.
    const config = await this.planConfigService.get();

    // =====================================
    // SUBSCRIPTION
    // =====================================
    if (payment.type === 'subscription') {
      const plan = payment.target?.trim();

      if (plan !== 'regular' && plan !== 'vip' && plan !== 'premium') {
        throw new BadRequestException('Invalid subscription plan');
      }

      const subscription = await this.subscriptionsService.activatePlan({
        userId: payment.userId,
        email: payment.email,
        plan,
        amount: payment.amount,
        durationDays: config.subscriptionDurationDays,
        sourceReference: `payment:${String(payment._id)}`,
      });

      await this.emailService.sendSubscriptionActivatedEmail({
        email: payment.email,

        plan: subscription.plan,

        amount: payment.amount,
        currency: payment.currency,

        activatedDate: subscription.startDate,

        expiryDate: subscription.expiryDate,
      });

      if (plan === 'regular') {
        await this.referralsService.markRegularSubscription(payment.userId);
      }

      if (plan === 'vip') {
        await this.referralsService.markVipSubscription(payment.userId);
      }
      if (plan === 'premium') {
        await this.referralsService.markPremiumSubscription(payment.userId);
      }
    }

    // =====================================
    // VIP / PREMIUM UPGRADE
    // =====================================
    if (payment.type === 'vip_upgrade' || payment.type === 'premium_upgrade') {
      const plan: PaidPlan = payment.type === 'vip_upgrade' ? 'vip' : 'premium';
      if (payment.target !== plan) {
        throw new BadRequestException(`Invalid ${plan} upgrade target.`);
      }

      const subscription = await this.subscriptionsService.activatePlan({
        userId: payment.userId,
        email: payment.email,
        plan,
        amount: payment.amount,
        durationDays: 30,
        sourceReference: `payment:${String(payment._id)}`,
      });

      await this.emailService.sendSubscriptionActivatedEmail({
        email: payment.email,
        plan: subscription.plan,
        amount: payment.amount,
        currency: payment.currency,
        activatedDate: subscription.startDate,
        expiryDate: subscription.expiryDate,
      });

      if (plan === 'vip') {
        await this.referralsService.markVipSubscription(payment.userId);
      } else {
        await this.referralsService.markPremiumSubscription(payment.userId);
      }
    }

    await this.promosService.completeSuccessfulRedemption({
      promoId: payment.promoId, userId: payment.userId, reference: payment.reference, pointsReward: payment.pointsReward,
    });

    payment.status = 'approved';
    payment.processedAt = new Date();
    payment.processedBy = adminId;
    await payment.save();
    this.adminGateway.emitPaymentUpdate(payment);

    return {
      message: 'Payment approved',
      payment,
    };
  }

  // =====================================
  // USER PAYMENTS
  // =====================================
  async getUserPayments(userId: string) {
    return this.paymentModel
      .find({
        userId,
        type: { $in: ACTIVE_PAYMENT_TYPES },
      })
      .sort({ createdAt: -1 });
  }

  // =====================================
  // REJECT MANUAL PAYMENT
  // =====================================
  async rejectPayment(paymentId: string, adminId: string, adminNote?: string) {
    const payment = await this.paymentModel.findById(paymentId);

    if (!payment) {
      throw new BadRequestException('Payment not found');
    }

    if (payment.status !== 'pending') {
      throw new BadRequestException('Already processed');
    }

    this.validatePaymentTypeAndTarget(payment.type, payment.target);

    payment.status = 'rejected';

    payment.processedAt = new Date();

    payment.processedBy = adminId;

    payment.adminNote = adminNote || '';

    await payment.save();
    await this.promosService.releaseRedemption(payment.reference);

    await this.emailService.sendPaymentRejectedEmail({
      email: payment.email,

      paymentType:
        payment.type === 'subscription'
          ? `${payment.target.toUpperCase()} Subscription`
          : payment.type === 'vip_upgrade'
            ? 'VIP Upgrade'
            : 'Premium Upgrade',

      amount: payment.amount,
      currency: payment.currency,

      reason: payment.adminNote,
    });
    return payment;
  }

  // =====================================
  // ADMIN QUERIES
  // =====================================
  async getPendingPayments() {
    return this.paymentModel
      .find({ status: 'pending', type: { $in: ACTIVE_PAYMENT_TYPES } })
      .sort({
        createdAt: -1,
      });
  }

  async getAllPayments() {
    return this.paymentModel
      .find({ type: { $in: ACTIVE_PAYMENT_TYPES } })
      .sort({
        createdAt: -1,
      });
  }

  async getTotalRevenue() {
    const payments = await this.paymentModel.find({
      status: 'approved',
      type: { $in: ACTIVE_PAYMENT_TYPES },
    });

    return {
      NGN: payments
        .filter((p) => p.currency === 'NGN')
        .reduce((sum, p) => sum + p.amount, 0),

      USD: payments
        .filter((p) => p.currency === 'USD')
        .reduce((sum, p) => sum + p.amount, 0),
    };
  }

  // =====================================
  // USER PAYMENT SUMMARY
  // =====================================
  async getPaymentSummary(userId: string) {
    const payments = await this.paymentModel
      .find({ userId, type: { $in: ACTIVE_PAYMENT_TYPES } })
      .sort({ createdAt: -1 });

    const approved = payments.filter((p) => p.status === 'approved');
    const pending = payments.filter((p) => p.status === 'pending');
    const rejected = payments.filter((p) => p.status === 'rejected');

    const approvedNGN = approved.filter((p) => p.currency === 'NGN');
    const approvedUSD = approved.filter((p) => p.currency === 'USD');

    const subscriptionNGN = approvedNGN.filter(
      (p) =>
        p.type === 'subscription' ||
        p.type === 'vip_upgrade' ||
        p.type === 'premium_upgrade',
    );

    const subscriptionUSD = approvedUSD.filter(
      (p) =>
        p.type === 'subscription' ||
        p.type === 'vip_upgrade' ||
        p.type === 'premium_upgrade',
    );

    return {
      payments,

      latestPayments: payments.slice(0, 10),

      revenue: {
        total: {
          NGN: approvedNGN.reduce((sum, p) => sum + p.amount, 0),
          USD: approvedUSD.reduce((sum, p) => sum + p.amount, 0),
        },

        subscriptions: {
          NGN: subscriptionNGN.reduce((sum, p) => sum + p.amount, 0),
          USD: subscriptionUSD.reduce((sum, p) => sum + p.amount, 0),
        },

        plans: {
          regular: {
            NGN: approvedNGN
              .filter(
                (p) => p.type === 'subscription' && p.target === 'regular',
              )
              .reduce((sum, p) => sum + p.amount, 0),
            USD: approvedUSD
              .filter(
                (p) => p.type === 'subscription' && p.target === 'regular',
              )
              .reduce((sum, p) => sum + p.amount, 0),
          },
          vip: {
            NGN: approvedNGN
              .filter(
                (p) =>
                  (p.type === 'subscription' && p.target === 'vip') ||
                  p.type === 'vip_upgrade',
              )
              .reduce((sum, p) => sum + p.amount, 0),
            USD: approvedUSD
              .filter(
                (p) =>
                  (p.type === 'subscription' && p.target === 'vip') ||
                  p.type === 'vip_upgrade',
              )
              .reduce((sum, p) => sum + p.amount, 0),
          },
          premium: {
            NGN: approvedNGN
              .filter(
                (p) =>
                  (p.type === 'subscription' && p.target === 'premium') ||
                  p.type === 'premium_upgrade',
              )
              .reduce((sum, p) => sum + p.amount, 0),
            USD: approvedUSD
              .filter(
                (p) =>
                  (p.type === 'subscription' && p.target === 'premium') ||
                  p.type === 'premium_upgrade',
              )
              .reduce((sum, p) => sum + p.amount, 0),
          },
        },
      },

      totalPayments: payments.length,

      approvedPayments: approved.length,

      pendingPayments: pending.length,

      rejectedPayments: rejected.length,
    };
  }
  // =====================================
  // LATEST USER PAYMENTS
  // =====================================
  // Lightweight summary for the admin user profile. It aggregates in MongoDB
  // instead of loading the user's complete payment history into application memory.
  async getUserPaymentAdminSummary(userId: string) {
    const match = { userId, type: { $in: ACTIVE_PAYMENT_TYPES } };
    const [groups, latestPayments] = await Promise.all([
      this.paymentModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: { status: '$status', currency: '$currency', type: '$type', target: '$target' },
            count: { $sum: 1 },
            amount: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, '$amount', 0] } },
          },
        },
      ]).exec(),
      this.paymentModel.find(match).sort({ createdAt: -1 }).limit(10).lean().exec(),
    ]);

    const counts = { total: 0, approved: 0, pending: 0, rejected: 0 };
    const totalRevenue = { NGN: 0, USD: 0 };
    const subscriptionRevenue = { NGN: 0, USD: 0 };
    const plans = {
      regular: { NGN: 0, USD: 0 },
      vip: { NGN: 0, USD: 0 },
      premium: { NGN: 0, USD: 0 },
    };
    for (const group of groups as any[]) {
      const status = String(group._id?.status ?? '').toLowerCase();
      const currency = String(group._id?.currency ?? '').toUpperCase();
      const type = String(group._id?.type ?? '');
      const target = String(group._id?.target ?? '').toLowerCase();
      const count = Number(group.count ?? 0);
      const amount = Number(group.amount ?? 0);
      counts.total += count;
      if (status === 'approved') counts.approved += count;
      if (status === 'pending') counts.pending += count;
      if (status === 'rejected') counts.rejected += count;
      if (status !== 'approved' || !(currency in totalRevenue)) continue;
      (totalRevenue as any)[currency] += amount;
      if (!ACTIVE_PAYMENT_TYPES.includes(type as any)) continue;
      (subscriptionRevenue as any)[currency] += amount;
      if (type === 'subscription' && target in plans) (plans as any)[target][currency] += amount;
      if (type === 'vip_upgrade') (plans.vip as any)[currency] += amount;
      if (type === 'premium_upgrade') (plans.premium as any)[currency] += amount;
    }
    return {
      latestPayments,
      totalPayments: counts.total,
      approvedPayments: counts.approved,
      pendingPayments: counts.pending,
      rejectedPayments: counts.rejected,
      revenue: { total: totalRevenue, subscriptions: subscriptionRevenue, plans },
    };
  }

  // Paginated full payment history for the admin profile's History tab.
  async getUserPaymentHistory(userId: string, pageValue = 1, limitValue = 10) {
    const page = Math.max(1, Math.floor(Number(pageValue) || 1));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(limitValue) || 10)));
    const filter = { userId, type: { $in: ACTIVE_PAYMENT_TYPES } };
    const [items, total] = await Promise.all([
      this.paymentModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.paymentModel.countDocuments(filter).exec(),
    ]);
    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async getLatestUserPayments(userId: string, limit = 10) {
    return this.paymentModel
      .find({ userId, type: { $in: ACTIVE_PAYMENT_TYPES } })
      .sort({ createdAt: -1 })
      .limit(limit);
  }

  // =====================================
  // USER LIFETIME REVENUE
  // =====================================
  async getLifetimeRevenue(userId: string) {
    const payments = await this.paymentModel.find({
      userId,
      status: 'approved',
      type: { $in: ACTIVE_PAYMENT_TYPES },
    });

    return {
      NGN: payments
        .filter((p) => p.currency === 'NGN')
        .reduce((sum, p) => sum + p.amount, 0),

      USD: payments
        .filter((p) => p.currency === 'USD')
        .reduce((sum, p) => sum + p.amount, 0),
    };
  }

  // =====================================
  // COUNT PAYMENTS
  // =====================================
  async countPayments() {
    return this.paymentModel.countDocuments({
      type: { $in: ACTIVE_PAYMENT_TYPES },
    });
  }

  // =====================================
  // RECENT PAYMENTS
  // =====================================
  async getRecentPayments(limit = 10) {
    return this.paymentModel
      .find({ type: { $in: ACTIVE_PAYMENT_TYPES } })
      .sort({
        createdAt: -1,
      })
      .limit(limit);
  }

  // =====================================
  // DELETE EXPIRED GATEWAY PAYMENTS
  // =====================================
  // Deletes only gateway payments that have
  // remained pending for more than 30 minutes.
  //
  // Manual payment requests are NOT deleted.
  // Approved and rejected payments are NOT deleted.
  // =====================================
  async deleteExpiredPendingGatewayPayments(): Promise<number> {
    const expirationTime = new Date(Date.now() - 30 * 60 * 1000);
    const expired = await this.paymentModel.find({
      status: 'pending', type: { $in: ACTIVE_PAYMENT_TYPES }, gateway: { $in: ['paystack'] }, createdAt: { $lt: expirationTime },
    }).select('reference').lean().exec();
    if (!expired.length) return 0;
    for (const payment of expired) await this.promosService.releaseRedemption(payment.reference);
    const result = await this.paymentModel.deleteMany({
      reference: { $in: expired.map((payment) => payment.reference) }, status: 'pending', gateway: { $in: ['paystack'] },
    }).exec();
    return result.deletedCount ?? 0;
  }
}
