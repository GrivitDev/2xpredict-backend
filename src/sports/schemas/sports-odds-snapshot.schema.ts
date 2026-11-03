import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { HydratedDocument } from 'mongoose';

export type SportsOddsSnapshotDocument = HydratedDocument<SportsOddsSnapshot>;

@Schema({
  timestamps: true,
  collection: 'sports_odds',
})
export class SportsOddsSnapshot {
  /**
   * Odds API event ID is the identity of the current
   * odds record.
   */
  @Prop({
    required: true,
    unique: true,
    index: true,
    trim: true,
  })
  eventId!: string;

  @Prop({
    required: true,
    index: true,
    trim: true,
  })
  sportKey!: string;

  @Prop({
    required: true,
    trim: true,
  })
  homeTeam!: string;

  @Prop({
    required: true,
    trim: true,
  })
  awayTeam!: string;

  @Prop({
    required: true,
    type: Date,
    index: true,
  })
  commenceTime!: Date;

  /**
   * Complete latest Odds API event object.
   *
   * This contains the current bookmakers and markets.
   *
   * We do NOT create a separate MongoDB document for each
   * bookmaker or market.
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

export const SportsOddsSnapshotSchema =
  SchemaFactory.createForClass(SportsOddsSnapshot);

SportsOddsSnapshotSchema.index({
  sportKey: 1,
  commenceTime: 1,
});

SportsOddsSnapshotSchema.index({
  homeTeam: 1,
  awayTeam: 1,
  commenceTime: 1,
});

