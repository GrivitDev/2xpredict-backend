import { Module } from '@nestjs/common';

import { ConfigModule, ConfigService } from '@nestjs/config';

import { MongooseModule } from '@nestjs/mongoose';

import { ScheduleModule } from '@nestjs/schedule';

import { AuthModule } from './auth/auth.module';

import { UsersModule } from './users/users.module';

import { OtpModule } from './otp/otp.module';

import { PaymentsModule } from './payments/payments.module';

import { SubscriptionsModule } from './subscriptions/subscriptions.module';

import { UploadsModule } from './uploads/uploads.module';

import { AnalyticsModule } from './analytics/analytics.module';

import { SportsModule } from './sports/sports.module';
import { UserSessionModule } from './user-session/user-session.module';

import { AdminUsersModule } from './admin-users/admin-users.module';

import { TelegramModule } from './telegram/telegram.module';
import { PlanConfigModule } from './plan-config/plan-config.module';
import { AdsModule } from './ads/ads.module';
import { InternalAdsModule } from './internal-ads/internal-ads.module';
import { ReferralsModule } from './referrals/referrals.module';
import { EmailModule } from './notifications/email.module';
import { PaymentGatewaysModule } from './payment-gateways/payment-gateways.module';

import { WebsiteAnalyticsModule } from './website-analytics/website-analytics.module';

import { PredictionsEngineModule } from './predictions-engine/predictions-engine.module';
import { BetLabModule } from './bet-lab/bet-lab.module';
import { SystemMonitorModule } from './system-monitor/system-monitor.module';
import { RealtimeModule } from './realtime/realtime.module';
import { BonusesModule } from './bonuses/bonuses.module';
import { CustomerCareModule } from './customer-care/customer-care.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    ScheduleModule.forRoot(),

    MongooseModule.forRootAsync({
      imports: [ConfigModule],

      inject: [ConfigService],

      useFactory: (configService: ConfigService) => ({
        uri: configService.getOrThrow<string>('MONGODB_URI'),
        monitorCommands: true,
      }),
    }),

    AuthModule,

    UsersModule,

    OtpModule,

    PaymentsModule,

    SubscriptionsModule,

    UploadsModule,

    AnalyticsModule,
    AdminUsersModule,

    UserSessionModule,
    TelegramModule,
    PlanConfigModule,

    SportsModule,

    AdsModule,
    EmailModule,
    InternalAdsModule,
    PaymentGatewaysModule,

    ReferralsModule,

    PredictionsEngineModule,

    BetLabModule,

    WebsiteAnalyticsModule,

    // Central in-memory monitoring, MongoDB command telemetry, and storage snapshots.
    SystemMonitorModule,
    RealtimeModule,
    BonusesModule,
    CustomerCareModule,
  ],
})
export class AppModule {}
