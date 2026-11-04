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
  private activeJob?: { jobKey: string; eventId: string; leagueId: string; startedAt: Date; attempt: number };
  private lastJobAt?: Date;
  private lastJobStatus?: 'COMPLETED' | 'PARTIAL' | 'SKIPPED' | 'RETRY' | 'FAILED';
  private lastJobKey?: string;
  private lastJobEventId?: string;
  private lastJobDurationMs?: number;
  private lastJobError?: string;
  private startupRetryTimer?: ReturnType<typeof setTimeout>;
  private readonly onQueued = () => this.wake(0);

  constructor(
    private readonly queue: SettlementQueueService,
    private readonly processor: SettlementProcessorService,
    private readonly eventLog: SettlementEventLogService,
    private readonly systemMonitor: SystemMonitorService,
    private readonly adminGateway: AdminGateway,
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
      workerId: this.workerId,
    };
  }

  onModuleInit(): void {
    this.adminGateway.setModuleOperationalStatus('settlement', 'STARTING', 'Settlement worker initialized; startup recovery is running.');
    this.systemMonitor.reportModuleHealth('settlement', 'UNKNOWN', { source: 'worker-lifecycle', message: 'Settlement queue worker initialized; startup recovery is running.' });
    this.queue.onEnqueued(this.onQueued);
    // Jobs are discovered by fixture-refresh, target-creation and Summary-update events.
    // Startup is limited to recovering interrupted worker leases.
    void this.startupRecovery();
  }

  onModuleDestroy(): void {
    this.queue.offEnqueued(this.onQueued);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    if (this.startupRetryTimer) clearTimeout(this.startupRetryTimer);
  }

  private async startupRecovery(): Promise<void> {
    this.startupAttempts += 1;
    try {
      const recovered = await this.queue.recoverExpiredProcessingJobs();
      // Temporary, durable one-time correction pass. It is a no-op unless
      // SETTLEMENT_HISTORICAL_RESETTLE_ON_STARTUP=true is explicitly enabled.
      // Complete it before enabling the queue drain so normal settlement cannot
      // race the controlled historical correction.
      const historicalResettlement = await this.processor.runHistoricalResettlementOnce();
      this.initialized = true;
      this.lastStartupSuccessAt = new Date();
      this.lastStartupError = undefined;
      // Start queue draining before any monitoring or audit operations that may fail.
      this.wake(0);
      this.adminGateway.setModuleOperationalStatus('settlement', 'READY', 'Settlement worker recovery completed.', { recoveredLeases: recovered, historicalResettlement });
      this.adminGateway.publishModuleEvent('settlement', 'settlement:worker-ready', { recoveredLeases: recovered, historicalResettlement, occurredAt: new Date().toISOString() });
      this.systemMonitor.reportModuleHealth('settlement', 'HEALTHY', { source: 'worker-recovery', message: 'Settlement worker recovery completed.', details: { recoveredLeases: recovered, historicalResettlement } });
      this.logger.log(
        `Settlement worker initialized. Recovered abandoned leases=${recovered}; historical resettlement=${JSON.stringify(historicalResettlement)}.`,
      );
      // Queue readiness must not depend on an audit-event insert succeeding.
      try {
        await this.eventLog.write({
          level: SettlementEventLevel.INFO,
          action: 'SETTLEMENT_WORKER_READY',
          message:
            'Event-triggered settlement worker completed startup recovery.',
          metadata: { recoveredLeases: recovered, historicalResettlement },
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
        this.adminGateway.setModuleOperationalStatus('settlement', 'DEGRADED', message);
        this.adminGateway.publishModuleEvent('settlement', 'settlement:worker-error', { phase: 'startup-recovery', message, occurredAt: new Date().toISOString() });
        this.systemMonitor.reportModuleHealth('settlement', 'DEGRADED', { source: 'worker-recovery', message });
        this.systemMonitor.reportError({ module: 'settlement', source: 'worker-recovery', operation: 'startup-recovery', message, occurredAt: new Date(), stack: error instanceof Error ? error.stack : undefined });
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
    this.drainCycles += 1;
    this.lastDrainStartedAt = new Date();
    let processed = 0;
    try {
      this.systemMonitor.reportActivity({ module: 'settlement', source: 'worker', operation: 'drain', status: 'INFO', message: 'Settlement queue drain started.', occurredAt: new Date() });
      this.adminGateway.publishModuleEvent('settlement', 'settlement:drain-started', { occurredAt: new Date().toISOString() });
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
      this.adminGateway.setModuleOperationalStatus('settlement', 'DEGRADED', this.errorMessage(error));
      this.adminGateway.publishModuleEvent('settlement', 'settlement:worker-error', { phase: 'drain', message: this.errorMessage(error), occurredAt: new Date().toISOString() });
      this.systemMonitor.reportModuleHealth('settlement', 'DEGRADED', { source: 'worker', message: this.errorMessage(error) });
      this.systemMonitor.reportError({ module: 'settlement', source: 'worker', operation: 'drain', message: this.errorMessage(error), occurredAt: new Date(), stack: error instanceof Error ? error.stack : undefined });
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
      this.busy = false;
      this.lastDrainCompletedAt = new Date();
      if (
        this.wakeRequested ||
        processed >= SETTLEMENT_CONFIG.queue.maximumJobsPerDrain
      ) {
        this.wake(0);
      } else {
        try {
          const nextAt = await this.queue.getNextWakeAt();
          if (nextAt) this.wake(Math.max(0, nextAt.getTime() - Date.now()));
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
    this.activeJob = { jobKey: job.jobKey, eventId: job.eventId, leagueId: job.leagueId, startedAt: new Date(startedAt), attempt: job.attempts };
    this.adminGateway.publishModuleEvent('settlement', 'settlement:job-started', { jobKey: job.jobKey, eventId: job.eventId, leagueId: job.leagueId, attempt: job.attempts, occurredAt: new Date().toISOString() });
    const leaseHeartbeat = setInterval(() => {
      void this.queue.renewProcessingLease(job._id, this.workerId).then((renewed) => {
        if (!renewed) {
          this.logger.warn(`Settlement lease is no longer owned by this worker for job ${job.jobKey}.`);
        }
      }).catch((error) => {
        this.logger.warn(`Could not renew Settlement lease for ${job.jobKey}: ${this.errorMessage(error)}`);
      });
    }, SETTLEMENT_CONFIG.queue.leaseHeartbeatIntervalMs);
    leaseHeartbeat.unref?.();
    try {
      const result = await this.processor.process(job);
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
      // A successful processor/queue cycle proves the worker has recovered.
      // Partial target outcomes remain visible in queue counts and unresolvedReasons.
      this.systemMonitor.reportModuleHealth('settlement', 'HEALTHY', {
        source: 'worker',
        message: result.skipped
          ? `Settlement worker safely skipped ${job.jobKey}; fixture lifecycle is not confirmed.`
          : result.partial
            ? `Settlement worker recovered and processed ${job.jobKey}; unresolved targets remain.`
            : `Settlement processing successfully completed job ${job.jobKey}.`,
        details: { eventId: job.eventId, partial: result.partial, skipped: result.skipped === true, durationMs, counts: result.counts },
      });
      this.adminGateway.setModuleOperationalStatus(
        'settlement',
        'READY',
        result.skipped
          ? `Settlement worker skipped event ${job.eventId}; fixture lifecycle is not confirmed.`
          : result.partial
            ? `Settlement worker is running; event ${job.eventId} still has unresolved targets.`
            : `Settlement worker completed event ${job.eventId}.`,
        { eventId: job.eventId, partial: result.partial, skipped: result.skipped === true, durationMs, counts: result.counts },
      );
      this.adminGateway.publishModuleEvent(
        'settlement',
        rerunQueued ? 'settlement:job-requeued' : result.skipped ? 'settlement:job-skipped' : 'settlement:job-completed',
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
      this.adminGateway.publishModuleEvent('settlement', 'settlement:job-failed', { jobKey: job.jobKey, eventId: job.eventId, terminal: outcome.terminal, retryAt: outcome.retryAt?.toISOString(), message, occurredAt: new Date().toISOString() });
      this.systemMonitor.reportError({
        module: 'settlement', source: 'worker', operation: 'process-job', message,
        occurredAt: new Date(), stack: error instanceof Error ? error.stack : undefined,
        referenceKey: job.jobKey,
      });
      this.systemMonitor.reportActivity({
        module: 'settlement', source: 'worker', operation: 'process-job', status: 'FAILED',
        message: `Settlement job ${job.jobKey} failed; ${outcome.terminal ? 'terminal failure' : 'retry scheduled'}.`,
        occurredAt: new Date(), durationMs: Date.now() - startedAt, referenceKey: job.jobKey,
      });
      if (outcome.terminal) {
        this.systemMonitor.reportModuleHealth('settlement', 'DEGRADED', {
          source: 'worker', message: `Settlement job ${job.jobKey} exhausted retries: ${message}`,
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
      this.activeJob = undefined;
      clearInterval(leaseHeartbeat);
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
