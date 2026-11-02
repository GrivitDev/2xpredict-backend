import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { BonusType } from '../enums/bonus-type.enum';
import { BonusBulkJobStatus } from '../enums/bonus-bulk-job-status.enum';

export type BonusBulkGrantJobDocument = HydratedDocument<BonusBulkGrantJob>;

@Schema({ timestamps: true, collection: 'bonus_bulk_grant_jobs' })
export class BonusBulkGrantJob {
  @Prop({ type: String, required: true, enum: Object.values(BonusType), index: true })
  type!: BonusType;

  @Prop({ type: String, required: true, enum: Object.values(BonusBulkJobStatus), default: BonusBulkJobStatus.QUEUED, index: true })
  status!: BonusBulkJobStatus;

  @Prop({ type: String, required: true, trim: true, index: true })
  grantedBy!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 300 })
  reason!: string;

  @Prop({ type: Number, default: undefined, min: 1 })
  points?: number;

  @Prop({ type: String, enum: ['regular', 'vip', 'premium'], default: undefined })
  plan?: 'regular' | 'vip' | 'premium';

  @Prop({ type: Number, default: undefined, min: 1, max: 365 })
  durationDays?: number;

  @Prop({ type: Date, default: Date.now })
  startsAt!: Date;

  @Prop({ type: Boolean, default: false })
  scheduledStart!: boolean;

  @Prop({ type: Date, default: null })
  expiresAt?: Date | null;

  @Prop({ type: String, required: true, trim: true, maxlength: 120, unique: true })
  idempotencyKey!: string;

  /** Upper cursor bound snapshots the eligible population at job creation. */
  @Prop({ type: String, default: null })
  throughUserId?: string | null;

  /** Explicit recipients are capped by DTO validation to keep job documents bounded. */
  @Prop({ type: [String], default: [] })
  recipientIds!: string[];

  @Prop({ type: String, enum: ['free', 'regular', 'vip', 'premium'], default: null })
  recipientPlan?: 'free' | 'regular' | 'vip' | 'premium' | null;

  @Prop({ type: Number, default: 0, min: 0 })
  recipientCursor!: number;

  @Prop({ type: String, default: null })
  lastUserId?: string | null;

  @Prop({ type: Number, default: 0, min: 0 })
  totalUsers!: number;

  @Prop({ type: Number, default: 0, min: 0 })
  processedUsers!: number;

  @Prop({ type: Number, default: 0, min: 0 })
  grantedCount!: number;

  @Prop({ type: Number, default: 0, min: 0 })
  failedCount!: number;

  @Prop({ type: [String], default: [] })
  recentErrors!: string[];

  @Prop({ type: Date, default: null })
  startedAt?: Date | null;

  @Prop({ type: Date, default: null })
  completedAt?: Date | null;
}

export const BonusBulkGrantJobSchema = SchemaFactory.createForClass(BonusBulkGrantJob);
BonusBulkGrantJobSchema.index({ status: 1, createdAt: 1 });
