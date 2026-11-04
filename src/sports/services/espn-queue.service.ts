import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { EspnQueue, EspnQueueDocument } from '../schemas/espn-queue.schema';

import {
  EspnQueueFailureCategory,
  EspnQueueJobType,
  EspnQueueLane,
  EspnQueueStatus,
} from '../interfaces/espn-queue.interface';

import { SportsSyncUnitStatus } from '../schemas/sports-sync-state.schema';

import { SportsSyncStateService } from './sports-sync-state.service';

import { SPORTS_DATA_COLLECTION_CONFIG } from '../config/sports-data-collection.config';

@Injectable()
export class EspnQueueService {
  private startupReady = false;

  private normalOperationsReady = false;

  private readonly normalOperationsReadyWaiters = new Set<() => void>();

  private wakeHandler?: () => void;

  setWakeHandler(handler: (() => void) | undefined): void {
    this.wakeHandler = handler;
  }

  /** Wake the event-driven worker after durable queue mutations. */
  notifyWorker(): void {
    this.wakeHandler?.();
  }

  constructor(
    @InjectModel(EspnQueue.name)
    private readonly queueModel: Model<EspnQueueDocument>,

    private readonly sportsSyncStateService: SportsSyncStateService,
  ) {}

  // ============================================================
  // STARTUP READINESS
  // ============================================================

  isStartupReady(): boolean {
    return this.startupReady;
  }

  markStartupReady(): void {
    this.startupReady = true;
  }

  isNormalOperationsReady(): boolean {
    return this.normalOperationsReady;
  }

  markNormalOperationsReady(): void {
    if (this.normalOperationsReady) return;
    this.normalOperationsReady = true;

    for (const resolve of this.normalOperationsReadyWaiters) resolve();
    this.normalOperationsReadyWaiters.clear();
  }

