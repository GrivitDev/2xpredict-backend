import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type {
  SportsQueueJob,
  SportsQueueRepeatUntil,
} from '../../interfaces/sports-queue.interface';
import {
  SportsQueueJobStatus,
  SportsQueueLane,
  SportsQueueJobType,
} from '../../interfaces/sports-queue.interface';

@Schema({ _id: false })
export class SportsQueueScopeEmbedded {
  @Prop({ type: String, trim: true }) competitionId?: string;
  @Prop({ type: String, trim: true, lowercase: true }) leagueId?: string;
  @Prop({ type: String, trim: true }) seasonId?: string;
  @Prop({ type: Number }) seasonYear?: number;
  @Prop({ type: String, trim: true }) teamId?: string;
  @Prop({ type: String, trim: true }) teamReference?: string;
  @Prop({ type: String, trim: true }) fixtureId?: string;
  @Prop({ type: [String] }) fixtureIds?: string[];
  @Prop({ type: String, trim: true, index: true }) newsWindow?: string;
  @Prop({ type: String, trim: true, index: true }) projectionWindow?: string;
  @Prop({ type: String, trim: true }) espnEventId?: string;
  @Prop({ type: String, trim: true }) calendarDate?: string;
  @Prop({ type: String, trim: true, index: true }) bootstrapRunId?: string;
  @Prop({
    type: String,
    trim: true,
    enum: [
      'LEAGUE_DETAILS',
      'SEASON_CATALOGUES',
      'TEAM_CATALOGUES',
      'TEAM_DETAILS',
      'MONTHLY_FIXTURE_BOOTSTRAP',
      'DAILY_FIXTURE_VALIDATION',
    ],
  })
  bootstrapPhase?: SportsQueueJob['scope']['bootstrapPhase'];
  @Prop({ type: String, trim: true }) milestone?: string;
  @Prop({ type: String, trim: true }) expectedKickoffAt?: string;
  @Prop({ type: String, trim: true }) expectedCompletedAt?: string;
  @Prop({ type: String, trim: true, enum: ['FIXTURE', 'TIMELINE'] })
  sourceKind?: 'FIXTURE' | 'TIMELINE';
  @Prop({ type: String, trim: true, index: true }) sourceFingerprint?: string;
  @Prop({ type: String, trim: true, index: true }) predictionSourceUpdatedAt?: string;
  @Prop({ type: Boolean }) seasonBootstrap?: boolean;
  @Prop({ type: String, trim: true }) seasonEndDate?: string;
  @Prop({ type: Number, min: 1 }) youtubeAttempt?: number;
  @Prop({ type: Number, min: 0 }) summaryAttempt?: number;
  @Prop({ type: String, trim: true }) backfillRunId?: string;
  @Prop({ type: String, trim: true }) summaryBackfillRunId?: string;
  @Prop({ type: String, trim: true }) backfillCursorKickoffAt?: string;
  @Prop({ type: String, trim: true }) backfillCursorFixtureId?: string;
}
export const SportsQueueScopeSchema = SchemaFactory.createForClass(
  SportsQueueScopeEmbedded,
);

@Schema({ _id: false })
export class SportsQueueRecurrenceEmbedded {
  @Prop({ required: true, type: Number, min: 1 }) intervalMs!: number;
  @Prop({ required: true, type: String, enum: ['NEVER', 'DATA_COMPLETE'] })
  repeatUntil!: SportsQueueRepeatUntil;
}
export const SportsQueueRecurrenceSchema = SchemaFactory.createForClass(
  SportsQueueRecurrenceEmbedded,
);

export type SportsQueueDocument = HydratedDocument<SportsQueue>;

@Schema({
  timestamps: true,
  collection: 'sports_queue_jobs',
  versionKey: false,
})
export class SportsQueue implements Omit<
  SportsQueueJob,
  'scope' | 'recurrence' | 'createdAt' | 'updatedAt'
> {
  @Prop({ required: true, unique: true, trim: true }) jobKey!: string;
  @Prop({
    required: true,
    type: String,
    enum: Object.values(SportsQueueJobType),
    index: true,
  })
  type!: SportsQueueJobType;
  @Prop({ required: true, type: SportsQueueScopeSchema })
  scope!: SportsQueueJob['scope'];
  @Prop({ required: true, type: Number, min: 1, default: 5, index: true })
  priority!: number;
  @Prop({
    required: true,
    type: String,
    enum: Object.values(SportsQueueJobStatus),
    default: SportsQueueJobStatus.PENDING,
    index: true,
  })
  status!: SportsQueueJobStatus;
  @Prop({
    required: true,
    type: String,
    enum: Object.values(SportsQueueLane),
    default: SportsQueueLane.NORMAL,
    index: true,
  })
  lane!: SportsQueueLane;
  @Prop({ required: true, type: Date, index: true }) scheduledFor!: Date;
  @Prop({ type: SportsQueueRecurrenceSchema })
  recurrence?: SportsQueueJob['recurrence'];
  @Prop({ required: true, type: Number, min: 0, default: 0 }) attempts!: number;
  @Prop({ required: true, type: Number, min: 1, default: 20 })
  maxAttempts!: number;
  @Prop({ required: true, type: Number, min: 0, default: 0 })
  retryCount!: number;
  @Prop({ type: Date, index: true }) lastAttemptAt?: Date;
  @Prop({ type: Date, index: true }) nextAttemptAt?: Date;
  @Prop({ type: Date, index: true }) nextRunAt?: Date;
  @Prop({ type: Date, index: true }) startedAt?: Date;
  @Prop({ type: Date, index: true }) completedAt?: Date;
  @Prop({ type: Date, index: true }) failedAt?: Date;
  @Prop({ type: String }) lastError?: string;
  @Prop({ type: String, trim: true, index: true }) ownerId?: string;
  @Prop({ type: Date, index: true }) heartbeatAt?: Date;
  @Prop({ type: Date, index: true }) leaseExpiresAt?: Date;
  @Prop({ type: String, trim: true, index: true }) triggerEventId?: string;
  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsQueueSchema = SchemaFactory.createForClass(SportsQueue);
SportsQueueSchema.index({
  status: 1,
  scheduledFor: 1,
  priority: -1,
  createdAt: 1,
});
SportsQueueSchema.index({ status: 1, nextAttemptAt: 1, priority: -1 });
SportsQueueSchema.index({ type: 1, status: 1, priority: -1, scheduledFor: 1, createdAt: 1 });
SportsQueueSchema.index({ type: 1, status: 1, nextAttemptAt: 1, priority: -1 });
SportsQueueSchema.index({
  'scope.bootstrapRunId': 1,
  'scope.bootstrapPhase': 1,
  status: 1,
  type: 1,
});
SportsQueueSchema.index({
  'scope.leagueId': 1,
  'scope.seasonYear': 1,
  type: 1,
  status: 1,
});
SportsQueueSchema.index({ 'scope.teamId': 1, type: 1, status: 1 });
SportsQueueSchema.index({ 'scope.fixtureId': 1, type: 1, status: 1 });
SportsQueueSchema.index({
  'scope.fixtureId': 1,
  type: 1,
  'scope.youtubeAttempt': 1,
  status: 1,
});
SportsQueueSchema.index({ triggerEventId: 1, type: 1 });
SportsQueueSchema.index({ status: 1, leaseExpiresAt: 1 });





