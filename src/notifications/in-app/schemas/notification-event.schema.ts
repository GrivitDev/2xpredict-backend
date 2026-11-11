import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { NotificationCategory } from '../enums/notification-category.enum';
import { NotificationType } from '../enums/notification-type.enum';

export type NotificationEventDocument = HydratedDocument<NotificationEvent>;

export enum NotificationEventStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  RETRYING = 'RETRYING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

/**
 * Durable MongoDB-backed outbox for in-app notification events.
 * This collection contains communication events only, never business records.
 */
@Schema({
  timestamps: true,
  collection: 'notification_events',
  minimize: false,
})
export class NotificationEvent {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  recipientId!: Types.ObjectId;

  @Prop({ type: String, enum: NotificationType, required: true })
  type!: NotificationType;

  @Prop({ type: String, enum: NotificationCategory, required: true })
  category!: NotificationCategory;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  title!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 1200 })
  message!: string;

  @Prop({ type: String, default: null, maxlength: 300 })
  actionUrl?: string | null;

  @Prop({ type: Object, default: {} })
  data!: Record<string, unknown>;

  @Prop({ type: String, required: true, trim: true, maxlength: 180 })
  dedupeKey!: string;

  @Prop({
    type: String,
    enum: NotificationEventStatus,
    default: NotificationEventStatus.PENDING,
    index: true,
  })
  status!: NotificationEventStatus;

  @Prop({ type: Number, default: 0, min: 0 })
  attempts!: number;

  @Prop({ type: Date, default: Date.now, index: true })
  nextAttemptAt!: Date;

  @Prop({ type: Date, default: null, index: true })
  lockedAt?: Date | null;

  @Prop({ type: String, default: null, maxlength: 80 })
  lockToken?: string | null;

  @Prop({ type: Date, default: null })
  processedAt?: Date | null;

  @Prop({ type: String, default: null, maxlength: 1000 })
  lastError?: string | null;

  /** Communication-log retention only; no business collection uses this TTL. */
  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const NotificationEventSchema =
  SchemaFactory.createForClass(NotificationEvent);

NotificationEventSchema.index(
  { recipientId: 1, dedupeKey: 1 },
  { unique: true, name: 'uniq_notification_event_recipient_dedupe' },
);
NotificationEventSchema.index(
  { status: 1, nextAttemptAt: 1, createdAt: 1 },
  { name: 'idx_notification_event_dispatch' },
);
NotificationEventSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_notification_events_18_months' },
);

