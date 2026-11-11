import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type { SportsTeamScoringRecord } from '../../interfaces/sports-derived-data.interface';

export type SportsTeamScoringRecordDocument = HydratedDocument<SportsTeamScoringRecordModel>;

@Schema({ timestamps: true, collection: 'sports_team_scoring_records', versionKey: false })
export class SportsTeamScoringRecordModel implements SportsTeamScoringRecord {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true, index: true })
  teamId!: string;

  @Prop({ required: true, trim: true, index: true })
  competitionId!: string;

  @Prop({ required: true, trim: true, index: true })
  seasonId!: string;

  @Prop({ required: true, type: Number, min: 0 })
  fixturesPlayed!: number;

  @Prop({ required: true, type: Number, min: 0 })
  goalsFor!: number;

  @Prop({ required: true, type: Number, min: 0 })
  goalsAgainst!: number;

  @Prop({ required: true, type: Number, min: 0 })
  averageGoalsFor!: number;

  @Prop({ required: true, type: Number, min: 0 })
  averageGoalsAgainst!: number;

  @Prop({ required: true, type: Number, min: 0 })
  cleanSheets!: number;

  @Prop({ required: true, type: Number, min: 0 })
  failedToScore!: number;

  @Prop({ required: true, type: Date, index: true })
  computedAt!: Date;

  @Prop({ required: true, type: Number, min: 0, index: true })
  sourceRevision!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsTeamScoringRecordSchema = SchemaFactory.createForClass(SportsTeamScoringRecordModel);
SportsTeamScoringRecordSchema.index({ teamId: 1, competitionId: 1, seasonId: 1 }, { unique: true });

