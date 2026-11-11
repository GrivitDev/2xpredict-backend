import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

import type { SportsTeamStatisticsAggregateRecord } from '../../interfaces/sports-derived-data.interface';

export type SportsTeamStatisticsAggregateDocument =
  HydratedDocument<SportsTeamStatisticsAggregate>;

@Schema({
  timestamps: true,
  collection: 'sports_team_statistics_aggregates',
  versionKey: false,
})
export class SportsTeamStatisticsAggregate implements SportsTeamStatisticsAggregateRecord {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true, index: true })
  teamId!: string;

  @Prop({ required: true, trim: true, index: true })
  competitionId!: string;

  @Prop({ required: true, trim: true, index: true })
  seasonId!: string;

  @Prop({ required: true, type: Number, min: 0 })
  fixturesWithStatistics!: number;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  statistics!: SportsTeamStatisticsAggregateRecord['statistics'];

  @Prop({ required: true, type: Date, index: true })
  computedAt!: Date;

  @Prop({ required: true, type: Number, min: 0, index: true })
  sourceRevision!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsTeamStatisticsAggregateSchema = SchemaFactory.createForClass(
  SportsTeamStatisticsAggregate,
);
SportsTeamStatisticsAggregateSchema.index(
  { teamId: 1, competitionId: 1, seasonId: 1 },
  { unique: true },
);
