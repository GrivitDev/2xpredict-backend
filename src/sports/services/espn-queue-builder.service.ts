// backend/src/sports/services/espn-queue-builder.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  EspnFixture,
  EspnFixtureDocument,
} from '../schemas/espn/espn-fixture.schema';

import { CompetitionPriority } from '../enums/competition-priority.enum';

import { EspnQueueService } from './espn-queue.service';
import { EspnActiveCompetitionService } from './espn-active-competition.service';
import { SportsSyncStateService } from './sports-sync-state.service';

@Injectable()
export class EspnQueueBuilderService {
  private readonly logger = new Logger(EspnQueueBuilderService.name);

  private readonly upcomingWindowDays = 4;
  private readonly fixtureRefreshForwardDays = 8;
  private readonly staleFixtureRefreshHours = 48;
  private readonly recentFinishedWindowHours = 48;

  private readonly youtubeFinishedWindowHours = 48;

  constructor(
    private readonly espnQueueService: EspnQueueService,

    private readonly espnActiveCompetitionService: EspnActiveCompetitionService,

    private readonly sportsSyncStateService: SportsSyncStateService,

    @InjectModel(EspnFixture.name)
    private readonly espnFixtureModel: Model<EspnFixtureDocument>,
  ) {}

  // ============================================================
  // DAILY FIXTURE REFRESH
  // ============================================================

  async buildDailyLeagueRefreshQueue(): Promise<{
    active: number;
    queued: number;
    skipped: number;
  }> {
    const activeLeagues =
      await this.espnActiveCompetitionService.getActiveLeagues();

    const triggerEventId = `DAILY:${this.getLagosDateKey()}`;

    let active = 0;
    let queued = 0;
    let skipped = 0;

    for (const league of activeLeagues) {
      if (!league.isActive) {
        skipped += 1;
        continue;
      }

      if (typeof league.season !== 'number') {
        skipped += 1;

        this.logger.warn(
          `Skipping daily fixture refresh for ${league.leagueId}: missing season`,
        );

        continue;
      }

      if (!league.seasonStartDate) {
        skipped += 1;

        this.logger.warn(
          `Skipping daily fixture refresh for ${league.leagueId}: missing season start date`,
        );

        continue;
      }

      const leagueId = (league.slug || league.leagueId).trim().toLowerCase();

      if (!leagueId) {
        skipped += 1;
        continue;
      }

      active += 1;

      const priority = this.getQueuePriority(league.priority);

      /*
       * Extend/reuse the one persistent FIXTURE_REFRESH state.
       *
       * This does NOT create another state for the daily trigger.
       * New dates are appended to the existing state, while dates
       * already present in MongoDB are marked SUCCESS by the
       * synchronization-state service.
       */
      await this.ensureFixtureRefreshState({
        leagueId,

        season: league.season,

        priority,

        seasonStartDate: league.seasonStartDate,
      });

      const job = await this.espnQueueService.addFixtureRefreshJob({
        leagueId,
        season: league.season,
        priority,
        scheduledFor: new Date(),
        triggerEventId,
      });

      if (this.isFreshPendingJob(job)) {
        queued += 1;
      }
    }

    return {
      active,
      queued,
      skipped,
    };
  }

  // ============================================================
  // STALE ACTIVE LEAGUES
  // ============================================================

