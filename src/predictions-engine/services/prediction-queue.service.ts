import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import type { AnyBulkWriteOperation } from 'mongoose';

import { SportsDomainReadService } from '../../sports/services/sports-domain-read.service';
import type { SportsFixtureRecord } from '../../sports/interfaces/sports-domain.interface';
import { PredictionQueue } from '../schemas/prediction-queue.schema';
import { PredictionQueueStatus } from '../enums/prediction-queue-status.enum';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { PredictionQueueSyncResult } from '../interfaces/prediction-queue.interface';
import { PredictionEngineMonitorService } from './prediction-engine-monitor.service';
import { OddsReadService } from '../../odds/services/odds-read.service';
import { SportsDataChangeEventService } from '../../sports/services/sports-data-change-event.service';

export type ClaimedPredictionQueueJob = Pick<
  PredictionQueue,
  | 'eventId'
  | 'attempts'
  | 'lockToken'
  | 'summaryCollectedAt'
  | 'oddsUpdatedAt'
  | 'scoreSnapshot'
  | 'fixtureSourceRevision'
> & { lockToken: string };

const PREDICTION_QUEUE_SYNC_PAGE_SIZE = 100;
const PREDICTION_QUEUE_SYNC_WRITE_BATCH_SIZE = 100;

const TERMINAL_FIXTURE_STATES = new Set([
  'COMPLETED',
  'POSTPONED',
  'CANCELLED',
  'CANCELED',
  'ABANDONED',
]);

const LIVE_FIXTURE_STATES = new Set([
  'LIVE',
  'HALFTIME',
  'EXTRA_TIME',
  'PENALTIES',
  'IN_PROGRESS',
  'INPLAY',
  'IN_PLAY',
  'PLAYING',
  'SUSPENDED',
  'INTERRUPTED',
]);

@Injectable()
export class PredictionQueueService {
  private readonly logger = new Logger(PredictionQueueService.name);

  constructor(
    private readonly sportsRead: SportsDomainReadService,
    private readonly sportsRevisions: SportsDataChangeEventService,
    @InjectModel(PredictionQueue.name)
    private readonly queueModel: Model<PredictionQueue>,
    private readonly monitor: PredictionEngineMonitorService,
    private readonly oddsService: OddsReadService,
  ) {}

  /**
   * Reconciles every retained, future Sports fixture. This is deliberately not
   * restricted to a rolling kickoff horizon: the final fixture in a season must
   * enter the durable queue as soon as Sports knows about it.
   *
   * Fixtures are processed page-by-page to keep memory and MongoDB $in queries
   * bounded. A fixture receives a durable WAITING_FOR_ODDS row even when Grivit
   * has not priced any market yet. Once Odds becomes ready, the same row moves
   * to PENDING and can be claimed by a worker.
   */
  async syncUpcomingFixtures(
    force = false,
  ): Promise<PredictionQueueSyncResult> {
    const now = new Date();
    const pageSize = PREDICTION_QUEUE_SYNC_PAGE_SIZE;
    let cursor: string | undefined;
    let pagesScanned = 0;

    const totals: PredictionQueueSyncResult = {
      scannedFixtures: 0,
      eligibleFixtures: 0,
      enqueued: 0,
      refreshed: 0,
      missingSummary: 0,
      oddsNotReady: 0,
    };

    do {
      const page = await this.sportsRead.getFixtures({
        from: now,
        limit: pageSize,
        sortOrder: 'ASC',
        retainedOnly: true,
        ...(cursor ? { cursor } : {}),
      });
      pagesScanned += 1;

      const fixtures = (page.items ?? []).filter((fixture) => {
        if (!fixture?.id) return false;
        const state = String(fixture.status?.state ?? 'UNKNOWN').toUpperCase();
        if (TERMINAL_FIXTURE_STATES.has(state) || fixture.status?.isFinal === true) {
          return false;
        }
        // The queue is pre-match inventory. Live fixtures are not added as new
        // work by this full-season reconciliation; kickoff lifecycle handling is
        // implemented separately so a pending job cannot become an in-play run.
        if (LIVE_FIXTURE_STATES.has(state)) return false;
        const kickoff = this.toDate(fixture.kickoffAt);
        return Boolean(kickoff && kickoff.getTime() >= now.getTime());
      });

      if (fixtures.length) {
        const result = await this.syncFixtureBatch(fixtures, now, force);
        totals.scannedFixtures += result.scannedFixtures;
        totals.eligibleFixtures += result.eligibleFixtures;
        totals.enqueued += result.enqueued;
        totals.refreshed += result.refreshed;
        totals.missingSummary += result.missingSummary;
        totals.oddsNotReady = (totals.oddsNotReady ?? 0) + (result.oddsNotReady ?? 0);
      }

      cursor = page.nextCursor;
    } while (cursor);

    await this.monitor.recordQueueSync(totals);
    this.logger.log(
      `Full-season prediction queue reconciliation completed: pages=${pagesScanned}, fixtures=${totals.scannedFixtures}, oddsReady=${totals.eligibleFixtures}, waitingForOdds=${totals.oddsNotReady ?? 0}, enqueued=${totals.enqueued}, refreshed=${totals.refreshed}, missingSportsFreshness=${totals.missingSummary}.`,
    );

    return totals;
  }

