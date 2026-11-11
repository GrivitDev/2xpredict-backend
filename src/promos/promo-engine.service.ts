import { BadRequestException, Injectable } from '@nestjs/common';

import { InjectModel } from '@nestjs/mongoose';

import { Model } from 'mongoose';

import { Promo, PromoDocument } from './schemas/promo.schema';

import {
  PromoReward,
  PromoRewardDocument,
} from './schemas/promo-reward.schema';

import { PromoRewardStatus } from './constants/promo-reward-status';

import { RewardType } from './constants/reward-types';

import { ReferralsService } from '../referrals/referrals.service';

import { SubscriptionsService } from '../subscriptions/subscriptions.service';

import { UsersService } from '../users/users.service';
import {
  PromoParticipant,
  PromoParticipantDocument,
} from './schemas/promo-participant.schema';
import { PromoCampaignType } from './constants/promo-campaign-type';
import { PromoRequirement } from './constants/promo-requirements';
import { PromoPromotionKind } from './constants/promo-promotion-kind';
import { PromosService } from './promos.service';
import { BetLabWalletService } from '../bet-lab/services/bet-lab-wallet.service';
import { NotificationEventsService } from '../notifications/in-app/notification-events.service';

@Injectable()
export class PromoEngineService {
  constructor(
    @InjectModel(Promo.name)
    private readonly promoModel: Model<PromoDocument>,

    @InjectModel(PromoReward.name)
    private readonly rewardModel: Model<PromoRewardDocument>,

    private readonly referralsService: ReferralsService,

    private readonly subscriptionsService: SubscriptionsService,

    private readonly usersService: UsersService,

    private readonly promosService: PromosService,
    private readonly walletService: BetLabWalletService,

    @InjectModel(PromoParticipant.name)
    private readonly participantModel: Model<PromoParticipantDocument>,
    private readonly notificationEvents: NotificationEventsService,
  ) {}

  // ==============================
  // CHECK USER PROMOS
  // ==============================

  async checkUserPromos(userId: string) {
    const now = new Date();
    const [joined, pendingPromoIds] = await Promise.all([
      this.participantModel
        .find({ userId })
        .select({ promoId: 1 })
        .lean()
        .exec(),
      this.rewardModel.distinct('promoId', {
        userId,
        status: { $ne: PromoRewardStatus.PAID },
      }),
    ]);

    const joinedPromoIds = new Set(joined.map((item) => String(item.promoId)));
    const joinedIds = [...joinedPromoIds];
    const pendingIds = [...new Set(pendingPromoIds.map((id) => String(id)))];

    const [activeReferralPromos, pendingRewardPromos] = await Promise.all([
      joinedIds.length
        ? this.promoModel
            .find({
              _id: { $in: joinedIds },
              campaignType: PromoCampaignType.REFERRAL,
              isActive: true,
              startDate: { $lte: now },
              endDate: { $gte: now },
            })
            .exec()
        : Promise.resolve([]),
      pendingIds.length
        ? this.promoModel.find({ _id: { $in: pendingIds } }).exec()
        : Promise.resolve([]),
    ]);

    // Pending rewards remain payable even after a campaign has ended or been
    // disabled. New claims, however, are allowed only for currently active
    // referral campaigns that this user actually joined.
    const promosById = new Map<string, PromoDocument>();
    for (const promo of activeReferralPromos) {
      promosById.set(String(promo._id), promo);
    }
    for (const promo of pendingRewardPromos) {
      promosById.set(String(promo._id), promo);
    }

    for (const promo of promosById.values()) {
      const canCreateNewClaims =
        joinedPromoIds.has(String(promo._id)) &&
        promo.campaignType === PromoCampaignType.REFERRAL &&
        promo.isActive &&
        promo.startDate <= now &&
        promo.endDate >= now;
      await this.processPromo(promo, userId, canCreateNewClaims);
    }
  }

  // ==============================
  // JOIN DIRECT CAMPAIGN
  // ==============================

