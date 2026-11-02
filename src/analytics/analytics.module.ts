import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsOverviewService } from './analytics-overview.service';
import { AnalyticsRevenueService } from './analytics-revenue.service';
import { AnalyticsLeaderboardService } from './analytics-leaderboard.service';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Payment, PaymentSchema } from '../payments/schemas/payment.schema';
import { Subscription, SubscriptionSchema } from '../subscriptions/schemas/subscription.schema';
import { Referral, ReferralSchema } from '../referrals/schemas/referral.schema';
import { Promo, PromoSchema } from '../promos/schemas/promo.schema';
import { Ad, AdSchema } from '../ads/schemas/ad.schema';
import { MarketPrediction, MarketPredictionSchema } from '../predictions-engine/schemas/market-prediction.schema';
import { CuratedPrediction, CuratedPredictionSchema } from '../predictions-engine/schemas/curated-prediction.schema';
import { ActiveCompetition, ActiveCompetitionSchema } from '../sports/schemas/active-competition.schema';
import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: Subscription.name, schema: SubscriptionSchema },
      { name: Referral.name, schema: ReferralSchema },
      { name: Promo.name, schema: PromoSchema },
      { name: Ad.name, schema: AdSchema },
      { name: MarketPrediction.name, schema: MarketPredictionSchema },
      { name: CuratedPrediction.name, schema: CuratedPredictionSchema },
      { name: ActiveCompetition.name, schema: ActiveCompetitionSchema },
    ]),
  ],
  controllers: [AnalyticsController],
  providers: [
    adminRealtimeRegistrationProvider('analytics', 'Business Analytics: revenue, subscriptions, referrals, and conversion reporting.'),
    AnalyticsService,
    AnalyticsOverviewService,
    AnalyticsRevenueService,
    AnalyticsLeaderboardService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
