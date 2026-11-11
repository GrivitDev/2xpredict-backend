import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument, InferSchemaType } from 'mongoose';

import { SportsSourceMetadataSchema } from './embedded.schema';

export type SportsVenueDocument = HydratedDocument<SportsVenue>;

@Schema({ timestamps: true, collection: 'sports_venues', versionKey: false })
export class SportsVenue {
  @Prop({ required: true, unique: true, trim: true })
  id!: string;

  @Prop({ trim: true })
  espnId?: string;

  @Prop({ required: true, trim: true, index: true })
  name!: string;

  @Prop({ trim: true })
  city?: string;

  @Prop({ trim: true })
  country?: string;

  @Prop({ trim: true })
  address?: string;

  @Prop({ type: Number, min: 0 })
  capacity?: number;

  @Prop({ trim: true })
  surface?: string;

  @Prop({ required: true, type: SportsSourceMetadataSchema })
  source!: InferSchemaType<typeof SportsSourceMetadataSchema>;

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsVenueSchema = SchemaFactory.createForClass(SportsVenue);
SportsVenueSchema.index({ espnId: 1 }, { unique: true, sparse: true });
SportsVenueSchema.index({ country: 1, city: 1, name: 1 });