  async buildStaleFixtureRefreshQueue(): Promise<{
    checked: number;
    stale: number;
    queued: number;
    skipped: number;
  }> {
    const activeLeagues =
      await this.espnActiveCompetitionService.getActiveLeagues();

    const cutoff = new Date(
      Date.now() - this.staleFixtureRefreshHours * 60 * 60 * 1000,
    );

    let checked = 0;
    let stale = 0;
    let queued = 0;
    let skipped = 0;

    for (const league of activeLeagues) {
      if (!league.isActive) {
        skipped += 1;
        continue;
      }

      if (typeof league.season !== 'number') {
        skipped += 1;
        continue;
      }

      if (!league.seasonStartDate) {
        skipped += 1;

        this.logger.warn(
          `Skipping stale fixture refresh for ${league.leagueId}: missing season start date`,
        );

        continue;
      }

      const leagueId = (league.slug || league.leagueId).trim().toLowerCase();

      if (!leagueId) {
        skipped += 1;
        continue;
      }

      checked += 1;

      const latestFixture = await this.espnFixtureModel
        .findOne({
          leagueId,
        })
        .select({
          collectedAt: 1,
        })
        .sort({
          collectedAt: -1,
        })
        .lean()
        .exec();

      const latestCollectedAt = latestFixture?.collectedAt
        ? new Date(latestFixture.collectedAt)
        : undefined;

      if (
        latestCollectedAt &&
        !Number.isNaN(latestCollectedAt.getTime()) &&
        latestCollectedAt.getTime() > cutoff.getTime()
      ) {
        continue;
      }

      stale += 1;

      const priority = this.getQueuePriority(league.priority);

      /*
       * Reuse the same persistent FIXTURE_REFRESH state before
       * creating the operational stale queue job.
       */
      await this.ensureFixtureRefreshState({
        leagueId,

        season: league.season,

        priority,

        seasonStartDate: league.seasonStartDate,
      });

      const job = await this.espnQueueService.addFixtureRefreshJob({
        leagueId,
        season: league.season,
        priority,
        scheduledFor: new Date(),
        triggerEventId: `STALE:${this.getLagosDateKey()}`,
      });

      if (this.isFreshPendingJob(job)) {
        queued += 1;
      }
    }

    return {
      checked,
      stale,
      queued,
      skipped,
    };
  }

  // ============================================================
  // STARTUP SUMMARY QUEUE
  // ============================================================

  async buildStartupSummaryRefreshQueue(): Promise<{
    checked: number;
    missingSummary: number;
    queued: number;
    skipped: number;
  }> {
    const fixtures = await this.espnFixtureModel
      .find({
        $or: [
          {
            'payload.summary': {
              $exists: false,
            },
          },
          {
            'payload.summary': null,
          },
        ],
      })
      .select({
        eventId: 1,
        leagueId: 1,
        season: 1,
        fixtureDate: 1,
        payload: 1,
      })
      .sort({
        fixtureDate: 1,
      })
      .lean()
      .exec();

    let missingSummary = 0;
    let queued = 0;
    let skipped = 0;

    for (const fixture of fixtures) {
      if (!fixture.eventId) {
        skipped += 1;
        continue;
      }

      if (!fixture.leagueId) {
        skipped += 1;
        continue;
      }

      if (typeof fixture.season !== 'number') {
        skipped += 1;
        continue;
      }

      if (this.hasSummary(fixture)) {
        continue;
      }

      missingSummary += 1;

      const priority = await this.getSummaryQueuePriority(fixture.leagueId);

      const job = await this.espnQueueService.addSummaryRefreshJob({
        leagueId: fixture.leagueId,
        eventId: fixture.eventId,
        season: fixture.season,
        priority,
        scheduledFor: new Date(),
      });

      if (this.isFreshPendingJob(job)) {
        queued += 1;
      }
    }

    return {
      checked: fixtures.length,
      missingSummary,
      queued,
      skipped,
    };
  }

  // ============================================================
  // CONTINUOUS SUMMARY QUEUE
  // ============================================================

