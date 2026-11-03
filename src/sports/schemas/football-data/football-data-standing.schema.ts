import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { HydratedDocument } from 'mongoose';

export type FootballDataStandingDocument =
  HydratedDocument<FootballDataStanding>;

@Schema({
  timestamps: true,
  collection: 'sports_football_data_standings',
})
export class FootballDataStanding {
  @Prop({
    required: true,
    index: true,
  })
  competitionId!: number;

  @Prop({
    required: true,
    index: true,
    trim: true,
    uppercase: true,
  })
  competitionCode!: string;

  @Prop({
    required: true,
    index: true,
  })
  seasonId!: number;

  @Prop({
    required: true,
    default: 'UNKNOWN',
  })
  stage!: string;

  @Prop({
    required: true,
    default: 'TOTAL',
  })
  type!: string;

  @Prop({
    trim: true,
  })
  group?: string;

  /**
   * Complete latest Football-Data standing row.
   *
   * The team ID inside payload identifies the standing row.
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

export const FootballDataStandingSchema =
  SchemaFactory.createForClass(FootballDataStanding);

/**
 * One current standing record per:
 *
 * competition + season + stage + type + group + team
 *
 * The team identifier is stored inside the provider payload
 * because Football-Data standing rows contain the team object.
 */
FootballDataStandingSchema.index(
  {
    competitionId: 1,
    seasonId: 1,
    stage: 1,
    type: 1,
    group: 1,
    'payload.team.id': 1,
  },
  {
    unique: true,
  },
);

FootballDataStandingSchema.index({
  competitionId: 1,
  seasonId: 1,
  stage: 1,
  type: 1,
  group: 1,
  'payload.position': 1,
});

