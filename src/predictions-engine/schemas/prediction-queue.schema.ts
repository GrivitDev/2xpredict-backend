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

  /** Token proving ownership of the currently active processing lease. */
  @Prop({ type: String, trim: true })
  lockToken?: string;

  @Prop({ type: Date })
  completedAt?: Date;

  /** Same expiry deadline as the retained Sports fixture. */
  @Prop({ type: Date })
  retentionExpiresAt?: Date;

  @Prop({ type: Date })
  summaryCollectedAt?: Date;

  @Prop({ type: Date })
  lastProcessedSummaryAt?: Date;

  /** Latest normalized Sports fixture revision observed by queue reconciliation. */
  @Prop({ type: Number, min: 0, default: 0 })
  fixtureSourceRevision?: number;

  /** Sports fixture revision consumed by the last successfully completed prediction run. */
  @Prop({ type: Number, min: 0 })
  lastProcessedFixtureSourceRevision?: number;

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

  /** A source/Odds update arrived while this fixture was being calculated. */
  @Prop({ type: Date, index: true })
  refreshRequestedAt?: Date;

  @Prop({ type: String, trim: true })
  refreshRequestedReason?: string;

  @Prop({ type: String, trim: true })
  sourceChangeEventId?: string;
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
PredictionQueueSchema.index(
  { retentionExpiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_prediction_queue_fixture_retention' },
);



