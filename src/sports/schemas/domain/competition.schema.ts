import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type {
  SportsCompetitionRecord,
  SportsCompetitionRegion,
  SportsCompetitionType,
} from '../../interfaces/sports-domain.interface';
import { SportsSourceMetadataSchema } from './embedded.schema';

export type SportsCompetitionDocument = HydratedDocument<SportsCompetition>;

@Schema({ timestamps: true, collection: 'sports_competitions', versionKey: false })
export class SportsCompetition implements Omit<SportsCompetitionRecord, 'createdAt' | 'updatedAt'> {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, unique: true, trim: true })
  espnId!: string;

  @Prop({ required: true, unique: true, trim: true, lowercase: true })
  slug!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true })
  displayName?: string;

  @Prop({ trim: true })
  abbreviation?: string;

  @Prop({ required: true, type: String, enum: ['LEAGUE', 'CLUB_COMPETITION', 'INTERNATIONAL'] })
  type!: SportsCompetitionType;

  @Prop({ required: true, type: String, enum: ['NIGERIA', 'AFRICA', 'EUROPE', 'SOUTH_AMERICA', 'NORTH_AMERICA', 'ASIA', 'OCEANIA', 'WORLD'] })
  region!: SportsCompetitionRegion;

  @Prop({ trim: true })
  country?: string;

  @Prop({ trim: true })
  logo?: string;

  @Prop({ required: true, default: true, index: true })
  isActive!: boolean;

  @Prop({ trim: true, index: true })
  currentSeasonId?: string;

  @Prop({ type: Number, index: true })
  currentSeasonYear?: number;

  @Prop({ type: Date })
  currentSeasonStartDate?: Date;

  @Prop({ type: Date })
  currentSeasonEndDate?: Date;

  @Prop({ type: Object })
  rawPayload?: Record<string, unknown>;

  @Prop({ required: true, type: SportsSourceMetadataSchema })
  source!: SportsCompetitionRecord['source'];

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsCompetitionSchema = SchemaFactory.createForClass(SportsCompetition);
SportsCompetitionSchema.index({ isActive: 1, region: 1, type: 1, name: 1 });



