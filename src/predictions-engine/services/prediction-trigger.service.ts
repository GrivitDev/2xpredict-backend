import { Injectable } from '@nestjs/common';
import { PredictionEngineService } from './prediction-engine.service';
import { PredictionQueueService } from './prediction-queue.service';
import { PredictionQueueWorkerService } from './prediction-queue-worker.service';
import { PredictionEngineMonitorService } from './prediction-engine-monitor.service';

@Injectable()
export class PredictionTriggerService {
  constructor(
    private readonly engine: PredictionEngineService,
    private readonly queue: PredictionQueueService,
    private readonly worker: PredictionQueueWorkerService,
    private readonly monitor: PredictionEngineMonitorService,
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

  async recoverStaleQueueItems(): Promise<{ recovered: number }> {
    const recovered = await this.queue.recoverStaleProcessing();
    return { recovered };
  }

  async runNextQueueItem(): Promise<{ processed: boolean; eventId?: string }> {
    return this.worker.runOneNow();
  }
}

