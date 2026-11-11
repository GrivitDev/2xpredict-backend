import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

import type { SportsHeadToHeadRecord } from '../../interfaces/sports-derived-data.interface';

export type SportsHeadToHeadDocument = HydratedDocument<SportsHeadToHead>;

@Schema({
  timestamps: true,
  collection: 'sports_head_to_head',
  versionKey: false,
})
export class SportsHeadToHead implements SportsHeadToHeadRecord {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  /** Team IDs are stored in canonical sorted order by the projection service. */
  @Prop({ required: true, trim: true, index: true })
  teamAId!: string;

  @Prop({ required: true, trim: true, index: true })
  teamBId!: string;

  @Prop({ trim: true, index: true })
  competitionId?: string;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  matches!: SportsHeadToHeadRecord['matches'];

  @Prop({ required: true, type: Date, index: true })
  computedAt!: Date;

  @Prop({ required: true, type: Number, min: 0, index: true })
  sourceRevision!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsHeadToHeadSchema =
  SchemaFactory.createForClass(SportsHeadToHead);
SportsHeadToHeadSchema.index({ teamAId: 1, teamBId: 1, competitionId: 1 });
SportsHeadToHeadSchema.index({ teamAId: 1, teamBId: 1, computedAt: -1 });
