// backend/src/sports/services/espn-queue-worker.service.ts

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

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
  EspnQueueLane,
} from '../interfaces/espn-queue.interface';
import { SPORTS_DATA_COLLECTION_CONFIG } from '../config/sports-data-collection.config';
import { YOUTUBE_CONFIG } from '../config/youtube.config';
import { getEspnStandingsPolicy } from '../config/priority-competitions.config';
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

type QueueWorkerLane = EspnQueueLane.NORMAL | EspnQueueLane.BACKGROUND_RETRY;

interface ActiveQueueJob {
  key: string;
  type: string;
  startedAt: number;
  lane: QueueWorkerLane;
  scopeKey?: string;
}

class SummaryJobDeferredError extends Error {
  readonly summaryJobDeferred = true;
}

@Injectable()
export class EspnQueueWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EspnQueueWorkerService.name);
  private workerStarted = false;
  private youtubeQueuePrepared = false;
  private draining = false;
  private pumping = false;
  private wakeRequested = false;
  private readonly activeSlots: Record<QueueWorkerLane, number> = {
    [EspnQueueLane.NORMAL]: 0,
    [EspnQueueLane.BACKGROUND_RETRY]: 0,
  };
  private readonly activeJobs = new Map<string, ActiveQueueJob>();
  private readonly laneNoWork = new Set<string>();
  private readonly workloadNoWork = new Set<EspnQueueJobType>();
  private readonly activeWorkloads = new Map<EspnQueueJobType, number>();
  private dispatchCursor = 0;
  private startupRetryFirst = false;
  private readonly startupIdleSleepMs = 30_000;
  private readonly workloadOrder: EspnQueueJobType[] = [
    EspnQueueJobType.FIXTURE_REFRESH,
    EspnQueueJobType.SUMMARY_REFRESH,
    EspnQueueJobType.STANDINGS_REFRESH,
    EspnQueueJobType.LEAGUE_CATALOGUE_REFRESH,
    EspnQueueJobType.LEAGUE_DETAIL_REFRESH,
    EspnQueueJobType.YOUTUBE_HIGHLIGHT,
  ];
  private readonly workerInstanceId = `sports-${process.pid}-${randomUUID()}`;
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

  private get fixtureDayConcurrency(): number {
    const fixtures = SPORTS_DATA_COLLECTION_CONFIG.ESPN.fixtures as unknown as {
      readonly dayConcurrency?: unknown;
    };
    const value = fixtures.dayConcurrency;
    return typeof value === 'number' && Number.isFinite(value) ? value : 1;
  }

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
      waitingForStartupRelease:
        this.initialized && !this.workerStarted && !this.everStarted,
      youtubeQueuePrepared: this.youtubeQueuePrepared,
      draining: this.draining,
      activeJobKey: this.activeJobKey,
      activeJobType: this.activeJobType,
      activeJobAgeMs: this.activeJobStartedAt
        ? Math.max(0, Date.now() - this.activeJobStartedAt)
        : undefined,
      activeJobCount: this.activeJobs.size,
      normalJobsActive: this.activeSlots[EspnQueueLane.NORMAL],
      retryJobsActive: this.activeSlots[EspnQueueLane.BACKGROUND_RETRY],
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

  private refreshActiveRuntime(): void {
    const active = [...this.activeJobs.values()].sort(
      (left, right) => right.startedAt - left.startedAt,
    );
    const current = active[0];
    this.activeJobKey = current?.key;
    this.activeJobType = current?.type;
    this.activeJobStartedAt = current?.startedAt;
    this.draining = this.pumping || this.activeJobs.size > 0;
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
          message: 'ESPN queue and background-retry workers are running.',
          details: {
            activeJobs:
              this.activeSlots[EspnQueueLane.NORMAL] +
              this.activeSlots[EspnQueueLane.BACKGROUND_RETRY],
            normalJobs: this.activeSlots[EspnQueueLane.NORMAL],
            retryJobs: this.activeSlots[EspnQueueLane.BACKGROUND_RETRY],
            queueReadFailures: this.queueReadFailures,
          },
        });

        // Recovery maintenance is independent of whether jobs are currently
        // executing. Renewed leases protect healthy work from being reclaimed.
        const orphaned = await this.espnQueueService.recoverOrphanedFailedJobs(
          36500,
          100,
        );
        if (orphaned > 0) {
          this.logger.warn(
            `Background retry lane adopted ${orphaned} legacy failed job(s)`,
          );
        }
        const recovered = await this.espnQueueService.recoverStaleJobs(
          SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.leaseMinutes,
        );
        if (recovered > 0) {
          this.logger.warn(
            `Background recovery reclaimed ${recovered} expired job lease(s)`,
          );
        }

        for (const active of this.activeJobs.values()) {
          const activeForMs = Date.now() - active.startedAt;
          if (
            activeForMs >= 5 * 60_000 &&
            Date.now() - this.lastLongJobWarningAt >= 5 * 60_000
          ) {
            this.lastLongJobWarningAt = Date.now();
            this.logger.warn(
              `ESPN job exceeded the five-minute execution target: ${active.key} (${Math.round(activeForMs / 60_000)}m). Its lease remains protected by heartbeat renewal.`,
            );
            break;
          }
        }

        const nextAt = await this.espnQueueService.getNextWakeAt();
        const slotsUsed =
          this.activeSlots[EspnQueueLane.NORMAL] +
          this.activeSlots[EspnQueueLane.BACKGROUND_RETRY];
        if (
          slotsUsed <
            SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.maxConcurrentJobs &&
          nextAt &&
          nextAt.getTime() <= Date.now()
        ) {
          this.wake(0);
        } else if (Date.now() - this.lastWatchdogReportAt >= 10 * 60_000) {
          this.lastWatchdogReportAt = Date.now();
          this.logger.log(
            nextAt
              ? `Sports queue heartbeat: active=${slotsUsed}, nextDue=${nextAt.toISOString()}`
              : `Sports queue heartbeat: active=${slotsUsed}, no scheduled work waiting`,
          );
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
        `Sports queue watchdog could not inspect durable work: ${message}`,
      );
      this.wake(this.queueReadRetryMs);
    } finally {
      this.scheduleWatchdog();
    }
  }

  /** New durable work wakes the pump immediately; delayed retries sleep until due. */
  private wake(delayMs = 0, resetLaneAvailability = true): void {
    if (!this.workerStarted) return;
    if (resetLaneAvailability) {
      this.laneNoWork.clear();
      this.workloadNoWork.clear();
    }
    if (this.pumping) {
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

  private getJobTypesForWorkload(
    workload: EspnQueueJobType,
  ): EspnQueueJobType[] {
    if (workload === EspnQueueJobType.FIXTURE_REFRESH) {
      return [
        EspnQueueJobType.FIXTURE_REFRESH,
        EspnQueueJobType.SEASON_FIXTURE_BOOTSTRAP,
      ];
    }
    return [workload];
  }

  private getWorkloadConcurrency(workload: EspnQueueJobType): number {
    const configured = (
      SPORTS_DATA_COLLECTION_CONFIG as unknown as {
        ESPN: {
          workloadConcurrency: {
            fixtures: number;
            summaries: number;
            standings: number;
            leagueCatalogue: number;
            leagueDetails: number;
            youtube: number;
          };
        };
      }
    ).ESPN.workloadConcurrency;
    switch (workload) {
      case EspnQueueJobType.FIXTURE_REFRESH:
        return configured.fixtures;
      case EspnQueueJobType.SUMMARY_REFRESH:
        return configured.summaries;
      case EspnQueueJobType.STANDINGS_REFRESH:
        return configured.standings;
      case EspnQueueJobType.LEAGUE_CATALOGUE_REFRESH:
        return configured.leagueCatalogue;
      case EspnQueueJobType.LEAGUE_DETAIL_REFRESH:
        return configured.leagueDetails;
      case EspnQueueJobType.YOUTUBE_HIGHLIGHT:
        return configured.youtube;
      default:
        return 1;
    }
  }

  private getWorkloadLaneKey(
    workload: EspnQueueJobType,
    lane: QueueWorkerLane,
  ): string {
    return `${workload}:${lane}`;
  }

  /**
   * Round-robin selection gives each workload its own slot and prevents a
   * continuously busy fixture lane from starving Summary, standings or the
   * league endpoints. The global cap remains a memory safety boundary.
   */
  private chooseNextWorkload(): EspnQueueJobType | undefined {
    const totalActive = [...this.activeWorkloads.values()].reduce(
      (total, value) => total + value,
      0,
    );
    if (
      totalActive >= SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.maxConcurrentJobs
    ) {
      return undefined;
    }

    const count = this.workloadOrder.length;
    for (let offset = 0; offset < count; offset += 1) {
      const index = (this.dispatchCursor + offset) % count;
      const workload = this.workloadOrder[index];
      if (
        workload === EspnQueueJobType.YOUTUBE_HIGHLIGHT &&
        !this.youtubeQueuePrepared
      ) {
        continue;
      }
      const active = this.activeWorkloads.get(workload) ?? 0;
      if (active >= this.getWorkloadConcurrency(workload)) continue;
      if (this.workloadNoWork.has(workload)) continue;

      this.dispatchCursor = (index + 1) % count;
      return workload;
    }

    return undefined;
  }

  private async processNextWorkloadJob(
    workload: EspnQueueJobType,
  ): Promise<boolean> {
    const jobTypes = this.getJobTypesForWorkload(workload);
    const firstLane = this.startupRetryFirst
      ? EspnQueueLane.BACKGROUND_RETRY
      : EspnQueueLane.NORMAL;
    this.startupRetryFirst = !this.startupRetryFirst;
    const secondLane =
      firstLane === EspnQueueLane.NORMAL
        ? EspnQueueLane.BACKGROUND_RETRY
        : EspnQueueLane.NORMAL;

    for (const lane of [firstLane, secondLane] as QueueWorkerLane[]) {
      const laneKey = this.getWorkloadLaneKey(workload, lane);
      if (this.laneNoWork.has(laneKey)) continue;
      const processed = await this.processNextJob({ jobTypes, lane });
      if (processed) {
        this.workloadNoWork.delete(workload);
        this.laneNoWork.delete(laneKey);
        return true;
      }
    }

    this.workloadNoWork.add(workload);
    return false;
  }

  private async drainQueue(): Promise<void> {
    if (this.pumping || !this.workerStarted) return;
    if (!this.espnQueueService.isNormalOperationsReady()) return;

    this.pumping = true;
    this.wakeRequested = false;
    this.drainCycles += 1;
    this.lastDrainStartedAt = new Date();
    try {
      if (!this.recoveryAttempted) {
        this.recoveryAttempted = true;
        const [stale, orphaned] = await Promise.all([
          this.espnQueueService.recoverStaleJobs(
            SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.leaseMinutes,
          ),
          this.espnQueueService.recoverOrphanedFailedJobs(36500, 50),
        ]);
        if (stale || orphaned) {
          this.logger.warn(
            `Initial queue recovery completed: expiredLeases=${stale}, legacyFailures=${orphaned}`,
          );
        }
      }

      let launched = 0;
      while (
        launched < SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.maxConcurrentJobs
      ) {
        const workload = this.chooseNextWorkload();
        if (!workload) break;

        this.activeWorkloads.set(
          workload,
          (this.activeWorkloads.get(workload) ?? 0) + 1,
        );
        launched += 1;

        void this.processNextWorkloadJob(workload)
          .then((processed) => {
            if (!processed) this.workloadNoWork.add(workload);
          })
          .catch((error) => {
            const message =
              error instanceof Error ? error.message : String(error);
            this.drainFailures += 1;
            this.systemMonitor.reportModuleHealth('sports', 'DEGRADED', {
              source: 'queue-worker',
              message,
              details: { workload },
            });
            this.logger.error(
              `Queue workload failed (${workload}): ${message}`,
            );
          })
          .finally(() => {
            const active = Math.max(
              0,
              (this.activeWorkloads.get(workload) ?? 1) - 1,
            );
            if (active === 0) this.activeWorkloads.delete(workload);
            else this.activeWorkloads.set(workload, active);
            this.refreshActiveRuntime();
            this.wake(0, false);
          });
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
        operation: 'pump-queue',
        message,
        occurredAt: new Date(),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.logger.error(`Sports queue pump failed: ${message}`);
    } finally {
      this.pumping = false;
      this.lastDrainCompletedAt = new Date();
      this.refreshActiveRuntime();
      if (this.wakeRequested) {
        this.wakeRequested = false;
        this.wake(0, false);
      } else {
        const activeDispatches = [...this.activeWorkloads.values()].reduce(
          (total, value) => total + value,
          0,
        );
        if (
          activeDispatches <
          SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.maxConcurrentJobs
        ) {
          try {
            const nextAt = await this.espnQueueService.getNextWakeAt();
            if (nextAt)
              this.wake(Math.max(0, nextAt.getTime() - Date.now()), true);
            this.queueReadFailures = 0;
          } catch (error) {
            this.queueReadFailures += 1;
            this.logger.warn(
              `Could not determine the next durable queue wake-up (failures=${this.queueReadFailures}); retrying in ${this.queueReadRetryMs / 1000}s: ${error instanceof Error ? error.message : String(error)}`,
            );
            this.wake(this.queueReadRetryMs, false);
          }
        }
      }
    }
  }

  private async sleep(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.max(250, milliseconds)),
    );
  }

  private async runStartupQueueWorkload(
    jobType: EspnQueueJobType,
    triggerEventIdPrefix: string,
    isComplete: () => Promise<boolean>,
  ): Promise<void> {
    let lastProgressLogAt = 0;
    const concurrency = Math.max(
      1,
      Math.min(
        this.getWorkloadConcurrency(jobType),
        SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.maxConcurrentJobs,
      ),
    );

    while (!(await isComplete())) {
      const firstLanes = Array.from({ length: concurrency }, () => {
        const first = this.startupRetryFirst
          ? EspnQueueLane.BACKGROUND_RETRY
          : EspnQueueLane.NORMAL;
        this.startupRetryFirst = !this.startupRetryFirst;
        return first;
      });

      const results = await Promise.all(
        firstLanes.map(async (firstLane) => {
          const secondLane =
            firstLane === EspnQueueLane.NORMAL
              ? EspnQueueLane.BACKGROUND_RETRY
              : EspnQueueLane.NORMAL;
          let processed = await this.processNextJob({
            jobTypes: [jobType],
            triggerEventIdPrefix,
            lane: firstLane,
          });
          if (!processed) {
            processed = await this.processNextJob({
              jobTypes: [jobType],
              triggerEventIdPrefix,
              lane: secondLane,
            });
          }
          return processed;
        }),
      );

      if (results.some(Boolean)) continue;

      const now = Date.now();
      if (now - lastProgressLogAt >= 5 * 60_000) {
        lastProgressLogAt = now;
        const quarantined =
          await this.espnQueueService.countQuarantinedWorkloadJobs({
            jobType,
            triggerEventIdPrefix,
          });
        this.logger.warn(
          `Startup ${jobType} remains incomplete; no due job is currently runnable. quarantined=${quarantined}. The startup gate remains closed.`,
        );
      }

      const nextAt = await this.espnQueueService.getNextWakeAtForWorkload({
        jobType,
        triggerEventIdPrefix,
      });
      const waitMs = nextAt
        ? Math.max(
            1_000,
            Math.min(this.startupIdleSleepMs, nextAt.getTime() - Date.now()),
          )
        : this.startupIdleSleepMs;
      await this.sleep(waitMs);
    }
  }

  /**
   * Executes only startup-seeded standings jobs while normal queue consumers
   * remain gated. Failed or quarantined required standings continue to block
   * release; only an explicitly unsupported format is considered complete.
   */
  async runStartupStandingsPhase(
    contexts: Array<{
      leagueId: string;
      season: number;
      standingsStateKey: string;
    }>,
  ): Promise<{ succeeded: number; failed: number; unavailable: number }> {
    const required = contexts.filter(
      (context) => getEspnStandingsPolicy(context.leagueId) !== 'NONE',
    );
    const unavailable = contexts.length - required.length;

    const isComplete = async (): Promise<boolean> => {
      for (const context of required) {
        const successful = await this.sportsSyncStateService.isUnitSuccessful(
          context.standingsStateKey,
          'STEP:STANDINGS_INITIAL',
        );
        if (!successful) return false;
        const assertStartupCollectionVerified = (
          this.espnStandingsService as {
            assertStartupCollectionVerified: (
              leagueId: string,
              season: number,
            ) => Promise<void>;
          }
        ).assertStartupCollectionVerified;
        await assertStartupCollectionVerified.call(
          this.espnStandingsService,
          context.leagueId,
          context.season,
        );
      }
      return true;
    };

    await this.runStartupQueueWorkload(
      EspnQueueJobType.STANDINGS_REFRESH,
      'STARTUP_STANDINGS',
      isComplete,
    );

    return { succeeded: required.length, failed: 0, unavailable };
  }

  /**
   * Processes the bounded startup Summary scope through the same durable queue
   * and handler used in normal operation. Completion is established from the
   * actual fixture documents, not merely from successful queue records.
   */
  async runStartupSummaryPhase(
    contexts: Array<{
      leagueId: string;
      season: number;
      summaryStateKey: string;
      kickoffWindowStart: Date;
      kickoffWindowEnd: Date;
      missingAtStart: number;
    }>,
  ): Promise<{ succeeded: number; failed: number }> {
    const succeeded = contexts.reduce(
      (total, context) => total + context.missingAtStart,
      0,
    );

    const isComplete = async (): Promise<boolean> => {
      for (const context of contexts) {
        const missing: number = await (
          this.sportsSyncStateService as {
            countMissingSummaryFixtures: (params: {
              leagueId: string;
              season: number;
              kickoffWindowStart: Date;
              kickoffWindowEnd: Date;
            }) => Promise<number>;
          }
        ).countMissingSummaryFixtures({
          leagueId: context.leagueId,
          season: context.season,
          kickoffWindowStart: context.kickoffWindowStart,
          kickoffWindowEnd: context.kickoffWindowEnd,
        });
        if (missing > 0) return false;
      }
      return true;
    };

    await this.runStartupQueueWorkload(
      EspnQueueJobType.SUMMARY_REFRESH,
      'STARTUP_SUMMARY:',
      isComplete,
    );

    return { succeeded, failed: 0 };
  }

  // ============================================================
  // JOB EXECUTION
  // ============================================================

  /**
   * Jobs that mutate one shared synchronization ledger are serialized by
   * logical scope. This is a process-local guard; the deployed worker should
   * remain a single NestJS process unless a distributed scope lease is added.
   */
  private getSerializedJobScope(
    job: Record<string, unknown>,
  ): string | undefined {
    const type = job.type as EspnQueueJobType;
    const leagueId = job.leagueId ? this.stringifyJobId(job.leagueId) : '';
    const season = typeof job.season === 'number' ? job.season : undefined;
    if (!leagueId || season === undefined) return undefined;

    if (
      type === EspnQueueJobType.FIXTURE_REFRESH ||
      type === EspnQueueJobType.SEASON_FIXTURE_BOOTSTRAP
    ) {
      return `FIXTURE:${leagueId}:${season}`;
    }
    if (type === EspnQueueJobType.STANDINGS_REFRESH) {
      return `STANDINGS:${leagueId}:${season}`;
    }
    if (type === EspnQueueJobType.SUMMARY_REFRESH) {
      const eventId = job.eventId ? this.stringifyJobId(job.eventId) : '';
      return eventId ? `SUMMARY:${leagueId}:${season}:${eventId}` : undefined;
    }
    return undefined;
  }

  private async processNextJob(params?: {
    jobTypes?: EspnQueueJobType[];
    includeFailed?: boolean;
    triggerEventIdPrefix?: string;
    leagueId?: string;
    season?: number;
    eventId?: string;
    lane?: QueueWorkerLane;
  }): Promise<boolean> {
    const claimId = `${this.workerInstanceId}:${randomUUID()}`;
    const leaseMs =
      SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.leaseMinutes * 60_000;
    const job = await this.espnQueueService.getNextJob({
      ...params,
      workerId: claimId,
      leaseMs,
    });

    if (!job) {
      if (params?.lane && params.jobTypes?.[0]) {
        this.laneNoWork.add(
          this.getWorkloadLaneKey(params.jobTypes[0], params.lane),
        );
      }
      return false;
    }

    const queueJob = job as unknown as Record<string, unknown>;
    const jobId = this.stringifyJobId(queueJob._id);
    const jobKey = this.safeJobString(
      queueJob.jobKey ?? queueJob._id,
      'unknown',
    );
    const jobType = this.safeJobString(queueJob.type, 'unknown');
    const startedAt = Date.now();
    const lane =
      params?.lane ??
      (queueJob.lane === EspnQueueLane.BACKGROUND_RETRY
        ? EspnQueueLane.BACKGROUND_RETRY
        : EspnQueueLane.NORMAL);
    const scopeKey = this.getSerializedJobScope(queueJob);
    if (
      scopeKey &&
      [...this.activeJobs.values()].some(
        (active) => active.scopeKey === scopeKey,
      )
    ) {
      // Fixture jobs rewrite a shared date-unit array and standings jobs update
      // shared league-season state. Do not run two such mutations concurrently.
      // Summary jobs are serialized only per event; different events may run
      // concurrently within the configured per-workload and global caps.
      await this.espnQueueService.deferClaimedJob(
        jobId,
        claimId,
        new Date(Date.now() + 30_000),
        lane,
      );
      return true;
    }
    if (params?.jobTypes?.[0]) {
      this.laneNoWork.delete(this.getWorkloadLaneKey(params.jobTypes[0], lane));
      this.workloadNoWork.delete(params.jobTypes[0]);
    }
    this.activeSlots[lane] += 1;
    this.activeJobs.set(jobId, {
      key: jobKey,
      type: jobType,
      startedAt,
      lane,
      scopeKey,
    });
    this.refreshActiveRuntime();
    this.logger.debug(
      `Processing ${lane} ESPN queue job ${jobKey} (${jobType})`,
    );

    const heartbeat = setInterval(() => {
      void this.espnQueueService
        .renewJobLease(jobId, claimId, leaseMs)
        .then((renewed) => {
          if (!renewed)
            this.logger.warn(
              `Queue job lease ownership changed while job was running: ${jobKey}`,
            );
        })
        .catch((error) => {
          this.logger.warn(
            `Could not renew queue job lease ${jobKey}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }, SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.heartbeatSeconds * 1000);
    heartbeat.unref?.();

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
      if (!(await this.espnQueueService.ownsProcessingJob(jobId, claimId))) {
        this.logger.warn(
          `Job ${jobKey} lost its processing lease before completion; the newer owner will reconcile it.`,
        );
        return true;
      }
      await this.afterSuccessfulJob(queueJob);
      const completed = await this.espnQueueService.markCompleted(
        jobId,
        claimId,
      );
      if (!completed) {
        this.logger.warn(
          `Job ${jobKey} could not be acknowledged because its processing lease changed.`,
        );
        return true;
      }
      this.jobsSucceeded += 1;
      this.lastJobAt = new Date();
      this.lastJobType = jobType;
      this.lastJobStatus = 'SUCCEEDED';
      this.lastJobDurationMs = Date.now() - startedAt;
      this.lastJobError = undefined;
    } catch (error) {
      if (
        error instanceof SummaryJobDeferredError ||
        (error &&
          typeof error === 'object' &&
          (error as { summaryJobDeferred?: unknown }).summaryJobDeferred ===
            true)
      ) {
        this.logger.debug(
          error instanceof Error
            ? error.message
            : 'Deferred Summary job outside its active timing window.',
        );
        this.lastJobAt = new Date();
        this.lastJobType = jobType;
        this.lastJobStatus = 'DEFERRED';
        this.lastJobDurationMs = Date.now() - startedAt;
        // The job has already been returned to PENDING at its contract-compliant
        // time. Do not mark it failed or count this as a provider attempt.
        return true;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.jobsFailed += 1;
      this.lastJobAt = new Date();
      this.lastJobType = jobType;
      this.lastJobStatus = 'FAILED';
      this.lastJobDurationMs = Date.now() - startedAt;
      this.lastJobError = message;

      const isExpectedYoutubeMiss =
        queueJob.type === EspnQueueJobType.YOUTUBE_HIGHLIGHT &&
        message.startsWith('No suitable YouTube highlight found');

      if (isExpectedYoutubeMiss) {
        this.logger.debug(
          `No YouTube highlight found for ${jobKey}; bounded search workflow evaluated.`,
        );
      } else {
        // Retries are intentionally quiet: individual transient failures are
        // retained on the durable job and monitored as aggregate recovery work.
        this.logger.debug(
          `Queue job ${jobKey} failed; handing it to background recovery: ${message}`,
        );
      }

      const failure = await this.espnQueueService.markFailed(job, message);
      if (failure.quarantined && !isExpectedYoutubeMiss) {
        this.systemMonitor.reportError({
          module: 'sports',
          source: jobType,
          operation: 'quarantined-job',
          message,
          occurredAt: new Date(),
          referenceKey: jobKey,
        });
        this.systemMonitor.reportModuleHealth('sports', 'DEGRADED', {
          source: 'queue-worker',
          message: `A non-replayable or invalid job was quarantined: ${jobKey}`,
          details: { jobKey, category: failure.category },
        });
        this.logger.warn(
          `Queue job ${jobKey} was quarantined (${failure.category}); it will not be replayed automatically.`,
        );
      }
    } finally {
      clearInterval(heartbeat);
      this.activeJobs.delete(jobId);
      this.activeSlots[lane] = Math.max(0, this.activeSlots[lane] - 1);
      this.refreshActiveRuntime();
    }

    return true;
  }

  private async afterSuccessfulJob(
    job: Record<string, unknown>,
  ): Promise<void> {
    const type = job.type as EspnQueueJobType;
    const leagueId = job.leagueId ? this.stringifyJobId(job.leagueId) : '';
    const season = typeof job.season === 'number' ? job.season : undefined;
    const trigger =
      typeof job.triggerEventId === 'string' ? job.triggerEventId : '';

    const startupSummaryJob = trigger.startsWith('STARTUP_SUMMARY:');
    if (
      type === EspnQueueJobType.SUMMARY_REFRESH &&
      !startupSummaryJob &&
      leagueId &&
      season !== undefined &&
      typeof job.eventId === 'string'
    ) {
      const eventId = this.stringifyJobId(job.eventId);
      const priority = typeof job.priority === 'number' ? job.priority : 4;
      await this.espnQueueBuilderService.scheduleNextPostMatchSummaryCheckpoint(
        {
          eventId,
          leagueId,
          season,
          priority,
        },
      );

      // A Summary response can repair the canonical result even when the
      // scoreboard root missed the completion transition. Seed the same
      // completion-dependent work as the normal fixture-collection path.
      const fixture = await this.espnFixtureModel
        .findOne({ eventId, leagueId, season })
        .select({ completed: 1 })
        .lean()
        .exec();
      if (fixture?.completed === true) {
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

      const priority = typeof job.priority === 'number' ? job.priority : 4;
      if (trigger.startsWith('WINDOW_REFRESH:NEAR:')) {
        await this.espnQueueBuilderService.scheduleNextRollingFixtureRefresh({
          leagueId,
          season,
          priority,
          window: 'NEAR',
        });
        await this.espnQueueBuilderService.buildSummaryRefreshQueue({
          leagueId,
          season,
        });
        await this.espnQueueBuilderService.buildPostMatchCheckQueue({
          leagueId,
          season,
        });
      } else if (trigger.startsWith('WINDOW_REFRESH:FAR:')) {
        await this.espnQueueBuilderService.scheduleNextRollingFixtureRefresh({
          leagueId,
          season,
          priority,
          window: 'FAR',
        });
        await this.espnQueueBuilderService.buildPostMatchCheckQueue({
          leagueId,
          season,
        });
      }

      const eventId = this.getTriggeredEventId(trigger);
      if (eventId) {
        // The post-kickoff Summary job is independent of ESPN's completed flag.
        // It is durable and scheduled for kickoff + 160 minutes.
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
          if (isStartupSeed || initialRefreshPending) {
            await (
              this.espnStandingsService.assertStartupCollectionVerified as (
                leagueId: string,
                season: number,
              ) => Promise<void>
            )(leagueId, season);
          }
        };

        if (isStartupSeed || initialRefreshPending) {
          await this.runTrackedStep(
            stateKey,
            'STANDINGS_INITIAL',
            async () => {
              await this.sportsSyncStateService.resetStepForRefresh(
                stateKey,
                'STANDINGS_REFRESH',
              );
              await this.runTrackedStep(
                stateKey,
                'STANDINGS_REFRESH',
                refresh,
                false,
              );
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
            },
            false,
          );
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
    const trigger =
      typeof job.triggerEventId === 'string' ? job.triggerEventId : '';
    return (
      trigger.startsWith('POSTMATCH:') ||
      trigger.startsWith('POSTMATCH_RECHECK:') ||
      trigger.startsWith('FINISHED:')
    );
  }

  /**
   * Older deployments persisted event-specific FIXTURE_REFRESH jobs and then
   * repeated monthly scoreboard requests every 30 minutes. Drain these legacy
   * and settlement-triggered jobs as event-level Summary recovery instead.
   */
  private async processLegacyPostMatchCheck(
    job: Record<string, unknown>,
  ): Promise<void> {
    const trigger =
      typeof job.triggerEventId === 'string' ? job.triggerEventId : '';
    const eventId = this.getTriggeredEventId(trigger);
    const leagueId = job.leagueId ? this.stringifyJobId(job.leagueId) : '';
    const season = typeof job.season === 'number' ? job.season : undefined;
    if (!eventId || !leagueId || season === undefined) {
      throw new Error(
        'Legacy post-match check requires eventId, leagueId, and season',
      );
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
    let forceRefreshDateRange = false;

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
    } else if (triggerEventId.startsWith('POSTMATCH_FIXTURE_DATE:')) {
      const dateKey = triggerEventId
        .slice('POSTMATCH_FIXTURE_DATE:'.length)
        .trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
        throw new Error(
          `Post-match fixture refresh has an invalid date key: ${dateKey}`,
        );
      }
      forcedFinishedDate = dateKey;
      dateFrom = dateKey;
      dateTo = dateKey;
    } else if (triggerEventId.startsWith('WINDOW_REFRESH:NEAR:')) {
      dateFrom = this.toDateOnly(now);
      dateTo = this.toDateOnly(this.addLagosCalendarDays(now, 2));
      forceRefreshDateRange = true;
    } else if (triggerEventId.startsWith('WINDOW_REFRESH:FAR:')) {
      dateFrom = this.toDateOnly(this.addLagosCalendarDays(now, 3));
      dateTo = this.toDateOnly(this.addLagosCalendarDays(now, forwardDays));
      forceRefreshDateRange = true;
    } else if (triggerEventId.startsWith('WINDOW_EXTEND:')) {
      const targetDate = this.addLagosCalendarDays(now, forwardDays);
      dateFrom = this.toDateOnly(targetDate);
      dateTo = dateFrom;
      forceRefreshDateRange = true;
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
    } else if (forceRefreshDateRange) {
      const cursor = new Date(`${dateFrom}T00:00:00Z`);
      const end = new Date(`${dateTo}T00:00:00Z`);
      while (cursor <= end) {
        await this.sportsSyncStateService.resetDateForRefresh(
          canonicalStateKey,
          cursor.toISOString().slice(0, 10),
        );
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
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
      const batch = monthWork.slice(index, index + this.fixtureDayConcurrency);

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
      if (
        !response ||
        typeof response !== 'object' ||
        Array.isArray(response)
      ) {
        throw new Error(
          `ESPN returned an invalid scoreboard envelope for ${leagueId}/${monthKey}`,
        );
      }
      const record = response as unknown as Record<string, unknown>;
      if (!Array.isArray(record.events)) {
        throw new Error(
          `ESPN scoreboard ${leagueId}/${monthKey} omitted the events array`,
        );
      }
      if (
        record.events.some((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item))
            return true;
          const eventDate = (item as Record<string, unknown>).date;
          return (
            typeof eventDate !== 'string' ||
            !Number.isFinite(new Date(eventDate).getTime())
          );
        })
      ) {
        throw new Error(
          `ESPN scoreboard ${leagueId}/${monthKey} contained malformed event records`,
        );
      }
      const requestedDates = new Set(dateKeys);
      const monthlyEvents = record.events as Array<Record<string, unknown>>;
      const monthlyEventIds = [
        ...new Set(
          monthlyEvents
            .map((item) =>
              typeof item.id === 'string' || typeof item.id === 'number'
                ? String(item.id).trim()
                : '',
            )
            .filter(Boolean),
        ),
      ];
      const knownEvents =
        monthlyEventIds.length > 0
          ? await this.espnFixtureModel
              .find({ eventId: { $in: monthlyEventIds } })
              .select({ eventId: 1 })
              .lean()
              .exec()
          : [];
      const knownEventIds = new Set(
        knownEvents.map((item) => String(item.eventId)),
      );
      const events = monthlyEvents.filter((item) => {
        const eventDate = typeof item.date === 'string' ? item.date : '';
        const eventId =
          typeof item.id === 'string' || typeof item.id === 'number'
            ? String(item.id).trim()
            : '';
        // Keep any already-known event even when ESPN moved it outside the
        // original requested date slice. The canonical upsert will apply its
        // new kickoff date instead of leaving a stale duplicate behind.
        return (
          requestedDates.has(eventDate.slice(0, 10)) ||
          knownEventIds.has(eventId)
        );
      });

      // An empty month/day slice is valid when the database has no inventory
      // for that window. If previously stored fixtures exist there, however,
      // an empty provider slice is not allowed to advance the sync ledger to
      // SUCCESS; retain those rows and let the durable retry re-check ESPN.
      if (events.length === 0 && dateKeys.length > 0) {
        const sortedDates = [...dateKeys].sort();
        const rangeStart = new Date(`${sortedDates[0]}T00:00:00.000Z`);
        const rangeEnd = new Date(
          `${sortedDates[sortedDates.length - 1]}T00:00:00.000Z`,
        );
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
          this.sportsSyncStateService.markDateFailed(stateKey, dateKey, error),
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
    const kickoff =
      fixture.fixtureDate instanceof Date
        ? fixture.fixtureDate
        : new Date(fixture.fixtureDate);
    if (!Number.isFinite(kickoff.getTime())) {
      throw new Error(
        `Summary refresh fixture ${eventId} has an invalid kickoff time`,
      );
    }
    const nowMs = Date.now();
    const triggerEventId =
      typeof job.triggerEventId === 'string' ? job.triggerEventId : '';
    // Keep recognizing the legacy trigger prefix because pending jobs survive deployments.
    const startupJob =
      triggerEventId.startsWith('STARTUP_SUMMARY:') ||
      triggerEventId.startsWith('STARTUP_SUMMARY_66H:');
    const postMatchSummaryJob =
      triggerEventId.startsWith('POSTMATCH_SUMMARY:') ||
      triggerEventId.startsWith('POSTMATCH_RECHECK:');
    const upcomingDelayMs =
      SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.upcomingWindowHours *
      60 *
      60_000;
    const startupDelayMs =
      SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.startupWindowHours *
      60 *
      60_000;
    const finishedDelayMs =
      SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.finishedMatchDelayMinutes *
      60_000;
    let eligibleAtMs: number | undefined;
    let deferralReason: string | undefined;

    if (postMatchSummaryJob) {
      // A durable post-match job remains a post-match job even if ESPN later
      // moves the kickoff date. Never allow a rescheduled fixture to consume
      // the post-match refresh identity during its prematch window.
      const recheckMatch = triggerEventId.match(
        /^POSTMATCH_RECHECK:([^:]+):(\d+)$/,
      );
      const postMatchOffsetMinutes = recheckMatch
        ? Number(recheckMatch[2])
        : SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.finishedMatchDelayMinutes;
      const safeOffsetMinutes =
        Number.isFinite(postMatchOffsetMinutes) && postMatchOffsetMinutes >= 0
          ? postMatchOffsetMinutes
          : SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary
              .finishedMatchDelayMinutes;
      eligibleAtMs = kickoff.getTime() + safeOffsetMinutes * 60_000;
      if (nowMs < eligibleAtMs) {
        deferralReason = `Post-match Summary refresh is due at kickoff + ${safeOffsetMinutes} minutes.`;
      }
    } else if (kickoff.getTime() > nowMs) {
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
        deferralReason = `Finished-match Summary refresh is due at kickoff + ${SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.finishedMatchDelayMinutes} minutes.`;
      }
    }

    if (deferralReason && eligibleAtMs !== undefined) {
      const jobId = this.stringifyJobId(job._id);
      if (!jobId)
        throw new Error(
          `Cannot defer Summary job without its queue ID: ${eventId}`,
        );
      const scheduledFor = new Date(Math.max(nowMs + 1_000, eligibleAtMs));
      const deferred = await this.espnQueueService.deferProcessingSummaryJob(
        jobId,
        scheduledFor,
        this.safeJobString(job.ownerId),
        job.lane === EspnQueueLane.BACKGROUND_RETRY
          ? EspnQueueLane.BACKGROUND_RETRY
          : EspnQueueLane.NORMAL,
      );
      if (!deferred)
        throw new Error(
          `Could not defer Summary job ${jobId} to ${scheduledFor.toISOString()}`,
        );
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
      const summaryPersistence = this.sportsCollectionService as unknown as {
        assertEspnSummaryPersisted: (
          leagueId: string,
          season: number,
          eventId: string,
        ) => Promise<void>;
      };
      await summaryPersistence.assertEspnSummaryPersisted(
        leagueId,
        season,
        eventId,
      );
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
    const competitions = Array.isArray(competitionsValue)
      ? competitionsValue
      : [];
    const competition = competitions.map(asRecord).find(Boolean);
    const competitorsValue = competition?.['competitors'];
    const competitors = Array.isArray(competitorsValue)
      ? competitorsValue.map(asRecord).filter(Boolean)
      : [];
    if (competitors.length < 2) return {};

    const home =
      competitors.find(
        (competitor) =>
          competitor?.['homeAway'] === 'home' ||
          competitor?.['isHome'] === true,
      ) ?? competitors[0];
    const away =
      competitors.find(
        (competitor) =>
          competitor?.['homeAway'] === 'away' ||
          competitor?.['isAway'] === true,
      ) ?? competitors.find((competitor) => competitor !== home);

    const getTeamName = (
      competitor: Record<string, unknown> | undefined,
    ): string | undefined => {
      const team = asRecord(competitor?.['team']) ?? competitor;
      const values = [
        team?.['displayName'],
        team?.['shortDisplayName'],
        team?.['name'],
      ];
      return values
        .find(
          (value): value is string =>
            typeof value === 'string' && Boolean(value.trim()),
        )
        ?.trim();
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
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    const record = value as Record<string, unknown>;
    const knownSections = new Set([
      'header',
      'event',
      'competitions',
      'boxscore',
      'plays',
      'leaders',
      'team',
      'teams',
      'rosters',
      'roster',
      'injuries',
      'standings',
      'odds',
      'pickcenter',
      'news',
      'videos',
      'articles',
      'gameInfo',
      'format',
      'broadcasts',
      'predictor',
      'againstTheSpread',
      'winprobability',
      'drives',
      'scoringPlays',
      'statistics',
      'headToHead',
      'venue',
      'weather',
      'rankings',
      'situation',
      'commentary',
      'recent',
      'previews',
    ]);
    return Object.entries(record).some(([key, section]) => {
      if (!knownSections.has(key) || section === null || section === undefined)
        return false;
      if (Array.isArray(section)) return section.length > 0;
      if (typeof section === 'object') return Object.keys(section).length > 0;
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
    allowUnavailable = true,
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
        allowUnavailable &&
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
