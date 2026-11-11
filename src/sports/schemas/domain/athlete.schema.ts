import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { SportsSourceMetadataSchema } from './embedded.schema';

export type SportsAthleteDocument = HydratedDocument<SportsAthlete>;

@Schema({ timestamps: true, collection: 'sports_athletes', versionKey: false })
export class SportsAthlete {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ required: true, unique: true, trim: true })
  espnId!: string;

  @Prop({ required: true, trim: true, index: true })
  fullName!: string;

  @Prop({ trim: true })
  firstName?: string;

  @Prop({ trim: true })
  lastName?: string;

  @Prop({ trim: true })
  displayName?: string;

  @Prop({ trim: true, index: true })
  nationality?: string;

  @Prop({ type: Date, index: true })
  dateOfBirth?: Date;

  @Prop({ trim: true, index: true })
  position?: string;

  @Prop({ trim: true })
  jerseyNumber?: string;

  @Prop({ type: Number, min: 0 })
  height?: number;

  @Prop({ type: Number, min: 0 })
  weight?: number;

  @Prop({ trim: true })
  headshot?: string;

  @Prop({ required: true, type: SportsSourceMetadataSchema })
  source!: Record<string, unknown>;

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsAthleteSchema = SchemaFactory.createForClass(SportsAthlete);
SportsAthleteSchema.index({ lastName: 1, firstName: 1 });