  /** Reconcile one bounded Sports fixture page against Odds and existing queue rows. */
  private async syncFixtureBatch(
    fixtures: SportsFixtureRecord[],
    now: Date,
    force: boolean,
  ): Promise<PredictionQueueSyncResult> {
    if (!fixtures.length) {
      return {
        scannedFixtures: 0,
        eligibleFixtures: 0,
        enqueued: 0,
        refreshed: 0,
        missingSummary: 0,
        oddsNotReady: 0,
      };
    }

    const competitionIds = [...new Set(
      fixtures.map((fixture) => String(fixture.competitionId)).filter(Boolean),
    )];
    const competitions = await Promise.all(
      competitionIds.map((id) => this.sportsRead.getCompetition(id)),
    );
    const priorityMap = new Map<string, number>();
    competitions.forEach((competition, index) => {
      if (!competition) return;
      const region = String(competition.region ?? '').toUpperCase();
      const priority = region === 'EUROPE' ? 400
        : region === 'WORLD' ? 350
          : region === 'AFRICA' ? 300
            : region === 'SOUTH_AMERICA' ? 300
              : region === 'NIGERIA' ? 280
                : region === 'NORTH_AMERICA' ? 240
                  : region === 'ASIA' ? 220
                    : region === 'OCEANIA' ? 200 : 100;
      priorityMap.set(competitionIds[index], priority);
    });

    const eventIds = fixtures.map((fixture) => String(fixture.id));
    const [readinessByEvent, fixtureRevisionsByEvent] = await Promise.all([
      this.oddsService.getPredictionReadinessForEvents(eventIds),
      this.sportsRevisions.getCurrentRevisions('FIXTURE', eventIds),
    ]);
    const eligibleFixtures = fixtures.filter((fixture) =>
      readinessByEvent.get(String(fixture.id))?.ready === true,
    );

    const existingRows = (await this.queueModel
      .find({ eventId: { $in: eventIds } })
      .select({
        _id: 0,
        eventId: 1,
        leagueId: 1,
        fixtureDate: 1,
        priority: 1,
        status: 1,
        lastProcessedSummaryAt: 1,
        summaryCollectedAt: 1,
        fixtureSourceRevision: 1,
        lastProcessedFixtureSourceRevision: 1,
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
        errorMessage: 1,
        retentionExpiresAt: 1,
      })
      .lean()
      .exec()) as PredictionQueue[];
    const existingByEvent = new Map(
      existingRows.map((row) => [String(row.eventId), row]),
    );

    const operations: AnyBulkWriteOperation<PredictionQueue>[] = [];
    const bulkWriteBatchSize = PREDICTION_QUEUE_SYNC_WRITE_BATCH_SIZE;
    let firstBulkWriteError: unknown;
    let bulkWriteFailed = false;

    const flushOperations = async (): Promise<void> => {
      if (!operations.length) return;
      const batch = operations.splice(0, bulkWriteBatchSize);
      try {
        await this.queueModel.bulkWrite(batch, { ordered: false });
      } catch (error) {
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
    let missingSummary = 0;
    let oddsNotReady = 0;

    for (const fixture of fixtures) {
      const eventId = String(fixture.id);
      const existing = existingByEvent.get(eventId);
      const readiness = readinessByEvent.get(eventId);
      const fixtureDate = this.toDate(fixture.kickoffAt);
      if (!fixtureDate) continue;

      const sourceDate = this.toDate(
        fixture.source?.providerUpdatedAt ?? fixture.source?.collectedAt ?? fixture.updatedAt,
      ) ?? fixtureDate;
      if (!this.toDate(
        fixture.source?.providerUpdatedAt ?? fixture.source?.collectedAt ?? fixture.updatedAt,
      )) {
        missingSummary += 1;
      }

      const home = fixture.competitors.find((item) => item.homeAway === 'HOME');
      const away = fixture.competitors.find((item) => item.homeAway === 'AWAY');
      const snapshotScore = (value: unknown): number | 'NA' => {
        if (value === null || value === undefined || value === '') return 'NA';
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 'NA';
      };
      const scoreSnapshot = [
        snapshotScore(home?.score),
        snapshotScore(away?.score),
        String(fixture.status?.state ?? ''),
        String(fixture.status?.period ?? ''),
        String(fixture.status?.clock ?? fixture.status?.displayClock ?? ''),
      ].join('|');

      const latestOddsUpdatedAt = this.toDate(readiness?.latestOddsUpdatedAt);
      const retentionExpiresAt = this.toDate(fixture.retentionExpiresAt);
      const fixtureSourceRevision = fixtureRevisionsByEvent.get(eventId) ?? 0;
      const currentPriority = priorityMap.get(String(fixture.competitionId)) ?? 100;

      const setFields: Record<string, any> = {
        eventId,
        leagueId: String(fixture.competitionId),
        fixtureDate,
        priority: currentPriority,
        summaryCollectedAt: sourceDate,
        fixtureSourceRevision,
        modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
        scoreSnapshot,
        ...(latestOddsUpdatedAt ? { oddsUpdatedAt: latestOddsUpdatedAt } : {}),
        ...(retentionExpiresAt ? { retentionExpiresAt } : {}),
      };

      // A queue row is created for every retained upcoming fixture, even when
      // the Odds module has not yet priced a single market. This is the key
      // coverage correction: absence of Odds no longer means absence of a job.
      if (!readiness?.ready) {
        oddsNotReady += 1;
        if (existing?.status === PredictionQueueStatus.PROCESSING) continue;

        const currentFixtureDate = this.toDate(existing?.fixtureDate);
        const currentSourceDate = this.toDate(existing?.summaryCollectedAt);
        const currentRetentionDate = this.toDate(existing?.retentionExpiresAt);
        const waitingReason = readiness?.reason
          ?? 'Odds module has not marked this Sports fixture prediction-ready.';
        const needsWaitingUpdate = !existing
          || existing.status !== PredictionQueueStatus.WAITING_FOR_ODDS
          || !currentFixtureDate
          || currentFixtureDate.getTime() !== fixtureDate.getTime()
          || !currentSourceDate
          || currentSourceDate.getTime() !== sourceDate.getTime()
          || existing.modelVersion !== PREDICTION_ENGINE_CONFIG.modelVersion
          || Number(existing.fixtureSourceRevision ?? -1) !== fixtureSourceRevision
          || existing.leagueId !== String(fixture.competitionId)
          || existing.priority !== currentPriority
          || existing.scoreSnapshot !== scoreSnapshot
          || existing.errorMessage !== waitingReason
          || Number(existing.attempts ?? 0) !== 0
          || (retentionExpiresAt?.getTime() ?? 0) !== (currentRetentionDate?.getTime() ?? 0)
          || force;

        if (!needsWaitingUpdate) continue;

        await pushOperation({
          updateOne: {
            filter: {
              eventId,
              status: { $ne: PredictionQueueStatus.PROCESSING },
            },
            update: {
              $set: {
                ...setFields,
                status: PredictionQueueStatus.WAITING_FOR_ODDS,
                availableAt: now,
                // Reset attempts for an existing row. For a new row, initialize
                // attempts through $setOnInsert below so MongoDB never receives
                // the same path in both update operators.
                ...(existing ? { attempts: 0 } : {}),
                reason: 'WAITING_FOR_ODDS',
                errorMessage: waitingReason,
              },
              ...(existing ? {} : { $setOnInsert: { attempts: 0, refreshCount: 0 } }),
              $unset: {
                lockedAt: 1,
                lockToken: 1,
                completedAt: 1,
                ...(!retentionExpiresAt ? { retentionExpiresAt: 1 } : {}),
              },
            },
            upsert: !existing,
          },
        });

        if (!existing) enqueued += 1;
        else refreshed += 1;
        continue;
      }

      if (existing?.status === PredictionQueueStatus.PROCESSING) continue;

      const previouslyProcessedDate = this.toDate(existing?.lastProcessedSummaryAt);
      const priorSourceDate = existing?.status === PredictionQueueStatus.COMPLETED
        ? previouslyProcessedDate
        : this.toDate(existing?.summaryCollectedAt) ?? previouslyProcessedDate;
      const sourceChanged = Boolean(
        sourceDate && (!priorSourceDate || sourceDate.getTime() > priorSourceDate.getTime()),
      );

      const previouslyProcessedOddsDate = existing?.status === PredictionQueueStatus.COMPLETED
        ? this.toDate(existing?.lastProcessedOddsAt)
        : this.toDate(existing?.oddsUpdatedAt) ?? this.toDate(existing?.lastProcessedOddsAt);
      const oddsChanged = Boolean(
        latestOddsUpdatedAt
        && (!previouslyProcessedOddsDate || latestOddsUpdatedAt.getTime() > previouslyProcessedOddsDate.getTime()),
      );
      const modelChanged = Boolean(
        existing && existing.modelVersion !== PREDICTION_ENGINE_CONFIG.modelVersion,
      );
      const scoreChanged = Boolean(
        existing && scoreSnapshot !== (existing.lastProcessedScoreSnapshot ?? existing.scoreSnapshot ?? ''),
      );
      const currentFixtureDate = this.toDate(existing?.fixtureDate);
      const kickoffChanged = Boolean(
        existing && (!currentFixtureDate || currentFixtureDate.getTime() !== fixtureDate.getTime()),
      );
      const currentRetentionDate = this.toDate(existing?.retentionExpiresAt);
      const retentionChanged = Boolean(
        existing && (retentionExpiresAt?.getTime() ?? 0) !== (currentRetentionDate?.getTime() ?? 0),
      );
      const revisionBaseline = existing?.status === PredictionQueueStatus.COMPLETED
        || existing?.status === PredictionQueueStatus.FAILED
        || existing?.status === PredictionQueueStatus.SKIPPED
        ? existing.lastProcessedFixtureSourceRevision ?? existing.fixtureSourceRevision
        : existing?.fixtureSourceRevision;
      const fixtureRevisionChanged = Boolean(
        existing && Number(revisionBaseline ?? -1) !== fixtureSourceRevision,
      );

      const existingCompletedAt = this.toDate(existing?.completedAt);
      const refreshCompletedDue = Boolean(
        existing?.status === PredictionQueueStatus.COMPLETED
        && existingCompletedAt
        && now.getTime() - existingCompletedAt.getTime() >= PREDICTION_ENGINE_CONFIG.queue.completedRefreshIntervalMs,
      );
      const recoverFailedDue = Boolean(
        existing?.status === PredictionQueueStatus.FAILED
        && existingCompletedAt
        && now.getTime() - existingCompletedAt.getTime() >= PREDICTION_ENGINE_CONFIG.queue.failedRecoveryIntervalMs,
      );
      const retryAvailableAt = this.toDate(existing?.availableAt);
      const retryDue = Boolean(
        existing?.status === PredictionQueueStatus.RETRY
        && (!retryAvailableAt || retryAvailableAt.getTime() <= now.getTime()),
      );
      const terminalStatus = [
        PredictionQueueStatus.COMPLETED,
        PredictionQueueStatus.FAILED,
        PredictionQueueStatus.SKIPPED,
      ].includes(existing?.status as PredictionQueueStatus);
      const inputsChanged = sourceChanged || oddsChanged || modelChanged || scoreChanged || kickoffChanged || retentionChanged || fixtureRevisionChanged;
      const shouldRequeue = !existing
        || existing.status === PredictionQueueStatus.WAITING_FOR_ODDS
        || (existing.status === PredictionQueueStatus.PENDING && (inputsChanged || force))
        || (existing.status === PredictionQueueStatus.RETRY && (retryDue || inputsChanged || force))
        || (terminalStatus && (force || inputsChanged || refreshCompletedDue || recoverFailedDue));

      if (!existing || shouldRequeue) {
        setFields.status = PredictionQueueStatus.PENDING;
        setFields.availableAt = now;
        setFields.reason = !existing
          ? 'INITIAL'
          : existing.status === PredictionQueueStatus.WAITING_FOR_ODDS
            ? 'ODDS_BECAME_READY'
            : modelChanged
              ? 'MODEL_VERSION_UPDATED'
              : oddsChanged
                ? 'ODDS_UPDATED'
                : scoreChanged
                  ? 'SPORTS_FIXTURE_STATE_UPDATED'
                  : fixtureRevisionChanged
                    ? 'SPORTS_FIXTURE_REVISION_UPDATED'
                    : sourceChanged
                      ? 'SPORTS_FIXTURE_UPDATED'
                      : kickoffChanged
                      ? 'FIXTURE_KICKOFF_UPDATED'
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
        if (existing && inputsChanged) {
          setFields.refreshCount = (existing.refreshCount ?? 0) + 1;
        }
      }

      const metadataChanged = !existing
        || existing.leagueId !== String(fixture.competitionId)
        || existing.priority !== currentPriority
        || kickoffChanged
        || sourceChanged
        || oddsChanged
        || modelChanged
        || scoreChanged
        || retentionChanged
        || fixtureRevisionChanged;

      if (!existing || shouldRequeue || metadataChanged) {
        const update: Record<string, any> = { $set: setFields };
        if (!existing) update.$setOnInsert = { attempts: 0, refreshCount: 0 };
        if (shouldRequeue || !retentionExpiresAt) {
          update.$unset = {
            ...(shouldRequeue ? { errorMessage: 1, lockedAt: 1, lockToken: 1, completedAt: 1 } : {}),
            ...(!retentionExpiresAt ? { retentionExpiresAt: 1 } : {}),
          };
        }

        await pushOperation({
          updateOne: {
            filter: {
              eventId,
              status: { $ne: PredictionQueueStatus.PROCESSING },
            },
            update,
            upsert: !existing,
          },
        });

        if (!existing) enqueued += 1;
        else if (shouldRequeue) refreshed += 1;
      }
    }

    await flushOperations();
    if (bulkWriteFailed) throw firstBulkWriteError;

    return {
      scannedFixtures: fixtures.length,
      eligibleFixtures: eligibleFixtures.length,
      enqueued,
      refreshed,
      missingSummary,
      oddsNotReady,
    };
  }

  private toDate(value: unknown): Date | null {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date : null;
    }
    return null;
  }

  /**
   * Apply a Sports/Odds source-change trigger to one fixture. The source-change
   * worker calls this only after the Odds worker has completed repricing.
   * Processing rows are not unlocked or overwritten: they receive a durable
   * refresh marker and are returned to PENDING by complete()/fail() afterwards.
   */
  async requestFixtureRefresh(
    eventId: string,
    sourceChangeEventId?: string,
  ): Promise<'QUEUED' | 'WAITING_FOR_ODDS' | 'REFRESH_REQUESTED' | 'SKIPPED'> {
    const id = String(eventId ?? '').trim();
    if (!id) return 'SKIPPED';

    const fixture = await this.sportsRead.getFixture(id);
    if (!fixture) return 'SKIPPED';

    const now = new Date();
    const kickoffAt = this.toDate(fixture.kickoffAt);
    const state = String(fixture.status?.state ?? 'UNKNOWN').toUpperCase();
    if (
      !kickoffAt ||
      kickoffAt.getTime() <= now.getTime() ||
      TERMINAL_FIXTURE_STATES.has(state) ||
      LIVE_FIXTURE_STATES.has(state) ||
      fixture.status?.isFinal === true
    ) {
      return 'SKIPPED';
    }

    const [readinessByEvent, fixtureSourceRevision] = await Promise.all([
      this.oddsService.getPredictionReadinessForEvents([id]),
      this.sportsRevisions.getCurrentRevision('FIXTURE', id),
    ]);
    const readiness = readinessByEvent.get(id);
    const competition = await this.sportsRead.getCompetition(String(fixture.competitionId));
    const region = String(competition?.region ?? '').toUpperCase();
    const priority = region === 'EUROPE' ? 400
      : region === 'WORLD' ? 350
        : region === 'AFRICA' ? 300
          : region === 'SOUTH_AMERICA' ? 300
            : region === 'NIGERIA' ? 280
              : region === 'NORTH_AMERICA' ? 240
                : region === 'ASIA' ? 220
                  : region === 'OCEANIA' ? 200 : 100;
    const sourceDate = this.toDate(
      fixture.source?.providerUpdatedAt ?? fixture.source?.collectedAt ?? fixture.updatedAt,
    ) ?? kickoffAt;
    const latestOddsUpdatedAt = this.toDate(readiness?.latestOddsUpdatedAt);
    const retentionExpiresAt = this.toDate(fixture.retentionExpiresAt);
    const snapshotScore = (value: unknown): number | 'NA' => {
      if (value === null || value === undefined || value === '') return 'NA';
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 'NA';
    };
    const home = fixture.competitors.find((item) => item.homeAway === 'HOME');
    const away = fixture.competitors.find((item) => item.homeAway === 'AWAY');
    const scoreSnapshot = [
      snapshotScore(home?.score),
      snapshotScore(away?.score),
      state,
      String(fixture.status?.period ?? ''),
      String(fixture.status?.clock ?? fixture.status?.displayClock ?? ''),
    ].join('|');
    const ready = readiness?.ready === true;
    const waitingReason = readiness?.reason
      ?? 'Grivit has not produced a prediction-ready price for this fixture.';
    const updateFields: Record<string, unknown> = {
      eventId: id,
      leagueId: String(fixture.competitionId),
      fixtureDate: kickoffAt,
      priority,
      summaryCollectedAt: sourceDate,
      fixtureSourceRevision,
      modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
      scoreSnapshot,
      status: ready ? PredictionQueueStatus.PENDING : PredictionQueueStatus.WAITING_FOR_ODDS,
      availableAt: now,
      attempts: 0,
      reason: ready ? 'SPORTS_ODDS_SOURCE_CHANGED' : 'WAITING_FOR_ODDS',
      refreshCount: 0,
      ...(latestOddsUpdatedAt ? { oddsUpdatedAt: latestOddsUpdatedAt } : {}),
      ...(retentionExpiresAt ? { retentionExpiresAt } : {}),
      ...(!ready ? { errorMessage: waitingReason } : {}),
    };

    // Retry the conditional transition if a prediction worker claims or
    // completes this row between our read and update. The unique eventId keeps
    // fixture-level coalescing intact.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await this.queueModel.findOne({ eventId: id })
        .select({ status: 1, refreshCount: 1 })
        .lean()
        .exec() as Pick<PredictionQueue, 'status' | 'refreshCount'> | null;

      if (existing?.status === PredictionQueueStatus.PROCESSING) {
        const marked = await this.queueModel.updateOne(
          { eventId: id, status: PredictionQueueStatus.PROCESSING },
          {
            $set: {
              fixtureDate: kickoffAt,
              leagueId: String(fixture.competitionId),
              priority,
              summaryCollectedAt: sourceDate,
              fixtureSourceRevision,
              modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
              scoreSnapshot,
              ...(latestOddsUpdatedAt ? { oddsUpdatedAt: latestOddsUpdatedAt } : {}),
              ...(retentionExpiresAt ? { retentionExpiresAt } : {}),
              refreshRequestedAt: now,
              refreshRequestedReason: ready ? 'SPORTS_ODDS_SOURCE_CHANGED' : 'SPORTS_SOURCE_CHANGED',
              ...(sourceChangeEventId ? { sourceChangeEventId } : {}),
            },
          },
        ).exec();
        if ((marked.matchedCount ?? marked.modifiedCount ?? 0) > 0) return 'REFRESH_REQUESTED';
        continue;
      }

      const nextFields = {
        ...updateFields,
        refreshCount: Number(existing?.refreshCount ?? 0) + (existing ? 1 : 0),
      };
      try {
        const updated = await this.queueModel.updateOne(
          { eventId: id, status: { $ne: PredictionQueueStatus.PROCESSING } },
          {
            $set: nextFields,
            $unset: {
              lockedAt: 1,
              lockToken: 1,
              completedAt: 1,
              refreshRequestedAt: 1,
              refreshRequestedReason: 1,
              sourceChangeEventId: 1,
              ...(ready ? { errorMessage: 1 } : {}),
              ...(!retentionExpiresAt ? { retentionExpiresAt: 1 } : {}),
            },
          },
          { upsert: !existing },
        ).exec();
        if ((updated.matchedCount ?? 0) > 0 || (updated.upsertedCount ?? 0) > 0) {
          return ready ? 'QUEUED' : 'WAITING_FOR_ODDS';
        }
      } catch (error) {
        // A concurrent first insert can win the unique eventId race. Re-read
        // the winner and perform the appropriate conditional transition.
        const code = error && typeof error === 'object' && 'code' in error
          ? Number((error as { code?: unknown }).code)
          : 0;
        if (code !== 11000) throw error;
      }
    }

    throw new Error(`Could not safely apply source-change trigger to prediction queue row ${id}.`);
  }

