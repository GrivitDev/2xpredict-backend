import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { Promo, PromoDocument } from './schemas/promo.schema';
import { CreatePromoDto } from './dto/create-promo.dto';
import { UpdatePromoDto } from './dto/update-promo.dto';
import { PromoCampaignType } from './constants/promo-campaign-type';
import { RewardType } from './constants/reward-types';
import { PromoPromotionKind } from './constants/promo-promotion-kind';
import { PromoDiscountType } from './constants/promo-discount-type';
import { PromoPurpose } from './constants/promo-purpose';
import { PromoRequirement } from './constants/promo-requirements';
import {
  PromoRedemption,
  PromoRedemptionDocument,
  PromoRedemptionStatus,
} from './schemas/promo-redemption.schema';
import {
  PromoClaim,
  PromoClaimDocument,
  PromoClaimStatus,
} from './schemas/promo-claim.schema';
import { User } from '../users/schemas/user.schema';
import { Payment } from '../payments/schemas/payment.schema';
import { Subscription } from '../subscriptions/schemas/subscription.schema';
import { BetLabWalletService } from '../bet-lab/services/bet-lab-wallet.service';
import { NotificationEventsService } from '../notifications/in-app/notification-events.service';

type PaidPlan = 'regular' | 'vip' | 'premium';
type PurchaseType = 'subscription' | 'vip_upgrade' | 'premium_upgrade';

type AccountAgeRule = {
  unit?: 'days' | 'months' | 'years';
  min?: number;
  max?: number;
};

type DaysSinceExpiryRule = { min?: number; max?: number };

type PromoEligibilityRules = {
  accountAge?: AccountAgeRule;
  verificationStatus?: 'any' | 'verified' | 'unverified';
  subscriptionStatus?:
    | 'any'
    | 'never_subscribed'
    | 'active'
    | 'renewal_due'
    | 'expired';
  daysSinceExpiry?: DaysSinceExpiryRule;
  firstPurchaseOnly?: boolean;
  previousPlan?: string;
};

interface PromoAnalyticsRow {
  _id: string;
  grossValue: number;
  discountCost: number;
  pointsAwarded: number;
}


// Public campaign fields are deliberately allow-listed. Promo codes remain
// public so visitors can use the welcome offer during registration, while
// redemption counters, eligibility internals and campaign-control fields stay
// server-side.
const PUBLIC_PROMO_SELECT = [
  '_id',
  'name',
  'description',
  'promoCode',
  'campaignType',
  'promotionKind',
  'purpose',
  'startDate',
  'endDate',
  'requirement',
  'targetCount',
  'rewardType',
  'rewardPlan',
  'rewardDurationDays',
  'pointsAmount',
  'discountType',
  'discountValue',
  'minPurchaseAmount',
  'maxDiscountAmount',
  'amountCurrency',
  'eligiblePlans',
].join(' ');


export interface PromoPricingResult {
  amount: number;
  baseAmount: number;
  discountAmount: number;
  promoId?: string;
  promoCode?: string;
  discountType?: PromoDiscountType;
  discountValue?: number;
  pointsReward: number;
}

@Injectable()
export class PromosService implements OnModuleInit {
  constructor(
    @InjectModel(Promo.name) private readonly promoModel: Model<PromoDocument>,
    @InjectModel(PromoRedemption.name)
    private readonly redemptionModel: Model<PromoRedemptionDocument>,
    @InjectModel(PromoClaim.name)
    private readonly claimModel: Model<PromoClaimDocument>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    private readonly walletService: BetLabWalletService,
    private readonly notificationEvents: NotificationEventsService,
  ) {}

  /** Disable legacy cash campaigns at startup without deleting historical records. */
  async onModuleInit() {
    await this.promoModel
      .updateMany(
        { rewardType: 'cash' as RewardType },
        { $set: { isActive: false } },
      )
      .exec();
  }

