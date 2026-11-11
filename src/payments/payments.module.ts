import { Module } from '@nestjs/common';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../common/guards/email-verified.guard';
import { MongooseModule } from '@nestjs/mongoose';

import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentProcessingWorker } from './payment-processing.worker';

import { Payment, PaymentSchema } from './schemas/payment.schema';

import { UsersModule } from '../users/users.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { PlanConfigModule } from '../plan-config/plan-config.module';
import { EmailModule } from '../notifications/email.module';
import { PromosModule } from '../promos/promos.module';

import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';
@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: Payment.name,
        schema: PaymentSchema,
      },
    ]),

    UsersModule,
    SubscriptionsModule,
    RealtimeModule,
    ReferralsModule,
    PlanConfigModule,
    EmailModule,
    PromosModule,
  ],

  controllers: [PaymentsController],
  providers: [
    adminRealtimeRegistrationProvider('payments', 'Payments: manual payments, gateway updates and payment processing events.'),
    PaymentsService,
    PaymentProcessingWorker,
    JwtAuthGuard,
    EmailVerifiedGuard,
    RolesGuard,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}



