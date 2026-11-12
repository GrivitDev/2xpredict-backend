import { randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import { SportsQueueJobType } from '../interfaces/sports-queue.interface';
import { SportsQueueJobProcessorService } from './sports-queue-job-processor.service';
import { SportsQueueService } from './sports-queue.service';
import { SportsCollectionStateService } from './sports-collection-state.service';
import type { ClaimedSportsQueueJob } from './sports-queue.service';
import { BackgroundWorkLimiterService } from '../../common/background-work/background-work-limiter.service';

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
  running: boolean;
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
}

const LANE_CONCURRENCY = 1;
const IDLE_POLL_MS = 5_000;
const ACTIVE_POLL_MS = 1_000;
const LEASE_MS = 10 * 60_000;
const HEARTBEAT_MS = 60_000;
const LEASE_RECOVERY_MS = 30_000;

/**
 * Independent durable queue lane for every SportsQueueJobType.
 * Each lane claims and executes one job at a time. The shared background-work
 * limiter caps all module workers at twelve active operations process-wide.
 */
@Injectable()
export class SportsQueueWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
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
  ) {
    const sportsOwnedTypes = Object.values(SportsQueueJobType).filter(
      (type) => type !== SportsQueueJobType.ODDS_PRICING_RECALCULATION
        && type !== SportsQueueJobType.PREDICTION_ENGINE_RECALCULATION,
    );
    for (const type of sportsOwnedTypes) {
      this.lanes.set(type, {
        type,
        running: false,
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

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.initialized = true;
    this.startedAt = new Date();
    this.queue.setWakeHandler((type) => {
      if (type) this.wakeLane(type);
      else for (const laneType of this.lanes.keys()) this.wakeLane(laneType);
    });
    for (const type of this.lanes.keys()) this.scheduleLane(type, 0);
    void this.recoverLeases();
    this.scheduleLeaseRecovery();
    this.logger.log(`Sports queue lanes started (${this.lanes.size} Sports-owned lanes; one job per lane; shared global limit=12).`);
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
    const lanes = Object.fromEntries([...this.lanes.entries()].map(([type, lane]) => [type, {
      running: lane.running,
      concurrency: LANE_CONCURRENCY,
      passes: lane.passes,
      failedPasses: lane.failedPasses,
      jobsClaimed: lane.claimed,
      jobsCompleted: lane.completed,
      jobsRetried: lane.retried,
      jobsQuarantined: lane.quarantined,
      lastPassStartedAt: lane.lastStartedAt,
      lastPassCompletedAt: lane.lastCompletedAt,
      lastError: lane.lastError,
    }]));
    const laneValues = [...this.lanes.values()];
    return {
      workerId: this.instanceId,
      initialized: this.initialized,
      stopped: this.stopped,
      running: laneValues.some((lane) => lane.running),
      startedAt: this.startedAt,
      laneCount: this.lanes.size,
      laneConcurrency: LANE_CONCURRENCY,
      passCount: laneValues.reduce((sum, lane) => sum + lane.passes, 0),
      jobsClaimed: laneValues.reduce((sum, lane) => sum + lane.claimed, 0),
      jobsCompleted: laneValues.reduce((sum, lane) => sum + lane.completed, 0),
      jobsRetried: laneValues.reduce((sum, lane) => sum + lane.retried, 0),
      jobsQuarantined: laneValues.reduce((sum, lane) => sum + lane.quarantined, 0),
      failedPassCount: laneValues.reduce((sum, lane) => sum + lane.failedPasses, 0),
      lastPassStartedAt: laneValues.map((lane) => lane.lastStartedAt).filter(Boolean).sort((a, b) => (b?.getTime() ?? 0) - (a?.getTime() ?? 0))[0],
      lastPassCompletedAt: laneValues.map((lane) => lane.lastCompletedAt).filter(Boolean).sort((a, b) => (b?.getTime() ?? 0) - (a?.getTime() ?? 0))[0],
      jobsOwnershipLost: this.jobsOwnershipLost,
      recoveredExpiredLeases: this.recoveredExpiredLeases,
      lastJob: this.lastJob ? { ...this.lastJob } : undefined,
      lanes,
    };
  }

  private wakeLane(type: SportsQueueJobType): void {
    if (this.stopped) return;
    const lane = this.lanes.get(type);
    if (!lane) return;
    if (lane.running) {
      lane.wakeRequested = true;
      return;
    }
    this.scheduleLane(type, 0);
  }

  private scheduleLane(type: SportsQueueJobType, delayMs: number): void {
    if (this.stopped) return;
    const lane = this.lanes.get(type);
    if (!lane || lane.running) return;
    if (lane.timer) clearTimeout(lane.timer);
    lane.timer = setTimeout(() => {
      lane.timer = undefined;
      void this.pumpLane(type);
    }, Math.max(0, delayMs));
    (lane.timer as unknown as { unref?: () => void }).unref?.();
  }

  private async pumpLane(type: SportsQueueJobType): Promise<void> {
    const lane = this.lanes.get(type);
    if (!lane || lane.running || this.stopped) return;

    lane.running = true;
    lane.passes += 1;
    let processed = 0;
    let releasePermit: (() => void) | undefined;

    try {
      // A permit is acquired before the durable claim, so waiting lanes do not
      // hold processing leases while another module is using all twelve slots.
      releasePermit = await this.backgroundWork.acquire(`sports:${type}`);
      if (this.stopped) return;

      lane.lastStartedAt = new Date();
      const workerId = `${this.instanceId}:${type}:0`;
      try {
        const job = await this.queue.claimNext(workerId, LEASE_MS, type);
        if (job) {
          lane.claimed += 1;
          processed = (await this.processClaimedJob(job, workerId)) ? 1 : 0;
        }
        lane.lastCompletedAt = new Date();
        lane.lastError = undefined;
      } catch (error) {
        lane.lastError = this.errorMessage(error);
        lane.failedPasses += 1;
        this.logger.error(`Sports queue lane ${type} failed: ${lane.lastError}`,
          error instanceof Error ? error.stack : undefined);
      }
    } catch (error) {
      if (!this.stopped) {
        lane.lastError = this.errorMessage(error);
        lane.failedPasses += 1;
        this.logger.error(`Sports queue lane ${type} could not acquire background capacity: ${lane.lastError}`);
      }
    } finally {
      releasePermit?.();
      lane.running = false;
      const wakeRequested = lane.wakeRequested;
      lane.wakeRequested = false;
      if (!this.stopped) {
        // Event wakes may request an immediate check, but the limiter still
        // enforces at least one second between starts in this lane.
        const delayMs = wakeRequested || processed > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS;
        this.scheduleLane(type, delayMs);
      }
    }
  }

  private async processClaimedJob(job: ClaimedSportsQueueJob, workerId: string): Promise<boolean> {
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      void this.queue.markHeartbeat(job.jobKey, workerId, LEASE_MS)
        .then((renewed) => {
          if (!renewed) this.logger.warn(`Lease for Sports queue job ${job.jobKey} is no longer owned by this worker.`);
        })
        .catch((error: unknown) => this.logger.warn(
          `Could not renew Sports queue job lease ${job.jobKey}: ${this.errorMessage(error)}`,
        ));
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
        this.logger.error(`Could not record failure for Sports job ${job.jobKey}: ${this.errorMessage(markError)}`);
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
      this.logger.error(`Sports queue job ${job.type} (${job.jobKey}) failed; ${outcome.toLowerCase()}.`, error instanceof Error ? error.stack : undefined);
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
      releasePermit = await this.backgroundWork.acquire('sports:lease-recovery');
      if (this.stopped) return;
      const recovered = await this.queue.recoverExpiredProcessing(200);
      this.recoveredExpiredLeases += recovered;
      const recoveredCollectionStates =
        await this.collectionStates.recoverStaleProcessing(20 * 60_000, 200);
      if (recovered > 0) {
        for (const type of this.lanes.keys()) this.wakeLane(type);
      }
      if (recoveredCollectionStates > 0) {
        this.logger.warn(
          `Recovered ${recoveredCollectionStates} abandoned Sports collection state(s) from PROCESSING to FAILED.`,
        );
      }
    } catch (error) {
      this.logger.error(`Sports queue lease recovery failed: ${this.errorMessage(error)}`);
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
      : String(error).replace(/[\r\n]+/g, ' ').slice(0, 500);
  }
}




