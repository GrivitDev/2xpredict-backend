import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type { SportsTeamHomeAwayRecord } from '../../interfaces/sports-derived-data.interface';

@Schema({ _id: false })
export class SportsTeamHomeAwaySplitEmbedded {
  @Prop({ required: true, type: Number, min: 0 })
  played!: number;

  @Prop({ required: true, type: Number, min: 0 })
  won!: number;

  @Prop({ required: true, type: Number, min: 0 })
  drawn!: number;

  @Prop({ required: true, type: Number, min: 0 })
  lost!: number;

  @Prop({ required: true, type: Number, min: 0 })
  goalsFor!: number;

  @Prop({ required: true, type: Number, min: 0 })
  goalsAgainst!: number;
}
export const SportsTeamHomeAwaySplitSchema = SchemaFactory.createForClass(SportsTeamHomeAwaySplitEmbedded);

export type SportsTeamHomeAwayRecordDocument = HydratedDocument<SportsTeamHomeAwayRecordModel>;

@Schema({ timestamps: true, collection: 'sports_team_home_away_records', versionKey: false })
export class SportsTeamHomeAwayRecordModel implements SportsTeamHomeAwayRecord {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true, index: true })
  teamId!: string;

  @Prop({ required: true, trim: true, index: true })
  competitionId!: string;

  @Prop({ required: true, trim: true, index: true })
  seasonId!: string;

  @Prop({ required: true, type: SportsTeamHomeAwaySplitSchema })
  home!: SportsTeamHomeAwayRecord['home'];

  @Prop({ required: true, type: SportsTeamHomeAwaySplitSchema })
  away!: SportsTeamHomeAwayRecord['away'];

  @Prop({ required: true, type: Date, index: true })
  computedAt!: Date;

  @Prop({ required: true, type: Number, min: 0, index: true })
  sourceRevision!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsTeamHomeAwayRecordSchema = SchemaFactory.createForClass(SportsTeamHomeAwayRecordModel);
SportsTeamHomeAwayRecordSchema.index({ teamId: 1, competitionId: 1, seasonId: 1 }, { unique: true });

