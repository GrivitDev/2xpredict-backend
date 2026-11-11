import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { SportsModule } from '../sports/sports.module';
import { FixtureOdds, FixtureOddsSchema } from './schemas/fixture-odds.schema';
import { OddsService } from './services/odds.service';
import { OddsReadService } from './services/odds-read.service';
import { OddsPricingEngineService } from './services/odds-pricing-engine.service';
import { OddsWorkerService } from './services/odds-worker.service';
import { OddsMonitorService } from './services/odds-monitor.service';
import { OddsCenterController } from './controllers/odds-center.controller';
import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';

/**
 * Odds is strictly a consumer of normalized Sports records. No provider client,
 * sports legacy schema, external API cache, API key or collection service is
 * registered here. Sports owns collection; Odds owns calculated prices.
 */
@Module({
  imports: [
    SportsModule,
    MongooseModule.forFeature([{ name: FixtureOdds.name, schema: FixtureOddsSchema }]),
  ],
  controllers: [OddsCenterController],
  providers: [
    adminRealtimeRegistrationProvider('odds', 'Odds: Sports-backed market pricing, bookmaker snapshot normalization, fair odds and market readiness.'),
    OddsPricingEngineService,
    OddsService,
    OddsReadService,
    OddsWorkerService,
    OddsMonitorService,
  ],
  exports: [OddsReadService],
})
export class OddsModule {}
