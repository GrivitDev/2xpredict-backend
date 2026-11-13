import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import type { SportsBootstrapPhase, SportsQueueEnqueueRequest, SportsQueueScope } from '../interfaces/sports-queue.interface';
import { SportsQueueJobStatus, SportsQueueLane, SportsQueueJobType } from '../interfaces/sports-queue.interface';
import { SportsQueue, SportsQueueDocument } from '../schemas/operations/sports-queue.schema';

export interface ClaimedSportsQueueJob {
  jobKey: string;
  type: SportsQueueJobType;
  scope: SportsQueueScope;
  priority: number;
  recurrence?: SportsQueueEnqueueRequest['recurrence'];
  attempts: number;
  maxAttempts: number;
  retryCount: number;
  triggerEventId?: string;
}

export interface BootstrapPhaseProgress {
  total: number;
  completed: number;
  pending: number;
  processing: number;
  failed: number;
  quarantined: number;
  isComplete: boolean;
  /** True once every tracked phase job is completed, failed, or quarantined. */
  isSettled: boolean;
  hasTerminalFailure: boolean;
}

export interface BootstrapPhaseFailure {
  jobKey: string;
  type: SportsQueueJobType;
  scope: SportsQueueScope;
  status: SportsQueueJobStatus;
  lastError?: string;
  failedAt?: Date;
}

@Injectable()
export class SportsQueueService {
  private wakeHandler?: (type?: SportsQueueJobType) => void;

  constructor(@InjectModel(SportsQueue.name) private readonly queueModel: Model<SportsQueueDocument>) {}

  setWakeHandler(handler: ((type?: SportsQueueJobType) => void) | undefined): void {
    this.wakeHandler = handler;
  }

  private notifyWorker(type: SportsQueueJobType): void {
    this.wakeHandler?.(type);
  }

