// backend/src/sports/services/espn-queue-worker.service.ts

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { EspnService } from '../providers/espn.service';

import { SportsCollectionService } from './sports-collection.service';
import { EspnQueueService } from './espn-queue.service';
import { EspnQueueBuilderService } from './espn-queue-builder.service';
import { YoutubeHighlightService } from './youtube-highlight.service';
import { ActiveCompetitionService } from './active-competition.service';
import { EspnActiveCompetitionService } from './espn-active-competition.service';
import { EspnStandingsService } from './espn-standings.service';
import { SportsSyncStateService } from './sports-sync-state.service';

import {
  EspnQueueJobType,
  EspnQueueStatus,
} from '../interfaces/espn-queue.interface';
import { SPORTS_DATA_COLLECTION_CONFIG } from '../config/sports-data-collection.config';
import { YOUTUBE_CONFIG } from '../config/youtube.config';
import { getYoutubeHighlightSearchPlan } from '../enums/official-youtube-channel.enum';
import { SportsProviderQuotaExceededError } from './sports-provider-rate-limit.service';
import { SystemMonitorService } from '../../system-monitor/system-monitor.service';

import {
  EspnFixture,
  EspnFixtureDocument,
} from '../schemas/espn/espn-fixture.schema';

import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { SportsWorkerRuntimeStatus } from '../interfaces/sports-system-monitor.interface';

class SummaryJobDeferredError extends Error {
  readonly summaryJobDeferred = true;
}

