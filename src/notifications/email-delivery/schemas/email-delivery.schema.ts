import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { NotificationCategory } from '../../in-app/enums/notification-category.enum';

export type EmailDeliveryDocument = HydratedDocument<EmailDelivery>;

export enum EmailDeliveryStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  RETRYING = 'RETRYING',
  SENT = 'SENT',
  DELAYED = 'DELAYED',
  DELIVERED = 'DELIVERED',
  BOUNCED = 'BOUNCED',
  COMPLAINED = 'COMPLAINED',
  SUPPRESSED = 'SUPPRESSED',
  SKIPPED = 'SKIPPED',
  FAILED = 'FAILED',
  UNKNOWN = 'UNKNOWN',
}

export enum EmailDeliveryTemplate {
  NOTIFICATION = 'NOTIFICATION',
  OTP = 'OTP',
  PASSWORD_RESET = 'PASSWORD_RESET',
  WELCOME = 'WELCOME',
}

/**
 * Communication-only email outbox. The email address and rendered content are
 * encrypted together so OTPs and password-reset links are never stored in
 * plaintext in this collection. TTL applies only to this delivery log.
 */
@Schema({
  timestamps: true,
  collection: 'notification_deliveries',
  minimize: false,
})
export class EmailDelivery {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  recipientId!: Types.ObjectId;

  @Prop({ type: String, default: 'EMAIL', enum: ['EMAIL'], required: true })
  channel!: 'EMAIL';

  @Prop({ type: String, enum: Object.values(EmailDeliveryTemplate), required: true })
  template!: EmailDeliveryTemplate;

  @Prop({ type: String, enum: NotificationCategory, required: true })
  category!: NotificationCategory;

  @Prop({ type: String, required: true, trim: true, maxlength: 180 })
  dedupeKey!: string;

  /** Optional replacement group, used to supersede OTPs only within the same purpose/address. */
  @Prop({ type: String, default: null, maxlength: 220 })
  scopeKey?: string | null;

  /** HMAC fingerprint of normalized recipient address for exact-address suppression. */
  @Prop({ type: String, default: null, maxlength: 64, index: true })
  recipientAddressFingerprint?: string | null;

  @Prop({ type: String, required: true })
  encryptedPayload!: string;

  @Prop({ type: String, required: true })
  payloadIv!: string;

  @Prop({ type: String, required: true })
  payloadAuthTag!: string;

  @Prop({ type: Boolean, default: false })
  essential!: boolean;

  /** Optional business validity deadline for one-time codes and reset links. */
  @Prop({ type: Date, default: null })
  payloadExpiresAt?: Date | null;

  @Prop({
    type: String,
    enum: Object.values(EmailDeliveryStatus),
    default: EmailDeliveryStatus.PENDING,
  })
  status!: EmailDeliveryStatus;

  @Prop({ type: Number, default: 0, min: 0 })
  attempts!: number;

  /** First provider-attempt timestamp, used to respect Resend idempotency expiry. */
  @Prop({ type: Date, default: null })
  firstAttemptAt?: Date | null;

  @Prop({ type: Date, default: Date.now })
  nextAttemptAt!: Date;

  @Prop({ type: Date, default: null })
  lockedAt?: Date | null;

  @Prop({ type: String, default: null, maxlength: 80 })
  lockToken?: string | null;

  @Prop({ type: String, default: null, maxlength: 160 })
  providerMessageId?: string | null;

  @Prop({ type: Date, default: null })
  providerEventAt?: Date | null;

  @Prop({ type: String, default: null, maxlength: 1000 })
  lastError?: string | null;

  /** Communication-log retention only. */
  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const EmailDeliverySchema = SchemaFactory.createForClass(EmailDelivery);

EmailDeliverySchema.index(
  { recipientId: 1, channel: 1, dedupeKey: 1 },
  { unique: true, name: 'uniq_notification_delivery_recipient_channel_dedupe' },
);
EmailDeliverySchema.index(
  { status: 1, nextAttemptAt: 1, createdAt: 1 },
  { name: 'idx_notification_delivery_dispatch' },
);
EmailDeliverySchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_notification_deliveries_18_months' },
);

EmailDeliverySchema.index(
  { status: 1, lockedAt: 1, attempts: 1 },
  { name: 'idx_notification_delivery_stale_lock' },
);
EmailDeliverySchema.index(
  { status: 1, firstAttemptAt: 1 },
  { name: 'idx_notification_delivery_idempotency_window' },
);
EmailDeliverySchema.index(
  { recipientId: 1, template: 1, scopeKey: 1, status: 1 },
  { name: 'idx_notification_delivery_scope_cancel' },
);