  async buildSummaryRefreshQueue(): Promise<{
    upcomingChecked: number;
    finishedChecked: number;
    queued: number;
    skipped: number;
  }> {
    const now = new Date();

    const upcomingUntil = new Date(
      now.getTime() + this.upcomingWindowDays * 24 * 60 * 60 * 1000,
    );

    const recentlyFinishedSince = new Date(
      now.getTime() - this.recentFinishedWindowHours * 60 * 60 * 1000,
    );

    const fixtures = await this.espnFixtureModel
      .find({
        $or: [
          {
            fixtureDate: {
              $gte: now,
              $lte: upcomingUntil,
            },
          },
          {
            fixtureDate: {
              $gte: recentlyFinishedSince,
              $lt: now,
            },
          },
        ],
      })
      .select({
        eventId: 1,
        leagueId: 1,
        season: 1,
        fixtureDate: 1,
        payload: 1,
      })
      .sort({
        fixtureDate: 1,
      })
      .lean()
      .exec();

    let upcomingChecked = 0;
    let finishedChecked = 0;
    let queued = 0;
    let skipped = 0;

    for (const fixture of fixtures) {
      if (!fixture.eventId) {
        skipped += 1;
        continue;
      }

      if (!fixture.leagueId) {
        skipped += 1;
        continue;
      }

      if (typeof fixture.season !== 'number') {
        skipped += 1;
        continue;
      }

      if (this.hasSummary(fixture)) {
        continue;
      }

      const fixtureDate = fixture.fixtureDate
        ? new Date(fixture.fixtureDate)
        : undefined;

      if (!fixtureDate || Number.isNaN(fixtureDate.getTime())) {
        skipped += 1;
        continue;
      }

      const isUpcoming =
        fixtureDate.getTime() >= now.getTime() &&
        fixtureDate.getTime() <= upcomingUntil.getTime();

      const isRecentlyFinished =
        fixtureDate.getTime() >= recentlyFinishedSince.getTime() &&
        fixtureDate.getTime() < now.getTime() &&
        this.isCompletedEvent(fixture.payload);

      if (!isUpcoming && !isRecentlyFinished) {
        continue;
      }

      if (isUpcoming) {
        upcomingChecked += 1;
      }

      if (isRecentlyFinished) {
        finishedChecked += 1;
      }

      if (!(await this.isActiveLeague(fixture.leagueId))) {
        skipped += 1;
        continue;
      }

      const priority = await this.getSummaryQueuePriority(fixture.leagueId);

      const job = await this.espnQueueService.addSummaryRefreshJob({
        leagueId: fixture.leagueId,
        eventId: fixture.eventId,
        season: fixture.season,
        priority,
        scheduledFor: new Date(),
      });

      if (this.isFreshPendingJob(job)) {
        queued += 1;
      }
    }

    return {
      upcomingChecked,
      finishedChecked,
      queued,
      skipped,
    };
  }

  // ============================================================
  // YOUTUBE HIGHLIGHT QUEUE
  // ============================================================

  /**
   * Creates YouTube highlight jobs for recently finished fixtures.
   *
   * Only active ELITE, HIGH and REGIONAL competitions are eligible.
   *
   * SELECTIVE competitions are deliberately excluded before a
   * queue document is created.
   */
  async buildYoutubeHighlightQueue(): Promise<{
    checked: number;
    eligible: number;
    queued: number;
    skipped: number;
  }> {
    const now = new Date();

    const finishedSince = new Date(
      now.getTime() - this.youtubeFinishedWindowHours * 60 * 60 * 1000,
    );

    const fixtures = await this.espnFixtureModel
      .find({
        completed: true,

        fixtureDate: {
          $gte: finishedSince,
          $lte: now,
        },
      })
      .select({
        eventId: 1,
        leagueId: 1,
        season: 1,
        fixtureDate: 1,
      })
      .sort({
        fixtureDate: 1,
      })
      .lean()
      .exec();

    let checked = 0;
    let eligible = 0;
    let queued = 0;
    let skipped = 0;

    for (const fixture of fixtures) {
      checked += 1;

      if (!fixture.eventId) {
        skipped += 1;
        continue;
      }

      if (!fixture.leagueId) {
        skipped += 1;
        continue;
      }

      if (typeof fixture.season !== 'number') {
        skipped += 1;
        continue;
      }

      const league = await this.espnActiveCompetitionService.getByLeagueId(
        fixture.leagueId,
      );

      if (!league?.isActive) {
        skipped += 1;
        continue;
      }

      /*
       * SELECTIVE is a hard exclusion.
       *
       * It is intentionally checked before creating the queue job.
       */
      if (league.priority === CompetitionPriority.SELECTIVE) {
        skipped += 1;
        continue;
      }

      /*
       * Only configured priority levels are eligible.
       *
       * getQueuePriority() maps:
       *   ELITE     → 1
       *   HIGH      → 2
       *   REGIONAL  → 3
       *   SELECTIVE → 4
       */
      const priority = this.getQueuePriority(league.priority);

      if (priority > 3) {
        skipped += 1;
        continue;
      }

      eligible += 1;

      const job = await this.espnQueueService.addYoutubeHighlightJob({
        leagueId: fixture.leagueId,
        eventId: fixture.eventId,
        season: fixture.season,
        priority,
        scheduledFor: new Date(),
      });

      if (this.isFreshPendingJob(job)) {
        queued += 1;
      }
    }

    return {
      checked,
      eligible,
      queued,
      skipped,
    };
  }