@Injectable()
export class EspnQueueWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EspnQueueWorkerService.name);
  private readonly fixtureDayConcurrency = 2;
  private workerStarted = false;
  private youtubeQueuePrepared = false;
  private draining = false;
  private wakeRequested = false;
  private recoveryAttempted = false;
  private timer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;
  private queueReadFailures = 0;
  private lastWatchdogReportAt = 0;
  private activeJobKey?: string;
  private activeJobType?: string;
  private activeJobStartedAt?: number;
  private initialized = false;
  private everStarted = false;
  private drainCycles = 0;
  private drainFailures = 0;
  private jobsSucceeded = 0;
  private jobsFailed = 0;
  private lastDrainStartedAt?: Date;
  private lastDrainCompletedAt?: Date;
  private lastJobAt?: Date;
  private lastJobType?: string;
  private lastJobStatus?: 'SUCCEEDED' | 'FAILED' | 'DEFERRED';
  private lastJobDurationMs?: number;
  private lastJobError?: string;
  private lastWatchdogAt?: Date;
  private lastWatchdogError?: string;
  private lastLongJobWarningAt = 0;
  private readonly watchdogIntervalMs = 5 * 60_000;
  private readonly queueReadRetryMs = 30_000;

  constructor(
    private readonly espnService: EspnService,
    private readonly sportsCollectionService: SportsCollectionService,
    private readonly espnQueueService: EspnQueueService,
    private readonly espnQueueBuilderService: EspnQueueBuilderService,
    private readonly youtubeHighlightService: YoutubeHighlightService,
    private readonly activeCompetitionService: ActiveCompetitionService,
    private readonly sportsSyncStateService: SportsSyncStateService,
    private readonly espnActiveCompetitionService: EspnActiveCompetitionService,
    private readonly espnStandingsService: EspnStandingsService,
    private readonly systemMonitor: SystemMonitorService,
    @InjectModel(EspnFixture.name)
    private readonly espnFixtureModel: Model<EspnFixtureDocument>,
  ) {}

  /** Read-only runtime snapshot for the admin Sports System Monitor. */
  getMonitorRuntimeStatus(): SportsWorkerRuntimeStatus {
    return {
      initialized: this.initialized,
      started: this.workerStarted,
      waitingForStartupRelease: this.initialized && !this.workerStarted && !this.everStarted,
      youtubeQueuePrepared: this.youtubeQueuePrepared,
      draining: this.draining,
      activeJobKey: this.activeJobKey,
      activeJobType: this.activeJobType,
      activeJobAgeMs: this.activeJobStartedAt ? Math.max(0, Date.now() - this.activeJobStartedAt) : undefined,
      queueReadFailures: this.queueReadFailures,
      drainCycles: this.drainCycles,
      drainFailures: this.drainFailures,
      jobsSucceeded: this.jobsSucceeded,
      jobsFailed: this.jobsFailed,
      lastDrainStartedAt: this.lastDrainStartedAt?.toISOString(),
      lastDrainCompletedAt: this.lastDrainCompletedAt?.toISOString(),
      lastJobAt: this.lastJobAt?.toISOString(),
      lastJobType: this.lastJobType,
      lastJobStatus: this.lastJobStatus,
      lastJobDurationMs: this.lastJobDurationMs,
      lastJobError: this.lastJobError,
      lastWatchdogAt: this.lastWatchdogAt?.toISOString(),
      lastWatchdogError: this.lastWatchdogError,
    };
  }

  onModuleInit(): void {
    this.initialized = true;
    this.systemMonitor.reportModuleHealth('sports', 'HEALTHY', {
      source: 'queue-worker',
      message: 'ESPN queue worker initialized and awaiting startup release.',
    });
    this.logger.log('ESPN queue worker initialized; awaiting startup release');
  }

  onModuleDestroy(): void {
    this.workerStarted = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.timer = undefined;
    this.watchdogTimer = undefined;
    this.espnQueueService.setWakeHandler(undefined);
  }

  start(): void {
    if (this.workerStarted) return;
    this.workerStarted = true;
    this.everStarted = true;
    this.systemMonitor.reportModuleHealth('sports', 'HEALTHY', {
      source: 'queue-worker',
      message: 'ESPN queue worker started.',
    });
    this.espnQueueService.setWakeHandler(() => this.wake());
    this.logger.log('ESPN persistent queue worker released');
    void this.espnQueueService.cleanupCompletedJobs(7).catch((error) => {
      this.logger.warn(
        `One-time queue cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    void this.espnQueueService
      .recoverKnownStandingsNormalizeFailures()
      .then((recovered) => {
        if (recovered > 0) {
          this.logger.warn(
            `Requeued ${recovered} standings jobs stranded by the previous normalize runtime error`,
          );
        }
      })
      .catch((error) => {
        this.logger.warn(
          `Standings job recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    // One bounded, idempotent historical pass repairs old canonical scores
    // from stored ESPN payloads and queues Summary refreshes for unresolved
    // finished fixtures. It runs after startup releases normal queue work.
    void this.sportsCollectionService
      .repairHistoricalFixtureResults()
      .then((result) => {
        if (!result.skipped) {
          this.logger.log(
            `Historical ESPN result reconciliation: scanned=${result.scanned}, repaired=${result.repaired}, summaryRefreshQueued=${result.summaryRefreshQueued}, conflicts=${result.conflicts}`,
          );
        }
      })
      .catch((error) => {
        this.logger.error(
          `Historical ESPN result reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    // Do not let retryable records from the old multi-channel handler run
    // before they have been normalized to the new one-request-per-stage model.
    void this.prepareYoutubeQueueBeforeDrain();
    this.scheduleWatchdog();
  }

  private async prepareYoutubeQueueBeforeDrain(): Promise<void> {
    if (!this.workerStarted) return;
    try {
      const suppressed =
        await this.espnQueueService.suppressLegacyYoutubeRetries();
      this.youtubeQueuePrepared = true;
      if (suppressed > 0) {
        this.logger.warn(
          `Suppressed ${suppressed} legacy YouTube auto-retry job(s) before queue drain`,
        );
      }
      this.wake();
    } catch (error) {
      this.logger.error(
        `Could not prepare the YouTube queue safely; queue draining will retry in ${this.queueReadRetryMs / 1000}s: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      const retry = setTimeout(
        () => void this.prepareYoutubeQueueBeforeDrain(),
        this.queueReadRetryMs,
      );
      retry.unref?.();
    }
  }

  /**
   * Queue-only watchdog: it never scans fixture collections or rebuilds work.
   * It repairs stale PROCESSING leases and re-arms due jobs if a wake-up was lost.
   */
  private scheduleWatchdog(delayMs = this.watchdogIntervalMs): void {
    if (!this.workerStarted) return;
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(
      () => {
        this.watchdogTimer = undefined;
        void this.runWatchdog();
      },
      Math.max(1_000, delayMs),
    );
    this.watchdogTimer.unref?.();
  }

  private async runWatchdog(): Promise<void> {
    if (!this.workerStarted) return;
    this.lastWatchdogAt = new Date();
    try {
      if (this.espnQueueService.isNormalOperationsReady()) {
        this.systemMonitor.reportModuleHealth('sports', 'HEALTHY', {
          source: 'queue-watchdog',
          message: 'ESPN queue watchdog is healthy.',
          details: {
            draining: this.draining,
            queueReadFailures: this.queueReadFailures,
          },
        });
        // Report a potentially stalled handler without stealing its lease. The
        // provider client has bounded request timeouts; this warning surfaces a
        // regression if a future integration accidentally stops respecting them.
        if (this.draining) {
          const activeForMs = this.activeJobStartedAt
            ? Date.now() - this.activeJobStartedAt
            : 0;
          const warningAfterMs = Math.max(
            5 * 60_000,
            SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.staleProcessingMinutes *
              2 *
              60_000,
          );
          if (
            activeForMs >= warningAfterMs &&
            Date.now() - this.lastLongJobWarningAt >= 5 * 60_000
          ) {
            this.lastLongJobWarningAt = Date.now();
            this.logger.error(
              `ESPN queue handler may be stalled: job=${this.activeJobKey ?? 'unknown'}, ` +
                `runningFor=${Math.round(activeForMs / 60_000)}m. The active job lease is not being stolen; inspect provider/database timeout logs.`,
            );
          } else if (Date.now() - this.lastWatchdogReportAt >= 10 * 60_000) {
            this.lastWatchdogReportAt = Date.now();
            this.logger.log(
              `ESPN queue worker heartbeat: processing ${this.activeJobKey ?? 'a queue job'}; ` +
                `currentJobAge=${Math.round(activeForMs / 1000)}s`,
            );
          }
        } else {
          const orphanedFailures =
            await this.espnQueueService.recoverOrphanedFailedJobs(7, 100);
          if (orphanedFailures > 0) {
            this.logger.warn(
              `Queue watchdog restored ${orphanedFailures} retryable failed job(s) missing retry timestamps`,
            );
          }

          const recovered = await this.espnQueueService.recoverStaleJobs(
            SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.staleProcessingMinutes,
          );
          if (recovered > 0) {
            this.logger.warn(
              `Queue watchdog recovered ${recovered} stale ESPN job(s)`,
            );
          }

          // Repair the narrow case where the process died after marking a
          // recurring job terminal but before it wrote the next durable job.
          const terminalFailures =
            await this.espnQueueService.getTerminalRecoveryCandidates(50, 7);
          for (const failedJob of terminalFailures) {
            await this.handleTerminalFailure(
              failedJob as unknown as Record<string, unknown>,
            );
          }

          const nextAt = await this.espnQueueService.getNextWakeAt();
          const now = Date.now();
          if (nextAt && nextAt.getTime() <= now) {
            const overdueSeconds = Math.max(
              0,
              Math.round((now - nextAt.getTime()) / 1000),
            );
            this.logger.warn(
              `ESPN queue watchdog found due work ${overdueSeconds}s overdue; re-arming the worker`,
            );
            this.wake(0);
          } else if (now - this.lastWatchdogReportAt >= 10 * 60_000) {
            this.lastWatchdogReportAt = now;
            this.logger.log(
              nextAt
                ? `ESPN queue worker heartbeat: healthy and waiting for the next job at ${nextAt.toISOString()}`
                : 'ESPN queue worker heartbeat: healthy; no pending or retryable jobs are due',
            );
          }
        }
      }
      this.lastWatchdogError = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastWatchdogError = message;
      this.systemMonitor.reportModuleHealth('sports', 'DEGRADED', {
        source: 'queue-watchdog',
        message,
      });
      this.systemMonitor.reportError({
        module: 'sports',
        source: 'queue-watchdog',
        operation: 'watchdog',
        message,
        occurredAt: new Date(),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.logger.warn(
        `ESPN queue watchdog could not inspect the queue; it will retry: ${message}`,
      );
      // Keep a failed Mongo read from disarming the only worker wake-up path.
      this.wake(this.queueReadRetryMs);
    } finally {
      this.scheduleWatchdog();
    }
  }

  /** New work and due-job notifications wake the worker; otherwise it sleeps. */
  private wake(delayMs = 0): void {
    if (!this.workerStarted) return;
    if (this.draining) {
      this.wakeRequested = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.drainQueue();
      },
      Math.max(0, delayMs),
    );
    this.timer.unref?.();
  }

  private async drainQueue(): Promise<void> {
    if (this.draining || !this.workerStarted || !this.youtubeQueuePrepared)
      return;
    if (!this.espnQueueService.isNormalOperationsReady()) return;
    this.draining = true;
    this.wakeRequested = false;
    this.drainCycles += 1;
    this.lastDrainStartedAt = new Date();
    try {
      // Recover jobs whose processing lease expired. A lease threshold avoids
      // stealing work from another healthy process during a rolling restart.
      if (!this.recoveryAttempted) {
        this.recoveryAttempted = true;
        const recovered = await this.espnQueueService.recoverStaleJobs(
          SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.staleProcessingMinutes,
        );
        if (recovered > 0)
          this.logger.warn(`Recovered ${recovered} interrupted ESPN jobs`);
      }
      let processedInBatch = 0;
      const maxJobsPerDrain = 25;
      while (
        processedInBatch < maxJobsPerDrain &&
        (await this.processNextJob({ includeFailed: true }))
      ) {
        processedInBatch += 1;
      }
      if (processedInBatch === maxJobsPerDrain) {
        // Yield between batches so collection backfills cannot monopolize the
        // process; finally schedules the next bounded batch.
        this.wakeRequested = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.drainFailures += 1;
      this.systemMonitor.reportModuleHealth('sports', 'DEGRADED', {
        source: 'queue-worker',
        message,
      });
      this.systemMonitor.reportError({
        module: 'sports',
        source: 'queue-worker',
        operation: 'drain-queue',
        message,
        occurredAt: new Date(),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.logger.error(`ESPN queue drain failed: ${message}`);
    } finally {
      this.draining = false;
      this.lastDrainCompletedAt = new Date();
      try {
        const nextAt = await this.espnQueueService.getNextWakeAt();
        this.queueReadFailures = 0;
        if (this.wakeRequested) {
          this.wake(0);
        } else if (nextAt) {
          this.wake(Math.max(0, nextAt.getTime() - Date.now()));
        }
      } catch (error) {
        this.queueReadFailures += 1;
        this.logger.warn(
          `Could not determine the next ESPN queue wake-up (consecutive failures=${this.queueReadFailures}); retrying in ${this.queueReadRetryMs / 1000}s: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.wake(this.queueReadRetryMs);
      }
    }
  }

  /**
   * Runs only startup-seeded standings jobs while the ordinary queue worker is
   * still gated. It waits for each job's bounded retries to finish and records
   * explicit success/failure outcomes before startup releases normal work.
   */
  async runStartupStandingsPhase(
    contexts: Array<{
      leagueId: string;
      season: number;
      standingsStateKey: string;
    }>,
  ): Promise<{ succeeded: number; failed: number; unavailable: number }> {
    const pending = new Map(
      contexts.map((context) => [
        `${context.leagueId}/${context.season}`,
        context,
      ]),
    );
    let succeeded = 0;
    let failed = 0;
    let unavailable = 0;

    this.logger.log(
      `ESPN STANDINGS STARTUP PHASE started: activeLeagueSeasons=${pending.size}`,
    );

    const recovered = await this.espnQueueService.recoverStaleJobs(
      SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.staleProcessingMinutes,
    );
    const orphaned = await this.espnQueueService.recoverOrphanedFailedJobs();
    if (recovered > 0 || orphaned > 0) {
      this.logger.warn(
        `Recovered queue work before standings startup: stale=${recovered}, orphanedFailed=${orphaned}`,
      );
    }

    while (pending.size > 0) {
      for (const [key, context] of [...pending.entries()]) {
        const unitSuccessful =
          await this.sportsSyncStateService.isUnitSuccessful(
            context.standingsStateKey,
            'STEP:STANDINGS_INITIAL',
          );

        if (unitSuccessful) {
          succeeded += 1;
          pending.delete(key);
          continue;
        }

        const unitUnavailable =
          await this.sportsSyncStateService.isUnitUnavailable(
            context.standingsStateKey,
            'STEP:STANDINGS_INITIAL',
          );
        if (unitUnavailable) {
          unavailable += 1;
          pending.delete(key);
          continue;
        }

        // Use the queue service's concrete durable lookup. A lookup failure
        // must propagate as an infrastructure error; it is not an ESPN result.
        const job = await this.espnQueueService.getStartupStandingsJobStatus(
          context.leagueId,
          context.season,
        );

        if (!job) {
          throw new Error(
            `Startup standings job is missing for ${context.leagueId}/${context.season}`,
          );
        }

        if (job.status === 'COMPLETED') {
          throw new Error(
            `Startup standings job completed without successful sync state for ${context.leagueId}/${context.season}`,
          );
        }

        const terminalFailure =
          job.status === 'FAILED' &&
          job.attempts >= job.maxAttempts &&
          !job.nextAttemptAt;

        if (terminalFailure) {
          const lastError =
            typeof job.lastError === 'string' ? job.lastError : '';
          const errorText = lastError.toLowerCase();
          if (
            errorText.includes('standings are unavailable') ||
            errorText.includes('no populated standings') ||
            errorText.includes('empty standings payload')
          ) {
            unavailable += 1;
          } else {
            failed += 1;
          }
          this.logger.warn(
            `Initial standings outcome for ${context.leagueId}/${context.season}: ${errorText.includes('standings') && (errorText.includes('unavailable') || errorText.includes('no populated') || errorText.includes('empty')) ? 'UNAVAILABLE' : 'FAILED'}; ${lastError || 'no error details'}`,
          );
          pending.delete(key);
        }
      }

      if (pending.size === 0) break;

      const processed = await this.processNextJob({
        jobTypes: [EspnQueueJobType.STANDINGS_REFRESH],
        includeFailed: true,
        triggerEventIdPrefix: 'STARTUP_STANDINGS:',
      });

      if (!processed) {
        // Startup-only standings recovery waits five minutes when no job is due, rather
        // than querying the durable queue every second. The normal worker remains
        // gated until this phase completes, preserving startup ordering.
        await new Promise<void>((resolve) => setTimeout(resolve, 5 * 60_000));
      }
    }

    this.logger.log(
      `ESPN STANDINGS STARTUP PHASE completed: ` +
        `total=${contexts.length}, succeeded=${succeeded}, unavailable=${unavailable}, failed=${failed}`,
    );

    return { succeeded, failed, unavailable };
  }

  /**
   * Runs startup-seeded Summary jobs while normal queue processing is still
   * gated. Queue records remain the source of truth, but startup waits for
   * the provider call and persisted Summary state before it can continue.
   */
  async runStartupSummaryPhase(
    contexts: Array<{
      leagueId: string;
      eventId: string;
      season: number;
      summaryStateKey: string;
    }>,
  ): Promise<{ succeeded: number; failed: number }> {
    const pending = new Map(
      contexts.map((context) => [
        `${context.leagueId}/${context.season}/${context.eventId}`,
        context,
      ]),
    );
    let succeeded = 0;
    let failed = 0;

    this.logger.log(
      `ESPN SUMMARY STARTUP WORKER started: fixtures=${pending.size}`,
    );

    const recovered = await this.espnQueueService.recoverStaleJobs(
      SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.staleProcessingMinutes,
    );
    const orphaned = await this.espnQueueService.recoverOrphanedFailedJobs();
    if (recovered > 0 || orphaned > 0) {
      this.logger.warn(
        `Recovered queue work before Summary startup: stale=${recovered}, orphanedFailed=${orphaned}`,
      );
    }

    while (pending.size > 0) {
      let processed = false;
      let earliestNextRunAt: Date | undefined;

      for (const [key, context] of pending) {
        const stepKey = this.sportsSyncStateService.getSummaryStepKey(
          context.eventId,
        );
        const successful = await this.sportsSyncStateService.isUnitSuccessful(
          context.summaryStateKey,
          `STEP:${stepKey}`,
        );

        if (successful) {
          succeeded += 1;
          pending.delete(key);
          continue;
        }

        const processedJob = await this.processNextJob({
          jobTypes: [EspnQueueJobType.SUMMARY_REFRESH],
          includeFailed: true,
          leagueId: context.leagueId,
          season: context.season,
          eventId: context.eventId,
        });

        if (processedJob) {
          processed = true;
          break;
        }

        const work = await this.espnQueueService.getSummaryRefreshWorkStatus({
          leagueId: context.leagueId,
          eventId: context.eventId,
          season: context.season,
        });

        if (
          work?.status === EspnQueueStatus.FAILED &&
          work.attempts >= work.maxAttempts &&
          !work.nextRunAt
        ) {
          failed += 1;
          pending.delete(key);
          this.logger.error(
            `Startup Summary failed for ${context.leagueId}/${context.season}/${context.eventId}: ` +
              `${work.lastError ?? 'retry budget exhausted without an error message'}`,
          );
          continue;
        }

        if (!work) {
          failed += 1;
          pending.delete(key);
          this.logger.error(
            `Startup Summary has no outstanding queue work for ${context.leagueId}/${context.season}/${context.eventId}`,
          );
          continue;
        }

        const nextRunAt = work.nextRunAt ?? new Date(Date.now() + 1_000);
        if (
          !earliestNextRunAt ||
          nextRunAt.getTime() < earliestNextRunAt.getTime()
        ) {
          earliestNextRunAt = nextRunAt;
        }
      }

      if (pending.size === 0 || processed) {
        continue;
      }

      const waitMs = earliestNextRunAt
        ? Math.max(1_000, earliestNextRunAt.getTime() - Date.now())
        : 1_000;
      await this.wait(waitMs);
    }

    this.logger.log(
      `ESPN SUMMARY STARTUP WORKER completed: total=${contexts.length}, ` +
        `succeeded=${succeeded}, failed=${failed}`,
    );

    return { succeeded, failed };
  }

  // ============================================================
  // JOB EXECUTION
  // ============================================================

  private async processNextJob(params?: {
    jobTypes?: EspnQueueJobType[];
    includeFailed?: boolean;
    triggerEventIdPrefix?: string;
    leagueId?: string;
    season?: number;
    eventId?: string;
  }): Promise<boolean> {
    const job = await this.espnQueueService.getNextJob(params);

    if (!job) {
      return false;
    }

    const queueJob = job as unknown as Record<string, unknown>;
    this.activeJobKey = this.safeJobString(
      queueJob.jobKey ?? queueJob._id,
      'unknown',
    );
    this.activeJobStartedAt = Date.now();
    this.activeJobType = this.safeJobString(queueJob.type, 'unknown');

    this.logger.debug(
      `Processing ESPN queue job ${this.activeJobKey} (${String(queueJob.type)})`,
    );

    try {
      await this.processJob(queueJob);

      switch (queueJob.type) {
        case EspnQueueJobType.FIXTURE_REFRESH: {
          if (this.isLegacyPostMatchCheck(queueJob)) break;
          const stateKey = this.getStateKeyFromJob(queueJob);
          const complete =
            await this.sportsSyncStateService.isComplete(stateKey);

          if (!complete) {
            throw new Error(
              `Synchronization state ${stateKey} is not complete`,
            );
          }

          break;
        }

        case EspnQueueJobType.SUMMARY_REFRESH: {
          const stateKey = this.getStateKeyFromJob(queueJob);

          if (!queueJob.eventId) {
            throw new Error(
              'Summary refresh queue job has no eventId after processing',
            );
          }

          const eventId = this.stringifyJobId(queueJob.eventId);

          const complete =
            await this.sportsSyncStateService.isSummaryEventComplete(
              stateKey,
              eventId,
            );

          if (!complete) {
            throw new Error(
              `Summary synchronization for ${eventId} is not complete in ${stateKey}`,
            );
          }

          break;
        }

        case EspnQueueJobType.YOUTUBE_HIGHLIGHT:
        case EspnQueueJobType.STANDINGS_REFRESH:
        case EspnQueueJobType.LEAGUE_CATALOGUE_REFRESH:
        case EspnQueueJobType.LEAGUE_DETAIL_REFRESH:
          break;

        default:
          break;
      }

      // Persist every required successor before acknowledging this job as
      // COMPLETED. If the process crashes after enqueueing successors, a retry
      // is safe because every successor has a deterministic logical key. If
      // successor creation fails, this job remains retryable instead of
      // creating a silent gap in its workflow chain.
      await this.afterSuccessfulJob(queueJob);
      await this.espnQueueService.markCompleted(String(queueJob._id));
      this.jobsSucceeded += 1;
      this.lastJobAt = new Date();
      this.lastJobType = this.activeJobType;
      this.lastJobStatus = 'SUCCEEDED';
      this.lastJobDurationMs = this.activeJobStartedAt ? Date.now() - this.activeJobStartedAt : undefined;
      this.lastJobError = undefined;
    } catch (error) {
      if (
        error instanceof SummaryJobDeferredError ||
        (error && typeof error === 'object' &&
          (error as { summaryJobDeferred?: unknown }).summaryJobDeferred === true)
      ) {
        this.logger.debug(error instanceof Error ? error.message : 'Deferred Summary job outside its active timing window.');
        this.lastJobAt = new Date();
        this.lastJobType = this.activeJobType;
        this.lastJobStatus = 'DEFERRED';
        this.lastJobDurationMs = this.activeJobStartedAt ? Date.now() - this.activeJobStartedAt : undefined;
        // The job has already been returned to PENDING at its contract-compliant
        // time. Do not mark it failed or count this as a provider attempt.
        return true;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.jobsFailed += 1;
      this.lastJobAt = new Date();
      this.lastJobType = this.activeJobType;
      this.lastJobStatus = 'FAILED';
      this.lastJobDurationMs = this.activeJobStartedAt ? Date.now() - this.activeJobStartedAt : undefined;
      this.lastJobError = message;

      const isExpectedYoutubeMiss =
        queueJob.type === EspnQueueJobType.YOUTUBE_HIGHLIGHT &&
        message.startsWith('No suitable YouTube highlight found');

      if (isExpectedYoutubeMiss) {
        this.logger.log('ESPN YouTube highlight unavailable; retry workflow evaluated');
      } else {
        this.logger.error('ESPN queue job failed; see system monitor for diagnostics');
        this.systemMonitor.reportError({
          module: 'sports',
          source: this.safeJobString(queueJob.type, 'queue-worker'),
          operation: this.safeJobString(queueJob.type, 'job'),
          message,
          occurredAt: new Date(),
          stack: error instanceof Error ? error.stack : undefined,
          referenceKey: this.safeJobString(queueJob.jobKey ?? queueJob._id, ''),
        });
        this.systemMonitor.reportActivity({
          module: 'sports',
          source: 'queue-worker',
          operation: this.safeJobString(queueJob.type, 'job'),
          status: 'FAILED',
          message: `ESPN queue job failed: ${message}`,
          occurredAt: new Date(),
          durationMs: this.activeJobStartedAt
            ? Date.now() - this.activeJobStartedAt
            : undefined,
          referenceKey: this.safeJobString(queueJob.jobKey ?? queueJob._id, ''),
        });
      }

      await this.espnQueueService.markFailed(job, message);

      const attempts = Number(queueJob.attempts ?? 0);
      const maxAttempts = Number(queueJob.maxAttempts ?? 0);
      if (
        !isExpectedYoutubeMiss &&
        maxAttempts > 0 &&
        attempts >= maxAttempts
      ) {
        this.systemMonitor.reportModuleHealth('sports', 'DEGRADED', {
          source: 'queue-worker',
          message: `ESPN job ${String(queueJob.jobKey ?? queueJob._id)} exhausted ${maxAttempts} attempts: ${message}`,
        });
      }
      if (maxAttempts > 0 && attempts >= maxAttempts) {
        await this.handleTerminalFailure(queueJob).catch((recoveryError) => {
          this.logger.error(
            `Could not schedule recovery for terminal ESPN job ${String(queueJob.jobKey ?? queueJob._id)}: ${
              recoveryError instanceof Error
                ? recoveryError.message
                : String(recoveryError)
            }`,
          );
        });
      }
    } finally {
      this.activeJobKey = undefined;
      this.activeJobType = undefined;
      this.activeJobStartedAt = undefined;
      this.lastLongJobWarningAt = 0;
    }

    return true;
  }

  private async handleTerminalFailure(
    job: Record<string, unknown>,
  ): Promise<void> {
    await this.afterTerminalFailure(job);
    const jobId = job._id ? this.stringifyJobId(job._id) : '';
    if (jobId) await this.espnQueueService.markTerminalRecoveryReviewed(jobId);
  }

  /**
   * A terminal task failure must not silently break an otherwise recurring
   * workflow. Schedule a bounded, delayed recovery generation with its own
   * stable job key. After three recovery generations, leave an explicit error
   * for operational review rather than creating an unbounded request storm.
   */
  private async afterTerminalFailure(
    job: Record<string, unknown>,
  ): Promise<void> {
    const type = job.type as EspnQueueJobType;
    const leagueId = job.leagueId ? this.stringifyJobId(job.leagueId) : '';
    const season = typeof job.season === 'number' ? job.season : undefined;
    const trigger =
      typeof job.triggerEventId === 'string' ? job.triggerEventId : '';
    const existingGeneration = this.getRecoveryGeneration(trigger);
    const nextGeneration = existingGeneration + 1;
    const rootKey = trigger.startsWith('RECOVERY:')
      ? trigger.replace(/^RECOVERY:\d+:/, '')
      : this.safeJobString(
          job.jobKey ?? job._id,
          `${type}:${leagueId}:${season ?? 'current'}`,
        );

    if (type === EspnQueueJobType.YOUTUBE_HIGHLIGHT) {
      this.logger.warn(
        `YouTube highlight job exhausted retries for ${leagueId}:${this.safeJobString(job.eventId)}; ` +
          'it may be requeued after cooldown if the fixture is encountered again today.',
      );
      return;
    }

    if (existingGeneration >= 3) {
      if (type === EspnQueueJobType.SUMMARY_REFRESH) {
        this.logger.error(
          `Summary job ${String(job.jobKey ?? job._id)} exhausted its ${existingGeneration} delayed recovery generations; ` +
            'leaving it terminal for inspection rather than repeatedly requesting an unavailable payload.',
        );
        return;
      }
      this.logger.error(
        `ESPN workflow ${String(job.jobKey ?? job._id)} exhausted its ${existingGeneration} rapid recovery generation(s); ` +
          'switching to a slower lifecycle retry rather than silently terminating the recurring chain.',
      );
      await this.scheduleSlowLifecycleFallback(job, type, leagueId, season);
      return;
    }

    const recoveryTrigger = `RECOVERY:${nextGeneration}:${rootKey}`;
    const priority =
      Number.isFinite(Number(job.priority)) && Number(job.priority) >= 1
        ? Number(job.priority)
        : 4;

    switch (type) {
      case EspnQueueJobType.FIXTURE_REFRESH: {
        if (!leagueId || season === undefined) return;
        if (
          trigger.startsWith('WINDOW_EXTEND:') ||
          (!trigger.startsWith('POSTMATCH') && !trigger.startsWith('FINISHED:'))
        ) {
          await this.espnQueueBuilderService.scheduleNextWindowExtension({
            leagueId,
            season,
            priority,
          });
          this.logger.warn(
            `Scheduled the next fixture-window extension after terminal failure for ${leagueId}/${season}`,
          );
          return;
        }

        const eventId = this.getTriggeredEventId(trigger);
        if (!eventId) return;
        const postMatchRecoveryTrigger = `POSTMATCH_RECHECK:${eventId}:RECOVERY:${nextGeneration}`;
        const hasPostMatchRecovery = await this.espnQueueService.hasJob({
          jobType: EspnQueueJobType.FIXTURE_REFRESH,
          leagueId,
          season,
          triggerEventId: postMatchRecoveryTrigger,
        });
        const fixture = await this.espnFixtureModel
          .findOne({ eventId, leagueId, season })
          .select({ completed: 1, fixtureDate: 1 })
          .lean()
          .exec();
        if (fixture?.completed === true) {
          // Reconcile each follow-up independently. The queue builders enforce
          // stable keys, so a partially completed recovery is safe to repeat.
          await this.espnQueueBuilderService.queueFinishedSummaryRefresh({
            eventId,
            leagueId,
            season,
            priority,
          });
          await this.espnQueueBuilderService.queueYoutubeHighlightForCompletedFixture(
            {
              eventId,
              leagueId,
              season,
              priority,
            },
          );
          await this.espnQueueBuilderService.queueStandingsRefresh({
            leagueId,
            season,
            priority,
            eventId,
            triggerEventId: recoveryTrigger,
          });
          return;
        }
        const fixtureDate = fixture?.fixtureDate
          ? new Date(fixture.fixtureDate)
          : undefined;
        const recentEnough = Boolean(
          fixtureDate &&
          !Number.isNaN(fixtureDate.getTime()) &&
          fixtureDate.getTime() >= Date.now() - 24 * 60 * 60 * 1000,
        );
        if (fixture && recentEnough && !hasPostMatchRecovery) {
          await this.espnQueueBuilderService.scheduleNextPostMatchCheck({
            eventId,
            leagueId,
            season,
            priority,
            scheduledFor: new Date(Date.now() + 30 * 60_000),
            recoveryGeneration: nextGeneration,
          });
        }
        return;
      }

      case EspnQueueJobType.SUMMARY_REFRESH: {
        const jobId = job._id ? this.stringifyJobId(job._id) : '';
        if (!jobId) return;
        const delayMs =
          existingGeneration === 0
            ? 60 * 60_000
            : existingGeneration === 1
              ? 6 * 60 * 60_000
              : 24 * 60 * 60_000;
        const scheduledFor = new Date(Date.now() + delayMs);
        const recovered =
          await this.espnQueueService.scheduleTerminalSummaryRecovery(
            jobId,
            `SUMMARY_RECOVERY:${nextGeneration}`,
            scheduledFor,
          );
        if (recovered) {
          this.logger.warn(
            `Scheduled Summary recovery generation ${nextGeneration} for ${leagueId}:${this.safeJobString(job.eventId)} at ${scheduledFor.toISOString()}`,
          );
        }
        return;
      }

      case EspnQueueJobType.LEAGUE_CATALOGUE_REFRESH:
        if (
          await this.espnQueueService.hasJob({
            jobType: EspnQueueJobType.LEAGUE_CATALOGUE_REFRESH,
            leagueId: '__system__',
            triggerEventId: recoveryTrigger,
          })
        )
          return;
        await this.espnQueueBuilderService.scheduleNextCatalogueRefresh({
          scheduledFor: new Date(
            Date.now() + (existingGeneration === 0 ? 60 : 180) * 60_000,
          ),
          triggerEventId: recoveryTrigger,
        });
        this.logger.warn(
          `Scheduled catalogue recovery generation ${nextGeneration}`,
        );
        return;

      case EspnQueueJobType.LEAGUE_DETAIL_REFRESH:
        if (!leagueId) return;
        if (
          await this.espnQueueService.hasJob({
            jobType: EspnQueueJobType.LEAGUE_DETAIL_REFRESH,
            leagueId,
            season,
            triggerEventId: recoveryTrigger,
          })
        )
          return;
        await this.espnQueueBuilderService.scheduleLeagueDetailRecovery({
          leagueId,
          season,
          priority,
          triggerEventId: recoveryTrigger,
          delayMs: (existingGeneration === 0 ? 60 : 360) * 60_000,
        });
        this.logger.warn(
          `Scheduled league-detail recovery ${nextGeneration} for ${leagueId}`,
        );
        return;

      case EspnQueueJobType.SEASON_FIXTURE_BOOTSTRAP:
        if (!leagueId || season === undefined) return;
        if (
          await this.espnQueueService.hasJob({
            jobType: EspnQueueJobType.SEASON_FIXTURE_BOOTSTRAP,
            leagueId,
            season,
            triggerEventId: recoveryTrigger,
          })
        )
          return;
        await this.espnQueueBuilderService.queueSeasonFixtureBootstrap({
          leagueId,
          season,
          priority,
          scheduledFor: new Date(Date.now() + 6 * 60 * 60_000),
          triggerEventId: recoveryTrigger,
        });
        this.logger.warn(
          `Scheduled season-bootstrap recovery ${nextGeneration} for ${leagueId}/${season}`,
        );
        return;

      case EspnQueueJobType.STANDINGS_REFRESH:
        if (!leagueId || season === undefined) return;
        if (
          await this.espnQueueService.hasJob({
            jobType: EspnQueueJobType.STANDINGS_REFRESH,
            leagueId,
            season,
            triggerEventId: recoveryTrigger,
          })
        )
          return;
        await this.espnQueueBuilderService.queueStandingsRefresh({
          leagueId,
          season,
          priority,
          eventId: typeof job.eventId === 'string' ? job.eventId : undefined,
          triggerEventId: recoveryTrigger,
          scheduledFor: new Date(
            Date.now() + (existingGeneration === 0 ? 15 : 60) * 60_000,
          ),
        });
        this.logger.warn(
          `Scheduled standings recovery ${nextGeneration} for ${leagueId}/${season}`,
        );
        return;

      default:
        return;
    }
  }

  /**
   * After bounded short-delay recovery generations are exhausted, recurring
   * workflows retain a slower durable retry cadence. This prevents a bad day
   * of provider failures from killing the chain, without hammering the APIs.
   * Summary collection remains bounded; YouTube misses remain event-driven.
   */
  private async scheduleSlowLifecycleFallback(
    job: Record<string, unknown>,
    type: EspnQueueJobType,
    leagueId: string,
    season?: number,
  ): Promise<void> {
    const jobKey = this.safeJobString(
      job.jobKey ?? job._id,
      `${type}:${leagueId}`,
    );
    const priority =
      Number.isFinite(Number(job.priority)) && Number(job.priority) >= 1
        ? Number(job.priority)
        : 4;
    const due = new Date(Date.now() + 24 * 60 * 60_000);
    const fallbackTrigger = `LIFECYCLE_FALLBACK:${jobKey}`;

    switch (type) {
      case EspnQueueJobType.FIXTURE_REFRESH: {
        if (!leagueId || season === undefined) return;
        const trigger =
          typeof job.triggerEventId === 'string' ? job.triggerEventId : '';
        const eventId = this.getTriggeredEventId(trigger);
        if (
          !eventId ||
          (!trigger.startsWith('POSTMATCH') && !trigger.startsWith('FINISHED:'))
        ) {
          // The daily extension chain always continues at the next Nigeria midnight.
          await this.espnQueueBuilderService.scheduleNextWindowExtension({
            leagueId,
            season,
            priority,
          });
          return;
        }
        const fixture = await this.espnFixtureModel
          .findOne({ eventId, leagueId, season })
          .select({ completed: 1, fixtureDate: 1 })
          .lean()
          .exec();
        if (fixture?.completed === true) {
          await this.espnQueueBuilderService.queueFinishedSummaryRefresh({
            eventId,
            leagueId,
            season,
            priority,
          });
          await this.espnQueueBuilderService.queueYoutubeHighlightForCompletedFixture(
            {
              eventId,
              leagueId,
              season,
              priority,
            },
          );
          await this.espnQueueBuilderService.queueStandingsRefresh({
            leagueId,
            season,
            priority,
            eventId,
            triggerEventId: fallbackTrigger,
            scheduledFor: due,
          });
          return;
        }
        const fixtureDate = fixture?.fixtureDate
          ? new Date(fixture.fixtureDate)
          : undefined;
        if (
          fixtureDate &&
          !Number.isNaN(fixtureDate.getTime()) &&
          fixtureDate.getTime() >= Date.now() - 24 * 60 * 60_000
        ) {
          await this.espnQueueBuilderService.scheduleNextPostMatchCheck({
            eventId,
            leagueId,
            season,
            priority,
            scheduledFor: due,
          });
        }
        return;
      }

      case EspnQueueJobType.LEAGUE_CATALOGUE_REFRESH:
        await this.espnQueueBuilderService.scheduleNextCatalogueRefresh({
          scheduledFor: due,
          triggerEventId: fallbackTrigger,
        });
        return;

      case EspnQueueJobType.LEAGUE_DETAIL_REFRESH:
        if (!leagueId) return;
        await this.espnQueueBuilderService.scheduleLeagueDetailRecovery({
          leagueId,
          season,
          priority,
          triggerEventId: fallbackTrigger,
          delayMs: 24 * 60 * 60_000,
        });
        return;

      case EspnQueueJobType.SEASON_FIXTURE_BOOTSTRAP:
        if (!leagueId || season === undefined) return;
        await this.espnQueueBuilderService.queueSeasonFixtureBootstrap({
          leagueId,
          season,
          priority,
          scheduledFor: new Date(Date.now() + 12 * 60 * 60_000),
          triggerEventId: fallbackTrigger,
        });
        return;

      case EspnQueueJobType.STANDINGS_REFRESH:
        if (!leagueId || season === undefined) return;
        await this.espnQueueBuilderService.queueStandingsRefresh({
          leagueId,
          season,
          priority,
          eventId: typeof job.eventId === 'string' ? job.eventId : undefined,
          triggerEventId: fallbackTrigger,
          scheduledFor: due,
        });
        return;

      case EspnQueueJobType.SUMMARY_REFRESH:
        // Summary receives three delayed recovery generations, then stops with
        // an explicit terminal failure to avoid repeated requests for bad IDs.
        return;

      case EspnQueueJobType.YOUTUBE_HIGHLIGHT:
      default:
        return;
    }
  }

  private getRecoveryGeneration(trigger: string): number {
    const summaryGeneration = trigger.match(/^SUMMARY_RECOVERY:(\d+)$/);
    if (summaryGeneration) return Number(summaryGeneration[1]);
    const prefixGeneration = trigger.match(/^RECOVERY:(\d+):/);
    if (prefixGeneration) return Number(prefixGeneration[1]);
    const suffixGeneration = trigger.match(/:RECOVERY:(\d+)$/);
    return suffixGeneration ? Number(suffixGeneration[1]) : 0;
  }

  private async afterSuccessfulJob(
    job: Record<string, unknown>,
  ): Promise<void> {
    const type = job.type as EspnQueueJobType;
    const leagueId = job.leagueId ? this.stringifyJobId(job.leagueId) : '';
    const season = typeof job.season === 'number' ? job.season : undefined;
    const trigger =
      typeof job.triggerEventId === 'string' ? job.triggerEventId : '';

    if (
      type === EspnQueueJobType.SUMMARY_REFRESH &&
      leagueId &&
      season !== undefined &&
      typeof job.eventId === 'string'
    ) {
      const eventId = this.stringifyJobId(job.eventId);
      const priority = typeof job.priority === 'number' ? job.priority : 4;
      await this.espnQueueBuilderService.scheduleNextPostMatchSummaryCheckpoint({
        eventId,
        leagueId,
        season,
        priority,
      });

      // A Summary response can repair the canonical result even when the
      // scoreboard root missed the completion transition. Seed the same
      // completion-dependent work as the normal fixture-collection path.
      const fixture = await this.espnFixtureModel
        .findOne({ eventId, leagueId, season })
        .select({ completed: 1 })
        .lean()
        .exec();
      if (fixture?.completed === true) {
        await this.espnQueueBuilderService.queueYoutubeHighlightForCompletedFixture({
          eventId,
          leagueId,
          season,
          priority,
        });
        await this.espnQueueBuilderService.queueStandingsRefresh({
          leagueId,
          season,
          priority,
          eventId,
        });
      }
    }

    if (
      type === EspnQueueJobType.FIXTURE_REFRESH &&
      leagueId &&
      season !== undefined
    ) {
      if (trigger.startsWith('WINDOW_EXTEND:')) {
        const priority = typeof job.priority === 'number' ? job.priority : 4;
        await this.espnQueueBuilderService.scheduleNextWindowExtension({
          leagueId,
          season,
          priority,
        });
        try {
          await this.espnQueueBuilderService.buildIntegrityRecoveryQueue({
            leagueId,
            season,
            // Window extensions are scoped per competition; keep recovery to
            // one event per league pass so 100+ active leagues cannot create a
            // sudden provider-request burst at midnight.
            maxQueued: 1,
          });
        } catch (error) {
          // Do not retry a successful provider month merely because the optional
          // integrity queue pass failed. The next durable daily pass will retry.
          this.logger.warn(
            `ESPN integrity recovery pass failed for ${leagueId}/${season}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const eventId = this.getTriggeredEventId(trigger);
      if (eventId) {
        // The post-kickoff Summary job is independent of ESPN's completed flag.
        // It is durable and scheduled for kickoff + 3 hours.
        await this.espnQueueBuilderService.queuePostKickoffSummaryRefresh({
          eventId,
          leagueId,
          season,
          priority: typeof job.priority === 'number' ? job.priority : 4,
        });

        const fixture = await this.espnFixtureModel
          .findOne({ eventId, leagueId, season })
          .select({ completed: 1, fixtureDate: 1, completedAt: 1 })
          .lean()
          .exec();
        if (fixture?.completed === true) {
          await this.espnQueueBuilderService.queueYoutubeHighlightForCompletedFixture(
            {
              eventId,
              leagueId,
              season,
              priority: typeof job.priority === 'number' ? job.priority : 4,
            },
          );
          await this.espnQueueBuilderService.queueStandingsRefresh({
            leagueId,
            season,
            priority: typeof job.priority === 'number' ? job.priority : 4,
            eventId,
          });
        }
      }
    }

    if (type === EspnQueueJobType.LEAGUE_CATALOGUE_REFRESH) {
      await this.espnQueueBuilderService.scheduleNextCatalogueRefresh({
        sourceJobKey: this.safeJobString(
          job.jobKey ?? job._id,
          'catalogue-refresh',
        ),
      });
    }

    if (
      type === EspnQueueJobType.SEASON_FIXTURE_BOOTSTRAP &&
      leagueId &&
      season !== undefined
    ) {
      const currentLeague =
        (await this.espnActiveCompetitionService.getBySlug(leagueId)) ??
        (await this.espnActiveCompetitionService.getByLeagueId(leagueId));
      if (
        currentLeague?.isActive &&
        currentLeague.season === season &&
        currentLeague.fixturesCollectedSeason !== season
      ) {
        const scheduledFor = new Date(Date.now() + 6 * 60 * 60 * 1000);
        const sixHourSlot = Math.floor(
          scheduledFor.getTime() / (6 * 60 * 60 * 1000),
        );
        await this.espnQueueBuilderService.queueSeasonFixtureBootstrap({
          leagueId,
          season,
          priority: typeof job.priority === 'number' ? job.priority : 4,
          scheduledFor,
          triggerEventId: `SEASON_BOOTSTRAP_RETRY:${sixHourSlot}`,
        });
        return;
      }
      await this.espnQueueBuilderService.scheduleNextWindowExtension({
        leagueId,
        season,
        priority: typeof job.priority === 'number' ? job.priority : 4,
      });
      await this.espnQueueBuilderService.buildSummaryRefreshQueue({
        leagueId,
        season,
      });
      await this.espnQueueBuilderService.buildPostMatchCheckQueue({
        leagueId,
        season,
      });
      await this.espnQueueBuilderService.buildRecentlyCompletedWorkQueue({
        leagueId,
        season,
      });
      try {
        await this.espnQueueBuilderService.buildIntegrityRecoveryQueue({
          leagueId,
          season,
          maxQueued: 1,
        });
      } catch (error) {
        this.logger.warn(
          `ESPN integrity recovery pass failed after season bootstrap ${leagueId}/${season}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (type === EspnQueueJobType.LEAGUE_DETAIL_REFRESH && leagueId) {
      await this.espnQueueBuilderService.scheduleNextLeagueDetailRefresh(
        leagueId,
        this.safeJobString(job.jobKey ?? job._id, `${leagueId}:detail-refresh`),
      );
    }
  }

  private getTriggeredEventId(trigger: string): string | undefined {
    for (const prefix of ['FINISHED:', 'POSTMATCH_RECHECK:', 'POSTMATCH:']) {
      if (trigger.startsWith(prefix)) {
        const eventId = trigger.slice(prefix.length).split(':')[0].trim();
        if (eventId) return eventId;
      }
    }
    return undefined;
  }

  private async processJob(job: Record<string, unknown>): Promise<void> {
    switch (job.type) {
      case EspnQueueJobType.FIXTURE_REFRESH:
        if (this.isLegacyPostMatchCheck(job)) {
          await this.processLegacyPostMatchCheck(job);
          return;
        }
        await this.processFixtureRefresh(job);
        return;

      case EspnQueueJobType.SUMMARY_REFRESH:
        await this.processSummaryRefresh(job);
        return;

      case EspnQueueJobType.YOUTUBE_HIGHLIGHT:
        await this.processYoutubeHighlight(job);
        return;

      case EspnQueueJobType.STANDINGS_REFRESH: {
        if (!job.leagueId || typeof job.season !== 'number') {
          throw new Error('Standings refresh job requires leagueId and season');
        }
        const leagueId = this.stringifyJobId(job.leagueId);
        const season = job.season;
        const stateKey = this.sportsSyncStateService.getQueueStateKey({
          jobType: EspnQueueJobType.STANDINGS_REFRESH,
          leagueId,
          season,
        });
        const state = await this.sportsSyncStateService.getState(stateKey);
        const initialUnit = state?.units?.find(
          (unit) => unit.key === 'STEP:STANDINGS_INITIAL',
        );
        const isStartupSeed =
          typeof job.triggerEventId === 'string' &&
          job.triggerEventId.startsWith('STARTUP_STANDINGS:');
        const initialRefreshPending = Boolean(
          initialUnit &&
          String(initialUnit.status) !== 'SUCCESS' &&
          String(initialUnit.status) !== 'UNAVAILABLE',
        );
        const refresh = async () => {
          await this.espnStandingsService.processQueuedRefresh(
            leagueId,
            season,
          );
        };

        if (isStartupSeed || initialRefreshPending) {
          await this.runTrackedStep(stateKey, 'STANDINGS_INITIAL', async () => {
            await this.sportsSyncStateService.resetStepForRefresh(
              stateKey,
              'STANDINGS_REFRESH',
            );
            await this.runTrackedStep(stateKey, 'STANDINGS_REFRESH', refresh);
            if (
              await this.sportsSyncStateService.isUnitUnavailable(
                stateKey,
                'STEP:STANDINGS_REFRESH',
              )
            ) {
              const unavailableError = new Error(
                `Initial standings are unavailable for ${leagueId}/${season}`,
              );
              unavailableError.name = 'StandingsUnavailableError';
              throw unavailableError;
            }
          });
        } else if (state && initialUnit) {
          // Track every later refresh separately from the one-time startup
          // milestone, so an ordinary refresh failure is visible in sync state.
          await this.sportsSyncStateService.resetStepForRefresh(
            stateKey,
            'STANDINGS_REFRESH',
          );
          await this.runTrackedStep(stateKey, 'STANDINGS_REFRESH', refresh);
        } else {
          await refresh();
        }
        return;
      }

      case EspnQueueJobType.LEAGUE_CATALOGUE_REFRESH:
        await this.espnActiveCompetitionService.synchronizeLeagueCatalogue();
        await this.espnQueueBuilderService.queueAllLeagueDetails();
        return;

      case EspnQueueJobType.LEAGUE_DETAIL_REFRESH: {
        if (!job.leagueId)
          throw new Error('League detail job requires leagueId');
        const leagueId = this.stringifyJobId(job.leagueId);
        const league =
          (await this.espnActiveCompetitionService.getBySlug(leagueId)) ??
          (await this.espnActiveCompetitionService.getByLeagueId(leagueId));
        if (!league)
          throw new Error(`ESPN league ${leagueId} is absent from catalogue`);
        await this.espnActiveCompetitionService.synchronizeLeagueDetail(league);

        // The detail refresh is the season lifecycle event. If ESPN exposes
        // a newly active season, persist a full-season bootstrap instead of
        // introducing a separate recurring watcher.
        const refreshed =
          (await this.espnActiveCompetitionService.getBySlug(leagueId)) ??
          (await this.espnActiveCompetitionService.getByLeagueId(leagueId));
        if (
          refreshed?.isActive &&
          typeof refreshed.season === 'number' &&
          refreshed.fixturesCollectedSeason !== refreshed.season
        ) {
          await this.espnQueueBuilderService.queueSeasonFixtureBootstrap({
            leagueId: this.stringifyJobId(refreshed.slug || refreshed.leagueId),
            season: refreshed.season,
            priority: typeof job.priority === 'number' ? job.priority : 4,
          });
        }
        return;
      }

      case EspnQueueJobType.SEASON_FIXTURE_BOOTSTRAP:
        await this.processSeasonFixtureBootstrap(job);
        return;

      default:
        throw new Error(`Unsupported ESPN queue job type: ${String(job.type)}`);
    }
  }

  // ============================================================
  // NEW-SEASON FIXTURE BOOTSTRAP
  // ============================================================

  private async processSeasonFixtureBootstrap(
    job: Record<string, unknown>,
  ): Promise<void> {
    if (!job.leagueId || typeof job.season !== 'number') {
      throw new Error('Season fixture bootstrap requires leagueId and season');
    }
    const leagueId = this.stringifyJobId(job.leagueId).trim().toLowerCase();
    const season = job.season;
    const league =
      (await this.espnActiveCompetitionService.getBySlug(leagueId)) ??
      (await this.espnActiveCompetitionService.getByLeagueId(leagueId));
    if (!league?.isActive || league.season !== season) {
      throw new Error(
        `Season bootstrap ${leagueId}/${season} no longer matches an active ESPN season`,
      );
    }
    if (league.fixturesCollectedSeason === season) return;
    if (!league.seasonStartDate || !league.seasonEndDate) {
      throw new Error(
        `Season bootstrap ${leagueId}/${season} requires both season start and end dates`,
      );
    }

    const seasonStart = new Date(league.seasonStartDate);
    const seasonEnd = new Date(league.seasonEndDate);
    if (
      Number.isNaN(seasonStart.getTime()) ||
      Number.isNaN(seasonEnd.getTime())
    ) {
      throw new Error(
        `Season bootstrap ${leagueId}/${season} has an invalid season start or end date`,
      );
    }
    const dateFrom = this.toDateOnly(seasonStart);
    const dateTo = this.toDateOnly(seasonEnd);
    if (dateFrom > dateTo) {
      throw new Error(
        `Season bootstrap ${leagueId}/${season} has a start date after its end date`,
      );
    }

    const priority = typeof job.priority === 'number' ? job.priority : 4;
    const state = await this.sportsSyncStateService.ensureFixtureRefreshState({
      leagueId,
      season,
      priority,
      dateFrom,
      dateTo,
      trackingMode: 'HISTORY',
      granularity: 'MONTH',
    });
    await this.sportsSyncStateService.resetInterruptedUnits(state.stateKey);

    const attemptedAt = league.fixtureCollectionAttemptedAt
      ? new Date(league.fixtureCollectionAttemptedAt)
      : undefined;
    const cooldownElapsed =
      !attemptedAt ||
      Number.isNaN(attemptedAt.getTime()) ||
      Date.now() - attemptedAt.getTime() >= 6 * 60 * 60 * 1000;
    if (league.fixtureCollectionAttemptSeason === season && cooldownElapsed) {
      await this.sportsSyncStateService.resetMonthUnitsForRetry(state.stateKey);
    }

    const monthKeys = await this.sportsSyncStateService.getIncompleteMonths(
      state.stateKey,
    );
    const failures: string[] = [];
    const concurrency =
      SPORTS_DATA_COLLECTION_CONFIG.ESPN.fixtures.startupConcurrency;
    for (let index = 0; index < monthKeys.length; index += concurrency) {
      const batch = monthKeys.slice(index, index + concurrency);
      const results = await Promise.allSettled(
        batch.map(async (monthKey) => {
          await this.sportsSyncStateService.markMonthProcessing(
            state.stateKey,
            monthKey,
          );
          try {
            const response = await this.espnService.getFixturesForMonth(
              leagueId,
              monthKey,
            );
            await this.sportsCollectionService.collectEspnFixtures(
              leagueId,
              this.filterFixtureResponseToSeasonAndRange(
                response,
                season,
                dateFrom,
                dateTo,
              ),
            );
            await this.sportsSyncStateService.markMonthSuccess(
              state.stateKey,
              monthKey,
            );
          } catch (error) {
            await this.sportsSyncStateService.markMonthFailed(
              state.stateKey,
              monthKey,
              error,
            );
            throw error;
          }
        }),
      );
      results.forEach((result, resultIndex) => {
        if (result.status === 'rejected') {
          failures.push(
            `${batch[resultIndex]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
        }
      });
    }

    await this.sportsSyncStateService.refreshOverallStatus(state.stateKey);
    if (failures.length > 0) {
      throw new Error(
        `Season fixture bootstrap failed for ${leagueId}/${season}: ${failures.join('; ')}`,
      );
    }
    await this.sportsSyncStateService.assertFixtureStartupComplete(
      leagueId,
      season,
    );

    await this.espnActiveCompetitionService.markSeasonFixturesCollected(
      leagueId,
      season,
    );
    // An empty catalogue is not an API error: completed month queries remain
    // successful, and the persistent lifecycle hook retries the season after
    // the existing six-hour empty-catalogue cooldown.
  }

  private filterFixtureResponseToSeasonAndRange(
    response: unknown,
    season: number,
    dateFrom: string,
    dateTo: string,
  ): unknown {
    if (!response || typeof response !== 'object') return response;
    const record = response as Record<string, unknown>;
    if (!Array.isArray(record.events)) return response;
    const events = record.events.filter((item) => {
      if (!item || typeof item !== 'object') return false;
      const event = item as Record<string, unknown>;
      const eventDate =
        typeof event.date === 'string' ? event.date.slice(0, 10) : '';
      if (!eventDate || eventDate < dateFrom || eventDate > dateTo)
        return false;
      const competition = Array.isArray(event.competitions)
        ? (event.competitions[0] as Record<string, unknown> | undefined)
        : undefined;
      const eventSeason =
        this.numberValue(
          (event.season as Record<string, unknown> | undefined)?.year,
        ) ??
        this.numberValue(
          (competition?.season as Record<string, unknown> | undefined)?.year,
        );
      return eventSeason === undefined || eventSeason === season;
    });
    return { ...record, events };
  }

  private numberValue(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (
      typeof value === 'string' &&
      value.trim() &&
      Number.isFinite(Number(value))
    )
      return Number(value);
    return undefined;
  }

  // ============================================================
  // FIXTURE REFRESH
  // ============================================================

  private isLegacyPostMatchCheck(job: Record<string, unknown>): boolean {
    if (job.type !== EspnQueueJobType.FIXTURE_REFRESH) return false;
    const trigger = typeof job.triggerEventId === 'string' ? job.triggerEventId : '';
    return trigger.startsWith('POSTMATCH:') || trigger.startsWith('POSTMATCH_RECHECK:') || trigger.startsWith('FINISHED:');
  }

  /**
   * Older deployments persisted event-specific FIXTURE_REFRESH jobs and then
   * repeated monthly scoreboard requests every 30 minutes. Drain these legacy
   * and settlement-triggered jobs as event-level Summary recovery instead.
   */
  private async processLegacyPostMatchCheck(
    job: Record<string, unknown>,
  ): Promise<void> {
    const trigger = typeof job.triggerEventId === 'string' ? job.triggerEventId : '';
    const eventId = this.getTriggeredEventId(trigger);
    const leagueId = job.leagueId ? this.stringifyJobId(job.leagueId) : '';
    const season = typeof job.season === 'number' ? job.season : undefined;
    if (!eventId || !leagueId || season === undefined) {
      throw new Error('Legacy post-match check requires eventId, leagueId, and season');
    }

    await this.espnQueueBuilderService.queuePostKickoffSummaryRefresh({
      eventId,
      leagueId,
      season,
      priority: typeof job.priority === 'number' ? job.priority : 4,
    });
    await this.espnQueueBuilderService.scheduleNextPostMatchSummaryCheckpoint({
      eventId,
      leagueId,
      season,
      priority: typeof job.priority === 'number' ? job.priority : 4,
    });
  }

  private async processFixtureRefresh(
    job: Record<string, unknown>,
  ): Promise<void> {
    if (!job.leagueId) {
      throw new Error('Fixture refresh job has no leagueId');
    }

    if (typeof job.season !== 'number') {
      throw new Error('Fixture refresh job requires season');
    }

    const leagueId = this.stringifyJobId(job.leagueId);
    const season = job.season;

    const competition =
      await this.activeCompetitionService.getByEspnLeagueSlug(leagueId);

    if (!competition) {
      throw new Error(
        `No ActiveCompetition found for fixture refresh league ${leagueId}`,
      );
    }

    if (
      typeof competition.season !== 'number' ||
      competition.season !== season
    ) {
      throw new Error(
        `ActiveCompetition season mismatch for ${leagueId}: ` +
          `queue=${season}, active=${competition.season ?? 'missing'}`,
      );
    }

    const priority =
      typeof job.priority === 'number' && Number.isFinite(job.priority)
        ? job.priority
        : 4;

    const forwardDays =
      this.espnQueueBuilderService.getFixtureRefreshForwardDays();

    const now = new Date();
    let dateFrom = this.toDateOnly(now);
    let dateTo = this.toDateOnly(this.addLagosCalendarDays(now, forwardDays));

    const triggerEventId =
      typeof job.triggerEventId === 'string' ? job.triggerEventId : '';

    let forcedFinishedDate: string | undefined;
    let finishedEventId: string | undefined;

    const triggeredEventId = this.getTriggeredEventId(triggerEventId);
    if (triggeredEventId) {
      const triggeredFixture = await this.espnFixtureModel
        .findOne({ eventId: triggeredEventId, leagueId, season })
        .select({ fixtureDate: 1, season: 1 })
        .lean()
        .exec();
      if (triggeredFixture?.fixtureDate) {
        const fixtureDate = new Date(triggeredFixture.fixtureDate);
        if (!Number.isNaN(fixtureDate.getTime())) {
          finishedEventId = triggeredEventId;
          forcedFinishedDate = this.toDateOnly(fixtureDate);
          dateFrom = forcedFinishedDate;
          dateTo = forcedFinishedDate;
        }
      }
    } else if (triggerEventId.startsWith('WINDOW_EXTEND:')) {
      // Extend coverage one day at a time, using the configured forward horizon.
      const targetDate = this.addLagosCalendarDays(now, forwardDays);
      dateFrom = this.toDateOnly(targetDate);
      dateTo = dateFrom;
    }

    const state = await this.sportsSyncStateService.ensureFixtureRefreshState({
      leagueId,
      season,
      priority,
      dateFrom,
      dateTo,
      trackingMode: 'WINDOW',
      granularity: 'DAY',
    });

    const canonicalStateKey = state.stateKey;

    if (forcedFinishedDate) {
      await this.sportsSyncStateService.resetDateForRefresh(
        canonicalStateKey,
        forcedFinishedDate,
      );
    }

    const incompleteDates =
      await this.sportsSyncStateService.getIncompleteDates(canonicalStateKey);

    // Keep the existing date-level sync ledger, but issue only one ESPN
    // scoreboard request per calendar month. This avoids duplicate monthly
    // requests when several incomplete dates fall in the same month.
    const datesByMonth = new Map<string, string[]>();
    for (const dateKey of incompleteDates) {
      const monthKey = dateKey.slice(0, 7).replace('-', '');
      const dates = datesByMonth.get(monthKey) ?? [];
      dates.push(dateKey);
      datesByMonth.set(monthKey, dates);
    }
    const monthWork = [...datesByMonth.entries()];
    const failures: string[] = [];

    for (
      let index = 0;
      index < monthWork.length;
      index += this.fixtureDayConcurrency
    ) {
      const batch = monthWork.slice(
        index,
        index + this.fixtureDayConcurrency,
      );

      const results = await Promise.allSettled(
        batch.map(([monthKey, dateKeys]) =>
          this.processFixtureMonthForDates(
            canonicalStateKey,
            leagueId,
            monthKey,
            dateKeys,
          ),
        ),
      );

      results.forEach((result, resultIndex) => {
        if (result.status === 'rejected') {
          failures.push(
            `${batch[resultIndex][0]}: ${
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason)
            }`,
          );
        }
      });
    }

    if (failures.length > 0) {
      throw new Error(
        `Fixture refresh still has failed dates for ${leagueId}: ${failures.join(
          '; ',
        )}`,
      );
    }

    await this.sportsSyncStateService.refreshOverallStatus(canonicalStateKey);

    // The final Summary is fetched only after the final scoreboard refresh succeeds.
    if (forcedFinishedDate && finishedEventId) {
      await this.espnQueueBuilderService.queueFinishedSummaryRefresh({
        eventId: finishedEventId,
        leagueId,
        season,
        priority,
      });
    }
  }

  private async processFixtureMonthForDates(
    stateKey: string,
    leagueId: string,
    monthKey: string,
    dateKeys: string[],
  ): Promise<void> {
    try {
      for (const dateKey of dateKeys) {
        await this.sportsSyncStateService.markDateProcessing(stateKey, dateKey);
      }

      const response = await this.espnService.getFixturesForMonth(
        leagueId,
        monthKey,
      );
      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        throw new Error(`ESPN returned an invalid scoreboard envelope for ${leagueId}/${monthKey}`);
      }
      const record = response as unknown as Record<string, unknown>;
      if (!Array.isArray(record.events)) {
        throw new Error(`ESPN scoreboard ${leagueId}/${monthKey} omitted the events array`);
      }
      if (record.events.some((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
        const eventDate = (item as Record<string, unknown>).date;
        return typeof eventDate !== 'string' || !Number.isFinite(new Date(eventDate).getTime());
      })) {
        throw new Error(`ESPN scoreboard ${leagueId}/${monthKey} contained malformed event records`);
      }
      const requestedDates = new Set(dateKeys);
      const events = record.events.filter((item) => {
        const eventDate = (item as Record<string, unknown>).date as string;
        return requestedDates.has(eventDate.slice(0, 10));
      });

      // An empty month/day slice is valid when the database has no inventory
      // for that window. If previously stored fixtures exist there, however,
      // an empty provider slice is not allowed to advance the sync ledger to
      // SUCCESS; retain those rows and let the durable retry re-check ESPN.
      if (events.length === 0 && dateKeys.length > 0) {
        const sortedDates = [...dateKeys].sort();
        const rangeStart = new Date(`${sortedDates[0]}T00:00:00.000Z`);
        const rangeEnd = new Date(`${sortedDates[sortedDates.length - 1]}T00:00:00.000Z`);
        rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 1);
        const existingFixture = await this.espnFixtureModel
          .findOne({
            leagueId: leagueId.trim().toLowerCase(),
            fixtureDate: { $gte: rangeStart, $lt: rangeEnd },
          })
          .select({ eventId: 1 })
          .lean()
          .exec();
        if (existingFixture) {
          throw new Error(
            `ESPN returned no events for ${leagueId}/${monthKey} ` +
              `although stored fixtures exist in ${sortedDates[0]}..${sortedDates[sortedDates.length - 1]}`,
          );
        }
      }

      await this.sportsCollectionService.collectEspnFixtures(leagueId, {
        ...record,
        events,
      });

      for (const dateKey of dateKeys) {
        await this.sportsSyncStateService.markDateSuccess(stateKey, dateKey);
      }
    } catch (error) {
      await Promise.all(
        dateKeys.map((dateKey) =>
          this.sportsSyncStateService.markDateFailed(
            stateKey,
            dateKey,
            error,
          ),
        ),
      );
      throw error;
    }
  }

  // ============================================================
  // SUMMARY REFRESH
  // ============================================================

  private async processSummaryRefresh(
    job: Record<string, unknown>,
  ): Promise<void> {
    if (!job.leagueId || !job.eventId) {
      throw new Error('Summary refresh job requires leagueId and eventId');
    }
    if (typeof job.season !== 'number') {
      throw new Error('Summary refresh job requires season');
    }

    const leagueId = this.stringifyJobId(job.leagueId);
    const season = job.season;
    const eventId = this.stringifyJobId(job.eventId);

    const fixture = await this.espnFixtureModel
      .findOne({ eventId, leagueId, season })
      .select({ eventId: 1, fixtureDate: 1 })
      .lean()
      .exec();

    if (!fixture) {
      throw new Error(
        `Summary refresh fixture ${eventId} not found in sports_espn_fixtures`,
      );
    }

    // Enforce the configured timing contract at execution too. Old durable
    // jobs cannot bypass startup/upcoming lead windows or the +160m post-match
    // checkpoint after a fixture has kicked off.
    const kickoff = fixture.fixtureDate instanceof Date
      ? fixture.fixtureDate
      : new Date(fixture.fixtureDate as string | number);
    if (!Number.isFinite(kickoff.getTime())) {
      throw new Error(`Summary refresh fixture ${eventId} has an invalid kickoff time`);
    }
    const nowMs = Date.now();
    const triggerEventId = String(job.triggerEventId ?? '');
    // Keep recognizing the legacy trigger prefix because pending jobs survive deployments.
    const startupJob =
      triggerEventId.startsWith('STARTUP_SUMMARY:') ||
      triggerEventId.startsWith('STARTUP_SUMMARY_66H:');
    const upcomingDelayMs = SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.upcomingWindowHours * 60 * 60_000;
    const startupDelayMs = SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.startupWindowHours * 60 * 60_000;
    const finishedDelayMs = SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.finishedMatchDelayMinutes * 60_000;
    let eligibleAtMs: number | undefined;
    let deferralReason: string | undefined;
    if (kickoff.getTime() > nowMs) {
      const targetLeadMs = startupJob ? startupDelayMs : upcomingDelayMs;
      eligibleAtMs = kickoff.getTime() - targetLeadMs;
      if (nowMs < eligibleAtMs) {
        deferralReason = startupJob
          ? `Startup Summary is limited to fixtures within ${SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.startupWindowHours} hours of kickoff.`
          : `Upcoming Summary is limited to fixtures within ${SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.upcomingWindowHours} hours of kickoff.`;
      }
    } else {
      eligibleAtMs = kickoff.getTime() + finishedDelayMs;
      if (nowMs < eligibleAtMs) {
        deferralReason = 'Finished-match Summary refresh is due at kickoff + 160 minutes.';
      }
    }

    if (deferralReason && eligibleAtMs !== undefined) {
      const jobId = this.stringifyJobId(job._id);
      if (!jobId) throw new Error(`Cannot defer Summary job without its queue ID: ${eventId}`);
      const scheduledFor = new Date(Math.max(nowMs + 1_000, eligibleAtMs));
      const deferred = await this.espnQueueService.deferProcessingSummaryJob(
        jobId,
        scheduledFor,
      );
      if (!deferred) throw new Error(`Could not defer Summary job ${jobId} to ${scheduledFor.toISOString()}`);
      throw new SummaryJobDeferredError(
        `Deferred Summary ${eventId} until ${scheduledFor.toISOString()}: ${deferralReason}`,
      );
    }

    // Queue insertion prepares/reopens the event unit. Do not infer success
    // from a pre-existing Summary: this job exists specifically to refresh it.
    const stateKey = this.sportsSyncStateService.getQueueStateKey({
      jobType: EspnQueueJobType.SUMMARY_REFRESH,
      leagueId,
      season,
    });

    const summaryStepKey =
      this.sportsSyncStateService.getSummaryStepKey(eventId);

    await this.runTrackedStep(stateKey, summaryStepKey, async () => {
      const summary = await this.espnService.getMatchSummary(leagueId, eventId);
      if (!this.hasUsableSummary(summary)) {
        throw new Error(
          `ESPN returned an empty Summary payload for ${leagueId}/${eventId}`,
        );
      }

      await this.sportsCollectionService.collectEspnMatchSummary({
        leagueId,
        eventId,
        summary,
      });
    });

    await this.sportsSyncStateService.refreshOverallStatus(stateKey);
    this.logger.log('ESPN Summary refresh succeeded');
  }

  // ============================================================
  // YOUTUBE HIGHLIGHT
  // ============================================================

  private async processYoutubeHighlight(
    job: Record<string, unknown>,
  ): Promise<void> {
    if (!job.leagueId || !job.eventId) {
      throw new Error('YouTube highlight job requires leagueId and eventId');
    }
    if (typeof job.season !== 'number') {
      throw new Error('YouTube highlight job requires season');
    }

    const eventId = this.stringifyJobId(job.eventId);
    const leagueId = this.stringifyJobId(job.leagueId);
    const season = job.season;

    // Revalidate durable jobs before spending provider quota. A fixture remains
    // eligible through its 24-hour post-kickoff window regardless of calendar day.
    const eligible =
      await this.espnQueueBuilderService.isYoutubeHighlightEligible({
        eventId,
        leagueId,
        season,
      });
    if (!eligible) {
      this.logger.debug(
        `Skipping ineligible YouTube highlight job ${leagueId}/${eventId}`,
      );
      return;
    }

    const { homeTeam, awayTeam } = await this.getYoutubeFixtureTeamNames(
      eventId,
      leagueId,
      season,
    );
    const plan = getYoutubeHighlightSearchPlan(leagueId, homeTeam, awayTeam);
    const stageTrigger =
      typeof job.triggerEventId === 'string' ? job.triggerEventId : '';
    const stageMatch = stageTrigger.match(/^YOUTUBE_ATTEMPT:(\d+)$/);
    const attemptNumber = stageMatch ? Number(stageMatch[1]) : 1;
    const maximumAttempts = Math.min(
      YOUTUBE_CONFIG.searchWorkflow.maximumRequestsPerFixture,
      plan.length,
    );

    if (
      !Number.isInteger(attemptNumber) ||
      attemptNumber < 1 ||
      attemptNumber > maximumAttempts
    ) {
      this.logger.warn(
        `Stopping invalid/exhausted YouTube stage for ${leagueId}/${eventId}: attempt=${attemptNumber}, maximum=${maximumAttempts}`,
      );
      return;
    }

    const channelId = plan[attemptNumber - 1];
    if (channelId === undefined) {
      this.logger.warn(
        `No search stage is configured for ${leagueId}/${eventId}; ending the search sequence`,
      );
      return;
    }

    this.logger.log(
      `YouTube highlight search ${attemptNumber}/${maximumAttempts} for ${leagueId}/${eventId} using ${channelId ?? 'a broad channel-unrestricted search'}`,
    );

    let outcome: Awaited<ReturnType<YoutubeHighlightService['processFixture']>>;
    try {
      // One persisted queue stage performs exactly one YouTube search request.
      outcome = await this.youtubeHighlightService.processFixture(
        eventId,
        typeof job.competitionId === 'string' ? job.competitionId : undefined,
        channelId ?? undefined,
      );
    } catch (error) {
      if (
        error instanceof SportsProviderQuotaExceededError &&
        error.provider === 'youtube'
      ) {
        this.logger.warn(
          `YouTube ${error.period} quota exhausted; stopping all new highlight searches until the quota period resets`,
        );
        return;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('YouTube API request failed:')) {
        // Count an API failure as this stage's one request and move forward;
        // never replay the same stage, because the provider may have received it.
        this.logger.warn(
          `YouTube API request failed on attempt ${attemptNumber}/${maximumAttempts} for ${leagueId}/${eventId}; moving to the next bounded stage: ${errorMessage}`,
        );
        await this.scheduleNextYoutubeAttempt({
          leagueId,
          eventId,
          season,
          priority:
            Number.isFinite(Number(job.priority)) && Number(job.priority) >= 1
              ? Number(job.priority)
              : 4,
          attemptNumber,
          maximumAttempts,
          plan,
        });
        return;
      }

      throw error;
    }

    if (outcome === 'FOUND') {
      this.logger.log(
        `YouTube highlight found for ${leagueId}/${eventId} on attempt ${attemptNumber}/${maximumAttempts}`,
      );
      return;
    }

    if (outcome === 'SKIPPED' || outcome === 'QUOTA_EXHAUSTED') {
      if (outcome === 'QUOTA_EXHAUSTED') {
        this.logger.warn(
          `YouTube daily quota is exhausted; stopping highlight searches until the quota period resets`,
        );
      }
      return;
    }

    if (attemptNumber >= maximumAttempts) {
      this.logger.warn(
        `YouTube highlight search ended for ${leagueId}/${eventId}: no suitable highlight after ${attemptNumber} request(s)`,
      );
      return;
    }

    await this.scheduleNextYoutubeAttempt({
      leagueId,
      eventId,
      season,
      priority:
        Number.isFinite(Number(job.priority)) && Number(job.priority) >= 1
          ? Number(job.priority)
          : 4,
      attemptNumber,
      maximumAttempts,
      plan,
    });
  }

  private async getYoutubeFixtureTeamNames(
    eventId: string,
    leagueId: string,
    season: number,
  ): Promise<{ homeTeam?: string; awayTeam?: string }> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId, leagueId, season })
      .select({ payload: 1 })
      .lean()
      .exec();
    if (!fixture?.payload || typeof fixture.payload !== 'object') return {};

    const asRecord = (value: unknown): Record<string, unknown> | undefined =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    const payload = asRecord(fixture.payload);
    if (!payload) return {};
    const event = asRecord(payload['event']) ?? payload;
    const competitionsValue = event['competitions'] ?? payload['competitions'];
    const competitions = Array.isArray(competitionsValue) ? competitionsValue : [];
    const competition = competitions.map(asRecord).find(Boolean);
    const competitorsValue = competition?.['competitors'];
    const competitors = Array.isArray(competitorsValue)
      ? competitorsValue.map(asRecord).filter(Boolean)
      : [];
    if (competitors.length < 2) return {};

    const home =
      competitors.find((competitor) =>
        competitor?.['homeAway'] === 'home' || competitor?.['isHome'] === true,
      ) ?? competitors[0];
    const away =
      competitors.find((competitor) =>
        competitor?.['homeAway'] === 'away' || competitor?.['isAway'] === true,
      ) ?? competitors.find((competitor) => competitor !== home);

    const getTeamName = (competitor: Record<string, unknown> | undefined): string | undefined => {
      const team = asRecord(competitor?.['team']) ?? competitor;
      const values = [team?.['displayName'], team?.['shortDisplayName'], team?.['name']];
      return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim();
    };

    return { homeTeam: getTeamName(home), awayTeam: getTeamName(away) };
  }

  private async scheduleNextYoutubeAttempt(params: {
    leagueId: string;
    eventId: string;
    season: number;
    priority: number;
    attemptNumber: number;
    maximumAttempts: number;
    plan: readonly (string | null)[];
  }): Promise<void> {
    if (params.attemptNumber >= params.maximumAttempts) {
      this.logger.warn(
        `YouTube highlight search ended for ${params.leagueId}/${params.eventId} after ${params.attemptNumber} request(s); no more attempts are allowed`,
      );
      return;
    }

    const nextAttempt = params.attemptNumber + 1;
    const getScheduledFor = Reflect.get(
      this.espnQueueBuilderService,
      'getYoutubeHighlightAttemptScheduledFor',
    ) as (args: {
      eventId: string;
      leagueId: string;
      season: number;
      attemptNumber: number;
    }) => Promise<Date | undefined>;
    const scheduledFor = await Reflect.apply(
      getScheduledFor,
      this.espnQueueBuilderService,
      [
        {
          eventId: params.eventId,
          leagueId: params.leagueId,
          season: params.season,
          attemptNumber: nextAttempt,
        },
      ],
    );
    if (!scheduledFor) {
      this.logger.warn(
        `YouTube highlight retry window expired for ${params.leagueId}/${params.eventId}; attempt ${nextAttempt} will not be queued`,
      );
      return;
    }

    // Attempt-specific durable keys let each configured stage be recovered
    // independently without duplicating a search request.
    const addYoutubeHighlightJob = Reflect.get(
      this.espnQueueService,
      'addYoutubeHighlightJob',
    ) as (args: {
      leagueId: string;
      eventId: string;
      season: number;
      priority: number;
      scheduledFor: Date;
      triggerEventId: string;
    }) => Promise<unknown>;
    await Reflect.apply(addYoutubeHighlightJob, this.espnQueueService, [
      {
        leagueId: params.leagueId,
        eventId: params.eventId,
        season: params.season,
        priority: params.priority,
        scheduledFor,
        triggerEventId: `YOUTUBE_ATTEMPT:${nextAttempt}`,
      },
    ]);

    const nextChannel = params.plan[nextAttempt - 1];
    this.logger.warn(
      `Scheduled YouTube highlight attempt ${nextAttempt}/${params.maximumAttempts} for ${params.leagueId}/${params.eventId} on ${nextChannel ?? 'a broad channel-unrestricted search'} at ${scheduledFor.toISOString()}`,
    );
  }

  private hasUsableSummary(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const knownSections = new Set([
      'header', 'event', 'competitions', 'boxscore', 'plays', 'leaders',
      'team', 'teams', 'rosters', 'roster', 'injuries', 'standings', 'odds',
      'pickcenter', 'news', 'videos', 'articles', 'gameInfo', 'format',
      'broadcasts', 'predictor', 'againstTheSpread', 'winprobability',
      'drives', 'scoringPlays', 'statistics', 'headToHead', 'venue',
      'weather', 'rankings', 'situation', 'commentary', 'recent', 'previews',
    ]);
    return Object.entries(record).some(([key, section]) => {
      if (!knownSections.has(key) || section === null || section === undefined) return false;
      if (Array.isArray(section)) return section.length > 0;
      if (typeof section === 'object') return Object.keys(section as Record<string, unknown>).length > 0;
      if (typeof section === 'string') return section.trim().length > 0;
      return typeof section === 'number' || typeof section === 'boolean';
    });
  }

  // ============================================================
  // TRACKED STEP EXECUTION
  // ============================================================

  private async runTrackedStep(
    stateKey: string,
    stepKey: string,
    action: () => Promise<void>,
  ): Promise<void> {
    const successful = await this.sportsSyncStateService.isUnitSuccessful(
      stateKey,
      `STEP:${stepKey}`,
    );

    if (successful) {
      return;
    }

    await this.sportsSyncStateService.markStepProcessing(stateKey, stepKey);

    try {
      await action();

      await this.sportsSyncStateService.markStepSuccess(stateKey, stepKey);
      await this.sportsSyncStateService.refreshOverallStatus(stateKey);
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'StandingsUnavailableError'
      ) {
        await this.sportsSyncStateService.markStepUnavailable(
          stateKey,
          stepKey,
          error.message,
        );
        await this.sportsSyncStateService
          .refreshOverallStatus(stateKey)
          .catch(() => undefined);
        this.logger.warn(
          `ESPN sync step terminal outcome UNAVAILABLE: state=${stateKey}, step=${stepKey}, reason=${error.message}`,
        );
        return;
      }

      await this.sportsSyncStateService.markStepFailed(
        stateKey,
        stepKey,
        error,
      );
      await this.sportsSyncStateService
        .refreshOverallStatus(stateKey)
        .catch(() => undefined);

      throw error;
    }
  }

  private async wait(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(1_000, milliseconds));
    });
  }

  // ============================================================
  // STATE KEY
  // ============================================================

  private getStateKeyFromJob(job: Record<string, unknown>): string {
    if (!job.type) {
      throw new Error('Queue job has no type');
    }

    if (!job.leagueId) {
      throw new Error('Queue job has no leagueId');
    }

    return this.sportsSyncStateService.getQueueStateKey({
      jobType: this.stringifyJobId(job.type),

      leagueId: this.stringifyJobId(job.leagueId),

      season: typeof job.season === 'number' ? job.season : undefined,

      eventId: job.eventId ? this.stringifyJobId(job.eventId) : undefined,

      triggerEventId: job.triggerEventId
        ? this.stringifyJobId(job.triggerEventId)
        : undefined,

      queueJobKey: job.jobKey ? this.stringifyJobId(job.jobKey) : undefined,
    });
  }

  // ============================================================
  // DATE HELPERS
  // ============================================================

  private toDateOnly(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Lagos',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const values = new Map(parts.map((part) => [part.type, part.value]));
    return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
  }

  private addLagosCalendarDays(date: Date, days: number): Date {
    const calendarDate = new Date(`${this.toDateOnly(date)}T00:00:00Z`);
    calendarDate.setUTCDate(calendarDate.getUTCDate() + days);
    const dateKey = calendarDate.toISOString().slice(0, 10);
    return new Date(`${dateKey}T00:00:00+01:00`);
  }

  // ============================================================
  // JOB ID
  // ============================================================

  private stringifyJobId(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }

    if (value && typeof value === 'object') {
      const objectValue = value as Record<string, unknown>;

      if (typeof objectValue['$oid'] === 'string') {
        return objectValue['$oid'];
      }

      if (typeof objectValue['toHexString'] === 'function') {
        return (objectValue['toHexString'] as () => string)();
      }

      const stringValue = Reflect.get(objectValue, 'toString');

      if (
        typeof stringValue === 'function' &&
        stringValue !== Object.prototype.toString
      ) {
        const result = Reflect.apply(stringValue, value, []) as unknown;

        if (typeof result === 'string') {
          return result;
        }
      }
    }

    throw new Error('Job ID must be a string, number, or identifiable object');
  }

  private safeJobString(value: unknown, fallback = ''): string {
    if (value === undefined || value === null) return fallback;
    try {
      return this.stringifyJobId(value);
    } catch {
      return fallback;
    }
  }
}