  async joinDirectCampaign(promoCode: string, userId: string) {
    const promo = await this.promosService.findActivePromoByCode(promoCode);

    if (!promo) {
      return null;
    }
    if (promo.promotionKind !== PromoPromotionKind.REWARD || (promo.rewardType as string) === 'cash') return promo;

    const claims = await this.rewardModel.countDocuments({
      promoId: promo._id.toString(),
      userId,
    });

    // Re-entering an existing campaign resumes any pending reward instead of
    // treating the presence of a reward record as proof that delivery finished.
    await this.processPromo(promo, userId, claims === 0);
    await this.notificationEvents.promotionJoined({
      userId,
      promoId: String(promo._id),
      promoName: String(promo.name),
      promoCode: String(promo.promoCode ?? promoCode),
      expiresAt: promo.endDate,
    });

    return promo;
  }

  // ==============================
  // JOIN REFERRAL CAMPAIGN
  // ==============================

  async joinReferralCampaign(promoId: string, userId: string) {
    const promo = await this.promosService.findActiveReferralPromo(promoId);

    if (!promo) {
      return null;
    }

    let participant = await this.participantModel
      .findOne({ promoId, userId })
      .exec();
    let wasAlreadyJoined = Boolean(participant);
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new BadRequestException('User not found');
    }

    if (!participant) {
      try {
        participant = await this.participantModel.create({
          promoId,
          userId,
          joinedAt: new Date(),
        });
      } catch (error) {
        if (!this.isDuplicateKeyError(error)) throw error;
        participant = await this.participantModel
          .findOne({ promoId, userId })
          .exec();
        if (!participant) throw error;
        wasAlreadyJoined = true;
      }
    }

    // Replaying this stable event repairs notification delivery after a crash
    // between participant creation and outbox insertion.
    await this.notificationEvents.promotionJoined({
      userId,
      promoId: String(promo._id),
      promoName: String(promo.name),
      promoCode: String(promo.promoCode ?? ''),
      expiresAt: promo.endDate,
    });

    // Preserve the existing return contract: first-time joins receive the
    // success payload, while repeated joins receive the stored participant.
    if (wasAlreadyJoined && participant) return participant;

