import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CompetitionPriority } from '../enums/competition-priority.enum';
import { SPORTS_DATA_COLLECTION_CONFIG } from '../config/sports-data-collection.config';
import { YOUTUBE_CONFIG } from '../config/youtube.config';
import { EspnQueueJobType } from '../interfaces/espn-queue.interface';
import {
  EspnFixture,
  EspnFixtureDocument,
} from '../schemas/espn/espn-fixture.schema';
import {
  YouTubeHighlight,
  YouTubeHighlightDocument,
} from '../schemas/youtube-highlight.schema';
import { YoutubeHighlightStatus } from '../interfaces/youtube-highlight.interface';
import { EspnQueueService } from './espn-queue.service';
import { EspnActiveCompetitionService } from './espn-active-competition.service';

interface QueueFixture {
  eventId: string;
  leagueId: string;
  season: number;
  fixtureDate: Date;
  completed?: boolean;
  live?: boolean;
  completedAt?: Date | string | null;
  fixtureCollectedAt?: Date | string | null;
  summaryCollectedAt?: Date | string | null;
  hasSummary: boolean;
  status?: string;
  statusDetail?: string;
  statusShortDetail?: string;
  homeScore?: number;
  awayScore?: number;
  payload?: { summary?: unknown; summaryCollectedAt?: Date | string | null };
  homeTeamId?: string;
  awayTeamId?: string;
}

@Injectable()
export class EspnQueueBuilderService {
  private readonly logger = new Logger(EspnQueueBuilderService.name);
  private readonly upcomingWindowHours =
    SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.upcomingWindowHours;
  private readonly fixtureRefreshForwardDays =
    SPORTS_DATA_COLLECTION_CONFIG.ESPN.fixtures.forwardDays;
  private readonly postMatchDelayMs =
    SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.finishedMatchDelayMinutes * 60_000;
  private readonly postMatchRetryDelayMs = 30 * 60 * 1000;

  constructor(
    private readonly espnQueueService: EspnQueueService,
    private readonly espnActiveCompetitionService: EspnActiveCompetitionService,
    @InjectModel(EspnFixture.name)
    private readonly espnFixtureModel: Model<EspnFixtureDocument>,
    @InjectModel(YouTubeHighlight.name)
    private readonly youtubeHighlightModel: Model<YouTubeHighlightDocument>,
  ) {}

