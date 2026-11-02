import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { UserHandler } from './handlers/user.handler';
import { PaymentHandler } from './handlers/payment.handler';
import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';
@Module({
  providers: [
    adminRealtimeRegistrationProvider('telegram', 'Telegram: notification delivery and integration operations.'),
    TelegramService, UserHandler, PaymentHandler,
  ],
  exports: [TelegramService],
})
export class TelegramModule {}