    return {
      message: 'Campaign joined successfully.',
      promoId,
      referralCode: user.username,
    };
  }

  async getJoinStatus(promoId: string, userId: string) {
    const joined = await this.participantModel.exists({
      promoId,
      userId,
    });

    return {
      joined: !!joined,
    };
  }

  // ==============================
  // PROCESS PROMO
  // ==============================

  private async processPromo(
    promo: PromoDocument,
    userId: string,
    allowNewClaims = true,
  ) {
    const pendingRewards = await this.rewardModel
      .find({
        promoId: String(promo._id),
        userId,
        status: { $ne: PromoRewardStatus.PAID },
      })
      .sort({ claimNumber: 1 })
      .exec();

    for (const reward of pendingRewards) {
      await this.grantReward(promo, userId, reward.claimNumber, reward);
    }

    if (!allowNewClaims) return;
    if (promo.promotionKind !== PromoPromotionKind.REWARD || (promo.rewardType as string) === 'cash') return;
    // ==============================
    // DIRECT REGISTER CAMPAIGN
    // ==============================

    if (
      promo.campaignType === PromoCampaignType.DIRECT &&
      promo.requirement === PromoRequirement.REGISTER
    ) {
      const claims = await this.rewardModel.countDocuments({
        promoId: promo._id.toString(),
        userId,
      });

      if (promo.maxClaims > 0 && claims >= promo.maxClaims) {
        return;
      }

      if (claims === 0) {
        await this.grantReward(promo, userId, 1);
      }

      return;
    }
    const qualified = await this.referralsService.countQualifiedReferrals(
      userId,
      promo.requirement,
    );

    const claims = await this.rewardModel.countDocuments({
      promoId: promo._id.toString(),
      userId,
    });

    if (promo.maxClaims > 0 && claims >= promo.maxClaims) {
      return;
    }

    const possibleClaims = Math.floor(qualified / promo.targetCount);

    if (possibleClaims <= claims) {
      return;
    }

    for (let i = claims + 1; i <= possibleClaims; i++) {
      if (promo.maxClaims > 0 && i > promo.maxClaims) {
        break;
      }

      await this.grantReward(promo, userId, i);
    }
  }

  // ==============================
  // GRANT REWARD
  // ==============================

  private async grantReward(
    promo: PromoDocument,
    userId: string,
    claimNumber: number,
    existingReward?: PromoRewardDocument,
  ) {
    const reward =
      existingReward ??
      (await this.rewardModel
        .findOne({ promoId: String(promo._id), userId, claimNumber })
        .exec());

    if (reward) {
      if (reward.status === PromoRewardStatus.PAID) {
        await this.notifyPromotionReward(promo, reward);
        return reward;
      }

      if (reward.type === RewardType.SUBSCRIPTION) {
        return this.grantSubscriptionReward(promo, userId, claimNumber, reward);
      }
      return this.grantPointsReward(promo, userId, claimNumber, reward);
    }

    if (promo.rewardType === RewardType.SUBSCRIPTION) {
      return this.grantSubscriptionReward(promo, userId, claimNumber);
    }
    return this.grantPointsReward(promo, userId, claimNumber);
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return Boolean(
      error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === 11000,
    );
  }

  private async createOrFindReward(data: {
    promoId: string;
    userId: string;
    claimNumber: number;
    type: RewardType;
    plan?: 'regular' | 'vip' | 'premium';
    durationDays?: number;
    points?: number;
    status: PromoRewardStatus;
  }): Promise<PromoRewardDocument> {
    try {
      return await this.rewardModel.create(data);
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) throw error;
      const raced = await this.rewardModel
        .findOne({
          promoId: data.promoId,
          userId: data.userId,
          claimNumber: data.claimNumber,
        })
        .exec();
      if (raced) return raced;
      throw error;
    }
  }

  // ==============================
  // SUBSCRIPTION REWARD
  // ==============================

  private async grantSubscriptionReward(
    promo: PromoDocument,
    userId: string,
    claimNumber: number,
    existingReward?: PromoRewardDocument,
  ) {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const reward =
      existingReward ??
      (await this.createOrFindReward({
        promoId: String(promo._id),
        userId,
        claimNumber,
        type: RewardType.SUBSCRIPTION,
        plan: promo.rewardPlan,
        durationDays: promo.rewardDurationDays ?? 30,
        status: PromoRewardStatus.APPROVED,
      }));

    if (reward.status === PromoRewardStatus.PAID) {
      await this.notifyPromotionReward(promo, reward);
      return reward;
    }

    const rewardPlan = reward.plan ?? promo.rewardPlan;
    if (!rewardPlan) {
      throw new Error(
        `Subscription reward ${String(reward._id)} has no configured plan.`,
      );
    }
    const durationDays = Number(
      reward.durationDays ?? promo.rewardDurationDays ?? 30,
    );

    const subscription = await this.subscriptionsService.activatePlan({
      userId,
      email: user.email,
      plan: rewardPlan,
      amount: 0,
      durationDays,
      sourceReference: `PROMO_REWARD:${String(reward._id)}`,
    });

    reward.subscriptionId = subscription?._id;
    reward.subscriptionStartDate = subscription?.startDate ?? null;
    reward.subscriptionExpiryDate = subscription?.expiryDate ?? null;
    reward.subscriptionIsActive = Boolean(subscription?.isActive);
    reward.status = PromoRewardStatus.PAID;

    reward.paidAt = new Date();

    await reward.save();
    await this.notifyPromotionReward(promo, reward);

    return reward;
  }

  // ==============================
  // BET LAB POINTS REWARD
  // ==============================

  private async grantPointsReward(
    promo: PromoDocument,
    userId: string,
    claimNumber: number,
    existingReward?: PromoRewardDocument,
  ) {
    const reward =
      existingReward ??
      (await this.createOrFindReward({
        promoId: String(promo._id),
        userId,
        claimNumber,
        type: RewardType.BET_LAB_POINTS,
        points: Number(promo.pointsAmount ?? 0),
        status: PromoRewardStatus.APPROVED,
      }));

    const points = Number(reward.points ?? promo.pointsAmount ?? 0);
    if (!Number.isSafeInteger(points) || points < 1) {
      throw new BadRequestException(
        'Promotion points reward is not configured correctly.',
      );
    }

    if (reward.status !== PromoRewardStatus.PAID) {
      // Wallet credit and ledger creation use the reward ID as a stable
      // idempotency key. This safely resumes a crash after credit but before
      // the reward record was marked paid.
      await this.walletService.grantAdminBonusPoints(
        userId,
        points,
        `Promotion reward: ${promo.name}`,
        String(reward._id),
      );
      reward.status = PromoRewardStatus.PAID;
      reward.paidAt = new Date();
      await reward.save();
    }

    await this.notifyPromotionReward(promo, reward);
    return reward;
  }

  private async notifyPromotionReward(promo: PromoDocument, reward: PromoRewardDocument): Promise<void> {
    if (reward.status !== PromoRewardStatus.PAID) return;
    if (reward.type === RewardType.SUBSCRIPTION) {
      // Recover from a crash after the subscription was persisted but before
      // the reward metadata or notification was completed.
      const subscription = reward.subscriptionId
        ? null
        : await this.subscriptionsService.findBySourceReference(`PROMO_REWARD:${String(reward._id)}`);
      const startDate = reward.subscriptionStartDate ?? subscription?.startDate ?? null;
      const expiryDate = reward.subscriptionExpiryDate ?? subscription?.expiryDate ?? null;
      const isActive = reward.subscriptionIsActive ?? Boolean(subscription?.isActive);
      if (startDate && expiryDate) {
        await this.notificationEvents.subscriptionActivated({
          userId: String(reward.userId),
          reference: `promo:${String(reward._id)}`,
          plan: String(reward.plan ?? promo.rewardPlan ?? 'regular'),
          startDate: new Date(startDate),
          expiryDate: new Date(expiryDate),
          isActive,
          source: 'promotion_reward',
        });
      }
    }
    await this.notificationEvents.promotionRewardGranted({
      userId: String(reward.userId),
      promoId: String(promo._id),
      rewardId: String(reward._id),
      promoName: String(promo.name),
      rewardType: reward.type === RewardType.SUBSCRIPTION ? 'subscription' : 'points',
      points: Number(reward.points ?? 0),
      plan: reward.plan ? String(reward.plan) : undefined,
      durationDays: Number(reward.durationDays ?? 0) || undefined,
      claimNumber: Number(reward.claimNumber ?? 1),
    });
  }

  // ==============================
  // USER PROMO PROGRESS
  // ==============================

  async getUserPromoProgress(userId: string) {
    const now = new Date();

    const joined = await this.participantModel.find({
      userId,
    });

    const promoIds = joined.map((x) => x.promoId);

    const promos =
      promoIds.length === 0
        ? []
        : await this.promoModel.find({
            _id: { $in: promoIds },
            campaignType: PromoCampaignType.REFERRAL,
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now },
          });

    const result: {
      promoId: PromoDocument['_id'];
      name: PromoDocument['name'];
      description: PromoDocument['description'];
      requirement: PromoDocument['requirement'];
      rewardType: PromoDocument['rewardType'];
      rewardPlan: PromoDocument['rewardPlan'];
      pointsAmount: PromoDocument['pointsAmount'];
      rewardDurationDays: PromoDocument['rewardDurationDays'];
      targetCount: PromoDocument['targetCount'];
      maxClaims: PromoDocument['maxClaims'];
      qualifiedReferrals: number;
      currentProgress: number;
      remainingToNextReward: number;
      completedClaims: number;
      remainingClaims: number | null;
      completed: boolean;
      unlimited: boolean;
    }[] = [];

    for (const promo of promos) {
      const qualified = await this.referralsService.countQualifiedReferrals(
        userId,
        promo.requirement,
      );

      const claims = await this.rewardModel.countDocuments({
        promoId: promo._id.toString(),

        userId,
      });

      const progress = qualified % promo.targetCount;

      const completed = promo.maxClaims > 0 && claims >= promo.maxClaims;

      result.push({
        promoId: promo._id,

        name: promo.name,

        description: promo.description,

        requirement: promo.requirement,

        rewardType: promo.rewardType,

        rewardPlan: promo.rewardPlan,

        pointsAmount: promo.pointsAmount,

        rewardDurationDays: promo.rewardDurationDays,

        targetCount: promo.targetCount,

        maxClaims: promo.maxClaims,

        qualifiedReferrals: qualified,

        currentProgress: progress,

        remainingToNextReward:
          progress === 0 ? promo.targetCount : promo.targetCount - progress,

        completedClaims: claims,

        remainingClaims:
          promo.maxClaims === 0 ? null : Math.max(0, promo.maxClaims - claims),

        completed,

        unlimited: promo.maxClaims === 0,
      });
    }

    return result;
  }

  // ==============================
  // ADMIN - PROMO REWARDS
  // ==============================

  async getPromoRewards(promoId: string) {
    return this.rewardModel
      .find({ promoId, type: { $in: [RewardType.SUBSCRIPTION, RewardType.BET_LAB_POINTS] } })
      .populate('userId', 'username email')
      .sort({
        createdAt: -1,
      });
  }

  // ==============================
  // USER REWARD HISTORY
  // ==============================

  async getUserRewards(userId: string) {
    return this.rewardModel
      .find({ userId, type: { $in: [RewardType.SUBSCRIPTION, RewardType.BET_LAB_POINTS] } })
      .populate('promoId', 'name description')
      .sort({
        createdAt: -1,
      });
  }

  async getUserRewardsPaginated(userId: string, pageValue = 1, limitValue = 10) {
    const page = Math.max(1, Math.floor(Number(pageValue) || 1));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(limitValue) || 10)));
    const filter = { userId, type: { $in: [RewardType.SUBSCRIPTION, RewardType.BET_LAB_POINTS] } };
    const [items, total] = await Promise.all([
      this.rewardModel.find(filter).populate('promoId', 'name description').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.rewardModel.countDocuments(filter).exec(),
    ]);
    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  // ==============================
  // ADMIN - ALL AWARDED REWARDS
  // ==============================

  async getAllAwardedRewards() {
    const rewards = await this.rewardModel.find({ type: { $in: [RewardType.SUBSCRIPTION, RewardType.BET_LAB_POINTS] }, status: { $in: [PromoRewardStatus.PENDING, PromoRewardStatus.APPROVED, PromoRewardStatus.PAID] } })
      .populate('userId', 'fullName username email')
      .populate('promoId', 'name campaignType requirement rewardType rewardPlan pointsAmount rewardDurationDays targetCount')
      .sort({ paidAt: -1, createdAt: -1 });
    const formatted = rewards.map((reward: any) => {
      const promo = reward.promoId;
      let activity = 'Completed campaign requirement';
      switch (promo?.requirement) {
        case PromoRequirement.REGISTER: activity = 'Registered a new account'; break;
        case PromoRequirement.REGULAR_SUBSCRIPTION: activity = `Referred ${promo.targetCount} Regular Subscribers`; break;
        case PromoRequirement.VIP_SUBSCRIPTION: activity = `Referred ${promo.targetCount} VIP Subscribers`; break;
        case PromoRequirement.PREMIUM_SUBSCRIPTION: activity = `Referred ${promo.targetCount} Premium Subscribers`; break;
        case PromoRequirement.ANY_SUBSCRIPTION: activity = `Referred ${promo.targetCount} Paying Subscribers`; break;
      }
      return {
        id: String(reward._id),
        rewardTitle: reward.type === RewardType.SUBSCRIPTION ? `${reward.plan ?? promo?.rewardPlan} Subscription (${reward.durationDays ?? 30} Days)` : `${reward.points ?? 0} Bet Lab Points`,
        rewardType: reward.type, points: reward.points ?? 0,
        dateReceived: reward.paidAt || reward.createdAt, campaignType: promo?.campaignType,
        userName: reward.userId?.fullName || reward.userId?.username, email: reward.userId?.email,
        activity, claimNumber: reward.claimNumber, status: reward.status,
      };
    });
    return {
      summary: { totalRewardsAwarded: formatted.length, subscriptionRewards: formatted.filter((r) => r.rewardType === RewardType.SUBSCRIPTION).length, pointsRewards: formatted.filter((r) => r.rewardType === RewardType.BET_LAB_POINTS).length, totalPointsAwarded: formatted.reduce((sum, r) => sum + (r.points || 0), 0) },
      rewards: formatted,
    };
  }
  async getAllClaimedRewards() {
    return this.rewardModel
      .find({ type: { $in: [RewardType.SUBSCRIPTION, RewardType.BET_LAB_POINTS] } })
      .populate('userId', 'fullName username email')
      .populate(
        'promoId',
        'name campaignType rewardType rewardPlan pointsAmount rewardDurationDays',
      )
      .sort({
        createdAt: -1,
      });
  }

}


