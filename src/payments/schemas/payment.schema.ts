import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PaymentDocument = HydratedDocument<Payment>;
export type PaymentStatus = 'pending' | 'processing' | 'approved' | 'rejected';
export type PaymentType = 'subscription' | 'vip_upgrade' | 'premium_upgrade';
export type PaymentGatewayInitializationStatus =
  | 'not_applicable'
  | 'initializing'
  | 'initialized'
  | 'unknown'
  | 'failed';
export type PaymentApprovalSource = 'manual' | 'paystack';

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
  @Prop({ required: true, type: String, enum: ['NGN', 'USD'] }) currency!: 'NGN' | 'USD';

  @Prop({ required: true, unique: true, trim: true }) reference!: string;
  @Prop({
    type: String,
    enum: ['pending', 'processing', 'approved', 'rejected'],
    default: 'pending',
    index: true,
  })
  status!: PaymentStatus;

  @Prop({ type: String, enum: ['subscription', 'vip_upgrade', 'premium_upgrade'], required: true })
  type!: PaymentType;
  @Prop({ type: Number, required: false, default: null }) gatewayAmount?: number | null;
  @Prop({ type: String, enum: ['NGN'], default: 'NGN' }) gatewayCurrency?: 'NGN';
  @Prop({ type: Number, default: null }) exchangeRate?: number;
  @Prop({ type: String, enum: ['manual', 'paystack'], default: 'manual' })
  gateway!: 'manual' | 'paystack';

  @Prop({ type: String, default: undefined, trim: true })
  gatewayTransactionId?: string;
  @Prop({ type: Object, default: null })
  gatewayResponse!: Record<string, any> | null;
  @Prop({
    type: String,
    enum: ['not_applicable', 'initializing', 'initialized', 'unknown', 'failed'],
    default: 'not_applicable',
    index: true,
  })
  gatewayInitializationStatus!: PaymentGatewayInitializationStatus;
  @Prop({ type: String, default: null }) gatewayAuthorizationUrl?: string | null;
  @Prop({ type: Date, default: null }) gatewayInitializationAttemptedAt?: Date | null;
  @Prop({ type: Date, default: null }) gatewayInitializedAt?: Date | null;
  @Prop({ type: String, default: null, maxlength: 500 })
  gatewayInitializationLastError?: string | null;

  @Prop({ required: true }) target!: string;
  @Prop({ default: '' }) transferReference?: string;
  @Prop({ default: '' }) proofImageUrl?: string;
  @Prop({ default: '' }) proofPublicId?: string;
  @Prop({ default: '' }) proofMessage?: string;
  @Prop({ default: '' }) adminNote?: string;

  /** Unique key held while a payment is active, preventing concurrent duplicates. */
  @Prop({ type: String, default: undefined, trim: true })
  activeRequestKey?: string;

  /** Durable approval-processing lease. A worker resumes expired leases. */
  @Prop({ type: String, default: null }) processingToken?: string | null;
  @Prop({ type: Date, default: null, index: true })
  processingLeaseExpiresAt?: Date | null;
  @Prop({ type: Number, default: 0, min: 0 }) processingAttempts!: number;
  @Prop({ type: String, default: null, maxlength: 1000 })
  processingLastError?: string | null;
  @Prop({ type: String, enum: ['manual', 'paystack'], default: undefined })
  approvalSource?: PaymentApprovalSource;

  /** Durable notification outbox state; old payment history remains untouched. */
  @Prop({ type: Boolean, default: false, index: true })
  notificationOutboxPending!: boolean;
  @Prop({ type: Date, default: null })
  paymentSubmittedNotificationQueuedAt?: Date | null;
  @Prop({ type: Date, default: null })
  paymentSuccessfulNotificationQueuedAt?: Date | null;
  @Prop({ type: Date, default: null })
  paymentRejectedNotificationQueuedAt?: Date | null;

  @Prop({ default: null }) processedAt?: Date;
  @Prop({ default: null }) processedBy?: string;
}

export const PaymentSchema = SchemaFactory.createForClass(Payment);

PaymentSchema.index({ promoId: 1, createdAt: -1 });
PaymentSchema.index(
  { activeRequestKey: 1 },
  {
    unique: true,
    sparse: true,
    name: 'uniq_payment_active_request_key',
  },
);
PaymentSchema.index(
  { status: 1, processingLeaseExpiresAt: 1, createdAt: 1 },
  { name: 'idx_payment_processing_recovery' },
);

