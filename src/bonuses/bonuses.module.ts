import { Module } from '@nestjs/common';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { BetLabModule } from '../bet-lab/bet-lab.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { UsersModule } from '../users/users.module';
import { BonusesAdminController } from './controllers/bonuses-admin.controller';
import { BonusesController } from './controllers/bonuses.controller';
import { BonusGrant, BonusGrantSchema } from './schemas/bonus-grant.schema';
import { BonusBulkGrantJob, BonusBulkGrantJobSchema } from './schemas/bonus-bulk-grant-job.schema';
import { BonusesService } from './bonuses.service';

import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BonusGrant.name, schema: BonusGrantSchema },
      { name: BonusBulkGrantJob.name, schema: BonusBulkGrantJobSchema },
    ]),
    AuthModule,
    BetLabModule,
    SubscriptionsModule,
    UsersModule,
  ],
  controllers: [BonusesAdminController, BonusesController],
  providers: [
    adminRealtimeRegistrationProvider('bonuses', 'Bonuses: bonus grants and reward processing.'),
    BonusesService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [BonusesService],
})
export class BonusesModule {}

