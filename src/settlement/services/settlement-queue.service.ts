import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter } from 'node:events';
import { Model } from 'mongoose';
import { EspnFixture } from '../../sports/schemas/espn/espn-fixture.schema';
import {
  SettlementJob,
  SettlementJobDocument,
} from '../schemas/settlement-job.schema';
import { SettlementJobStatus } from '../enums/settlement-job-status.enum';
import { SETTLEMENT_CONFIG } from '../config/settlement.config';
import { createSettlementSourceFingerprint } from '../utils/summary-fingerprint.util';
import { isFixtureRefreshConfirmedFinished } from '../utils/fixture-lifecycle.util';

interface FixtureRecord {
  eventId?: unknown;
  leagueId?: unknown;
  completed?: unknown;
  live?: unknown;
  status?: unknown;
  statusDetail?: unknown;
  statusShortDetail?: unknown;
  homeScore?: unknown;
  awayScore?: unknown;
  payload?: unknown;
  collectedAt?: unknown;
}

@Injectable()
export class SettlementQueueService {
  private readonly signal = new EventEmitter();

  constructor(
    @InjectModel(SettlementJob.name)
    private readonly jobModel: Model<SettlementJobDocument>,
    @InjectModel(EspnFixture.name)
    private readonly fixtureModel: Model<EspnFixture>,
  ) {
    this.signal.setMaxListeners(0);
  }

  onEnqueued(listener: () => void): void {
    this.signal.on('queued', listener);
  }
  offEnqueued(listener: () => void): void {
    this.signal.off('queued', listener);
  }

