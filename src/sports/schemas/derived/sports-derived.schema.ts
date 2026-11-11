import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProjectionMetrics = Record<string, unknown>;

@Schema({ timestamps: true, collection: 'sports_calculated_standings', versionKey: false })
export class SportsCalculatedStandings {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true, index: true })
  competitionId!: string;

  @Prop({ type: String, trim: true, index: true })
  seasonId?: string;

  @Prop({ type: Date, required: true, index: true })
  calculatedAt!: Date;

  @Prop({ type: Number, default: 0, min: 0 })
  sourceFixtureCount!: number;

  @Prop({ type: Object, default: {} })
  metrics!: ProjectionMetrics;

  @Prop({ required: true, trim: true, index: true })
  teamId!: string;

  @Prop({ required: true, type: Number, min: 1, index: true })
  position!: number;

}
export type SportsCalculatedStandingsDocument = HydratedDocument<SportsCalculatedStandings>;
export const SportsCalculatedStandingsSchema = SchemaFactory.createForClass(SportsCalculatedStandings);
SportsCalculatedStandingsSchema.index({ competitionId: 1, seasonId: 1, position: 1 }, { unique: true });

@Schema({ timestamps: true, collection: 'sports_team_form', versionKey: false })
export class SportsTeamForm {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true, index: true })
  competitionId!: string;

  @Prop({ type: String, trim: true, index: true })
  seasonId?: string;

  @Prop({ type: Date, required: true, index: true })
  calculatedAt!: Date;

  @Prop({ type: Number, default: 0, min: 0 })
  sourceFixtureCount!: number;

  @Prop({ type: Object, default: {} })
  metrics!: ProjectionMetrics;

  @Prop({ required: true, trim: true, index: true })
  teamId!: string;

}
export type SportsTeamFormDocument = HydratedDocument<SportsTeamForm>;
export const SportsTeamFormSchema = SchemaFactory.createForClass(SportsTeamForm);
SportsTeamFormSchema.index({ competitionId: 1, seasonId: 1, teamId: 1 }, { unique: true });

@Schema({ timestamps: true, collection: 'sports_team_home_away_records', versionKey: false })
export class SportsTeamHomeAwayRecord {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true, index: true })
  competitionId!: string;

  @Prop({ type: String, trim: true, index: true })
  seasonId?: string;

  @Prop({ type: Date, required: true, index: true })
  calculatedAt!: Date;

  @Prop({ type: Number, default: 0, min: 0 })
  sourceFixtureCount!: number;

  @Prop({ type: Object, default: {} })
  metrics!: ProjectionMetrics;

  @Prop({ required: true, trim: true, index: true })
  teamId!: string;

}
export type SportsTeamHomeAwayRecordDocument = HydratedDocument<SportsTeamHomeAwayRecord>;
export const SportsTeamHomeAwayRecordSchema = SchemaFactory.createForClass(SportsTeamHomeAwayRecord);
SportsTeamHomeAwayRecordSchema.index({ competitionId: 1, seasonId: 1, teamId: 1 }, { unique: true });

@Schema({ timestamps: true, collection: 'sports_team_scoring_records', versionKey: false })
export class SportsTeamScoringRecord {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true, index: true })
  competitionId!: string;

  @Prop({ type: String, trim: true, index: true })
  seasonId?: string;

  @Prop({ type: Date, required: true, index: true })
  calculatedAt!: Date;

  @Prop({ type: Number, default: 0, min: 0 })
  sourceFixtureCount!: number;

  @Prop({ type: Object, default: {} })
  metrics!: ProjectionMetrics;

  @Prop({ required: true, trim: true, index: true })
  teamId!: string;

}
export type SportsTeamScoringRecordDocument = HydratedDocument<SportsTeamScoringRecord>;
export const SportsTeamScoringRecordSchema = SchemaFactory.createForClass(SportsTeamScoringRecord);
SportsTeamScoringRecordSchema.index({ competitionId: 1, seasonId: 1, teamId: 1 }, { unique: true });

