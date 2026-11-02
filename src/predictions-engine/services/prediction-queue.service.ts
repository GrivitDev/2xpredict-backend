import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { AnyBulkWriteOperation } from 'mongoose';

import { EspnFixture } from '../../sports/schemas/espn/espn-fixture.schema';
import { ActiveCompetition } from '../../sports/schemas/active-competition.schema';
import { PredictionQueue } from '../schemas/prediction-queue.schema';
import { PredictionQueueStatus } from '../enums/prediction-queue-status.enum';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { PredictionQueueSyncResult } from '../interfaces/prediction-queue.interface';
import { PredictionEngineMonitorService } from './prediction-engine-monitor.service';
import { EspnPayloadUtil } from '../utils/espn-payload.util';
import { OddsService } from '../../odds/services/odds.service';

@Injectable()
export class PredictionQueueService {
  private readonly logger = new Logger(PredictionQueueService.name);

  constructor(
    @InjectModel(EspnFixture.name)
    private readonly fixtureModel: Model<EspnFixture>,
    @InjectModel(ActiveCompetition.name)
    private readonly competitionModel: Model<ActiveCompetition>,
    @InjectModel(PredictionQueue.name)
    private readonly queueModel: Model<PredictionQueue>,
    private readonly monitor: PredictionEngineMonitorService,
    private readonly oddsService: OddsService,
  ) {}

