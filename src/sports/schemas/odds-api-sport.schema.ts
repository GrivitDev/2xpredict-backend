import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { HydratedDocument } from 'mongoose';

export type OddsApiSportDocument = HydratedDocument<OddsApiSport>;

@Schema({
  timestamps: true,
  collection: 'sports_odds_api_sports',
})
export class OddsApiSport {
  /**
   * Odds API sport key is the provider identity.
   */
  @Prop({
    required: true,
    unique: true,
    index: true,
    trim: true,
  })
  sportKey!: string;

  @Prop({
    required: true,
    trim: true,
  })
  title!: string;

  @Prop({
    required: true,
    index: true,
  })
  active!: boolean;

  @Prop({
    required: true,
  })
  hasOutrights!: boolean;

  /**
   * Complete latest Odds API sport object.
   */
  @Prop({
    type: Object,
    required: true,
  })
  payload!: Record<string, unknown>;

  @Prop({
    required: true,
    type: Date,
    index: true,
  })
  collectedAt!: Date;
}

export const OddsApiSportSchema = SchemaFactory.createForClass(OddsApiSport);