  async recoverStaleProcessing(): Promise<number> {
    const cutoff = new Date(
      Date.now() - PREDICTION_ENGINE_CONFIG.queue.staleProcessingMs,
    );
    const refreshResult = await this.queueModel
      .updateMany(
        {
          status: PredictionQueueStatus.PROCESSING,
          lockedAt: { $lt: cutoff },
          refreshRequestedAt: { $exists: true },
        },
        {
          $set: {
            status: PredictionQueueStatus.PENDING,
            availableAt: new Date(),
            attempts: 0,
            reason: 'SOURCE_CHANGED_DURING_PROCESSING',
            errorMessage: 'A newer Sports/Odds source update arrived before the previous worker lease expired; recalculation was requeued.',
          },
          $inc: { refreshCount: 1 },
          $unset: {
            lockedAt: 1,
            lockToken: 1,
            completedAt: 1,
            refreshRequestedAt: 1,
            refreshRequestedReason: 1,
            sourceChangeEventId: 1,
          },
        },
      )
      .exec();
    const retryResult = await this.queueModel
      .updateMany(
        {
          status: PredictionQueueStatus.PROCESSING,
          lockedAt: { $lt: cutoff },
          refreshRequestedAt: { $exists: false },
          attempts: { $lt: PREDICTION_ENGINE_CONFIG.queue.maxAttempts },
        },
        {
          $set: {
            status: PredictionQueueStatus.RETRY,
            availableAt: new Date(),
            errorMessage: 'Recovered stale processing lock; retry scheduled.',
          },
          $unset: { lockedAt: 1, lockToken: 1 },
        },
      )
      .exec();
    const failedResult = await this.queueModel
      .updateMany(
        {
          status: PredictionQueueStatus.PROCESSING,
          lockedAt: { $lt: cutoff },
          refreshRequestedAt: { $exists: false },
          attempts: { $gte: PREDICTION_ENGINE_CONFIG.queue.maxAttempts },
        },
        {
          $set: {
            status: PredictionQueueStatus.FAILED,
            completedAt: new Date(),
            errorMessage:
              'Recovered stale processing lock after the retry limit was exhausted.',
          },
          $unset: { lockedAt: 1, lockToken: 1 },
        },
      )
      .exec();
    return (refreshResult.modifiedCount ?? 0) + (retryResult.modifiedCount ?? 0) + (failedResult.modifiedCount ?? 0);
  }

