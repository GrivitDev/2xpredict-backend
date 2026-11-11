import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';
import { EmailService } from './email.service';

@Module({
  imports: [ConfigModule],
  providers: [
    adminRealtimeRegistrationProvider(
      'email',
      'Transactional email provider integration; Resend credentials are checked when a delivery is requested.',
    ),
    EmailService,
  ],
  exports: [EmailService],
})
export class EmailModule {}
