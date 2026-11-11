import { randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import { SportsDataChangeEventProcessorService } from './sports-data-change-event-processor.service';
import { SportsDataChangeEventService } from './sports-data-change-event.service';

/** Dedicated at-least-once worker for the transactional Sports source outbox. */
@Injectable()
export class SportsDataChangeEventWorkerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SportsDataChangeEventWorkerService.name);
  private readonly workerId = `sports-outbox:${process.env.HOSTNAME ?? 'node'}:${randomUUID()}`;
  private stopped = false;
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly events: SportsDataChangeEventService,
    private readonly processor: SportsDataChangeEventProcessorService,
  ) {}

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.events.setWakeHandler(() => this.wake());
    this.wake();
    this.logger.log(`Sports source-data outbox worker started (${this.workerId}).`);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.events.setWakeHandler(undefined);
  }

  private wake(): void {
    if (this.stopped || this.running) return;
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

    try {
      processed = await this.processor.drain(100, this.workerId);
    } catch (error) {
      this.logger.error(
        `Sports source-data outbox pass failed: ${this.errorMessage(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.running = false;
      if (!this.stopped) {
        // Drain another batch immediately when the previous pass filled it;
        // otherwise keep an inexpensive poll as crash/restart recovery.
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.pump();
        }, processed >= 100 ? 25 : 2_000);
        (this.timer as unknown as { unref?: () => void }).unref?.();
      }
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
