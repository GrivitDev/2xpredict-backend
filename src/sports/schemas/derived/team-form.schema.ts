import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

import type { SportsTeamFormRecord } from '../../interfaces/sports-derived-data.interface';

export type SportsTeamFormDocument = HydratedDocument<SportsTeamForm>;

@Schema({
  timestamps: true,
  collection: 'sports_team_forms',
  versionKey: false,
})
export class SportsTeamForm implements SportsTeamFormRecord {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true, index: true })
  teamId!: string;

  @Prop({ trim: true, index: true })
  competitionId?: string;

  @Prop({ trim: true, index: true })
  seasonId?: string;

  @Prop({ required: true, type: Number, min: 1 })
  lastN!: number;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  results!: SportsTeamFormRecord['results'];

  @Prop({ required: true, type: Date, index: true })
  computedAt!: Date;

  @Prop({ required: true, type: Number, min: 0, index: true })
  sourceRevision!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsTeamFormSchema =
  SchemaFactory.createForClass(SportsTeamForm);
SportsTeamFormSchema.index(
  { teamId: 1, competitionId: 1, seasonId: 1, lastN: 1 },
  { unique: true },
);
SportsTeamFormSchema.index({ competitionId: 1, seasonId: 1, teamId: 1 });
