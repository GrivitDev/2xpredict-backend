import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Subscription,
  SubscriptionDocument,
  PaidPlanType,
  PlanType,
} from './schemas/subscription.schema';
import { EmailService } from '../notifications/email.service';
import { BonusGrant } from '../bonuses/schemas/bonus-grant.schema';
import { BonusStatus } from '../bonuses/enums/bonus-status.enum';
import { BonusType } from '../bonuses/enums/bonus-type.enum';
import { UsersService } from '../users/users.service';
import { SystemMonitorService } from '../system-monitor/system-monitor.service';

const PAID_SUBSCRIPTION_DURATION_DAYS = 30;

@Injectable()
export class SubscriptionsService {
  constructor(
    @InjectModel(Subscription.name)
    private subscriptionModel: Model<SubscriptionDocument>,
    private emailService: EmailService,
    @InjectModel(BonusGrant.name)
    private readonly bonusGrantModel: Model<BonusGrant>,
    private readonly usersService: UsersService,
    private readonly systemMonitor: SystemMonitorService,
  ) {}

  // =====================================
  // CALCULATE EXPIRY
  // =====================================
  private addDays(date: Date, days: number) {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
  }

  // =====================================
  // GET ACTIVE SUBSCRIPTION
  // =====================================
  async getActiveSubscription(userId: string) {
    const now = new Date();
    const active = await this.subscriptionModel
      .findOne({
        userId,
        isActive: true,
        startDate: { $lte: now },
        expiryDate: { $gt: now },
      })
      .sort({ startDate: -1 })
      .exec();
    if (active) return active;

    // Paid renewals and lower-tier purchases are queued with isActive=false.
    // Activate a due queued term on demand instead of relying on the daily
    // notification scheduler to grant access at the exact transition time.
    const queued = await this.subscriptionModel
      .findOne({
        userId,
        isActive: false,
        startDate: { $lte: now },
        expiryDate: { $gt: now },
      })
      .sort({ startDate: 1 })
      .exec();
    if (!queued) return null;

    const activated = await this.subscriptionModel
      .findOneAndUpdate(
        {
          _id: queued._id,
          isActive: false,
          startDate: { $lte: now },
          expiryDate: { $gt: now },
        },
        { $set: { isActive: true } },
        { returnDocument: 'after' },
      )
      .exec();
    if (activated) return activated;

    // Another request may have activated this term concurrently.
    return this.subscriptionModel
      .findOne({
        userId,
        isActive: true,
        startDate: { $lte: now },
        expiryDate: { $gt: now },
      })
      .sort({ startDate: -1 })
      .exec();
  }

  private async latestQueuedExpiry(
    userId: string,
    baseDate: Date,
  ): Promise<Date> {
    const now = new Date();
    const queued = await this.subscriptionModel
      .findOne({
        userId,
        isActive: false,
        startDate: { $gte: baseDate },
        expiryDate: { $gt: now },
      })
      .sort({ expiryDate: -1 })
      .select({ expiryDate: 1 })
      .lean()
      .exec();
    return queued?.expiryDate && queued.expiryDate > baseDate
      ? new Date(queued.expiryDate)
      : baseDate;
  }

  // =====================================
  // CREATE OR QUEUE SUBSCRIPTION
  // =====================================
  async createSubscription(data: {
    userId: string;
    email: string;
    plan: PaidPlanType;
    amount: number;
    durationDays: number;
  }) {
    return this.activatePlan(data);
  }

  // =====================================
  // CALCULATE PLAN UPGRADE PRICE
  // =====================================
  async calculatePlanUpgradePrice(
    userId: string,
    prices: { regular: number; vip: number; premium: number },
    targetPlan: Exclude<PaidPlanType, 'regular'>,
    _subscriptionDurationDays: number,
    currency: 'NGN' | 'USD',
  ) {
    const subscription = await this.getActiveSubscription(userId);
    const durationDays = PAID_SUBSCRIPTION_DURATION_DAYS;
    const currentPlan: PlanType = subscription?.plan ?? 'free';
    const planRank: Record<PaidPlanType, number> = {
      regular: 1,
      vip: 2,
      premium: 3,
    };
    const targetPrice = prices[targetPlan];
    const currentPrice = subscription ? prices[subscription.plan] : 0;
    const millisecondsRemaining = subscription
      ? Math.max(0, subscription.expiryDate.getTime() - Date.now())
      : 0;
    const daysRemaining = Math.min(
      durationDays,
      Math.ceil(millisecondsRemaining / (1000 * 60 * 60 * 24)),
    );
    const currentDailyPrice = currentPrice / durationDays;
    const targetDailyPrice = targetPrice / durationDays;
    const credit =
      subscription && currentPlan !== 'free'
        ? currentDailyPrice * daysRemaining
        : 0;
    const amount = Math.round(Math.max(0, targetPrice - credit) * 100) / 100;
    const canUpgrade = Boolean(
      subscription && planRank[subscription.plan] < planRank[targetPlan],
    );

    return {
      currentPlan,
      targetPlan,
      currency,
      regularPrice: prices.regular,
      vipPrice: prices.vip,
      premiumPrice: prices.premium,
      subscriptionDurationDays: durationDays,
      daysRemaining,
      regularDailyPrice: prices.regular / durationDays,
      vipDailyPrice: prices.vip / durationDays,
      premiumDailyPrice: prices.premium / durationDays,
      currentDailyPrice,
      targetDailyPrice,
      upgradeDailyPrice: targetDailyPrice - currentDailyPrice,
      credit: Math.round(credit * 100) / 100,
      upgradeCost: amount,
      amount,
      canUpgrade,
    };
  }

