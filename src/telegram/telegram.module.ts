import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';
import { TelegramService } from './telegram.service';

@Module({
  imports: [ConfigModule],
  providers: [
    adminRealtimeRegistrationProvider(
      'telegram',
      'Telegram: AI-generated public-channel broadcasts only.',
    ),
    TelegramService,
  ],
  exports: [TelegramService],
})
export class TelegramModule {}
