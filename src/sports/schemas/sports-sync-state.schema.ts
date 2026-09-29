import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SportsSyncStateDocument = HydratedDocument<SportsSyncState> & {
  createdAt: Date;
  updatedAt: Date;
};

export enum SportsSyncStateKind {
  QUEUE = 'QUEUE',
  CRON = 'CRON',
}

export enum SportsSyncStateStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  PARTIAL = 'PARTIAL',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

export enum SportsSyncUnitType {
  DATE = 'DATE',
  STEP = 'STEP',
}

export enum SportsSyncUnitStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

@Schema({
  _id: false,
})
export class SportsSyncUnit {
  @Prop({
    required: true,
    trim: true,
  })
  key!: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(SportsSyncUnitType),
  })
  type!: SportsSyncUnitType;

  @Prop({
    type: String,
    trim: true,
  })
  dateKey?: string;

  @Prop({
    type: String,
    trim: true,
  })
  stepKey?: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(SportsSyncUnitStatus),
    default: SportsSyncUnitStatus.PENDING,
  })
  status!: SportsSyncUnitStatus;

  @Prop({
    required: true,
    default: 0,
    min: 0,
  })
  attempts!: number;

  @Prop({
    type: Date,
  })
  startedAt?: Date;

  @Prop({
    type: Date,
  })
  completedAt?: Date;

  @Prop({
    type: Date,
  })
  nextAttemptAt?: Date;

  @Prop({
    type: String,
  })
  lastError?: string;
}

export const SportsSyncUnitSchema =
  SchemaFactory.createForClass(SportsSyncUnit);

@Schema({
  timestamps: true,
  collection: 'sports_sync_states',
})
export class SportsSyncState {
  /**
   * Permanent operational identity.
   *
   * Examples:
   *
   * QUEUE:FIXTURE_REFRESH:eng.1:2026
   * QUEUE:SUMMARY_REFRESH:eng.1:401884783
   * CRON:espn-live-matches
   *
   * Older LEAGUE_REFRESH, FIXTURE_RECOVERY,
   * UPCOMING_MATCH and FINISHED_MATCH identities are
   * no longer part of the target architecture.
   */
  @Prop({
    required: true,
    unique: true,
    trim: true,
  })
  stateKey!: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(SportsSyncStateKind),
    index: true,
  })
  kind!: SportsSyncStateKind;

  /**
   * Current queue job type.
   *
   * Queue states should use:
   *
   * FIXTURE_REFRESH
   * SUMMARY_REFRESH
   */
  @Prop({
    type: String,
    index: true,
  })
  jobType?: string;

  @Prop({
    type: String,
    index: true,
    trim: true,
  })
  taskKey?: string;

  @Prop({
    type: String,
    index: true,
    trim: true,
    lowercase: true,
  })
  leagueId?: string;

  @Prop({
    type: Number,
    index: true,
  })
  season?: number;

  @Prop({
    type: String,
    index: true,
    trim: true,
  })
  eventId?: string;

  @Prop({
    type: Number,
    index: true,
    min: 1,
  })
  priority?: number;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(SportsSyncStateStatus),
    default: SportsSyncStateStatus.PENDING,
    index: true,
  })
  status!: SportsSyncStateStatus;

  /**
   * WINDOW:
   *   Normal rolling fixture collection window.
   *
   * HISTORY:
   *   Startup or recovery fixture hydration covering
   *   the known operational season window.
   *
   * Summary jobs normally do not require a date-range
   * tracking mode because they are event-specific.
   */
  @Prop({
    required: true,
    type: String,
    enum: ['WINDOW', 'HISTORY'],
  })
  trackingMode!: 'WINDOW' | 'HISTORY';

  @Prop({
    type: String,
  })
  dateFrom?: string;

  @Prop({
    type: String,
  })
  dateTo?: string;

  @Prop({
    type: [SportsSyncUnitSchema],
    default: [],
  })
  units!: SportsSyncUnit[];

  // ============================================================
  // CRON STATE
  // ============================================================

  @Prop({
    type: String,
  })
  cronExpression?: string;

  @Prop({
    type: String,
  })
  timeZone?: string;

  @Prop({
    type: Date,
    index: true,
  })
  lastStartedAt?: Date;

  @Prop({
    type: Date,
    index: true,
  })
  lastSuccessfulAt?: Date;

  @Prop({
    type: Date,
    index: true,
  })
  nextRunAt?: Date;

  @Prop({
    type: Number,
    default: 0,
    min: 0,
  })
  consecutiveFailures!: number;

  @Prop({
    type: String,
  })
  lastError?: string;

  // ============================================================
  // QUEUE EXECUTION
  // ============================================================

  @Prop({
    type: String,
    trim: true,
  })
  lastQueueJobKey?: string;

  @Prop({
    type: Date,
    index: true,
  })
  lastCompletedAt?: Date;
}

export const SportsSyncStateSchema =
  SchemaFactory.createForClass(SportsSyncState);

SportsSyncStateSchema.index({
  kind: 1,
  status: 1,
});

SportsSyncStateSchema.index({
  jobType: 1,
  leagueId: 1,
  season: 1,
});

SportsSyncStateSchema.index({
  jobType: 1,
  eventId: 1,
});

SportsSyncStateSchema.index({
  nextRunAt: 1,
  kind: 1,
});

SportsSyncStateSchema.index({
  priority: 1,
  status: 1,
  updatedAt: 1,
});
