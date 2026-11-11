import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type { SportsPlayerEventTotalsRecord } from '../../interfaces/sports-derived-data.interface';

export type SportsPlayerEventTotalsDocument = HydratedDocument<SportsPlayerEventTotals>;

@Schema({ timestamps: true, collection: 'sports_player_event_totals', versionKey: false })
export class SportsPlayerEventTotals implements SportsPlayerEventTotalsRecord {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true, index: true })
  athleteId!: string;

  @Prop({ trim: true, index: true })
  competitionId?: string;

  @Prop({ trim: true, index: true })
  seasonId?: string;

  @Prop({ required: true, type: Number, min: 0 })
  fixturesWithEvents!: number;

  @Prop({ required: true, type: Number, min: 0, default: 0 })
  goals!: number;

  @Prop({ required: true, type: Number, min: 0, default: 0 })
  assists!: number;

  @Prop({ required: true, type: Number, min: 0, default: 0 })
  ownGoals!: number;

  @Prop({ required: true, type: Number, min: 0, default: 0 })
  yellowCards!: number;

  @Prop({ required: true, type: Number, min: 0, default: 0 })
  redCards!: number;

  @Prop({ required: true, type: Number, min: 0, default: 0 })
  penaltiesScored!: number;

  @Prop({ required: true, type: Number, min: 0, default: 0 })
  penaltiesMissed!: number;

  @Prop({ required: true, type: Date, index: true })
  computedAt!: Date;

  @Prop({ required: true, type: Number, min: 0, index: true })
  sourceRevision!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsPlayerEventTotalsSchema = SchemaFactory.createForClass(SportsPlayerEventTotals);
SportsPlayerEventTotalsSchema.index({ athleteId: 1, competitionId: 1, seasonId: 1 }, { unique: true });

