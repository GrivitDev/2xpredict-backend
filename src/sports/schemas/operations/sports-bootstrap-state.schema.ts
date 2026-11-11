import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type { SportsBootstrapPhase } from '../../interfaces/sports-queue.interface';

export type SportsBootstrapStateDocument = HydratedDocument<SportsBootstrapState>;

@Schema({ timestamps: true, collection: 'sports_bootstrap_states', versionKey: false })
export class SportsBootstrapState {
  @Prop({ required: true, unique: true, trim: true }) key!: string;
  @Prop({ required: true, trim: true }) runId!: string;
  @Prop({ required: true, type: String, enum: ['RUNNING', 'COMPLETED', 'FAILED'], index: true }) status!: 'RUNNING' | 'COMPLETED' | 'FAILED';
  @Prop({ type: String, enum: ['LEAGUE_DETAILS', 'SEASON_CATALOGUES', 'TEAM_CATALOGUES', 'TEAM_DETAILS', 'MONTHLY_FIXTURE_BOOTSTRAP', 'DAILY_FIXTURE_VALIDATION'] }) currentPhase?: SportsBootstrapPhase;
  @Prop({ type: Date }) startedAt?: Date;
  @Prop({ type: Date }) completedAt?: Date;
  @Prop({ type: String }) lastError?: string;
  @Prop({ type: [{ leagueId: { type: String, required: true }, teamId: { type: String, required: true }, teamReference: { type: String }, seasonYear: { type: Number } }], default: [] }) discoveredTeams!: Array<{ leagueId: string; teamId: string; teamReference?: string; seasonYear?: number }>;
  @Prop({ type: [String], default: [] }) discoveredLeagueIds!: string[];
  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsBootstrapStateSchema = SchemaFactory.createForClass(SportsBootstrapState);
