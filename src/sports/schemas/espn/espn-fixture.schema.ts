import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { HydratedDocument } from 'mongoose';

import type { EspnFixturePayload } from '../../providers/espn.interfaces';

export type EspnFixtureDocument = HydratedDocument<EspnFixture>;

@Schema({
  timestamps: true,
  collection: 'sports_espn_fixtures',
})
export class EspnFixture {
  /**
   * ESPN event ID.
   *
   * This is the permanent provider identity of the fixture.
   */
  @Prop({
    required: true,
    unique: true,
    index: true,
    trim: true,
  })
  eventId!: string;

  /**
   * ESPN league slug.
   *
   * Examples:
   * eng.1
   * uefa.champions
   * nga.1
   */
  @Prop({
    required: true,
    index: true,
    trim: true,
    lowercase: true,
  })
  leagueId!: string;

  /**
   * ESPN/provider season identifier.
   */
  @Prop({
    required: true,
    index: true,
  })
  season!: number;

  @Prop({
    required: true,
    type: Date,
    index: true,
  })
  fixtureDate!: Date;

  @Prop({
    required: true,
    index: true,
  })
  status!: string;

  @Prop({
    required: false,
  })
  statusDetail?: string;

  @Prop({
    required: false,
  })
  statusShortDetail?: string;

  @Prop({
    required: false,
  })
  period?: number;

  @Prop({
    required: false,
  })
  completed?: boolean;

  @Prop({
    required: true,
    default: false,
    index: true,
  })
  live!: boolean;

  @Prop({
    required: false,
  })
  displayClock?: string;

  /**
   * ESPN team IDs.
   */
  @Prop({
    required: true,
    index: true,
    trim: true,
  })
  homeTeamId!: string;

  @Prop({
    required: true,
    index: true,
    trim: true,
  })
  awayTeamId!: string;

  @Prop({
    required: false,
  })
  homeScore?: number;

  @Prop({
    required: false,
  })
  awayScore?: number;

  @Prop({
    required: false,
    trim: true,
  })
  venueId?: string;

  @Prop({
    required: false,
  })
  venueName?: string;

  /**
   * Complete latest ESPN event/fixture object.
   *
   * The runtime MongoDB representation remains an object,
   * while TypeScript uses the complete ESPN fixture payload type.
   */
  @Prop({
    type: Object,
    required: true,
  })
  payload!: EspnFixturePayload;

  @Prop({
    required: true,
    type: Date,
    index: true,
  })
  collectedAt!: Date;
}

export const EspnFixtureSchema = SchemaFactory.createForClass(EspnFixture);

EspnFixtureSchema.index({
  leagueId: 1,
  season: 1,
  fixtureDate: 1,
});

EspnFixtureSchema.index({
  leagueId: 1,
  season: 1,
  status: 1,
  fixtureDate: 1,
});

EspnFixtureSchema.index({
  homeTeamId: 1,
  awayTeamId: 1,
  fixtureDate: -1,
});

EspnFixtureSchema.index({
  homeTeamId: 1,
  fixtureDate: -1,
});

EspnFixtureSchema.index({
  awayTeamId: 1,
  fixtureDate: -1,
});

EspnFixtureSchema.index({
  collectedAt: -1,
});
