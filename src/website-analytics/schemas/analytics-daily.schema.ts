import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AnalyticsDailyDocument = HydratedDocument<AnalyticsDailyAggregate>;

/** One compact aggregate per UTC day, not one record per pageview/event. */
@Schema({ collection: 'analytics_daily_aggregates', timestamps: false, versionKey: false })
export class AnalyticsDailyAggregate {
  @Prop({ required: true, unique: true, index: true }) dayKey!: string;
  @Prop({ required: true, index: true }) date!: Date;
  @Prop({ default: 0 }) events!: number;
  @Prop({ default: 0 }) pageViews!: number;
  @Prop({ default: 0 }) sessions!: number;
  @Prop({ default: 0 }) endedSessions!: number;
  @Prop({ default: 0 }) bouncedSessions!: number;
  @Prop({ default: 0 }) totalActiveTimeMs!: number;
  @Prop({ default: 0 }) registeredEvents!: number;
  @Prop({ default: 0 }) anonymousEvents!: number;
  @Prop({ default: 0 }) conversions!: number;
  @Prop({ default: 0 }) uniqueVisitors!: number;
  @Prop({ default: 0 }) registeredUniqueVisitors!: number;
  @Prop({ default: 0 }) anonymousUniqueVisitors!: number;
  /** Bounded idempotency window used to make aggregate retries safe. */
  @Prop({ type: [String], default: [] }) recentEventIds!: string[];
  @Prop({ type: [String], default: [] }) recentUniqueVisitorIds!: string[];
  @Prop({ type: Map, of: Number, default: {} }) hourlyEventCounts!: Map<string, number>;

  @Prop({ type: Map, of: Number, default: {} }) eventTypeCounts!: Map<string, number>;
  @Prop({ type: Map, of: String, default: {} }) eventTypeLabels!: Map<string, string>;
  @Prop({ type: Map, of: Number, default: {} }) eventNameCounts!: Map<string, number>;
  @Prop({ type: Map, of: String, default: {} }) eventNameLabels!: Map<string, string>;
  @Prop({ type: Map, of: Number, default: {} }) pageViewCounts!: Map<string, number>;
  @Prop({ type: Map, of: String, default: {} }) pageLabels!: Map<string, string>;
  @Prop({ type: Map, of: Number, default: {} }) pageDurationMsByPath!: Map<string, number>;
  @Prop({ type: Map, of: Number, default: {} }) pageDurationCountByPath!: Map<string, number>;
  @Prop({ type: Map, of: String, default: {} }) pageDurationLabels!: Map<string, string>;
  @Prop({ type: Map, of: Number, default: {} }) entryPageCounts!: Map<string, number>;
  @Prop({ type: Map, of: String, default: {} }) entryPageLabels!: Map<string, string>;
  @Prop({ type: Map, of: Number, default: {} }) exitPageCounts!: Map<string, number>;
  @Prop({ type: Map, of: String, default: {} }) exitPageLabels!: Map<string, string>;
  @Prop({ type: Map, of: Number, default: {} }) sourceCounts!: Map<string, number>;
  @Prop({ type: Map, of: String, default: {} }) sourceLabels!: Map<string, string>;
  @Prop({ type: Map, of: Number, default: {} }) countryCounts!: Map<string, number>;
  @Prop({ type: Map, of: String, default: {} }) countryLabels!: Map<string, string>;
  @Prop({ type: Map, of: Number, default: {} }) cityCounts!: Map<string, number>;
  @Prop({ type: Map, of: String, default: {} }) cityLabels!: Map<string, string>;
  @Prop({ type: Map, of: Number, default: {} }) deviceCounts!: Map<string, number>;
  @Prop({ type: Map, of: String, default: {} }) deviceLabels!: Map<string, string>;
  @Prop({ type: Map, of: Number, default: {} }) browserCounts!: Map<string, number>;
  @Prop({ type: Map, of: String, default: {} }) browserLabels!: Map<string, string>;
  @Prop({ type: Map, of: Number, default: {} }) operatingSystemCounts!: Map<string, number>;
  @Prop({ type: Map, of: String, default: {} }) operatingSystemLabels!: Map<string, string>;
}

export const AnalyticsDailyAggregateSchema = SchemaFactory.createForClass(AnalyticsDailyAggregate);
AnalyticsDailyAggregateSchema.index({ date: -1 });
