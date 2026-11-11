import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Subscription,
  SubscriptionDocument,
  PaidPlanType,
  PlanType,
} from './schemas/subscription.schema';
import { BonusGrant } from '../bonuses/schemas/bonus-grant.schema';
import { BonusStatus } from '../bonuses/enums/bonus-status.enum';
import { BonusType } from '../bonuses/enums/bonus-type.enum';
import { User } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { SystemMonitorService } from '../system-monitor/system-monitor.service';
import { NotificationEventsService } from '../notifications/in-app/notification-events.service';

const PAID_SUBSCRIPTION_DURATION_DAYS = 30;

@Injectable()
export class SubscriptionsService {
  constructor(
    @InjectModel(Subscription.name)
    private subscriptionModel: Model<SubscriptionDocument>,
    @InjectModel(BonusGrant.name)
    private readonly bonusGrantModel: Model<BonusGrant>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    private readonly usersService: UsersService,
    private readonly systemMonitor: SystemMonitorService,
    private readonly notificationEvents: NotificationEventsService,
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

  async findBySourceReference(sourceReference: string) {
    const reference = String(sourceReference ?? '').trim();
    if (!reference) return null;
    return this.subscriptionModel.findOne({ sourceReference: reference }).lean().exec();
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

      if (existingGrant) {
        // Recover the second half of an upgrade if the process stopped after
        // creating the new term but before shortening the previous active term.
        // Same-plan renewals and queued lower-tier purchases are not altered.
        if (existingGrant.isActive) {
          const planRank: Record<PaidPlanType, number> = {
            regular: 1,
            vip: 2,
            premium: 3,
          };
          const previousActive = await this.subscriptionModel
            .findOne({
              userId: data.userId,
              _id: { $ne: existingGrant._id },
              isActive: true,
              startDate: { $lt: existingGrant.startDate },
              expiryDate: { $gt: existingGrant.startDate },
            })
            .sort({ startDate: -1 })
            .exec();

          if (
            previousActive &&
            planRank[existingGrant.plan] > planRank[previousActive.plan]
          ) {
            previousActive.expiryDate = existingGrant.startDate;
            previousActive.isActive = false;
            await previousActive.save();
          }
        }
        return existingGrant;
      }
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

  private readonly planRank: Record<PlanType, number> = {
    free: 0,
    regular: 1,
    vip: 2,
    premium: 3,
  };

  /**
   * The single source of truth for a user's current membership entitlement.
   * A verified bonus elevates the effective tier only when it outranks the
   * paid term. An equal-tier bonus keeps the paid tier and contributes to the
   * effective allowance window used by Bet Lab.
   */
  async getEffectiveEntitlement(userId: string): Promise<{
    plan: PlanType;
    source: 'paid_subscription' | 'subscription_bonus' | 'combined' | 'free';
    subscription: SubscriptionDocument | null;
    bonus: {
      plan: PaidPlanType;
      startsAt: Date;
      expiresAt: Date;
    } | null;
    startsAt: Date | null;
    expiresAt: Date | null;
  }> {
    const [subscription, bonus] = await Promise.all([
      this.getActiveSubscription(userId),
      this.getActiveSubscriptionBonus(userId),
    ]);
    const paidPlan: PlanType = subscription?.plan ?? 'free';
    const bonusOutranksPaid = Boolean(
      bonus && this.planRank[bonus.plan] > this.planRank[paidPlan],
    );

    if (bonus && bonusOutranksPaid) {
      return {
        plan: bonus.plan,
        source: 'subscription_bonus',
        subscription: subscription ?? null,
        bonus,
        startsAt: bonus.startsAt,
        expiresAt: bonus.expiresAt,
      };
    }

    if (subscription && bonus?.plan === subscription.plan) {
      const paidStart = new Date(subscription.startDate);
      const bonusStart = new Date(bonus.startsAt);
      const paidEnd = new Date(subscription.expiryDate);
      const bonusEnd = new Date(bonus.expiresAt);
      return {
        plan: subscription.plan,
        source: 'combined',
        subscription,
        bonus,
        startsAt: new Date(Math.min(paidStart.getTime(), bonusStart.getTime())),
        expiresAt: new Date(Math.max(paidEnd.getTime(), bonusEnd.getTime())),
      };
    }

    if (subscription) {
      return {
        plan: subscription.plan,
        source: 'paid_subscription',
        subscription,
        bonus,
        startsAt: new Date(subscription.startDate),
        expiresAt: new Date(subscription.expiryDate),
      };
    }

    if (bonus) {
      return {
        plan: bonus.plan,
        source: 'subscription_bonus',
        subscription: null,
        bonus,
        startsAt: bonus.startsAt,
        expiresAt: bonus.expiresAt,
      };
    }

    return {
      plan: 'free',
      source: 'free',
      subscription: null,
      bonus: null,
      startsAt: null,
      expiresAt: null,
    };
  }

  async getUserPlan(userId: string): Promise<PlanType> {
    return (await this.getEffectiveEntitlement(userId)).plan;
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
    const entitlement = await this.getEffectiveEntitlement(userId);
    const subscription = entitlement.subscription;

    const pendingSubscription = await this.subscriptionModel
      .findOne({ userId, startDate: { $gt: now } })
      .sort({ startDate: 1 })
      .exec();

    const daysRemaining = entitlement.expiresAt
      ? Math.max(
          0,
          Math.ceil(
            (entitlement.expiresAt.getTime() - now.getTime()) /
              (1000 * 60 * 60 * 24),
          ),
        )
      : 0;

    if (!subscription && entitlement.source !== 'subscription_bonus') {
      const lastExpiredSubscription = await this.subscriptionModel
        .findOne({
          userId,
          startDate: { $lte: now },
          expiryDate: { $lte: now },
        })
        .sort({ expiryDate: -1 })
        .exec();

      return {
        hasSubscription: false,
        hasEntitlement: false,
        currentPlan: 'free' as const,
        entitlementSource: 'free' as const,
        status: lastExpiredSubscription ? 'expired' : 'free',
        subscription: null,
        bonus: null,
        daysRemaining: 0,
        expired: Boolean(lastExpiredSubscription),
        pendingSubscription,
      };
    }

    return {
      // hasSubscription remains the indicator for a paid subscription record;
      // hasEntitlement includes a temporary subscription bonus.
      hasSubscription: Boolean(subscription),
      hasEntitlement: entitlement.plan !== 'free',
      currentPlan: entitlement.plan,
      entitlementSource: entitlement.source,
      status: 'active',
      daysRemaining,
      expired: false,
      subscription: subscription ?? null,
      bonus:
        entitlement.source === 'subscription_bonus' || entitlement.source === 'combined'
          ? entitlement.bonus
          : null,
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

  /**
   * Resolves membership filters with the same precedence as getUserPlan():
   * latest active paid term, elevated by a verified active subscription bonus
   * only when that bonus has a higher tier. Due queued terms are included
   * because getActiveSubscription() activates them on demand.
   */
  async getUserIdFilterForPlan(
    plan: PlanType | string,
  ): Promise<{ includeUserIds?: string[]; excludeUserIds?: string[] }> {
    if (!['free', 'regular', 'vip', 'premium'].includes(plan)) {
      throw new BadRequestException(`Unsupported subscription plan filter: ${plan}`);
    }

    const now = new Date();
    const [activeSubscriptions, dueQueuedSubscriptions, activeBonuses] =
      await Promise.all([
        this.subscriptionModel
          .find({
            isActive: true,
            startDate: { $lte: now },
            expiryDate: { $gt: now },
          })
          .select({ userId: 1, plan: 1, startDate: 1 })
          .sort({ startDate: -1 })
          .lean()
          .exec(),
        this.subscriptionModel
          .find({
            isActive: false,
            startDate: { $lte: now },
            expiryDate: { $gt: now },
          })
          .select({ userId: 1, plan: 1, startDate: 1 })
          .sort({ startDate: 1 })
          .lean()
          .exec(),
        this.bonusGrantModel
          .find({
            type: BonusType.SUBSCRIPTION,
            status: BonusStatus.GRANTED,
            plan: { $in: ['regular', 'vip', 'premium'] },
            startsAt: { $lte: now },
            expiresAt: { $gt: now },
          })
          .select({ userId: 1, plan: 1, startsAt: 1, expiresAt: 1 })
          .sort({ expiresAt: -1 })
          .lean()
          .exec(),
      ]);

    const paidPlans = new Map<string, PaidPlanType>();
    // Match getActiveSubscription(): the most recently started active term wins.
    for (const item of activeSubscriptions) {
      const userId = String(item.userId);
      if (!paidPlans.has(userId)) paidPlans.set(userId, item.plan);
    }
    // Match its on-demand queued-term fallback, and only use queued terms when
    // no current active term exists for that account.
    for (const item of dueQueuedSubscriptions) {
      const userId = String(item.userId);
      if (!paidPlans.has(userId)) paidPlans.set(userId, item.plan);
    }

    const bonusUserIds = [
      ...new Set(
        activeBonuses
          .map((grant) => String(grant.userId ?? ''))
          .filter(Boolean),
      ),
    ];
    const verifiedUsers = bonusUserIds.length
      ? await this.userModel
          .find({
            _id: { $in: bonusUserIds },
            isVerified: true,
            isDeleted: false,
          })
          .select({ _id: 1 })
          .lean()
          .exec()
      : [];
    const verifiedUserIds = new Set(
      verifiedUsers.map((user) => String(user._id)),
    );

    const effectivePlans = new Map<string, PlanType>();
    for (const [userId, paidPlan] of paidPlans) {
      effectivePlans.set(userId, paidPlan);
    }

    for (const grant of activeBonuses) {
      const userId = String(grant.userId ?? '');
      const bonusPlan = grant.plan as PaidPlanType | undefined;
      if (!userId || !bonusPlan || !verifiedUserIds.has(userId)) continue;

      const currentPlan = effectivePlans.get(userId) ?? 'free';
      if (this.planRank[bonusPlan] > this.planRank[currentPlan]) {
        effectivePlans.set(userId, bonusPlan);
      }
    }

    const matchingIds = [...effectivePlans.entries()]
      .filter(([, effectivePlan]) => effectivePlan === plan)
      .map(([userId]) => userId);

    if (plan === 'free') {
      const entitledIds = [...effectivePlans.keys()];
      return { excludeUserIds: [...new Set(entitledIds)] };
    }

    return { includeUserIds: [...new Set(matchingIds)] };
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
    // Persist the one-time reminder marker first. Email delivery is independent
    // and must never keep the subscription lifecycle operation from completing.
    subscription.expiringReminderSent = true;
    await subscription.save();

    await this.notificationEvents.subscriptionExpiring({
      userId: String(subscription.userId),
      subscriptionId: String(subscription._id),
      plan: subscription.plan,
      expiryDate: subscription.expiryDate,
      daysRemaining: 3,
    });
  }

  // =====================================
  // SEND EXPIRED EMAIL
  // =====================================
  async sendExpiredEmail(subscription: SubscriptionDocument) {
    // Disable the expired entitlement and persist the reminder marker before
    // attempting any external communication.
    subscription.expiredNotificationSent = true;
    subscription.isActive = false;
    await subscription.save();

    await this.notificationEvents.subscriptionExpired({
      userId: String(subscription.userId),
      subscriptionId: String(subscription._id),
      plan: subscription.plan,
      expiryDate: subscription.expiryDate,
    });
  }

}