  // ============================================================
  // FINISHED FIXTURE FOLLOW-UP
  // ============================================================

  async queueFinishedFixtureFollowUp(params: {
    eventId: string;
    leagueId: string;
    season: number;
  }): Promise<{
    fixtureRefreshQueued: boolean;
    summaryRefreshQueued: boolean;
  }> {
    const { eventId, leagueId, season } = params;

    if (!eventId || !leagueId || typeof season !== 'number') {
      return {
        fixtureRefreshQueued: false,
        summaryRefreshQueued: false,
      };
    }

    const activeLeague =
      await this.espnActiveCompetitionService.getByLeagueId(leagueId);

    if (!activeLeague?.isActive) {
      return {
        fixtureRefreshQueued: false,
        summaryRefreshQueued: false,
      };
    }

    const priority = this.getQueuePriority(activeLeague.priority);

    /*
     * Finished-fixture follow-up still uses the same persistent
     * FIXTURE_REFRESH state for the league/season.
     *
     * The operational queue job may be FINISHED:<eventId>, but
     * that trigger does not create another sync-state document.
     */
    if (activeLeague.seasonStartDate) {
      await this.ensureFixtureRefreshState({
        leagueId,

        season,

        priority,

        seasonStartDate: activeLeague.seasonStartDate,
      });
    }

    const fixtureRefreshJob = await this.espnQueueService.addFixtureRefreshJob({
      leagueId,
      season,
      priority,
      scheduledFor: new Date(),
      triggerEventId: `FINISHED:${eventId}`,
    });

    let summaryRefreshQueued = false;

    const fixture = await this.espnFixtureModel
      .findOne({
        eventId,
      })
      .select({
        eventId: 1,
        leagueId: 1,
        season: 1,
        payload: 1,
      })
      .lean()
      .exec();

    if (fixture && !this.hasSummary(fixture)) {
      const summaryJob = await this.espnQueueService.addSummaryRefreshJob({
        leagueId: fixture.leagueId || leagueId,
        eventId,
        season: typeof fixture.season === 'number' ? fixture.season : season,
        priority,
        scheduledFor: new Date(),
      });

      summaryRefreshQueued = this.isFreshPendingJob(summaryJob);
    }

    return {
      fixtureRefreshQueued: this.isFreshPendingJob(fixtureRefreshJob),
      summaryRefreshQueued,
    };
  }

  // ============================================================
  // FIXTURE SYNC STATE
  // ============================================================

  private async ensureFixtureRefreshState(params: {
    leagueId: string;
    season: number;
    priority: number;
    seasonStartDate: string | Date;
  }): Promise<void> {
    const seasonStartDate = new Date(params.seasonStartDate);

    if (Number.isNaN(seasonStartDate.getTime())) {
      throw new Error(
        `Invalid season start date for fixture refresh: ${params.leagueId}`,
      );
    }

    const dateFrom = this.toDateOnly(seasonStartDate);

    const dateTo = this.toDateOnly(
      this.addUtcDays(
        this.startOfUtcDay(new Date()),
        this.fixtureRefreshForwardDays,
      ),
    );

    await this.sportsSyncStateService.ensureFixtureRefreshState({
      leagueId: params.leagueId,

      season: params.season,

      priority: params.priority,

      dateFrom,

      dateTo,

      trackingMode: 'HISTORY',
    });
  }

  // ============================================================
  // SUMMARY ELIGIBILITY
  // ============================================================

  private hasSummary(fixture: Pick<EspnFixtureDocument, 'payload'>): boolean {
    const payload = fixture.payload;

    if (!payload || typeof payload !== 'object') {
      return false;
    }

    return Boolean(
      payload.summary &&
      typeof payload.summary === 'object' &&
      Object.keys(payload.summary).length > 0,
    );
  }

  // ============================================================
  // ACTIVITY
  // ============================================================

