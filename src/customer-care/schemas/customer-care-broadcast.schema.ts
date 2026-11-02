import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CustomerCareBroadcastDocument = HydratedDocument<CustomerCareBroadcast>;
export type CustomerCareBroadcastKind = 'DAILY_PICKS' | 'PROMOTION';

@Schema({ timestamps: true, collection: 'customer_care_broadcasts' })
export class CustomerCareBroadcast {
  @Prop({ type: String, enum: ['DAILY_PICKS', 'PROMOTION'], required: true, index: true })
  kind!: CustomerCareBroadcastKind;

  @Prop({ type: String, required: true, trim: true, index: true })
  dateKey!: string;

  /** "daily" for picks; the existing promotion ID for a promotion broadcast. */
  @Prop({ type: String, required: true, trim: true })
  sourceKey!: string;

  @Prop({ type: String, enum: ['GENERATING', 'READY', 'SENDING', 'SENT', 'SKIPPED', 'FAILED'], default: 'GENERATING', index: true })
  status!: 'GENERATING' | 'READY' | 'SENDING' | 'SENT' | 'SKIPPED' | 'FAILED';

  @Prop({ type: String, maxlength: 4000, default: '' })
  content!: string;

  @Prop({ type: [String], default: [] })
  sourceReferences!: string[];

  @Prop({ type: String, maxlength: 80, default: '' })
  styleTag!: string;

  @Prop({ type: String, maxlength: 1000, default: '' })
  skipReason!: string;

  @Prop({ type: Number, min: 0, default: 0 })
  attempts!: number;

  @Prop({ type: Number, min: 0 })
  telegramMessageId?: number;

  @Prop({ type: Date })
  sentAt?: Date;

  @Prop({ type: Boolean, default: false, index: true })
  manualReviewRequired!: boolean;

  @Prop({ type: String, maxlength: 1000, default: '' })
  lastError!: string;
}

export const CustomerCareBroadcastSchema = SchemaFactory.createForClass(CustomerCareBroadcast);
CustomerCareBroadcastSchema.index({ kind: 1, dateKey: 1, sourceKey: 1 }, { unique: true });
CustomerCareBroadcastSchema.index({ status: 1, updatedAt: -1 });
