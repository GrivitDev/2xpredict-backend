import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdsController } from './ads.controller';
import { AdminAdsController } from './admin-ads.controller';
import { AdsService } from './ads.service';
import { AdsMonitorService } from './ads-monitor.service';
import { Ad, AdSchema } from './schemas/ad.schema';
import { AdEvent, AdEventSchema } from './schemas/ad-event.schema';
import {
  ExternalAdPolicyConfig,
  ExternalAdPolicySchema,
} from './schemas/external-ad-policy.schema';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { UploadsModule } from '../uploads/uploads.module';
import { PlanConfigModule } from '../plan-config/plan-config.module';
import {
  MarketPrediction,
  MarketPredictionSchema,
} from '../predictions-engine/schemas/market-prediction.schema';
import {
  PredictionSlip,
  PredictionSlipSchema,
} from '../predictions-engine/schemas/prediction-slip.schema';
import { Promo, PromoSchema } from '../promos/schemas/promo.schema';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Ad.name, schema: AdSchema },
      { name: AdEvent.name, schema: AdEventSchema },
      { name: ExternalAdPolicyConfig.name, schema: ExternalAdPolicySchema },
      // Read-side projections only: Ads discovers and displays predictions, slips and promos.
      // Their lifecycle, writes and settlement remain owned by PredictionsEngine/Promos/Settlement.
      { name: MarketPrediction.name, schema: MarketPredictionSchema },
      { name: PredictionSlip.name, schema: PredictionSlipSchema },
      { name: Promo.name, schema: PromoSchema },
    ]),
    SubscriptionsModule,
    UploadsModule,
    PlanConfigModule,
  ],
  controllers: [AdsController, AdminAdsController],
  providers: [
    adminRealtimeRegistrationProvider(
      'ads',
      'Advertisement inventory, targeting, automated content discovery and delivery-monitor integration.',
    ),
    AdsService,
    AdsMonitorService,
    JwtAuthGuard,
    OptionalJwtAuthGuard,
    RolesGuard,
  ],
  exports: [AdsService],
})
export class AdsModule {}
