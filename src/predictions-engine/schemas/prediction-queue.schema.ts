import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { PredictionQueueStatus } from '../enums/prediction-queue-status.enum';

@Schema({ timestamps: true, collection: 'predictions_engine_queue' })
export class PredictionQueue {
  @Prop({ required: true, unique: true, trim: true, index: true })
  eventId!: string;

  @Prop({ required: true, trim: true, lowercase: true, index: true })
  leagueId!: string;

  @Prop({ required: true, type: Date, index: true })
  fixtureDate!: Date;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(PredictionQueueStatus),
    default: PredictionQueueStatus.PENDING,
    index: true,
  })
  status!: PredictionQueueStatus;

  @Prop({ type: Number, default: 0, index: true })
  priority!: number;

  @Prop({ type: Number, default: 0, min: 0 })
  attempts!: number;

  @Prop({ required: true, type: Date, default: Date.now, index: true })
  availableAt!: Date;

  @Prop({ type: Date })
  lockedAt?: Date;

  @Prop({ type: Date })
  completedAt?: Date;

  @Prop({ type: Date })
  summaryCollectedAt?: Date;

  @Prop({ type: Date })
  lastProcessedSummaryAt?: Date;

  @Prop({ type: Date })
  oddsUpdatedAt?: Date;

  @Prop({ type: Date })
  lastProcessedOddsAt?: Date;

  @Prop({ type: String, trim: true })
  modelVersion?: string;

  @Prop({ type: String, trim: true })
  scoreSnapshot?: string;

  @Prop({ type: String, trim: true })
  lastProcessedScoreSnapshot?: string;

  @Prop({ type: String, default: 'INITIAL' })
  reason!: string;

  @Prop({ type: String })
  errorMessage?: string;

  @Prop({ type: Number, min: 0 })
  processingDurationMs?: number;

  @Prop({ type: Number, default: 0 })
  refreshCount!: number;
}
export type PredictionQueueDocument = HydratedDocument<PredictionQueue>;
export const PredictionQueueSchema =
  SchemaFactory.createForClass(PredictionQueue);
PredictionQueueSchema.index({
  status: 1,
  availableAt: 1,
  priority: -1,
  fixtureDate: 1,
});
PredictionQueueSchema.index({ status: 1, fixtureDate: 1 });


