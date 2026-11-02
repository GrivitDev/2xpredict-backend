import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AdminGateway } from '../../realtime/admin.gateway';
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
import { EspnFixture } from '../../sports/schemas/espn/espn-fixture.schema';
import { PredictionEventLevel } from '../enums/prediction-event-level.enum';
import { EngineEventType } from '../enums/engine-event-type.enum';
import { PredictionQueueStatus } from '../enums/prediction-queue-status.enum';
import { PredictionRunStatus } from '../enums/prediction-run-status.enum';
import { PredictionStatus } from '../enums/prediction-status.enum';
import { SlipStatus } from '../enums/slip-status.enum';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { PredictionEngineDashboard } from '../interfaces/prediction-monitor.interface';

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
    @InjectModel(EspnFixture.name)
    private readonly fixtureModel: Model<EspnFixture>,
    @InjectModel(MarketCalibration.name)
    private readonly calibrationModel: Model<MarketCalibration>,
    private readonly adminGateway: AdminGateway,
  ) {}

  onModuleInit(): void {
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
      message: `Queue sync scanned ${result.scannedFixtures} fixtures, found ${result.eligibleFixtures} with Summary, queued ${result.enqueued}, refreshed ${result.refreshed}, missing Summary ${result.missingSummary}.`,
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
    const now = new Date();
    const staleBeforeDate = new Date(
      now.getTime() -
        PREDICTION_ENGINE_CONFIG.model.sourceSummaryStaleHours * 3_600_000,
    );
    const staleBeforeIso = staleBeforeDate.toISOString();
    const last24h = new Date(now.getTime() - 86_400_000);
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
      this.fixtureModel.countDocuments({
        fixtureDate: { $gte: now },
        live: false,
        completed: { $ne: true },
      }),
      this.fixtureModel.countDocuments({
        fixtureDate: { $gte: now },
        live: false,
        completed: { $ne: true },
        'payload.summary': { $exists: true, $ne: null },
      }),
      this.fixtureModel.countDocuments({
        fixtureDate: { $gte: now },
        live: false,
        completed: { $ne: true },
        $or: [
          { 'payload.summary': { $exists: false } },
          { 'payload.summary': null },
        ],
      }),
      this.fixtureModel.countDocuments({
        live: true,
        completed: { $ne: true },
      }),
      this.fixtureModel.countDocuments({ completed: true }),
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
      this.fixtureModel.countDocuments({
        fixtureDate: { $gte: now },
        live: false,
        completed: { $ne: true },
        $or: [
          { 'payload.summary.odds': { $exists: false } },
          { 'payload.summary.odds': null },
          { 'payload.summary.pickcenter': { $exists: false } },
          { 'payload.summary.pickcenter': null },
        ],
      }),
      this.fixtureModel.countDocuments({
        fixtureDate: { $gte: now },
        live: false,
        completed: { $ne: true },
        $or: [
          { 'payload.summaryCollectedAt': { $lt: staleBeforeDate } },
          { 'payload.summaryCollectedAt': { $lt: staleBeforeIso } },
          { 'payload.summary.meta.lastUpdatedAt': { $lt: staleBeforeIso } },
        ],
      }),
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
    const marketEngineHorizon = new Date(
      now.getTime() +
        PREDICTION_ENGINE_CONFIG.queue.forwardWindowHours * 3_600_000,
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
      this.fixtureModel
        .countDocuments({
          fixtureDate: { $gte: now, $lte: marketEngineHorizon },
          live: { $ne: true },
          completed: { $ne: true },
        })
        .exec(),
      this.fixtureModel
        .countDocuments({
          fixtureDate: { $gte: now, $lte: marketEngineHorizon },
          live: { $ne: true },
          completed: { $ne: true },
          'payload.summary': { $exists: true, $ne: null },
        })
        .exec(),
      this.fixtureModel
        .countDocuments({
          fixtureDate: { $gte: now, $lte: marketEngineHorizon },
          live: { $ne: true },
          completed: { $ne: true },
          $or: [
            { 'payload.summary': { $exists: false } },
            { 'payload.summary': null },
          ],
        })
        .exec(),
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

    return {
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
        forwardHours: PREDICTION_ENGINE_CONFIG.queue.forwardWindowHours,
        fixtures: marketEngineWindowFixtures,
        withSummary: marketEngineWindowWithSummary,
        missingSummary: marketEngineWindowMissingSummary,
        waitingForOdds: queueMap[PredictionQueueStatus.WAITING_FOR_ODDS] ?? 0,
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
        marketEnginesForwardHours:
          PREDICTION_ENGINE_CONFIG.queue.forwardWindowHours,
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

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

