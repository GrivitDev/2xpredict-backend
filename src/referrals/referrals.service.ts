import { BadRequestException, Injectable } from '@nestjs/common';

import { InjectModel } from '@nestjs/mongoose';

import { Model } from 'mongoose';

import { Referral, ReferralDocument } from './schemas/referral.schema';

import { PromoRequirement } from '../promos/constants/promo-requirements';

import { UsersService } from '../users/users.service';
import { NotificationEventsService } from '../notifications/in-app/notification-events.service';

@Injectable()
export class ReferralsService {
  constructor(
    @InjectModel(Referral.name)
    private readonly referralModel: Model<ReferralDocument>,

    private readonly usersService: UsersService,

    private readonly notificationEvents: NotificationEventsService,
  ) {}

  // ============================================================
  // CREATE REFERRAL
  // ============================================================

  async createReferral(referrerId: string, referredUserId: string) {
    if (referrerId === referredUserId) return null;

    const [referrer, referredUser] = await Promise.all([
      this.usersService.findById(referrerId),
      this.usersService.findById(referredUserId),
    ]);
    if (!referrer) throw new BadRequestException('Referrer not found');
    if (!referredUser) throw new BadRequestException('Referred user not found');

    const session = await this.referralModel.db.startSession();
    let referral: ReferralDocument | null = null;

    try {
      await session.withTransaction(async () => {
        const existing = await this.referralModel
          .findOne({ referredUserId })
          .session(session)
          .exec();

        if (existing) {
          referral = existing;
          return;
        }

        const [created] = await this.referralModel.create(
          [
            {
              referrerId,
              referredUserId,
              registered: true,
              regularSubscription: false,
              vipSubscription: false,
              premiumSubscription: false,
              rewardClaimed: false,
            },
          ],
          { session },
        );

        const updatedReferrer = await this.usersService.incrementSuccessfulReferrals(
          referrerId,
          session,
        );
        if (!updatedReferrer) {
          throw new BadRequestException('Referrer is no longer available.');
        }

        referral = created;
      });
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) throw error;
      // A concurrent verification request may have created the referral first.
      referral = await this.referralModel.findOne({ referredUserId }).exec();
      if (!referral) throw error;
    } finally {
      await session.endSession();
    }

    if (!referral) {
      throw new BadRequestException('Referral could not be created.');
    }

    // The notification service uses a stable event key, so repeating this call
    // repairs an interrupted notification without producing duplicate notices.
    const actualReferrerId = String(referral.referrerId);
    await this.notificationEvents.referralRegistered({
      referrerId: actualReferrerId,
      referredUserId,
      referredName: String(
        (referredUser as any).fullName ??
          (referredUser as any).username ??
          '',
      ),
    });

