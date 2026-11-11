import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { SettlementJobStatus } from '../enums/settlement-job-status.enum';

export type SettlementJobDocument = HydratedDocument<SettlementJob>;

@Schema({ timestamps: true, collection: 'settlement_jobs' })
export class SettlementJob {
  @Prop({ required: true, unique: true, trim: true, index: true })
  jobKey!: string;

  @Prop({ required: true, trim: true, index: true })
  eventId!: string;

  @Prop({ required: true, trim: true, lowercase: true, index: true })
  leagueId!: string;

  @Prop({ required: true, trim: true, index: true })
  sourceFingerprint!: string;

  @Prop({ type: Date, required: true, index: true })
  sourceSummaryCollectedAt!: Date;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(SettlementJobStatus),
    index: true,
  })
  status!: SettlementJobStatus;

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  attempts!: number;

  @Prop({ type: Number, required: true, default: 5, min: 1 })
  maximumAttempts!: number;

  @Prop({ type: Number, required: true, default: 4, min: 1, index: true })
  priority!: number;

  @Prop({ type: Date, required: true, default: Date.now, index: true })
  nextRunAt!: Date;

  @Prop({ type: Date, index: true })
  lockedAt?: Date;

  @Prop({ trim: true })
  lockedBy?: string;

  /** Fencing token for one specific processing claim; never returned by admin list queries. */
  @Prop({ type: String, trim: true, select: false })
  claimToken?: string;

  @Prop({ type: Date })
  startedAt?: Date;

  @Prop({ type: Date })
  completedAt?: Date;

  @Prop({ type: Object })
  resultCounts?: Record<string, number>;

  @Prop({ type: [String], default: [] })
  unresolvedReasons!: string[];

  @Prop({ type: String, maxlength: 3000 })
  lastError?: string;

  @Prop({ type: Number, min: 0 })
  lastDurationMs?: number;

  @Prop({ type: String, default: 'SPORTS_DATA_CHANGED' })
  triggerReason!: string;

  /** A target arrived while this event's job was being processed. */
  @Prop({ type: Boolean, default: false, index: true })
  rerunRequested!: boolean;

  @Prop({ type: String })
  rerunTriggerReason?: string;
}

export const SettlementJobSchema = SchemaFactory.createForClass(SettlementJob);
SettlementJobSchema.index({
  status: 1,
  nextRunAt: 1,
  priority: 1,
  createdAt: 1,
});
SettlementJobSchema.index(
  { eventId: 1, sourceFingerprint: 1 },
  { unique: true, name: 'uniq_settlement_event_fingerprint' },
);
SettlementJobSchema.index({ status: 1, lockedAt: 1 });




