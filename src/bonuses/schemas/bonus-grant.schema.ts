import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { BonusStatus } from '../enums/bonus-status.enum';
import { BonusType } from '../enums/bonus-type.enum';

export type BonusGrantDocument = HydratedDocument<BonusGrant>;

@Schema({ timestamps: true, collection: 'bonus_grants' })
export class BonusGrant {
  @Prop({ required: true, trim: true, index: true })
  userId!: string;

  @Prop({ required: true, trim: true, index: true })
  grantedBy!: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(BonusType),
    index: true,
  })
  type!: BonusType;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(BonusStatus),
    default: BonusStatus.PENDING,
    index: true,
  })
  status!: BonusStatus;

  @Prop({ required: true, trim: true, maxlength: 300 })
  reason!: string;

  /** Points are non-cash, non-withdrawable Bet Lab virtual points. */
  @Prop({ type: Number, min: 1, default: undefined })
  points?: number;

  @Prop({
    type: String,
    enum: ['regular', 'vip', 'premium'],
    default: undefined,
  })
  plan?: 'regular' | 'vip' | 'premium';

  @Prop({ type: Number, min: 1, max: 365, default: undefined })
  durationDays?: number;

  @Prop({ type: Date, required: true, default: Date.now, index: true })
  startsAt!: Date;

  @Prop({ type: Date, default: null, index: true })
  expiresAt?: Date | null;

  /** Client-generated key prevents duplicate grants when an admin request retries. */
  @Prop({ required: true, trim: true, maxlength: 120 })
  idempotencyKey!: string;

  @Prop({ type: Date, default: null })
  revokedAt?: Date | null;

  @Prop({ type: String, default: undefined })
  revokedBy?: string;

  @Prop({ type: String, default: undefined, maxlength: 300 })
  revocationReason?: string;
}

export const BonusGrantSchema = SchemaFactory.createForClass(BonusGrant);
BonusGrantSchema.index({ idempotencyKey: 1 }, { unique: true });
BonusGrantSchema.index({ userId: 1, createdAt: -1 });
BonusGrantSchema.index({
  userId: 1,
  type: 1,
  status: 1,
  plan: 1,
  startsAt: 1,
  expiresAt: 1,
});
BonusGrantSchema.index({ type: 1, status: 1, expiresAt: 1 });
