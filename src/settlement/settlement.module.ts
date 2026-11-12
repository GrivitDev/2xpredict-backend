import { forwardRef, Module } from '@nestjs/common';
import { BackgroundWorkModule } from '../common/background-work/background-work.module';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { MongooseModule } from '@nestjs/mongoose';
import { BetLabModule } from '../bet-lab/bet-lab.module';
import { SportsModule } from '../sports/sports.module';
import {
  BetLabTicket,
  BetLabTicketSchema,
} from '../bet-lab/schemas/bet-lab-ticket.schema';
import {
  MarketPrediction,
  MarketPredictionSchema,
} from '../predictions-engine/schemas/market-prediction.schema';
import {
  PredictionSlip,
  PredictionSlipSchema,
} from '../predictions-engine/schemas/prediction-slip.schema';
import {
  CuratedPrediction,
  CuratedPredictionSchema,
} from '../predictions-engine/schemas/curated-prediction.schema';
import { SettlementAdminController } from './controllers/settlement-admin.controller';
import {
  SettlementEvent,
  SettlementEventSchema,
} from './schemas/settlement-event.schema';
import {
  SettlementJob,
  SettlementJobSchema,
} from './schemas/settlement-job.schema';
import {
  SettlementRun,
  SettlementRunSchema,
} from './schemas/settlement-run.schema';
import { BetLabSettlementService } from './services/bet-lab-settlement.service';
import { FootballMatchFactsService } from './services/football-match-facts.service';
import { MarketSettlementService } from './services/market-settlement.service';
import { PredictionSettlementService } from './services/prediction-settlement.service';
import { SettlementEventLogService } from './services/settlement-event-log.service';
import { SettlementMonitorService } from './services/settlement-monitor.service';
import { SettlementProcessorService } from './services/settlement-processor.service';
import { SettlementQueueService } from './services/settlement-queue.service';
import { SettlementTriggerService } from './services/settlement-trigger.service';
import { SettlementWorkerService } from './services/settlement-worker.service';

import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';
/**
 * Cross-module settlement boundary:
 * - SportsModule supplies the authoritative normalized fixture and timeline.
 * - FOOTBALL_MARKET_CATALOG (imported by MarketSettlementService from Odds)
 *   defines the shared market, selection, period and line contract.
 * - Prediction Engine records are registered here for outcome reconciliation.
 * - BetLabModule supplies the wallet-safe settlement adapter.
 *
 * Odds prices are deliberately not used as match-result evidence. Settlement
 * grades actual Sports facts against the same canonical catalogue used by Odds.
 */
@Module({
  imports: [
    BackgroundWorkModule,
    forwardRef(() => BetLabModule),
    forwardRef(() => SportsModule),
    MongooseModule.forFeature([
      { name: MarketPrediction.name, schema: MarketPredictionSchema },
      { name: PredictionSlip.name, schema: PredictionSlipSchema },
      { name: CuratedPrediction.name, schema: CuratedPredictionSchema },
      { name: BetLabTicket.name, schema: BetLabTicketSchema },
      { name: SettlementJob.name, schema: SettlementJobSchema },
      { name: SettlementRun.name, schema: SettlementRunSchema },
      { name: SettlementEvent.name, schema: SettlementEventSchema },
    ]),
  ],
  controllers: [SettlementAdminController],
  providers: [
    adminRealtimeRegistrationProvider(
      'settlement',
      'Settlement: event-triggered queue, processing jobs, runs and settlement outcomes.',
    ),
    FootballMatchFactsService,
    MarketSettlementService,
    PredictionSettlementService,
    BetLabSettlementService,
    SettlementEventLogService,
    SettlementQueueService,
    SettlementTriggerService,
    SettlementProcessorService,
    SettlementWorkerService,
    SettlementMonitorService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [
    SettlementTriggerService,
    SettlementQueueService,
    MarketSettlementService,
    SettlementMonitorService,
  ],
})
export class SettlementModule {}




