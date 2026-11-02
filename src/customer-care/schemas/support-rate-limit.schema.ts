import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SupportRateLimitDocument = HydratedDocument<SupportRateLimit>;

/** One tiny per-account rolling-window counter. No message text is stored here. */
@Schema({ timestamps: true, collection: 'support_rate_limits' })
export class SupportRateLimit {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId!: Types.ObjectId;

  @Prop({ type: [Date], default: [] })
  requestTimes!: Date[];

  @Prop({ type: Date, required: true })
  expiresAt!: Date;
}

export const SupportRateLimitSchema = SchemaFactory.createForClass(SupportRateLimit);
SupportRateLimitSchema.index({ userId: 1 }, { unique: true, name: 'uniq_support_rate_limit_user' });
SupportRateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_support_rate_limit_expiry' });
