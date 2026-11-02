import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { PromoRequirement } from '../constants/promo-requirements';
import { RewardType } from '../constants/reward-types';
import { PromoCampaignType } from '../constants/promo-campaign-type';
import { PromoPromotionKind } from '../constants/promo-promotion-kind';
import { PromoDiscountType } from '../constants/promo-discount-type';
import { PromoPurpose } from '../constants/promo-purpose';

export type PromoDocument = HydratedDocument<Promo>;

@Schema({ timestamps: true })
export class Promo {
  @Prop({ required: true, trim: true }) name!: string;
  @Prop({ default: '' }) description?: string;
  @Prop({ unique: true, sparse: true, uppercase: true, trim: true, index: true }) promoCode?: string;
  @Prop({ enum: PromoCampaignType, required: true, index: true }) campaignType!: PromoCampaignType;
  @Prop({ enum: PromoPromotionKind, type: String, default: PromoPromotionKind.REWARD, index: true }) promotionKind!: PromoPromotionKind;
  @Prop({ enum: PromoPurpose, type: String, default: PromoPurpose.GENERAL, index: true }) purpose!: PromoPurpose;
  @Prop({ default: true, index: true }) isActive!: boolean;
  @Prop({ required: true, index: true }) startDate!: Date;
  @Prop({ required: true, index: true }) endDate!: Date;
  @Prop({ enum: PromoRequirement, required: true, default: PromoRequirement.REGISTER }) requirement!: PromoRequirement;
  @Prop({ required: true, default: 1, min: 1 }) targetCount!: number;

  /** Existing referral/reward claim limit. 0 means unlimited. */
  @Prop({ default: 1, min: 0 }) maxClaims!: number;
  @Prop({ enum: RewardType, type: String, default: RewardType.SUBSCRIPTION }) rewardType!: RewardType;
  @Prop({ enum: ['regular', 'vip', 'premium'] }) rewardPlan?: 'regular' | 'vip' | 'premium';
  @Prop({ type: Number, min: 1, max: 365, default: 30 }) rewardDurationDays?: number;
  @Prop({ type: Number, min: 1, default: undefined }) pointsAmount?: number;

  // Discount configuration. Discounts are applied only by server-side pricing.
  @Prop({ enum: PromoDiscountType, type: String, default: undefined }) discountType?: PromoDiscountType;
  @Prop({ type: Number, min: 0, default: undefined }) discountValue?: number;
  @Prop({ type: Number, min: 0, default: undefined }) minPurchaseAmount?: number;
  @Prop({ type: Number, min: 0, default: undefined }) maxDiscountAmount?: number;
  @Prop({ type: String, enum: ['NGN', 'USD'], default: undefined }) amountCurrency?: 'NGN' | 'USD';
  @Prop({ type: [String], enum: ['regular', 'vip', 'premium'], default: [] }) eligiblePlans!: Array<'regular' | 'vip' | 'premium'>;
  /** JSON rule object validated and evaluated by PromosService. */
  @Prop({ type: Object, default: {} }) eligibilityRules!: Record<string, any>;
  @Prop({ type: Number, min: 0, default: 0 }) perUserRedemptionLimit!: number;
  @Prop({ type: Number, min: 0, default: 0 }) totalRedemptionLimit!: number;
  @Prop({ type: Number, min: 0, default: 0 }) redemptionCount!: number;
  @Prop({ type: Number, min: 0, default: 0 }) reservedRedemptions!: number;
  /** Incremented only when an administrator edits campaign configuration. */
  @Prop({ type: Number, min: 1, default: 1 }) eligibilityVersion!: number;
}

export const PromoSchema = SchemaFactory.createForClass(Promo);
PromoSchema.index({ campaignType: 1, promotionKind: 1, isActive: 1, startDate: 1, endDate: 1 });
