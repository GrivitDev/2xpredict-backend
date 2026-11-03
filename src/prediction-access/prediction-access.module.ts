import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import {
  MarketPrediction,
  MarketPredictionSchema,
} from '../predictions-engine/schemas/market-prediction.schema';
import {
  PickCenter,
  PickCenterSchema,
} from '../predictions-engine/schemas/pick-center.schema';
import {
  PredictionSlip,
  PredictionSlipSchema,
} from '../predictions-engine/schemas/prediction-slip.schema';
import {
  CuratedPrediction,
  CuratedPredictionSchema,
} from '../predictions-engine/schemas/curated-prediction.schema';
import {
  EspnFixture,
  EspnFixtureSchema,
} from '../sports/schemas/espn/espn-fixture.schema';
import {
  EspnTeam,
  EspnTeamSchema,
} from '../sports/schemas/espn/espn-team.schema';
import {
  EspnLeague,
  EspnLeagueSchema,
} from '../sports/schemas/espn/espn-league.schema';
import { PredictionAccessController } from './controllers/prediction-access.controller';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { PredictionAccessService } from './prediction-access.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MarketPrediction.name, schema: MarketPredictionSchema },
      { name: PickCenter.name, schema: PickCenterSchema },
      { name: PredictionSlip.name, schema: PredictionSlipSchema },
      { name: CuratedPrediction.name, schema: CuratedPredictionSchema },
      { name: EspnFixture.name, schema: EspnFixtureSchema },
      { name: EspnTeam.name, schema: EspnTeamSchema },
      { name: EspnLeague.name, schema: EspnLeagueSchema },
    ]),
    SubscriptionsModule,
  ],
  controllers: [PredictionAccessController],
  providers: [PredictionAccessService, OptionalJwtAuthGuard],
  exports: [PredictionAccessService, OptionalJwtAuthGuard],
})
export class PredictionAccessModule {}
