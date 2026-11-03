import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { HydratedDocument } from 'mongoose';

export type EspnTeamDocument = HydratedDocument<EspnTeam>;

@Schema({
  timestamps: true,
  collection: 'sports_espn_teams',
})
export class EspnTeam {
  /**
   * ESPN team ID.
   *
   * A team can appear in multiple ESPN leagues/competitions,
   * so this must NOT be globally unique.
   */
  @Prop({
    required: true,
    index: true,
    trim: true,
  })
  teamId!: string;

  /**
   * ESPN league slug.
   */
  @Prop({
    required: true,
    index: true,
    trim: true,
    lowercase: true,
  })
  leagueId!: string;

  @Prop({
    required: true,
    index: true,
    trim: true,
  })
  name!: string;

  @Prop({
    required: false,
  })
  displayName?: string;

  @Prop({
    required: false,
  })
  shortDisplayName?: string;

  @Prop({
    required: false,
    index: true,
  })
  abbreviation?: string;

  @Prop({
    required: false,
  })
  location?: string;

  @Prop({
    required: false,
  })
  logo?: string;

  @Prop({
    required: false,
  })
  color?: string;

  @Prop({
    required: false,
  })
  alternateColor?: string;

  @Prop({
    required: false,
    index: true,
  })
  active?: boolean;

  /**
   * Complete latest ESPN team object for this league.
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

export const EspnTeamSchema = SchemaFactory.createForClass(EspnTeam);

/**
 * A team may exist in multiple leagues, so leagueId is part
 * of the team's identity within this collection.
 */
EspnTeamSchema.index({
  teamId: 1,
  leagueId: 1,
});

EspnTeamSchema.index({
  leagueId: 1,
  name: 1,
});

EspnTeamSchema.index({
  leagueId: 1,
  active: 1,
});

