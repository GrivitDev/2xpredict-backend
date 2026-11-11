import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { HydratedDocument, Types } from 'mongoose';

import { AnalyticsVisitorType } from '../enums/analytics-visitor-type.enum';

export type AnalyticsSessionDocument = HydratedDocument<AnalyticsSession>;

@Schema({
  timestamps: true,
  collection: 'analytics_sessions',
})
export class AnalyticsSession {
  // ==========================================
  // IDENTIFICATION
  // ==========================================

  @Prop({
    required: true,
    unique: true,
    index: true,
  })
  sessionId!: string;

  @Prop({
    required: true,
    index: true,
  })
  visitorId!: string;

  @Prop({
    type: Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  })
  userId?: Types.ObjectId | null;

  @Prop({
    type: String,
    enum: AnalyticsVisitorType,
    required: true,
    index: true,
  })
  visitorType!: AnalyticsVisitorType;

  // ==========================================
  // SESSION TIME
  // ==========================================

  @Prop({
    type: Date,
    required: true,
    index: true,
  })
  startedAt!: Date;

  @Prop({
    type: Date,
    required: true,
    index: true,
  })
  lastActiveAt!: Date;

  @Prop({
    type: Date,
    default: null,
  })
  endedAt?: Date | null;

  @Prop({
    default: 0,
  })
  durationMs!: number;

  @Prop({
    default: 0,
  })
  activeTimeMs!: number;

  // ==========================================
  // PAGE ACTIVITY
  // ==========================================

  @Prop({
    default: '',
  })
  landingPage!: string;

  @Prop({
    default: '',
  })
  exitPage!: string;

  @Prop({
    default: '',
  })
  currentPage!: string;

  @Prop({
    default: 0,
  })
  pageViews!: number;

  @Prop({
    default: 0,
  })
  eventCount!: number;

  // ==========================================
  // SESSION QUALITY
  // ==========================================

  @Prop({
    default: false,
  })
  bounced!: boolean;

  @Prop({
    default: false,
    index: true,
  })
  isActive!: boolean;

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
}

export const AnalyticsSessionSchema =
  SchemaFactory.createForClass(AnalyticsSession);

// ==========================================
// INDEXES
// ==========================================

AnalyticsSessionSchema.index({
  visitorId: 1,
  startedAt: -1,
});

AnalyticsSessionSchema.index({
  userId: 1,
  startedAt: -1,
});

AnalyticsSessionSchema.index({
  startedAt: -1,
});

AnalyticsSessionSchema.index({
  lastActiveAt: -1,
});

AnalyticsSessionSchema.index({
  isActive: 1,
  lastActiveAt: -1,
});

AnalyticsSessionSchema.index({
  visitorType: 1,
  startedAt: -1,
});

AnalyticsSessionSchema.index({
  landingPage: 1,
  startedAt: -1,
});

AnalyticsSessionSchema.index({
  exitPage: 1,
  startedAt: -1,
});