  async syncUpcomingFixtures(
    force = false,
  ): Promise<PredictionQueueSyncResult> {
    const now = new Date();
    // Market engines use a rolling 72-hour kickoff window, not a calendar-day
    // boundary. Active live fixtures are admitted separately below.
    const horizon = new Date(
      now.getTime() + PREDICTION_ENGINE_CONFIG.queue.forwardWindowHours * 60 * 60_000,
    );
    const baseFilter = {
      $and: [
        { $or: [
          { fixtureDate: { $gte: now, $lte: horizon } },
          { live: true },
          { status: /IN[_ -]?PROGRESS|INPROGRESS|LIVE|HALF[_ -]?TIME|FIRST[_ -]?HALF|SECOND[_ -]?HALF|STATUS_HALFTIME|STATUS_IN_PROGRESS/i },
          { statusDetail: /IN[_ -]?PROGRESS|INPROGRESS|LIVE|HALF[_ -]?TIME|FIRST[_ -]?HALF|SECOND[_ -]?HALF|STATUS_HALFTIME|STATUS_IN_PROGRESS/i },
          { statusShortDetail: /IN[_ -]?PROGRESS|INPROGRESS|LIVE|HALF[_ -]?TIME|FIRST[_ -]?HALF|SECOND[_ -]?HALF|STATUS_HALFTIME|STATUS_IN_PROGRESS/i },
          { 'payload.summary.header.competitions.status.state': /^(in|in_progress|in-progress)$/i },
          { 'payload.summary.header.competitions.status.type.state': /^(in|in_progress|in-progress)$/i },
          { 'payload.competitions.status.state': /^(in|in_progress|in-progress)$/i },
          { 'payload.competitions.status.type.state': /^(in|in_progress|in-progress)$/i },
        ] },
        { completed: { $ne: true } },
        { $nor: [
          { status: /(^|[^A-Z])(FINAL|FINISHED|FULL[ _-]?TIME|AFTER EXTRA TIME|AFTER PENALTIES|FT)([^A-Z]|$)/i },
          { statusDetail: /(^|[^A-Z])(FINAL|FINISHED|FULL[ _-]?TIME|AFTER EXTRA TIME|AFTER PENALTIES|FT)([^A-Z]|$)/i },
          { statusShortDetail: /(^|[^A-Z])(FINAL|FINISHED|FULL[ _-]?TIME|AFTER EXTRA TIME|AFTER PENALTIES|FT)([^A-Z]|$)/i },
          { status: /postpon|cancel|abandon|delay/i },
          { statusDetail: /postpon|cancel|abandon|delay/i },
          { statusShortDetail: /postpon|cancel|abandon|delay/i },
          { 'payload.summary.header.competitions.status.completed': true },
          { 'payload.summary.header.competitions.status.type.completed': true },
          { 'payload.competitions.status.completed': true },
          { 'payload.competitions.status.type.completed': true },
        ] },
      ],
    };

    // Read the eligible fixture set once. Previously this performed two extra
    // countDocuments scans over the same broad filter every sync cycle. Compute
    // both monitoring counters from the same lightweight projected result.
    const fixtures = (await this.fixtureModel
      .aggregate<EspnFixture & { summaryMissing: boolean }>([
        { $match: baseFilter },
        { $sort: { fixtureDate: 1 } },
        {
          $project: {
            _id: 0,
            eventId: 1,
            leagueId: 1,
            fixtureDate: 1,
            live: 1,
            completed: 1,
            homeScore: 1,
            awayScore: 1,
            status: 1,
            statusDetail: 1,
            statusShortDetail: 1,
            collectedAt: 1,
            'payload.summary.meta.lastUpdatedAt': 1,
            'payload.summaryCollectedAt': 1,
            summaryMissing: {
              $eq: [{ $ifNull: ['$payload.summary', null] }, null],
            },
          },
        },
      ])
      .exec()) as Array<EspnFixture & { summaryMissing: boolean }>;
    const scannedFixtures = fixtures.length;
    const missingSummary = fixtures.reduce(
      (count, fixture) => count + (fixture.summaryMissing ? 1 : 0),
      0,
    );

    if (!fixtures.length) {
      const result = {
        scannedFixtures,
        eligibleFixtures: 0,
        enqueued: 0,
        refreshed: 0,
        missingSummary,
        oddsNotReady: 0,
      };
      await this.monitor.recordQueueSync(result);
      return result;
    }

    const competitionIds = [
      ...new Set(fixtures.map((fixture) => String(fixture.leagueId))),
    ];
    const competitions = (await this.competitionModel
      .find({
        competitionId: { $in: competitionIds },
      })
      .select({ _id: 0, competitionId: 1, priority: 1, status: 1 })
      .lean()
      .exec()) as Array<{ competitionId: string; priority?: unknown }>;
    const priorityMap = new Map<string, number>();
    for (const competition of competitions) {
      const priority =
        typeof competition.priority === 'string'
          ? competition.priority.toUpperCase()
          : '';
      priorityMap.set(
        String(competition.competitionId),
        priority === 'ELITE'
          ? 400
          : priority === 'HIGH'
            ? 300
            : priority === 'REGIONAL'
              ? 200
              : 100,
      );
    }

    const eventIds = fixtures.map((fixture: unknown) =>
      String(EspnPayloadUtil.asRecord(fixture).eventId),
    );
    const readinessByEvent = await this.oddsService.getPredictionReadinessForEvents(eventIds);
    const eligibleFixtures = fixtures.filter((fixture) =>
      readinessByEvent.get(String(fixture.eventId))?.ready === true,
    );
    const oddsNotReady = fixtures.length - eligibleFixtures.length;
    const existingRows = (await this.queueModel
      .find({ eventId: { $in: eventIds } })
      .select({
        _id: 0,
        eventId: 1,
        status: 1,
        lastProcessedSummaryAt: 1,
        summaryCollectedAt: 1,
        modelVersion: 1,
        lastProcessedOddsAt: 1,
        oddsUpdatedAt: 1,
        lastProcessedScoreSnapshot: 1,
        scoreSnapshot: 1,
        completedAt: 1,
        availableAt: 1,
        attempts: 1,
        refreshCount: 1,
        reason: 1,
      })
      .lean()
      .exec()) as PredictionQueue[];
    const existingByEvent = new Map(
      existingRows.map((row) => [String(row.eventId), row]),
    );
    const operations: AnyBulkWriteOperation<PredictionQueue>[] = [];
    const bulkWriteBatchSize = 500;
    let firstBulkWriteError: unknown;
    let bulkWriteFailed = false;
    const flushOperations = async (): Promise<void> => {
      if (!operations.length) return;
      const batch = operations.splice(0, bulkWriteBatchSize);
      try {
        await this.queueModel.bulkWrite(batch, { ordered: false });
      } catch (error) {
        // unordered bulkWrite attempts every operation in its batch. Keep going
        // with subsequent batches and rethrow after all writes have been tried.
        if (!bulkWriteFailed) {
          firstBulkWriteError = error;
          bulkWriteFailed = true;
        }
      }
    };
    const pushOperation = async (
      operation: AnyBulkWriteOperation<PredictionQueue>,
    ): Promise<void> => {
      operations.push(operation);
      if (operations.length >= bulkWriteBatchSize) await flushOperations();
    };
    let enqueued = 0;
    let refreshed = 0;

    for (const fixture of fixtures) {
      const eventId = String(fixture.eventId);
      const existing = existingByEvent.get(eventId);
      const readiness = readinessByEvent.get(eventId);
      if (!readiness?.ready) {
        // No usable Odds-module price exists for this fixture yet. Once any
        // supported exact selection has a valid price, the fixture is queued;
        // missing prices in other markets are handled independently by calculation.
        if (existing && existing.status !== PredictionQueueStatus.PROCESSING) {
          await pushOperation({
            updateOne: {
              filter: { eventId, status: { $ne: PredictionQueueStatus.PROCESSING } },
              update: {
                $set: {
                  status: PredictionQueueStatus.WAITING_FOR_ODDS,
                  reason: 'WAITING_FOR_ODDS',
                  errorMessage: readiness?.reason ?? 'Odds module has not marked this fixture prediction-ready.',
                },
                $unset: { lockedAt: 1 },
              },
            },
          });
        }
        continue;
      }
      const payload = EspnPayloadUtil.asRecord(fixture.payload);
      const summary = EspnPayloadUtil.asRecord(payload.summary);
      const summarySourceDates = [
        EspnPayloadUtil.toValidDate(payload.summaryCollectedAt),
        EspnPayloadUtil.toValidDate(
          EspnPayloadUtil.asRecord(summary.meta).lastUpdatedAt,
        ),
      ].filter((value): value is Date => value !== null);
      const newestSummarySourceDate = summarySourceDates.reduce<Date | null>(
        (latest, value) => !latest || value.getTime() > latest.getTime() ? value : latest,
        null,
      );
      const fixtureCollectedAt = EspnPayloadUtil.toValidDate(fixture.collectedAt);
      const priority = priorityMap.get(String(fixture.leagueId)) ?? 100;

      if (existing?.status === PredictionQueueStatus.PROCESSING) continue;
      const previouslyProcessedDate = EspnPayloadUtil.toValidDate(
        existing?.lastProcessedSummaryAt,
      );
      const priorSourceDate = existing?.status === PredictionQueueStatus.COMPLETED
        ? previouslyProcessedDate
        : EspnPayloadUtil.toValidDate(existing?.summaryCollectedAt) ?? previouslyProcessedDate;
      // Do not re-run every live fixture just because its document was polled.
      // Summary timestamps, actual score/status changes and Odds updates are the
      // meaningful refresh signals. If live Summary metadata is absent, retain
      // the prior source timestamp and rely on the score snapshot.
      const sourceDate = newestSummarySourceDate
        ?? (fixture.live
          ? previouslyProcessedDate ?? fixtureCollectedAt ?? new Date(fixture.fixtureDate)
          : fixtureCollectedAt ?? previouslyProcessedDate ?? new Date(fixture.fixtureDate));
      const snapshotScore = (value: unknown): number | 'NA' =>
        value !== null && value !== undefined && value !== ''
          && Number.isFinite(Number(value)) && Number(value) >= 0
          ? Math.floor(Number(value))
          : 'NA';
      const scoreSnapshot = [
        snapshotScore(fixture.homeScore),
        snapshotScore(fixture.awayScore),
        String(fixture.status ?? ''),
        String(fixture.statusDetail ?? ''),
        String(fixture.statusShortDetail ?? ''),
      ].join('|');
      // `collectedAt` is a polling timestamp, not proof that the summary
      // content changed. Only explicit ESPN Summary source timestamps trigger
      // content-based requeues; periodic refresh handles unchanged summaries.
      const sourceChanged = Boolean(
        newestSummarySourceDate
        && (!priorSourceDate || newestSummarySourceDate.getTime() > priorSourceDate.getTime()),
      );
      const latestOddsUpdatedAt = EspnPayloadUtil.toValidDate(readiness?.latestOddsUpdatedAt);
      const previouslyProcessedOddsDate = existing?.status === PredictionQueueStatus.COMPLETED
        ? EspnPayloadUtil.toValidDate(existing?.lastProcessedOddsAt)
        : EspnPayloadUtil.toValidDate(existing?.oddsUpdatedAt) ?? EspnPayloadUtil.toValidDate(existing?.lastProcessedOddsAt);
      const oddsChanged = Boolean(
        latestOddsUpdatedAt
        && (!previouslyProcessedOddsDate || latestOddsUpdatedAt.getTime() > previouslyProcessedOddsDate.getTime()),
      );
      const modelChanged = Boolean(existing && existing.modelVersion !== PREDICTION_ENGINE_CONFIG.modelVersion);
      const scoreChanged = Boolean(
        existing
        && scoreSnapshot !== (existing.lastProcessedScoreSnapshot ?? existing.scoreSnapshot ?? ''),
      );
      const existingCompletedAt = EspnPayloadUtil.toValidDate(existing?.completedAt);
      const refreshCompletedDue = Boolean(
        existing?.status === PredictionQueueStatus.COMPLETED
        && existingCompletedAt
        && now.getTime() - existingCompletedAt.getTime()
          >= PREDICTION_ENGINE_CONFIG.queue.completedRefreshIntervalMs,
      );
      const recoverFailedDue = Boolean(
        existing?.status === PredictionQueueStatus.FAILED
        && existingCompletedAt
        && now.getTime() - existingCompletedAt.getTime()
          >= PREDICTION_ENGINE_CONFIG.queue.failedRecoveryIntervalMs,
      );
      const retryAvailableAt = EspnPayloadUtil.toValidDate(existing?.availableAt);
      const retryDue = Boolean(
        existing?.status === PredictionQueueStatus.RETRY
        && (!retryAvailableAt || retryAvailableAt.getTime() <= now.getTime()),
      );
      const terminalStatus = [
        PredictionQueueStatus.COMPLETED,
        PredictionQueueStatus.FAILED,
        PredictionQueueStatus.SKIPPED,
      ].includes(existing?.status as PredictionQueueStatus);
      const inputsChanged = sourceChanged || oddsChanged || modelChanged || scoreChanged;
      const shouldRequeue =
        !existing ||
        existing.status === PredictionQueueStatus.PENDING ||
        retryDue ||
        (force && existing.status === PredictionQueueStatus.RETRY) ||
        existing.status === PredictionQueueStatus.WAITING_FOR_ODDS ||
        (force && terminalStatus) ||
        (terminalStatus && (inputsChanged || refreshCompletedDue || recoverFailedDue));

      const setFields: Record<string, any> = {
        eventId,
        leagueId: String(fixture.leagueId),
        fixtureDate: new Date(fixture.fixtureDate),
        priority,
        summaryCollectedAt: sourceDate,
        ...(latestOddsUpdatedAt ? { oddsUpdatedAt: latestOddsUpdatedAt } : {}),
        modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
        scoreSnapshot,
      };

      if (shouldRequeue) {
        setFields.status = PredictionQueueStatus.PENDING;
        setFields.availableAt = now;
        setFields.reason = !existing
          ? 'INITIAL'
          : modelChanged
            ? 'MODEL_VERSION_UPDATED'
            : oddsChanged
              ? 'ODDS_UPDATED'
              : scoreChanged
                ? 'LIVE_SCORE_UPDATED'
                : sourceChanged
                ? 'ESPN_SUMMARY_UPDATED'
                : force
                  ? 'ADMIN_FORCE_REFRESH'
                  : refreshCompletedDue
                    ? 'PERIODIC_REFRESH'
                    : recoverFailedDue
                      ? 'FAILED_JOB_COOLDOWN_RECOVERY'
                      : retryDue
                        ? 'RETRY_BACKOFF_ELAPSED'
                        : existing.reason;
        if (existing && terminalStatus && (force || refreshCompletedDue || recoverFailedDue || inputsChanged)) {
          setFields.attempts = 0;
        }
        if (!existing) enqueued += 1;
        else if (
          existing.status !== PredictionQueueStatus.PENDING &&
          existing.status !== PredictionQueueStatus.RETRY
        )
          refreshed += 1;
        if ((sourceChanged || oddsChanged || modelChanged || scoreChanged) && existing)
          setFields.refreshCount = (existing.refreshCount ?? 0) + 1;
      }

      // MongoDB rejects an update when the same path is targeted by both
      // $set and $setOnInsert. Existing records whose summary changed receive
      // refreshCount through $set; inserts initialize it through $setOnInsert.
      // MongoDB rejects an update when the same path appears in both $set and
      // $setOnInsert. Terminal jobs reset attempts via $set; new rows initialize
      // attempts through $setOnInsert only.
      const setOnInsertFields: Record<string, number> = {};
      if (!Object.prototype.hasOwnProperty.call(setFields, 'attempts')) {
        setOnInsertFields.attempts = 0;
      }
      if (!Object.prototype.hasOwnProperty.call(setFields, 'refreshCount')) {
        setOnInsertFields.refreshCount = 0;
      }
      const update: Record<string, any> = { $set: setFields };
      if (Object.keys(setOnInsertFields).length) {
        update.$setOnInsert = setOnInsertFields;
      }
      if (shouldRequeue) {
        update.$unset = { errorMessage: 1, lockedAt: 1, completedAt: 1 };
      }

      await pushOperation({
        updateOne: {
          filter: { eventId },
          update,
          upsert: true,
        },
      });
    }

    await flushOperations();
    if (bulkWriteFailed) throw firstBulkWriteError;
    const result = {
      scannedFixtures,
      eligibleFixtures: eligibleFixtures.length,
      enqueued,
      refreshed,
      missingSummary,
      oddsNotReady,
    };
    await this.monitor.recordQueueSync(result);
    this.logger.log(
      `Prediction queue sync: fixturesWithAtLeastOneReadySelection=${eligibleFixtures.length}, noUsableOdds=${oddsNotReady}, enqueued=${enqueued}, refreshed=${refreshed}, missingSummary=${missingSummary}.`,
    );
    return result;
  }

