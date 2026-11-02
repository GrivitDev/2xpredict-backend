import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsersModule } from '../users/users.module';
import { PaymentsModule } from '../payments/payments.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { UserSessionModule } from '../user-session/user-session.module';
import { BetLabModule } from '../bet-lab/bet-lab.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { PromosModule } from '../promos/promos.module';
import { BonusesModule } from '../bonuses/bonuses.module';
import { WebsiteAnalyticsModule } from '../website-analytics/website-analytics.module';
import { PredictionAccessModule } from '../prediction-access/prediction-access.module';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminUserAudit, AdminUserAuditSchema } from './schemas/admin-user-audit.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AdminUserAudit.name, schema: AdminUserAuditSchema },
    ]),
    UsersModule,
    PaymentsModule,
    SubscriptionsModule,
    UserSessionModule,
    BetLabModule,
    ReferralsModule,
    PromosModule,
    BonusesModule,
    WebsiteAnalyticsModule,
    PredictionAccessModule,
  ],
  controllers: [AdminUsersController],
  providers: [AdminUsersService, JwtAuthGuard, RolesGuard],
})
export class AdminUsersModule {}
