import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AdminGateway } from '../../realtime/admin.gateway';
import { SystemMonitorService } from '../../system-monitor/system-monitor.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { MarketPrediction } from '../schemas/market-prediction.schema';
import { PredictionRun } from '../schemas/prediction-run.schema';
import { PredictionQueue } from '../schemas/prediction-queue.schema';
import { PickCenter } from '../schemas/pick-center.schema';
import { PredictionSlip } from '../schemas/prediction-slip.schema';
import { CuratedPrediction } from '../schemas/curated-prediction.schema';
import { PredictionEngineEvent } from '../schemas/prediction-engine-event.schema';
import { PredictionEngineState } from '../schemas/prediction-engine-state.schema';
import { MarketCalibration } from '../schemas/market-calibration.schema';
import { SportsDomainReadService } from '../../sports/services/sports-domain-read.service';
import { SportsDataChangeEventService } from '../../sports/services/sports-data-change-event.service';
import type { SportsFixtureRecord } from '../../sports/interfaces/sports-domain.interface';
import { OddsReadService } from '../../odds/services/odds-read.service';
import { PredictionEventLevel } from '../enums/prediction-event-level.enum';
import { EngineEventType } from '../enums/engine-event-type.enum';
import { PredictionQueueStatus } from '../enums/prediction-queue-status.enum';
import { PredictionRunStatus } from '../enums/prediction-run-status.enum';
import { PredictionStatus } from '../enums/prediction-status.enum';
import { SlipStatus } from '../enums/slip-status.enum';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { PredictionEngineDashboard } from '../interfaces/prediction-monitor.interface';
import { FOOTBALL_MARKET_CATALOG } from '../catalog/football-market-catalog';
import { FOOTBALL_MARKET_BY_PREDICTION_KEY } from '../../odds/catalog/football-market-catalog';

export type PredictionOperationStatus = 'RUNNING' | 'HEALTHY' | 'DEGRADED' | 'UNKNOWN';

export interface PredictionOperationRuntime {
  name: string;
  status: PredictionOperationStatus;
  activeRuns: number;
  runs: number;
  failures: number;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastSuccessAt?: string;
  lastDurationMs?: number;
  lastError?: string;
  lastDetails?: Record<string, unknown>;
}

interface MutableOperationRuntime {
  name: string;
  status: PredictionOperationStatus;
  activeRuns: number;
  runs: number;
  failures: number;
  startedAtMs?: number;
  lastStartedAt?: Date;
  lastCompletedAt?: Date;
  lastSuccessAt?: Date;
  lastDurationMs?: number;
  lastError?: string;
  lastDetails?: Record<string, unknown>;
}

