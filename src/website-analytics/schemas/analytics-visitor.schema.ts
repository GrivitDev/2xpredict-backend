import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { AnalyticsVisitorType } from '../enums/analytics-visitor-type.enum';

@Schema({ _id: false })
export class AnalyticsRecentActivity {
  @Prop({ required: true }) eventId!: string;
  @Prop({ required: true }) sessionId!: string;
  @Prop({ required: true }) eventType!: string;
  @Prop({ required: true }) eventName!: string;
  @Prop({ required: true }) path!: string;
  @Prop({ required: true }) occurredAt!: Date;
  @Prop({ default: 0 }) durationMs!: number;
  @Prop({ type: Object, default: {} }) properties!: Record<string, unknown>;
}
export const AnalyticsRecentActivitySchema = SchemaFactory.createForClass(AnalyticsRecentActivity);

@Schema({ _id: false })
export class AnalyticsRecentSession {
  @Prop({ required: true }) sessionId!: string;
  @Prop({ required: true }) startedAt!: Date;
  @Prop({ required: true }) lastActiveAt!: Date;
  @Prop({ type: Date, default: null }) endedAt?: Date | null;
  @Prop({ default: 0 }) durationMs!: number;
  @Prop({ default: 0 }) activeTimeMs!: number;
  @Prop({ default: 0 }) pageViews!: number;
  @Prop({ default: 0 }) eventCount!: number;
  @Prop({ default: '' }) landingPage!: string;
  @Prop({ default: '' }) exitPage!: string;
  @Prop({ default: false }) bounced!: boolean;
  @Prop({ default: true }) isActive!: boolean;
}
export const AnalyticsRecentSessionSchema = SchemaFactory.createForClass(AnalyticsRecentSession);

export type AnalyticsVisitorDocument = HydratedDocument<AnalyticsVisitor>;

/**
 * One summary document per registered account (visitorId=user:<ObjectId>) or
 * per anonymous browser identity. Activity is updated in-place; no event or
 * session document is inserted for each interaction.
 */
@Schema({ timestamps: true, collection: 'analytics_visitors', versionKey: false })
export class AnalyticsVisitor {
  @Prop({ required: true, unique: true, index: true }) visitorId!: string;
  @Prop({ type: Types.ObjectId, ref: 'User', default: null, index: true }) userId?: Types.ObjectId | null;
  @Prop({ enum: AnalyticsVisitorType, required: true, index: true }) visitorType!: AnalyticsVisitorType;

  @Prop({ default: 0 }) totalSessions!: number;
  @Prop({ default: 0 }) totalPageViews!: number;
  @Prop({ default: 0 }) totalEvents!: number;
  @Prop({ default: 0 }) totalActiveTimeMs!: number;

  @Prop({ type: Date, default: null, index: true }) firstSeenAt?: Date | null;
  @Prop({ type: Date, default: null, index: true }) lastSeenAt?: Date | null;
  @Prop({ default: '' }) lastPath!: string;
  /** Bounded day keys support accurate distinct-visitor reports for the latest 400 days. */
  @Prop({ type: [String], default: [] }) recentActiveDayKeys!: string[];

  @Prop({ default: '' }) deviceType!: string;
  @Prop({ default: '' }) browser!: string;
  @Prop({ default: '' }) operatingSystem!: string;
  @Prop({ default: 0 }) screenWidth!: number;
  @Prop({ default: 0 }) screenHeight!: number;

  @Prop({ default: '' }) country!: string;
  @Prop({ default: '' }) countryCode!: string;
  @Prop({ default: '' }) region!: string;
  @Prop({ default: '' }) city!: string;

  @Prop({ default: '' }) firstReferrer!: string;
  @Prop({ default: '' }) firstUtmSource!: string;
  @Prop({ default: '' }) firstUtmMedium!: string;
  @Prop({ default: '' }) firstUtmCampaign!: string;
  @Prop({ default: '' }) lastReferrer!: string;
  @Prop({ default: '' }) lastUtmSource!: string;
  @Prop({ default: '' }) lastUtmMedium!: string;
  @Prop({ default: '' }) lastUtmCampaign!: string;

  /** Bounded idempotency windows; only recent event/session ids are retained. */
  @Prop({ type: [String], default: [] }) recentEventIds!: string[];
  @Prop({ type: [String], default: [] }) recentSessionIds!: string[];
  @Prop({ type: [String], default: [] }) endedSessionIds!: string[];

  /** Recent detail is bounded. Lifetime page counters stay as compact maps. */
  @Prop({ type: [AnalyticsRecentActivitySchema], default: [] }) recentActivity!: AnalyticsRecentActivity[];
  @Prop({ type: [AnalyticsRecentSessionSchema], default: [] }) recentSessions!: AnalyticsRecentSession[];
  @Prop({ type: Map, of: Number, default: {} }) pageViewsByPath!: Map<string, number>;
  @Prop({ type: Map, of: String, default: {} }) pagePathLabels!: Map<string, string>;
  @Prop({ type: Map, of: Number, default: {} }) eventCountsByType!: Map<string, number>;
  @Prop({ type: Map, of: String, default: {} }) eventTypeLabels!: Map<string, string>;
  @Prop({ type: Map, of: Number, default: {} }) eventCountsByName!: Map<string, number>;
  @Prop({ type: Map, of: String, default: {} }) eventNameLabels!: Map<string, string>;
}

export const AnalyticsVisitorSchema = SchemaFactory.createForClass(AnalyticsVisitor);
AnalyticsVisitorSchema.index({ lastSeenAt: -1 });
AnalyticsVisitorSchema.index({ userId: 1, lastSeenAt: -1 });
AnalyticsVisitorSchema.index({ visitorType: 1, lastSeenAt: -1 });
AnalyticsVisitorSchema.index({ countryCode: 1, lastSeenAt: -1 });
