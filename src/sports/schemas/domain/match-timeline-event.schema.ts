import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type { SportsMatchTimelineEventRecord } from '../../interfaces/sports-domain.interface';
import { SportsSourceMetadataSchema, SportsTimelineScoreSchema } from './embedded.schema';

export type SportsMatchTimelineEventDocument = HydratedDocument<SportsMatchTimelineEvent>;

@Schema({ timestamps: true, collection: 'sports_match_timeline_events', versionKey: false })
export class SportsMatchTimelineEvent implements Omit<SportsMatchTimelineEventRecord, 'createdAt' | 'updatedAt'> {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ trim: true, index: true })
  espnPlayId?: string;

  @Prop({ required: true, trim: true })
  fixtureId!: string;

  @Prop({ required: true, type: Number, min: 0 })
  sequence!: number;

  @Prop({ type: Number, min: 0 })
  period?: number;

  @Prop({ trim: true })
  clock?: string;

  @Prop({ type: Number, min: 0 })
  clockSeconds?: number;

  @Prop({ trim: true })
  addedClock?: string;

  @Prop({ required: true, trim: true, index: true })
  type!: string;

  @Prop({ type: String, trim: true })
  typeId?: string;

  @Prop({ type: String, trim: true })
  typeKey?: string;

  @Prop({ type: String })
  description?: string;

  @Prop({ trim: true, index: true })
  teamId?: string;

  @Prop({ trim: true, index: true })
  athleteId?: string;

  @Prop({ trim: true })
  relatedAthleteId?: string;

  @Prop({ type: [Object], default: [] })
  involvedAthletes?: SportsMatchTimelineEventRecord['involvedAthletes'];

  @Prop({ type: SportsTimelineScoreSchema })
  scoreAfter?: SportsMatchTimelineEventRecord['scoreAfter'];

  @Prop({ type: Number, min: 0 })
  homeScore?: number;

  @Prop({ type: Number, min: 0 })
  awayScore?: number;

  @Prop({ type: Number })
  scoreValue?: number;

  @Prop({ type: Boolean })
  scoringPlay?: boolean;

  @Prop({ type: Boolean })
  shootingPlay?: boolean;

  @Prop({ type: Boolean })
  priority?: boolean;

  @Prop({ type: Boolean })
  valid?: boolean;

  @Prop({ type: Boolean })
  substitution?: boolean;

  @Prop({ type: Boolean })
  redCard?: boolean;

  @Prop({ type: Boolean })
  yellowCard?: boolean;

  @Prop({ type: Boolean })
  penaltyKick?: boolean;

  @Prop({ type: Boolean })
  ownGoal?: boolean;

  @Prop({ type: Boolean })
  shootout?: boolean;

  @Prop({ type: Boolean })
  hasVideoTagging?: boolean;

  @Prop({ type: String })
  sourceId?: string;

  @Prop({ type: String })
  sourceDescription?: string;

  @Prop({ type: Number })
  statYardage?: number;

  @Prop({ type: Number })
  coordinateX?: number;

  @Prop({ type: Number })
  coordinateY?: number;

  @Prop({ type: Number })
  fieldPositionX?: number;

  @Prop({ type: Number })
  fieldPositionY?: number;

  @Prop({ type: Number })
  fieldPosition2X?: number;

  @Prop({ type: Number })
  fieldPosition2Y?: number;

  @Prop({ type: String })
  periodDisplayValue?: string;

  @Prop({ type: String })
  wallclock?: string;

  @Prop({ type: String })
  shortText?: string;

  @Prop({ type: Date })
  modifiedAt?: Date;

  @Prop({ type: Date })
  modifiedDate?: Date;

  @Prop({ type: String })
  probabilityRef?: string;

  @Prop({ type: Object })
  rawPayload?: Record<string, unknown>;

  @Prop({ required: true, type: SportsSourceMetadataSchema })
  source!: SportsMatchTimelineEventRecord['source'];

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsMatchTimelineEventSchema = SchemaFactory.createForClass(SportsMatchTimelineEvent);
SportsMatchTimelineEventSchema.index({ fixtureId: 1, sequence: 1 }, { unique: true });
SportsMatchTimelineEventSchema.index({ fixtureId: 1, period: 1, sequence: 1 });
SportsMatchTimelineEventSchema.index({ athleteId: 1, type: 1, createdAt: -1 });
SportsMatchTimelineEventSchema.index({ espnPlayId: 1, fixtureId: 1 }, { unique: true, sparse: true });