  async recoverStaleProcessing(): Promise<number> {
    const cutoff = new Date(
      Date.now() - PREDICTION_ENGINE_CONFIG.queue.staleProcessingMs,
    );
    const retryResult = await this.queueModel
      .updateMany(
        {
          status: PredictionQueueStatus.PROCESSING,
          lockedAt: { $lt: cutoff },
          attempts: { $lt: PREDICTION_ENGINE_CONFIG.queue.maxAttempts },
        },
        {
          $set: {
            status: PredictionQueueStatus.RETRY,
            availableAt: new Date(),
            errorMessage: 'Recovered stale processing lock; retry scheduled.',
          },
          $unset: { lockedAt: 1 },
        },
      )
      .exec();
    const failedResult = await this.queueModel
      .updateMany(
        {
          status: PredictionQueueStatus.PROCESSING,
          lockedAt: { $lt: cutoff },
          attempts: { $gte: PREDICTION_ENGINE_CONFIG.queue.maxAttempts },
        },
        {
          $set: {
            status: PredictionQueueStatus.FAILED,
            completedAt: new Date(),
            errorMessage:
              'Recovered stale processing lock after the retry limit was exhausted.',
          },
          $unset: { lockedAt: 1 },
        },
      )
      .exec();
    return (retryResult.modifiedCount ?? 0) + (failedResult.modifiedCount ?? 0);
  }

