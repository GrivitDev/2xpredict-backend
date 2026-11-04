import { Injectable, Logger } from '@nestjs/common';
import { SettlementQueueService } from './settlement-queue.service';

type TriggerReason =
  | 'PREDICTION_CREATED'
  | 'BET_LAB_TICKET_CREATED'
  | 'FIXTURE_REFRESHED'
  | 'SUMMARY_UPDATED';

@Injectable()
export class SettlementTriggerService {
  private readonly logger = new Logger(SettlementTriggerService.name);
  private readonly enqueueConcurrency = 2;

  constructor(private readonly queue: SettlementQueueService) {}

  /** Fixture refresh is the only lifecycle-discovery event. */
  async onFixturesRefreshed(eventIds: string[]): Promise<void> {
    await this.enqueueEvents(eventIds, 'FIXTURE_REFRESHED');
  }

  /** Targets created after a fixture finished need an immediate targeted check. */
  async onTargetsCreated(
    eventIds: string[],
    triggerReason: 'PREDICTION_CREATED' | 'BET_LAB_TICKET_CREATED',
  ): Promise<void> {
    await this.enqueueEvents(eventIds, triggerReason);
  }

  /** Summary updates may refresh evidence, but cannot establish a finished state. */
  async onSummaryUpdated(eventId: string, leagueId?: string): Promise<void> {
    const id = String(eventId ?? '').trim();
    if (!id) return;
    try {
      const result = await this.queue.enqueueForConfirmedFinishedFixture(
        id,
        leagueId,
        'SUMMARY_UPDATED',
      );
      if (result.enqueued) {
        this.logger.log(
          `Settlement evidence refresh queued for finished fixture ${id} (${result.jobKey ?? 'job key unavailable'}).`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Summary-triggered settlement evaluation failed for ${id}: ${this.errorMessage(error)}`,
      );
    }
  }

  private async enqueueEvents(
    eventIds: string[],
    triggerReason: TriggerReason,
  ): Promise<void> {
    const uniqueEventIds = [
      ...new Set(eventIds.map((id) => String(id ?? '').trim()).filter(Boolean)),
    ];
    if (uniqueEventIds.length === 0) return;

    let queued = 0;
    let failed = 0;
    for (
      let offset = 0;
      offset < uniqueEventIds.length;
      offset += this.enqueueConcurrency
    ) {
      const batch = uniqueEventIds.slice(offset, offset + this.enqueueConcurrency);
      const results = await Promise.all(
        batch.map(async (eventId) => {
          try {
            return await this.queue.enqueueForConfirmedFinishedFixture(
              eventId,
              undefined,
              triggerReason,
            );
          } catch (error) {
            failed += 1;
            this.logger.error(
              `Settlement enqueue failed for fixture ${eventId}: ${this.errorMessage(error)}`,
            );
            return null;
          }
        }),
      );
      queued += results.filter((result) => result?.enqueued === true).length;
    }

    if (queued > 0 || failed > 0) {
      this.logger.log(
        `Settlement fixture event processed: reason=${triggerReason}, fixtures=${uniqueEventIds.length}, queued=${queued}, failures=${failed}.`,
      );
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
