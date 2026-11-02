import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
export type PaymentDocument = HydratedDocument<Payment>;
export type PaymentStatus = 'pending' | 'approved' | 'rejected';
export type PaymentType = 'subscription' | 'vip_upgrade' | 'premium_upgrade';

@Schema({ timestamps: true })
export class Payment {
  @Prop({ required: true }) userId!: string;
  @Prop({ required: true }) email!: string;
  /** Final discounted subscription price in the user's currency. */
  @Prop({ required: true, min: 0 }) amount!: number;
  @Prop({ type: Number, min: 0, default: undefined }) baseAmount?: number;
  @Prop({ type: Number, min: 0, default: 0 }) discountAmount!: number;
  @Prop({ type: String, default: undefined, uppercase: true, trim: true }) promoCode?: string;
  @Prop({ type: String, default: undefined, index: true }) promoId?: string;
  @Prop({ type: String, enum: ['percentage', 'fixed_amount'], default: undefined }) discountType?: 'percentage' | 'fixed_amount';
  @Prop({ type: Number, min: 0, default: undefined }) discountValue?: number;
  @Prop({ type: Number, min: 0, default: 0 }) pointsReward!: number;
  @Prop({ required: true, enum: ['NGN', 'USD'] }) currency!: 'NGN' | 'USD';
  @Prop({ required: true, unique: true }) reference!: string;
  @Prop({ enum: ['pending', 'approved', 'rejected'], default: 'pending' }) status!: PaymentStatus;
  @Prop({ enum: ['subscription', 'vip_upgrade', 'premium_upgrade'], required: true }) type!: PaymentType;
  @Prop({ type: Number, required: false, default: null }) gatewayAmount?: number | null;
  @Prop({ type: String, enum: ['NGN'], default: 'NGN' }) gatewayCurrency?: 'NGN';
  @Prop({ type: Number, default: null }) exchangeRate?: number;
  @Prop({ type: String, default: 'manual' }) gateway!: 'manual' | 'paystack';
  @Prop({ default: '' }) gatewayTransactionId!: string;
  @Prop({ type: Object, default: null }) gatewayResponse!: Record<string, any> | null;
  @Prop({ required: true }) target!: string;
  @Prop({ default: '' }) transferReference?: string;
  @Prop({ default: '' }) proofImageUrl?: string;
  @Prop({ default: '' }) proofPublicId?: string;
  @Prop({ default: '' }) proofMessage?: string;
  @Prop({ default: '' }) adminNote?: string;
  @Prop({ default: null }) processedAt?: Date;
  @Prop({ default: null }) processedBy?: string;
}
export const PaymentSchema = SchemaFactory.createForClass(Payment);
PaymentSchema.index({ promoId: 1, createdAt: -1 });
