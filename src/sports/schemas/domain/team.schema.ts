import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type { SportsTeamRecord } from '../../interfaces/sports-domain.interface';
import { SportsSourceMetadataSchema } from './embedded.schema';

export type SportsTeamDocument = HydratedDocument<SportsTeam>;

@Schema({ timestamps: true, collection: 'sports_teams', versionKey: false })
export class SportsTeam implements Omit<SportsTeamRecord, 'createdAt' | 'updatedAt'> {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, unique: true, trim: true })
  espnId!: string;

  @Prop({ required: true, type: [String], default: [], index: true })
  leagueIds!: string[];

  @Prop({ required: true, trim: true, index: true })
  name!: string;

  @Prop({ trim: true })
  displayName?: string;

  @Prop({ trim: true })
  shortName?: string;

  @Prop({ trim: true, index: true })
  abbreviation?: string;

  @Prop({ trim: true, lowercase: true, index: true })
  slug?: string;

  @Prop({ trim: true })
  logo?: string;

  @Prop({ trim: true, index: true })
  country?: string;

  @Prop({ trim: true })
  location?: string;


  @Prop({ trim: true })
  primaryColor?: string;

  @Prop({ trim: true })
  alternateColor?: string;

  @Prop({ type: Object })
  rawPayload?: Record<string, unknown>;

  @Prop({ required: true, type: SportsSourceMetadataSchema })
  source!: SportsTeamRecord['source'];

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsTeamSchema = SchemaFactory.createForClass(SportsTeam);
SportsTeamSchema.index({ country: 1, name: 1 });

