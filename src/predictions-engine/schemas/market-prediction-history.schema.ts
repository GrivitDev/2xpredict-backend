import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MarketPredictionHistoryDocument = HydratedDocument<MarketPredictionHistory>;

/**
 * Append-only copy of a market prediction before a valid recalculation replaces
 * it. Keeping the complete source document preserves selection-level evidence,
 * prices, confidence, probabilities and settlement metadata for later analysis.
 */
@Schema({ timestamps: false, collection: 'predictions_engine_market_history', versionKey: false })
export class MarketPredictionHistory {
  @Prop({ required: true, trim: true })
  snapshotId!: string;

  @Prop({ required: true, trim: true, index: true })
  eventId!: string;

  @Prop({ required: true, trim: true, index: true })
  marketKey!: string;

  @Prop({ required: true, trim: true, index: true })
  modelVersion!: string;

  @Prop({ type: Number, min: 0, default: 0, index: true })
  fixtureSourceRevision!: number;

  @Prop({ type: String, trim: true, index: true })
  sourceRevisionFingerprint?: string;

  @Prop({ required: true, type: Date, index: true })
  calculatedAt!: Date;

  @Prop({ required: true, type: Date, default: Date.now })
  archivedAt!: Date;

  /** Copied from the prediction so history follows the fixture retention policy. */
  @Prop({ type: Date, index: true })
  retentionExpiresAt?: Date | null;

  @Prop({ type: Object, required: true })
  snapshot!: Record<string, unknown>;
}

export const MarketPredictionHistorySchema = SchemaFactory.createForClass(MarketPredictionHistory);
MarketPredictionHistorySchema.index(
  { snapshotId: 1 },
  { unique: true, name: 'uniq_market_prediction_history_snapshot' },
);
MarketPredictionHistorySchema.index(
  { eventId: 1, marketKey: 1, calculatedAt: -1 },
  { name: 'market_prediction_history_lookup' },
);
MarketPredictionHistorySchema.index(
  { retentionExpiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_market_prediction_history_expiry' },
);
