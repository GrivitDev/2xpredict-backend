import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { ConnectionStates, Model } from 'mongoose';
import { CustomerCareJob } from '../schemas/customer-care-job.schema';
import { DailyBroadcastService } from './daily-broadcast.service';
import { SupportEscalationService } from './support-escalation.service';
import { SystemMonitorService } from '../../system-monitor/system-monitor.service';

interface WorkerJob {
  _id: unknown;
  type: string;
  dateKey: string;
  sourceId: string;
  jobKey: string;
  payload: Record<string, unknown>;
  attempts: number;
  scheduledAt: Date;
}

@Injectable()
export class CustomerCareWorkerService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(CustomerCareWorkerService.name);
  private readonly broadcastHour: number;
  private running = false;
  private stopped = false;

  constructor(
    @InjectModel(CustomerCareJob.name)
    private readonly jobs: Model<CustomerCareJob>,
    private readonly broadcasts: DailyBroadcastService,
    private readonly escalation: SupportEscalationService,
    private readonly config: ConfigService,
    private readonly systemMonitor: SystemMonitorService,
  ) {
    const configured = Number(
      this.config.get<string>('CUSTOMER_CARE_BROADCAST_HOUR') ?? 8,
    );
    this.broadcastHour =
      Number.isInteger(configured) && configured >= 0 && configured <= 23
        ? configured
        : 8;
  }

  async onModuleInit(): Promise<void> {
    // Retire legacy job rows from the removed private/admin Telegram notifier.
    // Keep this best-effort so a temporary database outage does not block startup.
    try {
      await this.jobs.updateMany(
        {
          type: { $in: ['SUPPORT_NOTIFICATION', 'INCIDENT_ALERT'] },
          status: { $in: ['PENDING', 'PROCESSING'] },
        },
        {
          $set: {
            status: 'FAILED',
            lastError: 'Private/admin Telegram notifications are disabled. Only AI public-channel broadcasts are supported.',
          },
          $unset: { leaseExpiresAt: 1 },
        },
      ).exec();
    } catch (error) {
      this.logger.warn(
        `Could not retire legacy private/admin Telegram jobs during startup: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
  }


  /** Five-minute durable-job tick. Event creation remains unchanged; queued work is picked up on the next tick. */
  @Interval(5 * 60_000)
  async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      // MongoDB-backed jobs cannot be claimed or persisted during a database
      // outage. Report the outage through System Monitor; broadcast jobs resume
      // automatically when the database connection is restored.
      if (this.jobs.db.readyState !== ConnectionStates.connected) {
        const readyState = this.jobs.db.readyState;
        this.systemMonitor.reportModuleHealth('database', 'FAILED', {
          source: 'customer-care-worker',
          message: `MongoDB is unavailable (readyState ${readyState}); durable Customer Care jobs are paused.`,
          details: { readyState },
          checkedAt: new Date(),
        });
        this.systemMonitor.reportModuleHealth(
          'customer-care-worker',
          'DEGRADED',
          {
            source: 'customer-care-worker',
            message:
              'Customer Care worker paused because MongoDB is unavailable.',
            checkedAt: new Date(),
          },
        );
        return;
      }

      const dateKey = lagosDateKey(new Date());
      if (lagosHour(new Date()) >= this.broadcastHour)
        await this.ensureDailyJobs(dateKey);
      await this.failExpiredJobs();
      const job = await this.claimOneJob();
      if (job) await this.processJob(job);
      this.systemMonitor.reportModuleHealth('customer-care-worker', 'HEALTHY', {
        source: 'customer-care-worker',
        message: 'Customer Care background worker tick completed.',
        checkedAt: new Date(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Customer Care worker tick failed: ${message}`);
      this.systemMonitor.reportModuleHealth(
        'customer-care-worker',
        'DEGRADED',
        {
          source: 'customer-care-worker',
          message: message.slice(0, 450),
          checkedAt: new Date(),
        },
      );
    } finally {
      this.running = false;
    }
  }

  private async ensureDailyJobs(dateKey: string): Promise<void> {
    for (const type of ['DAILY_PICKS', 'PROMOTION'] as const) {
      const jobKey = `${type}:${dateKey}`;
      await this.jobs
        .updateOne(
          { jobKey },
          {
            $setOnInsert: {
              jobKey,
              type,
              dateKey,
              sourceId: '',
              payload: {},
              status: 'PENDING',
              scheduledAt: new Date(),
              attempts: 0,
              lastError: '',
            },
          },
          { upsert: true },
        )
        .exec();
    }
  }

  private async failExpiredJobs(): Promise<void> {
    await this.jobs
      .updateMany(
        {
          status: 'PROCESSING',
          leaseExpiresAt: { $lte: new Date() },
          attempts: { $gte: 4 },
        },
        {
          $set: {
            status: 'FAILED',
            lastError:
              'Worker lease expired after the maximum number of attempts.',
          },
          $unset: { leaseExpiresAt: 1 },
        },
      )
      .exec();
  }

  private async claimOneJob(): Promise<WorkerJob | null> {
    const now = new Date();
    return this.jobs
      .findOneAndUpdate(
        {
          type: { $in: ['DAILY_PICKS', 'PROMOTION'] },
          attempts: { $lt: 4 },
          $or: [
            { status: 'PENDING', scheduledAt: { $lte: now } },
            { status: 'PROCESSING', leaseExpiresAt: { $lte: now } },
          ],
        },
        {
          $set: {
            status: 'PROCESSING',
            leaseExpiresAt: new Date(now.getTime() + 4 * 60_000),
            lastError: '',
          },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after', sort: { scheduledAt: 1, createdAt: 1 } },
      )
        .lean<WorkerJob>()
      .exec();
  }

  private async processJob(job: WorkerJob): Promise<void> {
    try {
      let result: Record<string, unknown>;
      if (job.type === 'DAILY_PICKS')
        result = await this.broadcasts.publishDailyPicks(job.dateKey);
      else if (job.type === 'PROMOTION')
        result = await this.broadcasts.publishDailyPromotions(job.dateKey);
      else
        throw new Error(
          `Unsupported Customer Care job type: ${String(job.type)}`,
        );

      if (result.deferred === true) {
        // Keep the durable job pending without burning its retry budget while a
        // prior send is still within the delivery ambiguity window.
        const requestedDelay =
          typeof result.retryAfterMs === 'number'
            ? result.retryAfterMs
            : typeof result.retryAfterMs === 'string'
              ? Number(result.retryAfterMs)
              : Number.NaN;
        const delayMs = Number.isFinite(requestedDelay)
          ? Math.min(60 * 60_000, Math.max(30_000, requestedDelay))
          : 30_000;
        await this.jobs
          .updateOne(
            { _id: job._id, status: 'PROCESSING' },
            {
              $set: {
                status: 'PENDING',
                scheduledAt: new Date(Date.now() + delayMs),
                lastError: safeText(
                  result.reason,
                  'Broadcast safely deferred.',
                ).slice(0, 500),
              },
              $inc: { attempts: -1 },
              $unset: { leaseExpiresAt: 1 },
            },
          )
          .exec();
        return;
      }
      if (result.requiresAdminReview === true) {
        // An ambiguous public-channel delivery must never be blindly replayed.
        // Preserve the broadcast's manual-review flag and record an incident
        // for the existing Customer Care admin workspace. No Telegram alert is sent.
        await this.escalation.createIncident({
          category: 'TELEGRAM_BROADCAST_DELIVERY',
          severity: 'HIGH',
          summary: `The ${String(job.type)} public-channel broadcast requires manual delivery verification before any retry.`,
          evidence: [
            `Job: ${String(job.jobKey)}.`,
            `Broadcast ID: ${safeText(result.broadcastId, 'unknown')}.`,
            `Reason: ${safeText(result.reason, 'Public-channel delivery outcome is ambiguous.').slice(0, 250)}.`,
          ],
          attemptedActions: [
            'The worker stopped automatic replay because the public channel may already have accepted the post.',
            'Administrator must inspect the public channel before confirming a retry.',
          ],
          fingerprint: `CUSTOMER_CARE_BROADCAST_REVIEW:${String(job.jobKey)}`,
        });
      }

      await this.jobs
        .updateOne(
          { _id: job._id, status: 'PROCESSING' },
          {
            $set: {
              status: 'COMPLETED',
              completedAt: new Date(),
              payload: { ...(job.payload ?? {}), result },
              lastError:
                result.requiresAdminReview === true
                  ? 'Completed with manual delivery review required.'
                  : '',
            },
            $unset: { leaseExpiresAt: 1 },
          },
        )
        .exec();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = Number(job.attempts || 1);
      const canRetry = attempts < 4;
      const backoffMs = Math.min(
        15 * 60_000,
        30_000 * 2 ** Math.max(0, attempts - 1),
      );
      await this.jobs
        .updateOne(
          { _id: job._id, status: 'PROCESSING' },
          {
            $set: {
              status: canRetry ? 'PENDING' : 'FAILED',
              scheduledAt: canRetry
                ? new Date(Date.now() + backoffMs)
                : job.scheduledAt,
              lastError: message.slice(0, 1200),
            },
            $unset: { leaseExpiresAt: 1 },
          },
        )
        .exec();
      this.logger.error(
        `Customer Care job ${String(job.jobKey)} failed (attempt ${attempts}): ${message}`,
      );
      if (!canRetry) {
        await this.escalation
          .createIncident({
            category: 'CUSTOMER_CARE_WORKER',
            severity: 'HIGH',
            summary: `Customer Care background job ${String(job.jobKey)} exhausted its retry attempts.`,
            evidence: [
              `Job type: ${String(job.type)}.`,
              `Last error: ${message.slice(0, 300)}`,
            ],
            attemptedActions: [
              `Automatic retry attempted ${attempts} times; the job remains failed.`,
            ],
            fingerprint: `CUSTOMER_CARE_JOB:${String(job.jobKey)}`,
          })
          .catch((incidentError) =>
            this.logger.error(
              `Could not escalate failed Customer Care job: ${incidentError instanceof Error ? incidentError.message : String(incidentError)}`,
            ),
          );
      }
    }
  }
}

function safeText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return fallback;
}

function lagosDateKey(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function lagosHour(value: Date): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    hour: '2-digit',
    hour12: false,
  }).format(value);
  return Number(hour) % 24;
}

