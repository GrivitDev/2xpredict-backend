import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type { SportsDataChangedEvent } from '../../interfaces/sports-derived-data.interface';

export type SportsDataChangeEventStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
export type SportsDataChangeEventDocument = HydratedDocument<SportsDataChangeEvent>;

/**
 * Durable outbox record written alongside a normalized source-data change.
 * A consumer uses this event to refresh affected derived projections. Keeping
 * the event durable prevents process restarts from silently skipping updates.
 */
@Schema({ timestamps: true, collection: 'sports_data_change_events', versionKey: false })
export class SportsDataChangeEvent implements SportsDataChangedEvent {
  @Prop({ required: true, unique: true, trim: true })
  eventId!: string;

  @Prop({ required: true, type: String, enum: ['COMPETITION', 'SEASON', 'TEAM', 'VENUE', 'ATHLETE', 'FIXTURE', 'MATCH_STATISTICS', 'MATCH_LINEUP', 'TEAM_ROSTER', 'MATCH_TIMELINE', 'MATCH_ODDS'], index: true })
  entity!: SportsDataChangedEvent['entity'];

  @Prop({ required: true, trim: true, index: true })
  entityId!: string;

  @Prop({ type: [String], default: [] })
  competitionIds!: string[];

  @Prop({ type: [String], default: [] })
  seasonIds!: string[];

  @Prop({ type: [String], default: [] })
  teamIds!: string[];

  @Prop({ type: [String], default: [] })
  athleteIds!: string[];

  @Prop({ type: [String], default: [] })
  fixtureIds!: string[];

  @Prop({ required: true, type: Date, index: true })
  changedAt!: Date;

  @Prop({ required: true, type: Number, min: 1, index: true })
  revision!: number;

  @Prop({ required: true, trim: true, index: true })
  sourceFingerprint!: string;

  @Prop({ required: true, type: String, enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'], default: 'PENDING', index: true })
  status!: SportsDataChangeEventStatus;

  @Prop({ required: true, type: Number, min: 0, default: 0 })
  attempts!: number;

  @Prop({ type: Date, index: true })
  processedAt?: Date;

  @Prop({ type: Date, index: true })
  processingAt?: Date;

  @Prop({ type: Date, index: true })
  leaseExpiresAt?: Date;

  @Prop({ type: Date, index: true })
  nextAttemptAt?: Date;

  @Prop({ type: String, trim: true, index: true })
  ownerId?: string;

  @Prop({ type: String })
  lastError?: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsDataChangeEventSchema = SchemaFactory.createForClass(SportsDataChangeEvent);
SportsDataChangeEventSchema.index({ status: 1, changedAt: 1 });
SportsDataChangeEventSchema.index({ status: 1, leaseExpiresAt: 1 });
SportsDataChangeEventSchema.index({ entity: 1, entityId: 1, revision: -1 });

// MongoDB compound multikey indexes cannot index two array fields together.
// Keep the competition and season lookup paths as separate single-array indexes.
SportsDataChangeEventSchema.index({ competitionIds: 1, changedAt: -1 });
SportsDataChangeEventSchema.index({ seasonIds: 1, changedAt: -1 });