  async skip(
    job: Pick<PredictionQueue, 'eventId' | 'attempts'>,
    reason: string,
    durationMs = 0,
  ): Promise<void> {
    await this.queueModel
      .updateOne(
        { eventId: String(job.eventId) },
        {
          $set: {
            status: PredictionQueueStatus.SKIPPED,
            completedAt: new Date(),
            processingDurationMs: durationMs,
            errorMessage: reason,
          },
          $unset: { lockedAt: 1 },
        },
      )
      .exec();
    await this.monitor.recordEvent({
      type: 'PREDICTION_PARTIAL',
      level: 'WARNING',
      eventId: String(job.eventId),
      message: `Prediction queue item skipped for ${job.eventId}: ${reason}`,
      metadata: { attempts: job.attempts, reason },
    });
  }

  async deferForOddsNotReady(
    job: Pick<PredictionQueue, 'eventId' | 'attempts'>,
    reason: string,
  ): Promise<void> {
    await this.queueModel.updateOne(
      { eventId: String(job.eventId), status: PredictionQueueStatus.PROCESSING },
      {
        $set: {
          status: PredictionQueueStatus.WAITING_FOR_ODDS,
          reason: 'WAITING_FOR_ODDS',
          errorMessage: reason,
        },
        $inc: { attempts: -1 },
        $unset: { lockedAt: 1 },
      },
    ).exec();
  }

