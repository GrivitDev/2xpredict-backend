import { Module } from '@nestjs/common';
import { RolesGuard } from '../common/guards/roles.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PredictionAccessModule } from '../prediction-access/prediction-access.module';
import { OddsModule } from '../odds/odds.module';
import { SportsModule } from '../sports/sports.module';
import { MongooseModule } from '@nestjs/mongoose';

import {
  ActiveCompetition,
  ActiveCompetitionSchema,
} from '../sports/schemas/active-competition.schema';
import {
  EspnFixture,
  EspnFixtureSchema,
} from '../sports/schemas/espn/espn-fixture.schema';
import {
  EspnTeam,
  EspnTeamSchema,
} from '../sports/schemas/espn/espn-team.schema';
import {
  EspnStanding,
  EspnStandingSchema,
} from '../sports/schemas/espn/espn-standing.schema';

import { PredictionEngineController } from './controllers/prediction-engine.controller';
import { PredictionsReadController } from './controllers/predictions-read.controller';

import {
  MarketPrediction,
  MarketPredictionSchema,
} from './schemas/market-prediction.schema';
import {
  PredictionRun,
  PredictionRunSchema,
} from './schemas/prediction-run.schema';
import {
  PredictionQueue,
  PredictionQueueSchema,
} from './schemas/prediction-queue.schema';
import { PickCenter, PickCenterSchema } from './schemas/pick-center.schema';
import { SlipCenterGenerationLock, SlipCenterGenerationLockSchema } from './schemas/slip-center-generation-lock.schema';
import {
  PredictionSlip,
  PredictionSlipSchema,
} from './schemas/prediction-slip.schema';
import { CuratedPrediction, CuratedPredictionSchema } from './schemas/curated-prediction.schema';
import {
  PredictionEngineEvent,
  PredictionEngineEventSchema,
} from './schemas/prediction-engine-event.schema';
import {
  PredictionEngineState,
  PredictionEngineStateSchema,
} from './schemas/prediction-engine-state.schema';
import {
  MarketCalibration,
  MarketCalibrationSchema,
} from './schemas/market-calibration.schema';

import { PredictionConfidenceService } from './services/prediction-confidence.service';
import { PredictionDataService } from './services/prediction-data.service';
import { ExpectedGoalsService } from './services/expected-goals.service';
import { MarketOddsService } from './services/market-odds.service';
import { MarketStatForecastService } from './services/market-stat-forecast.service';
import { MarketPredictionCalculationService } from './services/market-prediction-calculation.service';
import { PredictionEngineService } from './services/prediction-engine.service';
import { PredictionQueueService } from './services/prediction-queue.service';
import { PredictionQueueWorkerService } from './services/prediction-queue-worker.service';
import { PredictionTriggerService } from './services/prediction-trigger.service';
import { PredictionReadService } from './services/prediction-read.service';
import { PredictionEngineMonitorService } from './services/prediction-engine-monitor.service';
import { PickCenterService } from './services/pick-center.service';
import { SlipCenterService } from './services/slip-center.service';
import { CuratedPredictionService } from './services/curated-prediction.service';
import { MarketCalibrationService } from './services/market-calibration.service';

import { ResultMarketEngine } from './services/market-engines/result-market.engine';
import { GoalsMarketEngine } from './services/market-engines/goals-market.engine';
import { PeriodMarketEngine } from './services/market-engines/period-market.engine';
import { HandicapMarketEngine } from './services/market-engines/handicap-market.engine';
import { StatisticsMarketEngine } from './services/market-engines/statistics-market.engine';
import { PlayerMarketEngine } from './services/market-engines/player-market.engine';
import { CombinationMarketEngine } from './services/market-engines/combination-market.engine';
import { SpecialMarketEngine } from './services/market-engines/special-market.engine';

import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';
import { SettlementModule } from '../settlement/settlement.module';
@Module({
  imports: [
    PredictionAccessModule,
    OddsModule,
    SportsModule,
    SettlementModule,
    MongooseModule.forFeature([
      { name: EspnFixture.name, schema: EspnFixtureSchema },
      { name: EspnTeam.name, schema: EspnTeamSchema },
      { name: EspnStanding.name, schema: EspnStandingSchema },
      { name: ActiveCompetition.name, schema: ActiveCompetitionSchema },
      { name: MarketPrediction.name, schema: MarketPredictionSchema },
      { name: PredictionRun.name, schema: PredictionRunSchema },
      { name: PredictionQueue.name, schema: PredictionQueueSchema },
      { name: PickCenter.name, schema: PickCenterSchema },
      { name: PredictionSlip.name, schema: PredictionSlipSchema },
      { name: SlipCenterGenerationLock.name, schema: SlipCenterGenerationLockSchema },
      { name: CuratedPrediction.name, schema: CuratedPredictionSchema },
      { name: PredictionEngineEvent.name, schema: PredictionEngineEventSchema },
      { name: PredictionEngineState.name, schema: PredictionEngineStateSchema },
      { name: MarketCalibration.name, schema: MarketCalibrationSchema },
    ]),
  ],
  controllers: [PredictionEngineController, PredictionsReadController],
  providers: [
    adminRealtimeRegistrationProvider('predictions-engine', 'Prediction Engine: queue, workers, prediction runs, calibration and engine events.'),
    PredictionConfidenceService,
    PredictionDataService,
    ExpectedGoalsService,
    MarketOddsService,
    MarketStatForecastService,
    MarketPredictionCalculationService,
    PredictionEngineService,
    PredictionQueueService,
    PredictionQueueWorkerService,
    PredictionTriggerService,
    PredictionReadService,
    PredictionEngineMonitorService,
    PickCenterService,
    SlipCenterService,
    CuratedPredictionService,
    MarketCalibrationService,
    ResultMarketEngine,
    GoalsMarketEngine,
    PeriodMarketEngine,
    HandicapMarketEngine,
    StatisticsMarketEngine,
    PlayerMarketEngine,
    CombinationMarketEngine,
    SpecialMarketEngine,
    JwtAuthGuard,
    OptionalJwtAuthGuard,
    RolesGuard,
  ],
  exports: [
    PredictionEngineService,
    PredictionQueueService,
    PredictionQueueWorkerService,
    PredictionTriggerService,
    PredictionReadService,
    PredictionEngineMonitorService,
    PickCenterService,
    SlipCenterService,
    CuratedPredictionService,
    MarketCalibrationService,
  ],
})
export class PredictionsEngineModule {}



