import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import { MarketPrediction } from '../../predictions-engine/schemas/market-prediction.schema';
import { PredictionStatus } from '../../predictions-engine/enums/prediction-status.enum';
import { PredictionSettlementOutcome } from '../enums/settlement-prediction-outcome.enum';
import { BetLabTicket } from '../../bet-lab/schemas/bet-lab-ticket.schema';
import { BetLabTicketStatus } from '../../bet-lab/enums/bet-lab-ticket-status.enum';
import { SportsDomainReadService } from '../../sports/services/sports-domain-read.service';
import { SettlementJob, SettlementJobDocument } from '../schemas/settlement-job.schema';
import { SettlementJobStatus } from '../enums/settlement-job-status.enum';
import { SETTLEMENT_CONFIG } from '../config/settlement.config';
import { createSettlementSourceFingerprint } from '../utils/sports-settlement-fingerprint.util';
import { isSportsFixtureSettleable } from '../utils/fixture-lifecycle.util';

@Injectable()
export class SettlementQueueService {
  private readonly signal = new EventEmitter();

  constructor(
    @InjectModel(SettlementJob.name)
    private readonly jobModel: Model<SettlementJobDocument>,
    @InjectModel(MarketPrediction.name)
    private readonly marketPredictionModel: Model<MarketPrediction>,
    @InjectModel(BetLabTicket.name)
    private readonly betLabTicketModel: Model<BetLabTicket>,
    private readonly sportsRead: SportsDomainReadService,
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
   * Re-evaluate a Sports fixture whenever its lifecycle, period score, timeline
   * or match statistics change. Only fixtures that are live, at half time, in
   * extra time/penalties, or confirmed completed are eligible. We also require
   * at least one unsettled Prediction or Bet Lab target before creating work.
   */
  async enqueueForSportsFixtureChange(
    eventIdValue: string,
    _competitionIdValue?: string,
    triggerReason = 'SPORTS_DATA_CHANGED',
  ) {
    const eventId = String(eventIdValue ?? '').trim();
    if (!eventId) return { enqueued: false, reason: 'EMPTY_EVENT_ID' as const };

    const match = await this.sportsRead.getMatch(eventId);
    if (!match) return { enqueued: false, reason: 'SPORTS_FIXTURE_NOT_FOUND' as const };
    if (!isSportsFixtureSettleable(match.fixture)) {
      return { enqueued: false, reason: 'FIXTURE_NOT_IN_SETTLEABLE_SPORTS_STATE' as const };
    }

    const [hasPredictions, hasBetLabTickets] = await Promise.all([
      this.marketPredictionModel.exists({
        eventId,
        selections: {
          $elemMatch: {
            status: { $nin: [PredictionStatus.UNAVAILABLE, PredictionStatus.FAILED] },
            $or: [
              { actualOutcome: { $nin: Object.values(PredictionSettlementOutcome) } },
              {
                actualOutcome: { $in: Object.values(PredictionSettlementOutcome) },
                settlementPhase: { $in: ['IN_PLAY', 'HALF_TIME'] },
              },
            ],
          },
        },
      }).exec(),
      this.betLabTicketModel.exists({
        status: { $in: [BetLabTicketStatus.OPEN, BetLabTicketStatus.PENDING_SETTLEMENT] },
        // OPEN legs need grading; already-resolved IN_PLAY/HALF_TIME legs still
        // need a full-time source recheck and accumulator payout finalization.
        legs: { $elemMatch: { eventId } },
      }).exec(),
    ]);
    if (!hasPredictions && !hasBetLabTickets) {
      return { enqueued: false, reason: 'NO_UNSETTLED_TARGETS' as const };
    }

    const now = new Date();
    const fixture = match.fixture;
    const sourceFingerprint = createSettlementSourceFingerprint(match);
    const sourceDates = [
      this.toDate(fixture.source?.collectedAt),
      this.toDate(fixture.source?.providerUpdatedAt),
      this.toDate(match.matchSummary?.lastCollectedAt),
      this.toDate(match.matchFacts?.sourceCollectedAt),
      this.toDate(match.matchFacts?.normalizedAt),
      this.toDate(fixture.updatedAt),
      this.toDate(fixture.createdAt),
      ...match.timeline.flatMap((item) => [
        this.toDate(item.source?.collectedAt),
        this.toDate(item.source?.providerUpdatedAt),
        this.toDate(item.updatedAt),
        this.toDate(item.createdAt),
      ]),
    ].filter((value): value is Date => Boolean(value));
    const sourceAt = sourceDates.length
      ? new Date(Math.max(...sourceDates.map((value) => value.getTime())))
      : now;
    const jobKey = `${eventId}:${sourceFingerprint}`;
    const leagueId = String(fixture.competitionId ?? '').trim().toLowerCase();
    const targetCreated = triggerReason === 'PREDICTION_CREATED' || triggerReason === 'BET_LAB_TICKET_CREATED';
    // Startup reconciliation intentionally bypasses terminal-job cooldowns:
    // it only supplies event IDs that still have unresolved business targets.
    const forceReconciliation = targetCreated || triggerReason === 'STARTUP_RECONCILIATION';

    // Coalesce frequent Sports outbox events into one active job per fixture.
    // A processing job is asked to run once more after it finishes; queued/retry
    // jobs are simply made due now because the worker always re-reads Sports.
    const activeJob = await this.jobModel
      .findOne({
        eventId,
        status: { $in: [SettlementJobStatus.QUEUED, SettlementJobStatus.RETRY, SettlementJobStatus.PROCESSING] },
      })
      .sort({ updatedAt: -1 })
      .exec();

    if (activeJob?.status === SettlementJobStatus.PROCESSING) {
      const sourceChanged = String(activeJob.sourceFingerprint ?? '') !== sourceFingerprint;
      if (!forceReconciliation && !sourceChanged) {
        return { enqueued: false, alreadyExists: true, reason: 'ACTIVE_JOB_ALREADY_PROCESSING' as const, jobKey: activeJob.jobKey };
      }
      if (activeJob.rerunRequested) {
        return { enqueued: false, alreadyExists: true, reason: 'ACTIVE_JOB_RERUN_ALREADY_REQUESTED' as const, jobKey: activeJob.jobKey };
      }
      const marked = await this.jobModel.updateOne(
        { _id: activeJob._id, status: SettlementJobStatus.PROCESSING, rerunRequested: { $ne: true } },
        { $set: { rerunRequested: true, rerunTriggerReason: triggerReason } },
      ).exec();
      if ((marked.modifiedCount ?? 0) > 0) {
        this.signal.emit('queued');
        return { enqueued: true, alreadyExists: true, scheduledAt: now, reason: sourceChanged ? 'RERUN_REQUESTED_FOR_NEW_SPORTS_SOURCE' as const : 'RERUN_REQUESTED_FOR_NEW_TARGET' as const, jobKey: activeJob.jobKey };
      }
      return { enqueued: false, alreadyExists: true, reason: 'ACTIVE_JOB_STATE_CHANGED' as const, jobKey: activeJob.jobKey };
    }

    if (activeJob && [SettlementJobStatus.QUEUED, SettlementJobStatus.RETRY].includes(activeJob.status)) {
      const resumed = await this.jobModel.updateOne(
        { _id: activeJob._id, status: { $in: [SettlementJobStatus.QUEUED, SettlementJobStatus.RETRY] } },
        {
          $set: {
            status: SettlementJobStatus.QUEUED,
            nextRunAt: now,
            priority: 1,
            attempts: 0,
            maximumAttempts: SETTLEMENT_CONFIG.queue.maximumAttempts,
            triggerReason,
            sourceSummaryCollectedAt: sourceAt,
          },
          $unset: { lastError: 1, completedAt: 1 },
        },
      ).exec();
      if ((resumed.modifiedCount ?? 0) > 0) this.signal.emit('queued');
      return { enqueued: (resumed.modifiedCount ?? 0) > 0, alreadyExists: true, reason: 'ACTIVE_JOB_COALESCED', scheduledAt: now, jobKey: activeJob.jobKey };
    }

    let job = await this.jobModel
      .findOneAndUpdate(
        { jobKey },
        {
          $setOnInsert: {
            jobKey,
            eventId,
            leagueId,
            sourceFingerprint,
            // Kept as a storage-compatible field name for existing jobs. It now
            // records the newest normalized Sports source timestamp.
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

    if (!job) throw new Error(`Could not queue settlement for event ${eventId}`);

    const recoverableStatuses = [
      SettlementJobStatus.COMPLETED,
      SettlementJobStatus.PARTIAL,
      SettlementJobStatus.FAILED,
      SettlementJobStatus.SKIPPED,
    ];
    if (recoverableStatuses.includes(job.status)) {
      const bypassCooldown = forceReconciliation;
      const nextRunAt = this.toDate(job.nextRunAt);
      const recoveryDelayMs = this.recoveryDelayForStatus(job.status);
      const updatedAt = this.toDate((job as unknown as { updatedAt?: unknown }).updatedAt);
      const effectiveRecoveryAt = nextRunAt ?? new Date((updatedAt?.getTime() ?? 0) + recoveryDelayMs);
      if (!bypassCooldown && effectiveRecoveryAt.getTime() > now.getTime()) {
        return { enqueued: false, alreadyExists: true, reason: `${job.status}_RECOVERY_COOLDOWN`, scheduledAt: effectiveRecoveryAt, jobKey };
      }
      const missingScheduleCutoff = new Date(now.getTime() - recoveryDelayMs);
      const recoveryFilter = {
        _id: job._id,
        status: job.status,
        ...(!bypassCooldown ? {
          $or: [
            { nextRunAt: { $lte: now } },
            { $and: [ { $or: [{ nextRunAt: { $exists: false } }, { nextRunAt: null }] }, { updatedAt: { $lte: missingScheduleCutoff } } ] },
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
            triggerReason: triggerReason === 'STARTUP_RECONCILIATION'
              ? 'STARTUP_RECONCILIATION'
              : targetCreated ? `NEW_TARGET_AFTER_${job.status}` : `RECOVERY_${triggerReason}`,
            rerunRequested: false,
          },
          $unset: { lockedAt: 1, lockedBy: 1, startedAt: 1, completedAt: 1, lastError: 1, rerunTriggerReason: 1 },
        },
        { returnDocument: 'after' },
      ).exec();
      if (recoveredJob) {
        this.signal.emit('queued');
        return { enqueued: true, alreadyExists: true, reason: triggerReason === 'STARTUP_RECONCILIATION' ? 'REQUEUED_FOR_STARTUP_RECONCILIATION' : targetCreated ? 'REQUEUED_FOR_NEW_TARGET' : 'RECOVERED_TERMINAL_JOB', scheduledAt: now, jobKey };
      }
      return { enqueued: false, alreadyExists: true, reason: 'JOB_STATE_CHANGED_DURING_RECOVERY', jobKey };
    }

    this.signal.emit('queued');
    return { enqueued: true, jobKey, reason: 'QUEUED' as const };
  }

  /**
   * Catch-up reconciliation for targets that predate the durable Sports outbox
   * integration or whose fixtures were not yet available at Settlement startup. It only discovers event IDs with unresolved
   * Prediction selections or tickets that are still awaiting settlement. Each
   * candidate is then revalidated against current Sports lifecycle and target
   * state by enqueueForSportsFixtureChange before any work is created.
   *
   * The query is deliberately read-only; the only writes are the normal
   * idempotent Settlement queue handoffs. Re-running after a partial failure is
   * safe because active jobs are coalesced by fixture and source fingerprint.
   */
  async reconcileExistingUnsettledTargets(batchSize = 4): Promise<{
    candidateEventIds: number;
    queued: number;
    skipped: number;
    failed: number;
    skippedReasons: Record<string, number>;
  }> {
    const unresolvedPredictionFilter = {
      selections: {
        $elemMatch: {
          status: { $nin: [PredictionStatus.UNAVAILABLE, PredictionStatus.FAILED] },
          $or: [
            { actualOutcome: { $nin: Object.values(PredictionSettlementOutcome) } },
            {
              actualOutcome: { $in: Object.values(PredictionSettlementOutcome) },
              settlementPhase: { $in: ['IN_PLAY', 'HALF_TIME'] },
            },
          ],
        },
      },
    };
    const unresolvedBetLabFilter = {
      status: { $in: [BetLabTicketStatus.OPEN, BetLabTicketStatus.PENDING_SETTLEMENT] },
      'legs.eventId': { $exists: true },
    };

    const [predictionEventIds, betLabEventIds] = await Promise.all([
      this.marketPredictionModel.distinct('eventId', unresolvedPredictionFilter).exec(),
      this.betLabTicketModel.distinct('legs.eventId', unresolvedBetLabFilter).exec(),
    ]);
    const eventIds = [...new Set(
      [...predictionEventIds, ...betLabEventIds]
        .map((value) => String(value ?? '').trim())
        .filter(Boolean),
    )];

    const safeBatchSize = Math.min(16, Math.max(1, Math.floor(batchSize) || 4));
    const skippedReasons: Record<string, number> = {};
    let queued = 0;
    let skipped = 0;
    let failed = 0;

    for (let offset = 0; offset < eventIds.length; offset += safeBatchSize) {
      const batch = eventIds.slice(offset, offset + safeBatchSize);
      const results = await Promise.all(batch.map(async (eventId) => {
        try {
          return {
            eventId,
            result: await this.enqueueForSportsFixtureChange(
              eventId,
              undefined,
              'STARTUP_RECONCILIATION',
            ),
          };
        } catch (error) {
          return { eventId, error };
        }
      }));

      for (const item of results) {
        if ('error' in item) {
          failed += 1;
          continue;
        }
        if (item.result.enqueued) {
          queued += 1;
          continue;
        }
        skipped += 1;
        const reason = String(item.result.reason ?? 'UNKNOWN');
        skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
      }
    }

    if (failed > 0) {
      throw new Error(
        `Settlement startup reconciliation failed for ${failed} of ${eventIds.length} candidate fixtures; ${queued} were queued before the failure.`,
      );
    }

    return {
      candidateEventIds: eventIds.length,
      queued,
      skipped,
      failed,
      skippedReasons,
    };
  }

  /** Backward-compatible method name; eligibility is now Sports lifecycle based. */
  enqueueForConfirmedFinishedFixture(eventId: string, competitionId?: string, triggerReason = 'SPORTS_DATA_CHANGED') {
    return this.enqueueForSportsFixtureChange(eventId, competitionId, triggerReason);
  }

  /**
   * Reclaims abandoned processing jobs. Recovery is safe across multiple
   * instances because each transition is an atomic update guarded by the
   * current PROCESSING state and expired lease timestamp.
   */
  async recoverExpiredProcessingJobs(): Promise<{
    recoveredForRetry: number;
    exhausted: number;
    total: number;
  }> {
    const now = new Date();
    const expiredBefore = new Date(
      now.getTime() - SETTLEMENT_CONFIG.queue.processingLeaseMinutes * 60_000,
    );
    const expiredLeaseFilter = {
      status: SettlementJobStatus.PROCESSING,
      $or: [
        { lockedAt: { $lte: expiredBefore } },
        // `$in: [null]` covers both explicit null and legacy documents where
        // lockedAt was never persisted; updatedAt prevents premature recovery.
        { lockedAt: { $in: [null] }, updatedAt: { $lte: expiredBefore } },
      ],
    };
    const recoveryError =
      'Processing lease expired; the abandoned settlement job was recovered.';

    const retryResult = await this.jobModel.updateMany(
      {
        ...expiredLeaseFilter,
        $expr: {
          $lt: [
            { $ifNull: ['$attempts', 0] },
            { $ifNull: ['$maximumAttempts', SETTLEMENT_CONFIG.queue.maximumAttempts] },
          ],
        },
      },
      {
        $set: {
          status: SettlementJobStatus.RETRY,
          nextRunAt: now,
          lastError: recoveryError,
          triggerReason: 'EXPIRED_PROCESSING_LEASE_RECOVERY',
        },
        $unset: {
          lockedAt: 1,
          lockedBy: 1,
          claimToken: 1,
          startedAt: 1,
          rerunRequested: 1,
          rerunTriggerReason: 1,
          completedAt: 1,
        },
      },
    ).exec();

    const exhaustedResult = await this.jobModel.updateMany(
      {
        ...expiredLeaseFilter,
        $expr: {
          $gte: [
            { $ifNull: ['$attempts', 0] },
            { $ifNull: ['$maximumAttempts', SETTLEMENT_CONFIG.queue.maximumAttempts] },
          ],
        },
      },
      {
        $set: {
          status: SettlementJobStatus.FAILED,
          nextRunAt: new Date(
            now.getTime() + SETTLEMENT_CONFIG.queue.failedRecoveryIntervalMs,
          ),
          lastError: recoveryError,
          triggerReason: 'EXPIRED_PROCESSING_LEASE_EXHAUSTED',
          completedAt: now,
        },
        $unset: {
          lockedAt: 1,
          lockedBy: 1,
          claimToken: 1,
          startedAt: 1,
          rerunRequested: 1,
          rerunTriggerReason: 1,
        },
      },
    ).exec();

    const recoveredForRetry = Number(retryResult.modifiedCount ?? 0);
    const exhausted = Number(exhaustedResult.modifiedCount ?? 0);
    if (recoveredForRetry > 0) this.signal.emit('queued');
    return {
      recoveredForRetry,
      exhausted,
      total: recoveredForRetry + exhausted,
    };
  }

  /** Renews the current claim without changing the processing owner or token. */
  async renewProcessingLease(
    job: SettlementJobDocument,
    workerId: string,
  ): Promise<boolean> {
    const claimToken = String(job.claimToken ?? '').trim();
    if (!claimToken) return false;
    const renewed = await this.jobModel.updateOne(
      {
        _id: job._id,
        status: SettlementJobStatus.PROCESSING,
        lockedBy: workerId,
        claimToken,
      },
      { $set: { lockedAt: new Date() } },
    ).exec();
    return (renewed.modifiedCount ?? 0) > 0;
  }

  async ownsProcessingLease(
    job: SettlementJobDocument,
    workerId?: string,
  ): Promise<boolean> {
    const claimToken = String(job.claimToken ?? '').trim();
    const lockedBy = String(workerId ?? job.lockedBy ?? '').trim();
    if (!claimToken || !lockedBy) return false;
    const found = await this.jobModel.exists({
      _id: job._id,
      status: SettlementJobStatus.PROCESSING,
      lockedBy,
      claimToken,
    }).exec();
    return Boolean(found);
  }

  async assertProcessingLease(
    job: SettlementJobDocument,
    workerId?: string,
  ): Promise<void> {
    if (!(await this.ownsProcessingLease(job, workerId))) {
      throw new Error(
        `Settlement processing lease was lost for job ${job.jobKey}; stale worker writes are blocked.`,
      );
    }
  }

  async claimNextDueJob(
    workerId: string,
  ): Promise<SettlementJobDocument | null> {
    const now = new Date();
    const claimToken = randomUUID();
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
            claimToken,
            startedAt: now,
          },
          $inc: { attempts: 1 },
          $unset: { lastError: 1, completedAt: 1 },
        },
        {
          returnDocument: 'after',
          sort: { priority: 1, nextRunAt: 1, createdAt: 1 },
        },
      )
      .select('+claimToken')
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
          ...this.claimFilter(job),
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
          $unset: { lockedAt: 1, lockedBy: 1, claimToken: 1, lastError: 1 },
        },
      )
      .exec();

    // Close the narrow race where a new target marks rerunRequested between
    // the first check and the completion update.
    if ((completed.modifiedCount ?? 0) === 0) {
      if (await this.requeueRequestedRun(job, input)) return true;
      throw new Error(
        `Settlement job ${job.jobKey} could not be completed because its processing lease is no longer owned by this worker.`,
      );
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
          ...this.claimFilter(job),
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
            claimToken: 1,
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

  private claimFilter(job: SettlementJobDocument): Record<string, any> {
    const claimToken = String(job.claimToken ?? '').trim();
    const lockedBy = String(job.lockedBy ?? '').trim();
    if (!claimToken || !lockedBy) {
      throw new Error(
        `Settlement job ${job.jobKey} has no active claim token; refusing an unfenced state transition.`,
      );
    }
    return {
      _id: job._id,
      status: SettlementJobStatus.PROCESSING,
      lockedBy,
      claimToken,
    };
  }

  async fail(
    job: SettlementJobDocument,
    error: unknown,
  ): Promise<{ terminal: boolean; retryAt?: Date; leaseLost?: boolean }> {
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
          ...this.claimFilter(job),
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
            claimToken: 1,
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
    const leaseLost = !(await this.ownsProcessingLease(job));
    return { terminal, retryAt: leaseLost ? undefined : normalRetryAt, leaseLost };
  }

  async requeueFinishedFixture(
    eventIdValue: string,
    _competitionIdValue?: string,
  ): Promise<{ queued: boolean; jobKey?: string; reason: string }> {
    const eventId = String(eventIdValue ?? '').trim();
    if (!eventId) return { queued: false, reason: 'EMPTY_EVENT_ID' };
    const match = await this.sportsRead.getMatch(eventId);
    if (!match) return { queued: false, reason: 'SPORTS_FIXTURE_NOT_FOUND' };
    if (!isSportsFixtureSettleable(match.fixture)) {
      return { queued: false, reason: 'FIXTURE_NOT_IN_SETTLEABLE_SPORTS_STATE' };
    }

    const fixture = match.fixture;
    const sourceFingerprint = createSettlementSourceFingerprint(match);
    const jobKey = `${eventId}:${sourceFingerprint}`;
    const now = new Date();
    const leagueId = String(fixture.competitionId ?? '').trim().toLowerCase();
    const sourceAt = [
      this.toDate(fixture.source?.collectedAt),
      this.toDate(match.matchSummary?.lastCollectedAt),
      this.toDate(match.matchFacts?.sourceCollectedAt),
    ].filter((value): value is Date => Boolean(value)).sort((a, b) => b.getTime() - a.getTime())[0] ?? now;

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
              sourceSummaryCollectedAt: sourceAt,
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
              claimToken: 1,
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
              claimToken: 1,
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




