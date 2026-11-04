import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EspnFixture, EspnFixtureSchema } from '../sports/schemas/espn/espn-fixture.schema';
import { SportsModule } from '../sports/sports.module';
import { EspnLeague, EspnLeagueSchema } from '../sports/schemas/espn/espn-league.schema';
import { FixtureOdds, FixtureOddsSchema } from './schemas/fixture-odds.schema';
import { OddsProviderState, OddsProviderStateSchema } from './schemas/odds-provider-state.schema';
import { OddsProviderCache, OddsProviderCacheSchema } from './schemas/odds-provider-cache.schema';
import { TheOddsApiService } from './providers/the-odds-api.service';
import { OddsService } from './services/odds.service';
import { OddsReadService } from './services/odds-read.service';
import { OddsCollectionService } from './services/odds-collection.service';
import { OddsProviderStateService } from './services/odds-provider-state.service';
import { OddsWorkerService } from './services/odds-worker.service';
import { OddsMonitorService } from './services/odds-monitor.service';
import { OddsCenterController } from './controllers/odds-center.controller';
import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';

@Module({
  imports: [
    forwardRef(() => SportsModule),
    MongooseModule.forFeature([
      { name: EspnFixture.name, schema: EspnFixtureSchema },
      { name: EspnLeague.name, schema: EspnLeagueSchema },
      { name: FixtureOdds.name, schema: FixtureOddsSchema },
      { name: OddsProviderState.name, schema: OddsProviderStateSchema },
      { name: OddsProviderCache.name, schema: OddsProviderCacheSchema },
    ]),
  ],
  controllers: [OddsCenterController],
  providers: [
    adminRealtimeRegistrationProvider('odds', 'Odds: provider quotas, cached market feeds, canonical fair odds, and odds freshness processing.'),
    OddsProviderStateService,
    TheOddsApiService,
    OddsCollectionService,
    OddsService,
    OddsReadService,
    OddsWorkerService,
    OddsMonitorService,
  ],
  // Downstream modules receive a read-only quote interface.
  exports: [OddsReadService],
})
export class OddsModule {}




