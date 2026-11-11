import type { Schema as MongooseSchema } from 'mongoose';
import { AdDisplaySchema } from '../ads/schemas/ad-display.schema';
import { AdEventSchema } from '../ads/schemas/ad-event.schema';
import { InternalAdSchema } from '../internal-ads/schemas/internal-ad.schema';
import { PaymentSchema } from '../payments/schemas/payment.schema';
import { SubscriptionSchema } from '../subscriptions/schemas/subscription.schema';
import { UserSchema } from '../users/schemas/user.schema';
import { AnalyticsEventSchema } from '../website-analytics/schemas/analytics-event.schema';
import { AnalyticsSessionSchema } from '../website-analytics/schemas/analytics-session.schema';
import { SportsCompetitionSchema } from '../sports/schemas/domain/competition.schema';
import { PromoSchema } from '../promos/schemas/promo.schema';
import { PromoClaimSchema } from '../promos/schemas/promo-claim.schema';
import { PromoRewardSchema } from '../promos/schemas/promo-reward.schema';
import { AnalyticsVisitorSchema } from '../website-analytics/schemas/analytics-visitor.schema';

describe('Mongoose string-enum schema metadata', () => {
  const contracts: Array<{ label: string; schema: MongooseSchema; fields: string[] }> = [
    { label: 'SportsCompetition', schema: SportsCompetitionSchema, fields: ['type', 'region'] },
    { label: 'AdDisplay', schema: AdDisplaySchema, fields: ['page', 'position', 'trigger', 'device'] },
    { label: 'AdEvent', schema: AdEventSchema, fields: ['type'] },
    { label: 'InternalAd', schema: InternalAdSchema, fields: ['displayLevel'] },
    { label: 'Payment', schema: PaymentSchema, fields: ['currency', 'type'] },
    { label: 'Subscription', schema: SubscriptionSchema, fields: ['plan'] },
    { label: 'User', schema: UserSchema, fields: ['status', 'role'] },
    { label: 'AnalyticsEvent', schema: AnalyticsEventSchema, fields: ['visitorType', 'eventType'] },
    { label: 'AnalyticsSession', schema: AnalyticsSessionSchema, fields: ['visitorType'] },
    { label: 'AnalyticsVisitor', schema: AnalyticsVisitorSchema, fields: ['visitorType'] },
    { label: 'Promo', schema: PromoSchema, fields: ['campaignType', 'requirement', 'rewardPlan'] },
    { label: 'PromoClaim', schema: PromoClaimSchema, fields: ['verificationStatusAtClaim'] },
    { label: 'PromoReward', schema: PromoRewardSchema, fields: ['plan'] },
  ];

  it.each(contracts)('$label declares every string enum as a String path', ({ schema, fields }) => {
    for (const field of fields) {
      expect(schema.path(field)).toBeDefined();
      expect(schema.path(field)?.instance).toBe('String');
    }
  });
});