@Schema({ timestamps: true, collection: 'sports_head_to_head', versionKey: false })
export class SportsHeadToHead {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true, index: true })
  competitionId!: string;

  @Prop({ type: String, trim: true, index: true })
  seasonId?: string;

  @Prop({ type: Date, required: true, index: true })
  calculatedAt!: Date;

  @Prop({ type: Number, default: 0, min: 0 })
  sourceFixtureCount!: number;

  @Prop({ type: Object, default: {} })
  metrics!: ProjectionMetrics;

  @Prop({ required: true, trim: true, index: true })
  teamAId!: string;

  @Prop({ required: true, trim: true, index: true })
  teamBId!: string;

}
export type SportsHeadToHeadDocument = HydratedDocument<SportsHeadToHead>;
export const SportsHeadToHeadSchema = SchemaFactory.createForClass(SportsHeadToHead);
SportsHeadToHeadSchema.index({ competitionId: 1, teamAId: 1, teamBId: 1 }, { unique: true });

@Schema({ timestamps: true, collection: 'sports_competition_scoring_totals', versionKey: false })
export class SportsCompetitionScoringTotals {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true, index: true })
  competitionId!: string;

  @Prop({ type: String, trim: true, index: true })
  seasonId?: string;

  @Prop({ type: Date, required: true, index: true })
  calculatedAt!: Date;

  @Prop({ type: Number, default: 0, min: 0 })
  sourceFixtureCount!: number;

  @Prop({ type: Object, default: {} })
  metrics!: ProjectionMetrics;

}
export type SportsCompetitionScoringTotalsDocument = HydratedDocument<SportsCompetitionScoringTotals>;
export const SportsCompetitionScoringTotalsSchema = SchemaFactory.createForClass(SportsCompetitionScoringTotals);
SportsCompetitionScoringTotalsSchema.index({ competitionId: 1, seasonId: 1 }, { unique: true });

@Schema({ timestamps: true, collection: 'sports_team_statistics_aggregates', versionKey: false })
export class SportsTeamStatisticsAggregate {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true, index: true })
  competitionId!: string;

  @Prop({ type: String, trim: true, index: true })
  seasonId?: string;

  @Prop({ type: Date, required: true, index: true })
  calculatedAt!: Date;

  @Prop({ type: Number, default: 0, min: 0 })
  sourceFixtureCount!: number;

  @Prop({ type: Object, default: {} })
  metrics!: ProjectionMetrics;

  @Prop({ required: true, trim: true, index: true })
  teamId!: string;

}
export type SportsTeamStatisticsAggregateDocument = HydratedDocument<SportsTeamStatisticsAggregate>;
export const SportsTeamStatisticsAggregateSchema = SchemaFactory.createForClass(SportsTeamStatisticsAggregate);
SportsTeamStatisticsAggregateSchema.index({ competitionId: 1, seasonId: 1, teamId: 1 }, { unique: true });

@Schema({ timestamps: true, collection: 'sports_player_event_totals', versionKey: false })
export class SportsPlayerEventTotals {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true, index: true })
  competitionId!: string;

  @Prop({ type: String, trim: true, index: true })
  seasonId?: string;

  @Prop({ type: Date, required: true, index: true })
  calculatedAt!: Date;

  @Prop({ type: Number, default: 0, min: 0 })
  sourceFixtureCount!: number;

  @Prop({ type: Object, default: {} })
  metrics!: ProjectionMetrics;

  @Prop({ required: true, trim: true, index: true })
  playerId!: string;

}
export type SportsPlayerEventTotalsDocument = HydratedDocument<SportsPlayerEventTotals>;
export const SportsPlayerEventTotalsSchema = SchemaFactory.createForClass(SportsPlayerEventTotals);
SportsPlayerEventTotalsSchema.index({ competitionId: 1, seasonId: 1, playerId: 1 }, { unique: true });
