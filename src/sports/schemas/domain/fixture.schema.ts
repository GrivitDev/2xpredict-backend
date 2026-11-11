import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type { SportsFixtureRecord } from '../../interfaces/sports-domain.interface';
import {
  SportsFixtureCompetitorSchema,
  SportsFixturePeriodScoreSchema,
  SportsFixtureStatusSchema,
  SportsSourceMetadataSchema,
} from './embedded.schema';

export type SportsFixtureDocument = HydratedDocument<SportsFixture>;

@Schema({ timestamps: true, collection: 'sports_fixtures', versionKey: false })
export class SportsFixture implements Omit<SportsFixtureRecord, 'createdAt' | 'updatedAt'> {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, unique: true, trim: true, index: true })
  espnEventId!: string;

  @Prop({ trim: true })
  espnCompetitionId?: string;

  @Prop({ required: true, trim: true, index: true })
  competitionId!: string;

  @Prop({ trim: true, index: true })
  seasonId?: string;

  @Prop({ type: Number, index: true })
  seasonYear?: number;

  @Prop({ trim: true })
  name?: string;

  @Prop({ trim: true })
  shortName?: string;

  @Prop({ required: true, type: Date, index: true })
  kickoffAt!: Date;

  @Prop({ required: true, type: SportsFixtureStatusSchema })
  status!: SportsFixtureRecord['status'];

  @Prop({
    required: true,
    type: [SportsFixtureCompetitorSchema],
    validate: {
      validator: (value: unknown[]) => Array.isArray(value) && value.length === 2,
      message: 'A football fixture must contain exactly two competitors.',
    },
  })
  competitors!: SportsFixtureRecord['competitors'];

  @Prop({ type: [SportsFixturePeriodScoreSchema], default: [] })
  periodScores!: SportsFixtureRecord['periodScores'];

  @Prop({ trim: true, index: true })
  venueId?: string;

  @Prop({ type: Number, min: 0 })
  attendance?: number;

  @Prop({ type: Boolean, default: false })
  neutralSite?: boolean;

  @Prop({ type: Date, index: true })
  completedAt?: Date;

  /** Season-relative expiry: fixture kickoff + season duration + retention grace. */
  @Prop({ type: Date, index: true })
  retentionExpiresAt?: Date;

  @Prop({ type: Number, min: 1 })
  retentionDurationMonths?: number;

  @Prop({ type: Object })
  rawPayload?: Record<string, unknown>;

  @Prop({ required: true, type: SportsSourceMetadataSchema })
  source!: SportsFixtureRecord['source'];

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsFixtureSchema = SchemaFactory.createForClass(SportsFixture);
SportsFixtureSchema.index({ competitionId: 1, seasonId: 1, kickoffAt: 1 });
SportsFixtureSchema.index({ 'status.state': 1, kickoffAt: 1 });
SportsFixtureSchema.index({ 'competitors.teamId': 1, kickoffAt: -1 });
SportsFixtureSchema.index({ competitionId: 1, 'status.state': 1, kickoffAt: 1 });
SportsFixtureSchema.index({ completedAt: -1, competitionId: 1, seasonId: 1 });
SportsFixtureSchema.index({ retentionExpiresAt: 1, kickoffAt: 1 });
// Supports stable ascending/descending keyset pagination across full-season fixture scans.
SportsFixtureSchema.index({ kickoffAt: 1, id: 1 }, { name: 'fixture_kickoff_id_keyset' });



