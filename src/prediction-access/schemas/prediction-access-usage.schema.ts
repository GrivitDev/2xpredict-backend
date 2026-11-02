import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PredictionAccessUsageScope = 'PICK_CENTER' | 'CURATED_PREDICTION';
export type PredictionAccessUsageDocument =
  HydratedDocument<PredictionAccessUsage>;

/** Minimal per-user grant ledger that prevents refresh/detail routes bypassing daily limits. */
@Schema({ timestamps: true, collection: 'prediction_access_daily_usage' })
export class PredictionAccessUsage {
  @Prop({ required: true, trim: true })
  userId!: string;

  /** Calendar day in Africa/Lagos, YYYY-MM-DD. */
  @Prop({ required: true, trim: true })
  dateKey!: string;

  @Prop({
    required: true,
    type: String,
    enum: ['PICK_CENTER', 'CURATED_PREDICTION'],
  })
  scope!: PredictionAccessUsageScope;

  /** Selection keys for Pick Center or CuratedPrediction Mongo IDs. */
  @Prop({ required: true, type: [String], default: [] })
  recordKeys!: string[];

  /** TTL cleanup; access grants are not required after their allocation day. */
  @Prop({ required: true, type: Date })
  expiresAt!: Date;
}

export const PredictionAccessUsageSchema = SchemaFactory.createForClass(
  PredictionAccessUsage,
);
PredictionAccessUsageSchema.index(
  { userId: 1, dateKey: 1, scope: 1 },
  { unique: true },
);
PredictionAccessUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