  async skip(
    job: Pick<ClaimedPredictionQueueJob, 'eventId' | 'attempts' | 'lockToken'>,
    reason: string,
    durationMs = 0,
  ): Promise<boolean> {
    const filter = {
      eventId: String(job.eventId),
      status: PredictionQueueStatus.PROCESSING,
      lockToken: job.lockToken,
    };
    const refreshedDuringProcessing = await this.queueModel.updateOne(
      { ...filter, refreshRequestedAt: { $exists: true } },
      {
        $set: {
          status: PredictionQueueStatus.PENDING,
          availableAt: new Date(),
          attempts: 0,
          reason: 'SOURCE_CHANGED_DURING_PROCESSING',
          errorMessage: 'A newer Sports/Odds source update arrived while this run was processing; recalculation was queued.',
          processingDurationMs: durationMs,
        },
        $inc: { refreshCount: 1 },
        $unset: {
          lockedAt: 1,
          lockToken: 1,
          completedAt: 1,
          refreshRequestedAt: 1,
          refreshRequestedReason: 1,
          sourceChangeEventId: 1,
        },
      },
    ).exec();
    if ((refreshedDuringProcessing.modifiedCount ?? 0) > 0) return true;

    const result = await this.queueModel.updateOne(
      { ...filter, refreshRequestedAt: { $exists: false } },
      {
        $set: {
          status: PredictionQueueStatus.SKIPPED,
          completedAt: new Date(),
          processingDurationMs: durationMs,
          errorMessage: reason,
        },
        $unset: { lockedAt: 1, lockToken: 1 },
      },
    ).exec();

    let skipped = (result.modifiedCount ?? 0) > 0;
    if (!skipped) {
      // A source change can race the ordinary SKIPPED transition. It must win
      // so the new evidence receives a fresh prediction attempt.
      const lateRefresh = await this.queueModel.updateOne(
        { ...filter, refreshRequestedAt: { $exists: true } },
        {
          $set: {
            status: PredictionQueueStatus.PENDING,
            availableAt: new Date(),
            attempts: 0,
            reason: 'SOURCE_CHANGED_DURING_PROCESSING',
            errorMessage: 'A newer Sports/Odds source update arrived while this run was processing; recalculation was queued.',
            processingDurationMs: durationMs,
          },
          $inc: { refreshCount: 1 },
          $unset: {
            lockedAt: 1,
            lockToken: 1,
            completedAt: 1,
            refreshRequestedAt: 1,
            refreshRequestedReason: 1,
            sourceChangeEventId: 1,
          },
        },
      ).exec();
      skipped = (lateRefresh.modifiedCount ?? 0) > 0;
    }
    if (!skipped) return false;

    await this.monitor.recordEvent({
      type: 'PREDICTION_PARTIAL',
      level: 'WARNING',
      eventId: String(job.eventId),
      message: `Prediction queue item skipped for ${job.eventId}: ${reason}`,
      metadata: { attempts: job.attempts, reason },
    });
    return true;
  }

