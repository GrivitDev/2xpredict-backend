import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  NOTIFICATION_ICONS,
  NOTIFICATION_VARIANTS,
} from '../notification-presentation';
import type {
  NotificationIcon,
  NotificationVariant,
} from '../notification-presentation';

@Schema({ _id: false, minimize: false })
export class NotificationPresentationRecord {
  @Prop({ type: String, enum: [...NOTIFICATION_VARIANTS], default: 'info' })
  variant!: NotificationVariant;

  @Prop({ type: String, enum: [...NOTIFICATION_ICONS], default: 'bell' })
  icon!: NotificationIcon;

  @Prop({ type: String, default: null, maxlength: 300 })
  imageUrl?: string | null;

  @Prop({ type: String, default: null, maxlength: 36 })
  actionLabel?: string | null;
}

export const NotificationPresentationRecordSchema =
  SchemaFactory.createForClass(NotificationPresentationRecord);
