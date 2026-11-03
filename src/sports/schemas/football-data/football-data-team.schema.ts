import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { HydratedDocument } from 'mongoose';

export type FootballDataTeamDocument = HydratedDocument<FootballDataTeam>;

@Schema({
  timestamps: true,
  collection: 'sports_football_data_teams',
})
export class FootballDataTeam {
  /**
   * Football-Data provider team ID.
   *
   * This is the identity of the team at this provider.
   *
   * A team can participate in multiple competitions, but
   * it remains one provider team record.
   */
  @Prop({
    required: true,
    unique: true,
    index: true,
  })
  teamId!: number;

  @Prop({
    required: true,
    trim: true,
  })
  name!: string;

  @Prop({
    type: String,
    trim: true,
  })
  shortName?: string;

  @Prop({
    type: String,
    trim: true,
  })
  tla?: string;

  /**
   * Complete latest Football-Data team object.
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

export const FootballDataTeamSchema =
  SchemaFactory.createForClass(FootballDataTeam);

FootballDataTeamSchema.index({
  name: 1,
});

