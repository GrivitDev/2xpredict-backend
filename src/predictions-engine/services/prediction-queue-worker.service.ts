import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  UnprocessableEntityException,
  NotFoundException,
} from '@nestjs/common';

import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { PredictionQueueService } from './prediction-queue.service';
import { PredictionEngineService } from './prediction-engine.service';
import { PredictionEngineMonitorService } from './prediction-engine-monitor.service';
import { SystemMonitorService } from '../../system-monitor/system-monitor.service';
import { OddsReadService } from '../../odds/services/odds-read.service';
import { MarketCalibrationService } from './market-calibration.service';
import { CuratedPredictionService } from './curated-prediction.service';
import { SlipCenterService } from './slip-center.service';
import { PickCenterService } from './pick-center.service';

@Injectable()
export class PredictionQueueWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PredictionQueueWorkerService.name);
  private workerTimer?: ReturnType<typeof setInterval>;
  private syncTimer?: ReturnType<typeof setInterval>;
  private productTimer?: ReturnType<typeof setInterval>;
  private slipTimer?: ReturnType<typeof setInterval>;
  private calibrationTimer?: ReturnType<typeof setInterval>;
  private pickCenterTimer?: ReturnType<typeof setInterval>;
  private activeWorkers = 0;
  private pickCenterBusy = false;
  private syncBusy = false;
  private curatedBusy = false;
  private slipBusy = false;
  private calibrationBusy = false;
  private started = false;

  constructor(
    private readonly queue: PredictionQueueService,
    private readonly engine: PredictionEngineService,
    private readonly monitor: PredictionEngineMonitorService,
    private readonly systemMonitor: SystemMonitorService,
    private readonly oddsService: OddsReadService,
    private readonly marketCalibrationService: MarketCalibrationService,
    private readonly curatedPredictionService: CuratedPredictionService,
    private readonly slipCenterService: SlipCenterService,
    private readonly pickCenterService: PickCenterService,
  ) {}

  onModuleInit(): void {
    if (!PREDICTION_ENGINE_CONFIG.enabled) {
      this.logger.warn(
        'Prediction engine is disabled by configuration; worker timers were not started.',
      );
      this.systemMonitor.reportModuleHealth('predictions-engine', 'HEALTHY', {
        source: 'worker-lifecycle',
        message:
          'Prediction engine is intentionally disabled by configuration.',
        details: { enabled: false },
      });
      void this.monitor
        .setWorkerRunning(false)
        .catch((error) => this.logger.error(this.errorMessage(error)));
      return;
    }
    this.systemMonitor.reportModuleHealth('predictions-engine', 'HEALTHY', {
      source: 'worker-lifecycle',
      message:
        'Prediction worker is starting immediately and will process fixtures as soon as Odds-module readiness is available.',
      details: { enabled: true, readinessGate: 'ODDS_MODULE' },
    });
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.systemMonitor.reportModuleHealth('predictions-engine', 'HEALTHY', {
      source: 'worker-lifecycle',
      message: 'Prediction queue worker started.',
    });
    void this.monitor
      .setWorkerRunning(true)
      .catch((error) => this.logger.error(this.errorMessage(error)));
    void this.monitor.recordEvent({
      type: 'ENGINE_STARTED',
      level: 'INFO',
      message: '2xPredict market prediction worker started.',
      metadata: {
        modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
        timingGate: 'ODDS_READINESS',
        workerIntervalMs: PREDICTION_ENGINE_CONFIG.queue.workerIntervalMs,
        queueSyncIntervalMs: PREDICTION_ENGINE_CONFIG.queue.syncIntervalMs,
      },
    });

    void this.syncQueueSafely();
    void this.runOneSafely();
    // Publication products have their own recurring cycle. They do not depend
    // on a new market-engine run and therefore continue refreshing while Pick
    // Center already contains eligible upcoming/live fixtures.
    void this.refreshCalibrationSafely();
    void this.refreshCuratedSafely();
    void this.refreshSlipSafely();
    void this.refreshPickCenterSafely();

    const pickCenterTimer = setInterval(
      () => void this.refreshPickCenterSafely(),
      PREDICTION_ENGINE_CONFIG.pickCenter.refreshIntervalMs,
    );
    const productTimer = setInterval(
      () => void this.refreshCuratedSafely(),
      PREDICTION_ENGINE_CONFIG.curatedPredictions.refreshIntervalMs,
    );
    const slipTimer = setInterval(
      () => void this.refreshSlipSafely(),
      PREDICTION_ENGINE_CONFIG.slipCenter.refreshIntervalMs,
    );
    const calibrationTimer = setInterval(
      () => void this.refreshCalibrationSafely(),
      PREDICTION_ENGINE_CONFIG.calibration.refreshIntervalMs,
    );
    const workerTimer = setInterval(
      () => void this.runOneSafely(),
      PREDICTION_ENGINE_CONFIG.queue.workerIntervalMs,
    );
    const syncTimer = setInterval(
      () => void this.syncQueueSafely(),
      PREDICTION_ENGINE_CONFIG.queue.syncIntervalMs,
    );
    this.workerTimer = workerTimer;
    this.syncTimer = syncTimer;
    this.productTimer = productTimer;
    this.slipTimer = slipTimer;
    this.calibrationTimer = calibrationTimer;
    this.pickCenterTimer = pickCenterTimer;
  }

  stop(): void {
    if (this.workerTimer) clearInterval(this.workerTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.productTimer) clearInterval(this.productTimer);
    if (this.slipTimer) clearInterval(this.slipTimer);
    if (this.calibrationTimer) clearInterval(this.calibrationTimer);
    if (this.pickCenterTimer) clearInterval(this.pickCenterTimer);
    this.workerTimer = undefined;
    this.syncTimer = undefined;
    this.productTimer = undefined;
    this.slipTimer = undefined;
    this.calibrationTimer = undefined;
    this.pickCenterTimer = undefined;
    if (!this.started) return;
    this.started = false;
    void this.monitor
      .setWorkerRunning(false)
      .catch((error) => this.logger.error(this.errorMessage(error)));
    void this.monitor.recordEvent({
      type: 'ENGINE_STOPPED',
      level: 'WARNING',
      message: '2xPredict market prediction worker stopped.',
    });
  }

  /** Admin-triggered one-item processing. It still uses the durable queue lock. */
  async runOneNow(): Promise<{
    processed: boolean;
    eventId?: string;
    failed?: boolean;
  }> {
    return this.processOne();
  }

  private async runOneSafely(): Promise<void> {
    if (
      this.activeWorkers >= PREDICTION_ENGINE_CONFIG.queue.workerConcurrency
      || !this.started
      || !PREDICTION_ENGINE_CONFIG.enabled
    ) return;
    this.activeWorkers += 1;
    this.monitor.recordOperationStart('prediction-worker', {
      activeWorkers: this.activeWorkers,
      configuredConcurrency: PREDICTION_ENGINE_CONFIG.queue.workerConcurrency,
    });
    let failed = false;
    let processedWork = false;
    try {
      const outcome = await this.processOne();
      processedWork = outcome.processed;
      if (outcome.failed) {
        failed = true;
        this.monitor.recordOperationFailure(
          'prediction-worker',
          'Prediction queue item failed during generation or persistence.',
          { eventId: outcome.eventId },
        );
      }
    } catch (error) {
      failed = true;
      this.monitor.recordOperationFailure('prediction-worker', this.errorMessage(error));
      this.systemMonitor.reportModuleHealth('predictions-engine', 'DEGRADED', {
        source: 'queue-worker',
        message: this.errorMessage(error),
      });
      this.systemMonitor.reportError({
        module: 'predictions-engine',
        source: 'queue-worker',
        operation: 'process-one',
        message: this.errorMessage(error),
        occurredAt: new Date(),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.logger.error(
        `Prediction worker cycle failed: ${this.errorMessage(error)}`,
      );
      await this.monitor.recordEvent({
        type: 'PREDICTION_FAILED',
        level: 'ERROR',
        message: `Prediction worker cycle failed: ${this.errorMessage(error)}`,
      });
    } finally {
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      if (!failed) {
        this.monitor.recordOperationSuccess('prediction-worker', {
          processed: processedWork,
          activeWorkers: this.activeWorkers,
        });
      }
      if (this.started && processedWork && !failed)
        this.systemMonitor.reportModuleHealth('predictions-engine', 'HEALTHY', {
          source: 'queue-worker',
          message: 'Prediction worker processed a fixture successfully.',
        });
    }
  }

  private async refreshPickCenterSafely(): Promise<void> {
    if (this.pickCenterBusy || !this.started || !PREDICTION_ENGINE_CONFIG.enabled) return;
    this.pickCenterBusy = true;
    this.monitor.recordOperationStart('pick-center');
    try {
      const result = await this.pickCenterService.refreshStaleUpcoming();
      if (result.failed > 0) {
        this.monitor.recordOperationFailure(
          'pick-center',
          `Pick Center reconciliation reported ${result.failed} fixture failures.`,
          { failed: result.failed, rebuilt: result.rebuilt, scanned: result.scanned },
        );
        this.systemMonitor.reportModuleHealth('predictions-engine', 'DEGRADED', {
          source: 'pick-center-refresh',
          message: `Pick Center reconciliation completed with ${result.failed} fixture failures.`,
          details: result,
        });
      } else {
        this.monitor.recordOperationSuccess('pick-center', {
          failed: result.failed,
          rebuilt: result.rebuilt,
          scanned: result.scanned,
        });
      }
    } catch (error) {
      const message = this.errorMessage(error);
      this.monitor.recordOperationFailure('pick-center', message);
      this.logger.error(`Independent Pick Center refresh failed: ${message}`);
      this.systemMonitor.reportModuleHealth('predictions-engine', 'DEGRADED', {
        source: 'pick-center-refresh',
        message,
      });
      this.systemMonitor.reportError({
        module: 'predictions-engine',
        source: 'pick-center-refresh',
        operation: 'refresh-stale-pick-center',
        message,
        occurredAt: new Date(),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } finally {
      this.pickCenterBusy = false;
    }
  }

  private async refreshCalibrationSafely(): Promise<void> {
    if (this.calibrationBusy || !this.started || !PREDICTION_ENGINE_CONFIG.enabled) return;
    this.calibrationBusy = true;
    const startedAt = Date.now();
    this.monitor.recordOperationStart('calibration');
    try {
      const result = await this.marketCalibrationService.refreshAllIfStale();
      await this.monitor.recordCalibrationCycle(result);
      this.monitor.recordOperationSuccess('calibration', {
        durationMs: Date.now() - startedAt,
        skipped: result.skipped === true,
        marketsRefreshed: Number(result.marketsRefreshed ?? 0),
        activeMarkets: Number(result.activeMarkets ?? 0),
      });
      this.systemMonitor.reportModuleHealth('predictions-engine-calibration', 'HEALTHY', {
        source: 'calibration-refresh',
        message: 'Calibration refresh check completed.',
        details: { durationMs: Date.now() - startedAt, skipped: result.skipped === true },
      });
    } catch (error) {
      const message = this.errorMessage(error);
      this.monitor.recordOperationFailure('calibration', message, {
        durationMs: Date.now() - startedAt,
      });
      this.logger.error(`Calibration refresh cycle failed: ${message}`);
      await this.monitor.recordProductRefreshFailure('calibration', message, Date.now() - startedAt);
      this.systemMonitor.reportModuleHealth('predictions-engine-calibration', 'DEGRADED', {
        source: 'calibration-refresh', message,
        details: { durationMs: Date.now() - startedAt },
      });
      this.systemMonitor.reportError({
        module: 'predictions-engine-calibration',
        source: 'calibration-refresh',
        operation: 'refresh-calibration',
        message,
        occurredAt: new Date(),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } finally {
      this.calibrationBusy = false;
    }
  }

  private async refreshCuratedSafely(): Promise<void> {
    if (this.curatedBusy || !this.started || !PREDICTION_ENGINE_CONFIG.enabled) return;
    this.curatedBusy = true;
    const startedAt = Date.now();
    this.monitor.recordOperationStart('curated-predictions');
    try {
      const result = await this.curatedPredictionService.refreshFromPickCenter();
      if (result.skipped === true) {
        this.monitor.recordOperationSuccess('curated-predictions', {
          skipped: true,
          reason: String(result.reason ?? 'REFRESH_ALREADY_RUNNING'),
        });
        this.systemMonitor.reportModuleHealth('predictions-engine-curated', 'HEALTHY', {
          source: 'curated-refresh',
          message: 'Curated Predictions refresh was skipped because another refresh is already active.',
          details: { reason: String(result.reason ?? 'REFRESH_ALREADY_RUNNING') },
        });
        return;
      }
      this.monitor.recordOperationSuccess('curated-predictions', {
        durationMs: Date.now() - startedAt,
        created: Number(result.created ?? 0),
        updated: Number(result.updated ?? 0),
        skipped: Number(result.skippedMatches ?? 0),
      });
      this.systemMonitor.reportModuleHealth('predictions-engine-curated', 'HEALTHY', {
        source: 'curated-refresh',
        message: 'Curated Predictions refresh completed.',
        details: {
          durationMs: Date.now() - startedAt,
          created: Number(result.created ?? 0),
          updated: Number(result.updated ?? 0),
          skipped: Number(result.skippedMatches ?? 0),
        },
      });
    } catch (error) {
      const message = this.errorMessage(error);
      this.monitor.recordOperationFailure('curated-predictions', message, {
        durationMs: Date.now() - startedAt,
      });
      this.logger.error(`Curated prediction refresh cycle failed: ${message}`);
      await this.monitor.recordProductRefreshFailure('curated', message, Date.now() - startedAt);
      this.systemMonitor.reportModuleHealth('predictions-engine-curated', 'DEGRADED', {
        source: 'curated-refresh', message,
        details: { durationMs: Date.now() - startedAt },
      });
      this.systemMonitor.reportError({
        module: 'predictions-engine-curated',
        source: 'curated-refresh',
        operation: 'refresh-curated-predictions',
        message,
        occurredAt: new Date(),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } finally {
      this.curatedBusy = false;
    }
  }

  private async refreshSlipSafely(): Promise<void> {
    if (this.slipBusy || !this.started || !PREDICTION_ENGINE_CONFIG.enabled) return;
    this.slipBusy = true;
    const startedAt = Date.now();
    this.monitor.recordOperationStart('slip-center');
    try {
      const result = await this.slipCenterService.refreshAutomaticSlips();
      if (result.inProgress === true) {
        this.monitor.recordOperationSuccess('slip-center', {
          skipped: true,
          reason: 'REFRESH_ALREADY_RUNNING',
        });
        this.systemMonitor.reportModuleHealth('predictions-engine-slip-center', 'HEALTHY', {
          source: 'slip-center-refresh',
          message: 'Slip Center refresh was skipped because another refresh is already active.',
          details: { reason: 'REFRESH_ALREADY_RUNNING' },
        });
        return;
      }
      this.monitor.recordOperationSuccess('slip-center', {
        durationMs: Date.now() - startedAt,
        createdOrUpdated: Number(result.createdOrUpdated ?? 0),
        skipped: Number(result.skipped ?? 0),
      });
      this.systemMonitor.reportModuleHealth('predictions-engine-slip-center', 'HEALTHY', {
        source: 'slip-center-refresh',
        message: 'Slip Center refresh completed.',
        details: {
          durationMs: Date.now() - startedAt,
          createdOrUpdated: Number(result.createdOrUpdated ?? 0),
          skipped: Number(result.skipped ?? 0),
        },
      });
    } catch (error) {
      const message = this.errorMessage(error);
      this.monitor.recordOperationFailure('slip-center', message, {
        durationMs: Date.now() - startedAt,
      });
      this.logger.error(`Slip Center refresh cycle failed: ${message}`);
      await this.monitor.recordProductRefreshFailure('slip', message, Date.now() - startedAt);
      this.systemMonitor.reportModuleHealth('predictions-engine-slip-center', 'DEGRADED', {
        source: 'slip-center-refresh', message,
        details: { durationMs: Date.now() - startedAt },
      });
      this.systemMonitor.reportError({
        module: 'predictions-engine-slip-center',
        source: 'slip-center-refresh',
        operation: 'refresh-automatic-slips',
        message,
        occurredAt: new Date(),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } finally {
      this.slipBusy = false;
    }
  }

  private async processOne(): Promise<{
    processed: boolean;
    eventId?: string;
    failed?: boolean;
  }> {
    const job: unknown = await this.queue.claimNext();
    if (!job) return { processed: false };

    const eventId = String((job as { eventId: unknown }).eventId);
    const startedAt = Date.now();
    try {
      const readinessByEvent =
        await this.oddsService.getPredictionReadinessForEvents([eventId]);
      const readiness = readinessByEvent.get(eventId);
      if (!readiness?.ready) {
        await this.queue.deferForOddsNotReady(
          job as Parameters<typeof this.queue.deferForOddsNotReady>[0],
          readiness?.reason ??
            'Odds module has not marked this fixture prediction-ready.',
        );
        return { processed: false, eventId };
      }
      await this.engine.generateForFixture(eventId);
      await this.queue.complete(
        job as Parameters<PredictionQueueService['complete']>[0],
        Date.now() - startedAt,
      );
      return { processed: true, eventId };
    } catch (error) {
      const message = this.errorMessage(error);
      const durationMs = Date.now() - startedAt;
      const expectedSkip =
        error instanceof NotFoundException ||
        error instanceof UnprocessableEntityException;

      if (expectedSkip) {
        await this.queue.skip(
          job as Parameters<typeof this.queue.skip>[0],
          message,
          durationMs,
        );
        this.systemMonitor.reportActivity({
          module: 'predictions-engine',
          source: 'queue-worker',
          operation: 'skip-fixture',
          status: 'INFO',
          message: `Prediction skipped for fixture ${eventId}: ${message}`,
          occurredAt: new Date(),
          durationMs,
          referenceKey: eventId,
        });
        return { processed: true, eventId };
      }

      this.systemMonitor.reportModuleHealth('predictions-engine', 'DEGRADED', {
        source: 'queue-worker',
        message: `Prediction generation failed for fixture ${eventId}: ${message}`,
      });
      this.systemMonitor.reportError({
        module: 'predictions-engine',
        source: 'queue-worker',
        operation: 'generate-for-fixture',
        message,
        occurredAt: new Date(),
        stack: error instanceof Error ? error.stack : undefined,
        referenceKey: eventId,
      });
      this.systemMonitor.reportActivity({
        module: 'predictions-engine',
        source: 'queue-worker',
        operation: 'generate-for-fixture',
        status: 'FAILED',
        message: `Prediction generation failed for fixture ${eventId}.`,
        occurredAt: new Date(),
        durationMs,
        referenceKey: eventId,
      });
      await this.queue.fail(
        job as Parameters<typeof this.queue.fail>[0],
        message,
        durationMs,
      );
      return { processed: true, eventId, failed: true };
    }
  }

  private async syncQueueSafely(): Promise<void> {
    if (this.syncBusy || !this.started || !PREDICTION_ENGINE_CONFIG.enabled)
      return;
    this.syncBusy = true;
    this.monitor.recordOperationStart('queue-sync');
    try {
      const recovered = await this.queue.recoverStaleProcessing();
      const syncResult = await this.queue.syncUpcomingFixtures();
      this.monitor.recordOperationSuccess('queue-sync', {
        recovered: typeof recovered === 'number' ? recovered : undefined,
        result: syncResult && typeof syncResult === 'object' ? syncResult as unknown as Record<string, unknown> : undefined,
      });
    } catch (error) {
      const message = this.errorMessage(error);
      this.monitor.recordOperationFailure('queue-sync', message);
      this.systemMonitor.reportModuleHealth('predictions-engine', 'DEGRADED', {
        source: 'queue-sync',
        message,
      });
      this.systemMonitor.reportError({
        module: 'predictions-engine',
        source: 'queue-sync',
        operation: 'sync-upcoming-fixtures',
        message,
        occurredAt: new Date(),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.logger.error(`Prediction queue sync failed: ${message}`);
      await this.monitor.recordEvent({
        type: 'QUEUE_SYNCED',
        level: 'ERROR',
        message: `Prediction queue sync failed: ${this.errorMessage(error)}`,
      });
    } finally {
      this.syncBusy = false;
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