  /**
   * Shared startup barrier for modules that depend on ESPN's initial data load.
   * Resolves only after SportsStartupService has completed its bootstrap and
   * explicitly released normal operations.
   */
  waitForNormalOperationsReady(): Promise<void> {
    if (this.normalOperationsReady) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const waiter = () => resolve();
      this.normalOperationsReadyWaiters.add(waiter);
      // Close the small race between the first readiness check and waiter add.
      if (this.normalOperationsReady) {
        this.normalOperationsReadyWaiters.delete(waiter);
        resolve();
      }
    });
  }

  // ============================================================
  // ADD FIXTURE REFRESH
  // ============================================================

  /**
   * Creates a fixture-refresh operational queue job.
   *
   * The triggerEventId differentiates operational queue jobs:
   *
   *   DAILY:2026-09-26
   *   STALE:2026-09-26
   *   FINISHED:401884783
   *
   * However, all FIXTURE_REFRESH jobs for the same league/season
   * use the SAME persistent SportsSyncState document.
   *
   * Sync-state identity:
   *
   *   QUEUE:FIXTURE_REFRESH:<league>:<season>
   *
   * Operational queue-job identity remains trigger-specific.
   */
  async addFixtureRefreshJob(params: {
    leagueId: string;
    season?: number;
    priority: number;
    scheduledFor?: Date;
    triggerEventId?: string;
  }): Promise<EspnQueueDocument> {
    return this.addJob({
      jobType: EspnQueueJobType.FIXTURE_REFRESH,

      leagueId: params.leagueId,

      season: params.season,

      priority: params.priority,

      scheduledFor: params.scheduledFor ?? new Date(),

      triggerEventId: params.triggerEventId,
    });
  }

  // ============================================================
  // ADD SUMMARY REFRESH
  // ============================================================

  /**
   * Creates a Summary-refresh job for one ESPN fixture.
   *
   * Summary is persisted inside:
   *
   *   sports_espn_fixtures.payload.summary
   *
   * Existing Summary payloads are refreshed when their freshness
   * timestamp is stale or when a match has just finished.
   */
  async addSummaryRefreshJob(params: {
    leagueId: string;
    eventId: string;
    season: number;
    priority: number;
    scheduledFor?: Date;
    triggerEventId?: string;
  }): Promise<EspnQueueDocument> {
    return this.addJob({
      jobType: EspnQueueJobType.SUMMARY_REFRESH,
      leagueId: params.leagueId,
      eventId: params.eventId,
      season: params.season,
      priority: params.priority,
      scheduledFor: params.scheduledFor ?? new Date(),
      triggerEventId: params.triggerEventId,
    });
  }

  // ============================================================
  // ADD YOUTUBE HIGHLIGHT
  // ============================================================

  /**
   * Creates a YouTube-highlight job for one completed ESPN fixture.
   *
   * YouTube eligibility is decided by EspnQueueBuilderService
   * before this method is called.
   */
  async addYoutubeHighlightJob(params: {
    leagueId: string;
    eventId: string;
    season: number;
    priority: number;
    scheduledFor?: Date;
    triggerEventId?: string;
  }): Promise<EspnQueueDocument> {
    return this.addJob({
      jobType: EspnQueueJobType.YOUTUBE_HIGHLIGHT,
      leagueId: params.leagueId,
      eventId: params.eventId,
      season: params.season,
      priority: params.priority,
      scheduledFor: params.scheduledFor ?? new Date(),
      triggerEventId: params.triggerEventId,
    });
  }

  // ============================================================
  // ADD STANDINGS / CATALOGUE / LEAGUE DETAIL JOBS
  // ============================================================

  async addStandingsRefreshJob(params: {
    leagueId: string;
    season: number;
    priority: number;
    scheduledFor?: Date;
    triggerEventId?: string;
  }): Promise<EspnQueueDocument> {
    return this.addJob({
      jobType: EspnQueueJobType.STANDINGS_REFRESH,
      leagueId: params.leagueId,
      season: params.season,
      priority: params.priority,
      scheduledFor: params.scheduledFor ?? new Date(),
      triggerEventId: params.triggerEventId,
    });
  }

  /**
   * Read the durable startup standings job for one canonical league-season.
   *
   * Startup jobs use a deterministic triggerEventId, so this lookup does not
   * accidentally read a normal/background standings refresh for the same
   * league and season.
   */
  async getStartupStandingsJobStatus(
    leagueIdValue: string,
    season: number,
  ): Promise<{
    status: EspnQueueStatus;
    attempts: number;
    maxAttempts: number;
    nextAttemptAt?: Date | null;
    lastError?: string | null;
  } | null> {
    const leagueId =
      typeof leagueIdValue === 'string'
        ? leagueIdValue.trim().toLowerCase()
        : '';

    if (!leagueId || !Number.isInteger(season)) {
      throw new Error(
        'Startup standings status lookup requires a league ID and integer season',
      );
    }

    const job = await this.queueModel
      .findOne({
        type: EspnQueueJobType.STANDINGS_REFRESH,
        leagueId,
        season,
        triggerEventId: `STARTUP_STANDINGS:${season}`,
      })
      .select({
        _id: 0,
        status: 1,
        attempts: 1,
        maxAttempts: 1,
        nextAttemptAt: 1,
        lastError: 1,
      })
      .lean()
      .exec();

    if (!job) return null;

    return {
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      nextAttemptAt: job.nextAttemptAt ?? null,
      lastError: job.lastError ?? null,
    };
  }

  /**
   * Returns the next outstanding Summary job for one fixture. Startup uses
   * this to wait for persisted provider work rather than treating queue
   * insertion as Summary completion.
   */
  async getSummaryRefreshWorkStatus(params: {
    leagueId: string;
    eventId: string;
    season: number;
  }): Promise<{
    status: EspnQueueStatus;
    attempts: number;
    maxAttempts: number;
    nextRunAt?: Date;
    lastError?: string | null;
  } | null> {
    const leagueId = String(params.leagueId ?? '')
      .trim()
      .toLowerCase();
    const eventId = String(params.eventId ?? '').trim();

    if (!leagueId || !eventId || !Number.isInteger(params.season)) {
      throw new Error(
        'Summary work status lookup requires leagueId, eventId, and integer season',
      );
    }

    const scope = {
      type: EspnQueueJobType.SUMMARY_REFRESH,
      leagueId,
      eventId,
      season: params.season,
    };

    const active = await this.queueModel
      .aggregate<{
        status: EspnQueueStatus;
        attempts: number;
        maxAttempts: number;
        nextRunAt?: Date;
        lastError?: string | null;
      }>([
        {
          $match: {
            ...scope,
            $or: [
              { status: EspnQueueStatus.PENDING },
              { status: EspnQueueStatus.PROCESSING },
              {
                status: EspnQueueStatus.FAILED,
                nextAttemptAt: { $type: 'date' },
              },
            ],
          },
        },
        {
          $addFields: {
            nextRunAt: {
              $ifNull: ['$nextAttemptAt', '$scheduledFor'],
            },
          },
        },
        { $sort: { nextRunAt: 1, createdAt: 1 } },
        { $limit: 1 },
        {
          $project: {
            _id: 0,
            status: 1,
            attempts: 1,
            maxAttempts: 1,
            nextRunAt: 1,
            lastError: 1,
          },
        },
      ])
      .exec();

    if (active[0]) {
      return active[0];
    }

    const terminal = await this.queueModel
      .findOne({
        ...scope,
        status: EspnQueueStatus.FAILED,
        nextAttemptAt: { $exists: false },
        $expr: { $gte: ['$attempts', '$maxAttempts'] },
      })
      .sort({ failedAt: -1, updatedAt: -1 })
      .select({
        _id: 0,
        status: 1,
        attempts: 1,
        maxAttempts: 1,
        lastError: 1,
      })
      .lean()
      .exec();

    if (!terminal) {
      return null;
    }

    return {
      status: terminal.status,
      attempts: terminal.attempts,
      maxAttempts: terminal.maxAttempts,
      lastError: terminal.lastError ?? null,
    };
  }

  async addLeagueCatalogueRefreshJob(params: {
    priority: number;
    scheduledFor?: Date;
    triggerEventId?: string;
  }): Promise<EspnQueueDocument> {
    return this.addJob({
      jobType: EspnQueueJobType.LEAGUE_CATALOGUE_REFRESH,
      leagueId: '__system__',
      priority: params.priority,
      scheduledFor: params.scheduledFor ?? new Date(),
      triggerEventId: params.triggerEventId,
    });
  }

  async addLeagueDetailRefreshJob(params: {
    leagueId: string;
    season?: number;
    priority: number;
    scheduledFor?: Date;
    triggerEventId?: string;
  }): Promise<EspnQueueDocument> {
    return this.addJob({
      jobType: EspnQueueJobType.LEAGUE_DETAIL_REFRESH,
      leagueId: params.leagueId,
      season: params.season,
      priority: params.priority,
      scheduledFor: params.scheduledFor ?? new Date(),
      triggerEventId: params.triggerEventId,
    });
  }

  async addSeasonFixtureBootstrapJob(params: {
    leagueId: string;
    season: number;
    priority: number;
    scheduledFor?: Date;
    triggerEventId?: string;
  }): Promise<EspnQueueDocument> {
    return this.addJob({
      jobType: EspnQueueJobType.SEASON_FIXTURE_BOOTSTRAP,
      leagueId: params.leagueId,
      season: params.season,
      priority: params.priority,
      scheduledFor: params.scheduledFor ?? new Date(),
      triggerEventId: params.triggerEventId ?? 'SEASON_BOOTSTRAP',
    });
  }

  async hasActiveSeasonBootstrap(
    leagueId: string,
    season: number,
  ): Promise<boolean> {
    return Boolean(
      await this.queueModel
        .findOne({
          type: EspnQueueJobType.SEASON_FIXTURE_BOOTSTRAP,
          leagueId: leagueId.trim().toLowerCase(),
          season,
          status: {
            $in: [EspnQueueStatus.PENDING, EspnQueueStatus.PROCESSING],
          },
        })
        .select({ _id: 1 })
        .lean()
        .exec(),
    );
  }

  // ============================================================
  // GENERIC ADD
  // ============================================================

  async addJob(params: {
    jobType: EspnQueueJobType;
    leagueId: string;
    eventId?: string;
    season?: number;
    priority: number;
    scheduledFor: Date;
    triggerEventId?: string;
  }): Promise<EspnQueueDocument> {
    const rawLeagueId = params.leagueId;
    if (typeof rawLeagueId !== 'string' || !rawLeagueId.trim()) {
      throw new Error('ESPN queue leagueId must be a non-empty string');
    }
    const leagueId = rawLeagueId.trim().toLowerCase();
    if (
      !(params.scheduledFor instanceof Date) ||
      Number.isNaN(params.scheduledFor.getTime())
    ) {
      throw new Error(
        `ESPN queue job ${params.jobType} requires a valid scheduledFor date`,
      );
    }
    if (!Number.isFinite(params.priority) || params.priority < 1) {
      throw new Error(
        `ESPN queue job ${params.jobType} requires a positive numeric priority`,
      );
    }

    const isSummary = params.jobType === EspnQueueJobType.SUMMARY_REFRESH;
    const isEventJob =
      isSummary || params.jobType === EspnQueueJobType.YOUTUBE_HIGHLIGHT;

    if (
      params.jobType === EspnQueueJobType.STANDINGS_REFRESH &&
      typeof params.season !== 'number'
    ) {
      throw new Error('STANDINGS_REFRESH jobs require a numeric season');
    }

    if (isEventJob) {
      if (!params.eventId?.trim()) {
        throw new Error(`${params.jobType} jobs require an eventId`);
      }
      if (typeof params.season !== 'number') {
        throw new Error(`${params.jobType} jobs require a numeric season`);
      }
    }

    const jobKey = this.buildJobKey(
      params.jobType,
      leagueId,
      params.eventId,
      params.season,
      params.triggerEventId,
    );

    const maxSummaryAttempts =
      SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.maxAttempts + 1;
    let existing = await this.queueModel.findOne({ jobKey }).exec();
    const now = new Date();

    // A YouTube stage is one and only one outbound search request. Never reopen
    // the same stage after success or failure; the next stage has a different
    // durable key and is explicitly enqueued by the worker after a no-result.
    if (existing && params.jobType === EspnQueueJobType.YOUTUBE_HIGHLIGHT) {
      return existing;
    }

    /*
     * A periodic freshness scan must never reset an in-flight Summary unit.
     * Respect scheduled queue retries and briefly cool down terminal failures
     * so a missing provider Summary cannot be re-requested every minute.
     */
    if (existing && isSummary) {
      if (
        existing.status === EspnQueueStatus.PENDING ||
        existing.status === EspnQueueStatus.PROCESSING
      ) {
        return existing;
      }

      if (
        existing.nextAttemptAt &&
        existing.nextAttemptAt.getTime() > now.getTime()
      ) {
        return existing;
      }

      const terminalSummaryFailure =
        existing.status === EspnQueueStatus.COMPLETED &&
        Boolean(existing.failedAt) &&
        Boolean(existing.lastError);

      if (
        terminalSummaryFailure &&
        existing.failedAt &&
        now.getTime() - existing.failedAt.getTime() < 60 * 60 * 1000
      ) {
        return existing;
      }
    }

    // A stale-fixture scan runs every 15 minutes. Because its job key is
    // date-scoped, a successful or terminal attempt for today's STALE job
    // should not be reopened repeatedly during the same day. Tomorrow's
    // trigger has a different job key and can try again if the catalogue is
    // still stale.
    if (
      existing?.status === EspnQueueStatus.COMPLETED &&
      params.jobType === EspnQueueJobType.FIXTURE_REFRESH &&
      params.triggerEventId?.startsWith('STALE:')
    ) {
      return existing;
    }

    /*
     * A SUMMARY_REFRESH represents a deliberate new collection attempt when
     * the freshness builder decides the stored payload is stale. Prepare its
     * event unit as pending before checking aggregate state completion. Failed
     * units retain their retry counters; successful units are reopened by the
     * sync-state service for the new collection cycle.
     */
    if (isSummary) {
      await this.sportsSyncStateService.ensureSummaryEventState({
        leagueId,
        season: params.season as number,
        eventId: params.eventId as string,
        priority: params.priority,
        hasSummary: false,
        trackingMode: 'WINDOW',
      });
    }

    const usesSyncState =
      params.jobType === EspnQueueJobType.FIXTURE_REFRESH ||
      params.jobType === EspnQueueJobType.SUMMARY_REFRESH;
    let stateComplete = false;

    if (usesSyncState) {
      const trackingMode: 'WINDOW' | 'HISTORY' =
        params.jobType === EspnQueueJobType.FIXTURE_REFRESH
          ? 'HISTORY'
          : 'WINDOW';
      const state = await this.sportsSyncStateService.ensureQueueState({
        jobType: params.jobType,
        leagueId,
        season: params.season,
        eventId: params.eventId,
        priority: params.priority,
        trackingMode,
        queueJobKey: jobKey,
        triggerEventId: params.triggerEventId,
      });
      stateComplete = this.isTrackedStateComplete(state);
    }

    if (existing) {
      if (isSummary && existing.maxAttempts < maxSummaryAttempts) {
        existing.maxAttempts = maxSummaryAttempts;
        await existing.save();
      }

      if (
        stateComplete &&
        !isSummary &&
        existing.status !== EspnQueueStatus.COMPLETED
      ) {
        existing.status = EspnQueueStatus.COMPLETED;
        existing.completedAt = existing.completedAt ?? new Date();
        existing.startedAt = undefined;
        existing.failedAt = undefined;
        existing.nextAttemptAt = undefined;
        existing.lastError = undefined;
        const saved = await existing.save();
        this.notifyWorker();
        return saved;
      }

      if (existing.status === EspnQueueStatus.COMPLETED) {
        return this.reopenJob(existing, params);
      }

      if (
        existing.status === EspnQueueStatus.PENDING ||
        existing.status === EspnQueueStatus.PROCESSING
      ) {
        return existing;
      }

      if (existing.status === EspnQueueStatus.FAILED) {
        // Failed work is owned by the independent recovery lane. A queue
        // builder must not reset its backoff or move it into normal traffic.
        return existing;
      }

      return this.reopenJob(existing, params);
    }

    try {
      const created = await this.queueModel.create({
        jobKey,
        type: params.jobType,
        leagueId,
        eventId: params.eventId,
        season: params.season,
        triggerEventId: params.triggerEventId,
        priority: params.priority,
        status: EspnQueueStatus.PENDING,
        lane: EspnQueueLane.NORMAL,
        retryCount: 0,
        attempts: 0,
        maxAttempts:
          params.jobType === EspnQueueJobType.YOUTUBE_HIGHLIGHT
            ? 1
            : isSummary
              ? maxSummaryAttempts
              : SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.maxAttempts,
        scheduledFor: params.scheduledFor,
      });
      this.notifyWorker();
      return created;
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) {
        throw error;
      }

      existing = await this.queueModel.findOne({ jobKey }).exec();
      if (!existing) {
        throw error;
      }
      if (params.jobType === EspnQueueJobType.YOUTUBE_HIGHLIGHT) {
        return existing;
      }

      if (
        existing.status === EspnQueueStatus.PENDING ||
        existing.status === EspnQueueStatus.PROCESSING
      ) {
        return existing;
      }

      if (existing.status === EspnQueueStatus.COMPLETED) {
        if (
          params.jobType === EspnQueueJobType.FIXTURE_REFRESH &&
          params.triggerEventId?.startsWith('STALE:')
        ) {
          return existing;
        }
        return this.reopenJob(existing, params);
      }

      if (existing.status === EspnQueueStatus.FAILED) {
        // The durable retry lane owns every failed job, including legacy jobs.
        // Duplicate-key races must never reset its backoff or move it to NORMAL.
        return existing;
      }

      return this.reopenJob(existing, params);
    }
  }

  /**
   * Checks whether an existing YouTube job should suppress a new insertion.
   * Active work, due retries, and successful jobs always win. An exhausted
   * failure becomes eligible for a controlled retry only after its cooldown.
   */
  async shouldSkipDuplicateAttempt(params: {
    jobType: EspnQueueJobType;
    leagueId: string;
    eventId?: string;
    season?: number;
    triggerEventId?: string;
    terminalFailureCooldownMs?: number;
  }): Promise<boolean> {
    if (params.jobType === EspnQueueJobType.YOUTUBE_HIGHLIGHT) {
      const scope: Record<string, unknown> = {
        type: EspnQueueJobType.YOUTUBE_HIGHLIGHT,
        leagueId: String(params.leagueId ?? '')
          .trim()
          .toLowerCase(),
        eventId: String(params.eventId ?? '').trim(),
      };
      if (typeof params.season === 'number') scope.season = params.season;
      // Any stage proves this fixture's search sequence has already started.
      // This blocks duplicate chains from repeated ESPN fixture collections.
      return Boolean(
        await this.queueModel.findOne(scope).select({ _id: 1 }).lean().exec(),
      );
    }

    const jobKey = this.buildJobKey(
      params.jobType,
      params.leagueId,
      params.eventId,
      params.season,
      params.triggerEventId,
    );
    const existing = await this.queueModel
      .findOne({ jobKey })
      .select({
        status: 1,
        attempts: 1,
        maxAttempts: 1,
        failedAt: 1,
        nextAttemptAt: 1,
        triggerEventId: 1,
      })
      .lean()
      .exec();
    if (!existing) return false;

    if (
      [
        EspnQueueStatus.PENDING,
        EspnQueueStatus.PROCESSING,
        EspnQueueStatus.COMPLETED,
      ].includes(existing.status)
    ) {
      return true;
    }
    if (existing.status !== EspnQueueStatus.FAILED) return true;

    const now = Date.now();
    const nextAttemptAt =
      existing.nextAttemptAt instanceof Date
        ? existing.nextAttemptAt.getTime()
        : undefined;
    if (typeof nextAttemptAt === 'number' && nextAttemptAt > now) return true;
    if (Number(existing.attempts ?? 0) < Number(existing.maxAttempts ?? 0))
      return true;

    const failedAt =
      existing.failedAt instanceof Date
        ? existing.failedAt.getTime()
        : undefined;
    const cooldownMs = Math.max(
      0,
      params.terminalFailureCooldownMs ?? 60 * 60_000,
    );
    return typeof failedAt !== 'number' || now - failedAt < cooldownMs;
  }

  /**
   * Checks for queued, processing, retryable, or recently terminal work in a
   * workflow scope. Startup and catalogue seeding use this to avoid creating a
   * second recurring chain when a durable successor already exists.
   */
  async hasScheduledJobForScope(params: {
    jobType: EspnQueueJobType;
    leagueId: string;
    season?: number;
    maximumAgeDays?: number;
  }): Promise<boolean> {
    const leagueId = String(params.leagueId ?? '')
      .trim()
      .toLowerCase();
    if (!leagueId) return false;
    const scope: Record<string, unknown> = {
      type: params.jobType,
      leagueId,
    };
    if (typeof params.season === 'number') scope.season = params.season;
    const oldest = new Date(
      Date.now() - Math.max(1, params.maximumAgeDays ?? 7) * 24 * 60 * 60_000,
    );
    const existing = await this.queueModel
      .findOne({
        ...scope,
        $or: [
          {
            status: {
              $in: [EspnQueueStatus.PENDING, EspnQueueStatus.PROCESSING],
            },
          },
          { status: EspnQueueStatus.FAILED, nextAttemptAt: { $type: 'date' } },
          {
            status: EspnQueueStatus.FAILED,
            failedAt: { $gte: oldest },
            lastError: { $not: /TERMINAL_RECOVERY_REVIEWED:/ },
          },
        ],
      })
      .select({ _id: 1 })
      .lean()
      .exec();
    return Boolean(existing);
  }

  /**
   * Stop retryable YouTube jobs created by the previous implementation. The
   * former implementation retried an entire multi-channel search from the
   * same job, which is incompatible with the new per-request persisted stages.
   * This runs once before the worker begins draining the queue.
   */
  async suppressLegacyYoutubeRetries(): Promise<number> {
    const result = await this.queueModel
      .updateMany(
        {
          type: EspnQueueJobType.YOUTUBE_HIGHLIGHT,
          status: EspnQueueStatus.FAILED,
          nextAttemptAt: { $type: 'date' },
        },
        {
          $set: {
            failedAt: new Date(),
            lastError:
              'Legacy automatic YouTube retry suppressed to enforce one request per persisted search stage',
          },
          $unset: { nextAttemptAt: 1, startedAt: 1 },
        },
      )
      .exec();
    const suppressed = result.modifiedCount ?? 0;
    if (suppressed > 0) this.notifyWorker();
    return suppressed;
  }

  /** A fixture only needs one outstanding post-match lifecycle check. */
  async hasScheduledPostMatchCheck(params: {
    leagueId: string;
    season: number;
    eventId: string;
    maximumAgeDays?: number;
  }): Promise<boolean> {
    const leagueId = String(params.leagueId ?? '')
      .trim()
      .toLowerCase();
    const eventId = String(params.eventId ?? '').trim();
    if (!leagueId || !eventId || !Number.isInteger(params.season)) return false;
    const escapedEventId = eventId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const triggerPattern = new RegExp(
      `^(?:POSTMATCH(?:_RECHECK)?|FINISHED):${escapedEventId}(?::|$)`,
    );
    const oldest = new Date(
      Date.now() - Math.max(1, params.maximumAgeDays ?? 7) * 24 * 60 * 60_000,
    );
    const existing = await this.queueModel
      .findOne({
        type: EspnQueueJobType.FIXTURE_REFRESH,
        leagueId,
        season: params.season,
        triggerEventId: triggerPattern,
        $or: [
          {
            status: {
              $in: [EspnQueueStatus.PENDING, EspnQueueStatus.PROCESSING],
            },
          },
          { status: EspnQueueStatus.FAILED, nextAttemptAt: { $type: 'date' } },
          {
            status: EspnQueueStatus.FAILED,
            failedAt: { $gte: oldest },
            lastError: { $not: /TERMINAL_RECOVERY_REVIEWED:/ },
          },
        ],
      })
      .select({ _id: 1 })
      .lean()
      .exec();
    return Boolean(existing);
  }

  /**
   * Prevent daily integrity recovery from creating another Summary job while
   * this fixture already has active or recently failed Summary work. The
   * existing event/status indexes keep this lookup bounded; terminal failures
   * become eligible again after a short cooldown so daily recovery can heal them.
   */
  async hasActiveSummaryRefreshForEvent(params: {
    leagueId: string;
    eventId: string;
    season: number;
    recentFailureCooldownMs?: number;
  }): Promise<boolean> {
    const leagueId = String(params.leagueId ?? '')
      .trim()
      .toLowerCase();
    const eventId = String(params.eventId ?? '').trim();
    if (!leagueId || !eventId || !Number.isInteger(params.season)) return false;

    const now = new Date();
    const recentFailureCutoff = new Date(
      now.getTime() -
        Math.max(0, params.recentFailureCooldownMs ?? 60 * 60_000),
    );
    const active = await this.queueModel
      .findOne({
        type: EspnQueueJobType.SUMMARY_REFRESH,
        leagueId,
        eventId,
        season: params.season,
        $or: [
          {
            status: {
              $in: [EspnQueueStatus.PENDING, EspnQueueStatus.PROCESSING],
            },
          },
          { status: EspnQueueStatus.FAILED, nextAttemptAt: { $gt: now } },
          {
            status: EspnQueueStatus.FAILED,
            failedAt: { $gte: recentFailureCutoff },
          },
        ],
      })
      .select({ _id: 1 })
      .lean()
      .exec();

    return Boolean(active);
  }

  /** Returns true when a logical job already exists in any state. Useful for one-shot event jobs. */
  async hasJob(params: {
    jobType: EspnQueueJobType;
    leagueId: string;
    eventId?: string;
    season?: number;
    triggerEventId?: string;
  }): Promise<boolean> {
    const jobKey = this.buildJobKey(
      params.jobType,
      params.leagueId,
      params.eventId,
      params.season,
      params.triggerEventId,
    );
    const existing = await this.queueModel
      .findOne({ jobKey })
      .select({ _id: 1 })
      .lean()
      .exec();
    return Boolean(existing);
  }

  /** Returns whether the specific logical job is pending or processing. */
  async isJobActive(params: {
    jobType: EspnQueueJobType;
    leagueId: string;
    eventId?: string;
    season?: number;
    triggerEventId?: string;
  }): Promise<boolean> {
    const jobKey = this.buildJobKey(
      params.jobType,
      params.leagueId,
      params.eventId,
      params.season,
      params.triggerEventId,
    );

    const active = await this.queueModel
      .findOne({
        jobKey,
        status: {
          $in: [EspnQueueStatus.PENDING, EspnQueueStatus.PROCESSING],
        },
      })
      .select({ _id: 1 })
      .lean()
      .exec();

    return Boolean(active);
  }

  /** The next durable due time; undefined means the worker can sleep until nudged. */
  async getNextWakeAt(): Promise<Date | null> {
    const results = await this.queueModel
      .aggregate<{ wakeAt?: Date }>([
        {
          $match: {
            $or: [
              { status: EspnQueueStatus.PENDING },
              {
                status: EspnQueueStatus.FAILED,
                nextAttemptAt: { $type: 'date' },
              },
            ],
          },
        },
        {
          $addFields: {
            wakeAt: { $ifNull: ['$nextAttemptAt', '$scheduledFor'] },
          },
        },
        { $match: { wakeAt: { $type: 'date' } } },
        { $sort: { wakeAt: 1 } },
        { $limit: 1 },
        { $project: { _id: 0, wakeAt: 1 } },
      ])
      .exec();
    const result = results[0];
    return result?.wakeAt instanceof Date ? result.wakeAt : null;
  }

  /**
   * Returns the next scheduled retry for one startup workload. This lets a
   * startup worker sleep until its own work is due instead of polling the
   * entire queue or being woken by unrelated normal jobs.
   */
  async getNextWakeAtForWorkload(params: {
    jobType: EspnQueueJobType;
    triggerEventIdPrefix: string;
  }): Promise<Date | null> {
    const prefix = params.triggerEventIdPrefix.trim();
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const job = await this.queueModel
      .findOne({
        type: params.jobType,
        triggerEventId: { $regex: `^${escapedPrefix}` },
        $or: [
          {
            status: EspnQueueStatus.PENDING,
            $or: [{ lane: EspnQueueLane.NORMAL }, { lane: { $exists: false } }],
          },
          {
            status: EspnQueueStatus.FAILED,
            lane: EspnQueueLane.BACKGROUND_RETRY,
            nextAttemptAt: { $type: 'date' },
          },
        ],
      })
      .select({ status: 1, nextAttemptAt: 1, scheduledFor: 1 })
      .sort({ nextAttemptAt: 1, scheduledFor: 1 })
      .lean()
      .exec();

    if (!job) return null;
    const wakeAt =
      job.status === EspnQueueStatus.FAILED
        ? job.nextAttemptAt
        : job.scheduledFor;
    return wakeAt instanceof Date ? wakeAt : null;
  }

  async countQuarantinedWorkloadJobs(params: {
    jobType: EspnQueueJobType;
    triggerEventIdPrefix: string;
  }): Promise<number> {
    const escapedPrefix = params.triggerEventIdPrefix
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.queueModel.countDocuments({
      type: params.jobType,
      triggerEventId: { $regex: `^${escapedPrefix}` },
      status: EspnQueueStatus.FAILED,
      lane: EspnQueueLane.QUARANTINE,
    });
  }

  // ============================================================
  // GET NEXT JOB
  // ============================================================

  async getNextJob(params?: {
    jobTypes?: EspnQueueJobType[];
    includeFailed?: boolean;
    triggerEventIdPrefix?: string;
    leagueId?: string;
    season?: number;
    eventId?: string;
    lane?: EspnQueueLane;
    workerId?: string;
    leaseMs?: number;
  }): Promise<EspnQueueDocument | null> {
    const now = new Date();
    const lane = params?.lane;
    const eligible: Record<string, unknown>[] = [];

    if (!lane || lane === EspnQueueLane.NORMAL) {
      eligible.push({
        status: EspnQueueStatus.PENDING,
        $or: [{ lane: EspnQueueLane.NORMAL }, { lane: { $exists: false } }],
        $and: [
          {
            $or: [
              { nextAttemptAt: { $in: [null] }, scheduledFor: { $lte: now } },
              { nextAttemptAt: { $lte: now } },
            ],
          },
        ],
      });
    }

    if (
      lane === EspnQueueLane.BACKGROUND_RETRY ||
      (!lane && params?.includeFailed === true)
    ) {
      eligible.push({
        status: EspnQueueStatus.FAILED,
        lane: EspnQueueLane.BACKGROUND_RETRY,
        nextAttemptAt: { $lte: now },
      });
    }

    if (lane === EspnQueueLane.QUARANTINE) return null;
    if (eligible.length === 0) return null;

    const query: Record<string, unknown> = { $or: eligible };
    if (params?.jobTypes?.length) query.type = { $in: params.jobTypes };
    if (params?.leagueId?.trim())
      query.leagueId = params.leagueId.trim().toLowerCase();
    if (typeof params?.season === 'number') query.season = params.season;
    if (params?.eventId?.trim()) query.eventId = params.eventId.trim();
    if (params?.triggerEventIdPrefix?.trim()) {
      const escapedPrefix = params.triggerEventIdPrefix
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.triggerEventId = { $regex: `^${escapedPrefix}` };
    }

    const workerId = params?.workerId?.trim() || `sports-worker-${process.pid}`;
    const leaseMs = Math.max(60_000, params?.leaseMs ?? 8 * 60_000);
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);

    const sort =
      lane === EspnQueueLane.BACKGROUND_RETRY
        ? { priority: 1, nextAttemptAt: 1, firstFailedAt: 1, createdAt: 1 }
        : { priority: 1, scheduledFor: 1, createdAt: 1 };

    return this.queueModel
      .findOneAndUpdate(
        query,
        {
          $set: {
            status: EspnQueueStatus.PROCESSING,
            ownerId: workerId,
            startedAt: now,
            heartbeatAt: now,
            leaseExpiresAt,
            lastAttemptAt: now,
          },
          $inc: { attempts: 1 },
          $unset: { nextAttemptAt: 1, failedAt: 1, completedAt: 1 },
        },
        {
          sort,
          returnDocument: 'after',
        },
      )
      .exec();
  }

  async renewJobLease(
    jobId: string,
    workerId: string,
    leaseMs: number,
  ): Promise<boolean> {
    const now = new Date();
    const result = await this.queueModel
      .updateOne(
        { _id: jobId, status: EspnQueueStatus.PROCESSING, ownerId: workerId },
        {
          $set: {
            heartbeatAt: now,
            leaseExpiresAt: new Date(now.getTime() + Math.max(60_000, leaseMs)),
          },
        },
      )
      .exec();
    return (result.modifiedCount ?? 0) > 0;
  }

  async ownsProcessingJob(jobId: string, workerId: string): Promise<boolean> {
    return Boolean(
      await this.queueModel
        .findOne({
          _id: jobId,
          status: EspnQueueStatus.PROCESSING,
          ownerId: workerId,
        })
        .select({ _id: 1 })
        .lean()
        .exec(),
    );
  }

  /**
   * Releases a claimed job when another job for the same mutable sync-state
   * scope is already running in this worker process. Deferral is not a failure
   * and therefore does not consume the execution retry budget.
   */
  async deferClaimedJob(
    jobId: string,
    workerId: string,
    scheduledFor: Date,
    lane: EspnQueueLane = EspnQueueLane.NORMAL,
  ): Promise<boolean> {
    if (
      !(scheduledFor instanceof Date) ||
      Number.isNaN(scheduledFor.getTime())
    ) {
      throw new Error(
        'Queue claim deferral requires a valid scheduledFor date',
      );
    }
    const backgroundRetry = lane === EspnQueueLane.BACKGROUND_RETRY;
    const result = await this.queueModel
      .updateOne(
        { _id: jobId, status: EspnQueueStatus.PROCESSING, ownerId: workerId },
        {
          $set: backgroundRetry
            ? {
                status: EspnQueueStatus.FAILED,
                lane: EspnQueueLane.BACKGROUND_RETRY,
                nextAttemptAt: scheduledFor,
                failedAt: new Date(),
              }
            : {
                status: EspnQueueStatus.PENDING,
                lane: EspnQueueLane.NORMAL,
                scheduledFor,
              },
          $inc: { attempts: -1 },
          $unset: {
            startedAt: 1,
            heartbeatAt: 1,
            leaseExpiresAt: 1,
            ownerId: 1,
            ...(backgroundRetry ? {} : { nextAttemptAt: 1, failedAt: 1 }),
          },
        },
      )
      .exec();
    const deferred = (result.modifiedCount ?? 0) > 0;
    if (deferred) this.notifyWorker();
    return deferred;
  }

  // ============================================================
  // COMPLETE
  // ============================================================

  async markCompleted(jobId: string, workerId?: string): Promise<boolean> {
    const filter: Record<string, unknown> = {
      _id: jobId,
      status: EspnQueueStatus.PROCESSING,
    };
    if (workerId) filter.ownerId = workerId;
    const result = await this.queueModel
      .updateOne(filter, {
        $set: {
          status: EspnQueueStatus.COMPLETED,
          completedAt: new Date(),
        },
        $unset: {
          nextAttemptAt: 1,
          startedAt: 1,
          heartbeatAt: 1,
          leaseExpiresAt: 1,
          ownerId: 1,
          lastError: 1,
          failureCategory: 1,
        },
      })
      .exec();
    const completed = (result.modifiedCount ?? 0) > 0;
    if (completed) this.notifyWorker();
    return completed;
  }

  /**
   * Return an out-of-window Summary job to PENDING without consuming its retry
   * budget. This enforces the active timing contract for jobs persisted by an
   * older deployment while retaining the same deterministic job identity.
   */
  async deferProcessingSummaryJob(
    jobId: string,
    scheduledFor: Date,
    workerId?: string,
    lane: EspnQueueLane = EspnQueueLane.NORMAL,
  ): Promise<boolean> {
    if (
      !(scheduledFor instanceof Date) ||
      Number.isNaN(scheduledFor.getTime())
    ) {
      throw new Error('Summary deferral requires a valid scheduledFor date');
    }
    const result = await this.queueModel
      .updateOne(
        {
          _id: jobId,
          type: EspnQueueJobType.SUMMARY_REFRESH,
          status: EspnQueueStatus.PROCESSING,
          ...(workerId ? { ownerId: workerId } : {}),
        },
        {
          $set:
            lane === EspnQueueLane.BACKGROUND_RETRY
              ? {
                  status: EspnQueueStatus.FAILED,
                  lane: EspnQueueLane.BACKGROUND_RETRY,
                  nextAttemptAt: scheduledFor,
                  failedAt: new Date(),
                }
              : {
                  status: EspnQueueStatus.PENDING,
                  lane: EspnQueueLane.NORMAL,
                  scheduledFor,
                },
          // A timing deferral is not a failed provider attempt.
          $inc: { attempts: -1 },
          $unset: {
            startedAt: 1,
            heartbeatAt: 1,
            leaseExpiresAt: 1,
            ownerId: 1,
            completedAt: 1,
            lastError: 1,
            ...(lane === EspnQueueLane.BACKGROUND_RETRY
              ? {}
              : { nextAttemptAt: 1, failedAt: 1 }),
          },
        },
      )
      .exec();
    const deferred = (result.modifiedCount ?? 0) > 0;
    if (deferred) this.notifyWorker();
    return deferred;
  }

  // ============================================================
  // FAIL
  // ============================================================

  async markFailed(
    job: EspnQueueDocument,
    error: unknown,
  ): Promise<{
    lane: EspnQueueLane;
    category: EspnQueueFailureCategory;
    retryCount: number;
    nextAttemptAt?: Date;
    quarantined: boolean;
  }> {
    const message = error instanceof Error ? error.message : String(error);
    const category = this.classifyFailure(job, error, message);
    const now = new Date();
    const workerId = typeof job.ownerId === 'string' ? job.ownerId : undefined;
    const filter: Record<string, unknown> = {
      _id: job._id,
      status: EspnQueueStatus.PROCESSING,
    };
    if (workerId) filter.ownerId = workerId;

    // A YouTube stage represents one outbound search and must not be replayed:
    // the provider may have received the request even if our process lost its response.
    const quarantine =
      category === EspnQueueFailureCategory.PERMANENT ||
      category === EspnQueueFailureCategory.NON_REPLAYABLE;

    if (quarantine) {
      const result = await this.queueModel
        .updateOne(filter, {
          $set: {
            status: EspnQueueStatus.FAILED,
            lane: EspnQueueLane.QUARANTINE,
            failureCategory: category,
            lastError: message,
            failedAt: now,
          },
          $min: { firstFailedAt: now },
          $unset: {
            nextAttemptAt: 1,
            startedAt: 1,
            heartbeatAt: 1,
            leaseExpiresAt: 1,
            ownerId: 1,
            completedAt: 1,
          },
        })
        .exec();
      if ((result.modifiedCount ?? 0) > 0) this.notifyWorker();
      return {
        lane: EspnQueueLane.QUARANTINE,
        category,
        retryCount: Number(job.retryCount ?? 0),
        quarantined: true,
      };
    }

    const retryCount = Number(job.retryCount ?? 0) + 1;
    const delays = SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.retryDelaysMinutes;
    const delayMinutes =
      delays[Math.min(retryCount - 1, delays.length - 1)] ?? 1440;
    const jitterPercent =
      SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.retryJitterPercent;
    const jitterFactor = 1 + ((Math.random() * 2 - 1) * jitterPercent) / 100;
    const retryDelayMs = Math.max(
      30_000,
      Math.round(delayMinutes * 60_000 * jitterFactor),
    );
    const nextAttemptAt = new Date(now.getTime() + retryDelayMs);

    const result = await this.queueModel
      .updateOne(filter, {
        $set: {
          status: EspnQueueStatus.FAILED,
          lane: EspnQueueLane.BACKGROUND_RETRY,
          failureCategory: category,
          lastError: message,
          failedAt: now,
          nextAttemptAt,
        },
        $min: { firstFailedAt: now },
        $inc: { retryCount: 1 },
        $unset: {
          startedAt: 1,
          heartbeatAt: 1,
          leaseExpiresAt: 1,
          ownerId: 1,
          completedAt: 1,
        },
      })
      .exec();

    // If ownership was lost, never overwrite a newer worker's claim or result.
    if ((result.modifiedCount ?? 0) > 0) this.notifyWorker();
    return {
      lane: EspnQueueLane.BACKGROUND_RETRY,
      category,
      retryCount,
      nextAttemptAt,
      quarantined: false,
    };
  }

  private classifyFailure(
    job: EspnQueueDocument,
    error: unknown,
    message: string,
  ): EspnQueueFailureCategory {
    if (job.type === EspnQueueJobType.YOUTUBE_HIGHLIGHT) {
      return EspnQueueFailureCategory.NON_REPLAYABLE;
    }

    const normalized = message.toLowerCase();
    if (
      /invalid (league|queue|job|date|month|endpoint)|unsupported queue job|season mismatch|requires (a|an)|must be a valid|no activecompetition found|malformed job parameters/.test(
        normalized,
      )
    ) {
      return EspnQueueFailureCategory.PERMANENT;
    }
    if (
      /summary.{0,30}(not found|unavailable|not ready|empty)|not yet published|no populated standings|standings are unavailable|empty standings payload|final result.{0,30}(missing|unavailable)|omitted the events array/.test(
        normalized,
      )
    ) {
      return EspnQueueFailureCategory.DATA_NOT_READY;
    }

    const status =
      error &&
      typeof error === 'object' &&
      typeof (error as { getStatus?: unknown }).getStatus === 'function'
        ? Number((error as { getStatus: () => number }).getStatus())
        : undefined;
    if (status === 400 || status === 401 || status === 403) {
      return EspnQueueFailureCategory.PERMANENT;
    }
    return EspnQueueFailureCategory.TRANSIENT;
  }

  /**
   * Requeue only standings jobs stranded by the previously observed
   * unbound-normalize runtime error. Successfully queued jobs no longer match
   * this status-scoped query on the next restart.
   */
  async recoverKnownStandingsNormalizeFailures(): Promise<number> {
    const result = await this.queueModel
      .updateMany(
        {
          type: EspnQueueJobType.STANDINGS_REFRESH,
          status: EspnQueueStatus.FAILED,
          lastError:
            "Cannot read properties of undefined (reading 'normalize')",
        },
        {
          $set: {
            status: EspnQueueStatus.FAILED,
            lane: EspnQueueLane.BACKGROUND_RETRY,
            failureCategory: EspnQueueFailureCategory.TRANSIENT,
            nextAttemptAt: new Date(),
            lastError: 'Recovered known legacy standings normalization failure',
          },
          $unset: {
            startedAt: 1,
            heartbeatAt: 1,
            leaseExpiresAt: 1,
            ownerId: 1,
            completedAt: 1,
            failedAt: 1,
          },
        },
      )
      .exec();

    const recovered = result.modifiedCount ?? 0;
    if (recovered > 0) this.notifyWorker();
    return recovered;
  }

  /**
   * Adopts legacy FAILED jobs into the durable background-retry lane. This
   * intentionally includes exhausted legacy jobs: the new retry policy is
   * independent of the old finite maxAttempts counter.
   */
  async recoverOrphanedFailedJobs(
    maximumAgeDays = 36500,
    limit = 100,
  ): Promise<number> {
    const now = new Date();
    const oldest = new Date(
      now.getTime() - Math.max(1, maximumAgeDays) * 24 * 60 * 60_000,
    );
    const filter = {
      status: EspnQueueStatus.FAILED,
      $or: [{ failedAt: { $gte: oldest } }, { failedAt: { $exists: false } }],
      lane: {
        $nin: [EspnQueueLane.BACKGROUND_RETRY, EspnQueueLane.QUARANTINE],
      },
    };
    const candidates = await this.queueModel
      .find(filter)
      .select({
        _id: 1,
        type: 1,
        lastError: 1,
        failureCategory: 1,
        firstFailedAt: 1,
        failedAt: 1,
        createdAt: 1,
      })
      .sort({ failedAt: 1, createdAt: 1 })
      .limit(Math.max(1, Math.min(500, limit)))
      .lean()
      .exec();
    if (candidates.length === 0) return 0;

    let adopted = 0;
    for (const candidate of candidates) {
      const message = String(
        candidate.lastError ?? 'Recovered legacy failed job',
      );
      const category =
        candidate.type === EspnQueueJobType.YOUTUBE_HIGHLIGHT
          ? EspnQueueFailureCategory.NON_REPLAYABLE
          : candidate.failureCategory === EspnQueueFailureCategory.PERMANENT ||
              candidate.failureCategory ===
                EspnQueueFailureCategory.NON_REPLAYABLE
            ? candidate.failureCategory
            : this.classifyFailure(candidate, new Error(message), message);
      const quarantined =
        category === EspnQueueFailureCategory.PERMANENT ||
        category === EspnQueueFailureCategory.NON_REPLAYABLE;
      const result = await this.queueModel
        .updateOne(
          {
            _id: candidate._id,
            status: EspnQueueStatus.FAILED,
            lane: {
              $nin: [EspnQueueLane.BACKGROUND_RETRY, EspnQueueLane.QUARANTINE],
            },
          },
          {
            $set: {
              lane: quarantined
                ? EspnQueueLane.QUARANTINE
                : EspnQueueLane.BACKGROUND_RETRY,
              failureCategory: category,
              ...(quarantined ? {} : { nextAttemptAt: now }),
              lastError: message,
            },
            $min: {
              firstFailedAt:
                candidate.firstFailedAt ??
                candidate.failedAt ??
                (candidate as typeof candidate & { createdAt?: Date })
                  .createdAt ??
                now,
            },
            $unset: quarantined
              ? {
                  nextAttemptAt: 1,
                  startedAt: 1,
                  heartbeatAt: 1,
                  leaseExpiresAt: 1,
                  ownerId: 1,
                  completedAt: 1,
                }
              : {
                  startedAt: 1,
                  heartbeatAt: 1,
                  leaseExpiresAt: 1,
                  ownerId: 1,
                  completedAt: 1,
                },
          },
        )
        .exec();
      adopted += result.modifiedCount ?? 0;
    }

    if (adopted > 0) this.notifyWorker();
    return adopted;
  }

  // ============================================================
  // RECOVER STALE JOBS
  // ============================================================

  async recoverStaleJobs(staleMinutes = 8): Promise<number> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - staleMinutes * 60_000);
    const staleFilter = {
      status: EspnQueueStatus.PROCESSING,
      $or: [
        { leaseExpiresAt: { $lte: now } },
        { leaseExpiresAt: { $exists: false }, startedAt: { $lte: cutoff } },
      ],
    };
    const staleJobs = await this.queueModel.find(staleFilter).limit(200).exec();
    if (staleJobs.length === 0) return 0;

    let recovered = 0;
    for (const job of staleJobs) {
      const nonReplayable = job.type === EspnQueueJobType.YOUTUBE_HIGHLIGHT;
      const delayAt = nonReplayable ? undefined : now;
      const update = await this.queueModel
        .updateOne(
          {
            _id: job._id,
            status: EspnQueueStatus.PROCESSING,
            ownerId: job.ownerId,
            ...(job.leaseExpiresAt
              ? { leaseExpiresAt: { $lte: now } }
              : {
                  startedAt: { $lte: cutoff },
                  leaseExpiresAt: { $exists: false },
                }),
          },
          {
            $set: nonReplayable
              ? {
                  status: EspnQueueStatus.FAILED,
                  lane: EspnQueueLane.QUARANTINE,
                  failureCategory: EspnQueueFailureCategory.NON_REPLAYABLE,
                  failedAt: now,
                  lastError:
                    'Interrupted one-shot YouTube search was quarantined to preserve the per-fixture request cap',
                }
              : {
                  status: EspnQueueStatus.FAILED,
                  lane: EspnQueueLane.BACKGROUND_RETRY,
                  failureCategory: EspnQueueFailureCategory.TRANSIENT,
                  failedAt: now,
                  nextAttemptAt: delayAt,
                  lastError:
                    'Recovered expired processing lease; job moved to background retry',
                },
            $min: { firstFailedAt: now },
            $unset: {
              startedAt: 1,
              heartbeatAt: 1,
              leaseExpiresAt: 1,
              ownerId: 1,
              completedAt: 1,
            },
            ...(nonReplayable ? {} : { $inc: { retryCount: 1 } }),
          },
        )
        .exec();

      if ((update.modifiedCount ?? 0) === 0) continue;
      recovered += 1;

      if (!nonReplayable) {
        const stateKey = this.sportsSyncStateService.getQueueStateKey({
          jobType: job.type,
          leagueId: job.leagueId,
          season: job.season,
          eventId: job.eventId,
          triggerEventId: job.triggerEventId,
          queueJobKey: job.jobKey,
        });
        try {
          await this.sportsSyncStateService.resetInterruptedUnits(
            stateKey,
            cutoff,
          );
        } catch {
          // The durable queue remains recoverable even if an old ledger is absent.
        }
      }
    }

    if (recovered > 0) this.notifyWorker();
    return recovered;
  }

  // ============================================================
  // COUNTS
  // ============================================================

  async countPending(): Promise<number> {
    return this.queueModel.countDocuments({
      status: EspnQueueStatus.PENDING,
    });
  }

  async countProcessing(): Promise<number> {
    return this.queueModel.countDocuments({
      status: EspnQueueStatus.PROCESSING,
    });
  }

  async countFailed(): Promise<number> {
    return this.queueModel.countDocuments({
      status: EspnQueueStatus.FAILED,
    });
  }

  async countCompleted(): Promise<number> {
    return this.queueModel.countDocuments({
      status: EspnQueueStatus.COMPLETED,
    });
  }

  // ============================================================
  // INTERNAL JOB REOPEN
  // ============================================================

  private async reopenJob(
    job: EspnQueueDocument,
    params: {
      priority: number;
      scheduledFor: Date;
      triggerEventId?: string;
    },
  ): Promise<EspnQueueDocument> {
    job.status = EspnQueueStatus.PENDING;
    job.lane = EspnQueueLane.NORMAL;
    job.retryCount = 0;
    job.failureCategory = undefined;
    job.firstFailedAt = undefined;
    job.lastAttemptAt = undefined;
    job.ownerId = undefined;
    job.heartbeatAt = undefined;
    job.leaseExpiresAt = undefined;

    job.priority = params.priority;

    job.scheduledFor = params.scheduledFor;
    if (params.triggerEventId !== undefined) {
      job.triggerEventId = params.triggerEventId;
    }

    job.attempts = 0;

    job.startedAt = undefined;

    job.completedAt = undefined;

    job.failedAt = undefined;

    job.lastError = undefined;

    job.nextAttemptAt = undefined;

    const saved = await job.save();
    this.notifyWorker();
    return saved;
  }

  private isTrackedStateComplete(state: {
    units: Array<{
      status: SportsSyncUnitStatus;
    }>;
  }): boolean {
    return (
      state.units.length > 0 &&
      state.units.every((unit) => unit.status === SportsSyncUnitStatus.SUCCESS)
    );
  }

  private isDuplicateKeyError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const record = error as Record<string, unknown>;

    return record.code === 11000;
  }

  // ============================================================
  // JOB KEY
  // ============================================================

  private buildJobKey(
    jobType: EspnQueueJobType,
    leagueId: string,
    eventId?: string,
    season?: number,
    triggerEventId?: string,
  ): string {
    const league = leagueId.trim().toLowerCase();

    /*
     * Summary is always event-specific.
     *
     * YouTube highlights are also event-specific because one
     * completed match can only have one logical highlight job.
     */
    if (jobType === EspnQueueJobType.SUMMARY_REFRESH) {
      if (!eventId?.trim()) {
        throw new Error(`${jobType} jobs require an eventId`);
      }
      const rootKey = [jobType, league, eventId.trim()].join(':');
      // Keep ordinary Summary jobs compatible. Post-kickoff refreshes need a
      // separate durable key so an upcoming Summary cannot suppress them.
      return triggerEventId?.trim()
        ? `${rootKey}:${triggerEventId.trim()}`
        : rootKey;
    }

    if (jobType === EspnQueueJobType.YOUTUBE_HIGHLIGHT) {
      if (!eventId?.trim()) {
        throw new Error(`${jobType} jobs require an eventId`);
      }
      const rootKey = [jobType, league, eventId.trim()].join(':');
      // Keep initial jobs compatible with the existing queue identity. Each
      // retry/fallback stage gets a distinct persistent identity.
      return triggerEventId?.trim()
        ? `${rootKey}:${triggerEventId.trim()}`
        : rootKey;
    }

    /*
     * Fixture-refresh queue documents remain trigger-specific.
     *
     * This allows multiple operational jobs:
     *
     *   FIXTURE_REFRESH:eng.1:2026:DAILY:2026-09-26
     *   FIXTURE_REFRESH:eng.1:2026:STALE:2026-09-26
     *   FIXTURE_REFRESH:eng.1:2026:FINISHED:401884783
     *
     * These are operational queue identities only.
     *
     * Their persistent synchronization state is NOT trigger-specific.
     */
    if (triggerEventId?.trim()) {
      return [jobType, league, season ?? 'current', triggerEventId.trim()].join(
        ':',
      );
    }

    return [jobType, league, season ?? 'current'].join(':');
  }

  /**
   * Removes completed operational queue records after the retention period.
   * This is general queue maintenance and is unrelated to the removed leaderboard feature.
   */
  async cleanupCompletedJobs(olderThanDays = 7): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    const result = await this.queueModel.deleteMany({
      status: EspnQueueStatus.COMPLETED,
      completedAt: {
        $lte: cutoff,
      },
    });

    return result.deletedCount ?? 0;
  }
}