  /**
   * Seeds persistent delayed work after startup. The worker later creates the
   * next dated window-extension job after each successful run; no cron job or
   * recurring MongoDB discovery scan is needed.
   */
  async buildDailyLeagueRefreshQueue(): Promise<{
    active: number;
    queued: number;
    skipped: number;
  }> {
    const activeLeagues =
      await this.espnActiveCompetitionService.getActiveLeagues();
    let active = 0;
    let queued = 0;
    let skipped = 0;

    for (const league of activeLeagues) {
      if (!league.isActive || typeof league.season !== 'number') {
        skipped += 1;
        continue;
      }

      const leagueId = this.normalizeLeagueId(league.slug || league.leagueId);
      if (!leagueId) {
        skipped += 1;
        continue;
      }

      active += 1;
      if (league.fixturesCollectedSeason !== league.season) {
        const bootstrap = await this.queueSeasonFixtureBootstrap({
          leagueId,
          season: league.season,
          priority: this.getQueuePriority(league.priority),
        });
        if (bootstrap) queued += 1;
        else skipped += 1;
        continue;
      }

      const result = await this.scheduleNextWindowExtension({
        leagueId,
        season: league.season,
        priority: this.getQueuePriority(league.priority),
      });
      if (result) queued += 1;
    }

    // Catalogue and league-detail maintenance are also persistent queue jobs.
    // Their successful workers schedule their next delayed execution.
    const catalogueAlreadyScheduled =
      await this.espnQueueService.hasScheduledJobForScope({
        jobType: EspnQueueJobType.LEAGUE_CATALOGUE_REFRESH,
        leagueId: '__system__',
      });
    if (!catalogueAlreadyScheduled) {
      const scheduledFor = this.addDays(new Date(), 7);
      const catalogueJob =
        await this.espnQueueService.addLeagueCatalogueRefreshJob({
          scheduledFor,
          priority: 1,
          triggerEventId: `CATALOGUE_BOOTSTRAP:${this.getLagosDateKey()}`,
        });
      if (this.isPendingFresh(catalogueJob)) queued += 1;
      else skipped += 1;
    } else {
      skipped += 1;
    }

    // One boot-time bounded query seeds durable 160-minute post-kickoff jobs
    // for already-known fixtures. Later scoreboard writes seed only their own
    // returned event IDs.
    const postMatch = await this.buildPostMatchCheckQueue();
    queued += postMatch.queued;
    skipped += postMatch.skipped;

    // One-time startup recovery for fixtures whose transition to completed
    // was recorded today. This is intentionally not a recurring fixture scan.
    const recentCompleted = await this.buildRecentlyCompletedWorkQueue();
    queued += recentCompleted.queued;
    skipped += recentCompleted.skipped;

    const allLeagues =
      await this.espnActiveCompetitionService.getOrderedLeagues();
    for (const league of allLeagues) {
      const leagueId = this.normalizeLeagueId(league.slug || league.leagueId);
      if (!leagueId) continue;
      const season =
        typeof league.season === 'number' ? league.season : undefined;
      if (
        await this.espnQueueService.hasScheduledJobForScope({
          jobType: EspnQueueJobType.LEAGUE_DETAIL_REFRESH,
          leagueId,
          season,
        })
      ) {
        skipped += 1;
        continue;
      }
      const scheduledFor = this.nextLeagueDetailRefreshAt(league);
      const job = await this.espnQueueService.addLeagueDetailRefreshJob({
        leagueId,
        season,
        priority: this.getQueuePriority(league.priority),
        scheduledFor,
        triggerEventId: `LEAGUE_DETAIL_BOOTSTRAP:${leagueId}:${season ?? 'current'}`,
      });
      if (this.isPendingFresh(job)) queued += 1;
      else skipped += 1;
    }

    try {
      const integrityRecovery = await this.buildIntegrityRecoveryQueue({
        maxQueued: SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.integrityRecoveryMaxQueuedPerPass,
      });
      queued += integrityRecovery.queued;
      skipped += integrityRecovery.skipped;
    } catch (error) {
      // Integrity recovery is supplemental. A failure here must not block the
      // normal fixture queue or stop startup; the next daily pass retries it.
      skipped += 1;
      this.logger.warn(
        `Could not seed the bounded ESPN integrity recovery pass: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return { active, queued, skipped };
  }

  /**
   * Called immediately after scoreboard fixtures have been persisted. Only
   * the returned fixture IDs are evaluated; this is event-triggered work, not
   * a periodic scan over all completed fixtures.
   */
  async onFixturesCollected(eventIds: string[]): Promise<void> {
    // Initial startup has a dedicated bounded Summary phase. Queue-based
    // runtime follow-ups begin only after startup releases normal operations.
    if (!this.espnQueueService.isNormalOperationsReady()) return;

    const ids = [
      ...new Set(eventIds.map((id) => String(id).trim()).filter(Boolean)),
    ];
    if (ids.length === 0) return;

    const now = new Date();
    const todayStart = this.startOfLagosDay(now);
    const tomorrowStart = this.addLagosCalendarDays(todayStart, 1);
    const summaryEnd = new Date(
      now.getTime() + this.upcomingWindowHours * 60 * 60_000,
    );
    const lifecycleStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const lifecycleEnd = this.addLagosCalendarDays(
      todayStart,
      this.fixtureRefreshForwardDays + 1,
    );

    // The input IDs came from one recent scoreboard write. Narrow the database
    // read to the lifecycle horizon plus matches completed today so a monthly
    // scoreboard response cannot trigger per-event work over historic rows.
    const fixtures = await this.espnFixtureModel
      .find({
        eventId: { $in: ids },
        $or: [
          { fixtureDate: { $gte: lifecycleStart, $lt: lifecycleEnd } },
          { completedAt: { $gte: todayStart, $lt: tomorrowStart } },
        ],
      })
      .select({
        eventId: 1,
        leagueId: 1,
        season: 1,
        fixtureDate: 1,
        completed: 1,
        live: 1,
        completedAt: 1,
        fixtureCollectedAt: 1,
        'payload.summaryCollectedAt': 1,
        'payload.summary': 1,
        homeTeamId: 1,
        awayTeamId: 1,
      })
      .lean()
      .exec();

    for (const raw of fixtures) {
      const fixture = raw as unknown as QueueFixture & {
        payload?: {
          summary?: unknown;
          summaryCollectedAt?: Date | string | null;
        };
      };
      const eventId = String(fixture.eventId ?? '').trim();
      const leagueId = this.normalizeLeagueId(fixture.leagueId);
      const season = fixture.season;
      const fixtureDate = this.asValidDate(fixture.fixtureDate);
      if (!eventId || !leagueId || !Number.isInteger(season) || !fixtureDate) {
        continue;
      }

      const activeLeague =
        (await this.espnActiveCompetitionService.getByLeagueId(leagueId)) ??
        (await this.espnActiveCompetitionService.getBySlug(leagueId));
      if (
        !activeLeague?.isActive ||
        activeLeague.season !== season ||
        activeLeague.fixturesCollectedSeason !== season
      ) {
        continue;
      }

      const priority = this.getQueuePriority(activeLeague.priority);

      await this.queuePostKickoffSummaryRefresh({
        eventId,
        leagueId,
        season,
        priority,
      });

      const completedAt = this.asValidDate(fixture.completedAt);
      const summaryCollectedAt = this.asValidDate(
        fixture.payload?.summaryCollectedAt ?? fixture.summaryCollectedAt,
      );
      const fixtureCollectedAt = this.asValidDate(fixture.fixtureCollectedAt);
      const hasSummary = this.hasSummary(fixture.payload?.summary);

      if (fixture.completed === true) {
        // The fixture lookup is already limited to the recent lifecycle horizon
        // (or a completion observed today). Do not use a calendar-day boundary
        // for standings: a match first observed as final after midnight still
        // has to refresh its competition-season table. Event-scoped queue keys
        // coalesce retries for this fixture without merging different seasons.
        await this.queueStandingsRefresh({
          leagueId,
          season,
          priority,
          eventId,
        });

        const completionReference = completedAt ?? fixtureCollectedAt ?? fixtureDate;
        const withinRecentCompletionWindow =
          completionReference.getTime() <= now.getTime() &&
          now.getTime() - completionReference.getTime() <= 24 * 60 * 60 * 1000;
        if (withinRecentCompletionWindow) {
          await this.queueFinishedSummaryRefresh({
            eventId,
            leagueId,
            season,
            priority,
          });
          await this.queueYoutubeHighlightForCompletedFixture({
            eventId,
            leagueId,
            season,
            priority,
          });
        }
        continue;
      }

      // Upcoming Summary eligibility uses the configured rolling window, not calendar days.
      if (
        fixture.live !== true &&
        fixtureDate >= now &&
        fixtureDate <= summaryEnd &&
        !this.isSummaryFreshForUpcomingWindow(hasSummary, summaryCollectedAt, fixtureDate)
      ) {
        await this.espnQueueService.addSummaryRefreshJob({
          leagueId,
          eventId,
          season,
          priority,
          scheduledFor: now,
        });
      }

      // Post-kickoff checks are event-specific Summary jobs. Do not enqueue a
      // full monthly scoreboard refresh for every fixture; that multiplies the
      // same provider request by the number of matches in the league.
    }
  }

  /**
   * Enqueues only upcoming fixture Summary work. Used when a newly discovered
   * season has been collected after normal queue operations were released.
   */
  async buildSummaryRefreshQueue(params?: {
    leagueId?: string;
    season?: number;
  }): Promise<{
    upcomingChecked: number;
    finishedChecked: number;
    queued: number;
    skipped: number;
  }> {
    const now = new Date();
    const end = new Date(
      now.getTime() + this.upcomingWindowHours * 60 * 60_000,
    );
    const fixtures = await this.espnFixtureModel
      .find({
        ...(params?.leagueId
          ? { leagueId: this.normalizeLeagueId(params.leagueId) }
          : {}),
        ...(typeof params?.season === 'number'
          ? { season: params.season }
          : {}),
        fixtureDate: { $gte: now, $lte: end },
        completed: { $ne: true },
        live: { $ne: true },
      })
      .select({
        eventId: 1,
        leagueId: 1,
        season: 1,
        fixtureDate: 1,
        fixtureCollectedAt: 1,
        'payload.summary': 1,
        'payload.summaryCollectedAt': 1,
      })
      .lean()
      .exec();

    let queued = 0;
    let skipped = 0;
    for (const fixture of fixtures) {
      const eventId = String(fixture.eventId ?? '').trim();
      const leagueId = this.normalizeLeagueId(fixture.leagueId);
      const season = fixture.season;
      if (!eventId || !leagueId || !Number.isInteger(season)) {
        skipped += 1;
        continue;
      }
      const activeLeague =
        (await this.espnActiveCompetitionService.getByLeagueId(leagueId)) ??
        (await this.espnActiveCompetitionService.getBySlug(leagueId));
      if (
        !activeLeague?.isActive ||
        activeLeague.season !== season ||
        activeLeague.fixturesCollectedSeason !== season
      ) {
        skipped += 1;
        continue;
      }
      const hasSummary = this.hasSummary(fixture.payload?.summary);
      if (
        this.isSummaryFreshForUpcomingWindow(
          hasSummary,
          fixture.payload?.summaryCollectedAt,
          new Date(fixture.fixtureDate),
        )
      ) {
        continue;
      }
      const job = await this.espnQueueService.addSummaryRefreshJob({
        leagueId,
        eventId,
        season,
        priority: this.getQueuePriority(activeLeague.priority),
        scheduledFor: now,
      });
      if (this.isPendingFresh(job)) queued += 1;
    }
    return {
      upcomingChecked: fixtures.length,
      finishedChecked: 0,
      queued,
      skipped,
    };
  }

  async queueSeasonFixtureBootstrap(params: {
    leagueId: string;
    season: number;
    priority: number;
    scheduledFor?: Date;
    triggerEventId?: string;
  }): Promise<boolean> {
    const leagueId = this.normalizeLeagueId(params.leagueId);
    if (!leagueId || !Number.isInteger(params.season)) return false;

    const league =
      (await this.espnActiveCompetitionService.getByLeagueId(leagueId)) ??
      (await this.espnActiveCompetitionService.getBySlug(leagueId));
    if (
      !league?.isActive ||
      league.season !== params.season ||
      league.fixturesCollectedSeason === params.season
    ) {
      return false;
    }

    const scheduledFor = params.scheduledFor ?? new Date();
    const attemptedAt = league.fixtureCollectionAttemptedAt
      ? this.asValidDate(league.fixtureCollectionAttemptedAt)
      : undefined;
    const cooldownUntil =
      league.fixtureCollectionAttemptSeason === params.season && attemptedAt
        ? attemptedAt.getTime() + 6 * 60 * 60 * 1000
        : 0;
    if (scheduledFor.getTime() < cooldownUntil) return false;
    if (
      await this.espnQueueService.hasActiveSeasonBootstrap(
        leagueId,
        params.season,
      )
    )
      return false;

    const job = await (
      this.espnQueueService as unknown as {
        addSeasonFixtureBootstrapJob(params: {
          leagueId: string;
          season: number;
          priority: number;
          scheduledFor: Date;
          triggerEventId?: string;
        }): Promise<{ status?: unknown }>;
      }
    ).addSeasonFixtureBootstrapJob({
      leagueId,
      season: params.season,
      priority: params.priority,
      scheduledFor,
      triggerEventId: params.triggerEventId,
    });
    return this.isPending(job);
  }

  /** Seed post-kickoff checks for unresolved fixtures from the last 24 hours. */
  async buildPostMatchCheckQueue(params?: {
    leagueId?: string;
    season?: number;
  }): Promise<{ checked: number; queued: number; skipped: number }> {
    const activeLeagues = (
      await this.espnActiveCompetitionService.getActiveLeagues()
    ).filter(
      (league) =>
        league.isActive &&
        typeof league.season === 'number' &&
        league.fixturesCollectedSeason === league.season &&
        (!params?.season || league.season === params.season) &&
        (!params?.leagueId ||
          [league.slug, league.leagueId].some(
            (id) =>
              this.normalizeLeagueId(id || '') ===
              this.normalizeLeagueId(params.leagueId || ''),
          )),
    );
    if (activeLeagues.length === 0)
      return { checked: 0, queued: 0, skipped: 0 };

    const activeKeys = new Map<
      string,
      { leagueId: string; season: number; priority: number }
    >();
    for (const league of activeLeagues) {
      const leagueId = this.normalizeLeagueId(league.slug || league.leagueId);
      if (!leagueId || typeof league.season !== 'number') continue;
      activeKeys.set(`${leagueId}:${league.season}`, {
        leagueId,
        season: league.season,
        priority: this.getQueuePriority(league.priority),
      });
    }
    if (activeKeys.size === 0) return { checked: 0, queued: 0, skipped: 0 };

    const now = new Date();
    // Only inspect fixtures whose kickoff has already passed. Upcoming matches
    // receive their post-match Summary job when their normal rolling fixture
    // refresh encounters them, avoiding a large startup burst of delayed jobs.
    const lifecycleStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const fixtures = await this.espnFixtureModel
      .find({
        $or: [...activeKeys.values()].map((key) => ({
          leagueId: key.leagueId,
          season: key.season,
        })),
        fixtureDate: { $gte: lifecycleStart, $lte: now },
        completed: { $ne: true },
      })
      .select({ eventId: 1, leagueId: 1, season: 1, fixtureDate: 1, live: 1 })
      .lean()
      .exec();

    let queued = 0;
    let skipped = 0;
    for (const fixture of fixtures) {
      const eventId = String(fixture.eventId ?? '').trim();
      const leagueId = this.normalizeLeagueId(fixture.leagueId);
      const season = fixture.season;
      const fixtureDate = this.asValidDate(fixture.fixtureDate);
      const active = activeKeys.get(`${leagueId}:${season}`);
      if (!eventId || !fixtureDate || !active) {
        skipped += 1;
        continue;
      }
      const summaryQueued = await this.queuePostKickoffSummaryRefresh({
        eventId,
        leagueId,
        season,
        priority: active.priority,
      });
      if (summaryQueued) queued += 1;
      else skipped += 1;
    }
    return { checked: fixtures.length, queued, skipped };
  }

  /**
   * One-shot reconciliation of fixtures whose completed transition was
   * recorded today in the Nigeria calendar. Called at startup and after a
   * newly-active season catalogue finishes; never registered as a timer.
   */
  async buildRecentlyCompletedWorkQueue(params?: {
    leagueId?: string;
    season?: number;
  }): Promise<{ checked: number; queued: number; skipped: number }> {
    const requestedLeagueId = params?.leagueId
      ? this.normalizeLeagueId(params.leagueId)
      : undefined;
    const activeLeagues = (
      await this.espnActiveCompetitionService.getActiveLeagues()
    ).filter(
      (league) =>
        league.isActive &&
        typeof league.season === 'number' &&
        league.fixturesCollectedSeason === league.season &&
        (typeof params?.season !== 'number' ||
          league.season === params.season) &&
        (!requestedLeagueId ||
          [league.slug, league.leagueId].some(
            (id) => this.normalizeLeagueId(id || '') === requestedLeagueId,
          )),
    );
    const activeKeys = activeLeagues.flatMap((league) => {
      const leagueId = this.normalizeLeagueId(league.slug || league.leagueId);
      if (!leagueId || typeof league.season !== 'number') return [];
      return [{ leagueId, season: league.season }];
    });
    if (activeKeys.length === 0) return { checked: 0, queued: 0, skipped: 0 };

    const now = new Date();
    const todayStart = this.startOfLagosDay(now);
    const tomorrowStart = this.addLagosCalendarDays(todayStart, 1);
    const fixtures = await this.espnFixtureModel
      .find({
        completed: true,
        completedAt: { $gte: todayStart, $lt: tomorrowStart },
        $or: activeKeys,
      })
      .select({ eventId: 1, leagueId: 1, season: 1 })
      .lean()
      .exec();

    let queued = 0;
    let skipped = 0;
    for (const fixture of fixtures) {
      const eventId = String(fixture.eventId ?? '').trim();
      const leagueId = this.normalizeLeagueId(fixture.leagueId);
      const season = fixture.season;
      const league = activeLeagues.find(
        (candidate) =>
          candidate.season === season &&
          [candidate.slug, candidate.leagueId].some(
            (id) => this.normalizeLeagueId(id || '') === leagueId,
          ),
      );
      if (!eventId || !league || typeof season !== 'number') {
        skipped += 1;
        continue;
      }

      const priority = this.getQueuePriority(league.priority);
      const summaryQueued = await this.queueFinishedSummaryRefresh({
        eventId,
        leagueId,
        season,
        priority,
      });
      const youtubeQueued = await this.queueYoutubeHighlightForCompletedFixture(
        {
          eventId,
          leagueId,
          season,
          priority,
        },
      );
      const standingsQueued = await this.queueStandingsRefresh({
        leagueId,
        season,
        priority,
        eventId,
      });
      if (summaryQueued || youtubeQueued || standingsQueued) queued += 1;
    }
    return { checked: fixtures.length, queued, skipped };
  }

  async queueFinishedFixtureFollowUp(params: {
    eventId: string;
    leagueId: string;
    season: number;
  }): Promise<{
    fixtureRefreshQueued: boolean;
    summaryRefreshQueued: boolean;
  }> {
    const eventId = String(params.eventId ?? '').trim();
    const leagueId = this.normalizeLeagueId(params.leagueId);
    const fixture = await this.espnFixtureModel
      .findOne({ eventId, leagueId, season: params.season })
      .select({
        completed: 1,
        fixtureDate: 1,
        completedAt: 1,
        fixtureCollectedAt: 1,
      })
      .lean()
      .exec();
    if (!fixture || fixture.completed !== true) {
      const activeLeague =
        (await this.espnActiveCompetitionService.getByLeagueId(leagueId)) ??
        (await this.espnActiveCompetitionService.getBySlug(leagueId));
      if (!activeLeague)
        return { fixtureRefreshQueued: false, summaryRefreshQueued: false };
      const job = await this.espnQueueService.addFixtureRefreshJob({
        leagueId,
        season: params.season,
        priority: this.getQueuePriority(activeLeague.priority),
        scheduledFor: new Date(),
        triggerEventId: `FINISHED:${eventId}`,
      });
      return {
        fixtureRefreshQueued: this.isPending(job),
        summaryRefreshQueued: false,
      };
    }
    const summaryRefreshQueued = await this.queueFinishedSummaryRefresh({
      eventId,
      leagueId,
      season: params.season,
    });
    await this.queueYoutubeHighlightForCompletedFixture({
      eventId,
      leagueId,
      season: params.season,
    });
    await this.queueStandingsRefresh({
      leagueId,
      season: params.season,
      eventId,
    });
    return { fixtureRefreshQueued: false, summaryRefreshQueued };
  }

  /**
   * Schedule a dedicated post-kickoff Summary refresh 160 minutes after the
   * fixture's scheduled kickoff. It deliberately does not require the fixture
   * to be marked completed or a Summary payload to already exist.
   */
  async queuePostKickoffSummaryRefresh(params: {
    eventId: string;
    leagueId: string;
    season: number;
    priority?: number;
  }): Promise<boolean> {
    const eventId = String(params.eventId ?? '').trim();
    const leagueId = this.normalizeLeagueId(params.leagueId);
    const season = params.season;
    if (!eventId || !leagueId || !Number.isInteger(season)) return false;

    const activeLeague =
      (await this.espnActiveCompetitionService.getByLeagueId(leagueId)) ??
      (await this.espnActiveCompetitionService.getBySlug(leagueId));
    if (
      !activeLeague?.isActive ||
      activeLeague.season !== season ||
      activeLeague.fixturesCollectedSeason !== season
    ) {
      return false;
    }

    const fixture = await this.espnFixtureModel
      .findOne({ eventId, leagueId, season })
      .select({ fixtureDate: 1 })
      .lean()
      .exec();
    const fixtureDate = this.asValidDate(fixture?.fixtureDate);
    if (!fixture || !fixtureDate) return false;

    const triggerEventId = `POSTMATCH_SUMMARY:${eventId}`;
    if (
      await this.espnQueueService.hasJob({
        jobType: EspnQueueJobType.SUMMARY_REFRESH,
        leagueId,
        eventId,
        season,
        triggerEventId,
      })
    ) {
      return false;
    }

    const scheduledFor = new Date(
      Math.max(
        Date.now(),
        fixtureDate.getTime() + this.postMatchDelayMs,
      ),
    );
    const job = await this.espnQueueService.addSummaryRefreshJob({
      leagueId,
      eventId,
      season,
      priority:
        typeof params.priority === 'number'
          ? params.priority
          : this.getQueuePriority(activeLeague.priority),
      scheduledFor,
      triggerEventId,
    });
    return this.isPendingFresh(job);
  }

  async queueFinishedSummaryRefresh(params: {
    eventId: string;
    leagueId: string;
    season: number;
    priority?: number;
  }): Promise<boolean> {
    // Completion may be discovered before or after kickoff + 160 minutes. The
    // dedicated job remains scheduled for kickoff + 160 minutes, or runs now if
    // that time has already passed.
    return this.queuePostKickoffSummaryRefresh(params);
  }

  /**
   * Re-check eligibility at execution time as well as queue-insertion time.
   * This also prevents old persisted YouTube jobs from consuming quota after
   * a deployment changes the eligibility rules.
   */
  async isYoutubeHighlightEligible(params: {
    eventId: string;
    leagueId: string;
    season: number;
  }): Promise<boolean> {
    if (!SPORTS_DATA_COLLECTION_CONFIG.YOUTUBE.enabled) return false;
    const eventId = String(params.eventId ?? '').trim();
    const leagueId = this.normalizeLeagueId(params.leagueId);
    if (!eventId || !leagueId || !Number.isInteger(params.season)) return false;

    const fixture = await this.espnFixtureModel
      .findOne({ eventId, leagueId, season: params.season, completed: true })
      .select({ completedAt: 1, fixtureDate: 1 })
      .lean()
      .exec();
    const fixtureDate = this.asValidDate(fixture?.fixtureDate);
    if (!fixture || !fixtureDate) return false;

    const now = new Date();
    const eligibilityExpiresAt = new Date(
      fixtureDate.getTime() + YOUTUBE_CONFIG.highlightWindowHours * 60 * 60_000,
    );
    if (fixtureDate.getTime() > now.getTime() || now.getTime() > eligibilityExpiresAt.getTime()) {
      return false;
    }

    const completedAt = this.asValidDate(fixture.completedAt);
    if (completedAt && completedAt.getTime() > now.getTime()) return false;

    const league =
      (await this.espnActiveCompetitionService.getByLeagueId(leagueId)) ??
      (await this.espnActiveCompetitionService.getBySlug(leagueId));
    if (
      !league?.isActive ||
      league.season !== params.season ||
      league.fixturesCollectedSeason !== params.season ||
      league.priority === CompetitionPriority.SELECTIVE ||
      this.getQueuePriority(league.priority) > 3
    ) {
      return false;
    }

    // A usable, previously saved video makes another YouTube search pointless.
    const existingHighlight = await this.youtubeHighlightModel
      .findOne({
        fixtureId: eventId,
        status: YoutubeHighlightStatus.FOUND,
        $or: [
          { videoId: { $exists: true, $nin: ['', null] } },
          { videoUrl: { $exists: true, $nin: ['', null] } },
        ],
      })
      .select({ _id: 1 })
      .lean()
      .exec();
    return !existingHighlight;
  }

  async queueYoutubeHighlightForCompletedFixture(params: {
    eventId: string;
    leagueId: string;
    season: number;
    priority?: number;
  }): Promise<boolean> {
    const eventId = String(params.eventId ?? '').trim();
    const leagueId = this.normalizeLeagueId(params.leagueId);
    if (!eventId || !leagueId || !Number.isInteger(params.season)) return false;
    if (
      !(await this.isYoutubeHighlightEligible({
        eventId,
        leagueId,
        season: params.season,
      }))
    ) {
      return false;
    }

    // Active, successful, and not-yet-due retry work suppress duplicates.
    // An exhausted failure can be reopened after a cooldown if this eligible
    // match is encountered again through normal scoreboard processing.
    if (
      await this.espnQueueService.shouldSkipDuplicateAttempt({
        jobType: EspnQueueJobType.YOUTUBE_HIGHLIGHT,
        leagueId,
        eventId,
        season: params.season,
        terminalFailureCooldownMs: 60 * 60_000,
      })
    ) {
      return false;
    }

    const league =
      (await this.espnActiveCompetitionService.getByLeagueId(leagueId)) ??
      (await this.espnActiveCompetitionService.getBySlug(leagueId));
    if (!league) return false;

    const scheduledFor = await this.getYoutubeHighlightAttemptScheduledFor({
      eventId,
      leagueId,
      season: params.season,
      attemptNumber: 1,
    });
    if (!scheduledFor) return false;

    const job = await this.espnQueueService.addYoutubeHighlightJob({
      leagueId,
      eventId,
      season: params.season,
      priority:
        typeof params.priority === 'number'
          ? params.priority
          : this.getQueuePriority(league.priority),
      scheduledFor,
    });
    return this.isPendingFresh(job);
  }

  /**
   * Returns the absolute queue time for one YouTube stage. Attempt offsets are
   * measured from full-time detection, not from the previous attempt, so late
   * workers do not keep pushing the entire sequence further into the window.
   */
  async getYoutubeHighlightAttemptScheduledFor(params: {
    eventId: string;
    leagueId: string;
    season: number;
    attemptNumber: number;
  }): Promise<Date | null> {
    const { eventId, leagueId, season, attemptNumber } = params;
    const offsets = YOUTUBE_CONFIG.searchWorkflow.attemptOffsetsMinutes;
    if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > offsets.length) {
      return null;
    }

    const fixture = await this.espnFixtureModel
      .findOne({ eventId, leagueId, season, completed: true })
      .select({ fixtureDate: 1, completedAt: 1 })
      .lean()
      .exec();
    const fixtureDate = this.asValidDate(fixture?.fixtureDate);
    if (!fixture || !fixtureDate) return null;

    const kickoffExpiry = new Date(
      fixtureDate.getTime() + YOUTUBE_CONFIG.highlightWindowHours * 60 * 60_000,
    );
    const now = new Date();
    if (now.getTime() > kickoffExpiry.getTime()) return null;

    // completedAt records when the fixture's completed transition was first
    // persisted. Legacy rows without it use kickoff + two hours as a bounded
    // full-time estimate rather than scheduling a retry before the match ends.
    const completedAt = this.asValidDate(fixture.completedAt);
    const completionReference = completedAt ?? new Date(fixtureDate.getTime() + 2 * 60 * 60_000);
    const target = new Date(
      completionReference.getTime() + offsets[attemptNumber - 1] * 60_000,
    );
    if (target.getTime() > kickoffExpiry.getTime()) return null;
    return target.getTime() > now.getTime() ? target : now;
  }

  async queueStandingsRefresh(params: {
    leagueId: string;
    season: number;
    priority?: number;
    eventId?: string;
    triggerEventId?: string;
    scheduledFor?: Date;
  }): Promise<boolean> {
    const leagueId = this.normalizeLeagueId(params.leagueId);
    if (!leagueId || !Number.isInteger(params.season)) return false;
    const league =
      (await this.espnActiveCompetitionService.getByLeagueId(leagueId)) ??
      (await this.espnActiveCompetitionService.getBySlug(leagueId));
    if (!league || league.season !== params.season) return false;
    const triggerEventId =
      params.triggerEventId ??
      (params.eventId ? `FINISHED:${params.eventId}` : undefined);
    if (
      await this.espnQueueService.shouldSkipDuplicateAttempt({
        jobType: EspnQueueJobType.STANDINGS_REFRESH,
        leagueId,
        season: params.season,
        triggerEventId,
        terminalFailureCooldownMs: 60 * 60_000,
      })
    ) {
      return false;
    }
    const job = await this.espnQueueService.addStandingsRefreshJob({
      leagueId,
      season: params.season,
      priority:
        typeof params.priority === 'number'
          ? params.priority
          : this.getQueuePriority(league.priority),
      scheduledFor: params.scheduledFor ?? new Date(),
      triggerEventId,
    });
    return this.isPending(job);
  }

  /**
   * Daily, bounded validation of recently played fixtures. Each league-season
   * scans one rotating indexed page, then enqueues only data defects. Provider
   * calls remain in the durable worker; this method performs database reads and
   * queue writes only. No global timer or collection-wide scan is introduced.
   */
  async buildIntegrityRecoveryQueue(params?: {
    leagueId?: string;
    season?: number;
    maxQueued?: number;
  }): Promise<{ checked: number; queued: number; skipped: number }> {
    const requestedLeagueId = params?.leagueId
      ? this.normalizeLeagueId(params.leagueId)
      : undefined;
    const configuredBatch = SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.integrityRecoveryBatchSize;
    const batchSize = Math.max(1, Math.floor(configuredBatch));
    const maxQueued = Math.max(
      1,
      Math.floor(
        params?.maxQueued ??
          SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.integrityRecoveryMaxQueuedPerPass,
      ),
    );
    const activeLeagues = (
      await this.espnActiveCompetitionService.getActiveLeagues()
    )
      .filter(
        (league) =>
          league.isActive &&
          typeof league.season === 'number' &&
          league.fixturesCollectedSeason === league.season &&
          (typeof params?.season !== 'number' || league.season === params.season) &&
          (!requestedLeagueId ||
            [league.slug, league.leagueId].some(
              (id) => this.normalizeLeagueId(id || '') === requestedLeagueId,
            )),
      )
      .map((league) => ({
        league,
        leagueId: this.normalizeLeagueId(league.slug || league.leagueId),
        season: league.season as number,
        priority: this.getQueuePriority(league.priority),
      }))
      .filter((entry) => Boolean(entry.leagueId));

    if (activeLeagues.length === 0) return { checked: 0, queued: 0, skipped: 0 };

    const now = new Date();
    const dayMs = 24 * 60 * 60_000;
    const elapsedLookbackDays = Math.max(
      1,
      SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.integrityRecoveryLookbackDays,
    );
    const lookbackStart = new Date(now.getTime() - elapsedLookbackDays * dayMs);
    const matureKickoffCutoff = new Date(now.getTime() - this.postMatchDelayMs);
    const epochDay = Math.floor(now.getTime() / dayMs);

    // Rotate league order and the page within each league so a large backlog
    // cannot permanently starve lower-priority or older records.
    if (!requestedLeagueId && activeLeagues.length > 1) {
      const rotation = epochDay % activeLeagues.length;
      activeLeagues.push(...activeLeagues.splice(0, rotation));
    }

    let checked = 0;
    let queued = 0;
    let skipped = 0;

    for (const active of activeLeagues) {
      if (queued >= maxQueued) break;
      const filter = {
        leagueId: active.leagueId,
        season: active.season,
        fixtureDate: { $gte: lookbackStart, $lte: now },
      };
      const total = await this.espnFixtureModel.countDocuments(filter).exec();
      if (total <= 0) continue;

      const pageCount = Math.max(1, Math.ceil(total / batchSize));
      const pageIndex = epochDay % pageCount;
      const fixtures = await this.espnFixtureModel
        .find(filter)
        .sort({ fixtureDate: 1 })
        .skip(pageIndex * batchSize)
        .limit(batchSize)
        .select({
          eventId: 1,
          leagueId: 1,
          season: 1,
          fixtureDate: 1,
          completed: 1,
          live: 1,
          status: 1,
          statusDetail: 1,
          statusShortDetail: 1,
          homeScore: 1,
          awayScore: 1,
          'payload.summary': 1,
          'payload.summaryCollectedAt': 1,
        })
        .lean()
        .exec();

      for (const raw of fixtures) {
        if (queued >= maxQueued) break;
        checked += 1;
        const fixture = raw as unknown as QueueFixture;
        const eventId = String(fixture.eventId ?? '').trim();
        const fixtureDate = this.asValidDate(fixture.fixtureDate);
        if (!eventId || !fixtureDate || fixture.live === true) {
          skipped += 1;
          continue;
        }

        const statusText = [
          fixture.status,
          fixture.statusDetail,
          fixture.statusShortDetail,
        ].filter(Boolean).join(' ').toUpperCase();
        const primaryStatusText = String(fixture.status ?? '').toUpperCase();
        if (/(CANCEL|POSTPON|ABANDON|VOID)/.test(statusText)) {
          skipped += 1;
          continue;
        }

        const hasScores =
          typeof fixture.homeScore === 'number' && Number.isFinite(fixture.homeScore) &&
          typeof fixture.awayScore === 'number' && Number.isFinite(fixture.awayScore);
        const isResultVerified = fixture.completed === true && hasScores &&
          !/(SCHEDULED|UPCOMING|NOT[_ ]STARTED|STATUS_PRE|STATUS_SCHEDULED)/.test(primaryStatusText);
        const hasSummary = this.hasSummary(fixture.payload?.summary);
        const postMatchMature = fixtureDate.getTime() <= matureKickoffCutoff.getTime();
        const staleUpcomingStatus = postMatchMature &&
          /(SCHEDULED|UPCOMING|NOT[_ ]STARTED|STATUS_PRE|STATUS_SCHEDULED)/.test(primaryStatusText);
        const needsRecovery =
          (fixture.completed === true && (!hasSummary || !hasScores)) ||
          (postMatchMature && (!isResultVerified || !hasSummary || staleUpcomingStatus));

        if (!needsRecovery) continue;

        const activeSummaryJob = await this.espnQueueService.hasActiveSummaryRefreshForEvent({
          leagueId: active.leagueId,
          eventId,
          season: active.season,
        });
        if (activeSummaryJob) {
          skipped += 1;
          continue;
        }

        const triggerEventId = `INTEGRITY_RECOVERY:${this.getLagosDateKey(now)}:${eventId}`;
        if (await this.espnQueueService.hasJob({
          jobType: EspnQueueJobType.SUMMARY_REFRESH,
          leagueId: active.leagueId,
          eventId,
          season: active.season,
          triggerEventId,
        })) {
          skipped += 1;
          continue;
        }

        const job = await this.espnQueueService.addSummaryRefreshJob({
          leagueId: active.leagueId,
          eventId,
          season: active.season,
          priority: active.priority,
          scheduledFor: now,
          triggerEventId,
        });
        if (this.isPendingFresh(job)) queued += 1;
        else skipped += 1;
      }
    }

    return { checked, queued, skipped };
  }

  /**
   * After every successful Summary response, schedule the next configured
   * post-match checkpoint only while the canonical fixture still lacks a
   * verified final result. Targets are absolute offsets from kickoff, so slow
   * retries do not move the whole schedule and completed results stop recovery.
   */
  async scheduleNextPostMatchSummaryCheckpoint(params: {
    eventId: string;
    leagueId: string;
    season: number;
    priority?: number;
  }): Promise<boolean> {
    const eventId = String(params.eventId ?? '').trim();
    const leagueId = this.normalizeLeagueId(params.leagueId);
    if (!eventId || !leagueId || !Number.isInteger(params.season)) return false;

    const fixture = await this.espnFixtureModel
      .findOne({ eventId, leagueId, season: params.season })
      .select({
        fixtureDate: 1,
        completed: 1,
        live: 1,
        status: 1,
        statusDetail: 1,
        statusShortDetail: 1,
        homeScore: 1,
        awayScore: 1,
      })
      .lean()
      .exec();
    const kickoff = this.asValidDate(fixture?.fixtureDate);
    if (!fixture || !kickoff) return false;

    const nowMs = Date.now();
    const elapsedMs = nowMs - kickoff.getTime();
    if (elapsedMs < this.postMatchDelayMs || fixture.live === true) return false;

    const statusText = [fixture.status, fixture.statusDetail, fixture.statusShortDetail]
      .filter(Boolean).join(' ').toUpperCase();
    const primaryStatusText = String(fixture.status ?? '').toUpperCase();
    if (/(CANCEL|POSTPON|ABANDON|VOID)/.test(statusText)) return false;

    const hasScores =
      typeof fixture.homeScore === 'number' && Number.isFinite(fixture.homeScore) &&
      typeof fixture.awayScore === 'number' && Number.isFinite(fixture.awayScore);
    const hasVerifiedResult = fixture.completed === true && hasScores &&
      !/(SCHEDULED|UPCOMING|NOT[_ ]STARTED|STATUS_PRE|STATUS_SCHEDULED)/.test(primaryStatusText);
    if (hasVerifiedResult) return false;

    const checkpoints = SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary
      .postMatchRecoveryCheckpointsMinutes as readonly number[];
    const nextOffset = checkpoints.find((minutes) => minutes * 60_000 > elapsedMs);
    if (nextOffset === undefined) return false;

    const triggerEventId = `POSTMATCH_RECHECK:${eventId}:${nextOffset}`;
    if (await this.espnQueueService.hasJob({
      jobType: EspnQueueJobType.SUMMARY_REFRESH,
      leagueId,
      eventId,
      season: params.season,
      triggerEventId,
    })) return false;

    const scheduledFor = new Date(Math.max(
      nowMs,
      kickoff.getTime() + nextOffset * 60_000,
    ));
    const job = await this.espnQueueService.addSummaryRefreshJob({
      leagueId,
      eventId,
      season: params.season,
      priority: params.priority ?? 4,
      scheduledFor,
      triggerEventId,
    });
    return this.isPendingFresh(job);
  }

  async scheduleNextPostMatchCheck(params: {
    eventId: string;
    leagueId: string;
    season: number;
    priority: number;
    scheduledFor?: Date;
    recoveryGeneration?: number;
  }): Promise<void> {
    const eventId = String(params.eventId ?? '').trim();
    const leagueId = this.normalizeLeagueId(params.leagueId);
    if (!eventId || !leagueId || !Number.isInteger(params.season)) return;
    const scheduledFor =
      params.scheduledFor ?? new Date(Date.now() + this.postMatchRetryDelayMs);
    const trigger = `POSTMATCH_RECHECK:${eventId}${
      params.recoveryGeneration ? `:RECOVERY:${params.recoveryGeneration}` : ''
    }`;
    await this.espnQueueService.addFixtureRefreshJob({
      leagueId,
      season: params.season,
      priority: params.priority,
      scheduledFor,
      triggerEventId: trigger,
    });
  }

  async scheduleNextWindowExtension(params: {
    leagueId: string;
    season: number;
    priority: number;
  }): Promise<boolean> {
    const nextRun = this.nextLagosMidnight();
    const job = await this.espnQueueService.addFixtureRefreshJob({
      leagueId: params.leagueId,
      season: params.season,
      priority: params.priority,
      scheduledFor: nextRun,
      triggerEventId: `WINDOW_EXTEND:${this.getLagosDateKey(nextRun)}`,
    });
    return this.isPendingFresh(job);
  }

  async scheduleNextCatalogueRefresh(params?: {
    scheduledFor?: Date;
    triggerEventId?: string;
    sourceJobKey?: string;
  }): Promise<void> {
    const scheduledFor = params?.scheduledFor ?? this.addDays(new Date(), 7);
    await this.espnQueueService.addLeagueCatalogueRefreshJob({
      scheduledFor,
      priority: 1,
      // A retry of the same parent must converge on the same durable successor.
      triggerEventId:
        params?.triggerEventId ??
        (params?.sourceJobKey
          ? `CATALOGUE_NEXT:${params.sourceJobKey}`
          : `CATALOGUE_NEXT:${scheduledFor.toISOString()}`),
    });
  }

  async scheduleLeagueDetailRecovery(params: {
    leagueId: string;
    season?: number;
    priority: number;
    triggerEventId: string;
    delayMs?: number;
  }): Promise<void> {
    const leagueId = this.normalizeLeagueId(params.leagueId);
    if (!leagueId) return;
    await this.espnQueueService.addLeagueDetailRefreshJob({
      leagueId,
      season: params.season,
      priority: params.priority,
      scheduledFor: new Date(Date.now() + (params.delayMs ?? 60 * 60_000)),
      triggerEventId: params.triggerEventId,
    });
  }

  async scheduleNextLeagueDetailRefresh(
    leagueId: string,
    sourceJobKey?: string,
  ): Promise<void> {
    const league =
      (await this.espnActiveCompetitionService.getByLeagueId(leagueId)) ??
      (await this.espnActiveCompetitionService.getBySlug(leagueId));
    if (!league) return;
    const normalized = this.normalizeLeagueId(league.slug || league.leagueId);
    if (!normalized) return;
    const scheduledFor = this.nextLeagueDetailRefreshAt(league);
    await this.espnQueueService.addLeagueDetailRefreshJob({
      leagueId: normalized,
      season: typeof league.season === 'number' ? league.season : undefined,
      priority: this.getQueuePriority(league.priority),
      scheduledFor,
      // A retry of the same detail job reuses the same successor key even if
      // the service finishes a few minutes later on the retry.
      triggerEventId: `LEAGUE_DETAIL_NEXT:${sourceJobKey ?? scheduledFor.toISOString()}`,
    });
  }

  async queueAllLeagueDetails(): Promise<number> {
    const leagues = await this.espnActiveCompetitionService.getOrderedLeagues();
    let queued = 0;
    for (const league of leagues) {
      const leagueId = this.normalizeLeagueId(league.slug || league.leagueId);
      if (!leagueId) continue;
      const season =
        typeof league.season === 'number' ? league.season : undefined;
      if (
        await this.espnQueueService.hasScheduledJobForScope({
          jobType: EspnQueueJobType.LEAGUE_DETAIL_REFRESH,
          leagueId,
          season,
        })
      ) {
        continue;
      }
      const job = await (
        this.espnQueueService as unknown as {
          addLeagueDetailRefreshJob(params: {
            leagueId: string;
            season?: number;
            priority: number;
            scheduledFor: Date;
            triggerEventId: string;
          }): Promise<{ status?: unknown; attempts?: unknown }>;
        }
      ).addLeagueDetailRefreshJob({
        leagueId,
        season: typeof league.season === 'number' ? league.season : undefined,
        priority: this.getQueuePriority(league.priority),
        scheduledFor: new Date(),
        triggerEventId: `CATALOGUE_REFRESH:${this.getLagosDateKey()}`,
      });
      if (this.isPendingFresh(job)) queued += 1;
    }
    return queued;
  }

  getFixtureRefreshForwardDays(): number {
    return this.fixtureRefreshForwardDays;
  }

  getPostMatchRetryDelayMs(): number {
    return this.postMatchRetryDelayMs;
  }

  private nextLeagueDetailRefreshAt(league: {
    detailLastSyncedAt?: Date;
    season?: number;
    fixturesCollectedSeason?: number;
    fixtureCollectionAttemptSeason?: number;
    fixtureCollectionAttemptedAt?: Date;
    seasonStartDate?: Date;
    seasonEndDate?: Date;
  }): Date {
    const now = new Date();
    const start = this.asValidDate(league.seasonStartDate);
    const end = this.asValidDate(league.seasonEndDate);
    const nearBoundary = [start, end].some(
      (date) =>
        Boolean(date) &&
        date!.getTime() >= now.getTime() - 7 * 24 * 60 * 60 * 1000 &&
        date!.getTime() <= now.getTime() + 7 * 24 * 60 * 60 * 1000,
    );
    const ended = Boolean(
      end && this.getLagosDateKey(end) < this.getLagosDateKey(now),
    );
    const fixtureCatalogueMissing =
      typeof league.season === 'number' &&
      league.fixturesCollectedSeason !== league.season;
    const attemptAt = this.asValidDate(league.fixtureCollectionAttemptedAt);
    const attemptCooldownActive =
      fixtureCatalogueMissing &&
      league.fixtureCollectionAttemptSeason === league.season &&
      attemptAt &&
      now.getTime() - attemptAt.getTime() < 6 * 60 * 60 * 1000;
    const delay = fixtureCatalogueMissing
      ? attemptCooldownActive
        ? Math.max(
            60_000,
            6 * 60 * 60 * 1000 - (now.getTime() - attemptAt.getTime()),
          )
        : 60 * 60 * 1000
      : nearBoundary
        ? 6 * 60 * 60 * 1000
        : ended
          ? 24 * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000;
    const due = new Date(now.getTime() + delay);
    const lastSynced = this.asValidDate(league.detailLastSyncedAt);
    if (!lastSynced && !nearBoundary)
      return new Date(now.getTime() + 60 * 60 * 1000);
    return due;
  }

  private isSummaryFreshForUpcomingWindow(
    hasSummary: boolean,
    summaryCollectedAtValue: unknown,
    fixtureDate: Date,
  ): boolean {
    const summaryAt = this.asValidDate(summaryCollectedAtValue);
    if (!hasSummary || !summaryAt || !Number.isFinite(fixtureDate.getTime())) return false;
    // A startup Summary must be refreshed when the fixture enters the runtime
    // upcoming window, regardless of calendar date. The configured startup and
    // runtime horizons may overlap, so this is a source-freshness check rather
    // than a fixed calendar-day comparison.
    const runtimeWindowStart = fixtureDate.getTime() - this.upcomingWindowHours * 60 * 60_000;
    return summaryAt.getTime() >= runtimeWindowStart;
  }

  private isTodayNigerian(
    date: Date,
    todayStart: Date,
    tomorrowStart: Date,
  ): boolean {
    return (
      date.getTime() >= todayStart.getTime() &&
      date.getTime() < tomorrowStart.getTime()
    );
  }

  private hasSummary(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const knownSections = new Set([
      'header', 'event', 'competitions', 'boxscore', 'plays', 'leaders',
      'team', 'teams', 'rosters', 'roster', 'injuries', 'standings', 'odds',
      'pickcenter', 'news', 'videos', 'articles', 'gameInfo', 'format',
      'broadcasts', 'predictor', 'againstTheSpread', 'winprobability',
      'drives', 'scoringPlays', 'statistics', 'headToHead', 'venue',
      'weather', 'rankings', 'situation', 'commentary', 'recent', 'previews',
    ]);
    return Object.entries(record).some(([key, section]) => {
      if (!knownSections.has(key) || section === null || section === undefined) return false;
      if (Array.isArray(section)) return section.length > 0;
      if (typeof section === 'object') return Object.keys(section as Record<string, unknown>).length > 0;
      if (typeof section === 'string') return section.trim().length > 0;
      return typeof section === 'number' || typeof section === 'boolean';
    });
  }

  private asValidDate(value: unknown): Date | undefined {
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      !(value instanceof Date)
    ) {
      return undefined;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  private getLagosDateKey(date = new Date()): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Lagos',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const values = new Map(parts.map((part) => [part.type, part.value]));
    return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
  }

  private startOfLagosDay(date: Date): Date {
    return new Date(`${this.getLagosDateKey(date)}T00:00:00+01:00`);
  }

  private addLagosCalendarDays(date: Date, days: number): Date {
    const calendarDate = new Date(`${this.getLagosDateKey(date)}T00:00:00Z`);
    calendarDate.setUTCDate(calendarDate.getUTCDate() + days);
    return new Date(
      `${calendarDate.toISOString().slice(0, 10)}T00:00:00+01:00`,
    );
  }

  private nextLagosMidnight(): Date {
    const nextDay = this.addLagosCalendarDays(
      this.startOfLagosDay(new Date()),
      1,
    );
    return new Date(nextDay.getTime() + 5 * 60 * 1000);
  }

  private addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
  }

  private normalizeLeagueId(value: string): string {
    return String(value ?? '')
      .trim()
      .toLowerCase();
  }

  private getQueuePriority(
    priority?: CompetitionPriority | string | null,
  ): number {
    switch (priority) {
      case CompetitionPriority.ELITE:
        return 1;
      case CompetitionPriority.HIGH:
        return 2;
      case CompetitionPriority.REGIONAL:
        return 3;
      case CompetitionPriority.SELECTIVE:
      default:
        return 4;
    }
  }

  private isPending(job: { status?: unknown }): boolean {
    return ['PENDING', 'PROCESSING'].includes(String(job.status));
  }

  private isPendingFresh(job: {
    status?: unknown;
    attempts?: unknown;
  }): boolean {
    return String(job.status) === 'PENDING' && Number(job.attempts ?? 0) === 0;
  }
}

