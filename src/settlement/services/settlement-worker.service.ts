import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SettlementQueueService } from './settlement-queue.service';
import { SettlementProcessorService } from './settlement-processor.service';
import { SettlementEventLogService } from './settlement-event-log.service';
import { SettlementJobDocument } from '../schemas/settlement-job.schema';
import { SettlementEventLevel } from '../enums/settlement-event-level.enum';
import { SETTLEMENT_CONFIG } from '../config/settlement.config';
import { SystemMonitorService } from '../../system-monitor/system-monitor.service';
import { AdminGateway } from '../../realtime/admin.gateway';
import { SettlementWorkerRuntimeStatus } from '../interfaces/settlement-monitor.interface';
import { BackgroundWorkLimiterService } from '../../common/background-work/background-work-limiter.service';

@Injectable()
export class SettlementWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettlementWorkerService.name);
  private readonly workerId = `settlement-worker-${randomUUID()}`;
  private busy = false;
  private wakeRequested = false;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private initialized = false;
  private startedAt = new Date();
  private lastStartupSuccessAt?: Date;
  private lastStartupError?: string;
  private startupAttempts = 0;
  private drainCycles = 0;
  private drainFailures = 0;
  private jobsClaimed = 0;
  private jobsCompleted = 0;
  private jobsPartial = 0;
  private jobsSkipped = 0;
  private jobsFailed = 0;
  private jobsRetried = 0;
  private jobsTerminalFailed = 0;
  private lastDrainStartedAt?: Date;
  private lastDrainCompletedAt?: Date;
  private lastDrainErrorAt?: Date;
  private activeJob?: {
    jobKey: string;
    eventId: string;
    leagueId: string;
    startedAt: Date;
    attempt: number;
  };
  private lastJobAt?: Date;
  private lastJobStatus?:
    | 'COMPLETED'
    | 'PARTIAL'
    | 'SKIPPED'
    | 'RETRY'
    | 'FAILED';
  private lastJobKey?: string;
  private lastJobEventId?: string;
  private lastJobDurationMs?: number;
  private lastJobError?: string;
  private startupRetryTimer?: ReturnType<typeof setTimeout>;
  private leaseRecoveryTimer?: ReturnType<typeof setInterval>;
  private targetReconciliationTimer?: ReturnType<typeof setInterval>;
  private targetReconciliationBusy = false;
  private leaseRecoveryBusy = false;
  private targetReconciliationRuns = 0;
  private targetReconciliationQueued = 0;
  private lastTargetReconciliationAt?: Date;
  private lastTargetReconciliationError?: string;
  private readonly onQueued = () => this.wake(0);

  constructor(
    private readonly queue: SettlementQueueService,
    private readonly processor: SettlementProcessorService,
    private readonly eventLog: SettlementEventLogService,
    private readonly systemMonitor: SystemMonitorService,
    private readonly adminGateway: AdminGateway,
    private readonly backgroundWork: BackgroundWorkLimiterService,
  ) {}

  getRuntimeStatus(): SettlementWorkerRuntimeStatus {
    const now = Date.now();
    return {
      initialized: this.initialized,
      busy: this.busy,
      wakeRequested: this.wakeRequested,
      activeJob: this.activeJob
        ? {
            jobKey: this.activeJob.jobKey,
            eventId: this.activeJob.eventId,
            leagueId: this.activeJob.leagueId,
            startedAt: this.activeJob.startedAt.toISOString(),
            durationMs: Math.max(0, now - this.activeJob.startedAt.getTime()),
            attempt: this.activeJob.attempt,
          }
        : undefined,
      startedAt: this.startedAt.toISOString(),
      lastStartupSuccessAt: this.lastStartupSuccessAt?.toISOString(),
      lastStartupError: this.lastStartupError,
      startupAttempts: this.startupAttempts,
      drainCycles: this.drainCycles,
      drainFailures: this.drainFailures,
      jobsClaimed: this.jobsClaimed,
      jobsCompleted: this.jobsCompleted,
      jobsPartial: this.jobsPartial,
      jobsSkipped: this.jobsSkipped,
      jobsFailed: this.jobsFailed,
      jobsRetried: this.jobsRetried,
      jobsTerminalFailed: this.jobsTerminalFailed,
      lastDrainStartedAt: this.lastDrainStartedAt?.toISOString(),
      lastDrainCompletedAt: this.lastDrainCompletedAt?.toISOString(),
      lastDrainErrorAt: this.lastDrainErrorAt?.toISOString(),
      lastJobAt: this.lastJobAt?.toISOString(),
      lastJobStatus: this.lastJobStatus,
      lastJobKey: this.lastJobKey,
      lastJobEventId: this.lastJobEventId,
      lastJobDurationMs: this.lastJobDurationMs,
      lastJobError: this.lastJobError,
      targetReconciliationBusy: this.targetReconciliationBusy,
      targetReconciliationRuns: this.targetReconciliationRuns,
      targetReconciliationQueued: this.targetReconciliationQueued,
      lastTargetReconciliationAt: this.lastTargetReconciliationAt?.toISOString(),
      lastTargetReconciliationError: this.lastTargetReconciliationError,
      workerId: this.workerId,
    };
  }

  onModuleInit(): void {
    this.adminGateway.setModuleOperationalStatus(
      'settlement',
      'STARTING',
      'Settlement worker initialized; startup recovery is running.',
    );
    this.systemMonitor.reportModuleHealth('settlement', 'UNKNOWN', {
      source: 'worker-lifecycle',
      message:
        'Settlement queue worker initialized; startup recovery is running.',
    });
    this.queue.onEnqueued(this.onQueued);
    // The periodic sweeper repairs PROCESSING jobs abandoned by a crashed or
    // disconnected instance, even when this worker has no runnable jobs.
    this.leaseRecoveryTimer = setInterval(
      () => void this.recoverAbandonedLeases(),
      SETTLEMENT_CONFIG.queue.leaseHeartbeatIntervalMs,
    );
    this.leaseRecoveryTimer.unref?.();
    // Target reconciliation is a level-triggered safety net for cases where a
    // Prediction or Bet Lab write committed but its immediate queue handoff did
    // not. It is intentionally separate from the lease sweeper.
    this.targetReconciliationTimer = setInterval(
      () => void this.reconcileUnsettledTargets(),
      SETTLEMENT_CONFIG.queue.targetReconciliationIntervalMs,
    );
    this.targetReconciliationTimer.unref?.();
    // Sports outbox events remain the primary trigger. Startup and recurring
    // reconciliation repair pre-existing and missed Prediction/Bet Lab handoffs.
    void this.startupRecovery();
  }

  onModuleDestroy(): void {
    this.queue.offEnqueued(this.onQueued);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    if (this.startupRetryTimer) clearTimeout(this.startupRetryTimer);
    if (this.leaseRecoveryTimer) clearInterval(this.leaseRecoveryTimer);
    if (this.targetReconciliationTimer) clearInterval(this.targetReconciliationTimer);
  }

  private async reconcileUnsettledTargets(): Promise<void> {
    if (!this.initialized || this.targetReconciliationBusy) return;
    this.targetReconciliationBusy = true;
    this.targetReconciliationRuns += 1;
    let releasePermit: (() => void) | undefined;
    try {
      releasePermit = await this.backgroundWork.acquire('settlement:target-reconciliation');
      if (!this.initialized) return;
      const result = await this.queue.reconcileExistingUnsettledTargets();
      this.lastTargetReconciliationAt = new Date();
      this.lastTargetReconciliationError = undefined;
      this.targetReconciliationQueued += result.queued;
      if (result.queued > 0) {
        this.logger.warn(
          `Settlement target reconciliation queued ${result.queued} job(s) from ${result.candidateEventIds} unresolved fixture target(s).`,
        );
        this.wake(0);
      }
    } catch (error) {
      const message = this.errorMessage(error);
      this.lastTargetReconciliationAt = new Date();
      this.lastTargetReconciliationError = message;
      this.logger.error(`Settlement target reconciliation failed: ${message}`);
      this.systemMonitor.reportModuleHealth('settlement', 'DEGRADED', {
        source: 'target-reconciliation',
        message,
        details: {
          run: this.targetReconciliationRuns,
          intervalMs: SETTLEMENT_CONFIG.queue.targetReconciliationIntervalMs,
        },
      });
      this.systemMonitor.reportError({
        module: 'settlement',
        source: 'target-reconciliation',
        operation: 'reconcile-unsettled-targets',
        message,
        occurredAt: new Date(),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } finally {
      releasePermit?.();
      this.targetReconciliationBusy = false;
    }
  }

  private async recoverAbandonedLeases(): Promise<void> {
    if (this.leaseRecoveryBusy) return;
    this.leaseRecoveryBusy = true;
    let releasePermit: (() => void) | undefined;
    try {
      releasePermit = await this.backgroundWork.acquire('settlement:lease-recovery');
      const recovered = await this.queue.recoverExpiredProcessingJobs();
      if (recovered.total > 0) {
        this.logger.warn(
          `Settlement lease recovery reclaimed ${recovered.recoveredForRetry} job(s) for retry and marked ${recovered.exhausted} exhausted job(s) failed.`,
        );
        this.wake(0);
        try {
          await this.eventLog.write({
            level: SettlementEventLevel.WARN,
            action: 'SETTLEMENT_EXPIRED_LEASES_RECOVERED',
            message: `Recovered ${recovered.total} abandoned settlement processing lease(s).`,
            metadata: recovered,
          });
        } catch (loggingError) {
          this.logger.warn(`Could not persist Settlement lease recovery event: ${this.errorMessage(loggingError)}`);
        }
      }
    } catch (error) {
      this.logger.error(`Settlement expired-lease recovery failed: ${this.errorMessage(error)}`);
      this.systemMonitor.reportModuleHealth('settlement', 'DEGRADED', {
        source: 'worker-lease-recovery',
        message: this.errorMessage(error),
      });
    } finally {
      releasePermit?.();
      this.leaseRecoveryBusy = false;
    }
  }

  private async startupRecovery(): Promise<void> {
    this.startupAttempts += 1;
    let releasePermit: (() => void) | undefined;
    try {
      releasePermit = await this.backgroundWork.acquire('settlement:startup-recovery');
      const recovered = await this.queue.recoverExpiredProcessingJobs();
      // Temporary, durable one-time correction pass. It is a no-op unless
      // SETTLEMENT_HISTORICAL_RESETTLE_ON_STARTUP=true is explicitly enabled.
      // Complete it before enabling the queue drain so normal settlement cannot
      // race the controlled historical correction.
      const historicalResettlement =
        await this.processor.runHistoricalResettlementOnce();
      // Catch up records created before Sports outbox delivery was activated.
      // Only unresolved Prediction/Bet Lab event IDs are scanned; every fixture
      // is re-read and checked by SettlementQueueService before being queued.
      const targetReconciliation =
        await this.queue.reconcileExistingUnsettledTargets();
      this.initialized = true;
      this.lastStartupSuccessAt = new Date();
      this.lastStartupError = undefined;
      // Start queue draining before any monitoring or audit operations that may fail.
      this.wake(0);
      this.adminGateway.setModuleOperationalStatus(
        'settlement',
        'READY',
        'Settlement worker recovery completed.',
        { recoveredLeases: recovered, historicalResettlement, targetReconciliation },
      );
      this.adminGateway.publishModuleEvent(
        'settlement',
        'settlement:worker-ready',
        {
          recoveredLeases: recovered,
          historicalResettlement,
          targetReconciliation,
          occurredAt: new Date().toISOString(),
        },
      );
      this.systemMonitor.reportModuleHealth('settlement', 'HEALTHY', {
        source: 'worker-recovery',
        message: 'Settlement worker recovery completed.',
        details: { recoveredLeases: recovered, historicalResettlement, targetReconciliation },
      });
      this.logger.log(
        `Settlement worker initialized. Recovered abandoned leases=${JSON.stringify(recovered)}; historical resettlement=${JSON.stringify(historicalResettlement)}; startup target reconciliation=${JSON.stringify(targetReconciliation)}.`,
      );
      // Queue readiness must not depend on an audit-event insert succeeding.
      try {
        await this.eventLog.write({
          level: SettlementEventLevel.INFO,
          action: 'SETTLEMENT_WORKER_READY',
          message:
            'Event-triggered settlement worker completed startup recovery.',
          metadata: { recoveredLeases: recovered, historicalResettlement, targetReconciliation },
        });
      } catch (loggingError) {
        this.logger.warn(
          `Could not persist Settlement worker-ready event: ${this.errorMessage(loggingError)}`,
        );
      }
    } catch (error) {
      const message = this.errorMessage(error);
      this.lastStartupError = message;
      // Schedule recovery first. Monitoring or event-log failures must never
      // leave the worker permanently stopped after a transient startup error.
      if (this.startupRetryTimer) clearTimeout(this.startupRetryTimer);
      this.startupRetryTimer = setTimeout(() => {
        this.startupRetryTimer = undefined;
        void this.startupRecovery();
      }, 15_000);
      this.startupRetryTimer.unref?.();

      this.logger.error(`Settlement startup recovery failed: ${message}`);
      try {
        this.adminGateway.setModuleOperationalStatus(
          'settlement',
          'DEGRADED',
          message,
        );
        this.adminGateway.publishModuleEvent(
          'settlement',
          'settlement:worker-error',
          {
            phase: 'startup-recovery',
            message,
            occurredAt: new Date().toISOString(),
          },
        );
        this.systemMonitor.reportModuleHealth('settlement', 'DEGRADED', {
          source: 'worker-recovery',
          message,
        });
        this.systemMonitor.reportError({
          module: 'settlement',
          source: 'worker-recovery',
          operation: 'startup-recovery',
          message,
          occurredAt: new Date(),
          stack: error instanceof Error ? error.stack : undefined,
        });
      } catch (monitoringError) {
        this.logger.warn(
          `Could not update Settlement startup monitoring state: ${this.errorMessage(monitoringError)}`,
        );
      }
      try {
        await this.eventLog.write({
          level: SettlementEventLevel.ERROR,
          action: 'SETTLEMENT_STARTUP_RECOVERY_FAILED',
          message,
        });
      } catch (loggingError) {
        this.logger.warn(
          `Could not persist Settlement startup recovery error: ${this.errorMessage(loggingError)}`,
        );
      }
    } finally {
      releasePermit?.();
    }
  }

  private wake(delayMs: number): void {
    if (this.busy) {
      this.wakeRequested = true;
      return;
    }
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = undefined;
        void this.drain();
      },
      Math.max(0, delayMs),
    );
  }

  private async drain(): Promise<void> {
    if (this.busy || !this.initialized) {
      this.wakeRequested = true;
      return;
    }
    this.busy = true;
    this.wakeRequested = false;
    let processed = 0;
    let releasePermit: (() => void) | undefined;
    try {
      releasePermit = await this.backgroundWork.acquire('settlement:queue');
      if (!this.initialized) return;
      this.drainCycles += 1;
      this.lastDrainStartedAt = new Date();
      this.systemMonitor.reportActivity({
        module: 'settlement',
        source: 'worker',
        operation: 'drain',
        status: 'INFO',
        message: 'Settlement queue drain started.',
        occurredAt: new Date(),
      });
      this.adminGateway.publishModuleEvent(
        'settlement',
        'settlement:drain-started',
        { occurredAt: new Date().toISOString() },
      );
      while (processed < SETTLEMENT_CONFIG.queue.maximumJobsPerDrain) {
        const job = await this.queue.claimNextDueJob(this.workerId);
        if (!job) break;
        this.jobsClaimed += 1;
        await this.processJob(job);
        processed += 1;
      }
    } catch (error) {
      this.drainFailures += 1;
      this.lastDrainErrorAt = new Date();
      this.adminGateway.setModuleOperationalStatus(
        'settlement',
        'DEGRADED',
        this.errorMessage(error),
      );
      this.adminGateway.publishModuleEvent(
        'settlement',
        'settlement:worker-error',
        {
          phase: 'drain',
          message: this.errorMessage(error),
          occurredAt: new Date().toISOString(),
        },
      );
      this.systemMonitor.reportModuleHealth('settlement', 'DEGRADED', {
        source: 'worker',
        message: this.errorMessage(error),
      });
      this.systemMonitor.reportError({
        module: 'settlement',
        source: 'worker',
        operation: 'drain',
        message: this.errorMessage(error),
        occurredAt: new Date(),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.logger.error(
        `Settlement worker drain failed: ${this.errorMessage(error)}`,
      );
      try {
        await this.eventLog.write({
          level: SettlementEventLevel.ERROR,
          action: 'SETTLEMENT_WORKER_DRAIN_FAILED',
          message: this.errorMessage(error),
        });
      } catch (loggingError) {
        this.logger.warn(
          `Could not persist Settlement drain error: ${this.errorMessage(loggingError)}`,
        );
      }
    } finally {
      releasePermit?.();
      this.busy = false;
      this.lastDrainCompletedAt = new Date();
      if (
        this.wakeRequested ||
        processed >= SETTLEMENT_CONFIG.queue.maximumJobsPerDrain
      ) {
        this.wake(1_000);
      } else {
        try {
          const nextAt = await this.queue.getNextWakeAt();
          if (nextAt) this.wake(Math.max(1_000, nextAt.getTime() - Date.now()));
        } catch (error) {
          this.logger.warn(
            `Settlement next-wake lookup failed: ${this.errorMessage(error)}`,
          );
          this.wake(15_000);
        }
      }
    }
  }

  private async processJob(job: SettlementJobDocument): Promise<void> {
    const startedAt = Date.now();
    this.activeJob = {
      jobKey: job.jobKey,
      eventId: job.eventId,
      leagueId: job.leagueId,
      startedAt: new Date(startedAt),
      attempt: job.attempts,
    };
    this.adminGateway.publishModuleEvent(
      'settlement',
      'settlement:job-started',
      {
        jobKey: job.jobKey,
        eventId: job.eventId,
        leagueId: job.leagueId,
        attempt: job.attempts,
        occurredAt: new Date().toISOString(),
      },
    );

    let heartbeatBusy = false;
    let leaseLost = false;
    const heartbeatTimer = setInterval(async () => {
      if (heartbeatBusy || leaseLost) return;
      heartbeatBusy = true;
      try {
        const renewed = await this.queue.renewProcessingLease(job, this.workerId);
        if (!renewed) {
          leaseLost = true;
          this.logger.error(
            `Settlement worker ${this.workerId} lost ownership of job ${job.jobKey}; further queue state changes are fenced.`,
          );
        }
      } catch (heartbeatError) {
        // A transient heartbeat error is not proof that ownership changed.
        // If the lease really expires, recovery changes the token and fences us.
        this.logger.warn(
          `Settlement lease heartbeat failed for ${job.jobKey}: ${this.errorMessage(heartbeatError)}`,
        );
      } finally {
        heartbeatBusy = false;
      }
    }, SETTLEMENT_CONFIG.queue.leaseHeartbeatIntervalMs);
    heartbeatTimer.unref?.();

    try {
      await this.queue.assertProcessingLease(job, this.workerId);
      const result = await this.processor.process(job);
      await this.queue.assertProcessingLease(job, this.workerId);
      if (leaseLost) {
        throw new Error(`Settlement processing lease was lost for job ${job.jobKey}.`);
      }
      const durationMs = Date.now() - startedAt;
      const rerunQueued = await this.queue.complete(job, {
        partial: result.partial,
        skipped: result.skipped === true,
        counts: result.counts as unknown as Record<string, number>,
        unresolvedReasons: result.unresolvedReasons,
        durationMs,
      });
      this.lastJobAt = new Date();
      this.lastJobKey = job.jobKey;
      this.lastJobEventId = job.eventId;
      this.lastJobDurationMs = durationMs;
      this.lastJobError = undefined;
      if (result.skipped) {
        this.jobsSkipped += 1;
        this.lastJobStatus = 'SKIPPED';
      } else if (result.partial) {
        this.jobsPartial += 1;
        this.lastJobStatus = 'PARTIAL';
      } else {
        this.jobsCompleted += 1;
        this.lastJobStatus = 'COMPLETED';
      }
      this.systemMonitor.reportActivity({
        module: 'settlement',
        source: 'worker',
        operation: 'process-job',
        status: 'INFO',
        message: result.skipped
          ? `Settlement job ${job.jobKey} was skipped because fixture lifecycle was not confirmed.`
          : result.partial
            ? `Settlement job ${job.jobKey} ran but still has unresolved targets.`
            : `Settlement job ${job.jobKey} completed successfully.`,
        occurredAt: new Date(),
        durationMs,
        referenceKey: job.jobKey,
      });
      this.systemMonitor.reportModuleHealth('settlement', 'HEALTHY', {
        source: 'worker',
        message: result.skipped
          ? `Settlement worker safely skipped ${job.jobKey}; fixture lifecycle is not confirmed.`
          : result.partial
            ? `Settlement worker recovered and processed ${job.jobKey}; unresolved targets remain.`
            : `Settlement processing successfully completed job ${job.jobKey}.`,
        details: {
          eventId: job.eventId,
          partial: result.partial,
          skipped: result.skipped === true,
          durationMs,
          counts: result.counts,
        },
      });
      this.adminGateway.setModuleOperationalStatus(
        'settlement',
        'READY',
        result.skipped
          ? `Settlement worker skipped event ${job.eventId}; fixture lifecycle is not confirmed.`
          : result.partial
            ? `Settlement worker is running; event ${job.eventId} still has unresolved targets.`
            : `Settlement worker completed event ${job.eventId}.`,
        {
          eventId: job.eventId,
          partial: result.partial,
          skipped: result.skipped === true,
          durationMs,
          counts: result.counts,
        },
      );
      this.adminGateway.publishModuleEvent(
        'settlement',
        rerunQueued
          ? 'settlement:job-requeued'
          : result.skipped
            ? 'settlement:job-skipped'
            : 'settlement:job-completed',
        {
          jobKey: job.jobKey,
          eventId: job.eventId,
          partial: result.partial,
          skipped: result.skipped === true,
          rerunQueued,
          counts: result.counts,
          unresolvedReasons: result.unresolvedReasons,
          durationMs,
          occurredAt: new Date().toISOString(),
        },
      );
    } catch (error) {
      const outcome = await this.queue.fail(job, error);
      if (outcome.leaseLost) {
        this.logger.warn(
          `Settlement job ${job.jobKey} was no longer owned by this worker; stale completion/failure was rejected.`,
        );
        this.wake(0);
        return;
      }
      const message = this.errorMessage(error);
      this.jobsFailed += 1;
      if (outcome.terminal) this.jobsTerminalFailed += 1;
      else this.jobsRetried += 1;
      this.lastJobAt = new Date();
      this.lastJobKey = job.jobKey;
      this.lastJobEventId = job.eventId;
      this.lastJobDurationMs = Date.now() - startedAt;
      this.lastJobError = message;
      this.lastJobStatus = outcome.terminal ? 'FAILED' : 'RETRY';
      this.adminGateway.publishModuleEvent(
        'settlement',
        'settlement:job-failed',
        {
          jobKey: job.jobKey,
          eventId: job.eventId,
          terminal: outcome.terminal,
          retryAt: outcome.retryAt?.toISOString(),
          message,
          occurredAt: new Date().toISOString(),
        },
      );
      this.systemMonitor.reportError({
        module: 'settlement',
        source: 'worker',
        operation: 'process-job',
        message,
        occurredAt: new Date(),
        stack: error instanceof Error ? error.stack : undefined,
        referenceKey: job.jobKey,
      });
      this.systemMonitor.reportActivity({
        module: 'settlement',
        source: 'worker',
        operation: 'process-job',
        status: 'FAILED',
        message: `Settlement job ${job.jobKey} failed; ${outcome.terminal ? 'terminal failure' : 'retry scheduled'}.`,
        occurredAt: new Date(),
        durationMs: Date.now() - startedAt,
        referenceKey: job.jobKey,
      });
      if (outcome.terminal) {
        this.systemMonitor.reportModuleHealth('settlement', 'DEGRADED', {
          source: 'worker',
          message: `Settlement job ${job.jobKey} exhausted retries: ${message}`,
        });
      }
      this.logger.error(
        `Settlement job ${job.jobKey} failed (${outcome.terminal ? 'terminal' : 'retry'}): ${message}`,
      );
      try {
        await this.eventLog.write({
          level: outcome.terminal
            ? SettlementEventLevel.ERROR
            : SettlementEventLevel.WARN,
          action: outcome.terminal
            ? 'SETTLEMENT_JOB_FAILED_TERMINALLY'
            : 'SETTLEMENT_JOB_RETRY_SCHEDULED',
          message,
          eventId: job.eventId,
          jobKey: job.jobKey,
          metadata: {
            attempt: job.attempts,
            maximumAttempts: job.maximumAttempts,
            retryAt: outcome.retryAt,
          },
        });
      } catch (loggingError) {
        this.logger.warn(
          `Could not persist Settlement job failure event for ${job.jobKey}: ${this.errorMessage(loggingError)}`,
        );
      }
      if (outcome.retryAt)
        this.wake(Math.max(0, outcome.retryAt.getTime() - Date.now()));
    } finally {
      clearInterval(heartbeatTimer);
      this.activeJob = undefined;
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}