  async deferForOddsNotReady(
    job: Pick<ClaimedPredictionQueueJob, 'eventId' | 'attempts' | 'lockToken'>,
    reason: string,
  ): Promise<boolean> {
    const result = await this.queueModel.updateOne(
      {
        eventId: String(job.eventId),
        status: PredictionQueueStatus.PROCESSING,
        lockToken: job.lockToken,
      },
      {
        $set: {
          status: PredictionQueueStatus.WAITING_FOR_ODDS,
          reason: 'WAITING_FOR_ODDS',
          errorMessage: reason,
        },
        $inc: { attempts: -1 },
        $unset: {
          lockedAt: 1,
          lockToken: 1,
          refreshRequestedAt: 1,
          refreshRequestedReason: 1,
          sourceChangeEventId: 1,
        },
      },
    ).exec();
    return (result.modifiedCount ?? 0) > 0;
  }

  async claimNext(): Promise<ClaimedPredictionQueueJob | null> {
    const now = new Date();
    const lockToken = randomUUID();
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
          $set: {
            status: PredictionQueueStatus.PROCESSING,
            lockedAt: now,
            lockToken,
          },
          $unset: { errorMessage: 1, completedAt: 1 },
          $inc: { attempts: 1 },
        },
        { sort: { priority: -1, fixtureDate: 1, createdAt: 1 }, returnDocument: 'after' },
      )
      .lean()
      .exec();
    if (job) {
      void this.monitor
        .recordEvent({
          type: 'QUEUE_CLAIMED',
          level: 'INFO',
          eventId: job.eventId,
          message: `Prediction queue claimed event ${job.eventId} (attempt ${job.attempts}).`,
          metadata: {
            priority: job.priority,
            fixtureDate: job.fixtureDate,
            attempts: job.attempts,
          },
        })
        .catch((error) =>
          this.logger.warn(
            `Could not record prediction queue claim for ${job.eventId}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      return job as unknown as ClaimedPredictionQueueJob;
    }
    return null;
  }

  async renewProcessingLease(eventId: string, lockToken: string): Promise<boolean> {
    const result = await this.queueModel
      .updateOne(
        {
          eventId,
          status: PredictionQueueStatus.PROCESSING,
          lockToken,
        },
        { $set: { lockedAt: new Date() } },
      )
      .exec();
    return (result.modifiedCount ?? 0) > 0;
  }

  async complete(
    job: Pick<
      ClaimedPredictionQueueJob,
      'eventId' | 'lockToken' | 'summaryCollectedAt' | 'oddsUpdatedAt' | 'scoreSnapshot' | 'fixtureSourceRevision'
    >,
    durationMs: number,
    processedFixtureSourceRevision?: number,
  ): Promise<boolean> {
    const filter = {
      eventId: job.eventId,
      status: PredictionQueueStatus.PROCESSING,
      lockToken: job.lockToken,
    };
    const processedRevisionValue = Number(
      processedFixtureSourceRevision ?? job.fixtureSourceRevision ?? 0,
    );
    const processedRevision = Number.isSafeInteger(processedRevisionValue)
      && processedRevisionValue >= 0
      ? processedRevisionValue
      : 0;
    const currentFixtureSourceRevision = await this.sportsRevisions.getCurrentRevision(
      'FIXTURE',
      String(job.eventId),
    );
    const fixtureChangedDuringProcessing = currentFixtureSourceRevision !== processedRevision;

    // A source trigger may be waiting in the Sports outbox and not yet have
    // written refreshRequestedAt. Revision comparison closes that gap: never
    // mark a run complete when it consumed an older fixture source generation.
    const refreshFilter = fixtureChangedDuringProcessing
      ? filter
      : { ...filter, refreshRequestedAt: { $exists: true } };
    const refreshReason = fixtureChangedDuringProcessing
      ? 'SPORTS_FIXTURE_REVISION_CHANGED_DURING_PROCESSING'
      : 'SOURCE_CHANGED_DURING_PROCESSING';
    const refreshed = await this.queueModel.updateOne(
      refreshFilter,
      {
        $set: {
          status: PredictionQueueStatus.PENDING,
          availableAt: new Date(),
          attempts: 0,
          reason: refreshReason,
          fixtureSourceRevision: currentFixtureSourceRevision,
          lastProcessedFixtureSourceRevision: processedRevision,
          lastProcessedSummaryAt: job.summaryCollectedAt,
          ...(job.oddsUpdatedAt ? { lastProcessedOddsAt: job.oddsUpdatedAt } : {}),
          ...(job.scoreSnapshot ? { lastProcessedScoreSnapshot: job.scoreSnapshot } : {}),
          processingDurationMs: durationMs,
        },
        $inc: { refreshCount: 1 },
        $unset: {
          lockedAt: 1,
          lockToken: 1,
          errorMessage: 1,
          completedAt: 1,
          refreshRequestedAt: 1,
          refreshRequestedReason: 1,
          sourceChangeEventId: 1,
        },
      },
    ).exec();
    if ((refreshed.modifiedCount ?? 0) > 0) return true;

    const completed = await this.queueModel.updateOne(
      { ...filter, refreshRequestedAt: { $exists: false } },
      {
        $set: {
          status: PredictionQueueStatus.COMPLETED,
          completedAt: new Date(),
          fixtureSourceRevision: currentFixtureSourceRevision,
          lastProcessedFixtureSourceRevision: processedRevision,
          lastProcessedSummaryAt: job.summaryCollectedAt,
          ...(job.oddsUpdatedAt ? { lastProcessedOddsAt: job.oddsUpdatedAt } : {}),
          ...(job.scoreSnapshot ? { lastProcessedScoreSnapshot: job.scoreSnapshot } : {}),
          processingDurationMs: durationMs,
        },
        $unset: { lockedAt: 1, lockToken: 1, errorMessage: 1 },
      },
    ).exec();
    if ((completed.modifiedCount ?? 0) > 0) return true;

    // Close the existing marker race. A source event that arrives after the
    // first marker check is still converted into durable pending work.
    const lateRefresh = await this.queueModel.updateOne(
      { ...filter, refreshRequestedAt: { $exists: true } },
      {
        $set: {
          status: PredictionQueueStatus.PENDING,
          availableAt: new Date(),
          attempts: 0,
          reason: 'SOURCE_CHANGED_DURING_PROCESSING',
          fixtureSourceRevision: currentFixtureSourceRevision,
          lastProcessedFixtureSourceRevision: processedRevision,
          lastProcessedSummaryAt: job.summaryCollectedAt,
          ...(job.oddsUpdatedAt ? { lastProcessedOddsAt: job.oddsUpdatedAt } : {}),
          ...(job.scoreSnapshot ? { lastProcessedScoreSnapshot: job.scoreSnapshot } : {}),
          processingDurationMs: durationMs,
        },
        $inc: { refreshCount: 1 },
        $unset: {
          lockedAt: 1,
          lockToken: 1,
          errorMessage: 1,
          completedAt: 1,
          refreshRequestedAt: 1,
          refreshRequestedReason: 1,
          sourceChangeEventId: 1,
        },
      },
    ).exec();
    return (lateRefresh.modifiedCount ?? 0) > 0;
  }

  async fail(
    job: Pick<ClaimedPredictionQueueJob, 'eventId' | 'attempts' | 'lockToken'>,
    errorMessage: string,
    durationMs: number,
  ): Promise<boolean> {
    const exhausted =
      Number(job.attempts ?? 0) >= PREDICTION_ENGINE_CONFIG.queue.maxAttempts;
    const delay = Math.min(
      PREDICTION_ENGINE_CONFIG.queue.maxRetryMs,
      PREDICTION_ENGINE_CONFIG.queue.retryBaseMs *
        Math.pow(2, Math.max(0, Number(job.attempts ?? 1) - 1)),
    );
    const filter = {
      eventId: job.eventId,
      status: PredictionQueueStatus.PROCESSING,
      lockToken: job.lockToken,
    };
    const refreshedDuringProcessing = await this.queueModel.updateOne(
      { ...filter, refreshRequestedAt: { $exists: true } },
      {
        $set: {
          status: PredictionQueueStatus.PENDING,
          availableAt: new Date(),
          attempts: 0,
          reason: 'SOURCE_CHANGED_DURING_PROCESSING',
          errorMessage: 'A newer Sports/Odds source update arrived while this run was processing; recalculation was queued.',
          processingDurationMs: durationMs,
        },
        $inc: { refreshCount: 1 },
        $unset: {
          lockedAt: 1,
          lockToken: 1,
          completedAt: 1,
          refreshRequestedAt: 1,
          refreshRequestedReason: 1,
          sourceChangeEventId: 1,
        },
      },
    ).exec();
    if ((refreshedDuringProcessing.modifiedCount ?? 0) > 0) return true;

    const result = await this.queueModel
      .updateOne(
        { ...filter, refreshRequestedAt: { $exists: false } },
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
          $unset: { lockedAt: 1, lockToken: 1, ...(exhausted ? {} : { completedAt: 1 }) },
        },
      )
      .exec();

    let failed = (result.modifiedCount ?? 0) > 0;
    if (!failed) {
      // Close the race where a newer Sports/Odds trigger arrives after the
      // refresh-marker check but before the ordinary RETRY/FAILED transition.
      const lateRefresh = await this.queueModel.updateOne(
        { ...filter, refreshRequestedAt: { $exists: true } },
        {
          $set: {
            status: PredictionQueueStatus.PENDING,
            availableAt: new Date(),
            attempts: 0,
            reason: 'SOURCE_CHANGED_DURING_PROCESSING',
            errorMessage: 'A newer Sports/Odds source update arrived while this run was processing; recalculation was queued.',
            processingDurationMs: durationMs,
          },
          $inc: { refreshCount: 1 },
          $unset: {
            lockedAt: 1,
            lockToken: 1,
            completedAt: 1,
            refreshRequestedAt: 1,
            refreshRequestedReason: 1,
            sourceChangeEventId: 1,
          },
        },
      ).exec();
      failed = (lateRefresh.modifiedCount ?? 0) > 0;
      if (!failed) return false;

      await this.monitor.recordEvent({
        type: 'PREDICTION_PARTIAL',
        level: 'WARNING',
        eventId: job.eventId,
        message: `A newer Sports/Odds source update superseded the failed run for ${job.eventId}; recalculation was queued.`,
        metadata: { attempts: job.attempts, sourceChangedDuringProcessing: true },
      });
      return true;
    }

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
    return true;
  }
}
