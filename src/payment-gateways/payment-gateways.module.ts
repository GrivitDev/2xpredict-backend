import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../common/guards/email-verified.guard';
import { HttpModule } from '@nestjs/axios';

import { PaymentGatewaysController } from './payment-gateways.controller';
import { PaymentGatewaysService } from './payment-gateways.service';

import { PaymentsModule } from '../payments/payments.module';
import { UsersModule } from '../users/users.module';
import { TelegramModule } from '../telegram/telegram.module';

import { PaystackProvider } from './providers/paystack.provider';
import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import { ExchangeRateService } from './exchange-rate.service';

import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';
@Module({
  imports: [HttpModule, PaymentsModule, UsersModule, TelegramModule],

  controllers: [PaymentGatewaysController],

  providers: [
    adminRealtimeRegistrationProvider('payment-gateways', 'Payment Gateways: provider initialization and transaction processing.'),
    PaymentGatewaysService,
    ExchangeRateService,
    PaystackProvider,
    PaymentGatewayFactory,
    JwtAuthGuard,
    EmailVerifiedGuard,
  ],

  exports: [PaymentGatewaysService],
})
export class PaymentGatewaysModule {}