  private async generatePromoCode(): Promise<string> {
    for (;;) {
      const code = `WELCOME-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      if (!(await this.promoModel.exists({ promoCode: code }))) return code;
    }
  }

  async findActivePromoByCode(promoCode: string) {
    const now = new Date();
    return this.promoModel.findOne({
      promoCode: promoCode.trim().toUpperCase(),
      campaignType: PromoCampaignType.DIRECT,
      isActive: true,
      startDate: { $lte: now },
      endDate: { $gte: now },
    });
  }

  buildRegistrationUrl(promoCode: string) {
    return `${process.env.FRONTEND_URL}/register?promoCode=${encodeURIComponent(promoCode)}`;
  }

  private validatePromo(
    dto: Partial<CreatePromoDto>,
    fallback?: PromoDocument,
  ) {
    const kind =
      dto.promotionKind ?? fallback?.promotionKind ?? PromoPromotionKind.REWARD;
    const rewardType =
      dto.rewardType ?? fallback?.rewardType ?? RewardType.SUBSCRIPTION;
    const rewardPlan = dto.rewardPlan ?? fallback?.rewardPlan;
    const pointsAmount = dto.pointsAmount ?? fallback?.pointsAmount;
    const discountType = dto.discountType ?? fallback?.discountType;
    const discountValue = dto.discountValue ?? fallback?.discountValue;
    const campaignType = dto.campaignType ?? fallback?.campaignType;

    if (
      kind === PromoPromotionKind.DISCOUNT ||
      kind === PromoPromotionKind.BUNDLE
    ) {
      if (
        !discountType ||
        !Number.isFinite(Number(discountValue)) ||
        Number(discountValue) <= 0
      ) {
        throw new BadRequestException(
          'A valid discount type and discount value are required.',
        );
      }
      if (
        discountType === PromoDiscountType.PERCENTAGE &&
        Number(discountValue) > 100
      ) {
        throw new BadRequestException(
          'Percentage discounts cannot exceed 100%.',
        );
      }
      const amountCurrency = dto.amountCurrency ?? fallback?.amountCurrency;
      if (
        (discountType === PromoDiscountType.FIXED_AMOUNT ||
          dto.minPurchaseAmount != null ||
          dto.maxDiscountAmount != null ||
          fallback?.minPurchaseAmount != null ||
          fallback?.maxDiscountAmount != null) &&
        !amountCurrency
      ) {
        throw new BadRequestException(
          'Select the currency used by fixed discounts and monetary limits.',
        );
      }
    }
    if (kind === PromoPromotionKind.BUNDLE && !(Number(pointsAmount) > 0)) {
      throw new BadRequestException(
        'Bundle promotions must include a positive Bet Lab points benefit.',
      );
    }
    if (
      kind === PromoPromotionKind.REWARD ||
      kind === PromoPromotionKind.BUNDLE
    ) {
      if (
        rewardType === RewardType.SUBSCRIPTION &&
        !rewardPlan &&
        kind === PromoPromotionKind.REWARD
      ) {
        throw new BadRequestException(
          'Reward plan is required for subscription rewards.',
        );
      }
      if (
        rewardType === RewardType.BET_LAB_POINTS &&
        !(Number(pointsAmount) > 0)
      ) {
        throw new BadRequestException(
          'A positive Bet Lab points amount is required for points rewards.',
        );
      }
    }
    if (
      campaignType === PromoCampaignType.REFERRAL &&
      kind !== PromoPromotionKind.REWARD
    ) {
      throw new BadRequestException(
        'Discount and bundle promo codes must be direct campaigns; referral reward campaigns remain participant-based.',
      );
    }
    const rules = (dto.eligibilityRules ??
      fallback?.eligibilityRules ??
      {}) as PromoEligibilityRules;
    if (rules.accountAge) {
      if (
        !['days', 'months', 'years'].includes(rules.accountAge.unit ?? 'days')
      )
        throw new BadRequestException(
          'Account age unit must be days, months, or years.',
        );
      for (const key of ['min', 'max'])
        if (
          rules.accountAge[key] != null &&
          (!Number.isFinite(Number(rules.accountAge[key])) ||
            Number(rules.accountAge[key]) < 0)
        )
          throw new BadRequestException(
            `Account age ${key} must be a non-negative number.`,
          );
      if (
        rules.accountAge.min != null &&
        rules.accountAge.max != null &&
        Number(rules.accountAge.min) > Number(rules.accountAge.max)
      )
        throw new BadRequestException(
          'Minimum account age cannot exceed maximum account age.',
        );
    }
    if (
      rules.verificationStatus &&
      !['any', 'verified', 'unverified'].includes(rules.verificationStatus)
    )
      throw new BadRequestException('Unsupported verification status rule.');
    if (
      rules.subscriptionStatus &&
      !['any', 'never_subscribed', 'active', 'renewal_due', 'expired'].includes(
        rules.subscriptionStatus,
      )
    )
      throw new BadRequestException('Unsupported subscription status rule.');
    if (rules.daysSinceExpiry) {
      for (const key of ['min', 'max'])
        if (
          rules.daysSinceExpiry[key] != null &&
          (!Number.isInteger(Number(rules.daysSinceExpiry[key])) ||
            Number(rules.daysSinceExpiry[key]) < 0)
        )
          throw new BadRequestException(
            `Days since expiry ${key} must be a non-negative whole number.`,
          );
      if (
        rules.daysSinceExpiry.min != null &&
        rules.daysSinceExpiry.max != null &&
        Number(rules.daysSinceExpiry.min) > Number(rules.daysSinceExpiry.max)
      )
        throw new BadRequestException(
          'Minimum days since expiry cannot exceed maximum days.',
        );
    }
  }

  async createPromo(dto: CreatePromoDto) {
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);
    if (
      !Number.isFinite(startDate.getTime()) ||
      !Number.isFinite(endDate.getTime()) ||
      endDate <= startDate
    ) {
      throw new BadRequestException(
        'A valid end date after the start date is required.',
      );
    }
    const promotionKind = dto.promotionKind ?? PromoPromotionKind.REWARD;
    const rewardType = dto.rewardType ?? RewardType.SUBSCRIPTION;
    this.validatePromo({ ...dto, promotionKind, rewardType });
    const promoCode =
      dto.campaignType === PromoCampaignType.DIRECT
        ? dto.promoCode?.trim().toUpperCase() ||
          (await this.generatePromoCode())
        : undefined;
    if (promoCode && (await this.promoModel.exists({ promoCode })))
      throw new ConflictException('That promo code already exists.');

    const promo = await this.promoModel.create({
      ...dto,
      promotionKind,
      purpose: dto.purpose ?? PromoPurpose.GENERAL,
      rewardType,
      requirement: dto.requirement ?? PromoRequirement.REGISTER,
      targetCount: dto.targetCount ?? 1,
      rewardDurationDays:
        rewardType === RewardType.SUBSCRIPTION
          ? (dto.rewardDurationDays ?? 30)
          : undefined,
      promoCode,
      eligiblePlans: dto.eligiblePlans ?? [],
      eligibilityRules: dto.eligibilityRules ?? {},
      startDate,
      endDate,
      perUserRedemptionLimit: dto.perUserRedemptionLimit ?? 0,
      totalRedemptionLimit: dto.totalRedemptionLimit ?? 0,
    });
    return {
      ...promo.toObject(),
      registrationUrl: promoCode
        ? this.buildRegistrationUrl(promoCode)
        : undefined,
    };
  }

  private toPublicPromo(promo: Partial<Promo> & { _id: unknown }) {
    const promoCode = typeof promo.promoCode === 'string'
      ? promo.promoCode
      : undefined;
    return {
      _id: promo._id,
      name: promo.name,
      description: promo.description,
      promoCode,
      campaignType: promo.campaignType,
      promotionKind: promo.promotionKind,
      purpose: promo.purpose,
      startDate: promo.startDate,
      endDate: promo.endDate,
      requirement: promo.requirement,
      targetCount: promo.targetCount,
      rewardType: promo.rewardType,
      rewardPlan: promo.rewardPlan,
      rewardDurationDays: promo.rewardDurationDays,
      pointsAmount: promo.pointsAmount,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      minPurchaseAmount: promo.minPurchaseAmount,
      maxDiscountAmount: promo.maxDiscountAmount,
      amountCurrency: promo.amountCurrency,
      eligiblePlans: promo.eligiblePlans,
      registrationUrl: promoCode
        ? this.buildRegistrationUrl(promoCode)
        : undefined,
    };
  }

  private async findPublicPromos(filter: Record<string, any>) {
    const promos = await this.promoModel
      .find(filter)
      .select(PUBLIC_PROMO_SELECT)
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    return promos.map((promo) => this.toPublicPromo(promo as Partial<Promo> & { _id: unknown }));
  }

  async getActivePromos() {
    const now = new Date();
    return this.findPublicPromos({
      isActive: true,
      rewardType: { $ne: 'cash' as RewardType },
      startDate: { $lte: now },
      endDate: { $gte: now },
    });
  }

  async getActiveDirectPromos() {
    const now = new Date();
    return this.findPublicPromos({
      campaignType: PromoCampaignType.DIRECT,
      isActive: true,
      rewardType: { $ne: 'cash' as RewardType },
      startDate: { $lte: now },
      endDate: { $gte: now },
    });
  }

  async getActiveReferralPromos() {
    const now = new Date();
    return this.findPublicPromos({
      campaignType: PromoCampaignType.REFERRAL,
      isActive: true,
      rewardType: { $ne: 'cash' as RewardType },
      startDate: { $lte: now },
      endDate: { $gte: now },
    });
  }

  /** Public listing: only currently redeemable campaigns and public fields. */
  async findAll() {
    return this.getActivePromos();
  }

  async findById(id: string) {
    if (!Types.ObjectId.isValid(id)) return null;
    const promo = await this.promoModel.findById(id);
    return promo
      ? {
          ...promo.toObject(),
          registrationUrl: promo.promoCode
            ? this.buildRegistrationUrl(promo.promoCode)
            : undefined,
        }
      : null;
  }

  async findOne(id: string) {
    if (!Types.ObjectId.isValid(id))
      throw new BadRequestException('Invalid promo id.');
    const promo = await this.promoModel.findById(id);
    if (!promo) throw new NotFoundException('Promo not found.');
    return promo;
  }

  async findActiveReferralPromo(id: string) {
    const now = new Date();
    return this.promoModel.findOne({
      _id: id,
      campaignType: PromoCampaignType.REFERRAL,
      isActive: true,
      startDate: { $lte: now },
      endDate: { $gte: now },
    });
  }

  async updatePromo(id: string, dto: UpdatePromoDto) {
    if (!Types.ObjectId.isValid(id))
      throw new BadRequestException('Invalid promo id.');
    const existing = await this.promoModel.findById(id);
    if (!existing) throw new NotFoundException('Promo not found.');
    if ((existing.rewardType as string) === 'cash')
      throw new BadRequestException(
        'Legacy cash-reward campaigns are retired and cannot be edited or reactivated.',
      );
    const startDate = dto.startDate
      ? new Date(dto.startDate)
      : existing.startDate;
    const endDate = dto.endDate ? new Date(dto.endDate) : existing.endDate;
    if (
      !Number.isFinite(startDate.getTime()) ||
      !Number.isFinite(endDate.getTime()) ||
      endDate <= startDate
    )
      throw new BadRequestException('End date must be after start date.');
    this.validatePromo(dto, existing);
    const updates: Record<string, any> = {
      ...dto,
      startDate,
      endDate,
      eligibilityVersion: Number(existing.eligibilityVersion ?? 1) + 1,
    };
    if (dto.promoCode) {
      const normalized = dto.promoCode.trim().toUpperCase();
      const duplicate = await this.promoModel.exists({
        _id: { $ne: existing._id },
        promoCode: normalized,
      });
      if (duplicate)
        throw new ConflictException('That promo code already exists.');
      updates.promoCode = normalized;
    }
    if (
      dto.rewardType === RewardType.SUBSCRIPTION ||
      (!dto.rewardType && existing.rewardType === RewardType.SUBSCRIPTION)
    )
      updates.rewardDurationDays =
        dto.rewardDurationDays ?? existing.rewardDurationDays ?? 30;
    const updated = await this.promoModel.findByIdAndUpdate(id, updates, {
      returnDocument: 'after',
      runValidators: true,
    });
    return updated;
  }

  async deactivatePromo(id: string) {
    return this.promoModel.findByIdAndUpdate(
      id,
      { isActive: false },
      { returnDocument: 'after' },
    );
  }

  /**
   * Claims a promotion while the user currently qualifies. This freezes account-age
   * and verification eligibility for up to 72 hours, so an unverified user can
   * verify their email before paying without losing an offer intended for them.
   */
  async claimPromo(userId: string, promoCode: string) {
    if (!Types.ObjectId.isValid(userId))
      throw new BadRequestException('Invalid user.');
    const promo = await this.findActivePromoByCode(promoCode);
    if (
      !promo ||
      ![PromoPromotionKind.DISCOUNT, PromoPromotionKind.BUNDLE].includes(
        promo.promotionKind,
      )
    )
      throw new BadRequestException(
        'Promo code is invalid or does not support subscription discounts.',
      );
    const user = (await this.userModel
      .findById(userId)
      .select('createdAt isVerified status isDeleted referredBy')
      .lean()
      .exec()) as (User & { createdAt?: Date }) | null;
    if (
      !user ||
      user.isDeleted ||
      user.status === 'suspended' ||
      user.status === 'deleted'
    )
      throw new BadRequestException(
        'This account is not eligible to claim promotions.',
      );
    const rules = promo.eligibilityRules ?? {};
    this.assertAccountAge(user.createdAt, rules.accountAge);
    if (rules.verificationStatus === 'verified' && !user.isVerified)
      throw new BadRequestException(
        'Verify your account before claiming this promotion.',
      );
    if (rules.verificationStatus === 'unverified' && user.isVerified)
      throw new BadRequestException(
        'This promotion can only be claimed while your account is unverified.',
      );
    if (
      (promo.purpose === PromoPurpose.FIRST_PURCHASE ||
        rules.firstPurchaseOnly === true) &&
      (await this.paymentModel.exists({
        userId,
        status: 'approved',
        type: { $in: ['subscription', 'vip_upgrade', 'premium_upgrade'] },
      }))
    )
      throw new BadRequestException(
        'This promotion is only available on your first qualifying purchase.',
      );
    if (promo.purpose === PromoPurpose.REFERRAL && !user.referredBy)
      throw new BadRequestException(
        'This promotion is only available to referred users.',
      );
    const now = new Date();
    const expiresAt = new Date(
      Math.min(now.getTime() + 72 * 60 * 60 * 1000, promo.endDate.getTime()),
    );
    const existing = await this.claimModel
      .findOne({ promoId: promo._id, userId: new Types.ObjectId(userId) })
      .exec();
    if (
      existing &&
      existing.status === PromoClaimStatus.ACTIVE &&
      existing.expiresAt > now &&
      existing.promoVersion === Number(promo.eligibilityVersion ?? 1)
    )
      return existing;
    if (existing) {
      existing.verificationStatusAtClaim = user.isVerified
        ? 'verified'
        : 'unverified';
      existing.promoVersion = Number(promo.eligibilityVersion ?? 1);
      existing.expiresAt = expiresAt;
      existing.status = PromoClaimStatus.ACTIVE;
      const reactivated = await existing.save();
      await this.notificationEvents.promotionJoined({
        userId,
        promoId: String(promo._id),
        promoName: String(promo.name),
        promoCode: String(promo.promoCode ?? promoCode),
        expiresAt,
      });
      return reactivated;
    }
    const created = await this.claimModel.create({
      promoId: promo._id,
      userId: new Types.ObjectId(userId),
      verificationStatusAtClaim: user.isVerified ? 'verified' : 'unverified',
      promoVersion: Number(promo.eligibilityVersion ?? 1),
      expiresAt,
      status: PromoClaimStatus.ACTIVE,
    });
    await this.notificationEvents.promotionJoined({
      userId,
      promoId: String(promo._id),
      promoName: String(promo.name),
      promoCode: String(promo.promoCode ?? promoCode),
      expiresAt,
    });
    return created;
  }

  /** Server-authoritative discount calculation. The frontend never submits a payable amount. */
  async calculateDiscount(input: {
    userId: string;
    promoCode?: string;
    plan: PaidPlan;
    purchaseType: PurchaseType;
    baseAmount: number;
    currency: 'NGN' | 'USD';
  }): Promise<PromoPricingResult> {
    const baseAmount = this.money(input.baseAmount);
    const empty: PromoPricingResult = {
      amount: baseAmount,
      baseAmount,
      discountAmount: 0,
      pointsReward: 0,
    };
    if (!input.promoCode?.trim()) return empty;
    if (!Types.ObjectId.isValid(input.userId))
      throw new BadRequestException('Invalid user.');
    const promo = await this.findActivePromoByCode(input.promoCode);
    if (!promo)
      throw new BadRequestException(
        'Promo code is invalid, inactive, or expired.',
      );
    if (
      ![PromoPromotionKind.DISCOUNT, PromoPromotionKind.BUNDLE].includes(
        promo.promotionKind,
      ) ||
      !promo.discountType ||
      !(Number(promo.discountValue) > 0)
    )
      throw new BadRequestException(
        'This promo code does not provide a valid subscription discount.',
      );
    if (
      promo.eligiblePlans?.length &&
      !promo.eligiblePlans.includes(input.plan)
    )
      throw new BadRequestException(
        'This promotion is not available for the selected plan.',
      );
    if (
      (promo.discountType === PromoDiscountType.FIXED_AMOUNT ||
        promo.minPurchaseAmount != null ||
        promo.maxDiscountAmount != null) &&
      promo.amountCurrency !== input.currency
    )
      throw new BadRequestException(
        `This promotion is configured for ${promo.amountCurrency ?? 'a different'} currency.`,
      );
    if (promo.minPurchaseAmount != null && baseAmount < promo.minPurchaseAmount)
      throw new BadRequestException(
        'The subscription price does not meet this promotion minimum.',
      );

    const user = (await this.userModel
      .findById(input.userId)
      .select('createdAt isVerified status isDeleted referredBy')
      .lean()
      .exec()) as (User & { createdAt?: Date }) | null;
    if (
      !user ||
      user.isDeleted ||
      user.status === 'suspended' ||
      user.status === 'deleted'
    )
      throw new BadRequestException(
        'This account is not eligible to use promotions.',
      );
    const rules = promo.eligibilityRules ?? {};
    const now = new Date();
    const eligibilityClaim = await this.claimModel
      .findOne({
        promoId: promo._id,
        userId: new Types.ObjectId(input.userId),
        status: PromoClaimStatus.ACTIVE,
        expiresAt: { $gt: now },
        promoVersion: Number(promo.eligibilityVersion ?? 1),
      })
      .lean()
      .exec();
    if (!eligibilityClaim) {
      this.assertAccountAge(user.createdAt, rules.accountAge);
      if (rules.verificationStatus === 'verified' && !user.isVerified)
        throw new BadRequestException(
          'This promotion is only available to verified users.',
        );
      if (rules.verificationStatus === 'unverified' && user.isVerified)
        throw new BadRequestException(
          'This promotion is only available to unverified users unless you claimed it before verification.',
        );
    }

    const [
      previousPurchases,
      activeSubscription,
      latestSubscription,
      userRedemptions,
    ] = await Promise.all([
      this.paymentModel
        .countDocuments({
          userId: input.userId,
          status: 'approved',
          type: { $in: ['subscription', 'vip_upgrade', 'premium_upgrade'] },
        })
        .exec(),
      this.subscriptionModel
        .findOne({
          userId: input.userId,
          isActive: true,
          startDate: { $lte: now },
          expiryDate: { $gt: now },
        })
        .sort({ startDate: -1 })
        .lean()
        .exec(),
      this.subscriptionModel
        .findOne({ userId: input.userId })
        .sort({ expiryDate: -1, startDate: -1 })
        .lean()
        .exec(),
      this.redemptionModel
        .countDocuments({
          promoId: promo._id,
          userId: input.userId,
          status: {
            $in: [
              PromoRedemptionStatus.RESERVED,
              PromoRedemptionStatus.REDEEMED,
            ],
          },
        })
        .exec(),
    ]);
    const hasPreviousPurchase = previousPurchases > 0;
    const currentPlan = activeSubscription?.plan ?? 'free';
    const latestExpired =
      !activeSubscription &&
      !!latestSubscription &&
      new Date(latestSubscription.expiryDate) <= now;
    const subscriptionStatus = activeSubscription
      ? new Date(activeSubscription.expiryDate).getTime() - now.getTime() <=
        7 * 86400000
        ? 'renewal_due'
        : 'active'
      : latestExpired
        ? 'expired'
        : 'never_subscribed';

    if (
      promo.perUserRedemptionLimit > 0 &&
      userRedemptions >= promo.perUserRedemptionLimit
    )
      throw new BadRequestException(
        'You have reached this promotion’s redemption limit.',
      );
    if (
      promo.totalRedemptionLimit > 0 &&
      promo.redemptionCount + promo.reservedRedemptions >=
        promo.totalRedemptionLimit
    )
      throw new BadRequestException(
        'This promotion has reached its redemption limit.',
      );
    if (
      (promo.purpose === PromoPurpose.FIRST_PURCHASE ||
        rules.firstPurchaseOnly === true) &&
      hasPreviousPurchase
    )
      throw new BadRequestException(
        'This promotion is only available on your first qualifying purchase.',
      );
    if (
      promo.purpose === PromoPurpose.RENEWAL &&
      (!activeSubscription || activeSubscription.plan !== input.plan)
    )
      throw new BadRequestException(
        'This promotion is only available for eligible subscription renewals.',
      );
    if (promo.purpose === PromoPurpose.WIN_BACK && !latestExpired)
      throw new BadRequestException(
        'This promotion is only available to users with an expired subscription.',
      );
    if (promo.purpose === PromoPurpose.REFERRAL && !user.referredBy)
      throw new BadRequestException(
        'This promotion is only available to referred users.',
      );
    if (promo.purpose === PromoPurpose.UPGRADE) {
      const rank: Record<string, number> = {
        free: 0,
        regular: 1,
        vip: 2,
        premium: 3,
      };
      if (currentPlan === 'free' || rank[input.plan] <= rank[currentPlan])
        throw new BadRequestException(
          'This promotion is only available when upgrading to a higher plan.',
        );
    }
    if (
      rules.subscriptionStatus &&
      rules.subscriptionStatus !== 'any' &&
      rules.subscriptionStatus !== subscriptionStatus
    )
      throw new BadRequestException(
        'Your subscription status does not meet this promotion’s requirements.',
      );
    if (
      rules.previousPlan &&
      rules.previousPlan !== 'any' &&
      rules.previousPlan !== latestSubscription?.plan
    )
      throw new BadRequestException(
        'Your previous subscription plan does not meet this promotion’s requirements.',
      );
    if (rules.daysSinceExpiry && latestExpired) {
      const days = Math.floor(
        (now.getTime() - new Date(latestSubscription.expiryDate).getTime()) /
          86400000,
      );
      if (
        rules.daysSinceExpiry.min != null &&
        days < Number(rules.daysSinceExpiry.min)
      )
        throw new BadRequestException(
          'Your subscription expired too recently for this promotion.',
        );
      if (
        rules.daysSinceExpiry.max != null &&
        days > Number(rules.daysSinceExpiry.max)
      )
        throw new BadRequestException(
          'This promotion is no longer available for your subscription expiry period.',
        );
    }

    let discount =
      promo.discountType === PromoDiscountType.PERCENTAGE
        ? (baseAmount * Number(promo.discountValue)) / 100
        : Number(promo.discountValue);
    if (promo.maxDiscountAmount != null && promo.maxDiscountAmount > 0)
      discount = Math.min(discount, promo.maxDiscountAmount);
    discount = this.money(Math.min(baseAmount, Math.max(0, discount)));
    return {
      amount: this.money(baseAmount - discount),
      baseAmount,
      discountAmount: discount,
      promoId: String(promo._id),
      promoCode: promo.promoCode,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      pointsReward:
        promo.promotionKind === PromoPromotionKind.BUNDLE
          ? Number(promo.pointsAmount ?? 0)
          : 0,
    };
  }

  /**
   * Reserve a promotion redemption. When a caller supplies a session, the
   * reservation participates in that caller's transaction (payment creation
   * uses this to commit the payment and promo reservation as one operation).
   */
  async reserveRedemption(
    input: {
      promoId?: string;
      userId: string;
      paymentReference: string;
      baseAmount: number;
      discountAmount: number;
      finalAmount: number;
      pointsReward?: number;
      currency: 'NGN' | 'USD';
    },
    externalSession?: ClientSession,
  ) {
    if (!input.promoId) return null;

    const reserveInSession = async (session: ClientSession) => {
      const existing = await this.redemptionModel
        .findOne({ paymentReference: input.paymentReference })
        .session(session)
        .exec();
      if (existing) return existing;

      const promo = await this.promoModel
        .findById(input.promoId)
        .session(session)
        .exec();
      if (!promo) throw new BadRequestException('Promotion no longer exists.');

      const now = new Date();
      if (!promo.isActive || promo.startDate > now || promo.endDate < now) {
        throw new ConflictException('This promotion is no longer active.');
      }

      const userId = new Types.ObjectId(input.userId);
      const uses = await this.redemptionModel
        .countDocuments({
          promoId: promo._id,
          userId,
          status: {
            $in: [PromoRedemptionStatus.RESERVED, PromoRedemptionStatus.REDEEMED],
          },
        })
        .session(session)
        .exec();

      if (promo.perUserRedemptionLimit > 0 && uses >= promo.perUserRedemptionLimit) {
        throw new ConflictException(
          'You have reached this promotion’s redemption limit.',
        );
      }

      const filter: Record<string, any> = { _id: promo._id };
      if (promo.totalRedemptionLimit > 0) {
        filter.$expr = {
          $lt: [
            {
              $add: [
                { $ifNull: ['$redemptionCount', 0] },
                { $ifNull: ['$reservedRedemptions', 0] },
              ],
            },
            promo.totalRedemptionLimit,
          ],
        };
      }

      const reservedPromo = await this.promoModel
        .findOneAndUpdate(
          filter,
          { $inc: { reservedRedemptions: 1 } },
          { returnDocument: 'after', session },
        )
        .exec();

      if (!reservedPromo) {
        throw new ConflictException(
          'This promotion has reached its redemption limit.',
        );
      }

      const [created] = await this.redemptionModel.create(
        [
          {
            promoId: promo._id,
            userId,
            paymentReference: input.paymentReference,
            status: PromoRedemptionStatus.RESERVED,
            baseAmount: input.baseAmount,
            discountAmount: input.discountAmount,
            finalAmount: input.finalAmount,
            pointsReward: Math.max(0, Math.floor(Number(input.pointsReward ?? 0))),
            currency: input.currency,
          },
        ],
        { session },
      );

      return created;
    };

    if (externalSession) return reserveInSession(externalSession);

    const session = await this.promoModel.db.startSession();
    try {
      let result: PromoRedemptionDocument | null = null;
      await session.withTransaction(async () => {
        result = await reserveInSession(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  /** Called after payment entitlement processing; wallet grant is idempotent by redemption ID. */
  async completeSuccessfulRedemption(payment: {
    promoId?: string;
    userId: string;
    reference: string;
    pointsReward?: number;
  }) {
    if (!payment.promoId) return null;
    const redemption = await this.redemptionModel
      .findOne({ paymentReference: payment.reference })
      .exec();
    if (!redemption || redemption.status === PromoRedemptionStatus.RELEASED)
      return null;
    const points = Math.max(
      0,
      Math.floor(Number(redemption.pointsReward ?? payment.pointsReward ?? 0)),
    );

    if (redemption.status !== PromoRedemptionStatus.REDEEMED) {
      if (points > 0)
        await this.walletService.grantAdminBonusPoints(
          String(redemption.userId),
          points,
          `Promotion reward for ${payment.reference}`,
          String(redemption._id),
        );
      await this.claimModel
        .updateOne(
          {
            promoId: redemption.promoId,
            userId: redemption.userId,
            status: PromoClaimStatus.ACTIVE,
          },
          { $set: { status: PromoClaimStatus.USED } },
        )
        .exec();
      const session = await this.promoModel.db.startSession();
      try {
        await session.withTransaction(async () => {
          const updated = await this.redemptionModel
            .findOneAndUpdate(
              { _id: redemption._id, status: PromoRedemptionStatus.RESERVED },
              {
                $set: {
                  status: PromoRedemptionStatus.REDEEMED,
                  redeemedAt: new Date(),
                },
              },
              { returnDocument: 'after', session },
            )
            .exec();
          if (updated) {
            const counters = await this.promoModel
              .updateOne(
                { _id: redemption.promoId, reservedRedemptions: { $gt: 0 } },
                { $inc: { reservedRedemptions: -1, redemptionCount: 1 } },
                { session },
              )
              .exec();

            if (counters.matchedCount !== 1) {
              throw new ConflictException(
                'Promotion reservation counters are inconsistent; redemption was not committed.',
              );
            }
          }
        });
      } finally {
        await session.endSession();
      }
    }

    // This is safe to call on retries: the event is deduplicated by payment reference.
    // It also repairs the rare case where the redemption committed before the process
    // stopped, but the in-app event had not yet been queued.
    const completed = await this.redemptionModel.findById(redemption._id).exec();
    if (completed?.status === PromoRedemptionStatus.REDEEMED) {
      const promo = await this.promoModel
        .findById(redemption.promoId)
        .select('name')
        .lean()
        .exec();
      await this.notificationEvents.promotionCompleted({
        userId: String(redemption.userId),
        promoId: String(redemption.promoId),
        reference: payment.reference,
        promoName: String(promo?.name ?? 'Your promotion'),
        pointsReward: points,
      });
    }
    return completed;
  }

  /** Release a reservation. A supplied session lets payment rejection and
   * promo release commit atomically. Repeated calls are safe. */
  async releaseRedemption(
    paymentReference: string,
    externalSession?: ClientSession,
  ) {
    const releaseInSession = async (session: ClientSession) => {
      const redemption = await this.redemptionModel
        .findOneAndUpdate(
          { paymentReference, status: PromoRedemptionStatus.RESERVED },
          {
            $set: {
              status: PromoRedemptionStatus.RELEASED,
              releasedAt: new Date(),
            },
          },
          { returnDocument: 'after', session },
        )
        .exec();

      if (redemption) {
        const updatedPromo = await this.promoModel
          .updateOne(
            { _id: redemption.promoId, reservedRedemptions: { $gt: 0 } },
            { $inc: { reservedRedemptions: -1 } },
            { session },
          )
          .exec();

        if (updatedPromo.matchedCount !== 1) {
          throw new ConflictException(
            'Promotion reservation counters are inconsistent; release was not committed.',
          );
        }
      }
      return redemption;
    };

    if (externalSession) return releaseInSession(externalSession);

    const session = await this.promoModel.db.startSession();
    try {
      let result: PromoRedemptionDocument | null = null;
      await session.withTransaction(async () => {
        result = await releaseInSession(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async getUserRedemptions(userId: string, pageValue = 1, limitValue = 20) {
    if (!Types.ObjectId.isValid(userId))
      throw new BadRequestException('Invalid user id.');
    const page = Math.max(1, Math.floor(Number(pageValue) || 1));
    const limit = Math.min(
      100,
      Math.max(1, Math.floor(Number(limitValue) || 20)),
    );
    const filter = { userId: new Types.ObjectId(userId) };
    const [items, total] = await Promise.all([
      this.redemptionModel
        .find(filter)
        .populate('promoId', 'name promoCode purpose promotionKind')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.redemptionModel.countDocuments(filter).exec(),
    ]);
    return {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async getRedemptions(pageValue = 1, limitValue = 20) {
    const page = Math.max(1, Math.floor(Number(pageValue) || 1));
    const limit = Math.min(
      100,
      Math.max(1, Math.floor(Number(limitValue) || 20)),
    );
    const [items, total] = await Promise.all([
      this.redemptionModel
        .find()
        .populate('promoId', 'name promoCode purpose promotionKind')
        .populate('userId', 'fullName username email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.redemptionModel.countDocuments().exec(),
    ]);
    return {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async getPromotionAnalytics(promoId?: string) {
    if (promoId && !Types.ObjectId.isValid(promoId))
      throw new BadRequestException('Invalid promo id.');
    const filter = promoId ? { promoId: new Types.ObjectId(promoId) } : {};
    const [reserved, redeemed, released, aggregate] = await Promise.all([
      this.redemptionModel
        .countDocuments({ ...filter, status: PromoRedemptionStatus.RESERVED })
        .exec(),
      this.redemptionModel
        .countDocuments({ ...filter, status: PromoRedemptionStatus.REDEEMED })
        .exec(),
      this.redemptionModel
        .countDocuments({ ...filter, status: PromoRedemptionStatus.RELEASED })
        .exec(),
      this.redemptionModel
        .aggregate<PromoAnalyticsRow>([
          { $match: { ...filter, status: PromoRedemptionStatus.REDEEMED } },
          {
            $group: {
              _id: '$currency',
              grossValue: { $sum: '$baseAmount' },
              discountCost: { $sum: '$discountAmount' },
              pointsAwarded: { $sum: '$pointsReward' },
            },
          },
        ])
        .exec(),
    ]);
    const byCurrency = Object.fromEntries(
      aggregate.map((row) => [
        row._id,
        {
          grossValue: row.grossValue,
          discountCost: row.discountCost,
          netSubscriptionValue: Math.max(0, row.grossValue - row.discountCost),
        },
      ]),
    );
    return {
      reserved,
      redeemed,
      released,
      byCurrency,
      pointsAwarded: aggregate.reduce(
        (sum: number, row) => sum + Number(row.pointsAwarded ?? 0),
        0,
      ),
    };
  }

  private assertAccountAge(createdAt: unknown, rule?: AccountAgeRule) {
    if (!rule || !createdAt) return;
    const registeredAt = new Date(createdAt as string | number | Date);
    if (!Number.isFinite(registeredAt.getTime()))
      throw new BadRequestException(
        'Account registration date is unavailable.',
      );
    const unit = rule.unit ?? 'days';
    const shift = (date: Date, amount: number) => {
      const next = new Date(date);
      if (unit === 'months') next.setMonth(next.getMonth() + amount);
      else if (unit === 'years') next.setFullYear(next.getFullYear() + amount);
      else next.setDate(next.getDate() + amount);
      return next;
    };
    const now = new Date();
    const min = rule.min != null ? Number(rule.min) : undefined;
    const max = rule.max != null ? Number(rule.max) : undefined;
    if (min != null && now < shift(registeredAt, min))
      throw new BadRequestException(
        'Your account is too new for this promotion.',
      );
    if (max != null && now > shift(registeredAt, max))
      throw new BadRequestException(
        'Your account is outside this promotion’s eligible age range.',
      );
  }

  private money(value: number) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }
}



