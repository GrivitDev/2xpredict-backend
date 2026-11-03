import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { HydratedDocument } from 'mongoose';

export type FootballDataCompetitionDocument =
  HydratedDocument<FootballDataCompetition>;

@Schema({
  timestamps: true,
  collection: 'sports_football_data_competitions',
})
export class FootballDataCompetition {
  /**
   * Football-Data provider competition ID.
   */
  @Prop({
    required: true,
    unique: true,
    index: true,
  })
  competitionId!: number;

  @Prop({
    required: true,
    index: true,
    trim: true,
    uppercase: true,
  })
  code!: string;

  @Prop({
    required: true,
    trim: true,
  })
  name!: string;

  @Prop({
    type: String,
    trim: true,
  })
  type?: string;

  /**
   * Complete latest Football-Data competition object.
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

export const FootballDataCompetitionSchema = SchemaFactory.createForClass(
  FootballDataCompetition,
);