  // Backwards-compatible VIP upgrade quote for existing callers.
  async calculateUpgradePrice(
    userId: string,
    regularPrice: number,
    vipPrice: number,
    subscriptionDurationDays: number,
    currency: 'NGN' | 'USD',
    premiumPrice = 0,
  ) {
    return this.calculatePlanUpgradePrice(
      userId,
      { regular: regularPrice, vip: vipPrice, premium: premiumPrice },
      'vip',
      subscriptionDurationDays,
      currency,
    );
  }

  // =====================================
  // ACTIVATE PLAN
  //
  // Handles:
  //
  // Free -> Regular      = activate now
  // Free -> VIP          = activate now
  // Free -> Premium      = activate now
  //
  // Regular -> Regular   = extend
  // VIP -> VIP           = extend
  // Premium -> Premium   = extend
  //
  // VIP -> Regular       = queue after expiry
  //
  // Regular/VIP -> higher paid tier = activate immediately
  //                        (current regular ends now)
  // =====================================
  activatePlan(data: {
    userId: string;
    email: string;
    plan: PaidPlanType;
    amount: number;
    durationDays: number;
    sourceReference?: string;
  }) {
    return this.systemMonitor.trackOperation(
      'subscriptions',
      'subscriptions.service',
      'activate-plan',
      () => this.activatePlanInternal(data),
      {
        logSuccess: true,
        referenceKey: data.sourceReference,
        isExpectedFailure: (error) => {
          const status = typeof (error as any)?.getStatus === 'function'
            ? Number((error as any).getStatus())
            : 500;
          return status >= 400 && status < 500;
        },
      },
    );
  }

  private async activatePlanInternal(data: {
    userId: string;
    email: string;
    plan: PaidPlanType;
    amount: number;
    durationDays: number;
    sourceReference?: string;
  }) {
    const now = new Date();
    const durationDays = PAID_SUBSCRIPTION_DURATION_DAYS;

    if (data.sourceReference) {
      const existingGrant = await this.subscriptionModel
        .findOne({ sourceReference: data.sourceReference })
        .exec();
      if (existingGrant) return existingGrant;
    }

    const existing = await this.getActiveSubscription(data.userId);

    // =====================================
    // NO ACTIVE SUBSCRIPTION
    // =====================================
    if (!existing) {
      return this.createIdempotentSubscription({
        userId: data.userId,
        email: data.email,

        plan: data.plan,
        amount: data.amount,

        startDate: now,
        expiryDate: this.addDays(now, durationDays),

        isActive: true,
        ...(data.sourceReference
          ? { sourceReference: data.sourceReference }
          : {}),

        expiringReminderSent: false,
        expiredNotificationSent: false,
      });
    }

    // Same-plan purchases extend the current term. A higher tier upgrades
    // immediately; a lower tier is queued to begin after the current term.
    const planRank: Record<PaidPlanType, number> = {
      regular: 1,
      vip: 2,
      premium: 3,
    };

    if (existing.plan === data.plan) {
      const startDate = await this.latestQueuedExpiry(
        data.userId,
        existing.expiryDate,
      );
      return this.createIdempotentSubscription({
        userId: data.userId,
        email: data.email,
        plan: data.plan,
        amount: data.amount,
        startDate,
        expiryDate: this.addDays(startDate, durationDays),
        isActive: false,
        ...(data.sourceReference
          ? { sourceReference: data.sourceReference }
          : {}),
        expiringReminderSent: false,
        expiredNotificationSent: false,
      });
    }

    if (planRank[data.plan] > planRank[existing.plan]) {
      const upgradedSubscription = await this.createIdempotentSubscription({
        userId: data.userId,
        email: data.email,
        plan: data.plan,
        amount: data.amount,
        startDate: now,
        expiryDate: this.addDays(now, durationDays),
        isActive: true,
        ...(data.sourceReference
          ? { sourceReference: data.sourceReference }
          : {}),
        expiringReminderSent: false,
        expiredNotificationSent: false,
      });
      existing.expiryDate = now;
      existing.isActive = false;
      await existing.save();
      return upgradedSubscription;
    }

    const startDate = await this.latestQueuedExpiry(
      data.userId,
      existing.expiryDate,
    );
    return this.createIdempotentSubscription({
      userId: data.userId,
      email: data.email,
      plan: data.plan,
      amount: data.amount,
      startDate,
      expiryDate: this.addDays(startDate, durationDays),
      isActive: false,
      ...(data.sourceReference
        ? { sourceReference: data.sourceReference }
        : {}),
      expiringReminderSent: false,
      expiredNotificationSent: false,
    });
  }

