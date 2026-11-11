import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { HydratedDocument, Types } from 'mongoose';

import { AnalyticsEventType } from '../enums/analytics-event-type.enum';

import { AnalyticsVisitorType } from '../enums/analytics-visitor-type.enum';

export type AnalyticsEventDocument = HydratedDocument<AnalyticsEvent>;

@Schema({
  timestamps: true,
  collection: 'analytics_events',
})
export class AnalyticsEvent {
  // ==========================================
  // EVENT ID
  // ==========================================

  @Prop({
    required: true,
    unique: true,
    index: true,
  })
  eventId!: string;

  // ==========================================
  // IDENTIFICATION
  // ==========================================

  @Prop({
    type: Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  })
  userId?: Types.ObjectId | null;

  @Prop({
    required: true,
    index: true,
  })
  visitorId!: string;

  @Prop({
    required: true,
    index: true,
  })
  sessionId!: string;

  @Prop({
    type: String,
    enum: AnalyticsVisitorType,
    required: true,
    index: true,
  })
  visitorType!: AnalyticsVisitorType;

  // ==========================================
  // EVENT
  // ==========================================

  @Prop({
    type: String,
    enum: AnalyticsEventType,
    required: true,
    index: true,
  })
  eventType!: AnalyticsEventType;

  @Prop({
    required: true,
    index: true,
  })
  eventName!: string;

  // ==========================================
  // PAGE
  // ==========================================

  @Prop({
    required: true,
    index: true,
  })
  path!: string;

  @Prop({
    default: '',
  })
  pageTitle!: string;

  @Prop({
    default: '',
  })
  url!: string;

  // ==========================================
  // EVENT DATA
  // ==========================================

  @Prop({
    type: Object,
    default: {},
  })
  properties!: Record<string, unknown>;

  // ==========================================
  // TIME
  // ==========================================

  @Prop({
    type: Date,
    required: true,
    index: true,
  })
  occurredAt!: Date;

  @Prop({
    default: 0,
  })
  durationMs!: number;

  // ==========================================
  // DEVICE
  // ==========================================

  @Prop({
    default: '',
  })
  deviceType!: string;

  @Prop({
    default: '',
  })
  browser!: string;

  @Prop({
    default: '',
  })
  operatingSystem!: string;

  @Prop({
    default: 0,
  })
  screenWidth!: number;

  @Prop({
    default: 0,
  })
  screenHeight!: number;

  // ==========================================
  // TRAFFIC SOURCE
  // ==========================================

  @Prop({
    default: '',
  })
  referrer!: string;

  @Prop({
    default: '',
  })
  utmSource!: string;

  @Prop({
    default: '',
  })
  utmMedium!: string;

  @Prop({
    default: '',
  })
  utmCampaign!: string;

  @Prop({
    default: '',
  })
  utmTerm!: string;

  @Prop({
    default: '',
  })
  utmContent!: string;

  // ==========================================
  // LOCATION
  // ==========================================

  @Prop({
    default: '',
  })
  country!: string;

  @Prop({
    default: '',
  })
  countryCode!: string;

  @Prop({
    default: '',
  })
  region!: string;

  @Prop({
    default: '',
  })
  city!: string;

  // ==========================================
  // TECHNICAL
  // ==========================================

  @Prop({
    default: '',
  })
  userAgent!: string;
}

export const AnalyticsEventSchema =
  SchemaFactory.createForClass(AnalyticsEvent);

// ==========================================
// INDEXES
// ==========================================

AnalyticsEventSchema.index({
  occurredAt: -1,
});

AnalyticsEventSchema.index({
  visitorId: 1,
  occurredAt: -1,
});

AnalyticsEventSchema.index({
  sessionId: 1,
  occurredAt: -1,
});

AnalyticsEventSchema.index({
  userId: 1,
  occurredAt: -1,
});

AnalyticsEventSchema.index({
  path: 1,
  occurredAt: -1,
});

AnalyticsEventSchema.index({
  eventType: 1,
  occurredAt: -1,
});

AnalyticsEventSchema.index({
  visitorType: 1,
  occurredAt: -1,
});

