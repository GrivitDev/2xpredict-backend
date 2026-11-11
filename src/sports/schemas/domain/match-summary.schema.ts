import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SportsMatchSummaryDocument = HydratedDocument<SportsMatchSummary>;

/** Latest raw ESPN Summary snapshot for one canonical Sports fixture. */
@Schema({ timestamps: true, collection: 'sports_match_summaries', versionKey: false })
export class SportsMatchSummary {
  @Prop({ required: true, unique: true, trim: true })
  fixtureId!: string;

  @Prop({ required: true, unique: true, trim: true })
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

  @Prop({ required: true, type: Object })
  rawPayload!: Record<string, unknown>;

  @Prop({ required: true, trim: true, index: true })
  payloadHash!: string;

  @Prop({ required: true, type: Number, min: 1 })
  revision!: number;

  @Prop({ required: true, type: Number, min: 0 })
  payloadSizeBytes!: number;

  @Prop({ required: true, type: Date })
  firstCollectedAt!: Date;

  @Prop({ required: true, type: Date, index: true })
  lastCollectedAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsMatchSummarySchema = SchemaFactory.createForClass(SportsMatchSummary);
SportsMatchSummarySchema.index({ competitionId: 1, seasonId: 1, lastCollectedAt: -1 });
