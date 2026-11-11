import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type { SportsMatchFactsRecord } from '../../interfaces/sports-match-facts.interface';

export type SportsMatchFactsDocument = HydratedDocument<SportsMatchFacts>;

/** Normalized, provider-independent details extracted from the latest ESPN Summary. */
@Schema({ timestamps: true, collection: 'sports_match_facts', versionKey: false })
export class SportsMatchFacts implements SportsMatchFactsRecord {
  @Prop({ required: true, unique: true, trim: true })
  fixtureId!: string;

  @Prop({ required: true, unique: true, trim: true, index: true })
  espnEventId!: string;

  @Prop({ required: true, trim: true, index: true })
  competitionId!: string;

  @Prop({ trim: true, index: true })
  seasonId?: string;

  @Prop({ type: Number, index: true })
  seasonYear?: number;

  @Prop({ required: true, trim: true })
  provider!: 'ESPN';

  @Prop({ required: true, trim: true })
  endpoint!: string;

  @Prop({ required: true, trim: true, index: true })
  sourcePayloadHash!: string;

  @Prop({ required: true, type: Number, min: 1 })
  sourceRevision!: number;

  @Prop({ required: true, type: Date, index: true })
  sourceCollectedAt!: Date;

  @Prop({ required: true, trim: true })
  normalizationVersion!: string;

  @Prop({ required: true, trim: true, index: true })
  normalizationHash!: string;

  @Prop({ required: true, type: Number, min: 1 })
  revision!: number;

  @Prop({ required: true, type: Date, index: true })
  normalizedAt!: Date;

  @Prop({ required: true, type: Object })
  matchResult!: SportsMatchFactsRecord['matchResult'];

  @Prop({ type: [Object], default: [] })
  periodScores!: SportsMatchFactsRecord['periodScores'];

  @Prop({ type: [Object], default: [] })
  teamStatistics!: SportsMatchFactsRecord['teamStatistics'];

  @Prop({ type: [Object], default: [] })
  playerAppearances!: SportsMatchFactsRecord['playerAppearances'];

  @Prop({ type: [Object], default: [] })
  leaders!: SportsMatchFactsRecord['leaders'];

  @Prop({ type: [Object], default: [] })
  summaryEvents!: SportsMatchFactsRecord['summaryEvents'];

  @Prop({ required: true, type: Object })
  sectionStatus!: SportsMatchFactsRecord['sectionStatus'];

  @Prop({ type: [String], default: [] })
  diagnostics!: string[];

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsMatchFactsSchema = SchemaFactory.createForClass(SportsMatchFacts);
SportsMatchFactsSchema.index({ competitionId: 1, seasonId: 1, normalizedAt: -1 });
SportsMatchFactsSchema.index({ competitionId: 1, seasonYear: 1, normalizedAt: -1 });
