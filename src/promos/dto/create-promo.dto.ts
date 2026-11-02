import { IsArray, IsBoolean, IsDateString, IsEnum, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PromoRequirement } from '../constants/promo-requirements';
import { RewardType } from '../constants/reward-types';
import { PromoCampaignType } from '../constants/promo-campaign-type';
import { PromoPromotionKind } from '../constants/promo-promotion-kind';
import { PromoDiscountType } from '../constants/promo-discount-type';
import { PromoPurpose } from '../constants/promo-purpose';

export class CreatePromoDto {
  @IsString() @MaxLength(120) name!: string;
  @IsEnum(PromoCampaignType) campaignType!: PromoCampaignType;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsString() @IsOptional() @MaxLength(60) promoCode?: string;
  @IsString() @IsOptional() @IsEnum(PromoPromotionKind) promotionKind?: PromoPromotionKind;
  @IsOptional() @IsEnum(PromoPurpose) purpose?: PromoPurpose;
  @IsDateString() startDate!: string;
  @IsDateString() endDate!: string;
  @IsOptional() @IsEnum(PromoRequirement) requirement?: PromoRequirement;
  @IsOptional() @IsInt() @Min(1) targetCount?: number;
  @IsOptional() @IsEnum(RewardType) rewardType?: RewardType;
  @IsOptional() @IsIn(['regular', 'vip', 'premium']) rewardPlan?: 'regular' | 'vip' | 'premium';
  @IsOptional() @IsInt() @Min(1) @Max(365) rewardDurationDays?: number;
  @IsOptional() @IsInt() @Min(1) pointsAmount?: number;
  @IsOptional() @IsEnum(PromoDiscountType) discountType?: PromoDiscountType;
  @IsOptional() @IsNumber() @Min(0.01) discountValue?: number;
  @IsOptional() @IsNumber() @Min(0) minPurchaseAmount?: number;
  @IsOptional() @IsNumber() @Min(0) maxDiscountAmount?: number;
  @IsOptional() @IsIn(['NGN', 'USD']) amountCurrency?: 'NGN' | 'USD';
  @IsOptional() @IsArray() @IsIn(['regular', 'vip', 'premium'], { each: true }) eligiblePlans?: Array<'regular' | 'vip' | 'premium'>;
  @IsOptional() @IsObject() eligibilityRules?: Record<string, any>;
  @IsOptional() @IsInt() @Min(0) perUserRedemptionLimit?: number;
  @IsOptional() @IsInt() @Min(0) totalRedemptionLimit?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) maxClaims?: number;
}
