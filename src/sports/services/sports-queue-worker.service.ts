import { randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';

import { SportsQueueJobType } from '../interfaces/sports-queue.interface';
import { YOUTUBE_LEAGUE_PRIORITY } from '../config/youtube.config';
import { SportsProviderRateLimitService } from './sports-provider-rate-limit.service';
import { SportsQueueJobProcessorService } from './sports-queue-job-processor.service';
import { SportsQueueService } from './sports-queue.service';
import { SportsCollectionStateService } from './sports-collection-state.service';
import type { ClaimedSportsQueueJob } from './sports-queue.service';
import {
  BACKGROUND_WORK_LIMITS,
  BackgroundWorkLimiterService,
} from '../../common/background-work/background-work-limiter.service';

interface SportsWorkerLastJob {
  jobKey: string;
  type: string;
  outcome: 'COMPLETED' | 'RETRY' | 'QUARANTINED' | 'OWNERSHIP_LOST';
  durationMs: number;
  occurredAt: Date;
  error?: string;
}

interface LaneRuntime {
  type: SportsQueueJobType;
  activeJobs: number;
  wakeRequested: boolean;
  timer?: ReturnType<typeof setTimeout>;
  passes: number;
  failedPasses: number;
  claimed: number;
  completed: number;
  retried: number;
  quarantined: number;
  lastStartedAt?: Date;
  lastCompletedAt?: Date;
  lastError?: string;
  pausedUntil?: Date;
  quotaPausePeriod?: 'daily' | 'monthly';
}

const DEFAULT_LANE_CONCURRENCY = 1;
const LIVE_SCOREBOARD_LANE_CONCURRENCY = 1;

function getLaneConcurrency(type: SportsQueueJobType): number {
  return type === SportsQueueJobType.LIVE_SCOREBOARD_REFRESH
    ? LIVE_SCOREBOARD_LANE_CONCURRENCY
    : DEFAULT_LANE_CONCURRENCY;
}

/**
 * These lanes have their own single-worker execution guard and do not wait for
 * a shared global permit. This is limited to live monitoring and lightweight,
 * sub-minute control gates. Historical backfills remain behind the global gate.
 */
const GLOBAL_GATE_BYPASS_JOB_TYPES: ReadonlySet<SportsQueueJobType> = new Set([
  SportsQueueJobType.LIVE_SCOREBOARD_REFRESH,
  SportsQueueJobType.BOOTSTRAP_PHASE_GATE,
  SportsQueueJobType.SEASON_DISCOVERY_PHASE_GATE,
  SportsQueueJobType.FIXTURE_SEASON_VALIDATION_GATE,
]);

const IDLE_POLL_MS = 10_000;
const LOW_PRIORITY_IDLE_POLL_MS = 30_000;
const LOW_PRIORITY_IDLE_POLL_JOB_TYPES: ReadonlySet<SportsQueueJobType> = new Set([
  SportsQueueJobType.LEAGUE_CATALOGUE_REFRESH,
  SportsQueueJobType.LEAGUE_DETAIL_REFRESH,
  SportsQueueJobType.SEASON_CATALOGUE_REFRESH,
  SportsQueueJobType.TEAM_CATALOGUE_REFRESH,
  SportsQueueJobType.TEAM_DETAIL_REFRESH,
  SportsQueueJobType.MATCH_SUMMARY_BACKFILL,
  SportsQueueJobType.SPORTS_RETENTION_CLEANUP,
]);
const ACTIVE_POLL_MS = 1_000;
const LEASE_MS = 10 * 60_000;
const HEARTBEAT_MS = 60_000;
const LEASE_RECOVERY_MS = 60_000;

/**
 * Independent durable queue lane for every SportsQueueJobType.
 * Live scoreboard refresh is serialized because ESPN returns an unfiltered
 * scoreboard snapshot and concurrent jobs can persist overlapping fixtures.
 * Most lanes use the shared process-wide limiter; live monitoring and short
 * control gates bypass that shared gate.
 */
@Injectable()
export class SportsQueueWorkerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SportsQueueWorkerService.name);
  private readonly instanceId = `sports-worker:${process.env.HOSTNAME ?? 'node'}:${randomUUID()}`;
  private readonly lanes = new Map<SportsQueueJobType, LaneRuntime>();
  private stopped = false;
  private initialized = false;
  private recoveryRunning = false;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private startedAt?: Date;
  private jobsOwnershipLost = 0;
  private recoveredExpiredLeases = 0;
  private lastJob?: SportsWorkerLastJob;

  constructor(
    private readonly queue: SportsQueueService,
    private readonly jobProcessor: SportsQueueJobProcessorService,
    private readonly collectionStates: SportsCollectionStateService,
    private readonly backgroundWork: BackgroundWorkLimiterService,
    @Optional()
    private readonly providerRateLimits?: SportsProviderRateLimitService,
  ) {
    const sportsOwnedTypes = Object.values(SportsQueueJobType).filter(
      (type) =>
        type !== SportsQueueJobType.ODDS_PRICING_RECALCULATION &&
        type !== SportsQueueJobType.PREDICTION_ENGINE_RECALCULATION,
    );
    for (const type of sportsOwnedTypes) {
      this.lanes.set(type, {
        type,
        activeJobs: 0,
        wakeRequested: false,
        passes: 0,
        failedPasses: 0,
        claimed: 0,
        completed: 0,
        retried: 0,
        quarantined: 0,
      });
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    this.stopped = false;
    this.initialized = true;
    this.startedAt = new Date();
    this.queue.setWakeHandler((type) => {
      if (type) this.wakeLane(type);
      else for (const laneType of this.lanes.keys()) this.wakeLane(laneType);
    });

    // Upgrade pre-existing pending YouTube jobs before any worker can claim
    // them. Only PENDING YOUTUBE_HIGHLIGHT jobs are updated by the queue helper.
    try {
      const updated =
        typeof this.queue.reprioritizePendingYoutubeHighlightJobs === 'function'
          ? await this.queue.reprioritizePendingYoutubeHighlightJobs(
              YOUTUBE_LEAGUE_PRIORITY,
            )
          : 0;
      if (updated > 0) {
        this.logger.log(
          `Applied tiered YouTube league priority to ${updated} pending highlight job(s).`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not refresh pending YouTube highlight priorities during startup: ${this.errorMessage(error)}`,
      );
    }

    for (const type of this.lanes.keys()) this.scheduleLane(type, 0);
    void this.recoverLeases();
    this.scheduleLeaseRecovery();
    this.logger.log(
      `Sports queue lanes started (${this.lanes.size} Sports-owned lanes; one job per lane; shared global limit=${BACKGROUND_WORK_LIMITS.maximumConcurrentJobs}; priority scheduling enabled).`,
    );
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.queue.setWakeHandler(undefined);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    for (const lane of this.lanes.values()) {
      if (lane.timer) clearTimeout(lane.timer);
    }
  }

  /** Payload-free worker telemetry consumed by SportsMonitorService. */
  getMonitorStatus(): Record<string, unknown> {
    const lanes = Object.fromEntries(
      [...this.lanes.entries()].map(([type, lane]) => [
        type,
        {
          running: lane.activeJobs > 0,
          activeJobs: lane.activeJobs,
          concurrency: getLaneConcurrency(type),
          globalGate: GLOBAL_GATE_BYPASS_JOB_TYPES.has(type) ? 'BYPASS' : 'LIMITED',
          passes: lane.passes,
          failedPasses: lane.failedPasses,
          jobsClaimed: lane.claimed,
          jobsCompleted: lane.completed,
          jobsRetried: lane.retried,
          jobsQuarantined: lane.quarantined,
          lastPassStartedAt: lane.lastStartedAt,
          lastPassCompletedAt: lane.lastCompletedAt,
          lastError: lane.lastError,
          pausedUntil: lane.pausedUntil,
          quotaPausePeriod: lane.quotaPausePeriod,
        },
      ]),
    );
    const laneValues = [...this.lanes.values()];
    return {
      workerId: this.instanceId,
      initialized: this.initialized,
      stopped: this.stopped,
      running: laneValues.some((lane) => lane.activeJobs > 0),
      startedAt: this.startedAt,
      laneCount: this.lanes.size,
      // Expose the single-job live scoreboard lane capacity.
      laneConcurrency: DEFAULT_LANE_CONCURRENCY,
      maximumLaneConcurrency: LIVE_SCOREBOARD_LANE_CONCURRENCY,
      passCount: laneValues.reduce((sum, lane) => sum + lane.passes, 0),
      jobsClaimed: laneValues.reduce((sum, lane) => sum + lane.claimed, 0),
      jobsCompleted: laneValues.reduce((sum, lane) => sum + lane.completed, 0),
      jobsRetried: laneValues.reduce((sum, lane) => sum + lane.retried, 0),
      jobsQuarantined: laneValues.reduce(
        (sum, lane) => sum + lane.quarantined,
        0,
      ),
      failedPassCount: laneValues.reduce(
        (sum, lane) => sum + lane.failedPasses,
        0,
      ),
      lastPassStartedAt: laneValues
        .map((lane) => lane.lastStartedAt)
        .filter(Boolean)
        .sort((a, b) => (b?.getTime() ?? 0) - (a?.getTime() ?? 0))[0],
      lastPassCompletedAt: laneValues
        .map((lane) => lane.lastCompletedAt)
        .filter(Boolean)
        .sort((a, b) => (b?.getTime() ?? 0) - (a?.getTime() ?? 0))[0],
      jobsOwnershipLost: this.jobsOwnershipLost,
      recoveredExpiredLeases: this.recoveredExpiredLeases,
      lastJob: this.lastJob ? { ...this.lastJob } : undefined,
      backgroundWork: this.backgroundWork.getStatus(),
      lanes,
    };
  }

  private wakeLane(type: SportsQueueJobType): void {
    if (this.stopped) return;
    const lane = this.lanes.get(type);
    if (!lane) return;
    if (
      type === SportsQueueJobType.YOUTUBE_HIGHLIGHT &&
      lane.pausedUntil &&
      lane.pausedUntil.getTime() > Date.now()
    ) {
      // Event-driven queue wakes must not break a quota pause.
      return;
    }
    if (lane.activeJobs > 0) {
      lane.wakeRequested = true;
      // If capacity remains, start another claim without waiting for the
      // currently executing job to finish.
      if (lane.activeJobs < getLaneConcurrency(type)) {
        this.scheduleLane(type, 0);
      }
      return;
    }
    this.scheduleLane(type, 0);
  }

  private scheduleLane(type: SportsQueueJobType, delayMs: number): void {
    if (this.stopped) return;
    const lane = this.lanes.get(type);
    if (!lane) return;
    if (lane.activeJobs >= getLaneConcurrency(type)) {
      if (lane.timer) clearTimeout(lane.timer);
      lane.timer = undefined;
      return;
    }
    if (lane.timer) clearTimeout(lane.timer);
    lane.timer = setTimeout(
      () => {
        lane.timer = undefined;
        void this.pumpLane(type);
      },
      Math.max(0, delayMs),
    );
    (lane.timer as unknown as { unref?: () => void }).unref?.();
  }

  private async pumpLane(type: SportsQueueJobType): Promise<void> {
    const lane = this.lanes.get(type);
    if (
      !lane ||
      lane.activeJobs >= getLaneConcurrency(type) ||
      this.stopped
    ) return;

    lane.activeJobs += 1;
    lane.passes += 1;

    // Each pump claims one durable job. Additional live slots are filled only
    // after a job is found, avoiding three empty database claims on idle polls.
    let processed = 0;
    let releasePermit: (() => void) | undefined;

    try {
      // Quota exhaustion pauses the whole YouTube lane before another job is
      // claimed. Pending jobs remain untouched and therefore retain tier order.
      if (
        type === SportsQueueJobType.YOUTUBE_HIGHLIGHT &&
        this.providerRateLimits
      ) {
        if (lane.pausedUntil && lane.pausedUntil.getTime() > Date.now()) {
          this.scheduleLane(type, lane.pausedUntil.getTime() - Date.now());
          return;
        }
        lane.pausedUntil = undefined;
        lane.quotaPausePeriod = undefined;

        const [dailyRemaining, monthlyRemaining] = await Promise.all([
          this.providerRateLimits.getRemainingDailyRequests('youtube'),
          this.providerRateLimits.getRemainingMonthlyRequests('youtube'),
        ]);
        const exhaustedPeriod =
          dailyRemaining !== null && dailyRemaining <= 0
            ? 'daily'
            : monthlyRemaining !== null && monthlyRemaining <= 0
              ? 'monthly'
              : undefined;

        if (exhaustedPeriod) {
          const resumeAt = this.providerRateLimits.getQuotaResumeAt(
            'youtube',
            exhaustedPeriod,
          );
          lane.pausedUntil = resumeAt;
          lane.quotaPausePeriod = exhaustedPeriod;
          lane.lastError = `YouTube ${exhaustedPeriod} quota exhausted; lane paused until ${resumeAt.toISOString()}.`;
          this.logger.warn(lane.lastError);
          this.scheduleLane(type, Math.max(1_000, resumeAt.getTime() - Date.now()));
          return;
        }
      }

      // Bypass lanes remain outside the shared gate. All other lanes obtain
      // global capacity before claiming so they never hold a lease while waiting.
      if (!GLOBAL_GATE_BYPASS_JOB_TYPES.has(type)) {
        releasePermit = await this.backgroundWork.acquire(`sports:${type}`);
      }
      if (this.stopped) return;

      lane.lastStartedAt = new Date();
      const workerId = `${this.instanceId}:${type}:${randomUUID()}`;
      try {
        const job = await this.queue.claimNext(workerId, LEASE_MS, type);
        if (job) {
          lane.claimed += 1;
          if (lane.activeJobs < getLaneConcurrency(type)) {
            this.scheduleLane(type, 0);
          }
          processed = (await this.processClaimedJob(job, workerId)) ? 1 : 0;
        }
        lane.lastCompletedAt = new Date();
        lane.lastError = undefined;
      } catch (error) {
        lane.lastError = this.errorMessage(error);
        lane.failedPasses += 1;
        this.logger.error(
          `Sports queue lane ${type} failed: ${lane.lastError}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    } catch (error) {
      if (!this.stopped) {
        lane.lastError = this.errorMessage(error);
        lane.failedPasses += 1;
        this.logger.error(
          `Sports queue lane ${type} could not acquire background capacity: ${lane.lastError}`,
        );
      }
    } finally {
      releasePermit?.();
      lane.activeJobs = Math.max(0, lane.activeJobs - 1);
      const wakeRequested = lane.wakeRequested;
      lane.wakeRequested = false;
      if (
        !this.stopped &&
        lane.activeJobs < getLaneConcurrency(type) &&
        !lane.timer
      ) {
        // Preserve an already-scheduled immediate slot fill. Otherwise event
        // wakes and productive passes get the active cadence; idle lanes back off.
        const idleDelayMs = LOW_PRIORITY_IDLE_POLL_JOB_TYPES.has(type)
          ? LOW_PRIORITY_IDLE_POLL_MS
          : IDLE_POLL_MS;
        const delayMs =
          wakeRequested || processed > 0 ? ACTIVE_POLL_MS : idleDelayMs;
        this.scheduleLane(type, delayMs);
      }
    }
  }

  private async processClaimedJob(
    job: ClaimedSportsQueueJob,
    workerId: string,
  ): Promise<boolean> {
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      void this.queue
        .markHeartbeat(job.jobKey, workerId, LEASE_MS)
        .then((renewed) => {
          if (!renewed)
            this.logger.warn(
              `Lease for Sports queue job ${job.jobKey} is no longer owned by this worker.`,
            );
        })
        .catch((error: unknown) =>
          this.logger.warn(
            `Could not renew Sports queue job lease ${job.jobKey}: ${this.errorMessage(error)}`,
          ),
        );
    }, HEARTBEAT_MS);
    (heartbeat as unknown as { unref?: () => void }).unref?.();

    try {
      await this.jobProcessor.process(job);
      await this.jobProcessor.scheduleNext(job, workerId);
      const completed = await this.queue.markCompleted(job.jobKey, workerId);
      if (completed) {
        const lane = this.lanes.get(job.type);
        if (lane) lane.completed += 1;
        this.lastJob = {
          jobKey: job.jobKey,
          type: job.type,
          outcome: 'COMPLETED',
          durationMs: Date.now() - startedAt,
          occurredAt: new Date(),
        };
        return true;
      }
      this.jobsOwnershipLost += 1;
      this.lastJob = {
        jobKey: job.jobKey,
        type: job.type,
        outcome: 'OWNERSHIP_LOST',
        durationMs: Date.now() - startedAt,
        occurredAt: new Date(),
      };
      return false;
    } catch (error) {
      let outcome: 'RETRY' | 'QUARANTINED';
      try {
        outcome = await this.queue.markFailed(job, workerId, error);
      } catch (markError) {
        // Leave the durable processing record leased. Central lease recovery
        // will return it to pending if this acknowledgement write also fails.
        this.logger.error(
          `Could not record failure for Sports job ${job.jobKey}: ${this.errorMessage(markError)}`,
        );
        return false;
      }
      const lane = this.lanes.get(job.type);
      if (lane) {
        if (outcome === 'QUARANTINED') lane.quarantined += 1;
        else lane.retried += 1;
      }
      this.lastJob = {
        jobKey: job.jobKey,
        type: job.type,
        outcome,
        durationMs: Date.now() - startedAt,
        occurredAt: new Date(),
        error: this.errorMessage(error),
      };
      this.logger.error(
        `Sports queue job ${job.type} (${job.jobKey}) failed; ${outcome.toLowerCase()}.`,
        error instanceof Error ? error.stack : undefined,
      );
      return false;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async recoverLeases(): Promise<void> {
    if (this.stopped || this.recoveryRunning) return;
    this.recoveryRunning = true;
    let releasePermit: (() => void) | undefined;
    try {
      releasePermit = await this.backgroundWork.acquire(
        'sports:lease-recovery',
      );
      if (this.stopped) return;
      const recovered = await this.queue.recoverExpiredProcessing(100);
      this.recoveredExpiredLeases += recovered;
      const recoveredCollectionStates =
        await this.collectionStates.recoverStaleProcessing(20 * 60_000, 100);
      if (recovered > 0) {
        for (const type of this.lanes.keys()) this.wakeLane(type);
      }
      if (recoveredCollectionStates > 0) {
        this.logger.warn(
          `Recovered ${recoveredCollectionStates} abandoned Sports collection state(s) from PROCESSING to FAILED.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Sports queue lease recovery failed: ${this.errorMessage(error)}`,
      );
    } finally {
      releasePermit?.();
      this.recoveryRunning = false;
    }
  }

  private scheduleLeaseRecovery(): void {
    if (this.stopped) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.recoverLeases().finally(() => this.scheduleLeaseRecovery());
    }, LEASE_RECOVERY_MS);
    (this.recoveryTimer as unknown as { unref?: () => void }).unref?.();
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 500)
      : String(error)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 500);
  }
}