  async claimNext(): Promise<PredictionQueue | null> {
    const now = new Date();
    const job = await this.queueModel
      .findOneAndUpdate(
        {
          status: {
            $in: [PredictionQueueStatus.PENDING, PredictionQueueStatus.RETRY],
          },
          availableAt: { $lte: now },
          attempts: { $lt: PREDICTION_ENGINE_CONFIG.queue.maxAttempts },
        },
        {
          $set: { status: PredictionQueueStatus.PROCESSING, lockedAt: now },
          $unset: { errorMessage: 1, completedAt: 1 },
          $inc: { attempts: 1 },
        },
        { sort: { priority: -1, fixtureDate: 1, createdAt: 1 }, returnDocument: 'after' },
      )
      .lean()
      .exec();
    if (job) {
      await this.monitor.recordEvent({
        type: 'QUEUE_CLAIMED',
        level: 'INFO',
        eventId: job.eventId,
        message: `Prediction queue claimed event ${job.eventId} (attempt ${job.attempts}).`,
        metadata: {
          priority: job.priority,
          fixtureDate: job.fixtureDate,
          attempts: job.attempts,
        },
      });
    }
    return job;
  }

  async complete(
    job: Pick<PredictionQueue, 'eventId' | 'summaryCollectedAt' | 'oddsUpdatedAt' | 'scoreSnapshot'>,
    durationMs: number,
  ): Promise<void> {
    await this.queueModel
      .updateOne(
        { eventId: job.eventId },
        {
          $set: {
            status: PredictionQueueStatus.COMPLETED,
            completedAt: new Date(),
            lastProcessedSummaryAt: job.summaryCollectedAt,
            ...(job.oddsUpdatedAt ? { lastProcessedOddsAt: job.oddsUpdatedAt } : {}),
            ...(job.scoreSnapshot ? { lastProcessedScoreSnapshot: job.scoreSnapshot } : {}),
            processingDurationMs: durationMs,
          },
          $unset: { lockedAt: 1, errorMessage: 1 },
        },
      )
      .exec();
  }

