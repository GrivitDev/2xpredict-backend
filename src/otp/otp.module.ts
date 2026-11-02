import { Module } from '@nestjs/common';

import { MongooseModule } from '@nestjs/mongoose';

import { OtpController } from './otp.controller';

import { OtpService } from './otp.service';

import { Otp, OtpSchema } from './schemas/otp.schema';

import { UsersModule } from '../users/users.module';

import { EmailService } from '../notifications/email.service';
import { EmailModule } from '../notifications/email.module';
import { TelegramModule } from '../telegram/telegram.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { PromosModule } from '../promos/promos.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: Otp.name,
        schema: OtpSchema,
      },
    ]),

    UsersModule,
    EmailModule,
    TelegramModule,
    ReferralsModule,
    PromosModule,
  ],

  controllers: [OtpController],

  providers: [OtpService, EmailService],

  exports: [OtpService],
})
export class OtpModule {}

