import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

export type PromoRedemptionDocument = HydratedDocument<PromoRedemption>;
export enum PromoRedemptionStatus {
  RESERVED = 'reserved',
  REDEEMED = 'redeemed',
  RELEASED = 'released',
}

@Schema({ timestamps: true, collection: 'promo_redemptions' })
export class PromoRedemption {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Promo', required: true, index: true }) promoId!: mongoose.Types.ObjectId;
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }) userId!: mongoose.Types.ObjectId;
  @Prop({ required: true, unique: true, trim: true, index: true }) paymentReference!: string;
  @Prop({ enum: PromoRedemptionStatus, type: String, default: PromoRedemptionStatus.RESERVED, index: true }) status!: PromoRedemptionStatus;
  @Prop({ type: Number, min: 0, default: 0 }) baseAmount!: number;
  @Prop({ type: Number, min: 0, default: 0 }) discountAmount!: number;
  @Prop({ type: Number, min: 0, default: 0 }) finalAmount!: number;
  @Prop({ type: Number, min: 0, default: 0 }) pointsReward!: number;
  @Prop({ type: String, enum: ['NGN', 'USD'], required: true }) currency!: 'NGN' | 'USD';
  @Prop({ type: Date, default: null }) redeemedAt?: Date | null;
  @Prop({ type: Date, default: null }) releasedAt?: Date | null;
}

export const PromoRedemptionSchema = SchemaFactory.createForClass(PromoRedemption);
PromoRedemptionSchema.index({ promoId: 1, userId: 1, status: 1 });
