import { Injectable, Logger } from '@nestjs/common';
import { SettlementQueueService } from './settlement-queue.service';

type TriggerReason =
  | 'PREDICTION_CREATED'
  | 'BET_LAB_TICKET_CREATED'
  | 'SPORTS_FIXTURE_CHANGED'
  | 'SPORTS_TIMELINE_CHANGED'
  | 'SPORTS_STATISTICS_CHANGED'
  | 'SPORTS_LINEUP_CHANGED'
  | 'ADMIN_MANUAL_REQUEUE';

@Injectable()
export class SettlementTriggerService {
  private readonly logger = new Logger(SettlementTriggerService.name);
  private readonly enqueueConcurrency = 4;

  constructor(private readonly queue: SettlementQueueService) {}

  /**
   * Durable Sports outbox events are the primary trigger. Fixture lifecycle,
   * score/period, timeline, lineup and statistics changes can each make new
   * markets settleable without waiting for the final whistle or periodic scans.
   */
  async onSportsDataChanged(
    eventIds: string[],
    entity: 'FIXTURE' | 'MATCH_TIMELINE' | 'MATCH_STATISTICS' | 'MATCH_LINEUP',
  ): Promise<void> {
    const reason: TriggerReason = entity === 'MATCH_TIMELINE'
      ? 'SPORTS_TIMELINE_CHANGED'
      : entity === 'MATCH_STATISTICS'
        ? 'SPORTS_STATISTICS_CHANGED'
        : entity === 'MATCH_LINEUP'
          ? 'SPORTS_LINEUP_CHANGED'
          : 'SPORTS_FIXTURE_CHANGED';
    await this.enqueueEvents(eventIds, reason, true);
  }

  /** Compatibility wrapper for callers that previously signalled fixture refresh. */
  async onFixturesRefreshed(eventIds: string[]): Promise<void> {
    await this.enqueueEvents(eventIds, 'SPORTS_FIXTURE_CHANGED');
  }

  /**
   * Sports calls this after its first complete fixture bootstrap. It closes the
   * startup-order gap where Settlement starts before Sports has finished loading
   * the fixture records needed to reconcile pre-existing target documents.
   */
  async onSportsBootstrapCompleted() {
    const result = await this.queue.reconcileExistingUnsettledTargets();
    this.logger.log(
      `Sports bootstrap settlement catch-up completed: candidates=${result.candidateEventIds}, queued=${result.queued}, skipped=${result.skipped}.`,
    );
    return result;
  }

  /** Newly-created Prediction/BetLab targets get an immediate reconciliation. */
  async onTargetsCreated(
    eventIds: string[],
    triggerReason: 'PREDICTION_CREATED' | 'BET_LAB_TICKET_CREATED',
  ): Promise<void> {
    // Target creation is committed independently from queue insertion. Surface
    // persistence failures to the producer so they are observable; the worker's
    // recurring reconciliation below provides the durable recovery path.
    await this.enqueueEvents(eventIds, triggerReason, true);
  }

  private async enqueueEvents(
    eventIds: string[],
    triggerReason: TriggerReason,
    throwOnFailure = false,
  ): Promise<void> {
    const uniqueEventIds = [
      ...new Set(eventIds.map((id) => String(id ?? '').trim()).filter(Boolean)),
    ];
    if (!uniqueEventIds.length) return;

    let queued = 0;
    let failed = 0;
    for (let offset = 0; offset < uniqueEventIds.length; offset += this.enqueueConcurrency) {
      const batch = uniqueEventIds.slice(offset, offset + this.enqueueConcurrency);
      const results = await Promise.all(batch.map(async (eventId) => {
        try {
          return await this.queue.enqueueForSportsFixtureChange(eventId, undefined, triggerReason);
        } catch (error) {
          failed += 1;
          this.logger.error(
            `Settlement enqueue failed for Sports fixture ${eventId}: ${this.errorMessage(error)}`,
          );
          return null;
        }
      }));
      queued += results.filter((result) => result?.enqueued === true).length;
    }

    if (queued > 0 || failed > 0) {
      this.logger.log(
        `Settlement Sports event processed: reason=${triggerReason}, fixtures=${uniqueEventIds.length}, queued=${queued}, failures=${failed}.`,
      );
    }
    // Let the durable Sports outbox retry the dispatch instead of acknowledging
    // an event whose fixture settlement jobs could not be durably queued.
    if (throwOnFailure && failed > 0) {
      throw new Error(`Settlement enqueue failed for ${failed} of ${uniqueEventIds.length} Sports fixtures.`);
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}


