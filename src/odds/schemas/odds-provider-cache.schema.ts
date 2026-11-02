import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OddsProviderCacheDocument = HydratedDocument<OddsProviderCache>;

@Schema({ timestamps: true, collection: 'odds_provider_cache' })
export class OddsProviderCache {
  @Prop({ required: true, unique: true, trim: true })
  cacheKey!: string;

  @Prop({ required: true, enum: ['THE_ODDS_API'] })
  provider!: 'THE_ODDS_API';

  @Prop({ required: true, type: Object })
  data!: Record<string, unknown>;

  @Prop({ required: true, type: Date, index: true })
  fetchedAt!: Date;

  // Indexed by the TTL index declared below.
  @Prop({ required: true, type: Date })
  expiresAt!: Date;
}

export const OddsProviderCacheSchema =
  SchemaFactory.createForClass(OddsProviderCache);

OddsProviderCacheSchema.index(
  { expiresAt: 1 },
  {
    expireAfterSeconds: 0,
    name: 'expiresAt_1',
  },
);
