import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';

import { MongooseModule } from '@nestjs/mongoose';

import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsMonitorService } from './subscriptions-monitor.service';
import {
  Subscription,
  SubscriptionSchema,
} from './schemas/subscription.schema';
import { UsersModule } from '../users/users.module';
import { SubscriptionsScheduler } from './subscriptions.scheduler';
import { EmailModule } from '../notifications/email.module';
import { PlanConfigModule } from '../plan-config/plan-config.module';
import { BonusGrant, BonusGrantSchema } from '../bonuses/schemas/bonus-grant.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Subscription.name, schema: SubscriptionSchema },
      { name: BonusGrant.name, schema: BonusGrantSchema },
      { name: User.name, schema: UserSchema },
    ]),
    UsersModule,
    EmailModule,
    PlanConfigModule,
  ],
  controllers: [SubscriptionsController],
  providers: [
    adminRealtimeRegistrationProvider(
      'subscriptions',
      'Subscriptions: subscription lifecycle and renewal operations.',
    ),
    SubscriptionsService,
    SubscriptionsMonitorService,
    SubscriptionsScheduler,
    JwtAuthGuard,
    OptionalJwtAuthGuard,
    RolesGuard,
  ],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}

