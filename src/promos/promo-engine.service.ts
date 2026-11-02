import {
  BadRequestException,
  Inject,
  Injectable,
  forwardRef,
} from '@nestjs/common';

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

@Injectable()
export class PromoEngineService {
  constructor(
    @InjectModel(Promo.name)
    private readonly promoModel: Model<PromoDocument>,

    @InjectModel(PromoReward.name)
    private readonly rewardModel: Model<PromoRewardDocument>,

    @Inject(forwardRef(() => ReferralsService))
    private readonly referralsService: ReferralsService,

    @Inject(forwardRef(() => SubscriptionsService))
    private readonly subscriptionsService: SubscriptionsService,

    @Inject(forwardRef(() => UsersService))
    private readonly usersService: UsersService,

    private readonly promosService: PromosService,
    private readonly walletService: BetLabWalletService,

    @InjectModel(PromoParticipant.name)
    private readonly participantModel: Model<PromoParticipantDocument>,
  ) {}

  // ==============================
  // CHECK USER PROMOS
  // ==============================

  async checkUserPromos(userId: string) {
    const now = new Date();

    // Referral campaigns only if user joined them
    const joined = await this.participantModel.find({
      userId,
    });

    const promoIds = joined.map((x) => x.promoId);

    const referralPromos =
      promoIds.length === 0
        ? []
        : await this.promoModel.find({
            _id: { $in: promoIds },
            campaignType: PromoCampaignType.REFERRAL,
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now },
          });

    const promos = referralPromos;

    for (const promo of promos) {
      await this.processPromo(promo, userId);
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

    if (claims > 0) {
      return promo;
    }

    await this.processPromo(promo, userId);

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

    const exists = await this.participantModel.findOne({
      promoId,
      userId,
    });

    if (exists) {
      return exists;
    }

    await this.participantModel.create({
      promoId,
      userId,
      joinedAt: new Date(),
    });

    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new BadRequestException('User not found');
    }

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

  private async processPromo(promo: PromoDocument, userId: string) {
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
  ) {
    const exists = await this.rewardModel.findOne({ promoId: promo._id.toString(), userId, claimNumber });
    if (exists) {
      if (exists.type === RewardType.BET_LAB_POINTS && exists.status !== PromoRewardStatus.PAID) {
        await this.walletService.grantAdminBonusPoints(String(exists.userId), Number(exists.points), `Promotion reward: ${promo.name}`, String(exists._id));
        exists.status = PromoRewardStatus.PAID;
        exists.paidAt = new Date();
        await exists.save();
      }
      return exists;
    }
    if (promo.rewardType === RewardType.SUBSCRIPTION) return this.grantSubscriptionReward(promo, userId, claimNumber);
    return this.grantPointsReward(promo, userId, claimNumber);
  }

  // ==============================
  // SUBSCRIPTION REWARD
  // ==============================

  private async grantSubscriptionReward(
    promo: PromoDocument,
    userId: string,
    claimNumber: number,
  ) {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }
    const reward = await this.rewardModel.create({
      promoId: promo._id.toString(),

      userId,

      claimNumber,

      type: RewardType.SUBSCRIPTION,

      plan: promo.rewardPlan,

      durationDays: promo.rewardDurationDays ?? 30,

      status: PromoRewardStatus.APPROVED,
    });

    await this.subscriptionsService.activatePlan({
      userId,

      email: user.email,

      plan: promo.rewardPlan!,

      amount: 0,

      durationDays: promo.rewardDurationDays ?? 30,
    });

    reward.status = PromoRewardStatus.PAID;

    reward.paidAt = new Date();

    await reward.save();

    return reward;
  }

  // ==============================
  // BET LAB POINTS REWARD
  // ==============================

  private async grantPointsReward(promo: PromoDocument, userId: string, claimNumber: number) {
    const points = Number(promo.pointsAmount ?? 0);
    if (!Number.isSafeInteger(points) || points < 1) {
      throw new BadRequestException('Promotion points reward is not configured correctly.');
    }
    const reward = await this.rewardModel.create({
      promoId: promo._id.toString(), userId, claimNumber,
      type: RewardType.BET_LAB_POINTS, points, status: PromoRewardStatus.APPROVED,
    });
    await this.walletService.grantAdminBonusPoints(userId, points, `Promotion reward: ${promo.name}`, String(reward._id));
    reward.status = PromoRewardStatus.PAID;
    reward.paidAt = new Date();
    await reward.save();
    return reward;
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
