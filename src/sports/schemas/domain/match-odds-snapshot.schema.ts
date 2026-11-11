import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type { SportsMatchOddsSnapshotRecord } from '../../interfaces/sports-domain.interface';
import { SportsOddsBookmakerSchema, SportsSourceMetadataSchema } from './embedded.schema';

export type SportsMatchOddsSnapshotDocument = HydratedDocument<SportsMatchOddsSnapshot>;

@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'sports_match_odds_snapshots', versionKey: false })
export class SportsMatchOddsSnapshot implements Omit<SportsMatchOddsSnapshotRecord, 'createdAt'> {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true })
  fixtureId!: string;

  @Prop({ required: true, type: String, enum: ['ESPN', 'ESPN_SUMMARY', 'ODDS_API'], index: true })
  provider!: SportsMatchOddsSnapshotRecord['provider'];

  @Prop({ required: true, type: Boolean, default: false, index: true })
  isFallback!: boolean;

  @Prop({ required: true, type: Date, index: true })
  collectedAt!: Date;

  @Prop({ type: [SportsOddsBookmakerSchema], default: [] })
  bookmakers!: SportsMatchOddsSnapshotRecord['bookmakers'];

  @Prop({ type: Object })
  rawPayload?: Record<string, unknown>;

  @Prop({ required: true, type: SportsSourceMetadataSchema })
  source!: SportsMatchOddsSnapshotRecord['source'];

  createdAt!: Date;
}

export const SportsMatchOddsSnapshotSchema = SchemaFactory.createForClass(SportsMatchOddsSnapshot);
SportsMatchOddsSnapshotSchema.index({ fixtureId: 1, collectedAt: -1 });
SportsMatchOddsSnapshotSchema.index({ fixtureId: 1, provider: 1, collectedAt: -1 });
SportsMatchOddsSnapshotSchema.index({ fixtureId: 1, isFallback: 1, collectedAt: -1 });
