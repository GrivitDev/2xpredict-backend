import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type FixtureOddsHistoryDocument = HydratedDocument<FixtureOddsHistory>;

/**
 * Append-only snapshot of a Grivit quote superseded by a later valid price set
 * or removed because its fixture became ineligible. The original quote is
 * retained as a Mixed snapshot so future schema additions are not discarded.
 */
@Schema({ timestamps: false, collection: 'sports_fixture_odds_history', versionKey: false })
export class FixtureOddsHistory {
  @Prop({ required: true, trim: true })
  snapshotId!: string;

  @Prop({ required: true, trim: true, index: true })
  eventId!: string;

  @Prop({ required: true, trim: true, index: true })
  marketId!: string;

  @Prop({ required: true, trim: true })
  selectionKey!: string;

  @Prop({ type: Number })
  line?: number;

  @Prop({ required: true, type: Date, index: true })
  calculatedAt!: Date;

  @Prop({ required: true, type: Date, default: Date.now })
  archivedAt!: Date;

  /** Copied from the source quote so history follows fixture retention policy. */
  @Prop({ type: Date, index: true })
  expiresAt?: Date;

  @Prop({ type: Object, required: true })
  snapshot!: Record<string, unknown>;
}

export const FixtureOddsHistorySchema = SchemaFactory.createForClass(FixtureOddsHistory);
FixtureOddsHistorySchema.index(
  { snapshotId: 1 },
  { unique: true, name: 'uniq_fixture_odds_history_snapshot' },
);
FixtureOddsHistorySchema.index(
  { eventId: 1, marketId: 1, selectionKey: 1, calculatedAt: -1 },
  { name: 'fixture_odds_history_lookup' },
);
FixtureOddsHistorySchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_fixture_odds_history_expiry' },
);