    return referral;
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return Boolean(
      error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === 11000,
    );
  }

  // ============================================================
  // MARK REGULAR SUBSCRIPTION
  // ============================================================

  private async markSubscriptionMilestone(
    userId: string,
    field: 'regularSubscription' | 'vipSubscription' | 'premiumSubscription',
    plan: 'regular' | 'vip' | 'premium',
  ) {
    // The milestone is an idempotent fact update. The payment-processing
    // workflow evaluates referral campaigns after this method returns, so a
    // retried payment can safely repeat the evaluation if a previous attempt
    // stopped between these operations.
    const referral = await this.referralModel
      .findOneAndUpdate(
        { referredUserId: userId },
        { $set: { [field]: true } },
        { returnDocument: 'after' },
      )
      .exec();

    if (!referral) return null;

    await this.notificationEvents.referralSubscription({
      referrerId: referral.referrerId.toString(),
      referredUserId: userId,
      plan,
    });

    return referral;
  }

  async markRegularSubscription(userId: string) {
    return this.markSubscriptionMilestone(
      userId,
      'regularSubscription',
      'regular',
    );
  }

  async markVipSubscription(userId: string) {
    return this.markSubscriptionMilestone(userId, 'vipSubscription', 'vip');
  }

  async markPremiumSubscription(userId: string) {
    return this.markSubscriptionMilestone(
      userId,
      'premiumSubscription',
      'premium',
    );
  }

  // ============================================================
  // FIND REFERRAL BY REFERRED USER
  // ============================================================

  async findByReferredUser(userId: string) {
    return this.referralModel.findOne({
      referredUserId: userId,
    });
  }

  // ============================================================
  // GET USER REFERRALS
  // ============================================================

  async getUserReferrals(userId: string) {
    return this.referralModel
      .find({
        referrerId: userId,
      })
      .sort({
        createdAt: -1,
      });
  }

  // ============================================================
  // COUNT ALL REFERRALS
  // ============================================================

  async getUserReferralsPaginated(userId: string, pageValue = 1, limitValue = 10) {
    const page = Math.max(1, Math.floor(Number(pageValue) || 1));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(limitValue) || 10)));
    const filter = { referrerId: userId };
    const [items, total] = await Promise.all([
      this.referralModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.referralModel.countDocuments(filter).exec(),
    ]);
    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async countReferrals(userId: string) {
    return this.referralModel.countDocuments({
      referrerId: userId,
    });
  }

  // ============================================================
  // COUNT QUALIFIED REFERRALS
  // ============================================================

  async countQualifiedReferrals(
    referrerId: string,
    requirement: PromoRequirement,
  ) {
    switch (requirement) {
      // --------------------------------------------------------
      // REGISTERED USERS
      // --------------------------------------------------------

      case PromoRequirement.REGISTER:
        return this.referralModel.countDocuments({
          referrerId,
          registered: true,
        });

      // --------------------------------------------------------
      // REGULAR SUBSCRIBERS
      // --------------------------------------------------------

      case PromoRequirement.REGULAR_SUBSCRIPTION:
        return this.referralModel.countDocuments({
          referrerId,
          regularSubscription: true,
        });

      // --------------------------------------------------------
      // VIP SUBSCRIBERS
      // --------------------------------------------------------

      case PromoRequirement.VIP_SUBSCRIPTION:
        return this.referralModel.countDocuments({
          referrerId,
          vipSubscription: true,
        });

      // --------------------------------------------------------
      // ANY SUBSCRIPTION
      // --------------------------------------------------------

      case PromoRequirement.ANY_SUBSCRIPTION:
        return this.referralModel.countDocuments({
          referrerId,

          $or: [
            {
              regularSubscription: true,
            },

            {
              vipSubscription: true,
            },
            {
              premiumSubscription: true,
            },
          ],
        });

      // --------------------------------------------------------
      // PREMIUM SUBSCRIBERS
      // --------------------------------------------------------

      case PromoRequirement.PREMIUM_SUBSCRIPTION:
        return this.referralModel.countDocuments({
          referrerId,
          premiumSubscription: true,
        });

      // --------------------------------------------------------
      // UNKNOWN REQUIREMENT
      // --------------------------------------------------------

      default:
        return 0;
    }
  }

  // ============================================================
  // ADMIN - ALL REFERRALS
  // ============================================================

  async getAdminReferrals() {
    return this.referralModel

      .find()

      .populate('referrerId', 'fullName username email')

      .populate('referredUserId', 'fullName username email')

      .sort({
        createdAt: -1,
      });
  }

  // ============================================================
  // ADMIN - REFERRAL STATS
  // ============================================================

  async getAdminReferralStats() {
    const total = await this.referralModel.countDocuments();

    const registered = await this.referralModel.countDocuments({
      registered: true,
    });

    const regularSubscribers = await this.referralModel.countDocuments({
      regularSubscription: true,
    });

    const vipSubscribers = await this.referralModel.countDocuments({
      vipSubscription: true,
    });

    const paidSubscribers = await this.referralModel.countDocuments({
      $or: [
        { regularSubscription: true },
        { vipSubscription: true },
        { premiumSubscription: true },
      ],
    });

    const totalReferrers = await this.referralModel.distinct('referrerId');

    return {
      total,

      totalReferrers: totalReferrers.length,

      registered,

      regularSubscribers,

      vipSubscribers,

      premiumSubscribers: await this.referralModel.countDocuments({ premiumSubscription: true }),
      paidSubscribers,

      conversionRate:
        total === 0 ? 0 : Math.round((paidSubscribers / total) * 100),
    };
  }
}


