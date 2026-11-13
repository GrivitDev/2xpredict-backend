import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';

import { SPORTS_COLLECTION_SCHEDULE } from '../config/sports-collection-schedule.config';
import {
  SportsQueueJobType,
  SportsBootstrapPhase,
  SportsQueueScope,
} from '../interfaces/sports-queue.interface';
import { SportsBootstrapState } from '../schemas/operations/sports-bootstrap-state.schema';
import { SportsSeason } from '../schemas';
import { SportsQueueService } from './sports-queue.service';

@Injectable()
export class SportsQueueBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SportsQueueBootstrapService.name);
  private readonly stateKey = 'espn-soccer-v2';

  constructor(
    private readonly queue: SportsQueueService,
    @InjectModel(SportsBootstrapState.name)
    private readonly bootstrapModel: Model<SportsBootstrapState>,
    @InjectModel(SportsSeason.name)
    private readonly seasonModel: Model<any>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const existing = (await this.bootstrapModel
      .findOne({ key: this.stateKey })
      .lean()
      .exec()) as SportsBootstrapState | null;

    if (existing?.status === 'COMPLETED' || existing?.status === 'PARTIAL') {
      await this.ensureRecurringDiscovery();
      this.logger.log(
        existing.status === 'PARTIAL'
          ? `ESPN Sports bootstrap completed with ${existing.phaseFailures?.length ?? 0} isolated failure(s); recurring discovery is active. Failed work can be retried from the admin Sports monitor.`
          : 'ESPN Sports bootstrap already completed; recurring discovery is active.',
      );
      return;
    }

    if (existing?.status === 'RUNNING' && existing.runId) {
      const runId = String(existing.runId);
      if (existing.currentPhase) {
        await this.enqueuePhaseGate(runId, existing.currentPhase, 0);
      } else {
        await this.queue.enqueueIfMissing({
          type: SportsQueueJobType.BOOTSTRAP_START,
          scope: { bootstrapRunId: runId },
          priority: 100,
          scheduledFor: new Date(),
          triggerEventId: `espn-bootstrap-start:${runId}`,
        });
      }
      this.logger.log(`Resuming incomplete ESPN Sports bootstrap (${runId}).`);
      return;
    }

    const runId = randomUUID();
    await this.bootstrapModel
      .updateOne(
        { key: this.stateKey },
        {
          $set: {
            key: this.stateKey,
            runId,
            status: 'RUNNING',
            startedAt: new Date(),
            discoveredLeagueIds: [],
            discoveredTeams: [],
            phaseFailures: [],
          },
          // Leave currentPhase unset until the league catalogue is actually read.
          // This lets a restart recover the bootstrap-start job without skipping discovery.
          $unset: { currentPhase: 1, completedAt: 1, lastError: 1 },
        },
        { upsert: true, runValidators: true },
      )
      .exec();
    await this.queue.enqueue({
      type: SportsQueueJobType.BOOTSTRAP_START,
      scope: { bootstrapRunId: runId },
      priority: 100,
      scheduledFor: new Date(),
      triggerEventId: `espn-bootstrap-start:${runId}`,
    });
    this.logger.log(`Started ESPN Sports bootstrap (${runId}).`);
  }

  /**
   * Re-enqueues only failed/quarantined jobs captured by the last partial
   * bootstrap. The original successful league jobs are never replayed.
   */
  async retryFailedBootstrapJobs(): Promise<{
    queued: number;
    skipped: number;
    runId?: string;
  }> {
    const state = (await this.bootstrapModel
      .findOne({ key: this.stateKey })
      .lean()
      .exec()) as (SportsBootstrapState & { phaseFailures?: Array<Record<string, any>> }) | null;

    if (state?.status !== 'PARTIAL' || !state.runId || !state.phaseFailures?.length) {
      return { queued: 0, skipped: state?.phaseFailures?.length ?? 0 };
    }

    const recoveryId = randomUUID();
    let queued = 0;
    let skipped = 0;

    for (const failure of state.phaseFailures) {
      const type = failure.type as SportsQueueJobType | undefined;
      const sourceScope = failure.scope as Record<string, unknown> | undefined;
      const key = String(failure.key ?? '');
      if (
        !type ||
        !Object.values(SportsQueueJobType).includes(type) ||
        !sourceScope ||
        !key ||
        failure.recoveryQueuedAt
      ) {
        skipped += 1;
        continue;
      }

      const scope = { ...sourceScope };
      delete scope.bootstrapRunId;
      delete scope.bootstrapPhase;

      const result = await this.queue.enqueue({
        type,
        scope: scope as SportsQueueScope,
        priority: 35,
        scheduledFor: new Date(),
        triggerEventId: `bootstrap-recovery:${state.runId}:${key}:${recoveryId}`,
      });

      await this.bootstrapModel
        .updateOne(
          { key: this.stateKey, runId: state.runId },
          {
            $set: {
              'phaseFailures.$[failure].recoveryQueuedAt': new Date(),
              'phaseFailures.$[failure].recoveryJobKey': result.jobKey,
            },
          },
          { arrayFilters: [{ 'failure.key': key }] },
        )
        .exec();
      queued += 1;
    }

    this.logger.log(
      `Queued ${queued} isolated bootstrap recovery job(s); skipped ${skipped}.`,
    );
    return { queued, skipped, runId: state.runId };
  }

  private async ensureRecurringDiscovery(): Promise<void> {
    await this.ensureHistoricalDerivedBaseline();
    const bootstrap = (await this.bootstrapModel
      .findOne({ key: this.stateKey })
      .select({ runId: 1 })
      .lean()
      .exec()) as SportsBootstrapState | null;
    const runId = String(bootstrap?.runId ?? 'existing-bootstrap');
    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.MATCH_SUMMARY_BACKFILL,
      scope: { backfillRunId: runId },
      priority: SPORTS_COLLECTION_SCHEDULE.summaryBackfill.priority,
      scheduledFor: new Date(),
      triggerEventId: `summary-backfill:${runId}:start`,
    });
    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.LEAGUE_CATALOGUE_REFRESH,
      scope: {},
      priority: 95,
      scheduledFor: new Date(
        Date.now() + SPORTS_COLLECTION_SCHEDULE.leagueCatalogue.intervalMs,
      ),
      recurrence: {
        intervalMs: SPORTS_COLLECTION_SCHEDULE.leagueCatalogue.intervalMs,
        repeatUntil: 'NEVER',
      },
      triggerEventId: 'espn-recurring-league-catalogue',
    });
    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.SOCCER_NEWS_REFRESH,
      scope: {},
      priority: 55,
      scheduledFor: new Date(
        Date.now() + SPORTS_COLLECTION_SCHEDULE.soccerNews.initialDelayMs,
      ),
      recurrence: {
        intervalMs: SPORTS_COLLECTION_SCHEDULE.soccerNews.intervalMs,
        repeatUntil: 'NEVER',
      },
      triggerEventId: 'espn-recurring-soccer-news',
    });
    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.SPORTS_RETENTION_CLEANUP,
      scope: {},
      priority: 25,
      scheduledFor: new Date(Date.now() + SPORTS_COLLECTION_SCHEDULE.retentionCleanup.intervalMs),
      recurrence: {
        intervalMs: SPORTS_COLLECTION_SCHEDULE.retentionCleanup.intervalMs,
        repeatUntil: 'NEVER',
      },
      triggerEventId: 'sports-recurring-retention-cleanup',
    });
  }

  /**
   * One-time idempotent Stage 4 migration for deployments whose original
   * Sports bootstrap was completed before historical derived projections were
   * retained. A stable scope key prevents this baseline from replaying on every
   * application restart.
   */
  private async ensureHistoricalDerivedBaseline(): Promise<void> {
    const seasons = await this.seasonModel.find({})
      .sort({ competitionId: 1, year: 1 })
      .select({ id: 1, competitionId: 1, year: 1 })
      .lean().exec() as Array<{ id: string; competitionId: string; year: number }>;
    const baseTime = Date.now() + SPORTS_COLLECTION_SCHEDULE.derivedData.historicalBackfillDelayMs;
    let enqueued = 0;
    for (const [index, season] of seasons.entries()) {
      if (!season.id || !season.competitionId) continue;
      const result = await this.queue.enqueueIfMissing({
        type: SportsQueueJobType.DERIVED_DATA_RECALCULATION,
        scope: {
          competitionId: season.competitionId,
          seasonId: season.id,
          projectionWindow: 'STAGE4_HISTORICAL_BASELINE',
        },
        priority: SPORTS_COLLECTION_SCHEDULE.derivedData.historicalBackfillPriority,
        scheduledFor: new Date(baseTime + index * SPORTS_COLLECTION_SCHEDULE.derivedData.historicalBackfillSpacingMs),
        triggerEventId: `derived:stage4-historical-baseline:${season.competitionId}:${season.id}`,
      });
      if (result.created) enqueued += 1;
    }
    if (enqueued) {
      this.logger.log(`Stage 4 historical derived-data baseline queued for ${enqueued} retained seasons.`);
    }
  }

  private async enqueuePhaseGate(
    runId: string,
    phase: SportsBootstrapPhase,
    delayMs: number,
  ): Promise<void> {
    const due = new Date(Date.now() + Math.max(0, delayMs));
    await this.queue.enqueue({
      type: SportsQueueJobType.BOOTSTRAP_PHASE_GATE,
      scope: { bootstrapRunId: runId, bootstrapPhase: phase },
      priority: 90,
      scheduledFor: due,
      triggerEventId: `espn-bootstrap-gate:${runId}:${phase}:${Math.floor(due.getTime() / 30_000)}`,
    });
  }
}



