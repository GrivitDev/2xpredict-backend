import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import type { SportsDataProvider } from '../../interfaces/sports-domain.interface';

export type SportsCollectionStateStatus = 'IDLE' | 'QUEUED' | 'PROCESSING' | 'SUCCEEDED' | 'NO_DATA' | 'FAILED' | 'DISABLED';
export type SportsCollectionScopeType = 'GLOBAL' | 'COMPETITION' | 'SEASON' | 'TEAM' | 'FIXTURE';
export type SportsFixtureValidationResult = 'FIXTURES_FOUND' | 'NO_FIXTURES_CONFIRMED' | 'RECOVERED_FROM_SUMMARY' | 'INCOMPLETE';
export type SportsCollectionStateDocument = HydratedDocument<SportsCollectionState>;

/** Durable freshness ledger and fixture-day validation record. */
@Schema({ timestamps: true, collection: 'sports_collection_states', versionKey: false })
export class SportsCollectionState {
  @Prop({ required: true, unique: true, trim: true }) collectionKey!: string;
  @Prop({ required: true, trim: true, index: true }) collectionType!: string;
  @Prop({ required: true, type: String, enum: ['GLOBAL', 'COMPETITION', 'SEASON', 'TEAM', 'FIXTURE'] }) scopeType!: SportsCollectionScopeType;
  @Prop({ required: true, trim: true }) scopeId!: string;
  @Prop({ required: true, type: String, enum: ['ESPN', 'ODDS_API'] }) provider!: SportsDataProvider;
  @Prop({ required: true, trim: true }) endpoint!: string;
  @Prop({ required: true, type: Number, min: 0 }) intervalMs!: number;
  @Prop({ required: true, type: Boolean, default: true }) enabled!: boolean;
  @Prop({ required: true, type: String, enum: ['IDLE', 'QUEUED', 'PROCESSING', 'SUCCEEDED', 'NO_DATA', 'FAILED', 'DISABLED'], default: 'IDLE' }) status!: SportsCollectionStateStatus;
  @Prop({ type: Date, index: true }) lastScheduledAt?: Date;
  @Prop({ type: Date, index: true }) lastStartedAt?: Date;
  @Prop({ type: Date, index: true }) lastSuccessfulAt?: Date;
  @Prop({ type: Date, index: true }) nextRunAt?: Date;
  @Prop({ type: Number, min: 0, default: 0 }) failureCount!: number;
  @Prop({ type: Number, min: 0, default: 0 }) dataRevision!: number;
  @Prop({ type: String }) lastError?: string;

  @Prop({ type: String, enum: ['FIXTURES_FOUND', 'NO_FIXTURES_CONFIRMED', 'RECOVERED_FROM_SUMMARY', 'INCOMPLETE'] }) validationResult?: SportsFixtureValidationResult;
  @Prop({ type: Number, min: 0 }) receivedCount?: number;
  @Prop({ type: Number, min: 0 }) persistedCount?: number;
  @Prop({ type: Number, min: 0 }) missingCount?: number;
  @Prop({ type: Date }) validatedAt?: Date;
  @Prop({ type: Object }) resultSummary?: Record<string, unknown>;
  /** Latest complete provider response for this collection scope. */
  @Prop({ type: Object }) lastRawResponse?: Record<string, unknown>;
  @Prop({ type: Date }) lastRawResponseAt?: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const SportsCollectionStateSchema = SchemaFactory.createForClass(SportsCollectionState);
SportsCollectionStateSchema.index({ enabled: 1, status: 1, nextRunAt: 1 });
SportsCollectionStateSchema.index({ scopeType: 1, scopeId: 1, collectionType: 1 }, { unique: true });
