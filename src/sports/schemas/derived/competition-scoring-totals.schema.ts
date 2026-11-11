import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type { SportsCompetitionScoringTotalsRecord } from '../../interfaces/sports-derived-data.interface';

export type SportsCompetitionScoringTotalsDocument = HydratedDocument<SportsCompetitionScoringTotals>;

@Schema({ timestamps: true, collection: 'sports_competition_scoring_totals', versionKey: false })
export class SportsCompetitionScoringTotals implements SportsCompetitionScoringTotalsRecord {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true, index: true })
  competitionId!: string;

  @Prop({ required: true, trim: true, index: true })
  seasonId!: string;

  @Prop({ required: true, type: Number, min: 0 })
  fixturesPlayed!: number;

  @Prop({ required: true, type: Number, min: 0 })
  totalGoals!: number;

  @Prop({ required: true, type: Number, min: 0 })
  homeGoals!: number;

  @Prop({ required: true, type: Number, min: 0 })
  awayGoals!: number;

  @Prop({ required: true, type: Number, min: 0 })
  averageGoalsPerFixture!: number;

  @Prop({ required: true, type: Date, index: true })
  computedAt!: Date;

  @Prop({ required: true, type: Number, min: 0, index: true })
  sourceRevision!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsCompetitionScoringTotalsSchema = SchemaFactory.createForClass(SportsCompetitionScoringTotals);
SportsCompetitionScoringTotalsSchema.index({ competitionId: 1, seasonId: 1 }, { unique: true });

