import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SportsModule } from '../sports/sports.module';
import { OddsModule } from '../odds/odds.module';
import { SettlementModule } from '../settlement/settlement.module';
import { BetLabModule } from '../bet-lab/bet-lab.module';

import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsOverviewService } from './analytics-overview.service';
import { AnalyticsRevenueService } from './analytics-revenue.service';
import { AnalyticsLeaderboardService } from './analytics-leaderboard.service';
import { AnalyticsOperationsService } from './analytics-operations.service';

import { User, UserSchema } from '../users/schemas/user.schema';
import { Payment, PaymentSchema } from '../payments/schemas/payment.schema';
import { Subscription, SubscriptionSchema } from '../subscriptions/schemas/subscription.schema';
import { Referral, ReferralSchema } from '../referrals/schemas/referral.schema';
import { Promo, PromoSchema } from '../promos/schemas/promo.schema';
import { Ad, AdSchema } from '../ads/schemas/ad.schema';
import { MarketPrediction, MarketPredictionSchema } from '../predictions-engine/schemas/market-prediction.schema';
import { CuratedPrediction, CuratedPredictionSchema } from '../predictions-engine/schemas/curated-prediction.schema';
import { PredictionQueue, PredictionQueueSchema } from '../predictions-engine/schemas/prediction-queue.schema';
import { PredictionRun, PredictionRunSchema } from '../predictions-engine/schemas/prediction-run.schema';
import { MarketCalibration, MarketCalibrationSchema } from '../predictions-engine/schemas/market-calibration.schema';
import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';

@Module({
  imports: [
    SportsModule,
    OddsModule,
    forwardRef(() => SettlementModule),
    forwardRef(() => BetLabModule),
    // Read-side reporting models only. Mutations remain in their owning domain modules.
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: Subscription.name, schema: SubscriptionSchema },
      { name: Referral.name, schema: ReferralSchema },
      { name: Promo.name, schema: PromoSchema },
      { name: Ad.name, schema: AdSchema },
      { name: MarketPrediction.name, schema: MarketPredictionSchema },
      { name: CuratedPrediction.name, schema: CuratedPredictionSchema },
      { name: PredictionQueue.name, schema: PredictionQueueSchema },
      { name: PredictionRun.name, schema: PredictionRunSchema },
      { name: MarketCalibration.name, schema: MarketCalibrationSchema },
    ]),
  ],
  controllers: [AnalyticsController],
  providers: [
    adminRealtimeRegistrationProvider(
      'analytics',
      'Business Analytics: revenue, subscriptions, prediction operations, Sports/Odds coverage, settlement and Bet Lab reporting.',
    ),
    AnalyticsService,
    AnalyticsOverviewService,
    AnalyticsRevenueService,
    AnalyticsLeaderboardService,
    AnalyticsOperationsService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}