  async enqueue(request: SportsQueueEnqueueRequest): Promise<{ created: boolean; jobKey: string }> {
    const scheduledFor = request.scheduledFor ?? new Date();
    const normalizedScope = this.sortObject((request.scope ?? {}) as Record<string, unknown>);
    const identity = JSON.stringify({
      type: request.type,
      scope: normalizedScope,
      scheduledFor: scheduledFor.toISOString(),
      triggerEventId: request.triggerEventId ?? null,
    });
    const jobKey = this.jobKey(identity);
    const result = await this.queueModel.updateOne(
      { jobKey },
      {
        $setOnInsert: {
          jobKey,
          type: request.type,
          scope: normalizedScope,
          priority: this.priority(request.priority),
          status: SportsQueueJobStatus.PENDING,
          lane: SportsQueueLane.NORMAL,
          scheduledFor,
          recurrence: request.recurrence,
          attempts: 0,
          maxAttempts: 20,
          retryCount: 0,
          triggerEventId: request.triggerEventId,
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    ).exec();
    const created = result.upsertedCount === 1;
    if (created) this.notifyWorker(request.type);
    return { created, jobKey };
  }

  /**
   * Idempotent enqueue for one-shot work and recurring seeds.
   * Completed jobs are also considered: otherwise a frequent fixture refresh
   * could enqueue an already-executed 18-hour milestone again every two minutes.
   * Recurring work remains live because scheduleNext creates its pending
   * successor before the current job is acknowledged.
   */
  async enqueueIfMissing(request: SportsQueueEnqueueRequest): Promise<{ created: boolean; jobKey?: string }> {
    const scope = this.sortObject((request.scope ?? {}) as Record<string, unknown>);
    // Match the scope field-by-field. MongoDB embedded-document equality is
    // sensitive to field order, while Mongoose serializes schema fields in its
    // own order. Also require omitted optional fields to be absent so bootstrap
    // jobs never collide with recurring jobs that have a different scope.
    const scopeFilter: Record<string, unknown> = { type: request.type };
    // Keep this list aligned with SportsQueueScopeEmbedded and SportsQueueScope.
    // Coalescing keys and source fingerprints must participate in identity;
    // otherwise an older completed job can suppress a later, distinct refresh.
    const scopeKeys = [
      'competitionId', 'leagueId', 'seasonId', 'seasonYear', 'teamId',
      'teamReference', 'fixtureId', 'fixtureIds', 'espnEventId', 'calendarDate',
      'bootstrapRunId', 'bootstrapPhase', 'milestone', 'expectedKickoffAt',
      'expectedCompletedAt', 'sourceKind', 'sourceFingerprint',
      'seasonBootstrap', 'seasonEndDate', 'youtubeAttempt',
      'projectionWindow', 'newsWindow', 'predictionSourceUpdatedAt', 'summaryAttempt',
      'backfillRunId', 'summaryBackfillRunId',
      'backfillCursorKickoffAt', 'backfillCursorFixtureId',
    ];
    for (const key of scopeKeys) {
      scopeFilter[`scope.${key}`] = Object.prototype.hasOwnProperty.call(scope, key)
        ? scope[key]
        : { $exists: false };
    }
    const existing = await this.queueModel.findOne(scopeFilter).select({ jobKey: 1 }).lean().exec();
    if (existing) return { created: false, jobKey: String(existing.jobKey) };
    return this.enqueue(request);
  }

  /**
   * Coalesce fixture-scoped recalculation triggers while one is already
   * pending or processing. A completed job does not suppress a later source
   * change, so the next revision can still be repriced.
   */
  async enqueueIfNoActiveFixtureJob(
    request: SportsQueueEnqueueRequest,
  ): Promise<{ created: boolean; jobKey: string }> {
    const scope = this.sortObject((request.scope ?? {}) as Record<string, unknown>);
    const fixtureId = String(scope.fixtureId ?? '').trim();
    if (!fixtureId) {
      throw new Error(
        `Cannot coalesce ${request.type}: a fixtureId is required in the job scope.`,
      );
    }

    const existing = await this.queueModel
      .findOne({
        type: request.type,
        'scope.fixtureId': fixtureId,
        status: {
          $in: [SportsQueueJobStatus.PENDING, SportsQueueJobStatus.PROCESSING],
        },
      })
      .select({ jobKey: 1 })
      .lean()
      .exec();
    if (existing) {
      return { created: false, jobKey: String(existing.jobKey) };
    }
    return this.enqueue(request);
  }

  async enqueueOrRestart(request: SportsQueueEnqueueRequest): Promise<{ created: boolean; jobKey: string }> {
    const scheduledFor = request.scheduledFor ?? new Date();
    const scope = this.sortObject((request.scope ?? {}) as Record<string, unknown>);
    const identity = JSON.stringify({ type: request.type, scope, scheduledFor: scheduledFor.toISOString(), triggerEventId: request.triggerEventId ?? null });
    const jobKey = this.jobKey(identity);
    const restarted = await this.queueModel.updateOne(
      { jobKey, status: { $in: [SportsQueueJobStatus.COMPLETED, SportsQueueJobStatus.QUARANTINED] } },
      {
        $set: {
          type: request.type,
          scope,
          priority: this.priority(request.priority),
          status: SportsQueueJobStatus.PENDING,
          lane: SportsQueueLane.NORMAL,
          scheduledFor,
          recurrence: request.recurrence,
          attempts: 0,
          maxAttempts: 20,
          retryCount: 0,
          triggerEventId: request.triggerEventId,
        },
        $unset: {
          ownerId: 1, heartbeatAt: 1, leaseExpiresAt: 1, nextAttemptAt: 1, nextRunAt: 1,
          startedAt: 1, completedAt: 1, failedAt: 1, lastError: 1,
        },
      },
    ).exec();
    if (restarted.modifiedCount === 1) {
      this.notifyWorker(request.type);
      return { created: true, jobKey };
    }
    return this.enqueue(request);
  }

  async hasActiveJob(type: SportsQueueJobType, competitionId: string, calendarDate: string): Promise<boolean> {
    const found = await this.queueModel.findOne({
      type,
      'scope.competitionId': competitionId,
      'scope.calendarDate': calendarDate,
      status: { $in: [SportsQueueJobStatus.PENDING, SportsQueueJobStatus.PROCESSING] },
    }).select({ _id: 1 }).lean().exec();
    return Boolean(found);
  }

  async hasActiveFixtureJob(
    type: SportsQueueJobType,
    fixtureId: string,
    attempt: number,
  ): Promise<boolean> {
    const found = await this.queueModel.findOne({
      type,
      'scope.fixtureId': fixtureId,
      'scope.youtubeAttempt': attempt,
      status: { $in: [SportsQueueJobStatus.PENDING, SportsQueueJobStatus.PROCESSING] },
    }).select({ _id: 1 }).lean().exec();
    return Boolean(found);
  }

  /** Read-only operational counters for one queue lane without loading job documents. */
  async getTypeOperationalSummary(type: SportsQueueJobType): Promise<{
    trackedCount: number;
    pendingCount: number;
    duePendingCount: number;
    processingCount: number;
    failedCount: number;
    quarantinedCount: number;
    staleProcessingCount: number;
    oldestPendingCreatedAt: Date | null;
    oldestDuePendingAt: Date | null;
    oldestProcessingStartedAt: Date | null;
    earliestProcessingLeaseExpiresAt: Date | null;
  }> {
    const now = new Date();
    const sentinel = new Date('9999-12-31T23:59:59.999Z');
    const duePending = {
      $and: [
        { $eq: ['$status', SportsQueueJobStatus.PENDING] },
        { $lte: [{ $ifNull: ['$scheduledFor', now] }, now] },
        { $lte: [{ $ifNull: ['$nextAttemptAt', now] }, now] },
      ],
    };
    const processing = { $eq: ['$status', SportsQueueJobStatus.PROCESSING] };

    const [row] = await this.queueModel.aggregate([
      {
        $match: {
          type,
          status: {
            $in: [
              SportsQueueJobStatus.PENDING,
              SportsQueueJobStatus.PROCESSING,
              SportsQueueJobStatus.FAILED,
              SportsQueueJobStatus.QUARANTINED,
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          trackedCount: { $sum: 1 },
          pendingCount: {
            $sum: { $cond: [{ $eq: ['$status', SportsQueueJobStatus.PENDING] }, 1, 0] },
          },
          duePendingCount: {
            $sum: { $cond: [duePending, 1, 0] },
          },
          processingCount: {
            $sum: { $cond: [processing, 1, 0] },
          },
          failedCount: {
            $sum: { $cond: [{ $eq: ['$status', SportsQueueJobStatus.FAILED] }, 1, 0] },
          },
          quarantinedCount: {
            $sum: { $cond: [{ $eq: ['$status', SportsQueueJobStatus.QUARANTINED] }, 1, 0] },
          },
          staleProcessingCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    processing,
                    { $lte: [{ $ifNull: ['$leaseExpiresAt', new Date(0)] }, now] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          oldestPendingCreatedAt: {
            $min: {
              $cond: [
                { $eq: ['$status', SportsQueueJobStatus.PENDING] },
                { $ifNull: ['$createdAt', sentinel] },
                sentinel,
              ],
            },
          },
          oldestDuePendingAt: {
            $min: {
              $cond: [
                duePending,
                { $ifNull: ['$nextAttemptAt', '$scheduledFor'] },
                sentinel,
              ],
            },
          },
          oldestProcessingStartedAt: {
            $min: {
              $cond: [processing, { $ifNull: ['$startedAt', sentinel] }, sentinel],
            },
          },
          earliestProcessingLeaseExpiresAt: {
            $min: {
              $cond: [processing, { $ifNull: ['$leaseExpiresAt', sentinel] }, sentinel],
            },
          },
        },
      },
    ]).exec();

    const toDateOrNull = (value: unknown): Date | null => {
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
      return value.getTime() >= sentinel.getTime() ? null : value;
    };

    return {
      trackedCount: Number(row?.trackedCount ?? 0),
      pendingCount: Number(row?.pendingCount ?? 0),
      duePendingCount: Number(row?.duePendingCount ?? 0),
      processingCount: Number(row?.processingCount ?? 0),
      failedCount: Number(row?.failedCount ?? 0),
      quarantinedCount: Number(row?.quarantinedCount ?? 0),
      staleProcessingCount: Number(row?.staleProcessingCount ?? 0),
      oldestPendingCreatedAt: toDateOrNull(row?.oldestPendingCreatedAt),
      oldestDuePendingAt: toDateOrNull(row?.oldestDuePendingAt),
      oldestProcessingStartedAt: toDateOrNull(row?.oldestProcessingStartedAt),
      earliestProcessingLeaseExpiresAt: toDateOrNull(row?.earliestProcessingLeaseExpiresAt),
    };
  }

  async getBootstrapPhaseProgress(runId: string, phase: SportsBootstrapPhase): Promise<BootstrapPhaseProgress> {
    const rows = await this.queueModel.aggregate([
      {
        $match: {
          'scope.bootstrapRunId': runId,
          'scope.bootstrapPhase': phase,
          type: { $nin: [SportsQueueJobType.BOOTSTRAP_PHASE_GATE, SportsQueueJobType.SEASON_DISCOVERY_PHASE_GATE] },
        },
      },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).exec();
    const counts = new Map<string, number>(rows.map((item: any) => [String(item._id), Number(item.count)]));
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    const completed = counts.get(SportsQueueJobStatus.COMPLETED) ?? 0;
    const pending = counts.get(SportsQueueJobStatus.PENDING) ?? 0;
    const processing = counts.get(SportsQueueJobStatus.PROCESSING) ?? 0;
    const failed = counts.get(SportsQueueJobStatus.FAILED) ?? 0;
    const quarantined = counts.get(SportsQueueJobStatus.QUARANTINED) ?? 0;
    return {
      total, completed, pending, processing, failed, quarantined,
      isComplete: total === completed,
      isSettled: pending === 0 && processing === 0,
      hasTerminalFailure: quarantined > 0 || failed > 0,
    };
  }

  /** Returns only terminal failures belonging to one startup phase. */
  async getBootstrapPhaseFailures(
    runId: string,
    phase: SportsBootstrapPhase,
  ): Promise<BootstrapPhaseFailure[]> {
    const rows = await this.queueModel
      .find({
        'scope.bootstrapRunId': runId,
        'scope.bootstrapPhase': phase,
        status: {
          $in: [SportsQueueJobStatus.FAILED, SportsQueueJobStatus.QUARANTINED],
        },
        type: {
          $nin: [
            SportsQueueJobType.BOOTSTRAP_PHASE_GATE,
            SportsQueueJobType.SEASON_DISCOVERY_PHASE_GATE,
          ],
        },
      })
      .select({ jobKey: 1, type: 1, scope: 1, status: 1, lastError: 1, failedAt: 1 })
      .limit(5_000)
      .lean()
      .exec();

    return (rows as any[]).map((row) => ({
      jobKey: String(row.jobKey),
      type: row.type as SportsQueueJobType,
      scope: (row.scope ?? {}) as SportsQueueScope,
      status: row.status as SportsQueueJobStatus,
      lastError: typeof row.lastError === 'string' ? row.lastError : undefined,
      failedAt: row.failedAt instanceof Date ? row.failedAt : undefined,
    }));
  }

  async claimNext(
    workerId: string,
    leaseMs = 120_000,
    jobType?: SportsQueueJobType,
  ): Promise<ClaimedSportsQueueJob | null> {
    const now = new Date();
    const document = await this.queueModel.findOneAndUpdate(
      {
        ...(jobType ? { type: jobType } : { type: { $in: Object.values(SportsQueueJobType) } }),
        status: SportsQueueJobStatus.PENDING,
        scheduledFor: { $lte: now },
        $or: [
          { nextAttemptAt: { $exists: false } },
          { nextAttemptAt: null },
          { nextAttemptAt: { $lte: now } },
        ],
      },
      {
        $set: {
          status: SportsQueueJobStatus.PROCESSING,
          ownerId: workerId,
          startedAt: now,
          lastAttemptAt: now,
          heartbeatAt: now,
          leaseExpiresAt: new Date(now.getTime() + Math.max(15_000, leaseMs)),
        },
        $inc: { attempts: 1 },
        $unset: { lastError: 1, nextAttemptAt: 1 },
      },
      { sort: { priority: -1, scheduledFor: 1, createdAt: 1 }, returnDocument: 'after' },
    ).lean().exec();
    if (!document) return null;
    return {
      jobKey: String(document.jobKey),
      type: document.type,
      scope: document.scope ?? {},
      priority: Number(document.priority ?? 5),
      recurrence: document.recurrence,
      attempts: Number(document.attempts ?? 1),
      maxAttempts: Number(document.maxAttempts ?? 20),
      retryCount: Number(document.retryCount ?? 0),
      triggerEventId: document.triggerEventId,
    };
  }

  async markHeartbeat(jobKey: string, workerId: string, leaseMs = 120_000): Promise<boolean> {
    const now = new Date();
    const result = await this.queueModel.updateOne(
      { jobKey, status: SportsQueueJobStatus.PROCESSING, ownerId: workerId },
      { $set: { heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + Math.max(15_000, leaseMs)) } },
    ).exec();
    return result.modifiedCount === 1;
  }

  async getOrCreateSuccessorAt(jobKey: string, workerId: string, intervalMs: number): Promise<Date> {
    const reserved = await this.queueModel.findOneAndUpdate(
      { jobKey, status: SportsQueueJobStatus.PROCESSING, ownerId: workerId, nextRunAt: { $exists: false } },
      { $set: { nextRunAt: new Date(Date.now() + Math.max(1, intervalMs)) } },
      { returnDocument: 'after' },
    ).select({ nextRunAt: 1 }).lean().exec();
    if (reserved?.nextRunAt) return new Date(reserved.nextRunAt);
    const existing = await this.queueModel.findOne({ jobKey, status: SportsQueueJobStatus.PROCESSING, ownerId: workerId })
      .select({ nextRunAt: 1 }).lean().exec();
    if (existing?.nextRunAt) return new Date(existing.nextRunAt);
    throw new Error(`Unable to reserve a successor timestamp for ${jobKey}.`);
  }

  async markCompleted(jobKey: string, workerId: string): Promise<boolean> {
    const result = await this.queueModel.updateOne(
      { jobKey, status: SportsQueueJobStatus.PROCESSING, ownerId: workerId },
      {
        $set: { status: SportsQueueJobStatus.COMPLETED, completedAt: new Date() },
        $unset: { ownerId: 1, heartbeatAt: 1, leaseExpiresAt: 1, nextAttemptAt: 1, nextRunAt: 1, lastError: 1 },
      },
    ).exec();
    return result.modifiedCount === 1;
  }

  async markFailed(job: ClaimedSportsQueueJob, workerId: string, error: unknown): Promise<'RETRY' | 'QUARANTINED'> {
    const message = error instanceof Error ? error.message : String(error);
    const lastError = message.replace(/[\r\n]+/g, ' ').slice(0, 1_000);
    const retryability = error && typeof error === 'object' && 'retryable' in error
      ? (error as { retryable?: unknown }).retryable
      : undefined;
    const retryable = retryability === true;
    const permanentProviderFailure = retryability === false;
    if (permanentProviderFailure || (!retryable && job.attempts >= job.maxAttempts)) {
      await this.queueModel.updateOne(
        { jobKey: job.jobKey, status: SportsQueueJobStatus.PROCESSING, ownerId: workerId },
        {
          $set: { status: SportsQueueJobStatus.QUARANTINED, lane: SportsQueueLane.QUARANTINE, failedAt: new Date(), lastError },
          $unset: { ownerId: 1, heartbeatAt: 1, leaseExpiresAt: 1 },
        },
      ).exec();
      return 'QUARANTINED';
    }
    const retryCount = job.retryCount + 1;
    const nextAttemptAt = new Date(Date.now() + Math.min(30 * 60_000, 5_000 * 2 ** Math.min(retryCount - 1, 8)));
    await this.queueModel.updateOne(
      { jobKey: job.jobKey, status: SportsQueueJobStatus.PROCESSING, ownerId: workerId },
      {
        $set: {
          status: SportsQueueJobStatus.PENDING,
          lane: SportsQueueLane.BACKGROUND_RETRY,
          nextAttemptAt,
          scheduledFor: nextAttemptAt,
          retryCount,
          lastError,
        },
        $unset: { ownerId: 1, heartbeatAt: 1, leaseExpiresAt: 1, startedAt: 1, nextRunAt: 1 },
      },
    ).exec();
    return 'RETRY';
  }

  async recoverExpiredProcessing(limit = 200): Promise<number> {
    const now = new Date();
    const expired = await this.queueModel.find({ status: SportsQueueJobStatus.PROCESSING, leaseExpiresAt: { $lte: now } })
      .select({ jobKey: 1, retryCount: 1 }).limit(Math.max(1, Math.min(1_000, limit))).lean().exec();
    let recovered = 0;
    for (const item of expired as any[]) {
      const jobKey = String(item.jobKey);
      // An expired lease only means the worker disappeared or exceeded its
      // lease. It is not evidence that the provider data is permanently bad.
      // Keep the durable job retryable; explicit non-retryable errors are
      // quarantined by markFailed instead.
      const retryCount = Number(item.retryCount ?? 0) + 1;
      const retryAt = new Date(now.getTime() + Math.min(30 * 60_000, 5_000 * 2 ** Math.min(retryCount - 1, 8)));
      const result = await this.queueModel.updateOne(
        { jobKey, status: SportsQueueJobStatus.PROCESSING, leaseExpiresAt: { $lte: now } },
        {
          $set: { status: SportsQueueJobStatus.PENDING, scheduledFor: retryAt, nextAttemptAt: retryAt, retryCount, lane: SportsQueueLane.BACKGROUND_RETRY, lastError: 'Recovered after worker lease expiry.' },
          $unset: { ownerId: 1, heartbeatAt: 1, leaseExpiresAt: 1, startedAt: 1, nextRunAt: 1 },
        },
      ).exec();
      recovered += result.modifiedCount;
    }
    return recovered;
  }

  async requeueQuarantined(jobKey: string): Promise<boolean> {
    const now = new Date();
    const result = await this.queueModel.updateOne(
      { jobKey, status: SportsQueueJobStatus.QUARANTINED },
      {
        $set: { status: SportsQueueJobStatus.PENDING, lane: SportsQueueLane.NORMAL, scheduledFor: now, nextAttemptAt: now, attempts: 0, retryCount: 0 },
        $unset: { failedAt: 1, completedAt: 1, lastError: 1 },
      },
    ).exec();
    return result.modifiedCount === 1;
  }

  private jobKey(identity: string): string {
    const digest = createHash('sha256').update(identity).digest('hex').slice(0, 40);
    return `sports-job:${digest}`;
  }

  private priority(value?: number): number {
    return Math.max(1, Math.min(100, Math.floor(value ?? 5)));
  }

  private sortObject(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [
        key,
        child && typeof child === 'object' && !Array.isArray(child) && !(child instanceof Date)
          ? this.sortObject(child as Record<string, unknown>)
          : child,
      ]));
  }
}







