import { randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import { BackgroundWorkLimiterService } from '../../common/background-work/background-work-limiter.service';
import { SportsDataChangeEventProcessorService } from './sports-data-change-event-processor.service';
import { SportsDataChangeEventService } from './sports-data-change-event.service';

const OUTBOX_BATCH_SIZE = 20;
const MIN_DRAIN_DELAY_MS = 1_000;
const IDLE_RECOVERY_POLL_MS = 5_000;

/** Dedicated at-least-once worker for the transactional Sports source outbox. */
@Injectable()
export class SportsDataChangeEventWorkerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SportsDataChangeEventWorkerService.name);
  private readonly workerId = `sports-outbox:${process.env.HOSTNAME ?? 'node'}:${randomUUID()}`;
  private stopped = false;
  private running = false;
  private wakeRequested = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly events: SportsDataChangeEventService,
    private readonly processor: SportsDataChangeEventProcessorService,
    private readonly backgroundWork: BackgroundWorkLimiterService,
  ) {}

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.events.setWakeHandler(() => this.wake());
    this.wake();
    this.logger.log(`Sports source-data outbox worker started (${this.workerId}); batch=${OUTBOX_BATCH_SIZE}.`);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.events.setWakeHandler(undefined);
  }

  private wake(): void {
    if (this.stopped) return;
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    let processed = 0;
    let releasePermit: (() => void) | undefined;

    try {
      releasePermit = await this.backgroundWork.acquire('sports:source-outbox');
      if (this.stopped) return;
      processed = await this.processor.drain(OUTBOX_BATCH_SIZE, this.workerId);
    } catch (error) {
      if (!this.stopped) {
        this.logger.error(
          `Sports source-data outbox pass failed: ${this.errorMessage(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    } finally {
      releasePermit?.();
      this.running = false;
      const wasWokenDuringDrain = this.wakeRequested;
      this.wakeRequested = false;

      if (!this.stopped) {
        // Even a full batch yields for one second before the next drain. An idle
        // worker checks every five seconds to recover missed wake notifications.
        const delayMs = wasWokenDuringDrain || processed > 0
          ? MIN_DRAIN_DELAY_MS
          : IDLE_RECOVERY_POLL_MS;
        this.scheduleNextPump(delayMs);
      }
    }
  }

  private scheduleNextPump(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pump();
    }, Math.max(MIN_DRAIN_DELAY_MS, delayMs));
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