  async fail(
    job: Pick<PredictionQueue, 'eventId' | 'attempts'>,
    errorMessage: string,
    durationMs: number,
  ): Promise<void> {
    const exhausted =
      Number(job.attempts ?? 0) >= PREDICTION_ENGINE_CONFIG.queue.maxAttempts;
    const delay = Math.min(
      PREDICTION_ENGINE_CONFIG.queue.maxRetryMs,
      PREDICTION_ENGINE_CONFIG.queue.retryBaseMs *
        Math.pow(2, Math.max(0, Number(job.attempts ?? 1) - 1)),
    );
    await this.queueModel
      .updateOne(
        { eventId: job.eventId },
        {
          $set: {
            status: exhausted
              ? PredictionQueueStatus.FAILED
              : PredictionQueueStatus.RETRY,
            availableAt: new Date(Date.now() + delay),
            errorMessage,
            processingDurationMs: durationMs,
            ...(exhausted ? { completedAt: new Date() } : {}),
          },
          $unset: { lockedAt: 1, ...(exhausted ? {} : { completedAt: 1 }) },
        },
      )
      .exec();
    await this.monitor.recordEvent({
      type: exhausted ? 'PREDICTION_FAILED' : 'RETRY_SCHEDULED',
      level: exhausted ? 'ERROR' : 'WARNING',
      eventId: job.eventId,
      message: exhausted
        ? `Prediction queue exhausted retries for ${job.eventId}: ${errorMessage}`
        : `Prediction retry scheduled for ${job.eventId} in ${Math.round(delay / 1000)} seconds: ${errorMessage}`,
      metadata: {
        attempts: job.attempts,
        delayMs: delay,
        exhausted,
        errorMessage,
      },
    });
  }
}