  private async isActiveLeague(leagueId: string): Promise<boolean> {
    const league =
      await this.espnActiveCompetitionService.getByLeagueId(leagueId);

    return Boolean(league?.isActive);
  }

  private async getSummaryQueuePriority(leagueId: string): Promise<number> {
    const league =
      await this.espnActiveCompetitionService.getByLeagueId(leagueId);

    if (!league) {
      return 4;
    }

    return this.getQueuePriority(league.priority);
  }

  // ============================================================
  // PRIORITY
  // ============================================================

  private getQueuePriority(
    priority?: CompetitionPriority | string | null,
  ): number {
    if (!priority) {
      return 4;
    }

    switch (priority) {
      case String(CompetitionPriority.ELITE):
        return 1;

      case String(CompetitionPriority.HIGH):
        return 2;

      case String(CompetitionPriority.REGIONAL):
        return 3;

      case String(CompetitionPriority.SELECTIVE):
      default:
        return 4;
    }
  }

  // ============================================================
  // QUEUE RESULT
  // ============================================================

  private isFreshPendingJob(job: {
    status?: unknown;
    attempts?: unknown;
  }): boolean {
    return String(job.status) === 'PENDING' && Number(job.attempts ?? 0) === 0;
  }

  // ============================================================
  // COMPLETION DETECTION
  // ============================================================

  private toStringValue(value: unknown): string | undefined {
    if (typeof value === 'string') {
      return value;
    }

    return typeof value === 'number' ? String(value) : undefined;
  }

  private isCompletedEvent(event: unknown): boolean {
    if (!event || typeof event !== 'object') {
      return false;
    }

    const eventRecord = event as Record<string, unknown>;

    const rootStatus =
      eventRecord.status && typeof eventRecord.status === 'object'
        ? (eventRecord.status as Record<string, unknown>)
        : undefined;

    const rootStatusType =
      rootStatus?.type && typeof rootStatus.type === 'object'
        ? (rootStatus.type as Record<string, unknown>)
        : undefined;

    if (rootStatus?.completed === true || rootStatusType?.completed === true) {
      return true;
    }

    const rootState = this.toStringValue(
      rootStatusType?.state ?? rootStatus?.state,
    );

    if (
      rootState &&
      ['post', 'final', 'completed', 'complete', 'finished'].includes(
        String(rootState).toLowerCase(),
      )
    ) {
      return true;
    }

    const competitions = Array.isArray(eventRecord.competitions)
      ? (eventRecord.competitions as unknown[])
      : [];

    const competition = competitions[0];

    if (!competition || typeof competition !== 'object') {
      return false;
    }

    const competitionRecord = competition as Record<string, unknown>;

    const competitionStatus =
      competitionRecord.status && typeof competitionRecord.status === 'object'
        ? (competitionRecord.status as Record<string, unknown>)
        : undefined;

    const competitionStatusType =
      competitionStatus?.type && typeof competitionStatus.type === 'object'
        ? (competitionStatus.type as Record<string, unknown>)
        : undefined;

    if (
      competitionStatus?.completed === true ||
      competitionStatusType?.completed === true
    ) {
      return true;
    }

    const state = this.toStringValue(
      competitionStatusType?.state ?? competitionStatus?.state,
    );

    if (
      state &&
      ['post', 'final', 'completed', 'complete', 'finished'].includes(
        state.toLowerCase(),
      )
    ) {
      return true;
    }

    const detail = this.toStringValue(
      competitionStatusType?.detail ??
        competitionStatus?.detail ??
        competitionStatusType?.shortDetail,
    );

    return detail
      ? ['ft', 'full time', 'post'].includes(detail.toLowerCase())
      : false;
  }

  // ============================================================
  // DATE HELPERS
  // ============================================================

  private startOfUtcDay(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }

  private addUtcDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
  }

  private toDateOnly(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private getLagosDateKey(date = new Date()): string {
    /*
     * Africa/Lagos is UTC+1.
     */
    return new Date(date.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  // ============================================================
  // NOTE
  // ============================================================

  getFixtureRefreshForwardDays(): number {
    return this.fixtureRefreshForwardDays;
  }
}
