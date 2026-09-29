import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { EspnQueue, EspnQueueDocument } from '../schemas/espn-queue.schema';

import {
  EspnQueueJobType,
  EspnQueueStatus,
} from '../interfaces/espn-queue.interface';

import { SportsSyncUnitStatus } from '../schemas/sports-sync-state.schema';

import { SportsSyncStateService } from './sports-sync-state.service';

@Injectable()
export class EspnQueueService {
  private startupReady = false;

  private normalOperationsReady = false;

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
    this.normalOperationsReady = true;
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
   * Queue creation must therefore be preceded by a check that
   * the fixture does not already contain a Summary.
   */
  async addSummaryRefreshJob(params: {
    leagueId: string;
    eventId: string;
    season: number;
    priority: number;
    scheduledFor?: Date;
  }): Promise<EspnQueueDocument> {
    return this.addJob({
      jobType: EspnQueueJobType.SUMMARY_REFRESH,

      leagueId: params.leagueId,

      eventId: params.eventId,

      season: params.season,

      priority: params.priority,

      scheduledFor: params.scheduledFor ?? new Date(),
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
  }): Promise<EspnQueueDocument> {
    return this.addJob({
      jobType: EspnQueueJobType.YOUTUBE_HIGHLIGHT,

      leagueId: params.leagueId,

      eventId: params.eventId,

      season: params.season,

      priority: params.priority,

      scheduledFor: params.scheduledFor ?? new Date(),
    });
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
    const leagueId = params.leagueId.trim().toLowerCase();

    if (!leagueId) {
      throw new Error('ESPN queue leagueId cannot be empty');
    }

    if (
      params.jobType === EspnQueueJobType.SUMMARY_REFRESH ||
      params.jobType === EspnQueueJobType.YOUTUBE_HIGHLIGHT
    ) {
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

    /*
     * FIXTURE_REFRESH synchronization state is persistent HISTORY.
     *
     * The date window belongs to the synchronization state and is
     * extended by SportsSyncStateService as new future dates become
     * required.
     *
     * Summary/YouTube states remain WINDOW based.
     */
    const trackingMode: 'WINDOW' | 'HISTORY' =
      params.jobType === EspnQueueJobType.FIXTURE_REFRESH
        ? 'HISTORY'
        : 'WINDOW';

    /*
     * The synchronization state is authoritative.
     *
     * For FIXTURE_REFRESH, getQueueStateKey() deliberately ignores
     * triggerEventId/queueJobKey when constructing the state key.
     *
     * Therefore:
     *
     * DAILY
     * STALE
     * FINISHED
     *
     * all resolve to one league/season synchronization state.
     */
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

    const stateComplete = this.isTrackedStateComplete(state);

    let existing = await this.queueModel
      .findOne({
        jobKey,
      })
      .exec();

    // ==========================================================
    // EXISTING QUEUE DOCUMENT
    // ==========================================================

    if (existing) {
      if (stateComplete) {
        if (existing.status !== EspnQueueStatus.COMPLETED) {
          existing.status = EspnQueueStatus.COMPLETED;

          existing.completedAt = existing.completedAt ?? new Date();

          existing.startedAt = undefined;

          existing.failedAt = undefined;

          existing.nextAttemptAt = undefined;

          existing.lastError = undefined;

          existing = await existing.save();
        }

        return existing;
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

      return this.reopenJob(existing, params);
    }

    // ==========================================================
    // CREATE NEW QUEUE DOCUMENT
    // ==========================================================

    try {
      return await this.queueModel.create({
        jobKey,

        type: params.jobType,

        leagueId,

        eventId: params.eventId,

        season: params.season,

        triggerEventId: params.triggerEventId,

        priority: params.priority,

        status: EspnQueueStatus.PENDING,

        attempts: 0,

        maxAttempts: 3,

        scheduledFor: params.scheduledFor,
      });
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) {
        throw error;
      }

      existing = await this.queueModel
        .findOne({
          jobKey,
        })
        .exec();

      if (!existing) {
        throw error;
      }

      if (stateComplete) {
        if (existing.status !== EspnQueueStatus.COMPLETED) {
          existing.status = EspnQueueStatus.COMPLETED;

          existing.completedAt = existing.completedAt ?? new Date();

          existing.startedAt = undefined;

          existing.failedAt = undefined;

          existing.nextAttemptAt = undefined;

          existing.lastError = undefined;

          return existing.save();
        }

        return existing;
      }

      if (
        existing.status === EspnQueueStatus.PENDING ||
        existing.status === EspnQueueStatus.PROCESSING
      ) {
        return existing;
      }

      return this.reopenJob(existing, params);
    }
  }

  // ============================================================
  // GET NEXT JOB
  // ============================================================

  async getNextJob(params?: {
    jobTypes?: EspnQueueJobType[];
    includeFailed?: boolean;
  }): Promise<EspnQueueDocument | null> {
    const now = new Date();

    const includeFailed = params?.includeFailed === true;

    const statuses = includeFailed
      ? [EspnQueueStatus.PENDING, EspnQueueStatus.FAILED]
      : [EspnQueueStatus.PENDING];

    const query: Record<string, unknown> = {
      status:
        statuses.length === 1
          ? statuses[0]
          : {
              $in: statuses,
            },

      $or: [
        {
          status: EspnQueueStatus.PENDING,

          nextAttemptAt: {
            $exists: false,
          },

          scheduledFor: {
            $lte: now,
          },
        },

        {
          status: EspnQueueStatus.PENDING,

          nextAttemptAt: {
            $lte: now,
          },
        },

        ...(includeFailed
          ? [
              {
                status: EspnQueueStatus.FAILED,

                nextAttemptAt: {
                  $lte: now,
                },
              },
            ]
          : []),
      ],
    };

    if (params?.jobTypes && params.jobTypes.length > 0) {
      query.type = {
        $in: params.jobTypes,
      };
    }

    return this.queueModel
      .findOneAndUpdate(
        query,
        {
          $set: {
            status: EspnQueueStatus.PROCESSING,

            startedAt: now,
          },

          $inc: {
            attempts: 1,
          },

          $unset: {
            nextAttemptAt: 1,

            failedAt: 1,

            completedAt: 1,
          },
        },
        {
          sort: {
            priority: 1,

            scheduledFor: 1,

            createdAt: 1,
          },

          returnDocument: 'after',
        },
      )
      .exec();
  }

  // ============================================================
  // COMPLETE
  // ============================================================

  async markCompleted(jobId: string): Promise<void> {
    await this.queueModel.updateOne(
      {
        _id: jobId,
      },
      {
        $set: {
          status: EspnQueueStatus.COMPLETED,

          completedAt: new Date(),
        },

        $unset: {
          nextAttemptAt: 1,

          startedAt: 1,

          lastError: 1,
        },
      },
    );
  }

  // ============================================================
  // FAIL
  // ============================================================

  async markFailed(job: EspnQueueDocument, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    if (job.attempts < job.maxAttempts) {
      const retryDelayMs =
        Math.min(15, Math.pow(2, Math.max(job.attempts - 1, 0))) * 60_000;

      await this.queueModel.updateOne(
        {
          _id: job._id,
        },
        {
          $set: {
            status: EspnQueueStatus.FAILED,

            lastError: message,

            failedAt: new Date(),

            nextAttemptAt: new Date(Date.now() + retryDelayMs),
          },

          $unset: {
            startedAt: 1,

            completedAt: 1,
          },
        },
      );

      return;
    }

    await this.queueModel.updateOne(
      {
        _id: job._id,
      },
      {
        $set: {
          status: EspnQueueStatus.FAILED,

          lastError: message,

          failedAt: new Date(),

          completedAt: new Date(),
        },

        $unset: {
          nextAttemptAt: 1,

          startedAt: 1,
        },
      },
    );
  }

  // ============================================================
  // RECOVER STALE JOBS
  // ============================================================

  async recoverStaleJobs(staleMinutes = 15): Promise<number> {
    const cutoff = new Date(Date.now() - staleMinutes * 60_000);

    const staleJobs = await this.queueModel
      .find({
        status: EspnQueueStatus.PROCESSING,

        startedAt: {
          $lte: cutoff,
        },
      })
      .exec();

    if (staleJobs.length === 0) {
      return 0;
    }

    const result = await this.queueModel.updateMany(
      {
        _id: {
          $in: staleJobs.map((job) => job._id),
        },
      },
      {
        $set: {
          status: EspnQueueStatus.PENDING,

          nextAttemptAt: new Date(),

          lastError: 'Recovered stale processing job',
        },

        $unset: {
          startedAt: 1,
        },
      },
    );

    for (const job of staleJobs) {
      const stateKey = this.sportsSyncStateService.getQueueStateKey({
        jobType: job.type,

        leagueId: job.leagueId,

        season: job.season,

        eventId: job.eventId,

        triggerEventId: job.triggerEventId,

        queueJobKey: job.jobKey,
      });

      try {
        await this.sportsSyncStateService.resetInterruptedUnits(stateKey);
      } catch {
        /*
         * Queue recovery remains valid even when an older
         * synchronization-state record is unavailable.
         */
      }
    }

    return result.modifiedCount;
  }

  // ============================================================
  // CLEANUP
  // ============================================================

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
    },
  ): Promise<EspnQueueDocument> {
    job.status = EspnQueueStatus.PENDING;

    job.priority = params.priority;

    job.scheduledFor = params.scheduledFor;

    job.attempts = 0;

    job.startedAt = undefined;

    job.completedAt = undefined;

    job.failedAt = undefined;

    job.lastError = undefined;

    job.nextAttemptAt = undefined;

    return job.save();
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
    if (
      jobType === EspnQueueJobType.SUMMARY_REFRESH ||
      jobType === EspnQueueJobType.YOUTUBE_HIGHLIGHT
    ) {
      if (!eventId?.trim()) {
        throw new Error(`${jobType} jobs require an eventId`);
      }

      return [jobType, league, eventId.trim()].join(':');
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
}