  /**
   * Queue settlement only after an ESPN fixture/scoreboard refresh has persisted
   * an explicit finished state. Kickoff age and Summary status are not lifecycle
   * signals. Target creation and Summary updates may re-evaluate a fixture, but
   * cannot make an unfinished fixture eligible.
   */
  async enqueueForConfirmedFinishedFixture(
    eventIdValue: string,
    _leagueIdValue?: string,
    triggerReason = 'FIXTURE_REFRESHED',
  ) {
    const eventId = String(eventIdValue ?? '').trim();
    if (!eventId) return { enqueued: false, reason: 'EMPTY_EVENT_ID' as const };

    const fixture = (await this.fixtureModel
      .findOne({ eventId })
      .select({
        eventId: 1,
        leagueId: 1,
        completed: 1,
        live: 1,
        status: 1,
        statusDetail: 1,
        homeScore: 1,
        awayScore: 1,
        payload: 1,
        collectedAt: 1,
      })
      .lean()
      .exec()) as unknown as FixtureRecord | null;

    if (!fixture)
      return { enqueued: false, reason: 'FIXTURE_NOT_FOUND' as const };
    if (!isFixtureRefreshConfirmedFinished(fixture)) {
      return {
        enqueued: false,
        reason: 'FIXTURE_NOT_CONFIRMED_FINISHED_BY_FIXTURE_REFRESH' as const,
      };
    }

    const payload = this.asRecord(fixture.payload) ?? {};
    const now = new Date();
    const sourceFingerprint = createSettlementSourceFingerprint(fixture);
    const sourceAt =
      this.toDate(payload.summaryCollectedAt ?? fixture.collectedAt) ?? now;
    const jobKey = `${eventId}:${sourceFingerprint}`;
    const leagueId =
      typeof fixture.leagueId === 'string' ||
      typeof fixture.leagueId === 'number'
        ? String(fixture.leagueId).toLowerCase()
        : '';

    let job = await this.jobModel
      .findOneAndUpdate(
        { jobKey },
        {
          $setOnInsert: {
            jobKey,
            eventId,
            leagueId,
            sourceFingerprint,
            sourceSummaryCollectedAt: sourceAt,
            status: SettlementJobStatus.QUEUED,
            attempts: 0,
            maximumAttempts: SETTLEMENT_CONFIG.queue.maximumAttempts,
            priority: 1,
            nextRunAt: now,
            triggerReason,
          },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      )
      .exec();

    if (!job)
      throw new Error(`Could not queue settlement for event ${eventId}`);

    const targetCreated =
      triggerReason === 'PREDICTION_CREATED' ||
      triggerReason === 'BET_LAB_TICKET_CREATED';

    // Only a genuinely new settlement target should request a follow-up pass
    // while this exact source snapshot is processing. Routine scans of the same
    // unresolved target must not schedule duplicate immediate runs.
    if (job.status === SettlementJobStatus.PROCESSING) {
      if (!targetCreated) {
        return {
          enqueued: false,
          alreadyExists: true,
          reason: 'ALREADY_PROCESSING_NO_NEW_TARGET' as const,
          jobKey,
        };
      }
      if (job.rerunRequested) {
        return {
          enqueued: false,
          alreadyExists: true,
          reason: 'RERUN_ALREADY_REQUESTED' as const,
          jobKey,
        };
      }
      const marked = await this.jobModel.updateOne(
        { _id: job._id, status: SettlementJobStatus.PROCESSING, rerunRequested: { $ne: true } },
        { $set: { rerunRequested: true, rerunTriggerReason: triggerReason } },
      ).exec();
      if ((marked.modifiedCount ?? 0) > 0) {
        this.signal.emit('queued');
        return {
          enqueued: true,
          alreadyExists: true,
          scheduledAt: now,
          reason: 'RERUN_REQUESTED_FOR_NEW_TARGET' as const,
          jobKey,
        };
      }
      job = (await this.jobModel.findById(job._id).exec()) ?? job;
    }

    // Incomplete or failed work must not become permanently inactive. New-target
    // events bypass the cooldown; later fixture/summary/target events can reawaken
    // the same source snapshot once its persisted recovery time has elapsed.
    const recoverableStatuses = [
      SettlementJobStatus.COMPLETED,
      SettlementJobStatus.PARTIAL,
      SettlementJobStatus.FAILED,
      SettlementJobStatus.SKIPPED,
    ];
    if (recoverableStatuses.includes(job.status)) {
      const bypassCooldown = targetCreated;
      const nextRunAt = this.toDate(job.nextRunAt);
      const recoveryDelayMs = this.recoveryDelayForStatus(job.status);
      const updatedAt = this.toDate((job as unknown as { updatedAt?: unknown }).updatedAt);
      // Older queue records may not have nextRunAt populated. Use their update
      // time plus a status-specific cooldown rather than retrying them every scan.
      const effectiveRecoveryAt = nextRunAt ?? new Date(
        (updatedAt?.getTime() ?? 0) + recoveryDelayMs,
      );
      if (!bypassCooldown && effectiveRecoveryAt.getTime() > now.getTime()) {
        return {
          enqueued: false,
          alreadyExists: true,
          reason: `${job.status}_RECOVERY_COOLDOWN`,
          scheduledAt: effectiveRecoveryAt,
          jobKey,
        };
      }

      const missingScheduleCutoff = new Date(now.getTime() - recoveryDelayMs);
      const recoveryFilter = {
        _id: job._id,
        status: job.status,
        ...(!bypassCooldown ? {
          $or: [
            { nextRunAt: { $lte: now } },
            {
              $and: [
                { $or: [{ nextRunAt: { $exists: false } }, { nextRunAt: null }] },
                { updatedAt: { $lte: missingScheduleCutoff } },
              ],
            },
          ],
        } : {}),
      };
      const recoveredJob = await this.jobModel.findOneAndUpdate(
        recoveryFilter,
        {
          $set: {
            status: SettlementJobStatus.RETRY,
            attempts: 0,
            maximumAttempts: SETTLEMENT_CONFIG.queue.maximumAttempts,
            nextRunAt: now,
            triggerReason: targetCreated ? `NEW_TARGET_AFTER_${job.status}` : `RECOVERY_${triggerReason}`,
            rerunRequested: false,
          },
          $unset: {
            lockedAt: 1,
            lockedBy: 1,
            startedAt: 1,
            completedAt: 1,
            lastError: 1,
            rerunTriggerReason: 1,
          },
        },
        { returnDocument: 'after' },
      ).exec();
      if (recoveredJob) {
        this.signal.emit('queued');
        return {
          enqueued: true,
          alreadyExists: true,
          reason: targetCreated ? 'REQUEUED_FOR_NEW_TARGET' : 'RECOVERED_TERMINAL_JOB',
          scheduledAt: now,
          jobKey,
        };
      }
      return {
        enqueued: false,
        alreadyExists: true,
        reason: 'JOB_STATE_CHANGED_DURING_RECOVERY',
        jobKey,
      };
    }

    if (job.status === SettlementJobStatus.QUEUED) {
      // Newly eligible jobs are immediate.
      await this.jobModel.updateOne(
        { _id: job._id, status: SettlementJobStatus.QUEUED },
        { $set: { nextRunAt: now } },
      ).exec();
      this.signal.emit('queued');
      return {
        enqueued: true,
        alreadyExists: true,
        scheduledAt: now,
        reason: job.status,
        jobKey,
      };
    }

    if (job.status === SettlementJobStatus.RETRY) {
      // Do not wake the worker for a retry that is still inside its backoff.
      // The worker keeps a durable timer for nextRunAt; fresh fixture/target
      // events can also wake it when a new pass is justified.
      const retryAt = this.toDate(job.nextRunAt) ?? now;
      const isDue = retryAt.getTime() <= now.getTime();
      if (isDue) this.signal.emit('queued');
      return {
        enqueued: isDue,
        alreadyExists: true,
        scheduledAt: retryAt,
        reason: isDue ? 'RETRY_DUE' : 'RETRY_BACKOFF',
        jobKey,
      };
    }

    return {
      enqueued: false,
      alreadyExists: true,
      scheduledAt: this.toDate(job.nextRunAt) ?? now,
      reason: job.status,
      jobKey,
    };
  }

  async recoverExpiredProcessingJobs(): Promise<number> {
    const staleBefore = new Date(
      Date.now() - SETTLEMENT_CONFIG.queue.processingLeaseMinutes * 60_000,
    );
    const stale = (await this.jobModel
      .find({
        status: SettlementJobStatus.PROCESSING,
        lockedAt: { $lte: staleBefore },
      })
      .select({ _id: 1, attempts: 1, maximumAttempts: 1 })
      .lean()
      .exec()) as unknown as Array<{
      _id: SettlementJobDocument['_id'];
      attempts?: number;
      maximumAttempts?: number;
    }>;
    let recovered = 0;
    for (const item of stale) {
      const terminal =
        Number(item.attempts ?? 0) >=
        Number(item.maximumAttempts ?? SETTLEMENT_CONFIG.queue.maximumAttempts);
      const result = await this.jobModel
        .updateOne(
          {
            _id: item._id,
            status: SettlementJobStatus.PROCESSING,
            lockedAt: { $lte: staleBefore },
          },
          {
            $set: {
              status: terminal
                ? SettlementJobStatus.FAILED
                : SettlementJobStatus.RETRY,
              nextRunAt: terminal
                ? new Date(Date.now() + SETTLEMENT_CONFIG.queue.failedRecoveryIntervalMs)
                : new Date(),
              lastError:
                'Recovered an interrupted settlement worker lease during recovery.',
              ...(terminal ? { completedAt: new Date() } : {}),
            },
            $unset: {
              lockedAt: 1,
              lockedBy: 1,
              rerunRequested: 1,
              rerunTriggerReason: 1,
              ...(terminal ? {} : { completedAt: 1 }),
            },
          },
        )
        .exec();
      recovered += result.modifiedCount ?? 0;
    }
    return recovered;
  }

  async renewProcessingLease(
    jobId: SettlementJobDocument['_id'],
    workerId: string,
  ): Promise<boolean> {
    const result = await this.jobModel.updateOne(
      {
        _id: jobId,
        status: SettlementJobStatus.PROCESSING,
        lockedBy: workerId,
      },
      { $set: { lockedAt: new Date() } },
    ).exec();
    return (result.modifiedCount ?? 0) > 0;
  }

  async claimNextDueJob(
    workerId: string,
  ): Promise<SettlementJobDocument | null> {
    const now = new Date();
    return this.jobModel
      .findOneAndUpdate(
        {
          status: {
            $in: [SettlementJobStatus.QUEUED, SettlementJobStatus.RETRY],
          },
          nextRunAt: { $lte: now },
        },
        {
          $set: {
            status: SettlementJobStatus.PROCESSING,
            lockedAt: now,
            lockedBy: workerId,
            startedAt: now,
          },
          $inc: { attempts: 1 },
          $unset: { lastError: 1 },
        },
        {
          returnDocument: 'after',
          sort: { priority: 1, nextRunAt: 1, createdAt: 1 },
        },
      )
      .exec();
  }

  async complete(
    job: SettlementJobDocument,
    input: {
      partial: boolean;
      skipped?: boolean;
      counts: Record<string, number>;
      unresolvedReasons: string[];
      durationMs: number;
    },
  ): Promise<boolean> {
    if (await this.requeueRequestedRun(job, input)) return true;

    const completed = await this.jobModel
      .updateOne(
        {
          _id: job._id,
          status: SettlementJobStatus.PROCESSING,
          rerunRequested: { $ne: true },
        },
        {
          $set: {
            status: input.skipped
              ? SettlementJobStatus.SKIPPED
              : input.partial
                ? SettlementJobStatus.PARTIAL
                : SettlementJobStatus.COMPLETED,
            nextRunAt: new Date(Date.now() + (
              input.skipped
                ? SETTLEMENT_CONFIG.queue.skippedRecoveryIntervalMs
                : input.partial
                  ? SETTLEMENT_CONFIG.queue.partialRetryDelayMs
                  : SETTLEMENT_CONFIG.queue.completedTargetRecoveryIntervalMs
            )),
            resultCounts: input.counts,
            unresolvedReasons: input.unresolvedReasons.slice(0, 100),
            lastDurationMs: input.durationMs,
            completedAt: new Date(),
          },
          $unset: { lockedAt: 1, lockedBy: 1, lastError: 1 },
        },
      )
      .exec();

    // Close the narrow race where a new target marks rerunRequested between
    // the first check and the completion update.
    if ((completed.modifiedCount ?? 0) === 0) {
      return this.requeueRequestedRun(job, input);
    }
    return false;
  }

  private async requeueRequestedRun(
    job: SettlementJobDocument,
    input: {
      counts: Record<string, number>;
      unresolvedReasons: string[];
      durationMs: number;
    },
  ): Promise<boolean> {
    const rerun = await this.jobModel
      .findOneAndUpdate(
        {
          _id: job._id,
          status: SettlementJobStatus.PROCESSING,
          rerunRequested: true,
        },
        {
          $set: {
            status: SettlementJobStatus.QUEUED,
            attempts: 0,
            maximumAttempts: SETTLEMENT_CONFIG.queue.maximumAttempts,
            nextRunAt: new Date(),
            triggerReason: 'TARGET_CREATED_DURING_PROCESSING',
            resultCounts: input.counts,
            unresolvedReasons: input.unresolvedReasons.slice(0, 100),
            lastDurationMs: input.durationMs,
          },
          $unset: {
            lockedAt: 1,
            lockedBy: 1,
            lastError: 1,
            completedAt: 1,
            startedAt: 1,
            rerunRequested: 1,
            rerunTriggerReason: 1,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!rerun) return false;
    this.signal.emit('queued');
    return true;
  }

  async fail(
    job: SettlementJobDocument,
    error: unknown,
  ): Promise<{ terminal: boolean; retryAt?: Date }> {
    const now = new Date();
    const attempts = Number(job.attempts ?? 1);
    const maxAttempts = Number(job.maximumAttempts ?? SETTLEMENT_CONFIG.queue.maximumAttempts);
    const terminal = attempts >= maxAttempts;
    const delay = Math.min(
      SETTLEMENT_CONFIG.queue.maximumRetryDelayMs,
      SETTLEMENT_CONFIG.queue.initialRetryDelayMs * Math.pow(2, Math.max(0, attempts - 1)),
    );
    const normalRetryAt = terminal ? undefined : new Date(now.getTime() + delay);
    const lastError = this.errorMessage(error).slice(0, 3000);

    // If a new processing pass was requested while this job was running, retry
    // immediately (but still obey the attempt ceiling). Otherwise preserve backoff.
    for (const rerunRequested of [true, false, true]) {
      const retryAt = terminal ? undefined : rerunRequested ? now : normalRetryAt;
      const result = await this.jobModel.updateOne(
        {
          _id: job._id,
          status: SettlementJobStatus.PROCESSING,
          ...(rerunRequested
            ? { rerunRequested: true }
            : { rerunRequested: { $ne: true } }),
        },
        {
          $set: {
            status: terminal ? SettlementJobStatus.FAILED : SettlementJobStatus.RETRY,
            nextRunAt: terminal
              ? new Date(now.getTime() + SETTLEMENT_CONFIG.queue.failedRecoveryIntervalMs)
              : retryAt ?? now,
            lastError,
            ...(terminal ? { completedAt: now } : {}),
          },
          $unset: {
            lockedAt: 1,
            lockedBy: 1,
            rerunRequested: 1,
            rerunTriggerReason: 1,
            ...(terminal ? {} : { completedAt: 1 }),
          },
        },
      ).exec();
      if ((result.modifiedCount ?? 0) > 0) {
        if (retryAt) this.signal.emit('queued');
        return { terminal, retryAt };
      }
    }

    // A separate worker or completion handler may already have transitioned the
    // job. Do not overwrite that terminal/queued state.
    return { terminal, retryAt: normalRetryAt };
  }

  async requeueFinishedFixture(
    eventIdValue: string,
    _leagueIdValue?: string,
  ): Promise<{ queued: boolean; jobKey?: string; reason: string }> {
    const eventId = String(eventIdValue ?? '').trim();
    if (!eventId) return { queued: false, reason: 'EMPTY_EVENT_ID' };
    const fixture = (await this.fixtureModel
      .findOne({ eventId })
      .select({
        eventId: 1,
        leagueId: 1,
        completed: 1,
        status: 1,
        statusDetail: 1,
        homeScore: 1,
        awayScore: 1,
        live: 1,
        payload: 1,
        collectedAt: 1,
      })
      .lean()
      .exec()) as unknown as FixtureRecord | null;
    if (!fixture) return { queued: false, reason: 'FIXTURE_NOT_FOUND' };
    if (!isFixtureRefreshConfirmedFinished(fixture)) {
      return {
        queued: false,
        reason: 'FIXTURE_NOT_CONFIRMED_FINISHED_BY_FIXTURE_REFRESH',
      };
    }

    const payload = this.asRecord(fixture.payload) ?? {};
    const sourceFingerprint = createSettlementSourceFingerprint(fixture);
    const jobKey = `${eventId}:${sourceFingerprint}`;
    const now = new Date();
    const leagueId =
      typeof fixture.leagueId === 'string' ||
      typeof fixture.leagueId === 'number'
        ? String(fixture.leagueId).toLowerCase()
        : '';

    // Make requeue a single atomic transition. The previous read-modify-save
    // pattern could read a queued job, race with a worker claim, then save stale
    // PROCESSING fields back as QUEUED and allow a second worker to claim it.
    try {
      const requeued = await this.jobModel
        .findOneAndUpdate(
          { jobKey, status: { $ne: SettlementJobStatus.PROCESSING } },
          {
            $set: {
              eventId,
              leagueId,
              sourceFingerprint,
              sourceSummaryCollectedAt:
                this.toDate(payload.summaryCollectedAt ?? fixture.collectedAt) ??
                now,
              status: SettlementJobStatus.QUEUED,
              attempts: 0,
              maximumAttempts: SETTLEMENT_CONFIG.queue.maximumAttempts,
              priority: 1,
              nextRunAt: now,
              triggerReason: 'ADMIN_MANUAL_REQUEUE',
              unresolvedReasons: [],
              rerunRequested: false,
            },
            $setOnInsert: { jobKey },
            $unset: {
              lockedAt: 1,
              lockedBy: 1,
              lastError: 1,
              lastDurationMs: 1,
              completedAt: 1,
              startedAt: 1,
              rerunTriggerReason: 1,
              resultCounts: 1,
            },
          },
          {
            upsert: true,
            returnDocument: 'after',
            setDefaultsOnInsert: true,
          },
        )
        .exec();
      if (!requeued) {
        return { queued: false, jobKey, reason: 'JOB_STATE_CHANGED' };
      }
    } catch (error) {
      // If a worker claimed the same job immediately before this atomic upsert,
      // the status predicate prevents mutation and the unique jobKey makes the
      // upsert fail safely. Report that state rather than disturbing the lease.
      const code = Number((error as { code?: unknown })?.code);
      if (code !== 11000) throw error;
      const latest = (await this.jobModel
        .findOne({ jobKey })
        .select({ status: 1 })
        .lean()
        .exec()) as unknown as { status?: SettlementJobStatus } | null;
      if (latest?.status === SettlementJobStatus.PROCESSING) {
        return { queued: false, jobKey, reason: 'ALREADY_PROCESSING' };
      }
      // Another producer may have inserted the same job key. Retry the guarded
      // transition without upsert so it cannot create/overwrite a processing job.
      const retried = await this.jobModel
        .findOneAndUpdate(
          { jobKey, status: { $ne: SettlementJobStatus.PROCESSING } },
          {
            $set: {
              status: SettlementJobStatus.QUEUED,
              attempts: 0,
              maximumAttempts: SETTLEMENT_CONFIG.queue.maximumAttempts,
              nextRunAt: now,
              triggerReason: 'ADMIN_MANUAL_REQUEUE',
              unresolvedReasons: [],
              rerunRequested: false,
            },
            $unset: {
              lockedAt: 1,
              lockedBy: 1,
              lastError: 1,
              lastDurationMs: 1,
              completedAt: 1,
              startedAt: 1,
              rerunTriggerReason: 1,
              resultCounts: 1,
            },
          },
          { returnDocument: 'after' },
        )
        .exec();
      if (!retried) {
        return { queued: false, jobKey, reason: 'JOB_STATE_CHANGED' };
      }
    }

    this.signal.emit('queued');
    return { queued: true, jobKey, reason: 'QUEUED' };
  }

  async getNextWakeAt(): Promise<Date | undefined> {
    const next = (await this.jobModel
      .findOne({
        status: {
          $in: [SettlementJobStatus.QUEUED, SettlementJobStatus.RETRY],
        },
      })
      .sort({ nextRunAt: 1 })
      .select({ nextRunAt: 1 })
      .lean()
      .exec()) as unknown as { nextRunAt?: Date } | null;
    return next?.nextRunAt ? new Date(next.nextRunAt) : undefined;
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = (await this.jobModel
      .aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
      .exec()) as Array<{ _id: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row._id, row.count]));
  }

  private recoveryDelayForStatus(status: SettlementJobStatus): number {
    switch (status) {
      case SettlementJobStatus.PARTIAL:
        return SETTLEMENT_CONFIG.queue.partialRetryDelayMs;
      case SettlementJobStatus.FAILED:
        return SETTLEMENT_CONFIG.queue.failedRecoveryIntervalMs;
      case SettlementJobStatus.SKIPPED:
        return SETTLEMENT_CONFIG.queue.skippedRecoveryIntervalMs;
      case SettlementJobStatus.COMPLETED:
      default:
        return SETTLEMENT_CONFIG.queue.completedTargetRecoveryIntervalMs;
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return undefined;
    return value as Record<string, unknown>;
  }
  private toDate(value: unknown): Date | undefined {
    if (!value) return undefined;
    if (value instanceof Date)
      return Number.isNaN(value.getTime()) ? undefined : value;
    if (typeof value !== 'string' && typeof value !== 'number')
      return undefined;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string' || typeof error === 'number')
      return String(error);
    return 'Unknown settlement error';
  }
}
