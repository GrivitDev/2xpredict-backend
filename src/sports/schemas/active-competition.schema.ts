import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { CompetitionPriority } from '../enums/competition-priority.enum';
import { CompetitionRegion } from '../enums/competition-region.enum';
import { CompetitionType } from '../enums/competition-type.enum';

import { ActiveCompetitionStatus } from '../interfaces/active-competition.interface';

export type ActiveCompetitionDocument = HydratedDocument<ActiveCompetition>;

@Schema({
  timestamps: true,
  collection: 'sports_active_competitions',
})
export class ActiveCompetition {
  @Prop({
    required: true,
    unique: true,
    index: true,
    trim: true,
    lowercase: true,
  })
  competitionId!: string;

  @Prop({
    required: true,
    trim: true,
  })
  name!: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(CompetitionType),
    index: true,
  })
  type!: CompetitionType;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(CompetitionRegion),
    index: true,
  })
  region!: CompetitionRegion;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(CompetitionPriority),
    index: true,
  })
  priority!: CompetitionPriority;

  @Prop({
    required: true,
    trim: true,
    lowercase: true,
    index: true,
  })
  espnLeagueSlug!: string;

  @Prop({
    type: String,
    trim: true,
    uppercase: true,
    index: true,
  })
  footballDataCode?: string;

  @Prop({
    type: String,
    trim: true,
    index: true,
  })
  oddsApiSportKey?: string;

  /**
   * Current ESPN season.
   */
  @Prop({
    type: Number,
    index: true,
  })
  season?: number;

  /**
   * Current season start date.
   */
  @Prop({
    type: Date,
    index: true,
  })
  seasonStartDate?: Date;

  /**
   * Current season end date.
   */
  @Prop({
    type: Date,
    index: true,
  })
  seasonEndDate?: Date;

  /**
   * Latest known fixture date.
   */
  @Prop({
    type: Date,
    index: true,
  })
  lastFixtureDate?: Date;

  /**
   * Next known fixture date.
   */
  @Prop({
    type: Date,
    index: true,
  })
  nextFixtureDate?: Date;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(ActiveCompetitionStatus),
    default: ActiveCompetitionStatus.INACTIVE,
    index: true,
  })
  status!: ActiveCompetitionStatus;

  /**
   * Full ESPN league-detail payload.
   */
  @Prop({
    type: Object,
  })
  espnPayload?: Record<string, unknown>;

  @Prop({
    type: Date,
    index: true,
  })
  lastUpdatedAt?: Date;
}

export const ActiveCompetitionSchema =
  SchemaFactory.createForClass(ActiveCompetition);

ActiveCompetitionSchema.index({
  status: 1,
  priority: 1,
  nextFixtureDate: 1,
});

ActiveCompetitionSchema.index({
  espnLeagueSlug: 1,
  season: 1,
});

