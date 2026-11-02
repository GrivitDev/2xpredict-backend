import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EspnStandingsCollectionStateDocument =
  HydratedDocument<EspnStandingsCollectionState>;

export type EspnStandingsCollectionStatus =
  | 'COLLECTING'
  | 'AVAILABLE'
  | 'PARTIAL'
  | 'UNAVAILABLE'
  | 'FAILED'
  | 'SKIPPED';

/** Persistent outcome for a competition-season, including attempts with no table. */
@Schema({
  timestamps: true,
  collection: 'sports_espn_standings_collection_state',
})
export class EspnStandingsCollectionState {
  @Prop({ required: true, trim: true, lowercase: true, index: true })
  leagueId!: string;

  @Prop({ required: true, index: true })
  season!: number;

  @Prop({
    required: true,
    enum: [
      'COLLECTING',
      'AVAILABLE',
      'PARTIAL',
      'UNAVAILABLE',
      'FAILED',
      'SKIPPED',
    ],
    index: true,
  })
  status!: EspnStandingsCollectionStatus;

  @Prop({ type: Number, default: 0 })
  attempts!: number;

  @Prop({ type: Date, default: null })
  lastAttemptAt?: Date | null;

  @Prop({ type: Date, default: null })
  lastSuccessAt?: Date | null;

  @Prop({ type: Date, default: null })
  nextRetryAt?: Date | null;

  @Prop({ type: [String], default: [] })
  discoveredStageIds!: string[];

  @Prop({ type: [String], default: [] })
  retrievedStageIds!: string[];

  @Prop({ type: [String], default: [] })
  missingStageIds!: string[];

  @Prop({ type: Number, default: 0 })
  tableCount!: number;

  @Prop({ type: Number, default: 0 })
  teamEntryCount!: number;

  @Prop({ type: String, default: null, maxlength: 500 })
  lastReason?: string | null;

  @Prop({ type: String, default: null, maxlength: 100 })
  lastErrorCode?: string | null;

  @Prop({ type: Boolean, default: false })
  hasLastKnownSnapshot!: boolean;
}

export const EspnStandingsCollectionStateSchema = SchemaFactory.createForClass(
  EspnStandingsCollectionState,
);

EspnStandingsCollectionStateSchema.index(
  { leagueId: 1, season: 1 },
  { unique: true },
);
EspnStandingsCollectionStateSchema.index({ status: 1, nextRetryAt: 1 });
