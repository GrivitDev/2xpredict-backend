import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';
import { RewardType } from '../constants/reward-types';
import { PromoRewardStatus } from '../constants/promo-reward-status';
export type PromoRewardDocument = HydratedDocument<PromoReward>;

@Schema({ timestamps: true })
export class PromoReward {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Promo', required: true, index: true }) promoId!: mongoose.Types.ObjectId;
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }) userId!: mongoose.Types.ObjectId;
  @Prop({ required: true }) claimNumber!: number;
  @Prop({ enum: RewardType, type: String, required: true }) type!: RewardType;
  @Prop({ type: String, enum: ['regular', 'vip', 'premium'] }) plan?: 'regular' | 'vip' | 'premium';
  @Prop({ type: Number, min: 1, max: 365 }) durationDays?: number;
  /** Non-cash, non-withdrawable virtual points. */
  @Prop({ type: Number, min: 1 }) points?: number;
  @Prop({ enum: PromoRewardStatus, type: String, default: PromoRewardStatus.PENDING }) status!: PromoRewardStatus;
  @Prop() paidAt?: Date;
  @Prop() claimedAt?: Date;

  /** Actual subscription created by a subscription reward; used for truthful notices. */
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', default: null })
  subscriptionId?: mongoose.Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  subscriptionStartDate?: Date | null;

  @Prop({ type: Date, default: null })
  subscriptionExpiryDate?: Date | null;

  @Prop({ type: Boolean, default: null })
  subscriptionIsActive?: boolean | null;
}
export const PromoRewardSchema = SchemaFactory.createForClass(PromoReward);
PromoRewardSchema.index({ promoId: 1, userId: 1, claimNumber: 1 }, { unique: true });


