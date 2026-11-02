import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import type { EspnStandingsPayload } from '../../providers/espn.interfaces';

export type EspnStandingDocument = HydratedDocument<EspnStanding>;

/** One untouched ESPN standings response per competition and season. */
@Schema({
  timestamps: true,
  collection: 'sports_espn_standings',
})
export class EspnStanding {
  @Prop({ required: true, trim: true, lowercase: true, index: true })
  leagueId!: string;

  @Prop({ required: true, index: true })
  season!: number;

  @Prop({ required: true, trim: true })
  leagueName!: string;

  /** Complete response body returned by ESPN; do not flatten or transform it. */
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload!: EspnStandingsPayload;

  @Prop({ required: true, type: Date, index: true })
  fetchedAt!: Date;
}

export const EspnStandingSchema = SchemaFactory.createForClass(EspnStanding);

// One document per ESPN competition and season, including cup group tables.
EspnStandingSchema.index(
  { leagueId: 1, season: 1 },
  {
    name: 'uniq_espn_standings_league_season_snapshot',
    unique: true,
    // Existing installations contain legacy per-team rows. They are excluded
    // until a successful ESPN refresh upgrades one row and removes its siblings.
    partialFilterExpression: {
      leagueName: { $type: 'string' },
      fetchedAt: { $type: 'date' },
    },
  },
);
EspnStandingSchema.index({ fetchedAt: -1 });
