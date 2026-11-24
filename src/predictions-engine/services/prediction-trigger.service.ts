import { Injectable } from '@nestjs/common';
import { PredictionEngineService } from './prediction-engine.service';
import { PredictionQueueService } from './prediction-queue.service';
import { PredictionQueueWorkerService } from './prediction-queue-worker.service';
import { PredictionEngineMonitorService } from './prediction-engine-monitor.service';
import { OddsWorkerService } from '../../odds/services/odds-worker.service';

@Injectable()
export class PredictionTriggerService {
  constructor(
    private readonly engine: PredictionEngineService,
    private readonly queue: PredictionQueueService,
    private readonly worker: PredictionQueueWorkerService,
    private readonly monitor: PredictionEngineMonitorService,
    private readonly oddsWorker: OddsWorkerService,
  ) {}

  async generateFixture(eventId: string): Promise<unknown> {
    const result: unknown = await this.engine.generateForFixture(eventId);
    await this.monitor.recordEvent({
      type: 'ADMIN_ACTION',
      level: 'INFO',
      eventId,
      message: `Prediction generation manually triggered for event ${eventId}.`,
    });
    return result;
  }

  async synchronizeQueue(force = false): Promise<unknown> {
    return this.queue.syncUpcomingFixtures(force);
  }

  /**
   * Reconcile both independent pipelines for the configured upcoming window.
   * Odds is scheduled through its bounded inventory worker; predictions are
   * inserted/refreshed through the durable prediction queue.
   */
  async backfillUpcomingFixtures(): Promise<Record<string, unknown>> {
    const oddsBackfill = this.oddsWorker.requestInventoryBackfill();
    const predictionQueue = await this.queue.syncUpcomingFixtures(false);

    await this.monitor.recordEvent({
      type: 'ADMIN_ACTION',
      level: 'INFO',
      message: 'Upcoming fixture Odds and prediction backfill was requested.',
      metadata: {
        oddsBackfillStatus: oddsBackfill.status,
        predictionFixturesScanned: predictionQueue.scannedFixtures,
        predictionJobsEnqueued: predictionQueue.enqueued,
        predictionJobsRefreshed: predictionQueue.refreshed,
      },
    });

    return {
      accepted: true,
      oddsAccepted: oddsBackfill.status !== 'DISABLED',
      odds: oddsBackfill,
      predictions: predictionQueue,
      processing: 'BACKGROUND_DURABLE_WORKERS',
      coverageAuditEndpoint: '/predictions-engine/monitor/market-coverage',
      note: 'This request schedules idempotent backfill work. It does not wait for every fixture to finish; use the paginated coverage audit to verify completion.',
    };
  }

  async recoverStaleQueueItems(): Promise<{ recovered: number }> {
    const recovered = await this.queue.recoverStaleProcessing();
    return { recovered };
  }

  async runNextQueueItem(): Promise<{ processed: boolean; eventId?: string }> {
    return this.worker.runOneNow();
  }
}