  private async createIdempotentSubscription(data: {
    userId: string;
    email: string;
    plan: PaidPlanType;
    amount: number;
    startDate: Date;
    expiryDate: Date;
    isActive: boolean;
    sourceReference?: string;
    expiringReminderSent: boolean;
    expiredNotificationSent: boolean;
  }) {
    try {
      return await this.subscriptionModel.create(data);
    } catch (error) {
      if (data.sourceReference && this.isDuplicateKey(error)) {
        const existing = await this.subscriptionModel
          .findOne({ sourceReference: data.sourceReference })
          .exec();
        if (existing) return existing;
      }
      throw error;
    }
  }

  private isDuplicateKey(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 11000,
    );
  }

  // =====================================
  // USER PLAN CHECK
  // =====================================
  async getActiveSubscriptionBonus(userId: string): Promise<{
    plan: PaidPlanType;
    startsAt: Date;
    expiresAt: Date;
  } | null> {
    const now = new Date();
    const commonFilter = {
      userId,
      type: BonusType.SUBSCRIPTION,
      status: BonusStatus.GRANTED,
      startsAt: { $lte: now },
      expiresAt: { $gt: now },
    };

    // At most three indexed existence lookups. Avoid loading every active
    // bonus for an account just to determine its effective subscription tier.
    for (const plan of ['premium', 'vip', 'regular'] as const) {
      const grant = await this.bonusGrantModel
        .findOne({ ...commonFilter, plan })
        .sort({ expiresAt: -1 })
        .select({ plan: 1, startsAt: 1, expiresAt: 1 })
        .lean()
        .exec();
      if (grant?.plan && grant.expiresAt) {
        // Bonus subscription entitlements are recorded immediately, including
        // for unverified accounts, but they cannot become effective until the
        // account verifies its current email address.
        const user = await this.usersService.findById(userId);
        if (!user?.isVerified) return null;
        return {
          plan: grant.plan,
          startsAt: new Date(grant.startsAt),
          expiresAt: new Date(grant.expiresAt),
        };
      }
    }
    return null;
  }

  async getUserPlan(userId: string): Promise<PlanType> {
    const [subscription, bonus] = await Promise.all([
      this.getActiveSubscription(userId),
      this.getActiveSubscriptionBonus(userId),
    ]);
    const rank: Record<PlanType, number> = {
      free: 0,
      regular: 1,
      vip: 2,
      premium: 3,
    };
    const paidPlan: PlanType = subscription?.plan ?? 'free';
    if (bonus && rank[bonus.plan] > rank[paidPlan]) return bonus.plan;
    return paidPlan;
  }

  // =====================================
  // VIP CHECK
  // =====================================
  async isVip(userId: string) {
    return (await this.getUserPlan(userId)) === 'vip';
  }

  async isPremium(userId: string) {
    return (await this.getUserPlan(userId)) === 'premium';
  }

  // =====================================
  // GET EXPIRED SUBSCRIPTIONS
  // =====================================
  async getExpiredSubscriptions() {
    const now = new Date();

    return this.subscriptionModel.find({
      startDate: {
        $lte: now,
      },

      expiryDate: {
        $lt: now,
      },
    });
  }
  // =====================================
  // ADMIN SUMMARY
  // =====================================
  async getSubscriptionSummary(userId: string) {
    const now = new Date();

    const subscription = await this.getActiveSubscription(userId);

    const pendingSubscription = await this.subscriptionModel
      .findOne({
        userId,

        startDate: {
          $gt: now,
        },
      })
      .sort({
        startDate: 1,
      });

    if (!subscription) {
      const lastExpiredSubscription = await this.subscriptionModel
        .findOne({
          userId,
          startDate: { $lte: now },
          expiryDate: { $lte: now },
        })
        .sort({ expiryDate: -1 });

      return {
        hasSubscription: false,
        currentPlan: 'free',
        status: lastExpiredSubscription ? 'expired' : 'free',
        subscription: null,
        daysRemaining: 0,
        // Free access does not expire. This flag only describes a previous
        // paid subscription, not the user's current Free plan.
        expired: Boolean(lastExpiredSubscription),
        pendingSubscription,
      };
    }

    const daysRemaining = Math.max(
      0,
      Math.ceil(
        (subscription.expiryDate.getTime() - now.getTime()) /
          (1000 * 60 * 60 * 24),
      ),
    );

    return {
      hasSubscription: true,

      currentPlan: subscription.plan,

      status: 'active',

      daysRemaining,

      expired: false,

      subscription,

      pendingSubscription,
    };
  }

  // =====================================
  // GET VIP USERS
  // =====================================
  // Admin profile history: bounded, paginated subscription records.
  async getUserSubscriptionHistory(
    userId: string,
    pageValue = 1,
    limitValue = 10,
  ) {
    const page = Math.max(1, Math.floor(Number(pageValue) || 1));
    const limit = Math.min(
      100,
      Math.max(1, Math.floor(Number(limitValue) || 10)),
    );
    const filter = { userId };
    const [items, total] = await Promise.all([
      this.subscriptionModel
        .find(filter)
        .sort({ startDate: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.subscriptionModel.countDocuments(filter).exec(),
    ]);
    return {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  // Resolve account IDs for the admin directory's membership filter.
  // Free means no currently active paid subscription, not an expired subscription.
  async getUserIdFilterForPlan(
    plan: string,
  ): Promise<{ includeUserIds?: string[]; excludeUserIds?: string[] }> {
    const now = new Date();
    const activeFilter = {
      isActive: true,
      startDate: { $lte: now },
      expiryDate: { $gt: now },
    };
    if (plan !== 'free') {
      const active = await this.subscriptionModel
        .find({ ...activeFilter, plan: plan as PaidPlanType })
        .select({ userId: 1 })
        .lean()
        .exec();
      const ids = active.map((item) => String(item.userId));
      return { includeUserIds: [...new Set<string>(ids)] };
    }
    const active = await this.subscriptionModel
      .find(activeFilter)
      .select({ userId: 1 })
      .lean()
      .exec();
    const ids = active.map((item) => String(item.userId));
    return { excludeUserIds: [...new Set<string>(ids)] };
  }

  async getVipUsers() {
    const now = new Date();

    return this.subscriptionModel.find({
      plan: 'vip',

      startDate: {
        $lte: now,
      },

      expiryDate: {
        $gt: now,
      },
    });
  }

  async getPremiumUsers() {
    const now = new Date();

    return this.subscriptionModel.find({
      plan: 'premium',
      startDate: { $lte: now },
      expiryDate: { $gt: now },
    });
  }

  // =====================================
  // FIND SUBSCRIPTIONS EXPIRING IN 3 DAYS
  // =====================================
  async getExpiringSubscriptions() {
    const now = new Date();

    const targetDate = new Date(now);

    targetDate.setDate(targetDate.getDate() + 3);

    const start = new Date(targetDate);

    start.setHours(0, 0, 0, 0);

    const end = new Date(targetDate);

    end.setHours(23, 59, 59, 999);

    return this.subscriptionModel.find({
      startDate: {
        $lte: now,
      },

      expiryDate: {
        $gte: start,
        $lte: end,
      },

      expiringReminderSent: false,
    });
  }

  // =====================================
  // FIND EXPIRED SUBSCRIPTIONS
  // =====================================
  async getSubscriptionsExpired() {
    const now = new Date();

    return this.subscriptionModel.find({
      startDate: {
        $lte: now,
      },

      expiryDate: {
        $lt: now,
      },

      expiredNotificationSent: false,
    });
  }

  // =====================================
  // SEND EXPIRING EMAIL
  // =====================================
  async sendExpiringEmail(subscription: SubscriptionDocument) {
    await this.emailService.sendSubscriptionExpiringEmail({
      email: subscription.email,

      plan: subscription.plan,

      expiryDate: subscription.expiryDate,

      daysRemaining: 3,
    });

    subscription.expiringReminderSent = true;

    await subscription.save();
  }

  // =====================================
  // SEND EXPIRED EMAIL
  // =====================================
  async sendExpiredEmail(subscription: SubscriptionDocument) {
    await this.emailService.sendSubscriptionExpiredEmail({
      email: subscription.email,

      plan: subscription.plan,

      expiryDate: subscription.expiryDate,
    });

    subscription.expiredNotificationSent = true;

    subscription.isActive = false;

    await subscription.save();
  }
}