export interface RecordEngineEventInput {
  type: EngineEventType | string;
  level: PredictionEventLevel | string;
  message: string;
  eventId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class PredictionEngineMonitorService implements OnModuleInit {
  private readonly logger = new Logger(PredictionEngineMonitorService.name);
  private readonly operationRuntime = new Map<string, MutableOperationRuntime>();
  private readonly operationStaleAfterMs: Record<string, number> = {
    'queue-sync': PREDICTION_ENGINE_CONFIG.queue.syncIntervalMs * 3,
    'prediction-worker': PREDICTION_ENGINE_CONFIG.queue.workerIntervalMs * 6,
    'pick-center': PREDICTION_ENGINE_CONFIG.pickCenter.refreshIntervalMs * 3,
    'curated-predictions': PREDICTION_ENGINE_CONFIG.curatedPredictions.refreshIntervalMs * 3,
    'slip-center': PREDICTION_ENGINE_CONFIG.slipCenter.refreshIntervalMs * 3,
    calibration: PREDICTION_ENGINE_CONFIG.calibration.refreshIntervalMs * 3,
  };

  constructor(
    @InjectModel(MarketPrediction.name)
    private readonly marketModel: Model<MarketPrediction>,
    @InjectModel(PredictionRun.name)
    private readonly runModel: Model<PredictionRun>,
    @InjectModel(PredictionQueue.name)
    private readonly queueModel: Model<PredictionQueue>,
    @InjectModel(PickCenter.name)
    private readonly pickCenterModel: Model<PickCenter>,
    @InjectModel(PredictionSlip.name)
    private readonly slipModel: Model<PredictionSlip>,
    @InjectModel(CuratedPrediction.name)
    private readonly curatedPredictionModel: Model<CuratedPrediction>,
    @InjectModel(PredictionEngineEvent.name)
    private readonly eventModel: Model<PredictionEngineEvent>,
    @InjectModel(PredictionEngineState.name)
    private readonly stateModel: Model<PredictionEngineState>,
    private readonly sportsRead: SportsDomainReadService,
    private readonly sportsRevisions: SportsDataChangeEventService,
    private readonly oddsRead: OddsReadService,
    @InjectModel(MarketCalibration.name)
    private readonly calibrationModel: Model<MarketCalibration>,
    private readonly adminGateway: AdminGateway,
    private readonly systemMonitor: SystemMonitorService,
  ) {}

  onModuleInit(): void {
    this.systemMonitor.registerModule('predictions-engine');
    this.adminGateway.registerModule('predictions-engine', {
      message:
        'Prediction Engine monitor initialized; queue synchronization, worker state and prediction run events are streamed.',
      operationalStatus: 'UNKNOWN',
    });
  }

  async recordEvent(input: RecordEngineEventInput): Promise<void> {
    try {
      await this.eventModel.create({
        type: input.type as EngineEventType,
        level: input.level as PredictionEventLevel,
        message: input.message,
        eventId: input.eventId,
        runId: input.runId,
        metadata: input.metadata,
        occurredAt: new Date(),
      });
      if (String(input.level) === String(PredictionEventLevel.ERROR)) {
        this.logger.error(input.message);
      } else if (String(input.level) === String(PredictionEventLevel.WARNING)) {
        this.logger.warn(input.message);
      } else {
        this.logger.log(input.message);
      }
      const level = String(input.level);
      // Ordinary INFO events are not health checks and must not clear errors.
      // A fully completed market run is an explicit recovery signal; partial
      // runs and product events do not clear a degraded status.
      if (
        level === String(PredictionEventLevel.ERROR) &&
        String(input.type) !== String(EngineEventType.PRODUCT_REFRESH_FAILED)
      ) {
        this.adminGateway.setModuleOperationalStatus(
          'predictions-engine',
          'DEGRADED',
          input.message,
        );
      } else if (
        String(input.type) === String(EngineEventType.PREDICTION_COMPLETED) &&
        level === String(PredictionEventLevel.INFO)
      ) {
        this.adminGateway.setModuleOperationalStatus(
          'predictions-engine',
          'READY',
          'A full prediction run completed successfully.',
          { eventId: input.eventId, runId: input.runId },
        );
      }
      this.adminGateway.publishModuleEvent(
        'predictions-engine',
        'predictions:event',
        {
          type: String(input.type),
          level,
          message: input.message.slice(0, 500),
          eventId: input.eventId,
          runId: input.runId,
          metadata: input.metadata,
          occurredAt: new Date().toISOString(),
        },
      );
    } catch (error) {
      this.logger.error(
        `Unable to persist prediction-engine event: ${this.errorMessage(error)}`,
      );
    }
  }

  async setWorkerRunning(workerRunning: boolean): Promise<void> {
    await this.stateModel
      .findOneAndUpdate(
        { key: 'main' },
        {
          $set: {
            key: 'main',
            workerRunning,
            modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
            enabled: PREDICTION_ENGINE_CONFIG.enabled,
          },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      )
      .exec();
    this.adminGateway.setModuleOperationalStatus(
      'predictions-engine',
      workerRunning ? 'READY' : 'STOPPED',
      workerRunning
        ? 'Prediction worker is running.'
        : 'Prediction worker is not currently running.',
    );
    this.adminGateway.publishModuleEvent(
      'predictions-engine',
      'predictions:worker-status',
      { workerRunning, occurredAt: new Date().toISOString() },
    );
  }

  async recordQueueSync(result: {
    scannedFixtures: number;
    eligibleFixtures: number;
    enqueued: number;
    refreshed: number;
    missingSummary: number;
  }): Promise<void> {
    await this.stateModel
      .findOneAndUpdate(
        { key: 'main' },
        {
          $set: {
            key: 'main',
            modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
            enabled: PREDICTION_ENGINE_CONFIG.enabled,
            lastQueueSyncAt: new Date(),
            lastScannedFixtures: result.scannedFixtures,
            lastEnqueuedFixtures: result.enqueued,
          },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      )
      .exec();

    await this.recordEvent({
      type: EngineEventType.QUEUE_SYNCED,
      level: result.missingSummary
        ? PredictionEventLevel.WARNING
        : PredictionEventLevel.INFO,
      message: `Full-season queue reconciliation scanned ${result.scannedFixtures} retained upcoming fixtures, found ${result.eligibleFixtures} Odds-ready fixtures, queued ${result.enqueued}, refreshed ${result.refreshed}, and found ${result.missingSummary} without a normalized Sports freshness timestamp.`,
      metadata: result,
    });
  }

  async recordCuratedRefresh(summary: Record<string, unknown>): Promise<void> {
    const created = Number(summary.created ?? 0) || 0;
    const updated = Number(summary.updated ?? 0) || 0;
    const skipped = Number(summary.skippedMatches ?? 0) || 0;
    const riskRejected = Number(summary.riskRejected ?? 0) || 0;
    const metadata = {
      matchesScanned: Number(summary.matchesScanned ?? 0) || 0,
      eligibleFixtures: Number(summary.eligibleFixtures ?? 0) || 0,
      durationMs: Number(summary.durationMs ?? 0) || 0,
      minimumProbability: Number(
        summary.minimumProbability ??
          PREDICTION_ENGINE_CONFIG.curatedPredictions.minimumProbability,
      ),
      minimumConfidence: Number(
        summary.minimumConfidence ??
          PREDICTION_ENGINE_CONFIG.curatedPredictions.minimumConfidence,
      ),
      minimumDataQuality: Number(
        summary.minimumDataQuality ??
          PREDICTION_ENGINE_CONFIG.curatedPredictions.minimumDataQuality,
      ),
      minimumSafetyScore: Number(
        summary.minimumSafetyScore ??
          PREDICTION_ENGINE_CONFIG.curatedPredictions.minimumSafetyScore,
      ),
      validOddsReadySelections:
        Number(summary.validOddsReadySelections ?? 0) || 0,
      created,
      updated,
      skipped,
      riskRejected,
      withdrawn: Number(summary.withdrawn ?? 0) || 0,
      oneSelectionMatches: Number(summary.oneSelectionMatches ?? 0) || 0,
      twoSelectionMatches: Number(summary.twoSelectionMatches ?? 0) || 0,
      threeSelectionMatches: Number(summary.threeSelectionMatches ?? 0) || 0,
      publishedRecordsSupplemented:
        Number(summary.publishedRecordsSupplemented ?? 0) || 0,
      publishedRecordsReconciled:
        Number(summary.publishedRecordsReconciled ?? 0) || 0,
      skipReasonCounts:
        summary.skipReasonCounts && typeof summary.skipReasonCounts === 'object'
          ? Object.fromEntries(
              Object.entries(
                summary.skipReasonCounts as Record<string, unknown>,
              ).map(([key, value]) => [key, Number(value) || 0]),
            )
          : {},
      selectedMarkets: Number(summary.selectedMarkets ?? 0) || 0,
      horizonHours: Number(
        summary.horizonHours ??
          PREDICTION_ENGINE_CONFIG.curatedPredictions.horizonHours,
      ),
    };
    await this.stateModel
      .findOneAndUpdate(
        { key: 'main' },
        {
          $set: {
            key: 'main',
            modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
            lastProductRefreshAt: new Date(),
            lastCuratedRefreshAt: new Date(),
            lastCuratedRefreshStatus: 'COMPLETED',
            lastCuratedRefreshDurationMs: metadata.durationMs,
            lastCuratedMatchesScanned: metadata.matchesScanned,
            lastCuratedEligibleFixtures: metadata.eligibleFixtures,
            lastCuratedCreated: created,
            lastCuratedUpdated: updated,
            lastCuratedSkipped: skipped,
            lastCuratedRiskRejected: riskRejected,
            lastCuratedOneSelectionMatches: metadata.oneSelectionMatches,
            lastCuratedTwoSelectionMatches: metadata.twoSelectionMatches,
            lastCuratedThreeSelectionMatches: metadata.threeSelectionMatches,
            lastCuratedPublishedRecordsSupplemented:
              metadata.publishedRecordsSupplemented,
            lastCuratedPublishedRecordsReconciled:
              metadata.publishedRecordsReconciled,
            lastCuratedSkipReasonCounts: metadata.skipReasonCounts,
          },
          $unset: { lastCuratedError: 1 },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      )
      .exec();
    await this.recordEvent({
      type: 'CURATED_REFRESHED',
      // Selection filtering is normal business logic, not an operational warning.
      // Actual refresh exceptions are reported separately as PRODUCT_REFRESH_FAILED.
      level: PredictionEventLevel.INFO,
      message: `Curated refresh scanned ${metadata.matchesScanned} Pick Center fixtures; ${metadata.eligibleFixtures} eligible, ${created} created, ${updated} updated, ${metadata.publishedRecordsSupplemented} published records supplemented, ${metadata.publishedRecordsReconciled} published fixture records reconciled, ${skipped} skipped, ${riskRejected} filtered by configured selection criteria.`,
      metadata,
    });
  }

  async recordSlipRefresh(summary: Record<string, unknown>): Promise<void> {
    const createdOrUpdated = Number(summary.createdOrUpdated ?? 0) || 0;
    const skipped = Number(summary.skipped ?? 0) || 0;
    const fixtureCandidates = Number(summary.fixtureCandidates ?? 0) || 0;
    const eligibleFixtures = Number(summary.eligibleFixtures ?? 0) || 0;
    const metadata = {
      createdOrUpdated,
      skipped,
      legacyMixedSlipsWithdrawn: Number(summary.legacyMixedSlipsWithdrawn ?? 0) || 0,
      fixtureCandidates,
      eligibleFixtures,
      durationMs: Number(summary.durationMs ?? 0) || 0,
      minimumProbability: Number(
        summary.minimumProbability ??
          PREDICTION_ENGINE_CONFIG.slipCenter.minimumLegProbability,
      ),
      minimumConfidence: Number(
        summary.minimumConfidence ??
          PREDICTION_ENGINE_CONFIG.slipCenter.minimumLegConfidence,
      ),
      minimumDataQuality: Number(
        summary.minimumDataQuality ??
          PREDICTION_ENGINE_CONFIG.slipCenter.minimumLegDataQuality,
      ),
      minimumSafetyScore: Number(
        summary.minimumSafetyScore ??
          PREDICTION_ENGINE_CONFIG.slipCenter.minimumSafetyScore,
      ),
      eligibleFixtureDays: Number(summary.eligibleFixtureDays ?? 0) || 0,
      eligibleEvents: Number(summary.eligibleEvents ?? 0) || 0,
      pickCenterEventsWithoutEligibleSelections:
        Number(summary.pickCenterEventsWithoutEligibleSelections ?? 0) || 0,
      pickCenterEventIdsWithoutEligibleSelections: Array.isArray(
        summary.pickCenterEventIdsWithoutEligibleSelections,
      )
        ? summary.pickCenterEventIdsWithoutEligibleSelections.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
      coveredEvents: Number(summary.coveredEvents ?? 0) || 0,
      coverageEventsRequired: Number(summary.coverageEventsRequired ?? 0) || 0,
      coverageEventsSatisfied:
        Number(summary.coverageEventsSatisfied ?? 0) || 0,
      coverageEventIdsMissing: Array.isArray(summary.coverageEventIdsMissing)
        ? summary.coverageEventIdsMissing.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
      coverageDatesRequired: Number(summary.coverageDatesRequired ?? 0) || 0,
      coverageDatesSatisfied: Number(summary.coverageDatesSatisfied ?? 0) || 0,
      coverageDatesMissing: Array.isArray(summary.coverageDatesMissing)
        ? summary.coverageDatesMissing.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
      coverageSlipsCreated: Number(summary.coverageSlipsCreated ?? 0) || 0,
      // Automatic Slip Center products are isolated to one kickoff date.
      sameDayFixtureCombinationProhibited: false,
      sameDayFixturesAllowed: true,
      crossDateCombinationsAllowed: false,
      maximumSelectionsPerMatch: Number(
        summary.maximumSelectionsPerMatch ??
          PREDICTION_ENGINE_CONFIG.slipCenter.maximumSelectionsPerMatch,
      ),
      publishedProductsToday: Number(summary.publishedProductsToday ?? 0) || 0,
      publishedProductsTomorrow: Number(summary.publishedProductsTomorrow ?? 0) || 0,
      targetDateTodayKey:
        typeof summary.targetDateTodayKey === 'string'
          ? summary.targetDateTodayKey
          : '',
      targetDateTomorrowKey:
        typeof summary.targetDateTomorrowKey === 'string'
          ? summary.targetDateTomorrowKey
          : '',
      todayTarget: Number(summary.todayTarget ?? PREDICTION_ENGINE_CONFIG.slipCenter.dailySlipTarget) || 0,
      tomorrowTarget: Number(summary.tomorrowTarget ?? PREDICTION_ENGINE_CONFIG.slipCenter.dailySlipTarget) || 0,
      todayRemaining: Number(summary.todayRemaining ?? PREDICTION_ENGINE_CONFIG.slipCenter.dailySlipTarget) || 0,
      tomorrowRemaining: Number(summary.tomorrowRemaining ?? PREDICTION_ENGINE_CONFIG.slipCenter.dailySlipTarget) || 0,
      targetDateProgress: Array.isArray(summary.targetDateProgress)
        ? summary.targetDateProgress
        : [],
      generatedDateKey:
        typeof summary.generatedDateKey === 'string'
          ? summary.generatedDateKey
          : '',
      fixtureHorizonHours: Number(
        summary.fixtureHorizonHours ??
          PREDICTION_ENGINE_CONFIG.curatedPredictions.horizonHours,
      ),
      dailyTarget: Number(
        summary.dailyTarget ??
          PREDICTION_ENGINE_CONFIG.slipCenter.dailySlipTarget,
      ),
      maximumAutomaticSlips: Number(
        summary.maximumAutomaticSlips ??
          PREDICTION_ENGINE_CONFIG.slipCenter.maxAutoSlipsPerDate,
      ),
    };
    await this.stateModel
      .findOneAndUpdate(
        { key: 'main' },
        {
          $set: {
            key: 'main',
            modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
            lastProductRefreshAt: new Date(),
            lastSlipRefreshAt: new Date(),
            lastSlipRefreshStatus: 'COMPLETED',
            lastSlipRefreshDurationMs: metadata.durationMs,
            lastSlipCreatedOrUpdated: createdOrUpdated,
            lastSlipSkipped: skipped,
            lastSlipFixtureCandidates: fixtureCandidates,
            lastSlipEligibleFixtures: eligibleFixtures,
            lastSlipEligibleFixtureDays: metadata.eligibleFixtureDays,
            lastSlipEligibleEvents: metadata.eligibleEvents,
            lastSlipPickCenterEventsWithoutEligibleSelections:
              metadata.pickCenterEventsWithoutEligibleSelections,
            lastSlipPickCenterEventIdsWithoutEligibleSelections:
              metadata.pickCenterEventIdsWithoutEligibleSelections,
            lastSlipCoveredEvents: metadata.coveredEvents,
            lastSlipCoverageEventsRequired: metadata.coverageEventsRequired,
            lastSlipCoverageEventsSatisfied: metadata.coverageEventsSatisfied,
            lastSlipCoverageEventIdsMissing: metadata.coverageEventIdsMissing,
            lastSlipCoverageDatesRequired: metadata.coverageDatesRequired,
            lastSlipCoverageDatesSatisfied: metadata.coverageDatesSatisfied,
            lastSlipCoverageDatesMissing: metadata.coverageDatesMissing,
            lastSlipCoverageSlipsCreated: metadata.coverageSlipsCreated,
            lastSlipSameDayFixtureCombinationProhibited:
              metadata.sameDayFixtureCombinationProhibited,
            lastSlipPublishedProductsToday: metadata.publishedProductsToday,
            lastSlipPublishedProductsTomorrow: metadata.publishedProductsTomorrow,
            lastSlipTargetDateTodayKey: metadata.targetDateTodayKey,
            lastSlipTargetDateTomorrowKey: metadata.targetDateTomorrowKey,
            lastSlipTodayTarget: metadata.todayTarget,
            lastSlipTomorrowTarget: metadata.tomorrowTarget,
            lastSlipTodayRemaining: metadata.todayRemaining,
            lastSlipTomorrowRemaining: metadata.tomorrowRemaining,
          },
          $unset: { lastSlipError: 1 },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      )
      .exec();
    await this.recordEvent({
      type: 'SLIP_REFRESHED',
      // Candidate filtering and an unmet product target are ordinary outcomes;
      // reserve warnings/errors for actual refresh failures, not each rejected combination.
      level: PredictionEventLevel.INFO,
      message: `Slip refresh considered ${fixtureCandidates} eligible fixture groups from ${eligibleFixtures} unfinished Pick Center fixtures. Kickoff-date targets: ${metadata.targetDateTodayKey || 'today'} ${metadata.publishedProductsToday}/${metadata.todayTarget} (${metadata.todayRemaining} remaining); ${metadata.targetDateTomorrowKey || 'tomorrow'} ${metadata.publishedProductsTomorrow}/${metadata.tomorrowTarget} (${metadata.tomorrowRemaining} remaining). Automatic slips are date-isolated; tomorrow's slips exclude today's fixtures. ${metadata.legacyMixedSlipsWithdrawn} legacy mixed-date slips were withdrawn; ${metadata.pickCenterEventsWithoutEligibleSelections} fixtures had no eligible selection; event coverage is ${metadata.coverageEventsSatisfied}/${metadata.coverageEventsRequired}, ${createdOrUpdated} products created or updated, ${metadata.coverageEventIdsMissing.length} eligible events remain uncovered, and ${skipped} combinations were skipped.`,
      metadata,
    });
  }

  async recordCalibrationCycle(result: Record<string, unknown>): Promise<void> {
    const skipped = result.skipped === true;
    const message = skipped
      ? `Calibration check skipped: ${typeof result.reason === 'string' ? result.reason : 'NO_REFRESH_REQUIRED'}.`
      : `Calibration refreshed ${Number(result.marketsRefreshed ?? 0)} markets; ${Number(result.activeMarkets ?? 0)} active using ${Number(result.settledSamples ?? 0)} settled final recommendations.`;
    await this.stateModel
      .findOneAndUpdate(
        { key: 'main' },
        {
          $set: {
            key: 'main',
            modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
            lastProductRefreshAt: new Date(),
            lastCalibrationRefreshAt: skipped ? undefined : new Date(),
            lastCalibrationRefreshStatus: skipped
              ? typeof result.reason === 'string'
                ? result.reason
                : 'SKIPPED'
              : 'REFRESHED',
            lastCalibrationMarketsRefreshed:
              Number(result.marketsRefreshed ?? 0) || 0,
            lastCalibrationActiveMarkets:
              Number(result.activeMarkets ?? 0) || 0,
          },
          $unset: { lastCalibrationError: 1 },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      )
      .exec();
    if (!skipped)
      await this.recordEvent({
        type: EngineEventType.CALIBRATION_UPDATED,
        level: PredictionEventLevel.INFO,
        message,
        metadata: result,
      });
  }

  async recordProductRefreshFailure(
    area: 'curated' | 'slip' | 'calibration',
    errorMessage: string,
    durationMs = 0,
  ): Promise<void> {
    const message = String(
      errorMessage ?? 'Unknown product refresh error',
    ).slice(0, 1000);
    const fields: Record<string, unknown> = {
      key: 'main',
      lastProductRefreshAt: new Date(),
    };
    const unset: Record<string, 1> = {};
    if (area === 'curated') {
      fields.lastCuratedRefreshAt = new Date();
      fields.lastCuratedError = message;
      fields.lastCuratedRefreshStatus = 'FAILED';
      fields.lastCuratedRefreshDurationMs = Math.max(
        0,
        Number(durationMs) || 0,
      );
    } else if (area === 'slip') {
      fields.lastSlipRefreshAt = new Date();
      fields.lastSlipError = message;
      fields.lastSlipRefreshStatus = 'FAILED';
      fields.lastSlipRefreshDurationMs = Math.max(0, Number(durationMs) || 0);
    } else {
      fields.lastCalibrationRefreshAt = new Date();
      fields.lastCalibrationError = message;
      fields.lastCalibrationRefreshStatus = 'FAILED';
    }
    const update: Record<string, unknown> = { $set: fields };
    if (Object.keys(unset).length) update.$unset = unset;
    await this.stateModel
      .findOneAndUpdate({ key: 'main' }, update, {
        upsert: true,
        returnDocument: 'after',
        setDefaultsOnInsert: true,
      })
      .exec();
    await this.recordEvent({
      type: 'PRODUCT_REFRESH_FAILED',
      level: PredictionEventLevel.ERROR,
      message: `${area} refresh failed: ${message}`,
      metadata: { area },
    });
  }

  async recordRunCompleted(data: {
    status: PredictionRunStatus;
    eventId: string;
    runId: string;
    calculatedMarkets: number;
    totalMarkets: number;
    durationMs: number;
    generalConfidence?: number;
  }): Promise<void> {
    await this.stateModel
      .findOneAndUpdate(
        { key: 'main' },
        {
          $set: {
            key: 'main',
            modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
            enabled: PREDICTION_ENGINE_CONFIG.enabled,
            lastSuccessfulRunAt: new Date(),
          },
          $unset: { lastError: 1 },
          $inc: { processedSinceStart: 1 },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      )
      .exec();

    await this.recordEvent({
      type:
        data.status === PredictionRunStatus.PARTIAL
          ? EngineEventType.PREDICTION_PARTIAL
          : EngineEventType.PREDICTION_COMPLETED,
      level:
        data.status === PredictionRunStatus.PARTIAL
          ? PredictionEventLevel.WARNING
          : PredictionEventLevel.INFO,
      eventId: data.eventId,
      runId: data.runId,
      message: `Prediction run ${data.runId} finished for event ${data.eventId}: ${data.calculatedMarkets}/${data.totalMarkets} markets calculated in ${data.durationMs}ms.`,
      metadata: data,
    });
  }

  async recordRunFailed(
    eventId: string,
    runId: string,
    errorMessage: string,
  ): Promise<void> {
    await this.stateModel
      .findOneAndUpdate(
        { key: 'main' },
        {
          $set: {
            key: 'main',
            modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
            lastFailedRunAt: new Date(),
            lastError: errorMessage,
          },
          $inc: { failedSinceStart: 1 },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      )
      .exec();

    await this.recordEvent({
      type: EngineEventType.PREDICTION_FAILED,
      level: PredictionEventLevel.ERROR,
      eventId,
      runId,
      message: `Prediction run failed for event ${eventId}: ${errorMessage}`,
    });
  }

  /**
   * In-process operation telemetry. This deliberately does not write a database
   * document on every worker tick; durable run/product records remain the source
   * of historical truth while this map exposes current liveness and stuck work.
   */
  recordOperationStart(name: string, details: Record<string, unknown> = {}): void {
    const now = new Date();
    const current: MutableOperationRuntime = this.operationRuntime.get(name) ?? {
      name,
      status: 'UNKNOWN',
      activeRuns: 0,
      runs: 0,
      failures: 0,
    };
    current.activeRuns += 1;
    current.status = 'RUNNING';
    current.startedAtMs = current.startedAtMs ?? now.getTime();
    current.lastStartedAt = now;
    current.lastDetails = { ...(current.lastDetails ?? {}), ...details };
    this.operationRuntime.set(name, current);
  }

  recordOperationSuccess(name: string, details: Record<string, unknown> = {}): void {
    const now = new Date();
    const current: MutableOperationRuntime = this.operationRuntime.get(name) ?? {
      name,
      status: 'UNKNOWN',
      activeRuns: 0,
      runs: 0,
      failures: 0,
    };
    current.activeRuns = Math.max(0, current.activeRuns - 1);
    current.runs += 1;
    current.lastCompletedAt = now;
    current.lastSuccessAt = now;
    current.lastDurationMs = current.startedAtMs
      ? Math.max(0, now.getTime() - current.startedAtMs)
      : current.lastDurationMs;
    current.startedAtMs = current.activeRuns > 0 ? current.startedAtMs : undefined;
    current.lastError = undefined;
    current.lastDetails = { ...(current.lastDetails ?? {}), ...details };
    current.status = current.activeRuns > 0 ? 'RUNNING' : 'HEALTHY';
    this.operationRuntime.set(name, current);
  }

  recordOperationFailure(
    name: string,
    errorMessage: string,
    details: Record<string, unknown> = {},
  ): void {
    const now = new Date();
    const current: MutableOperationRuntime = this.operationRuntime.get(name) ?? {
      name,
      status: 'UNKNOWN',
      activeRuns: 0,
      runs: 0,
      failures: 0,
    };
    current.activeRuns = Math.max(0, current.activeRuns - 1);
    current.failures += 1;
    current.lastCompletedAt = now;
    current.lastDurationMs = current.startedAtMs
      ? Math.max(0, now.getTime() - current.startedAtMs)
      : current.lastDurationMs;
    current.startedAtMs = current.activeRuns > 0 ? current.startedAtMs : undefined;
    current.lastError = String(errorMessage).slice(0, 1000);
    current.lastDetails = { ...(current.lastDetails ?? {}), ...details };
    current.status = current.activeRuns > 0 ? 'RUNNING' : 'DEGRADED';
    this.operationRuntime.set(name, current);
  }

  private getOperationRuntimeSnapshot(now = Date.now()): {
    operations: PredictionOperationRuntime[];
    alerts: Array<{ code: string; severity: 'WARNING' | 'ERROR'; message: string; operation?: string }>;
  } {
    const operations: PredictionOperationRuntime[] = [];
    const alerts: Array<{ code: string; severity: 'WARNING' | 'ERROR'; message: string; operation?: string }> = [];

    for (const [name, item] of this.operationRuntime.entries()) {
      const lastCompletedMs = item.lastCompletedAt?.getTime();
      const staleAfterMs = this.operationStaleAfterMs[name];
      let status = item.status;

      if (item.activeRuns > 0 && item.startedAtMs && now - item.startedAtMs > Math.max(120_000, staleAfterMs ?? 300_000)) {
        status = 'DEGRADED';
        alerts.push({
          code: 'OPERATION_STUCK',
          severity: 'ERROR',
          operation: name,
          message: `${name} has been running for ${Math.round((now - item.startedAtMs) / 1000)} seconds.`,
        });
      } else if (
        item.activeRuns === 0 &&
        staleAfterMs !== undefined &&
        lastCompletedMs !== undefined &&
        now - lastCompletedMs > staleAfterMs
      ) {
        alerts.push({
          code: 'OPERATION_HEARTBEAT_STALE',
          severity: 'WARNING',
          operation: name,
          message: `${name} has not completed within its expected monitoring window.`,
        });
      }

      if (item.failures > 0 && item.lastError && status !== 'RUNNING') {
        alerts.push({
          code: 'OPERATION_LAST_RUN_FAILED',
          severity: 'WARNING',
          operation: name,
          message: `${name} last reported an error: ${item.lastError}`,
        });
      }

      operations.push({
        name: item.name,
        status,
        activeRuns: item.activeRuns,
        runs: item.runs,
        failures: item.failures,
        ...(item.lastStartedAt ? { lastStartedAt: item.lastStartedAt.toISOString() } : {}),
        ...(item.lastCompletedAt ? { lastCompletedAt: item.lastCompletedAt.toISOString() } : {}),
        ...(item.lastSuccessAt ? { lastSuccessAt: item.lastSuccessAt.toISOString() } : {}),
        ...(item.lastDurationMs !== undefined ? { lastDurationMs: item.lastDurationMs } : {}),
        ...(item.lastError ? { lastError: item.lastError } : {}),
        ...(item.lastDetails ? { lastDetails: item.lastDetails } : {}),
      });
    }

    return { operations, alerts };
  }

  async dashboard(): Promise<PredictionEngineDashboard> {
    try {
      return await this.buildDashboard();
    } catch (error) {
      this.systemMonitor.reportMonitorSnapshot('predictions-engine', {
        status: 'FAILED',
        checkedAt: new Date(),
        checks: [{ name: 'dashboard', status: 'FAILED', error: error instanceof Error ? error.message : String(error) }],
      });
      throw error;
    }
  }

  private async buildDashboard(): Promise<PredictionEngineDashboard> {
    const now = new Date();
    const staleBeforeDate = new Date(
      now.getTime() - PREDICTION_ENGINE_CONFIG.model.sourceDataStaleHours * 3_600_000,
    );
    const last24h = new Date(now.getTime() - 86_400_000);
    const readFixturePages = async (query: {
      state?: SportsFixtureRecord['status']['state'];
      from?: Date;
      to?: Date;
      retainedOnly?: boolean;
    }): Promise<{ items: SportsFixtureRecord[]; total: number }> => {
      const items: SportsFixtureRecord[] = [];
      let cursor: string | undefined;
      do {
        const result = await this.sportsRead.getFixtures({
          ...query,
          limit: 500,
          ...(cursor ? { cursor } : {}),
        });
        items.push(...(result.items ?? []));
        if (result.nextCursor && result.nextCursor === cursor) {
          throw new Error('Sports fixture pagination returned a repeated cursor while building the Predictions Engine dashboard.');
        }
        cursor = result.nextCursor;
      } while (cursor);
      return { items, total: items.length };
    };
    const [upcomingSports, liveSports, completedSports] = await Promise.all([
      // The market engine now covers every retained fixture with a future kickoff.
      readFixturePages({ from: now, retainedOnly: true }),
      Promise.all((['LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES'] as const).map((state) =>
        readFixturePages({ state, retainedOnly: true }),
      )),
      this.sportsRead.countFixtures({ state: 'COMPLETED', retainedOnly: true }),
    ]);
    const terminalFixtureStates = new Set(['COMPLETED', 'POSTPONED', 'CANCELLED', 'CANCELED', 'ABANDONED']);
    const upcomingSportsItems = upcomingSports.items.filter((fixture) =>
      !terminalFixtureStates.has(String(fixture.status?.state ?? '').toUpperCase())
      && fixture.status?.isFinal !== true
      && new Date(fixture.kickoffAt).getTime() >= now.getTime(),
    );
    const liveSportsItems = liveSports.flatMap((item) => item.items);
    const liveSportsTotal = liveSportsItems.length;
    const upcomingSportsTotal = upcomingSportsItems.length;
    const completedSportsTotal = completedSports;
    const sportsSourceDate = (fixture: SportsFixtureRecord): Date | null => {
      const value = fixture.source?.collectedAt ?? fixture.source?.providerUpdatedAt ?? fixture.updatedAt;
      if (value instanceof Date && Number.isFinite(value.getTime())) return value;
      if (typeof value === 'string' || typeof value === 'number') {
        const parsed = new Date(value);
        return Number.isFinite(parsed.getTime()) ? parsed : null;
      }
      return null;
    };
    const upcomingSportsReadyCount = upcomingSportsItems.filter((fixture) => sportsSourceDate(fixture) !== null).length;
    const liveSportsReadyCount = liveSportsItems.filter((fixture) => sportsSourceDate(fixture) !== null).length;
    const sportsWindowFixtures = upcomingSportsItems.concat(liveSportsItems);
    const marketWindowTotal = upcomingSportsTotal + liveSportsTotal;
    const marketWindowWithSportsData = upcomingSportsReadyCount + liveSportsReadyCount;
    const marketWindowMissingSportsData = Math.max(0, marketWindowTotal - marketWindowWithSportsData);
    const staleSportsFixtures = sportsWindowFixtures.filter((fixture) => {
      const sourceDate = sportsSourceDate(fixture);
      return !sourceDate || sourceDate.getTime() < staleBeforeDate.getTime();
    }).length;
    const oddsReadiness = new Map<string, { ready?: boolean }>();
    // Keep readiness lookup batches bounded even when the retained season
    // inventory contains many thousands of upcoming fixtures.
    for (let offset = 0; offset < sportsWindowFixtures.length; offset += 500) {
      const batchIds = sportsWindowFixtures
        .slice(offset, offset + 500)
        .map((fixture) => String(fixture.id));
      const batchReadiness = await this.oddsRead.getPredictionReadinessForEvents(batchIds);
      for (const [eventId, readiness] of batchReadiness) {
        oddsReadiness.set(eventId, readiness);
      }
    }
    const missingOddsSportsFixtures = sportsWindowFixtures.filter((fixture) =>
      oddsReadiness.get(String(fixture.id))?.ready !== true,
    ).length;
    const state: PredictionEngineState | null = await this.stateModel
      .findOne({ key: 'main' })
      .lean()
      .exec();
    const activeModelVersion = PREDICTION_ENGINE_CONFIG.modelVersion;

    const [
      upcoming,
      eligibleWithSummary,
      upcomingMissingSummary,
      live,
      completedFixtures,
      totalMarketDocuments,
      calculatedMarketDocuments,
      partialMarketDocuments,
      unavailableMarketDocuments,
      failedMarketDocuments,
      queueCounts,
      oldestPending,
      totalRuns,
      completedRuns,
      partialRuns,
      failedRuns,
      avgDuration,
      runsLast24h,
      totalSlips,
      readySlips,
      publishedSlips,
      slipsWithCode,
      marketAggregate,
      allSelectionStats,
      missingOddsFixtures,
      staleSummaries,
      lowEvidenceRuns,
      selectedPickCenterRows,
      rankedPickCenterRows,
      recentEvents,
      calibrationDocuments,
    ] = await Promise.all([
      upcomingSportsTotal,
      upcomingSportsReadyCount,
      Math.max(0, upcomingSportsTotal - upcomingSportsReadyCount),
      liveSportsTotal,
      completedSportsTotal,
      this.marketModel.countDocuments({ modelVersion: activeModelVersion }),
      this.marketModel.countDocuments({
        modelVersion: activeModelVersion,
        status: PredictionStatus.CALCULATED,
      }),
      this.marketModel.countDocuments({
        modelVersion: activeModelVersion,
        status: PredictionStatus.PARTIAL,
      }),
      this.marketModel.countDocuments({
        modelVersion: activeModelVersion,
        status: PredictionStatus.UNAVAILABLE,
      }),
      this.marketModel.countDocuments({
        modelVersion: activeModelVersion,
        status: PredictionStatus.FAILED,
      }),
      this.queueModel
        .aggregate<{
          _id: PredictionQueueStatus;
          count: number;
        }>([{ $group: { _id: '$status', count: { $sum: 1 } } }])
        .exec(),
      this.queueModel
        .aggregate<{
          createdAt: Date;
        }>([
          { $match: { status: PredictionQueueStatus.PENDING } },
          { $sort: { createdAt: 1 } },
          { $limit: 1 },
          { $project: { _id: 0, createdAt: 1 } },
        ])
        .exec(),
      this.runModel.countDocuments({ modelVersion: activeModelVersion }),
      this.runModel.countDocuments({
        modelVersion: activeModelVersion,
        status: PredictionRunStatus.COMPLETED,
      }),
      this.runModel.countDocuments({
        modelVersion: activeModelVersion,
        status: PredictionRunStatus.PARTIAL,
      }),
      this.runModel.countDocuments({
        modelVersion: activeModelVersion,
        status: PredictionRunStatus.FAILED,
      }),
      this.runModel
        .aggregate<{
          average: number | null;
        }>([
          {
            $match: {
              modelVersion: activeModelVersion,
              durationMs: { $gte: 0 },
            },
          },
          { $group: { _id: null, average: { $avg: '$durationMs' } } },
        ])
        .exec(),
      this.runModel.countDocuments({
        modelVersion: activeModelVersion,
        startedAt: { $gte: last24h },
      }),
      this.slipModel.countDocuments({
        'legs.modelVersion': activeModelVersion,
      }),
      this.slipModel.countDocuments({
        'legs.modelVersion': activeModelVersion,
        status: SlipStatus.READY,
      }),
      this.slipModel.countDocuments({
        'legs.modelVersion': activeModelVersion,
        status: SlipStatus.PUBLISHED,
      }),
      this.slipModel.countDocuments({
        'legs.modelVersion': activeModelVersion,
        sportyBetSlipCode: { $exists: true, $ne: '' },
      }),
      this.marketModel
        .aggregate<{
          marketKey: string;
          marketName: string;
          documents: number;
          selections: number;
          calculated: number;
          unavailable: number;
          finalSelections: number;
          oddsReadySelections: number;
          providerPricedSelections: number;
          estimatedPricedSelections: number;
          averageProbability: number | null;
          averageConfidence: number | null;
          averageFinalProbability: number | null;
          averageFinalConfidence: number | null;
          averageFinalDataQuality: number | null;
          averageFinalSafetyScore: number | null;
          averageFinalCalibrationReliability: number | null;
          averageFinalDecimalOdds: number | null;
          averageFinalExpectedValuePercent: number | null;
        }>([
          { $match: { modelVersion: activeModelVersion } },
          {
            $unwind: { path: '$selections', preserveNullAndEmptyArrays: false },
          },
          {
            $group: {
              _id: '$marketKey',
              marketName: { $first: '$marketName' },
              documents: { $addToSet: '$_id' },
              selections: { $sum: 1 },
              calculated: {
                $sum: {
                  $cond: [
                    {
                      $eq: ['$selections.status', PredictionStatus.CALCULATED],
                    },
                    1,
                    0,
                  ],
                },
              },
              unavailable: {
                $sum: {
                  $cond: [
                    {
                      $eq: ['$selections.status', PredictionStatus.UNAVAILABLE],
                    },
                    1,
                    0,
                  ],
                },
              },
              finalSelections: {
                $sum: {
                  $cond: [
                    { $eq: ['$selections.isFinalSelection', true] },
                    1,
                    0,
                  ],
                },
              },
              oddsReadySelections: {
                $sum: {
                  $cond: [
                    { $eq: ['$selections.oddsPredictionReady', true] },
                    1,
                    0,
                  ],
                },
              },
              providerPricedSelections: {
                $sum: {
                  $cond: [{ $eq: ['$selections.priceType', 'PROVIDER'] }, 1, 0],
                },
              },
              estimatedPricedSelections: {
                $sum: {
                  $cond: [
                    { $eq: ['$selections.priceType', 'ESTIMATED'] },
                    1,
                    0,
                  ],
                },
              },
              averageProbability: { $avg: '$selections.probability' },
              averageConfidence: { $avg: '$selections.confidence' },
              averageFinalProbability: {
                $avg: {
                  $cond: [
                    { $eq: ['$selections.isFinalSelection', true] },
                    '$selections.probability',
                    null,
                  ],
                },
              },
              averageFinalConfidence: {
                $avg: {
                  $cond: [
                    { $eq: ['$selections.isFinalSelection', true] },
                    '$selections.confidence',
                    null,
                  ],
                },
              },
              averageFinalDataQuality: {
                $avg: {
                  $cond: [
                    { $eq: ['$selections.isFinalSelection', true] },
                    '$selections.dataQuality',
                    null,
                  ],
                },
              },
              averageFinalSafetyScore: {
                $avg: {
                  $cond: [
                    { $eq: ['$selections.isFinalSelection', true] },
                    '$selections.safetyScore',
                    null,
                  ],
                },
              },
              averageFinalCalibrationReliability: {
                $avg: {
                  $cond: [
                    { $eq: ['$selections.isFinalSelection', true] },
                    '$selections.calibrationReliability',
                    null,
                  ],
                },
              },
              averageFinalDecimalOdds: {
                $avg: {
                  $cond: [
                    { $eq: ['$selections.isFinalSelection', true] },
                    '$selections.decimalOdds',
                    null,
                  ],
                },
              },
              averageFinalExpectedValuePercent: {
                $avg: {
                  $cond: [
                    { $eq: ['$selections.isFinalSelection', true] },
                    '$selections.expectedValuePercent',
                    null,
                  ],
                },
              },
            },
          },
          {
            $project: {
              _id: 0,
              marketKey: '$_id',
              marketName: 1,
              documents: { $size: '$documents' },
              selections: 1,
              calculated: 1,
              unavailable: 1,
              finalSelections: 1,
              oddsReadySelections: 1,
              providerPricedSelections: 1,
              estimatedPricedSelections: 1,
              averageProbability: 1,
              averageConfidence: 1,
              averageFinalProbability: 1,
              averageFinalConfidence: 1,
              averageFinalDataQuality: 1,
              averageFinalSafetyScore: 1,
              averageFinalCalibrationReliability: 1,
              averageFinalDecimalOdds: 1,
              averageFinalExpectedValuePercent: 1,
            },
          },
          { $sort: { marketName: 1 } },
        ])
        .exec(),
      this.marketModel
        .aggregate<{
          selections: number;
          calculatedSelections: number;
          probability: number | null;
          confidence: number | null;
          recommendationEligibleSelections: number;
          providerPricedSelections: number;
          estimatedPricedSelections: number;
          oddsReadySelections: number;
          calibrationAppliedSelections: number;
          averageExpectedValuePercent: number | null;
          averageDataQuality: number | null;
          averageSafetyScore: number | null;
          averageCalibrationReliability: number | null;
        }>([
          { $match: { modelVersion: activeModelVersion } },
          { $unwind: '$selections' },
          {
            $group: {
              _id: null,
              selections: { $sum: 1 },
              calculatedSelections: {
                $sum: {
                  $cond: [
                    {
                      $eq: ['$selections.status', PredictionStatus.CALCULATED],
                    },
                    1,
                    0,
                  ],
                },
              },
              probability: {
                $avg: {
                  $cond: [
                    {
                      $eq: ['$selections.status', PredictionStatus.CALCULATED],
                    },
                    '$selections.probability',
                    null,
                  ],
                },
              },
              confidence: {
                $avg: {
                  $cond: [
                    {
                      $eq: ['$selections.status', PredictionStatus.CALCULATED],
                    },
                    '$selections.confidence',
                    null,
                  ],
                },
              },
              recommendationEligibleSelections: {
                $sum: {
                  $cond: [
                    { $eq: ['$selections.recommendationEligible', true] },
                    1,
                    0,
                  ],
                },
              },
              providerPricedSelections: {
                $sum: {
                  $cond: [{ $eq: ['$selections.priceType', 'PROVIDER'] }, 1, 0],
                },
              },
              estimatedPricedSelections: {
                $sum: {
                  $cond: [
                    { $eq: ['$selections.priceType', 'ESTIMATED'] },
                    1,
                    0,
                  ],
                },
              },
              oddsReadySelections: {
                $sum: {
                  $cond: [
                    { $eq: ['$selections.oddsPredictionReady', true] },
                    1,
                    0,
                  ],
                },
              },
              calibrationAppliedSelections: {
                $sum: {
                  $cond: [
                    { $eq: ['$selections.calibrationApplied', true] },
                    1,
                    0,
                  ],
                },
              },
              averageSafetyScore: {
                $avg: {
                  $cond: [
                    { $eq: ['$selections.isFinalSelection', true] },
                    '$selections.safetyScore',
                    null,
                  ],
                },
              },
              averageCalibrationReliability: {
                $avg: {
                  $cond: [
                    { $eq: ['$selections.isFinalSelection', true] },
                    '$selections.calibrationReliability',
                    null,
                  ],
                },
              },
              averageExpectedValuePercent: {
                $avg: {
                  $cond: [
                    { $eq: ['$selections.recommendationEligible', true] },
                    '$selections.expectedValuePercent',
                    null,
                  ],
                },
              },
              averageDataQuality: {
                $avg: {
                  $cond: [
                    {
                      $eq: ['$selections.status', PredictionStatus.CALCULATED],
                    },
                    '$selections.dataQuality',
                    null,
                  ],
                },
              },
            },
          },
        ])
        .exec(),
      missingOddsSportsFixtures,
      staleSportsFixtures,
      this.runModel
        .distinct('eventId', {
          modelVersion: activeModelVersion,
          dataQuality: { $lt: 0.25 },
        })
        .then((ids) => ids.length),
      this.pickCenterModel
        .aggregate<{ count: number }>([
          { $match: { modelVersion: activeModelVersion } },
          {
            $project: {
              count: { $size: { $ifNull: ['$selectedMarkets', []] } },
            },
          },
          { $group: { _id: null, count: { $sum: '$count' } } },
        ])
        .exec(),
      this.pickCenterModel
        .aggregate<{ count: number }>([
          { $match: { modelVersion: activeModelVersion, status: 'SELECTED' } },
          {
            $project: {
              count: { $size: { $ifNull: ['$selectedMarkets', []] } },
            },
          },
          { $group: { _id: null, count: { $sum: '$count' } } },
        ])
        .exec(),
      this.eventModel
        .find({})
        .sort({ occurredAt: -1 })
        .limit(PREDICTION_ENGINE_CONFIG.monitor.recentEventsLimit)
        .lean()
        .exec(),
      this.calibrationModel
        .find({ modelVersion: activeModelVersion })
        .select({
          marketKey: 1,
          sampleSize: 1,
          brierScore: 1,
          calibrationError: 1,
          reliabilityScore: 1,
          logLoss: 1,
          active: 1,
        })
        .lean()
        .exec(),
    ]);

    const curatedHorizon = new Date(
      now.getTime() +
        PREDICTION_ENGINE_CONFIG.curatedPredictions.horizonHours * 3_600_000,
    );
    const [
      curatedTotal,
      curatedReady,
      curatedPublished,
      curatedSettled,
      curatedCancelled,
      curatedUpcomingWithin48Hours,
      curatedLive,
      eligiblePickCenterFixtures,
      curatedHorizonEventIds,
      automaticActiveSlips,
      sureOddsPublishedSlips,
      generatedSlipsToday,
      marketEngineWindowFixtures,
      marketEngineWindowWithSummary,
      marketEngineWindowMissingSummary,
    ] = await Promise.all([
      this.curatedPredictionModel.countDocuments({}).exec(),
      this.curatedPredictionModel
        .countDocuments({ status: 'READY', settlementStatus: 'PENDING' })
        .exec(),
      this.curatedPredictionModel
        .countDocuments({ status: 'PUBLISHED', settlementStatus: 'PENDING' })
        .exec(),
      this.curatedPredictionModel
        .countDocuments({
          $or: [
            { status: 'SETTLED' },
            {
              settlementStatus: {
                $in: ['WON', 'LOST', 'VOID', 'PUSH', 'HALF_WON', 'HALF_LOST'],
              },
            },
          ],
        })
        .exec(),
      this.curatedPredictionModel
        .countDocuments({ status: 'CANCELLED' })
        .exec(),
      this.curatedPredictionModel
        .countDocuments({
          status: { $in: ['READY', 'PUBLISHED'] },
          settlementStatus: 'PENDING',
          live: { $ne: true },
          fixtureDateFrom: { $gte: now, $lte: curatedHorizon },
          completed: { $ne: true },
        })
        .exec(),
      this.curatedPredictionModel
        .countDocuments({
          status: { $in: ['READY', 'PUBLISHED'] },
          settlementStatus: 'PENDING',
          live: true,
          completed: { $ne: true },
        })
        .exec(),
      this.pickCenterModel
        .find({
          status: 'SELECTED' as PickCenter['status'],
          modelVersion: activeModelVersion,
          completed: { $ne: true },
          $or: [
            { fixtureDate: { $gte: now, $lte: curatedHorizon } },
            { live: true },
          ],
        })
        .select({ eventId: 1 })
        .lean()
        .exec(),
      this.curatedPredictionModel
        .distinct('eventId', {
          status: { $in: ['READY', 'PUBLISHED'] },
          settlementStatus: 'PENDING',
          completed: { $ne: true },
          $or: [
            { fixtureDateFrom: { $gte: now, $lte: curatedHorizon } },
            { live: true },
          ],
        })
        .exec(),
      this.slipModel
        .countDocuments({
          automatic: true,
          status: { $in: [SlipStatus.READY, SlipStatus.PUBLISHED] },
          settlementStatus: 'PENDING',
        })
        .exec(),
      this.slipModel
        .countDocuments({
          productType: 'SURE_ODDS' as PredictionSlip['productType'],
          status: SlipStatus.PUBLISHED,
          settlementStatus: 'PENDING',
        })
        .exec(),
      this.slipModel
        .countDocuments({
          automatic: true,
          generatedDateKey: this.lagosDateKey(now),
          status: { $in: [SlipStatus.READY, SlipStatus.PUBLISHED] },
        })
        .exec(),
      marketWindowTotal,
      marketWindowWithSportsData,
      marketWindowMissingSportsData,
    ]);
    const eventIdKey = (value: unknown): string => {
      if (value == null) return '';
      if (typeof value === 'object') return JSON.stringify(value) ?? '';
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        typeof value === 'bigint' ||
        typeof value === 'symbol'
      )
        return String(value);
      return '';
    };
    const curatedEventIdSet = new Set(
      (curatedHorizonEventIds as unknown[]).map(eventIdKey),
    );
    const missingForEligiblePickCenterFixtures = (
      eligiblePickCenterFixtures as Array<{ eventId?: unknown }>
    ).filter((pick) => !curatedEventIdSet.has(eventIdKey(pick.eventId))).length;

    const queueMap = Object.fromEntries(
      queueCounts.map((item) => [item._id, item.count]),
    );
    const selectionStats = allSelectionStats[0] ?? {};
    const durationStats = avgDuration[0] ?? {};
    const pickRows = selectedPickCenterRows;
    const rankedRows = rankedPickCenterRows;
    const lastCuratedRefreshAt = (
      state as unknown as { lastCuratedRefreshAt?: unknown } | null
    )?.lastCuratedRefreshAt;
    const lastCalibrationRefreshAt = (
      state as unknown as { lastCalibrationRefreshAt?: unknown } | null
    )?.lastCalibrationRefreshAt;
    const asStringArray = (value: unknown): string[] => {
      if (!Array.isArray(value)) return [];
      return value
        .filter(
          (entry): entry is string | number | boolean =>
            typeof entry === 'string' ||
            typeof entry === 'number' ||
            typeof entry === 'boolean',
        )
        .map(String);
    };
    const calibrations = calibrationDocuments as Array<{
      sampleSize?: number;
      brierScore?: number;
      calibrationError?: number;
      reliabilityScore?: number;
      active?: boolean;
      logLoss?: number;
    }>;
    const numericMean = (values: Array<number | undefined>) => {
      const valid = values.filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value),
      );
      return valid.length
        ? Number(
            (
              valid.reduce((sum, value) => sum + value, 0) / valid.length
            ).toFixed(4),
          )
        : null;
    };
    const markets = marketAggregate.map((item) => ({
      marketKey: item.marketKey,
      marketName: item.marketName,
      documents: item.documents,
      calculated: item.calculated,
      unavailable: item.unavailable,
      selections: item.selections,
      calculatedSelections: item.calculated,
      unavailableSelections: item.unavailable,
      finalSelections: item.finalSelections ?? 0,
      oddsReadySelections: item.oddsReadySelections ?? 0,
      providerPricedSelections: item.providerPricedSelections ?? 0,
      estimatedPricedSelections: item.estimatedPricedSelections ?? 0,
      averageProbability:
        item.averageProbability == null
          ? null
          : Number(Number(item.averageProbability).toFixed(4)),
      averageConfidence:
        item.averageConfidence == null
          ? null
          : Number(Number(item.averageConfidence).toFixed(2)),
      averageFinalProbability:
        item.averageFinalProbability == null
          ? null
          : Number(Number(item.averageFinalProbability).toFixed(4)),
      averageFinalConfidence:
        item.averageFinalConfidence == null
          ? null
          : Number(Number(item.averageFinalConfidence).toFixed(2)),
      averageFinalDataQuality:
        item.averageFinalDataQuality == null
          ? null
          : Number(Number(item.averageFinalDataQuality).toFixed(4)),
      averageFinalSafetyScore:
        item.averageFinalSafetyScore == null
          ? null
          : Number(Number(item.averageFinalSafetyScore).toFixed(4)),
      averageFinalCalibrationReliability:
        item.averageFinalCalibrationReliability == null
          ? null
          : Number(Number(item.averageFinalCalibrationReliability).toFixed(4)),
      averageFinalDecimalOdds:
        item.averageFinalDecimalOdds == null
          ? null
          : Number(Number(item.averageFinalDecimalOdds).toFixed(4)),
      averageFinalExpectedValuePercent:
        item.averageFinalExpectedValuePercent == null
          ? null
          : Number(Number(item.averageFinalExpectedValuePercent).toFixed(2)),
    }));

    const runtime = this.getOperationRuntimeSnapshot(now.getTime());
    if (PREDICTION_ENGINE_CONFIG.enabled && state?.workerRunning !== true) {
      runtime.alerts.unshift({
        code: 'ENGINE_WORKER_NOT_RUNNING',
        severity: 'ERROR',
        message: 'Prediction Engine is enabled, but persisted worker state does not report the worker as running.',
      });
    }
    const oldestPendingAt = oldestPending[0]?.createdAt;
    if (oldestPendingAt instanceof Date && now.getTime() - oldestPendingAt.getTime() > 10 * 60_000) {
      runtime.alerts.push({
        code: 'QUEUE_BACKLOG_AGE',
        severity: 'WARNING',
        operation: 'queue-sync',
        message: `The oldest pending queue item is ${Math.round((now.getTime() - oldestPendingAt.getTime()) / 60_000)} minutes old.`,
      });
    }

    const dashboard: PredictionEngineDashboard = {
      generatedAt: now.toISOString(),
      runtime,
      engine: {
        enabled: state?.enabled ?? PREDICTION_ENGINE_CONFIG.enabled,
        workerRunning: state?.workerRunning ?? false,
        modelVersion: activeModelVersion,
        timingGate: 'ODDS_READINESS',
        lastQueueSyncAt: state?.lastQueueSyncAt?.toISOString?.(),
        lastSuccessfulRunAt: state?.lastSuccessfulRunAt?.toISOString?.(),
        lastFailedRunAt: state?.lastFailedRunAt?.toISOString?.(),
        lastError: state?.lastError,
        lastProductRefreshAt: (() => {
          const value = (
            state as unknown as { lastProductRefreshAt?: unknown } | null
          )?.lastProductRefreshAt;
          return value instanceof Date ? value.toISOString() : undefined;
        })(),
        lastCuratedRefreshAt:
          lastCuratedRefreshAt instanceof Date
            ? lastCuratedRefreshAt.toISOString()
            : undefined,
        lastSlipRefreshAt: (() => {
          const value = (
            state as unknown as { lastSlipRefreshAt?: unknown } | null
          )?.lastSlipRefreshAt;
          return value instanceof Date ? value.toISOString() : undefined;
        })(),
        lastCalibrationRefreshAt:
          lastCalibrationRefreshAt instanceof Date
            ? lastCalibrationRefreshAt.toISOString()
            : undefined,
        productRefreshIntervalMs:
          PREDICTION_ENGINE_CONFIG.curatedPredictions.refreshIntervalMs,
      },
      fixtures: {
        upcoming,
        eligibleWithSummary,
        upcomingMissingSummary,
        live,
        completed: completedFixtures,
      },
      predictions: {
        marketDocuments: totalMarketDocuments,
        calculatedMarketDocuments,
        partialMarketDocuments,
        unavailableMarketDocuments,
        failedMarketDocuments,
        selections: selectionStats.selections ?? 0,
        calculatedSelections: selectionStats.calculatedSelections ?? 0,
        eligibleRecommendations:
          selectionStats.recommendationEligibleSelections ?? 0,
        modelVersion: activeModelVersion,
        selectedPickCenterMarkets: pickRows[0]?.count ?? 0,
        rankedPickCenterMarkets: rankedRows[0]?.count ?? 0,
        publishedPickCenterMarkets: rankedRows[0]?.count ?? 0,
      },
      queue: {
        pending: queueMap[PredictionQueueStatus.PENDING] ?? 0,
        processing: queueMap[PredictionQueueStatus.PROCESSING] ?? 0,
        retry: queueMap[PredictionQueueStatus.RETRY] ?? 0,
        waitingForOdds: queueMap[PredictionQueueStatus.WAITING_FOR_ODDS] ?? 0,
        completed: queueMap[PredictionQueueStatus.COMPLETED] ?? 0,
        failed: queueMap[PredictionQueueStatus.FAILED] ?? 0,
        skipped: queueMap[PredictionQueueStatus.SKIPPED] ?? 0,
        oldestPendingAt: oldestPending[0]?.createdAt.toISOString(),
      },
      runs: {
        total: totalRuns,
        completed: completedRuns,
        partial: partialRuns,
        failed: failedRuns,
        averageDurationMs: Math.round(durationStats.average ?? 0),
        last24Hours: runsLast24h,
      },
      curatedPredictions: {
        total: curatedTotal,
        ready: curatedReady,
        published: curatedPublished,
        settled: curatedSettled,
        cancelled: curatedCancelled,
        upcomingWithin48Hours: curatedUpcomingWithin48Hours,
        live: curatedLive,
        missingForEligiblePickCenterFixtures,
        lastRefresh: {
          matchesScanned: Number(state?.lastCuratedMatchesScanned ?? 0),
          eligibleFixtures: Number(state?.lastCuratedEligibleFixtures ?? 0),
          status: String(state?.lastCuratedRefreshStatus ?? 'UNKNOWN'),
          durationMs: Number(state?.lastCuratedRefreshDurationMs ?? 0),
          minimumProbability:
            PREDICTION_ENGINE_CONFIG.curatedPredictions.minimumProbability,
          minimumConfidence:
            PREDICTION_ENGINE_CONFIG.curatedPredictions.minimumConfidence,
          minimumDataQuality:
            PREDICTION_ENGINE_CONFIG.curatedPredictions.minimumDataQuality,
          minimumSafetyScore:
            PREDICTION_ENGINE_CONFIG.curatedPredictions.minimumSafetyScore,
          created: Number(state?.lastCuratedCreated ?? 0),
          updated: Number(state?.lastCuratedUpdated ?? 0),
          skipped: Number(state?.lastCuratedSkipped ?? 0),
          riskRejected: Number(state?.lastCuratedRiskRejected ?? 0),
          oneSelectionMatches: Number(
            state?.lastCuratedOneSelectionMatches ?? 0,
          ),
          twoSelectionMatches: Number(
            state?.lastCuratedTwoSelectionMatches ?? 0,
          ),
          threeSelectionMatches: Number(
            state?.lastCuratedThreeSelectionMatches ?? 0,
          ),
          publishedRecordsSupplemented: Number(
            state?.lastCuratedPublishedRecordsSupplemented ?? 0,
          ),
          publishedRecordsReconciled: Number(
            state?.lastCuratedPublishedRecordsReconciled ?? 0,
          ),
          skipReasonCounts: (state?.lastCuratedSkipReasonCounts ??
            {}) as Record<string, number>,
          ...(state?.lastCuratedError
            ? { error: String(state.lastCuratedError) }
            : {}),
        },
      },
      slips: {
        total: totalSlips,
        ready: readySlips,
        published: publishedSlips,
        automaticActive: automaticActiveSlips,
        sureOddsPublished: sureOddsPublishedSlips,
        generatedToday: generatedSlipsToday,
        lastRefresh: {
          createdOrUpdated: Number(state?.lastSlipCreatedOrUpdated ?? 0),
          skipped: Number(state?.lastSlipSkipped ?? 0),
          status: String(state?.lastSlipRefreshStatus ?? 'UNKNOWN'),
          durationMs: Number(state?.lastSlipRefreshDurationMs ?? 0),
          minimumProbability:
            PREDICTION_ENGINE_CONFIG.slipCenter.minimumLegProbability,
          minimumConfidence:
            PREDICTION_ENGINE_CONFIG.slipCenter.minimumLegConfidence,
          minimumDataQuality:
            PREDICTION_ENGINE_CONFIG.slipCenter.minimumLegDataQuality,
          minimumSafetyScore:
            PREDICTION_ENGINE_CONFIG.slipCenter.minimumSafetyScore,
          fixtureCandidates: Number(state?.lastSlipFixtureCandidates ?? 0),
          eligibleFixtures: Number(state?.lastSlipEligibleFixtures ?? 0),
          eligibleFixtureDays: Number(state?.lastSlipEligibleFixtureDays ?? 0),
          eligibleEvents: Number(state?.lastSlipEligibleEvents ?? 0),
          pickCenterEventsWithoutEligibleSelections: Number(
            state?.lastSlipPickCenterEventsWithoutEligibleSelections ?? 0,
          ),
          pickCenterEventIdsWithoutEligibleSelections: Array.isArray(
            state?.lastSlipPickCenterEventIdsWithoutEligibleSelections,
          )
            ? state.lastSlipPickCenterEventIdsWithoutEligibleSelections.map(
                String,
              )
            : [],
          coveredEvents: Number(state?.lastSlipCoveredEvents ?? 0),
          coverageEventsRequired: Number(
            state?.lastSlipCoverageEventsRequired ?? 0,
          ),
          coverageEventsSatisfied: Number(
            state?.lastSlipCoverageEventsSatisfied ?? 0,
          ),
          coverageEventIdsMissing: Array.isArray(
            state?.lastSlipCoverageEventIdsMissing,
          )
            ? state.lastSlipCoverageEventIdsMissing.map(String)
            : [],
          coverageDatesRequired: Number(
            state?.lastSlipCoverageDatesRequired ?? 0,
          ),
          coverageDatesSatisfied: Number(
            state?.lastSlipCoverageDatesSatisfied ?? 0,
          ),
          coverageDatesMissing: Array.isArray(
            state?.lastSlipCoverageDatesMissing,
          )
            ? state.lastSlipCoverageDatesMissing.map(String)
            : [],
          coverageSlipsCreated: Number(
            state?.lastSlipCoverageSlipsCreated ?? 0,
          ),
          sameDayFixtureCombinationProhibited: false,
          sameDayFixturesAllowed: true,
          crossDateCombinationsAllowed: false,
          maximumSelectionsPerMatch:
            PREDICTION_ENGINE_CONFIG.slipCenter.maximumSelectionsPerMatch,
          publishedProductsToday: Number(
            state?.lastSlipPublishedProductsToday ?? 0,
          ),
          publishedProductsTomorrow: Number(
            state?.lastSlipPublishedProductsTomorrow ?? 0,
          ),
          targetDateTodayKey: state?.lastSlipTargetDateTodayKey
            ? String(state.lastSlipTargetDateTodayKey)
            : undefined,
          targetDateTomorrowKey: state?.lastSlipTargetDateTomorrowKey
            ? String(state.lastSlipTargetDateTomorrowKey)
            : undefined,
          todayTarget: Number(state?.lastSlipTodayTarget ?? PREDICTION_ENGINE_CONFIG.slipCenter.dailySlipTarget),
          tomorrowTarget: Number(state?.lastSlipTomorrowTarget ?? PREDICTION_ENGINE_CONFIG.slipCenter.dailySlipTarget),
          todayRemaining: Number(state?.lastSlipTodayRemaining ?? PREDICTION_ENGINE_CONFIG.slipCenter.dailySlipTarget),
          tomorrowRemaining: Number(state?.lastSlipTomorrowRemaining ?? PREDICTION_ENGINE_CONFIG.slipCenter.dailySlipTarget),
          ...(state?.lastSlipError
            ? { error: String(state.lastSlipError as unknown) }
            : {}),
        },
        withSportyBetCode: slipsWithCode,
        withoutSportyBetCode: Math.max(0, totalSlips - slipsWithCode),
      },
      marketEngineWindow: {
        coverageScope: 'ALL_RETAINED_UPCOMING_FIXTURES',
        fixtures: marketEngineWindowFixtures,
        withSummary: marketEngineWindowWithSummary,
        missingSummary: marketEngineWindowMissingSummary,
        waitingForOdds: missingOddsSportsFixtures,
      },
      calibration: {
        lastCycleStatus:
          typeof state?.lastCalibrationRefreshStatus === 'string'
            ? (state.lastCalibrationRefreshStatus as unknown as string)
            : undefined,
        lastRefreshAt:
          lastCalibrationRefreshAt instanceof Date &&
          !Number.isNaN(lastCalibrationRefreshAt.getTime())
            ? lastCalibrationRefreshAt.toISOString()
            : undefined,
        lastError:
          state?.lastCalibrationError == null
            ? undefined
            : String(state.lastCalibrationError),
        marketsRefreshedLastCycle: Number(
          state?.lastCalibrationMarketsRefreshed ?? 0,
        ),
        activeMarketsLastCycle: Number(
          state?.lastCalibrationActiveMarkets ?? 0,
        ),
        markets: calibrations.map((item) => {
          const calibrationMarket = item as {
            marketKey?: string | number;
            sampleSize?: number | string;
            active?: boolean;
            reliabilityScore?: number | null;
            brierScore?: number | null;
            calibrationError?: number | null;
            logLoss?: number | null;
          };

          return {
            marketKey: String(calibrationMarket.marketKey ?? ''),
            sampleSize: Math.max(0, Number(calibrationMarket.sampleSize ?? 0)),
            active: calibrationMarket.active === true,
            reliabilityScore:
              typeof calibrationMarket.reliabilityScore === 'number'
                ? calibrationMarket.reliabilityScore
                : null,
            brierScore:
              typeof calibrationMarket.brierScore === 'number'
                ? calibrationMarket.brierScore
                : null,
            calibrationError:
              typeof calibrationMarket.calibrationError === 'number'
                ? calibrationMarket.calibrationError
                : null,
            logLoss:
              typeof calibrationMarket.logLoss === 'number'
                ? calibrationMarket.logLoss
                : null,
          };
        }),
      },
      generationWindows: {
        marketEnginesCoverageScope: 'ALL_RETAINED_UPCOMING_FIXTURES',
        curatedAndSlipForwardHours:
          PREDICTION_ENGINE_CONFIG.curatedPredictions.horizonHours,
        includeLiveFixtures: true,
        oddsModuleReadinessRequired: true,
        pickCenterUsesFixtureTimeWindow: false,
      },
      quality: {
        averageConfidence:
          selectionStats.confidence == null
            ? null
            : Number(selectionStats.confidence.toFixed(2)),
        averageProbability:
          selectionStats.probability == null
            ? null
            : Number(selectionStats.probability.toFixed(4)),
        averageExpectedValuePercent:
          selectionStats.averageExpectedValuePercent == null
            ? null
            : Number(
                Number(selectionStats.averageExpectedValuePercent).toFixed(2),
              ),
        averageDataQuality:
          selectionStats.averageDataQuality == null
            ? null
            : Number(Number(selectionStats.averageDataQuality).toFixed(4)),
        providerPricedSelections: selectionStats.providerPricedSelections ?? 0,
        estimatedPricedSelections:
          selectionStats.estimatedPricedSelections ?? 0,
        oddsReadySelections: selectionStats.oddsReadySelections ?? 0,
        calibrationAppliedSelections:
          selectionStats.calibrationAppliedSelections ?? 0,
        averageSafetyScore:
          selectionStats.averageSafetyScore == null
            ? null
            : Number(Number(selectionStats.averageSafetyScore).toFixed(4)),
        averageCalibrationReliability:
          selectionStats.averageCalibrationReliability == null
            ? null
            : Number(
                Number(selectionStats.averageCalibrationReliability).toFixed(4),
              ),
        recommendationEligibleSelections:
          selectionStats.recommendationEligibleSelections ?? 0,
        missingOddsFixtures,
        missingHistoricalEvidenceFixtures: lowEvidenceRuns,
        staleSummaries,
        calibrationMarkets: calibrations.length,
        calibratedMarkets: calibrations.filter((item) => item.active === true)
          .length,
        calibrationSettledSelections: calibrations.reduce(
          (sum, item) => sum + Math.max(0, Number(item.sampleSize ?? 0)),
          0,
        ),
        meanBrierScore: numericMean(
          calibrations.map((item) => item.brierScore),
        ),
        meanCalibrationError: numericMean(
          calibrations.map((item) => item.calibrationError),
        ),
        meanCalibrationReliability: numericMean(
          calibrations.map((item) => item.reliabilityScore),
        ),
        meanLogLoss: numericMean(calibrations.map((item) => item.logLoss)),
      },
      markets,
      recentEvents: recentEvents as unknown as Record<string, unknown>[],
    };

    const monitorAlerts = dashboard.runtime?.alerts ?? [];
    const failedAlerts = monitorAlerts.filter((alert) => alert.severity === 'ERROR');
    const status = failedAlerts.length > 0
      ? 'FAILED'
      : monitorAlerts.length > 0
        ? 'DEGRADED'
        : 'HEALTHY';
    this.systemMonitor.reportMonitorSnapshot('predictions-engine', {
      status,
      checkedAt: now,
      checks: monitorAlerts,
      warnings: monitorAlerts
        .filter((alert) => alert.severity === 'WARNING')
        .map((alert) => alert.message),
      details: {
        engineEnabled: dashboard.engine.enabled,
        workerRunning: dashboard.engine.workerRunning,
        pendingQueueItems: dashboard.queue.pending,
        retryQueueItems: dashboard.queue.retry,
        failedQueueItems: dashboard.queue.failed,
        failedRuns: dashboard.runs.failed,
        activeOperations: dashboard.runtime?.operations.filter((item) => item.activeRuns > 0).length ?? 0,
        alertCount: monitorAlerts.length,
      },
    });
    return dashboard;
  }

  private lagosDateKey(now: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Lagos',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const values = Object.fromEntries(
      parts.map((item) => [item.type, item.value]),
    );
    return `${values.year}-${values.month}-${values.day}`;
  }

  async getRecentRuns(limit = 50): Promise<any[]> {
    const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.runModel
      .find({ modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion })
      .sort({ startedAt: -1 })
      .limit(bounded)
      .lean()
      .exec();
  }

  async getQueueItems(status?: string, limit = 100): Promise<any[]> {
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    const query: Record<string, any> = {};
    if (
      status &&
      Object.values(PredictionQueueStatus).includes(
        status as PredictionQueueStatus,
      )
    )
      query.status = status;
    return this.queueModel
      .find(query)
      .sort({ priority: -1, fixtureDate: 1 })
      .limit(bounded)
      .lean()
      .exec();
  }

  async getEvents(limit = 100, level?: string): Promise<any[]> {
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    const query: Record<string, any> = {};
    if (
      level &&
      Object.values(PredictionEventLevel).includes(
        level as PredictionEventLevel,
      )
    )
      query.level = level;
    return this.eventModel
      .find(query)
      .sort({ occurredAt: -1 })
      .limit(bounded)
      .lean()
      .exec();
  }

  async getMarketDocuments(eventId: string): Promise<any[]> {
    return this.marketModel
      .find({ eventId })
      .sort({ marketKey: 1 })
      .lean()
      .exec();
  }

  /**
   * Read-only, market-by-market coverage audit for one fixture.
   * It compares the active prediction catalogue, persisted market results,
   * current Odds quotes, and Pick Center output without triggering generation
   * or changing any prediction.
   */
  async getMarketCoverageAudit(eventId: string): Promise<Record<string, unknown>> {
    const normalizedEventId = String(eventId ?? '').trim();
    if (!normalizedEventId) {
      return {
        eventId: normalizedEventId,
        generatedAt: new Date(),
        error: 'A non-empty Sports fixture eventId is required.',
      };
    }

    const [marketDocuments, oddsQuotes, pickCenter, currentFixtureSourceRevision] = await Promise.all([
      this.marketModel
        .find({
          eventId: normalizedEventId,
          modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
        })
        .lean()
        .exec() as Promise<any[]>,
      this.oddsRead.getFixturePrices(normalizedEventId),
      this.pickCenterModel
        .findOne({ eventId: normalizedEventId })
        .lean()
        .exec() as Promise<any>,
      this.sportsRevisions.getCurrentRevision('FIXTURE', normalizedEventId),
    ]);

    const documentsByMarket = new Map<string, any>();
    for (const document of marketDocuments) {
      const key = String(document.marketKey ?? '').trim().toUpperCase();
      if (key) documentsByMarket.set(key, document);
    }

    const pickSelections: any[] = Array.isArray(pickCenter?.selectedMarkets)
      ? pickCenter.selectedMarkets
      : [];
    const selectedByMarket = new Map<string, any>();
    for (const selection of pickSelections) {
      const key = String(selection?.marketKey ?? '').trim().toUpperCase();
      if (key && !selectedByMarket.has(key)) selectedByMarket.set(key, selection);
    }

    const sameLine = (left: unknown, right: unknown): boolean => {
      const leftMissing = left === undefined || left === null || left === '';
      const rightMissing = right === undefined || right === null || right === '';
      if (leftMissing || rightMissing) return leftMissing && rightMissing;
      const leftNumber = Number(left);
      const rightNumber = Number(right);
      return Number.isFinite(leftNumber)
        && Number.isFinite(rightNumber)
        && Math.abs(leftNumber - rightNumber) < 0.001;
    };
    const quoteMatchesSelection = (quote: any, selection: any): boolean =>
      String(quote?.selectionKey ?? '').trim().toUpperCase()
        === String(selection?.key ?? '').trim().toUpperCase()
      && sameLine(quote?.line, selection?.line);
    const hasUsableOdds = (quote: any): boolean =>
      quote?.predictionReady === true
      && quote?.isFresh === true
      && (quote?.priceType === 'PROVIDER' || quote?.priceType === 'ESTIMATED')
      && Number.isFinite(Number(quote?.decimalOdds))
      && Number(quote.decimalOdds) >= PREDICTION_ENGINE_CONFIG.selectionEligibility.minimumDecimalOdds
      && Number(quote.decimalOdds) <= PREDICTION_ENGINE_CONFIG.selectionEligibility.maximumDecimalOdds
      && Boolean(String(quote?.oddsCalculationMethod ?? '').trim())
      && ['BOOKMAKER_ONLY', 'BOOKMAKER_PLUS_HISTORY', 'HISTORICAL_ONLY', 'PRIOR_ONLY']
        .includes(String(quote?.oddsBasis ?? ''));

    const markets = FOOTBALL_MARKET_CATALOG.map((definition) => {
      const marketKey = String(definition.key).toUpperCase();
      const canonicalMarket = FOOTBALL_MARKET_BY_PREDICTION_KEY.get(marketKey as any);
      const document = documentsByMarket.get(marketKey);
      const selections: any[] = Array.isArray(document?.selections)
        ? document.selections
        : [];
      const marketQuotes = canonicalMarket
        ? oddsQuotes.filter((quote: any) => String(quote.marketId) === String(canonicalMarket.id))
        : [];
      const freshQuotes = marketQuotes.filter((quote: any) => quote.isFresh === true);
      const usableQuotes = marketQuotes.filter(hasUsableOdds);
      const calculatedSelections = selections.filter((selection) =>
        String(selection?.status ?? '').toUpperCase() === 'CALCULATED'
        && Number.isFinite(Number(selection?.probability))
        && Number(selection.probability) > 0
        && Number(selection.probability) < 1,
      );
      const finalSelections = selections.filter((selection) => selection?.isFinalSelection === true);
      const oddsReadySelections = selections.filter((selection) => selection?.oddsPredictionReady === true);
      const selectionsWithMatchingUsableQuote = calculatedSelections.filter((selection) =>
        marketQuotes.some((quote: any) => quoteMatchesSelection(quote, selection) && hasUsableOdds(quote)),
      );
      const matchedUsableQuoteIdentities = new Set<string>();
      for (const quote of usableQuotes) {
        if (selections.some((selection) => quoteMatchesSelection(quote, selection))) {
          matchedUsableQuoteIdentities.add(
            `${String(quote.selectionKey).toUpperCase()}::${quote.line == null ? '-' : Number(quote.line).toFixed(3)}`,
          );
        }
      }
      const readyQuotesWithoutModelSelection = Math.max(0, usableQuotes.length - matchedUsableQuoteIdentities.size);
      const selectedInPickCenter = selectedByMarket.get(marketKey);
      const finalSelection = finalSelections.length === 1 ? finalSelections[0] : undefined;
      const finalSelectionInPickCenter = Boolean(
        finalSelection
        && selectedInPickCenter
        && String(selectedInPickCenter.selectionKey ?? '').toUpperCase() === String(finalSelection.key ?? '').toUpperCase()
        && String(selectedInPickCenter.marketPredictionId ?? '') === String(document?._id ?? ''),
      );
      const pricingEnabled = definition.pricingEnabled !== false;

      let coverageState: string;
      let blockingReason: string | null = null;
      if (!canonicalMarket) {
        coverageState = 'CANONICAL_ODDS_MAPPING_MISSING';
        blockingReason = 'The prediction market has no matching market ID in the canonical Odds catalogue.';
      } else if (!pricingEnabled) {
        coverageState = 'CATALOG_DISABLED';
        blockingReason = definition.notes ?? 'Pricing is intentionally disabled for this market.';
      } else if (!document) {
        coverageState = usableQuotes.length
          ? 'ODDS_READY_BUT_PREDICTION_DOCUMENT_MISSING'
          : 'PREDICTION_DOCUMENT_MISSING';
        blockingReason = usableQuotes.length
          ? 'Fresh prediction-ready Odds quotes exist, but the active model version has no persisted prediction document for this market.'
          : 'No persisted market prediction exists for the active model version.';
      } else if (Number(document.fixtureSourceRevision ?? -1) !== currentFixtureSourceRevision) {
        coverageState = 'PREDICTION_SOURCE_REVISION_STALE';
        blockingReason = `The prediction was generated from Sports fixture revision ${document.fixtureSourceRevision ?? 'missing'}, while the current revision is ${currentFixtureSourceRevision}. Recalculation is required.`;
      } else if (finalSelections.length > 1) {
        coverageState = 'MULTIPLE_FINAL_SELECTIONS';
        blockingReason = 'More than one final selection is stored for this market; the one-selection-per-market invariant is violated.';
      } else if (finalSelectionInPickCenter) {
        coverageState = 'PICK_CENTER_SELECTED';
      } else if (finalSelections.length === 1) {
        coverageState = 'FINAL_SELECTION_NOT_IN_PICK_CENTER';
        blockingReason = 'The market has one final selection, but the matching selection is absent from the current Pick Center snapshot.';
      } else if (usableQuotes.length > 0 && calculatedSelections.length === 0) {
        coverageState = 'ODDS_READY_BUT_MODEL_UNAVAILABLE';
        blockingReason = 'Fresh prediction-ready Odds quotes exist, but the market model produced no calculated probability.';
      } else if (calculatedSelections.length > 0 && usableQuotes.length > 0 && selectionsWithMatchingUsableQuote.length === 0) {
        coverageState = 'MODEL_SELECTIONS_NOT_ODDS_MATCHED';
        blockingReason = 'The model calculated probabilities, but none of the emitted selection keys and lines match a fresh prediction-ready Odds quote.';
      } else if (calculatedSelections.length > 0) {
        coverageState = 'CALCULATED_NO_FINAL_SELECTION';
        blockingReason = 'The model calculated candidate probabilities, but no single candidate passed the market engine final-selection checks.';
      } else if (marketQuotes.length === 0) {
        coverageState = 'NO_ODDS_QUOTES';
        blockingReason = 'The Odds module has no active quote for this canonical market and fixture.';
      } else if (freshQuotes.length === 0) {
        coverageState = 'ODDS_QUOTES_STALE';
        blockingReason = 'Stored Odds quotes exist, but none is currently marked fresh.';
      } else if (usableQuotes.length === 0) {
        coverageState = 'ODDS_QUOTES_NOT_PREDICTION_READY';
        blockingReason = 'Fresh quotes exist, but none satisfies the Odds readiness, price, provenance, and calculation-method checks.';
      } else {
        coverageState = 'ODDS_QUOTES_NOT_USABLE';
        blockingReason = 'No quote passed the current Odds readiness and technical price validation checks.';
      }

      const documentDiagnostics = Array.isArray(document?.diagnostics)
        ? document.diagnostics.filter((item: unknown) => typeof item === 'string').slice(0, 6)
        : [];
      const selectionDiagnostics = selections
        .flatMap((selection) => Array.isArray(selection?.diagnostics) ? selection.diagnostics : [])
        .filter((item: unknown) => typeof item === 'string');
      const uniqueSelectionDiagnostics = [...new Set(selectionDiagnostics)].slice(0, 6);

      return {
        marketKey,
        marketId: canonicalMarket?.id ?? null,
        marketName: definition.fullName,
        abbreviation: definition.abbreviation,
        family: definition.family,
        model: definition.model,
        selectionMode: definition.selectionMode,
        period: definition.period,
        pricingEnabled,
        requiredData: definition.requiredData ?? [],
        minimumSampleSize: definition.minimumSampleSize ?? null,
        catalogueNotes: definition.notes ?? null,
        prediction: {
          documentPresent: Boolean(document),
          fixtureSourceRevision: document?.fixtureSourceRevision ?? null,
          fixtureSourceRevisionCurrent: document
            ? Number(document.fixtureSourceRevision ?? -1) === currentFixtureSourceRevision
            : null,
          status: document?.status ?? null,
          selectionCount: selections.length,
          calculatedSelectionCount: calculatedSelections.length,
          oddsReadySelectionCount: oddsReadySelections.length,
          finalSelectionCount: finalSelections.length,
          finalSelections: finalSelections.map((selection) => ({
            selectionKey: String(selection.key ?? ''),
            line: selection.line ?? null,
            probability: selection.probability ?? null,
            confidence: selection.confidence ?? null,
            decimalOdds: selection.decimalOdds ?? null,
            priceType: selection.priceType ?? null,
            oddsBasis: selection.oddsBasis ?? null,
          })),
          calculatedSelectionsWithMatchingUsableOdds: selectionsWithMatchingUsableQuote.length,
          diagnostics: [...documentDiagnostics, ...uniqueSelectionDiagnostics].slice(0, 10),
        },
        odds: {
          quoteCount: marketQuotes.length,
          freshQuoteCount: freshQuotes.length,
          predictionReadyQuoteCount: marketQuotes.filter((quote: any) => quote.predictionReady === true).length,
          freshPredictionReadyQuoteCount: usableQuotes.length,
          readyQuotesWithoutModelSelection,
        },
        pickCenter: {
          selected: Boolean(selectedInPickCenter),
          selectionKey: selectedInPickCenter?.selectionKey ?? null,
          matchesFinalSelection: finalSelectionInPickCenter,
        },
        coverageState,
        blockingReason,
      };
    });

    const count = (predicate: (market: any) => boolean): number => markets.filter(predicate).length;
    const totals = {
      catalogMarketCount: markets.length,
      pricingEnabledMarketCount: count((market) => market.pricingEnabled),
      canonicalMappingMissingCount: count((market) => market.coverageState === 'CANONICAL_ODDS_MAPPING_MISSING'),
      predictionDocumentsFound: marketDocuments.length,
      marketsWithPredictionDocument: count((market) => market.prediction.documentPresent),
      marketsWithStaleSourceRevision: count((market) => market.coverageState === 'PREDICTION_SOURCE_REVISION_STALE'),
      marketsWithoutPredictionDocument: count((market) => !market.prediction.documentPresent && market.pricingEnabled),
      marketsWithFreshPredictionReadyOdds: count((market) => market.odds.freshPredictionReadyQuoteCount > 0),
      marketsWithCalculatedProbability: count((market) => market.prediction.calculatedSelectionCount > 0),
      marketsWithOneFinalSelection: count((market) => market.prediction.finalSelectionCount === 1),
      marketsWithMultipleFinalSelections: count((market) => market.prediction.finalSelectionCount > 1),
      marketsSelectedInPickCenter: count((market) => market.pickCenter.matchesFinalSelection),
      marketsFinalButMissingFromPickCenter: count((market) => market.coverageState === 'FINAL_SELECTION_NOT_IN_PICK_CENTER'),
      marketsWithOddsReadyQuotesButNoCalculatedProbability: count((market) => market.coverageState === 'ODDS_READY_BUT_MODEL_UNAVAILABLE'),
      marketsCalculatedButWithoutFinalSelection: count((market) => market.coverageState === 'CALCULATED_NO_FINAL_SELECTION'),
      marketsWithModelToOddsSelectionMismatch: count((market) => market.coverageState === 'MODEL_SELECTIONS_NOT_ODDS_MATCHED'),
      freshPredictionReadyQuotesWithoutModelSelection: markets.reduce((sum, market) => sum + market.odds.readyQuotesWithoutModelSelection, 0),
    };

    return {
      eventId: normalizedEventId,
      generatedAt: new Date(),
      modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
      fixture: marketDocuments[0]
        ? {
            leagueId: marketDocuments[0].leagueId ?? null,
            fixtureDate: marketDocuments[0].fixtureDate ?? null,
            homeTeamName: marketDocuments[0].homeTeamName ?? null,
            awayTeamName: marketDocuments[0].awayTeamName ?? null,
            live: marketDocuments[0].live === true,
            completed: marketDocuments[0].completed === true,
            predictionSourceRevision: marketDocuments[0].fixtureSourceRevision ?? null,
            currentSourceRevision: currentFixtureSourceRevision,
            sourceRevisionCurrent: Number(marketDocuments[0].fixtureSourceRevision ?? -1) === currentFixtureSourceRevision,
          }
        : {
            currentSourceRevision: currentFixtureSourceRevision,
            predictionSourceRevision: null,
            sourceRevisionCurrent: null,
          },
      pickCenterSnapshot: pickCenter
        ? {
            status: pickCenter.status ?? null,
            selectedMarketCount: pickCenter.selectedMarketCount ?? pickSelections.length,
            updatedAt: pickCenter.updatedAt ?? null,
          }
        : null,
      totals,
      markets,
      note: 'Read-only audit. It does not generate predictions, refresh Odds, or mutate Pick Center.',
    };
  }

  /**
   * Read-only coverage inventory across a bounded page of retained future
   * fixtures. Unlike the single-fixture audit, this endpoint shows which
   * canonical markets repeatedly stop at the same pipeline stage.
   *
   * It reads the durable prediction queue as the fixture inventory, so fixtures
   * with no generated MarketPrediction documents are still represented.
   */
  async getMarketCoverageInventory(input: {
    from?: string;
    to?: string;
    leagueId?: string;
    page?: number;
    pageSize?: number;
  } = {}): Promise<Record<string, unknown>> {
    const generatedAt = new Date();
    const from = input.from ? new Date(input.from) : generatedAt;
    const to = input.to
      ? new Date(input.to)
      : new Date(generatedAt.getTime() + 7 * 24 * 60 * 60 * 1000);

    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
      throw new BadRequestException('Market coverage dates must be valid ISO date values.');
    }
    if (to.getTime() < from.getTime()) {
      throw new BadRequestException('Market coverage "to" date must be on or after the "from" date.');
    }

    const page = Math.max(1, Math.floor(Number(input.page) || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(input.pageSize) || 50)));
    const filter: Record<string, any> = {
      fixtureDate: { $gte: from, $lte: to },
    };
    const leagueId = String(input.leagueId ?? '').trim().toLowerCase();
    if (leagueId) filter.leagueId = leagueId;

    const [totalFixtures, queueRows] = await Promise.all([
      this.queueModel.countDocuments(filter).exec(),
      this.queueModel
        .find(filter)
        .select({
          eventId: 1,
          leagueId: 1,
          fixtureDate: 1,
          status: 1,
          attempts: 1,
          modelVersion: 1,
          reason: 1,
          errorMessage: 1,
          oddsUpdatedAt: 1,
          summaryCollectedAt: 1,
          lastProcessedSummaryAt: 1,
          fixtureSourceRevision: 1,
          lastProcessedFixtureSourceRevision: 1,
        })
        .sort({ fixtureDate: 1, eventId: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean()
        .exec() as Promise<any[]>,
    ]);

    const eventIds = queueRows
      .map((row) => String(row.eventId ?? '').trim())
      .filter(Boolean);
    if (!eventIds.length) {
      return {
        generatedAt,
        modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
        range: { from, to, leagueId: leagueId || null },
        pagination: {
          page,
          pageSize,
          totalFixtures,
          totalPages: Math.ceil(totalFixtures / pageSize),
          hasMore: page * pageSize < totalFixtures,
        },
        totals: {
          fixturesAudited: 0,
          catalogMarketCount: FOOTBALL_MARKET_CATALOG.length,
          marketFixturePairs: 0,
          pricingEnabledMarketFixturePairs: 0,
          marketsWithPredictionDocument: 0,
          marketsWithFreshPredictionReadyOdds: 0,
          marketsWithCalculatedProbability: 0,
          marketsWithOneFinalSelection: 0,
          marketsSelectedInPickCenter: 0,
          marketsWithStaleSourceRevision: 0,
          coverageStateCounts: {},
        },
        coverageByMarket: [],
        fixtures: [],
        note: 'Read-only page-level coverage summary. No prediction, Odds, Pick Center, or queue records were changed.',
      };
    }

    const [marketDocuments, oddsQuotes, pickRows, fixtureRevisionsByEvent] = await Promise.all([
      this.marketModel
        .find({
          eventId: { $in: eventIds },
          modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
        })
        .lean()
        .exec() as Promise<any[]>,
      this.oddsRead.getPricesForFixtures(eventIds),
      this.pickCenterModel
        .find({ eventId: { $in: eventIds } })
        .lean()
        .exec() as Promise<any[]>,
      this.sportsRevisions.getCurrentRevisions('FIXTURE', eventIds),
    ]);

    const documentsByEvent = new Map<string, Map<string, any>>();
    for (const document of marketDocuments) {
      const eventId = String(document.eventId ?? '').trim();
      const marketKey = String(document.marketKey ?? '').trim().toUpperCase();
      if (!eventId || !marketKey) continue;
      const byMarket = documentsByEvent.get(eventId) ?? new Map<string, any>();
      byMarket.set(marketKey, document);
      documentsByEvent.set(eventId, byMarket);
    }

    const quotesByEvent = new Map<string, any[]>();
    for (const quote of oddsQuotes as any[]) {
      const eventId = String(quote.eventId ?? '').trim();
      if (!eventId) continue;
      const rows = quotesByEvent.get(eventId) ?? [];
      rows.push(quote);
      quotesByEvent.set(eventId, rows);
    }

    const picksByEvent = new Map<string, any>();
    for (const pick of pickRows) picksByEvent.set(String(pick.eventId ?? ''), pick);

    const sameLine = (left: unknown, right: unknown): boolean => {
      const leftMissing = left === undefined || left === null || left === '';
      const rightMissing = right === undefined || right === null || right === '';
      if (leftMissing || rightMissing) return leftMissing && rightMissing;
      const leftNumber = Number(left);
      const rightNumber = Number(right);
      return Number.isFinite(leftNumber)
        && Number.isFinite(rightNumber)
        && Math.abs(leftNumber - rightNumber) < 0.001;
    };
    const quoteMatchesSelection = (quote: any, selection: any): boolean =>
      String(quote?.selectionKey ?? '').trim().toUpperCase()
        === String(selection?.key ?? '').trim().toUpperCase()
      && sameLine(quote?.line, selection?.line);
    const hasUsableOdds = (quote: any): boolean =>
      quote?.predictionReady === true
      && quote?.isFresh === true
      && (quote?.priceType === 'PROVIDER' || quote?.priceType === 'ESTIMATED')
      && Number.isFinite(Number(quote?.decimalOdds))
      && Number(quote.decimalOdds) >= PREDICTION_ENGINE_CONFIG.selectionEligibility.minimumDecimalOdds
      && Number(quote.decimalOdds) <= PREDICTION_ENGINE_CONFIG.selectionEligibility.maximumDecimalOdds
      && Boolean(String(quote?.oddsCalculationMethod ?? '').trim())
      && ['BOOKMAKER_ONLY', 'BOOKMAKER_PLUS_HISTORY', 'HISTORICAL_ONLY', 'PRIOR_ONLY']
        .includes(String(quote?.oddsBasis ?? ''));

    const marketAggregates = new Map<string, {
      marketKey: string;
      marketId: string | null;
      marketName: string;
      family: string;
      pricingEnabled: boolean;
      fixturesAudited: number;
      predictionDocumentsFound: number;
      fixturesWithFreshReadyOdds: number;
      fixturesWithCalculatedProbability: number;
      fixturesWithOneFinalSelection: number;
      fixturesSelectedInPickCenter: number;
      coverageStates: Record<string, number>;
    }>();

    for (const definition of FOOTBALL_MARKET_CATALOG) {
      const marketKey = String(definition.key).trim().toUpperCase();
      const canonicalMarket = FOOTBALL_MARKET_BY_PREDICTION_KEY.get(marketKey as any);
      marketAggregates.set(marketKey, {
        marketKey,
        marketId: canonicalMarket?.id ?? null,
        marketName: definition.fullName,
        family: String(definition.family),
        pricingEnabled: definition.pricingEnabled !== false,
        fixturesAudited: 0,
        predictionDocumentsFound: 0,
        fixturesWithFreshReadyOdds: 0,
        fixturesWithCalculatedProbability: 0,
        fixturesWithOneFinalSelection: 0,
        fixturesSelectedInPickCenter: 0,
        coverageStates: {},
      });
    }

    const coverageStateCounts: Record<string, number> = {};
    const fixtures: Array<Record<string, unknown>> = [];
    let marketFixturePairs = 0;
    let pricingEnabledMarketFixturePairs = 0;
    let marketsWithPredictionDocument = 0;
    let marketsWithFreshPredictionReadyOdds = 0;
    let marketsWithCalculatedProbability = 0;
    let marketsWithOneFinalSelection = 0;
    let marketsSelectedInPickCenter = 0;
    let marketsWithStaleSourceRevision = 0;

    for (const queueRow of queueRows) {
      const eventId = String(queueRow.eventId ?? '').trim();
      const currentFixtureSourceRevision = fixtureRevisionsByEvent.get(eventId) ?? 0;
      const documents = documentsByEvent.get(eventId) ?? new Map<string, any>();
      const fixtureQuotes = quotesByEvent.get(eventId) ?? [];
      const pickCenter = picksByEvent.get(eventId);
      const pickSelections: any[] = Array.isArray(pickCenter?.selectedMarkets)
        ? pickCenter.selectedMarkets
        : [];
      const selectedByMarket = new Map<string, any>();
      for (const selection of pickSelections) {
        const key = String(selection?.marketKey ?? '').trim().toUpperCase();
        if (key && !selectedByMarket.has(key)) selectedByMarket.set(key, selection);
      }

      const fixtureStateCounts: Record<string, number> = {};
      const problemMarkets: Array<Record<string, unknown>> = [];
      let fixtureSelectedCount = 0;
      let fixtureFinalSelectionCount = 0;
      let fixtureCalculatedCount = 0;
      let fixtureReadyOddsCount = 0;
      let fixtureDocumentCount = 0;

      for (const definition of FOOTBALL_MARKET_CATALOG) {
        marketFixturePairs += 1;
        const marketKey = String(definition.key).trim().toUpperCase();
        const aggregate = marketAggregates.get(marketKey)!;
        aggregate.fixturesAudited += 1;
        const canonicalMarket = FOOTBALL_MARKET_BY_PREDICTION_KEY.get(marketKey as any);
        const document = documents.get(marketKey);
        const selections: any[] = Array.isArray(document?.selections) ? document.selections : [];
        const marketQuotes = canonicalMarket
          ? fixtureQuotes.filter((quote: any) => String(quote.marketId) === String(canonicalMarket.id))
          : [];
        const freshQuotes = marketQuotes.filter((quote: any) => quote.isFresh === true);
        const usableQuotes = marketQuotes.filter(hasUsableOdds);
        const calculatedSelections = selections.filter((selection) =>
          String(selection?.status ?? '').toUpperCase() === 'CALCULATED'
          && Number.isFinite(Number(selection?.probability))
          && Number(selection.probability) > 0
          && Number(selection.probability) < 1,
        );
        const finalSelections = selections.filter((selection) => selection?.isFinalSelection === true);
        const matchingCalculatedSelections = calculatedSelections.filter((selection) =>
          usableQuotes.some((quote: any) => quoteMatchesSelection(quote, selection)),
        );
        const selectedInPickCenter = selectedByMarket.get(marketKey);
        const oneFinal = finalSelections.length === 1;
        const finalSelection = oneFinal ? finalSelections[0] : undefined;
        const finalSelectionInPickCenter = Boolean(
          finalSelection
          && selectedInPickCenter
          && String(selectedInPickCenter.selectionKey ?? '').trim().toUpperCase()
            === String(finalSelection.key ?? '').trim().toUpperCase()
          && String(selectedInPickCenter.marketPredictionId ?? '') === String(document?._id ?? ''),
        );

        let coverageState: string;
        if (!canonicalMarket) coverageState = 'CANONICAL_ODDS_MAPPING_MISSING';
        else if (definition.pricingEnabled === false) coverageState = 'CATALOG_DISABLED';
        else if (!document) coverageState = usableQuotes.length
          ? 'ODDS_READY_BUT_PREDICTION_DOCUMENT_MISSING'
          : 'PREDICTION_DOCUMENT_MISSING';
        else if (Number(document.fixtureSourceRevision ?? -1) !== currentFixtureSourceRevision) coverageState = 'PREDICTION_SOURCE_REVISION_STALE';
        else if (finalSelections.length > 1) coverageState = 'MULTIPLE_FINAL_SELECTIONS';
        else if (finalSelectionInPickCenter) coverageState = 'PICK_CENTER_SELECTED';
        else if (oneFinal) coverageState = 'FINAL_SELECTION_NOT_IN_PICK_CENTER';
        else if (usableQuotes.length > 0 && calculatedSelections.length === 0) coverageState = 'ODDS_READY_BUT_MODEL_UNAVAILABLE';
        else if (calculatedSelections.length > 0 && usableQuotes.length > 0 && matchingCalculatedSelections.length === 0) coverageState = 'MODEL_SELECTIONS_NOT_ODDS_MATCHED';
        else if (calculatedSelections.length > 0) coverageState = 'CALCULATED_NO_FINAL_SELECTION';
        else if (marketQuotes.length === 0) coverageState = 'NO_ODDS_QUOTES';
        else if (freshQuotes.length === 0) coverageState = 'ODDS_QUOTES_STALE';
        else if (usableQuotes.length === 0) coverageState = 'ODDS_QUOTES_NOT_PREDICTION_READY';
        else coverageState = 'ODDS_QUOTES_NOT_USABLE';

        fixtureStateCounts[coverageState] = (fixtureStateCounts[coverageState] ?? 0) + 1;
        coverageStateCounts[coverageState] = (coverageStateCounts[coverageState] ?? 0) + 1;
        aggregate.coverageStates[coverageState] = (aggregate.coverageStates[coverageState] ?? 0) + 1;
        if (document) {
          aggregate.predictionDocumentsFound += 1;
          fixtureDocumentCount += 1;
          marketsWithPredictionDocument += 1;
          if (Number(document.fixtureSourceRevision ?? -1) !== currentFixtureSourceRevision) {
            marketsWithStaleSourceRevision += 1;
          }
        }
        if (usableQuotes.length) {
          aggregate.fixturesWithFreshReadyOdds += 1;
          fixtureReadyOddsCount += 1;
          marketsWithFreshPredictionReadyOdds += 1;
        }
        if (calculatedSelections.length) {
          aggregate.fixturesWithCalculatedProbability += 1;
          fixtureCalculatedCount += 1;
          marketsWithCalculatedProbability += 1;
        }
        if (oneFinal) {
          aggregate.fixturesWithOneFinalSelection += 1;
          fixtureFinalSelectionCount += 1;
          marketsWithOneFinalSelection += 1;
        }
        if (finalSelectionInPickCenter) {
          aggregate.fixturesSelectedInPickCenter += 1;
          fixtureSelectedCount += 1;
          marketsSelectedInPickCenter += 1;
        }
        if (definition.pricingEnabled !== false) pricingEnabledMarketFixturePairs += 1;
        if (coverageState !== 'PICK_CENTER_SELECTED' && coverageState !== 'CATALOG_DISABLED') {
          problemMarkets.push({
            marketKey,
            marketName: definition.fullName,
            family: definition.family,
            coverageState,
            predictionDocumentPresent: Boolean(document),
            usableOddsQuoteCount: usableQuotes.length,
            calculatedSelectionCount: calculatedSelections.length,
            finalSelectionCount: finalSelections.length,
            blockingReason: !canonicalMarket
              ? 'Canonical Odds market mapping is missing.'
              : !document
                ? usableQuotes.length
                  ? 'Fresh prediction-ready Odds quotes exist, but the active model-version prediction document is missing.'
                  : 'No active model-version prediction document exists for this fixture and market.'
                : Number(document.fixtureSourceRevision ?? -1) !== currentFixtureSourceRevision
                  ? `Prediction source revision ${document.fixtureSourceRevision ?? 'missing'} is stale; current Sports fixture revision is ${currentFixtureSourceRevision}.`
                  : finalSelections.length > 1
                  ? 'The one-final-selection-per-market invariant is violated.'
                  : oneFinal
                    ? 'The market engine final selection is absent from the Pick Center snapshot.'
                    : usableQuotes.length && !calculatedSelections.length
                      ? 'Odds are ready, but the specialized market model emitted no probability.'
                      : calculatedSelections.length && usableQuotes.length && !matchingCalculatedSelections.length
                        ? 'Calculated outcomes do not match any fresh prediction-ready Odds selection and line.'
                        : calculatedSelections.length
                          ? 'Calculated probabilities exist, but no final selection was emitted.'
                          : marketQuotes.length === 0
                            ? 'No active Odds quotes exist for this market.'
                            : freshQuotes.length === 0
                              ? 'Stored Odds quotes are stale.'
                              : 'No fresh quote satisfies the Odds prediction-readiness and technical validity checks.',
          });
        }
      }

      fixtures.push({
        eventId,
        leagueId: queueRow.leagueId ?? null,
        fixtureDate: queueRow.fixtureDate ?? null,
        queue: {
          status: queueRow.status ?? null,
          attempts: Number(queueRow.attempts ?? 0),
          reason: queueRow.reason ?? null,
          errorMessage: queueRow.errorMessage ?? null,
          modelVersion: queueRow.modelVersion ?? null,
          summaryCollectedAt: queueRow.summaryCollectedAt ?? null,
          lastProcessedSummaryAt: queueRow.lastProcessedSummaryAt ?? null,
          oddsUpdatedAt: queueRow.oddsUpdatedAt ?? null,
          fixtureSourceRevision: queueRow.fixtureSourceRevision ?? null,
          lastProcessedFixtureSourceRevision: queueRow.lastProcessedFixtureSourceRevision ?? null,
          currentFixtureSourceRevision,
          sourceRevisionCurrent: Number(queueRow.fixtureSourceRevision ?? -1) === currentFixtureSourceRevision,
        },
        predictionDocumentsFound: fixtureDocumentCount,
        freshPredictionReadyMarkets: fixtureReadyOddsCount,
        calculatedMarkets: fixtureCalculatedCount,
        marketsWithOneFinalSelection: fixtureFinalSelectionCount,
        pickCenterSnapshot: {
          exists: Boolean(pickCenter),
          selectedMarketCount: Number(pickCenter?.selectedMarketCount ?? pickSelections.length),
          status: pickCenter?.status ?? null,
          updatedAt: pickCenter?.updatedAt ?? null,
        },
        selectedInPickCenter: fixtureSelectedCount,
        coverageStateCounts: fixtureStateCounts,
        problemMarkets: problemMarkets.slice(0, 40),
        problemMarketCount: problemMarkets.length,
      });
    }

    const coverageByMarket = [...marketAggregates.values()].map((item) => ({
      ...item,
      coverageRate: item.pricingEnabled && item.fixturesAudited
        ? Number((item.fixturesSelectedInPickCenter / item.fixturesAudited).toFixed(4))
        : null,
    })).sort((left, right) =>
      (left.coverageRate ?? 1) - (right.coverageRate ?? 1)
      || left.marketKey.localeCompare(right.marketKey),
    );

    return {
      generatedAt,
      modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
      range: { from, to, leagueId: leagueId || null },
      pagination: {
        page,
        pageSize,
        totalFixtures,
        totalPages: Math.ceil(totalFixtures / pageSize),
        hasMore: page * pageSize < totalFixtures,
        note: 'Coverage totals and per-market rates in this response describe the current page, not every fixture in the full date range.',
      },
      totals: {
        fixturesAudited: queueRows.length,
        catalogMarketCount: FOOTBALL_MARKET_CATALOG.length,
        marketFixturePairs,
        pricingEnabledMarketFixturePairs,
        marketsWithPredictionDocument,
        marketsWithFreshPredictionReadyOdds,
        marketsWithCalculatedProbability,
        marketsWithOneFinalSelection,
        marketsSelectedInPickCenter,
        marketsWithStaleSourceRevision,
        pickCenterCoverageRate: pricingEnabledMarketFixturePairs
          ? Number((marketsSelectedInPickCenter / pricingEnabledMarketFixturePairs).toFixed(4))
          : 0,
        coverageStateCounts,
      },
      coverageByMarket,
      fixtures,
      note: 'Read-only page-level coverage summary. It uses the durable prediction queue so fixtures with no market prediction documents remain visible, and compares persisted prediction revisions with the current Sports fixture revision. It does not enqueue work, generate predictions, refresh Odds, or mutate Pick Center.',
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

