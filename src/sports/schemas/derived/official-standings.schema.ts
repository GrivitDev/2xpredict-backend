import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

import type {
  SportsOfficialStandingsGroup,
} from '../../interfaces/sports-match-facts.interface';

export type SportsOfficialStandingsDocument = HydratedDocument<SportsOfficialStandings>;
export type SportsOfficialStandingsStatus = 'AVAILABLE' | 'MISSING';

/** Latest complete official ESPN standings for one competition-season. */
@Schema({
  timestamps: true,
  collection: 'sports_official_standings',
  versionKey: false,
})
export class SportsOfficialStandings {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true, index: true })
  competitionId!: string;

  @Prop({ required: true, trim: true, index: true })
  seasonId!: string;

  @Prop({ required: true, type: String, enum: ['ESPN'], default: 'ESPN' })
  provider!: 'ESPN';

  @Prop({ required: true, type: String, enum: ['AVAILABLE', 'MISSING'], default: 'MISSING', index: true })
  status!: SportsOfficialStandingsStatus;

  @Prop({ type: String })
  endpoint?: string;

  @Prop({ type: String })
  sourcePayloadHash?: string;

  /** Informational only: Summary revisions are scoped to individual fixtures. */
  @Prop({ type: Number, min: 0 })
  sourceRevision?: number;

  @Prop({ type: Date, index: true })
  sourceCollectedAt?: Date;

  @Prop({ type: Date, index: true })
  lastSuccessfulAt?: Date;

  @Prop({ type: String })
  header?: string;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  groups!: SportsOfficialStandingsGroup[];

  @Prop({ type: Number, min: 0, default: 0 })
  entryCount!: number;

  @Prop({ type: Boolean, default: false, index: true })
  isComplete!: boolean;

  @Prop({ type: [String], default: [] })
  diagnostics!: string[];

  /** Latest attempt metadata; never replaces the last valid standings snapshot. */
  @Prop({ type: MongooseSchema.Types.Mixed })
  lastAttempt?: Record<string, unknown>;

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsOfficialStandingsSchema =
  SchemaFactory.createForClass(SportsOfficialStandings);

SportsOfficialStandingsSchema.index(
  { competitionId: 1, seasonId: 1 },
  { unique: true },
);
SportsOfficialStandingsSchema.index({ competitionId: 1, seasonId: 1, sourceCollectedAt: -1 });
