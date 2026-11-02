import { forwardRef, Module } from '@nestjs/common';
import { RolesGuard } from '../common/guards/roles.guard';
import { MongooseModule } from '@nestjs/mongoose';

import { Referral, ReferralSchema } from './schemas/referral.schema';

import { ReferralsService } from './referrals.service';
import { ReferralsMonitorService } from './referrals-monitor.service';
import { ReferralsController } from './referrals.controller';

import { UsersModule } from '../users/users.module';
import { PromosModule } from '../promos/promos.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: Referral.name,
        schema: ReferralSchema,
      },
    ]),

    UsersModule,

    forwardRef(() => PromosModule),
  ],

  controllers: [ReferralsController],

  providers: [ReferralsService, ReferralsMonitorService, RolesGuard],

  exports: [ReferralsService],
})
export class ReferralsModule {}