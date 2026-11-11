import { Prop, Schema as NestSchema, SchemaFactory } from '@nestjs/mongoose';

import type { SportsDataProvider, SportsFixtureState } from '../../interfaces/sports-domain.interface';

@NestSchema({ _id: false })
export class SportsSourceMetadataEmbedded {
  @Prop({ required: true, type: String, enum: ['ESPN', 'ODDS_API'] })
  provider!: SportsDataProvider;

  @Prop({ type: String, trim: true })
  providerId?: string;

  @Prop({ required: true, type: String, trim: true })
  endpoint!: string;

  @Prop({ required: true, type: Date })
  collectedAt!: Date;

  @Prop({ type: Date })
  providerUpdatedAt?: Date;
}
export const SportsSourceMetadataSchema = SchemaFactory.createForClass(SportsSourceMetadataEmbedded);

@NestSchema({ _id: false })
export class SportsFixtureStatusEmbedded {
  @Prop({ required: true, type: String, enum: ['SCHEDULED', 'LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES', 'COMPLETED', 'POSTPONED', 'CANCELLED', 'ABANDONED', 'UNKNOWN'] })
  state!: SportsFixtureState;

  @Prop({ type: String }) providerState?: string;
  @Prop({ type: String }) name?: string;
  @Prop({ type: String }) description?: string;
  @Prop({ type: String }) shortDescription?: string;
  @Prop({ type: Number, min: 0 }) period?: number;
  @Prop({ type: String }) clock?: string;
  @Prop({ type: String }) displayClock?: string;
  @Prop({ required: true, type: Boolean, default: false }) isFinal!: boolean;
}
export const SportsFixtureStatusSchema = SchemaFactory.createForClass(SportsFixtureStatusEmbedded);

@NestSchema({ _id: false })
export class SportsFixtureCompetitorEmbedded {
  @Prop({ required: true, type: String, trim: true }) teamId!: string;
  @Prop({ type: String, trim: true }) espnCompetitorId?: string;
  @Prop({ required: true, type: String, enum: ['HOME', 'AWAY'] }) homeAway!: 'HOME' | 'AWAY';
  @Prop({ type: Number, min: 0, default: null }) score?: number | null;
  @Prop({ type: Boolean }) winner?: boolean;
  @Prop({ type: String, trim: true }) form?: string;
  @Prop({ type: [Object], default: [] }) records?: Array<Record<string, unknown>>;
  @Prop({ type: [Object], default: [] }) statistics?: Array<Record<string, unknown>>;
  @Prop({ type: [Object], default: [] }) leaders?: Array<Record<string, unknown>>;
  @Prop({ type: Object }) rawPayload?: Record<string, unknown>;
}
export const SportsFixtureCompetitorSchema = SchemaFactory.createForClass(SportsFixtureCompetitorEmbedded);

@NestSchema({ _id: false })
export class SportsFixturePeriodScoreEmbedded {
  @Prop({ required: true, type: String, trim: true }) teamId!: string;
  @Prop({ required: true, type: Number, min: 1 }) period!: number;
  @Prop({ required: true, type: Number, min: 0 }) score!: number;
}
export const SportsFixturePeriodScoreSchema = SchemaFactory.createForClass(SportsFixturePeriodScoreEmbedded);

@NestSchema({ _id: false })
export class SportsTimelineScoreEmbedded {
  @Prop({ required: true, type: Number, min: 0 }) home!: number;
  @Prop({ required: true, type: Number, min: 0 }) away!: number;
}
export const SportsTimelineScoreSchema = SchemaFactory.createForClass(SportsTimelineScoreEmbedded);

@NestSchema({ _id: false })
export class SportsOddsOutcomeEmbedded {
  @Prop({ required: true, type: String, trim: true }) selection!: string;
  @Prop({ required: true, type: Number, min: 1 }) price!: number;
  @Prop({ type: Number, default: null }) point?: number | null;
  @Prop({ type: Boolean, default: false }) isSuspended?: boolean;
}
export const SportsOddsOutcomeSchema = SchemaFactory.createForClass(SportsOddsOutcomeEmbedded);

@NestSchema({ _id: false })
export class SportsOddsMarketEmbedded {
  @Prop({ type: String, trim: true }) marketId?: string;
  @Prop({ required: true, type: String, trim: true }) marketKey!: string;
  @Prop({ required: true, type: String, trim: true }) marketName!: string;
  @Prop({ type: [SportsOddsOutcomeSchema], default: [] }) outcomes!: SportsOddsOutcomeEmbedded[];
  @Prop({ type: Date }) providerUpdatedAt?: Date;
}
export const SportsOddsMarketSchema = SchemaFactory.createForClass(SportsOddsMarketEmbedded);

@NestSchema({ _id: false })
export class SportsOddsBookmakerEmbedded {
  @Prop({ type: String, trim: true }) bookmakerId?: string;
  @Prop({ required: true, type: String, trim: true }) bookmakerName!: string;
  @Prop({ type: Number }) priority?: number;
  @Prop({ type: [SportsOddsMarketSchema], default: [] }) markets!: SportsOddsMarketEmbedded[];
}
export const SportsOddsBookmakerSchema = SchemaFactory.createForClass(SportsOddsBookmakerEmbedded);
