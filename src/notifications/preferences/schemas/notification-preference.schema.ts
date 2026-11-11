import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type NotificationPreferenceDocument = HydratedDocument<NotificationPreference>;

/**
 * Persistent communication preferences are user settings, not delivery logs.
 * They intentionally have no TTL index.
 */
@Schema({
  timestamps: true,
  collection: 'notification_preferences',
  minimize: false,
})
export class NotificationPreference {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  recipientId!: Types.ObjectId;

  /** Disables optional email categories; essential security/transactional mail remains enabled. */
  @Prop({ type: Boolean, default: true })
  emailEnabled!: boolean;

  @Prop({ type: Map, of: Boolean, default: {} })
  emailCategories!: Map<string, boolean>;

  createdAt!: Date;
  updatedAt!: Date;
}

export const NotificationPreferenceSchema =
  SchemaFactory.createForClass(NotificationPreference);

NotificationPreferenceSchema.index(
  { recipientId: 1 },
  { unique: true, name: 'uniq_notification_preferences_recipient' },
);
