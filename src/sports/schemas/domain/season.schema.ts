import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type { SportsSeasonRecord } from '../../interfaces/sports-domain.interface';
import { SportsSourceMetadataSchema } from './embedded.schema';

export type SportsSeasonDocument = HydratedDocument<SportsSeason>;

@Schema({ timestamps: true, collection: 'sports_seasons', versionKey: false })
export class SportsSeason implements Omit<SportsSeasonRecord, 'createdAt' | 'updatedAt'> {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, trim: true })
  espnId!: string;

  @Prop({ required: true, trim: true, index: true })
  competitionId!: string;

  @Prop({ required: true, type: Number, index: true })
  year!: number;

  @Prop({ trim: true })
  displayName?: string;

  @Prop({ trim: true })
  shortDisplayName?: string;

  @Prop({ type: Date })
  startDate?: Date;

  @Prop({ type: Date })
  endDate?: Date;

  @Prop({ required: true, default: false, index: true })
  isCurrent!: boolean;

  @Prop({ type: Object })
  rawPayload?: Record<string, unknown>;

  @Prop({ required: true, type: SportsSourceMetadataSchema })
  source!: SportsSeasonRecord['source'];

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsSeasonSchema = SchemaFactory.createForClass(SportsSeason);
SportsSeasonSchema.index({ competitionId: 1, year: 1 }, { unique: true });
SportsSeasonSchema.index({ competitionId: 1, isCurrent: 1 });
SportsSeasonSchema.index({ startDate: 1, endDate: 1 });


