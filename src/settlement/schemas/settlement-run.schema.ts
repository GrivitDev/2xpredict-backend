import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { SettlementJobStatus } from '../enums/settlement-job-status.enum';

export type SettlementRunDocument = HydratedDocument<SettlementRun>;

@Schema({ timestamps: true, collection: 'settlement_runs' })
export class SettlementRun {
  @Prop({ required: true, trim: true, index: true })
  eventId!: string;

  @Prop({ required: true, trim: true, index: true })
  leagueId!: string;

  @Prop({ required: true, trim: true })
  sourceFingerprint!: string;

  @Prop({ type: Date, required: true })
  sourceSummaryCollectedAt!: Date;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(SettlementJobStatus),
    index: true,
  })
  status!: SettlementJobStatus;

  @Prop({ type: Object, required: true })
  counts!: Record<string, number>;

  @Prop({ type: [String], default: [] })
  unresolvedReasons!: string[];

  @Prop({ type: Date })
  startedAt?: Date;

  @Prop({ type: Date })
  completedAt?: Date;

  @Prop({ type: Number, min: 0 })
  durationMs?: number;
}

export const SettlementRunSchema = SchemaFactory.createForClass(SettlementRun);
SettlementRunSchema.index(
  { eventId: 1, sourceFingerprint: 1 },
  { unique: true, name: 'uniq_settlement_run_event_fingerprint' },
);
SettlementRunSchema.index({ status: 1, completedAt: -1 });
SettlementRunSchema.index({ eventId: 1, createdAt: -1 });

