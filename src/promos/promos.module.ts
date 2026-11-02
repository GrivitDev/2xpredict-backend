import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RolesGuard } from '../common/guards/roles.guard';
import { Promo, PromoSchema } from './schemas/promo.schema';
import { PromoReward, PromoRewardSchema } from './schemas/promo-reward.schema';
import { PromoParticipant, PromoParticipantSchema } from './schemas/promo-participant.schema';
import { PromoRedemption, PromoRedemptionSchema } from './schemas/promo-redemption.schema';
import { PromoClaim, PromoClaimSchema } from './schemas/promo-claim.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Payment, PaymentSchema } from '../payments/schemas/payment.schema';
import { Subscription, SubscriptionSchema } from '../subscriptions/schemas/subscription.schema';
import { PromosService } from './promos.service';
import { PromosController } from './promos.controller';
import { PromoEngineService } from './promo-engine.service';
import { PromosMonitorService } from './promos-monitor.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { UsersModule } from '../users/users.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { BetLabModule } from '../bet-lab/bet-lab.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Promo.name, schema: PromoSchema },
      { name: PromoReward.name, schema: PromoRewardSchema },
      { name: PromoParticipant.name, schema: PromoParticipantSchema },
      { name: PromoRedemption.name, schema: PromoRedemptionSchema },
      { name: PromoClaim.name, schema: PromoClaimSchema },
      { name: User.name, schema: UserSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: Subscription.name, schema: SubscriptionSchema },
    ]),
    forwardRef(() => ReferralsModule),
    SubscriptionsModule,
    UsersModule,
    BetLabModule,
  ],
  controllers: [PromosController],
  providers: [PromosService, PromoEngineService, PromosMonitorService, RolesGuard],
  exports: [PromosService, PromoEngineService],
})
export class PromosModule {}