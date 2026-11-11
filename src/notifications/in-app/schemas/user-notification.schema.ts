import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { NotificationCategory } from '../enums/notification-category.enum';
import { NotificationType } from '../enums/notification-type.enum';

export type UserNotificationDocument = HydratedDocument<UserNotification>;

@Schema({
  timestamps: true,
  collection: 'user_notifications',
  minimize: false,
})
export class UserNotification {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  recipientId!: Types.ObjectId;

  @Prop({ type: String, enum: NotificationType, required: true, index: true })
  type!: NotificationType;

  @Prop({ type: String, enum: NotificationCategory, required: true, index: true })
  category!: NotificationCategory;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  title!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 1200 })
  message!: string;

  @Prop({ type: Object, default: {} })
  data!: Record<string, unknown>;

  @Prop({ type: String, default: null, maxlength: 300 })
  actionUrl?: string | null;

  /** Unique per recipient. Used to make retried business events idempotent. */
  @Prop({ type: String, required: true, trim: true, maxlength: 180 })
  dedupeKey!: string;

  @Prop({ type: Date, default: null, index: true })
  readAt?: Date | null;

  /** MongoDB TTL removes notification records after 18 calendar months. */
  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const UserNotificationSchema =
  SchemaFactory.createForClass(UserNotification);

UserNotificationSchema.index({ recipientId: 1, createdAt: -1 });
UserNotificationSchema.index({ recipientId: 1, readAt: 1, createdAt: -1 });
UserNotificationSchema.index({ recipientId: 1, category: 1, createdAt: -1 });
UserNotificationSchema.index(
  { recipientId: 1, dedupeKey: 1 },
  { unique: true, name: 'uniq_user_notification_dedupe' },
);
UserNotificationSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_user_notifications_18_months' },
);
