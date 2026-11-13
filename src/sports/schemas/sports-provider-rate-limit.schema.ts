import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SportsProviderRateLimitDocument =
  HydratedDocument<SportsProviderRateLimit>;

@Schema({
  timestamps: true,
  collection: 'sports_provider_rate_limits',
})
export class SportsProviderRateLimit {
  /**
   * Provider name.
   *
   * Multiple records can exist for the same provider,
   * one for each endpoint.
   */
  @Prop({
    required: true,
    trim: true,
  })
  provider!: string;

  /**
   * Logical endpoint identifier used by the rate limiter.
   *
   * Examples:
   *
   * ESPN:
   *   leagues
   *   league
   *   scoreboard
   *   standings
   *   match
   *   summary
   *   live-scoreboard
   *   news
   *
   *
   * Odds API:
   *   sports
   *   odds
   *
   * YouTube:
   *   search
   *
   * Query parameters are deliberately excluded.
   */
  @Prop({
    required: true,
    trim: true,
  })
  endpoint!: string;

  /**
   * Last outbound request timestamp for this
   * provider + endpoint.
   */
  @Prop({
    type: Date,
    index: true,
  })
  lastRequestAt?: Date;

  /**
   * Current UTC day: YYYY-MM-DD
   *
   * Used by provider-wide quota accounting.
   */
  @Prop({
    required: true,
    default: '',
    index: true,
  })
  dailyPeriod!: string;

  /**
   * Requests used during dailyPeriod.
   *
   * Quota counters belong to the provider quota
   * record rather than an individual endpoint.
   */
  @Prop({
    required: true,
    default: 0,
    min: 0,
  })
  dailyRequests!: number;

  /**
   * Optional hard stop for provider-reported or internally exhausted daily
   * quotas. It survives UTC counter rollover so YouTube searches cannot resume
   * in the middle of the user's Nigerian calendar day.
   */
  @Prop({
    type: Date,
    index: true,
  })
  quotaBlockedUntil?: Date;

  /**
   * Current UTC month: YYYY-MM
   *
   * Used by provider-wide quota accounting.
   */
  @Prop({
    required: true,
    default: '',
    index: true,
  })
  monthlyPeriod!: string;

  /**
   * Requests used during monthlyPeriod.
   */
  @Prop({
    required: true,
    default: 0,
    min: 0,
  })
  monthlyRequests!: number;
}

export const SportsProviderRateLimitSchema = SchemaFactory.createForClass(
  SportsProviderRateLimit,
);

/**
 * One rate-limit record per provider + endpoint.
 *
 * This is the canonical lookup and uniqueness index
 * for rate-limit records.
 */
SportsProviderRateLimitSchema.index(
  {
    provider: 1,
    endpoint: 1,
  },
  {
    unique: true,
  },
);
