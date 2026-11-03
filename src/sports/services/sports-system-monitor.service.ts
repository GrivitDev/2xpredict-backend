// backend/src/sports/services/sports-system-monitor.service.ts

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AdminGateway } from '../../realtime/admin.gateway';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

// ============================================================
// ACTIVE COMPETITION
// ============================================================

import {
  ActiveCompetition,
  ActiveCompetitionDocument,
} from '../schemas/active-competition.schema';

// ============================================================
// ESPN
// ============================================================

import {
  EspnLeague,
  EspnLeagueDocument,
} from '../schemas/espn/espn-league.schema';

import {
  EspnFixture,
  EspnFixtureDocument,
} from '../schemas/espn/espn-fixture.schema';

import {
  EspnStanding,
  EspnStandingDocument,
} from '../schemas/espn/espn-standing.schema';

import { EspnNews, EspnNewsDocument } from '../schemas/espn/espn-news.schema';

import { EspnTeam, EspnTeamDocument } from '../schemas/espn/espn-team.schema';

// ============================================================
// ESPN QUEUE
// ============================================================

import { EspnQueue, EspnQueueDocument } from '../schemas/espn-queue.schema';

import {
  EspnQueueJobType,
  EspnQueueStatus,
} from '../interfaces/espn-queue.interface';

// ============================================================
// SYNC STATE
// ============================================================

import {
  SportsSyncState,
  SportsSyncStateDocument,
  SportsSyncStateKind,
  SportsSyncStateStatus,
  SportsSyncUnitStatus,
} from '../schemas/sports-sync-state.schema';

// ============================================================
// PROVIDER RATE LIMIT
// ============================================================

import {
  SportsProviderRateLimit,
  SportsProviderRateLimitDocument,
} from '../schemas/sports-provider-rate-limit.schema';

import { SportsProviderRateLimitService } from './sports-provider-rate-limit.service';
import { EspnQueueWorkerService } from './espn-queue-worker.service';

import { SPORTS_DATA_COLLECTION_CONFIG } from '../config/sports-data-collection.config';

// ============================================================
// YOUTUBE
// ============================================================

import {
  YouTubeHighlight,
  YouTubeHighlightDocument,
} from '../schemas/youtube-highlight.schema';

// ============================================================
// FOOTBALL-DATA
// ============================================================

import {
  FootballDataCompetition,
  FootballDataCompetitionDocument,
} from '../schemas/football-data/football-data-competition.schema';

import {
  FootballDataMatch,
  FootballDataMatchDocument,
} from '../schemas/football-data/football-data-match.schema';

import {
  FootballDataStanding,
  FootballDataStandingDocument,
} from '../schemas/football-data/football-data-standing.schema';

import {
  FootballDataTeam,
  FootballDataTeamDocument,
} from '../schemas/football-data/football-data-team.schema';

// ============================================================
// ODDS API
// ============================================================

import {
  OddsApiSport,
  OddsApiSportDocument,
} from '../schemas/odds-api-sport.schema';

import {
  SportsOddsSnapshot,
  SportsOddsSnapshotDocument,
} from '../schemas/sports-odds-snapshot.schema';

// ============================================================
// MONITOR INTERFACES
// ============================================================

import {
  MonitorExpectedWork,
  MonitorInventory,
  MonitorLeagueSummary,
  MonitorPipelineDefinition,
  MonitorProviderSummary,
  MonitorQueueItem,
  MonitorQueueSummary,
  MonitorSyncFailure,
  MonitorSyncStageSummary,
  MonitorSyncStateDetail,
  MonitorSyncSummary,
  MonitorUpcomingFixture,
  MonitorUpcomingSummary,
  SportsSystemMonitorQuery,
  SportsSystemMonitorResponse,
  SportsRuntimeMonitor,
  SportsMonitorAlert,
  SportsMonitorHealthStatus,
} from '../interfaces/sports-system-monitor.interface';

// ============================================================
// INTERNAL TYPES
// ============================================================

interface LeagueContext {
  competition: ActiveCompetitionDocument;
  key: string;
  aliases: string[];
  season?: number;
}

interface FixtureAggregate {
  total: number;
  upcoming: number;
  live: number;
  finished: number;
  finishedWithSummary: number;
  withSummary: number;
  missingSummary: number;
  finishedMissingSummary: number;
  postMatchMissingFinalResult: number;
  staleUpcomingStatus: number;
  summaryCoveragePercent: number;
  latestCollectedAt?: Date;
  latestSummaryCollectedAt?: Date;
  storedSeasons: number;
}

interface TeamAggregate {
  documents: number;
  teamIds: Set<string>;
  latestCollectedAt?: Date;
}

interface StandingAggregate {
  rows: number;
  teamIds: Set<string>;
  latestCollectedAt?: Date;
}

interface NewsAggregate {
  total: number;
  last24Hours: number;
  latestPublishedAt?: Date;
  latestCollectedAt?: Date;
}

interface QueueAggregate {
  total: number;
  byStatus: Map<string, number>;
  byType: Map<string, number>;
  byTypeAndStatus: Map<string, number>;
  staleProcessing: number;
  latestFailureAt?: Date;
  latestFailure?: string;
  latestCompletedAt?: Date;
}

interface SyncAggregate {
  stateCounts: Record<string, number>;
  queueStates: number;
  cronStates: number;

  unitProgress: {
    total: number;
    monthUnits: number;
    success: number;
    processing: number;
    pending: number;
    failed: number;
  };

  currentStages: MonitorSyncStageSummary[];
  failures: MonitorSyncFailure[];
  cron: SportsSystemMonitorResponse['sync']['cron'];
  states: MonitorSyncStateDetail[];

  latestSuccessfulAt?: Date;
  latestCompletedAt?: Date;
  nextRunAt?: Date;
}

interface OperationalSeasonData {
  fixtures: Map<string, FixtureAggregate>;
  expectedTeams: Map<string, Set<string>>;
}

interface UpcomingIndexes {
  summaries: Set<string>;
  odds: Set<string>;
}

interface ProviderConfig {
  minIntervalSeconds: number;
  dailyRequestLimit: number | null;
  monthlyRequestLimit: number | null;
}

interface ProviderStatePeriods {
  dailyPeriod?: Date | string;
  monthlyPeriod?: Date | string;
}

// ============================================================
// CONSTANTS
// ============================================================

const COMPLETED_STATUSES = new Set([
  'FT',
  'AET',
  'PEN',
  'FINAL',
  'FINISHED',
  'COMPLETED',
  'POST',
  'STATUS_FINAL',
]);

const QUEUE_COMPLETED_RETENTION_DAYS = 7;

const STALE_PROCESSING_MINUTES =
  SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.leaseMinutes;

const UPCOMING_WINDOW_HOURS =
  SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.upcomingWindowHours;

const STALE_ACTIVE_LEAGUE_HOURS = 48;

type ConfiguredSportsProvider = Parameters<
  SportsProviderRateLimitService['getDailyUsage']
>[0];

const PROVIDER_CONFIG: Record<ConfiguredSportsProvider, ProviderConfig> = {
  espn: {
    minIntervalSeconds:
      SPORTS_DATA_COLLECTION_CONFIG.ESPN.rateLimit.minIntervalSeconds,
    dailyRequestLimit: null,
    monthlyRequestLimit: null,
  },

  'football-data': {
    minIntervalSeconds: 60,
    dailyRequestLimit: null,
    monthlyRequestLimit: null,
  },

  'odds-api': {
    minIntervalSeconds: 60,
    dailyRequestLimit: null,
    monthlyRequestLimit: 450,
  },

  youtube: {
    minIntervalSeconds: 200,
    dailyRequestLimit: 90,
    monthlyRequestLimit: null,
  },
};

// ============================================================
// SERVICE
// ============================================================

type MonitorSyncUnitRecord = {
  key: string;
  type: string;
  monthKey?: string;
  dateKey?: string;
  stepKey?: string;
  status: SportsSyncUnitStatus;
  startedAt?: Date;
  completedAt?: Date;
};

type MonitorSyncStateRecord = {
  stateKey: string;
  kind: SportsSyncStateKind;
  jobType?: string;
  taskKey?: string;
  cronExpression?: string;
  timeZone?: string;
  leagueId?: string;
  season?: number;
  eventId?: string;
  status: SportsSyncStateStatus;
  trackingMode?: string;
  fixtureGranularity?: string;
  dateFrom?: string;
  dateTo?: string;
  lastStartedAt?: Date;
  lastSuccessfulAt?: Date;
  lastCompletedAt?: Date;
  nextRunAt?: Date;
  consecutiveFailures?: number;
  lastError?: string;
  updatedAt?: Date;
  units: MonitorSyncUnitRecord[];
};

@Injectable()
export class SportsSystemMonitorService implements OnModuleInit {
  private readonly logger = new Logger(SportsSystemMonitorService.name);
  private readonly monitorCache = new Map<
    string,
    { cachedAt: number; data: SportsSystemMonitorResponse }
  >();
  private readonly monitorRefreshes = new Map<string, Promise<void>>();
  private readonly monitorRefreshErrors = new Map<string, string>();
  private readonly monitorCacheTtlMs = 5 * 60_000;

  constructor(
    // ----------------------------------------------------------
    // ACTIVE COMPETITIONS
    // ----------------------------------------------------------

    @InjectModel(ActiveCompetition.name)
    private readonly activeCompetitionModel: Model<ActiveCompetitionDocument>,

    // ----------------------------------------------------------
    // ESPN
    // ----------------------------------------------------------

    @InjectModel(EspnLeague.name)
    private readonly espnLeagueModel: Model<EspnLeagueDocument>,

    @InjectModel(EspnFixture.name)
    private readonly espnFixtureModel: Model<EspnFixtureDocument>,

    @InjectModel(EspnTeam.name)
    private readonly espnTeamModel: Model<EspnTeamDocument>,

    @InjectModel(EspnStanding.name)
    private readonly espnStandingModel: Model<EspnStandingDocument>,

    @InjectModel(EspnNews.name)
    private readonly espnNewsModel: Model<EspnNewsDocument>,

    // ----------------------------------------------------------
    // QUEUE
    // ----------------------------------------------------------

    @InjectModel(EspnQueue.name)
    private readonly espnQueueModel: Model<EspnQueueDocument>,

    // ----------------------------------------------------------
    // SYNC STATE
    // ----------------------------------------------------------

    @InjectModel(SportsSyncState.name)
    private readonly sportsSyncStateModel: Model<SportsSyncStateDocument>,

    // ----------------------------------------------------------
    // RATE LIMIT
    // ----------------------------------------------------------

    @InjectModel(SportsProviderRateLimit.name)
    private readonly sportsProviderRateLimitModel: Model<SportsProviderRateLimitDocument>,

    private readonly providerRateLimitService: SportsProviderRateLimitService,

    // ----------------------------------------------------------
    // YOUTUBE
    // ----------------------------------------------------------

    @InjectModel(YouTubeHighlight.name)
    private readonly youtubeHighlightModel: Model<YouTubeHighlightDocument>,

    // ----------------------------------------------------------
    // FOOTBALL-DATA
    // ----------------------------------------------------------

    @InjectModel(FootballDataCompetition.name)
    private readonly footballDataCompetitionModel: Model<FootballDataCompetitionDocument>,

    @InjectModel(FootballDataMatch.name)
    private readonly footballDataMatchModel: Model<FootballDataMatchDocument>,

    @InjectModel(FootballDataStanding.name)
    private readonly footballDataStandingModel: Model<FootballDataStandingDocument>,

    @InjectModel(FootballDataTeam.name)
    private readonly footballDataTeamModel: Model<FootballDataTeamDocument>,

    // ----------------------------------------------------------
    // ODDS
    // ----------------------------------------------------------

    @InjectModel(OddsApiSport.name)
    private readonly oddsApiSportModel: Model<OddsApiSportDocument>,

    @InjectModel(SportsOddsSnapshot.name)
    private readonly sportsOddsSnapshotModel: Model<SportsOddsSnapshotDocument>,
    private readonly adminGateway: AdminGateway,
    private readonly espnQueueWorker: EspnQueueWorkerService,
  ) {}

  onModuleInit(): void {
    this.adminGateway.registerModule('sports', {
      message:
        'Sports monitor initialized; queue, collection and provider snapshots are streamed to admin clients.',
      operationalStatus: 'UNKNOWN',
    });
  }

  // ============================================================
  // PUBLIC
  // ============================================================

  getSystemMonitor(
    query: SportsSystemMonitorQuery = {},
  ): SportsSystemMonitorResponse {
    const cacheKey = this.getMonitorCacheKey(query);
    const cached = this.monitorCache.get(cacheKey);
    const cacheAge = cached
      ? Date.now() - cached.cachedAt
      : Number.POSITIVE_INFINITY;

    const previousError = this.monitorRefreshErrors.get(cacheKey);
    const shouldStartRefresh =
      query.forceRefresh ||
      (cached
        ? cacheAge >= this.monitorCacheTtlMs && !previousError
        : !previousError);

    if (shouldStartRefresh) {
      this.startMonitorRefresh(cacheKey, query);
    }

    if (cached) {
      return this.attachRuntimeHealth({
        ...cached.data,
        snapshotReady: true,
        refreshing: this.monitorRefreshes.has(cacheKey),
        snapshotError: this.monitorRefreshErrors.get(cacheKey),
      });
    }

    return this.attachRuntimeHealth(
      this.createLoadingSnapshot(
        query,
        this.monitorRefreshErrors.get(cacheKey),
        this.monitorRefreshes.has(cacheKey),
      ),
    );
  }

  private attachRuntimeHealth(
    snapshot: SportsSystemMonitorResponse,
  ): SportsSystemMonitorResponse {
    const checkedAt = new Date().toISOString();
    const worker = this.espnQueueWorker.getMonitorRuntimeStatus();
    const alerts: SportsMonitorAlert[] = [];
    const addAlert = (
      code: string,
      severity: SportsMonitorAlert['severity'],
      message: string,
      details?: Record<string, unknown>,
    ) => {
      alerts.push({
        code,
        severity,
        message,
        occurredAt: checkedAt,
        ...(details ? { details } : {}),
      });
    };

    if (snapshot.snapshotError)
      addAlert(
        'MONITOR_SNAPSHOT_FAILED',
        'CRITICAL',
        'The sports monitor could not build its database snapshot.',
        { error: snapshot.snapshotError },
      );
    if (worker.queueReadFailures >= 3)
      addAlert(
        'QUEUE_READ_FAILURES',
        'CRITICAL',
        'The ESPN worker has repeated failures reading its next queue wake-up.',
        { consecutiveFailures: worker.queueReadFailures },
      );
    else if (worker.queueReadFailures > 0)
      addAlert(
        'QUEUE_READ_FAILURES',
        'WARNING',
        'The ESPN worker has a queue-read failure and is retrying.',
        { consecutiveFailures: worker.queueReadFailures },
      );
    if (worker.lastWatchdogError)
      addAlert(
        'QUEUE_WATCHDOG_FAILED',
        'WARNING',
        'The last ESPN queue watchdog check failed.',
        { error: worker.lastWatchdogError },
      );
    if (worker.draining && (worker.activeJobAgeMs ?? 0) > 10 * 60_000)
      addAlert(
        'QUEUE_JOB_LONG_RUNNING',
        'WARNING',
        'An ESPN queue job has been running for more than ten minutes.',
        {
          jobKey: worker.activeJobKey,
          jobType: worker.activeJobType,
          activeJobAgeMs: worker.activeJobAgeMs,
        },
      );
    if (snapshot.queue.staleProcessing > 0)
      addAlert(
        'STALE_PROCESSING_JOBS',
        'CRITICAL',
        'One or more ESPN queue jobs have remained in PROCESSING beyond the stale-job threshold.',
        { count: snapshot.queue.staleProcessing },
      );
    if (snapshot.queue.retryLaneJobs > 100)
      addAlert(
        'BACKGROUND_RETRY_BACKLOG',
        'WARNING',
        'The background retry lane has accumulated a large recovery backlog.',
        { retryJobs: snapshot.queue.retryLaneJobs },
      );
    if (snapshot.queue.quarantinedJobs > 0)
      addAlert(
        'QUEUE_QUARANTINE',
        'WARNING',
        'Some jobs require configuration or data correction and were quarantined rather than replayed indefinitely.',
        { quarantinedJobs: snapshot.queue.quarantinedJobs },
      );
    if (
      snapshot.queue.oldestRetryFailedAt &&
      Date.now() - new Date(snapshot.queue.oldestRetryFailedAt).getTime() >
        24 * 60 * 60_000
    )
      addAlert(
        'BACKGROUND_RETRY_AGE',
        'WARNING',
        'At least one recoverable job has remained unresolved for more than 24 hours and is continuing its scheduled background retries.',
        {
          oldestRetryFailedAt: snapshot.queue.oldestRetryFailedAt,
          retryJobs: snapshot.queue.retryLaneJobs,
        },
      );
    for (const provider of snapshot.providers) {
      if (
        provider.usage.remainingDailyRequests === 0 ||
        provider.usage.remainingMonthlyRequests === 0
      )
        addAlert(
          'PROVIDER_QUOTA_EXHAUSTED',
          'WARNING',
          `${provider.provider} has exhausted a configured provider request allowance.`,
          {
            provider: provider.provider,
            remainingDailyRequests: provider.usage.remainingDailyRequests,
            remainingMonthlyRequests: provider.usage.remainingMonthlyRequests,
          },
        );
      if (provider.usage.activeLocks > 0)
        addAlert(
          'PROVIDER_ENDPOINT_LOCKED',
          'INFO',
          `${provider.provider} has one or more endpoint rate-limit locks active.`,
          {
            provider: provider.provider,
            activeLocks: provider.usage.activeLocks,
          },
        );
    }
    if (snapshot.sync.failures.length > 0)
      addAlert(
        'SYNC_STATE_FAILURES',
        'WARNING',
        'The sports sync ledger contains recent or unresolved failed operations.',
        {
          count: snapshot.sync.failures.length,
          failures: snapshot.sync.failures.slice(0, 5) as unknown as Record<
            string,
            unknown
          >,
        },
      );
    if (snapshot.expectedWork.staleActiveLeagues > 0)
      addAlert(
        'STALE_ACTIVE_COMPETITIONS',
        'WARNING',
        'Some active competitions have stale fixture collection.',
        { count: snapshot.expectedWork.staleActiveLeagues },
      );
    if (snapshot.expectedWork.upcomingFixturesMissingSummary > 0)
      addAlert(
        'UPCOMING_SUMMARIES_MISSING',
        'WARNING',
        'Upcoming fixtures inside the Summary window are missing summary payloads.',
        { count: snapshot.expectedWork.upcomingFixturesMissingSummary },
      );
    if (snapshot.expectedWork.upcomingFixturesMissingOdds > 0)
      addAlert(
        'UPCOMING_ODDS_MISSING',
        'WARNING',
        'Upcoming fixtures with Odds API support do not have a matching odds snapshot.',
        { count: snapshot.expectedWork.upcomingFixturesMissingOdds },
      );
    if (snapshot.expectedWork.postMatchFixturesMissingFinalResult > 0)
      addAlert(
        'POSTMATCH_RESULTS_MISSING',
        'WARNING',
        'Fixtures past the post-match checkpoint still lack a verified final result and both scores.',
        { count: snapshot.expectedWork.postMatchFixturesMissingFinalResult },
      );
    if (snapshot.expectedWork.staleUpcomingStatusFixtures > 0)
      addAlert(
        'STALE_UPCOMING_FIXTURE_STATUS',
        'WARNING',
        'Fixtures past the post-match checkpoint still have a scheduled/upcoming root status.',
        { count: snapshot.expectedWork.staleUpcomingStatusFixtures },
      );

    const components: SportsRuntimeMonitor['components'] = {
      ESPN_QUEUE: {
        status:
          worker.queueReadFailures >= 3 || snapshot.queue.staleProcessing > 0
            ? 'CRITICAL'
            : worker.lastWatchdogError ||
                snapshot.queue.quarantinedJobs > 0 ||
                snapshot.queue.retryLaneJobs > 100
              ? 'DEGRADED'
              : worker.started
                ? 'HEALTHY'
                : 'UNKNOWN',
        message: worker.started
          ? `Queue is active with ${worker.normalJobsActive ?? 0} normal and ${worker.retryJobsActive ?? 0} recovery jobs executing.`
          : worker.waitingForStartupRelease
            ? 'Worker is initialized and waiting for startup release.'
            : 'Worker is not currently running.',
        metrics: {
          pending: snapshot.queue.pending,
          processing: snapshot.queue.processing,
          failed: snapshot.queue.failed,
          retryLaneJobs: snapshot.queue.retryLaneJobs,
          quarantinedJobs: snapshot.queue.quarantinedJobs,
          oldestRetryFailedAt: snapshot.queue.oldestRetryFailedAt ?? null,
          staleProcessing: snapshot.queue.staleProcessing,
          activeJobs: worker.activeJobCount ?? 0,
          normalJobsActive: worker.normalJobsActive ?? 0,
          retryJobsActive: worker.retryJobsActive ?? 0,
          jobsSucceeded: worker.jobsSucceeded,
          jobsFailed: worker.jobsFailed,
        },
      },
      ESPN_FIXTURES: {
        status:
          snapshot.expectedWork.staleActiveLeagues > 0 ||
          snapshot.expectedWork.postMatchFixturesMissingFinalResult > 0 ||
          snapshot.expectedWork.staleUpcomingStatusFixtures > 0
            ? 'DEGRADED'
            : 'HEALTHY',
        message:
          snapshot.expectedWork.postMatchFixturesMissingFinalResult > 0 ||
          snapshot.expectedWork.staleUpcomingStatusFixtures > 0
            ? 'Fixture coverage has unresolved post-match results or stale upcoming statuses.'
            : snapshot.expectedWork.staleActiveLeagues > 0
              ? 'Some active competition fixture collections are stale.'
              : 'Fixture inventory, post-match results and active competition freshness checks completed.',
        metrics: {
          storedFixtures: snapshot.inventory.espnFixtures,
          staleActiveLeagues: snapshot.expectedWork.staleActiveLeagues,
          postMatchMissingFinalResult:
            snapshot.expectedWork.postMatchFixturesMissingFinalResult,
          staleUpcomingStatus:
            snapshot.expectedWork.staleUpcomingStatusFixtures,
        },
      },
      ESPN_SUMMARY: {
        status:
          snapshot.expectedWork.upcomingFixturesMissingSummary > 0 ||
          snapshot.expectedWork.finishedFixturesMissingSummary > 0
            ? 'DEGRADED'
            : 'HEALTHY',
        message:
          'Summary readiness is derived from fixture payload coverage and sync-state progress.',
        metrics: {
          upcomingMissing: snapshot.expectedWork.upcomingFixturesMissingSummary,
          finishedMissing: snapshot.expectedWork.finishedFixturesMissingSummary,
        },
      },
      ESPN_STANDINGS: {
        status:
          snapshot.expectedWork.standingsMissingTeams > 0
            ? 'DEGRADED'
            : 'HEALTHY',
        message:
          'Standings coverage is measured against teams found in current-season fixtures; some competitions may not require standings.',
        metrics: {
          missingTeams: snapshot.expectedWork.standingsMissingTeams,
          storedRows: snapshot.inventory.espnStandings,
        },
      },
      YOUTUBE: {
        status:
          snapshot.providers.find((p) => p.provider === 'youtube')?.usage
            .remainingDailyRequests === 0
            ? 'DEGRADED'
            : 'HEALTHY',
        message:
          'YouTube queue and provider quota telemetry are available in the queue/provider sections.',
        metrics: {
          storedHighlights: snapshot.inventory.youtubeHighlights,
          pendingJobs: snapshot.queue.byType['YOUTUBE_HIGHLIGHT'] ?? 0,
          remainingDailyRequests:
            snapshot.providers.find((p) => p.provider === 'youtube')?.usage
              .remainingDailyRequests ?? null,
        },
      },
      FOOTBALL_DATA: {
        status: 'UNKNOWN',
        message:
          'Football-Data integration is disabled by current collection configuration; inventory is retained for visibility.',
        metrics: {
          enabled: SPORTS_DATA_COLLECTION_CONFIG.FOOTBALL_DATA.enabled,
          storedMatches: snapshot.inventory.footballDataMatches,
        },
      },
      ODDS_API: {
        status:
          snapshot.expectedWork.upcomingFixturesMissingOdds > 0
            ? 'DEGRADED'
            : 'HEALTHY',
        message:
          'Odds availability is checked against exact stored event IDs for competitions with configured Odds API mappings.',
        metrics: {
          storedOddsSnapshots: snapshot.inventory.sportsOddsSnapshots,
          missingUpcomingOdds:
            snapshot.expectedWork.upcomingFixturesMissingOdds,
        },
      },
      ACTIVE_COMPETITIONS: {
        status: snapshot.scope.activeCompetitions > 0 ? 'HEALTHY' : 'DEGRADED',
        message:
          snapshot.scope.activeCompetitions > 0
            ? 'Active competition registry is populated.'
            : 'No active competitions are available to the monitor.',
        metrics: {
          active: snapshot.scope.activeCompetitions,
          catalogue: snapshot.scope.catalogueCompetitions,
        },
      },
      SYNC_LEDGER: {
        status: snapshot.sync.failures.length > 0 ? 'DEGRADED' : 'HEALTHY',
        message:
          'Sync health is based on persisted queue/cron states and their unit progress.',
        metrics: {
          states: snapshot.sync.totalStates,
          failures: snapshot.sync.failures.length,
          completionPercent: snapshot.sync.stateCompletionPercent,
        },
      },
    };

    const critical = alerts.some((a) => a.severity === 'CRITICAL');
    const warning =
      alerts.some((a) => a.severity === 'WARNING') ||
      Object.values(components).some((c) => c.status === 'DEGRADED');
    const status: SportsMonitorHealthStatus = critical
      ? 'CRITICAL'
      : warning
        ? 'DEGRADED'
        : snapshot.snapshotReady === false
          ? 'UNKNOWN'
          : 'HEALTHY';
    return {
      ...snapshot,
      health: { status, checkedAt, worker, components, alerts },
    };
  }

  private getMonitorCacheKey(query: SportsSystemMonitorQuery): string {
    return this.normalize(query.leagueId) || '__all_competitions__';
  }

  private startMonitorRefresh(
    cacheKey: string,
    query: SportsSystemMonitorQuery,
  ): void {
    if (this.monitorRefreshes.has(cacheKey)) return;

    this.monitorRefreshErrors.delete(cacheKey);
    const refresh = this.buildSystemMonitorSnapshot(
      { leagueId: query.leagueId },
      (partialSnapshot) => {
        // Publish operational queue/provider/sync state as soon as that light
        // phase is ready; historical fixture coverage keeps calculating below.
        this.monitorCache.set(cacheKey, {
          cachedAt: Date.now(),
          data: {
            ...partialSnapshot,
            snapshotReady: true,
            snapshotPartial: true,
            refreshing: true,
          },
        });
        this.adminGateway.publishModuleEvent(
          'sports',
          'sports:monitor-update',
          {
            leagueId: query.leagueId ?? null,
            snapshotReady: true,
            snapshotPartial: true,
            refreshing: true,
            occurredAt: new Date().toISOString(),
          },
        );
      },
    )
      .then((snapshot) => {
        this.monitorCache.set(cacheKey, {
          cachedAt: Date.now(),
          data: {
            ...snapshot,
            snapshotReady: true,
            snapshotPartial: false,
            refreshing: false,
          },
        });
        this.adminGateway.setModuleOperationalStatus(
          'sports',
          'READY',
          'Sports monitor snapshot refreshed successfully.',
        );
        this.adminGateway.publishModuleEvent(
          'sports',
          'sports:monitor-update',
          {
            leagueId: query.leagueId ?? null,
            snapshotReady: true,
            snapshotPartial: false,
            refreshing: false,
            occurredAt: new Date().toISOString(),
          },
        );
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error
            ? error.message
            : 'Unable to build the sports system monitor snapshot.';
        this.monitorRefreshErrors.set(cacheKey, message);
        this.adminGateway.setModuleOperationalStatus(
          'sports',
          'DEGRADED',
          message,
          { leagueId: query.leagueId ?? null },
        );
        this.adminGateway.publishModuleEvent('sports', 'sports:error', {
          leagueId: query.leagueId ?? null,
          message,
          occurredAt: new Date().toISOString(),
        });
        this.logger.error(
          `Sports system monitor refresh failed for ${cacheKey}: ${message}`,
          error instanceof Error ? error.stack : undefined,
        );
      })
      .finally(() => {
        this.monitorRefreshes.delete(cacheKey);
      });

    this.monitorRefreshes.set(cacheKey, refresh);
  }

  private createLoadingSnapshot(
    query: SportsSystemMonitorQuery,
    snapshotError?: string,
    refreshing = false,
  ): SportsSystemMonitorResponse {
    return {
      generatedAt: new Date().toISOString(),
      snapshotReady: false,
      refreshing,
      snapshotError,
      scope: {
        activeLeagueFilter: query.leagueId
          ? this.normalize(query.leagueId)
          : undefined,
        activeCompetitions: 0,
        catalogueCompetitions: 0,
        operationalSeasonScope: true,
      },
      inventory: {
        activeCompetitions: 0,
        espnCatalogue: 0,
        espnFixtures: 0,
        espnTeams: 0,
        espnStandings: 0,
        espnNews: 0,
        espnQueue: 0,
        sportsSyncStates: 0,
        footballDataCompetitions: 0,
        footballDataMatches: 0,
        footballDataStandings: 0,
        footballDataTeams: 0,
        oddsApiSports: 0,
        sportsOddsSnapshots: 0,
        youtubeHighlights: 0,
      },
      queue: {
        total: 0,
        pending: 0,
        processing: 0,
        completedRetained: 0,
        failed: 0,
        retryLaneJobs: 0,
        quarantinedJobs: 0,
        staleProcessing: 0,
        completedRetentionDays: QUEUE_COMPLETED_RETENTION_DAYS,
        byType: {},
        byTypeAndStatus: [],
      },
      sync: {
        totalStates: 0,
        queueStates: 0,
        cronStates: 0,
        byStatus: {},
        unitProgress: {
          total: 0,
          success: 0,
          processing: 0,
          pending: 0,
          failed: 0,
          completionPercent: 0,
        },
        stateCompletionPercent: 0,
        currentStages: [],
        failures: [],
        cron: [],
        states: [],
      },
      pipeline: {},
      providers: [],
      expectedWork: this.emptyExpectedWork(),
      leagues: [],
      architectureNotes: this.getArchitectureNotes(),
    };
  }

  private async buildSystemMonitorSnapshot(
    query: SportsSystemMonitorQuery = {},
    onPartialSnapshot?: (snapshot: SportsSystemMonitorResponse) => void,
  ): Promise<SportsSystemMonitorResponse> {
    const now = new Date();

    const [activeCompetitions, catalogue] = await Promise.all([
      this.getActiveCompetitions(query),
      this.espnLeagueModel
        .find({})
        .select({
          leagueId: 1,
          slug: 1,
          name: 1,
          country: 1,
          isActive: 1,
          isPriority: 1,
          lastSyncedAt: 1,
          detailLastSyncedAt: 1,
        })
        .lean()
        .exec(),
    ]);

    const catalogueById = new Map<string, EspnLeagueDocument>();

    for (const league of catalogue) {
      const leagueId = this.normalize(league.leagueId);
      const slug = this.normalize(league.slug);

      if (leagueId) {
        catalogueById.set(leagueId, league);
      }

      if (slug) {
        catalogueById.set(slug, league);
      }
    }

    const contexts: LeagueContext[] = activeCompetitions.map((competition) => ({
      competition,
      key: this.normalize(competition.competitionId),

      aliases: [
        ...new Set(
          [competition.competitionId, competition.espnLeagueSlug]
            .map((value) => this.normalize(value))
            .filter(Boolean),
        ),
      ],

      season:
        typeof competition.season === 'number' ? competition.season : undefined,
    }));

    const [inventory, queue, syncStates, providers] = await Promise.all([
      this.buildInventory(),
      this.buildQueueSummary(),
      this.loadSyncStateSnapshot(),
      this.buildProviderSummaries(),
    ]);
    const sync = this.buildSyncSummary(contexts, now, syncStates);

    const pipeline = this.buildPipelineDefinitions(sync);

    if (contexts.length && onPartialSnapshot) {
      const emptyOperationalSeasonData: OperationalSeasonData = {
        fixtures: new Map<string, FixtureAggregate>(),
        expectedTeams: new Map<string, Set<string>>(),
      };
      const emptyTeamAggregates = new Map<string, TeamAggregate>();
      const emptyStandingAggregates = new Map<string, StandingAggregate>();
      const emptyNewsAggregates = new Map<string, NewsAggregate>();
      const emptyQueueAggregates = new Map<string, QueueAggregate>();
      const emptySyncAggregates = new Map<string, SyncAggregate>();
      const emptyUpcomingIndexes: UpcomingIndexes = {
        summaries: new Set<string>(),
        odds: new Set<string>(),
      };

      const partialLeagues = contexts.map((context) => ({
        ...this.buildLeagueSummary({
          context,
          catalogueById,
          operationalSeasonData: emptyOperationalSeasonData,
          teamAggregates: emptyTeamAggregates,
          standingAggregates: emptyStandingAggregates,
          newsAggregates: emptyNewsAggregates,
          queueAggregates: emptyQueueAggregates,
          syncAggregates: emptySyncAggregates,
          upcomingFixtures: [],
          upcomingIndexes: emptyUpcomingIndexes,
        }),
        // Do not report uncomputed work as confirmed missing work.
        expectedWork: this.emptyExpectedWork(),
      }));

      onPartialSnapshot({
        generatedAt: this.toIso(now) as string,
        snapshotReady: true,
        snapshotPartial: true,
        refreshing: true,
        scope: {
          activeLeagueFilter: query.leagueId
            ? this.normalize(query.leagueId)
            : undefined,
          activeCompetitions: activeCompetitions.length,
          catalogueCompetitions: catalogue.length,
          operationalSeasonScope: true,
        },
        inventory,
        queue,
        sync,
        pipeline,
        providers,
        expectedWork: this.emptyExpectedWork(),
        leagues: partialLeagues,
        architectureNotes: this.getArchitectureNotes(),
      });
    }

    if (!contexts.length) {
      return {
        generatedAt: this.toIso(now) as string,

        scope: {
          activeLeagueFilter: query.leagueId
            ? this.normalize(query.leagueId)
            : undefined,

          activeCompetitions: 0,

          catalogueCompetitions: catalogue.length,

          operationalSeasonScope: true,
        },

        inventory,

        queue,

        sync,

        pipeline,

        providers,

        expectedWork: this.emptyExpectedWork(),

        leagues: [],

        architectureNotes: this.getArchitectureNotes(),
      };
    }

    const [
      operationalSeasonData,
      teamAggregates,
      standingAggregates,
      newsAggregates,
      queueAggregates,
      upcomingFixtures,
    ] = await Promise.all([
      this.buildOperationalSeasonData(contexts, now),

      this.aggregateTeams(contexts),

      this.aggregateStandings(contexts),

      this.aggregateNews(contexts, now),

      this.aggregateQueueData(contexts),

      this.loadUpcomingFixtures(contexts, now),
    ]);

    const syncAggregates = this.aggregateSyncData(contexts, now, syncStates);

    const upcomingIndexes = await this.buildUpcomingIndexes(upcomingFixtures);

    const leagues = contexts.map((context) =>
      this.buildLeagueSummary({
        context,
        catalogueById,
        operationalSeasonData,
        teamAggregates,
        standingAggregates,
        newsAggregates,
        queueAggregates,
        syncAggregates,
        upcomingFixtures,
        upcomingIndexes,
      }),
    );

    const expectedWork = this.sumExpectedWork(
      leagues.map((league) => league.expectedWork),
    );

    return {
      generatedAt: this.toIso(now) as string,

      scope: {
        activeLeagueFilter: query.leagueId
          ? this.normalize(query.leagueId)
          : undefined,

        activeCompetitions: activeCompetitions.length,

        catalogueCompetitions: catalogue.length,

        operationalSeasonScope: true,
      },

      inventory,

      queue,

      sync,

      pipeline,

      providers,

      expectedWork,

      leagues,

      architectureNotes: this.getArchitectureNotes(),
    };
  }

  // ============================================================
  // ACTIVE COMPETITIONS
  // ============================================================

  private async getActiveCompetitions(
    query: SportsSystemMonitorQuery,
  ): Promise<ActiveCompetitionDocument[]> {
    const filter: Record<string, unknown> = {};

    if (query.leagueId?.trim()) {
      const normalized = this.normalize(query.leagueId);

      filter.$or = [
        {
          competitionId: normalized,
        },

        {
          espnLeagueSlug: normalized,
        },
      ];
    }

    return this.activeCompetitionModel
      .find(filter)
      .sort({
        priority: 1,
        nextFixtureDate: 1,
        name: 1,
      })
      .lean()
      .exec();
  }

  // ============================================================
  // INVENTORY
  // ============================================================

  private async buildInventory(): Promise<MonitorInventory> {
    const [
      activeCompetitions,
      espnCatalogue,
      espnFixtures,
      espnTeams,
      espnStandings,
      espnNews,
      espnQueue,
      sportsSyncStates,
      footballDataCompetitions,
      footballDataMatches,
      footballDataStandings,
      footballDataTeams,
      oddsApiSports,
      sportsOddsSnapshots,
      youtubeHighlights,
    ] = await Promise.all([
      this.activeCompetitionModel.estimatedDocumentCount(),

      this.espnLeagueModel.estimatedDocumentCount(),

      this.espnFixtureModel.estimatedDocumentCount(),

      this.espnTeamModel.estimatedDocumentCount(),

      this.espnStandingModel.estimatedDocumentCount(),

      this.espnNewsModel.estimatedDocumentCount(),

      this.espnQueueModel.estimatedDocumentCount(),

      this.sportsSyncStateModel.estimatedDocumentCount(),

      this.footballDataCompetitionModel.estimatedDocumentCount(),

      this.footballDataMatchModel.estimatedDocumentCount(),

      this.footballDataStandingModel.estimatedDocumentCount(),

      this.footballDataTeamModel.estimatedDocumentCount(),

      this.oddsApiSportModel.estimatedDocumentCount(),

      this.sportsOddsSnapshotModel.estimatedDocumentCount(),

      this.youtubeHighlightModel.estimatedDocumentCount(),
    ]);

    return {
      activeCompetitions,
      espnCatalogue,
      espnFixtures,
      espnTeams,
      espnStandings,
      espnNews,
      espnQueue,
      sportsSyncStates,
      footballDataCompetitions,
      footballDataMatches,
      footballDataStandings,
      footballDataTeams,
      oddsApiSports,
      sportsOddsSnapshots,
      youtubeHighlights,
    };
  }

  // ============================================================
  // OPERATIONAL SEASON DATA
  // ============================================================

  private async buildOperationalSeasonData(
    contexts: LeagueContext[],
    now: Date,
  ): Promise<OperationalSeasonData> {
    const clauses = contexts
      .filter((context) => typeof context.season === 'number')
      .flatMap((context) =>
        context.aliases.map((leagueId) => ({
          leagueId,
          season: context.season,
        })),
      );

    const contextByAlias = new Map<string, LeagueContext>();

    for (const context of contexts) {
      for (const alias of context.aliases) {
        contextByAlias.set(alias, context);
      }
    }

    const fixtureRows = clauses.length
      ? await this.espnFixtureModel
          .aggregate<{
            _id: {
              leagueId: string;
              season: number;
            };

            total: number;

            upcoming: number;

            live: number;

            finished: number;

            withSummary: number;

            finishedWithSummary: number;

            postMatchMissingFinalResult: number;

            staleUpcomingStatus: number;

            homeTeamIds: Array<string | number | null | undefined>;

            awayTeamIds: Array<string | number | null | undefined>;

            latestCollectedAt?: Date;

            latestSummaryCollectedAt?: Date;
          }>([
            {
              $match: {
                $or: clauses,
              },
            },

            {
              $group: {
                _id: {
                  leagueId: '$leagueId',
                  season: '$season',
                },

                total: {
                  $sum: 1,
                },

                upcoming: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          {
                            $gte: ['$fixtureDate', now],
                          },

                          {
                            $ne: ['$completed', true],
                          },
                        ],
                      },

                      1,

                      0,
                    ],
                  },
                },

                live: {
                  $sum: {
                    $cond: [
                      {
                        $eq: ['$live', true],
                      },

                      1,

                      0,
                    ],
                  },
                },

                finished: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          {
                            $eq: ['$completed', true],
                          },

                          {
                            $in: ['$status', [...COMPLETED_STATUSES]],
                          },
                        ],
                      },

                      1,

                      0,
                    ],
                  },
                },

                withSummary: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          {
                            $ne: [
                              {
                                $ifNull: ['$payload.summary', null],
                              },

                              null,
                            ],
                          },

                          {
                            $ne: [
                              {
                                $ifNull: ['$payload.summary', {}],
                              },

                              {},
                            ],
                          },
                        ],
                      },

                      1,

                      0,
                    ],
                  },
                },

                finishedWithSummary: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          {
                            $or: [
                              {
                                $eq: ['$completed', true],
                              },

                              {
                                $in: ['$status', [...COMPLETED_STATUSES]],
                              },
                            ],
                          },

                          {
                            $ne: [
                              {
                                $ifNull: ['$payload.summary', null],
                              },

                              null,
                            ],
                          },

                          {
                            $ne: [
                              {
                                $ifNull: ['$payload.summary', {}],
                              },

                              {},
                            ],
                          },
                        ],
                      },

                      1,

                      0,
                    ],
                  },
                },

                postMatchMissingFinalResult: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          {
                            $gte: [
                              '$fixtureDate',
                              new Date(
                                now.getTime() -
                                  Math.max(
                                    1,
                                    SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary
                                      .integrityRecoveryLookbackDays,
                                  ) *
                                    24 *
                                    60 *
                                    60_000,
                              ),
                            ],
                          },
                          {
                            $lte: [
                              '$fixtureDate',
                              new Date(
                                now.getTime() -
                                  SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary
                                    .finishedMatchDelayMinutes *
                                    60_000,
                              ),
                            ],
                          },
                          {
                            $not: [
                              {
                                $regexMatch: {
                                  input: {
                                    $toUpper: {
                                      $concat: [
                                        { $ifNull: ['$status', ''] },
                                        ' ',
                                        { $ifNull: ['$statusDetail', ''] },
                                        ' ',
                                        { $ifNull: ['$statusShortDetail', ''] },
                                      ],
                                    },
                                  },
                                  regex: 'CANCEL|POSTPON|ABANDON|VOID',
                                },
                              },
                            ],
                          },
                          {
                            $or: [
                              { $ne: ['$completed', true] },
                              { $not: [{ $isNumber: '$homeScore' }] },
                              { $not: [{ $isNumber: '$awayScore' }] },
                            ],
                          },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },

                staleUpcomingStatus: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          {
                            $gte: [
                              '$fixtureDate',
                              new Date(
                                now.getTime() -
                                  Math.max(
                                    1,
                                    SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary
                                      .integrityRecoveryLookbackDays,
                                  ) *
                                    24 *
                                    60 *
                                    60_000,
                              ),
                            ],
                          },
                          {
                            $lte: [
                              '$fixtureDate',
                              new Date(
                                now.getTime() -
                                  SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary
                                    .finishedMatchDelayMinutes *
                                    60_000,
                              ),
                            ],
                          },
                          {
                            $regexMatch: {
                              input: {
                                $toUpper: { $ifNull: ['$status', ''] },
                              },
                              regex:
                                'SCHEDULED|UPCOMING|NOT[_ ]STARTED|STATUS_PRE|STATUS_SCHEDULED',
                            },
                          },
                          {
                            $not: [
                              {
                                $regexMatch: {
                                  input: {
                                    $toUpper: {
                                      $concat: [
                                        { $ifNull: ['$status', ''] },
                                        ' ',
                                        { $ifNull: ['$statusDetail', ''] },
                                        ' ',
                                        { $ifNull: ['$statusShortDetail', ''] },
                                      ],
                                    },
                                  },
                                  regex: 'CANCEL|POSTPON|ABANDON|VOID',
                                },
                              },
                            ],
                          },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },

                homeTeamIds: {
                  $addToSet: '$homeTeamId',
                },

                awayTeamIds: {
                  $addToSet: '$awayTeamId',
                },

                latestCollectedAt: {
                  $max: '$collectedAt',
                },

                latestSummaryCollectedAt: {
                  $max: '$payload.summaryCollectedAt',
                },
              },
            },
          ])
          .exec()
      : [];

    const expectedTeams = new Map<string, Set<string>>();

    const fixtureAggregates = new Map<string, FixtureAggregate>();

    const storedSeasonSets = new Map<string, Set<number>>();

    for (const row of fixtureRows) {
      const context = contextByAlias.get(this.normalize(row._id.leagueId));

      if (!context) {
        continue;
      }

      if (
        typeof row._id.season !== 'number' ||
        row._id.season !== context.season
      ) {
        continue;
      }

      if (!expectedTeams.has(context.key)) {
        expectedTeams.set(context.key, new Set<string>());
      }

      const teamIds = expectedTeams.get(context.key)!;
      for (const teamId of [
        ...(row.homeTeamIds ?? []),
        ...(row.awayTeamIds ?? []),
      ]) {
        if (teamId !== null && teamId !== undefined && String(teamId)) {
          teamIds.add(String(teamId));
        }
      }

      const key = context.key;

      const total = Number(row.total ?? 0);

      const withSummary = Number(row.withSummary ?? 0);

      const finished = Number(row.finished ?? 0);

      const finishedWithSummary = Number(row.finishedWithSummary ?? 0);

      const existing = fixtureAggregates.get(key);

      if (!storedSeasonSets.has(key)) {
        storedSeasonSets.set(key, new Set<number>());
      }

      storedSeasonSets.get(key)!.add(row._id.season);

      const incoming: FixtureAggregate = {
        total,

        upcoming: Number(row.upcoming ?? 0),

        live: Number(row.live ?? 0),

        finished,

        finishedWithSummary,

        withSummary,

        missingSummary: Math.max(0, total - withSummary),

        finishedMissingSummary: Math.max(0, finished - finishedWithSummary),

        postMatchMissingFinalResult: Number(
          row.postMatchMissingFinalResult ?? 0,
        ),

        staleUpcomingStatus: Number(row.staleUpcomingStatus ?? 0),

        summaryCoveragePercent:
          total > 0 ? this.percent(withSummary, total) : 0,

        latestCollectedAt: row.latestCollectedAt,

        latestSummaryCollectedAt: row.latestSummaryCollectedAt,

        storedSeasons: 1,
      };

      if (!existing) {
        fixtureAggregates.set(key, incoming);

        continue;
      }

      existing.total += incoming.total;

      existing.upcoming += incoming.upcoming;

      existing.live += incoming.live;

      existing.finished += incoming.finished;

      existing.finishedWithSummary += incoming.finishedWithSummary;

      existing.withSummary += incoming.withSummary;

      existing.missingSummary += incoming.missingSummary;

      existing.finishedMissingSummary += incoming.finishedMissingSummary;

      existing.postMatchMissingFinalResult +=
        incoming.postMatchMissingFinalResult;

      existing.staleUpcomingStatus += incoming.staleUpcomingStatus;

      if (
        incoming.latestCollectedAt &&
        (!existing.latestCollectedAt ||
          incoming.latestCollectedAt.getTime() >
            existing.latestCollectedAt.getTime())
      ) {
        existing.latestCollectedAt = incoming.latestCollectedAt;
      }

      if (
        incoming.latestSummaryCollectedAt &&
        (!existing.latestSummaryCollectedAt ||
          incoming.latestSummaryCollectedAt.getTime() >
            existing.latestSummaryCollectedAt.getTime())
      ) {
        existing.latestSummaryCollectedAt = incoming.latestSummaryCollectedAt;
      }
    }

    for (const [key, aggregate] of fixtureAggregates) {
      aggregate.summaryCoveragePercent =
        aggregate.total > 0
          ? this.percent(aggregate.withSummary, aggregate.total)
          : 0;

      aggregate.storedSeasons = storedSeasonSets.get(key)?.size ?? 0;
    }

    return {
      fixtures: fixtureAggregates,

      expectedTeams,
    };
  }

  // ============================================================
  // TEAMS
  // ============================================================

  private async aggregateTeams(
    contexts: LeagueContext[],
  ): Promise<Map<string, TeamAggregate>> {
    const aliases = [
      ...new Set(contexts.flatMap((context) => context.aliases)),
    ];

    if (!aliases.length) {
      return new Map();
    }

    const contextByAlias = new Map<string, LeagueContext>();

    for (const context of contexts) {
      for (const alias of context.aliases) {
        contextByAlias.set(alias, context);
      }
    }

    const rows = await this.espnTeamModel
      .aggregate<{
        _id: string;
        documents: number;
        teamIds: string[];
        latestCollectedAt?: Date;
      }>([
        {
          $match: {
            leagueId: {
              $in: aliases,
            },
          },
        },

        {
          $group: {
            _id: '$leagueId',

            documents: {
              $sum: 1,
            },

            teamIds: {
              $addToSet: '$teamId',
            },

            latestCollectedAt: {
              $max: '$collectedAt',
            },
          },
        },
      ])
      .exec();

    const result = new Map<string, TeamAggregate>();

    for (const row of rows) {
      const context = contextByAlias.get(this.normalize(row._id));

      if (!context) {
        continue;
      }

      const incoming: TeamAggregate = {
        documents: Number(row.documents ?? 0),

        teamIds: new Set(
          (row.teamIds ?? []).filter(Boolean).map((teamId) => String(teamId)),
        ),

        latestCollectedAt: row.latestCollectedAt,
      };

      const current = result.get(context.key);

      if (!current) {
        result.set(context.key, incoming);

        continue;
      }

      current.documents += incoming.documents;

      for (const teamId of incoming.teamIds) {
        current.teamIds.add(teamId);
      }

      if (
        incoming.latestCollectedAt &&
        (!current.latestCollectedAt ||
          incoming.latestCollectedAt.getTime() >
            current.latestCollectedAt.getTime())
      ) {
        current.latestCollectedAt = incoming.latestCollectedAt;
      }
    }

    return result;
  }

  // ============================================================
  // QUEUE
  // ============================================================

  private async buildQueueSummary(): Promise<MonitorQueueSummary> {
    const staleCutoff = new Date(
      Date.now() - STALE_PROCESSING_MINUTES * 60 * 1000,
    );

    // One grouped collection pass provides status, type, and type/status totals.
    // The previous implementation scanned the queue three separate times.
    const [
      statusTypeRows,
      latestFailure,
      latestCompleted,
      retryLaneJobs,
      quarantinedJobs,
      oldestRetryJob,
    ] = await Promise.all([
      this.espnQueueModel
        .aggregate<{
          _id: {
            status: string;
            type: string;
          };
          count: number;
          staleProcessing: number;
        }>([
          {
            $group: {
              _id: {
                status: '$status',
                type: '$type',
              },
              count: {
                $sum: 1,
              },
              staleProcessing: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$status', EspnQueueStatus.PROCESSING] },
                        {
                          $or: [
                            { $lte: ['$leaseExpiresAt', new Date()] },
                            {
                              $and: [
                                {
                                  $eq: [
                                    { $type: '$leaseExpiresAt' },
                                    'missing',
                                  ],
                                },
                                { $lte: ['$startedAt', staleCutoff] },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ])
        .exec(),

      this.espnQueueModel
        .findOne({ status: EspnQueueStatus.FAILED })
        .sort({ failedAt: -1, updatedAt: -1 })
        .lean()
        .exec(),

      this.espnQueueModel
        .findOne({ status: EspnQueueStatus.COMPLETED })
        .sort({ completedAt: -1, updatedAt: -1 })
        .lean()
        .exec(),

      this.espnQueueModel
        .countDocuments({
          status: EspnQueueStatus.FAILED,
          lane: 'BACKGROUND_RETRY' as unknown as EspnQueueDocument['lane'],
        })
        .exec(),

      this.espnQueueModel
        .countDocuments({
          status: EspnQueueStatus.FAILED,
          lane: 'QUARANTINE' as unknown as EspnQueueDocument['lane'],
        })
        .exec(),

      this.espnQueueModel
        .findOne({
          status: EspnQueueStatus.FAILED,
          lane: 'BACKGROUND_RETRY' as unknown as EspnQueueDocument['lane'],
        })
        .sort({ firstFailedAt: 1, failedAt: 1 })
        .select({ firstFailedAt: 1, failedAt: 1 })
        .lean()
        .exec(),
    ]);

    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const byTypeAndStatus: MonitorQueueItem[] = [];
    let staleProcessing = 0;

    for (const row of statusTypeRows) {
      const status = String(row._id.status);
      const type = String(row._id.type);
      const count = Number(row.count ?? 0);

      byStatus[status] = (byStatus[status] ?? 0) + count;
      byType[type] = (byType[type] ?? 0) + count;
      staleProcessing += Number(row.staleProcessing ?? 0);
      byTypeAndStatus.push({ type, status, count });
    }

    const latestFailureRecord = latestFailure as unknown as {
      failedAt?: Date;
      updatedAt?: Date;
      lastError?: string;
      error?: string;
    } | null;

    const latestCompletedRecord = latestCompleted as unknown as {
      completedAt?: Date;
      updatedAt?: Date;
    } | null;

    return {
      total: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
      pending: byStatus[EspnQueueStatus.PENDING] ?? 0,
      processing: byStatus[EspnQueueStatus.PROCESSING] ?? 0,
      completedRetained: byStatus[EspnQueueStatus.COMPLETED] ?? 0,
      failed: byStatus[EspnQueueStatus.FAILED] ?? 0,
      retryLaneJobs: Number(retryLaneJobs ?? 0),
      quarantinedJobs: Number(quarantinedJobs ?? 0),
      oldestRetryFailedAt: this.toIso(
        (oldestRetryJob as { firstFailedAt?: Date; failedAt?: Date } | null)
          ?.firstFailedAt ??
          (oldestRetryJob as { failedAt?: Date } | null)?.failedAt,
      ),
      staleProcessing,
      completedRetentionDays: QUEUE_COMPLETED_RETENTION_DAYS,
      byType,
      byTypeAndStatus,
      latestFailureAt: this.toIso(
        latestFailureRecord?.failedAt ?? latestFailureRecord?.updatedAt,
      ),
      latestFailure:
        latestFailureRecord?.lastError ?? latestFailureRecord?.error,
      latestCompletedAt: this.toIso(
        latestCompletedRecord?.completedAt ?? latestCompletedRecord?.updatedAt,
      ),
    };
  }

  private async aggregateQueueData(
    contexts: LeagueContext[],
  ): Promise<Map<string, QueueAggregate>> {
    const clauses = contexts.flatMap((context) =>
      context.aliases.map((leagueId) => ({
        leagueId,

        ...(typeof context.season === 'number'
          ? {
              season: context.season,
            }
          : {}),
      })),
    );

    if (!clauses.length) {
      return new Map();
    }

    const contextByAlias = new Map<string, LeagueContext>();

    for (const context of contexts) {
      for (const alias of context.aliases) {
        contextByAlias.set(alias, context);
      }
    }

    const rows = await this.espnQueueModel
      .aggregate<{
        _id: {
          leagueId: string;
          type: string;
          status: string;
        };

        count: number;
      }>([
        {
          $match: {
            $or: clauses,
          },
        },

        {
          $group: {
            _id: {
              leagueId: '$leagueId',

              type: '$type',

              status: '$status',
            },

            count: {
              $sum: 1,
            },
          },
        },
      ])
      .exec();

    const result = new Map<string, QueueAggregate>();

    for (const row of rows) {
      const context = contextByAlias.get(this.normalize(row._id.leagueId));

      if (!context) {
        continue;
      }

      let aggregate = result.get(context.key);

      if (!aggregate) {
        aggregate = {
          total: 0,

          byStatus: new Map(),

          byType: new Map(),

          byTypeAndStatus: new Map(),

          staleProcessing: 0,
        };

        result.set(context.key, aggregate);
      }

      const count = Number(row.count ?? 0);

      const status = String(row._id.status);

      const type = String(row._id.type);

      aggregate.total += count;

      aggregate.byStatus.set(
        status,
        (aggregate.byStatus.get(status) ?? 0) + count,
      );

      aggregate.byType.set(type, (aggregate.byType.get(type) ?? 0) + count);

      const compoundKey = `${type}:${status}`;

      aggregate.byTypeAndStatus.set(
        compoundKey,
        (aggregate.byTypeAndStatus.get(compoundKey) ?? 0) + count,
      );
    }

    const staleCutoff = new Date(
      Date.now() - STALE_PROCESSING_MINUTES * 60 * 1000,
    );

    const staleRows = await this.espnQueueModel
      .aggregate<{
        _id: string;
        count: number;
      }>([
        {
          $match: {
            $and: [
              { $or: clauses },
              { status: EspnQueueStatus.PROCESSING },
              {
                $or: [
                  { leaseExpiresAt: { $lte: new Date() } },
                  {
                    leaseExpiresAt: { $exists: false },
                    startedAt: { $lte: staleCutoff },
                  },
                ],
              },
            ],
          },
        },

        {
          $group: {
            _id: '$leagueId',

            count: {
              $sum: 1,
            },
          },
        },
      ])
      .exec();

    for (const row of staleRows) {
      const context = contextByAlias.get(this.normalize(row._id));

      if (!context) {
        continue;
      }

      const aggregate = result.get(context.key);

      if (aggregate) {
        aggregate.staleProcessing += Number(row.count ?? 0);
      }
    }

    return result;
  }

  // ============================================================
  // SYNC SUMMARY
  // ============================================================

  private async loadSyncStateSnapshot(): Promise<MonitorSyncStateRecord[]> {
    const states = await this.sportsSyncStateModel
      .find({})
      .select({
        stateKey: 1,
        kind: 1,
        jobType: 1,
        taskKey: 1,
        cronExpression: 1,
        timeZone: 1,
        leagueId: 1,
        season: 1,
        eventId: 1,
        status: 1,
        trackingMode: 1,
        fixtureGranularity: 1,
        dateFrom: 1,
        dateTo: 1,
        lastStartedAt: 1,
        lastSuccessfulAt: 1,
        lastCompletedAt: 1,
        nextRunAt: 1,
        consecutiveFailures: 1,
        lastError: 1,
        updatedAt: 1,
        'units.key': 1,
        'units.type': 1,
        'units.monthKey': 1,
        'units.dateKey': 1,
        'units.stepKey': 1,
        'units.status': 1,
        'units.startedAt': 1,
        'units.completedAt': 1,
      })
      .lean()
      .exec();
    return states;
  }

  private buildSyncSummary(
    contexts: LeagueContext[],
    now: Date,
    states: MonitorSyncStateRecord[],
  ): MonitorSyncSummary {
    const contextByAlias = new Map<string, LeagueContext>();

    for (const context of contexts) {
      for (const alias of context.aliases) {
        contextByAlias.set(alias, context);
      }
    }

    const byStatus: Record<string, number> = {};

    let queueStates = 0;

    let cronStates = 0;

    let totalUnits = 0;

    let successUnits = 0;

    let processingUnits = 0;

    let pendingUnits = 0;

    let failedUnits = 0;

    let successfulStates = 0;

    let latestSuccessfulAt: Date | undefined;

    let latestCompletedAt: Date | undefined;

    let nextRunAt: Date | undefined;

    const stages: MonitorSyncStageSummary[] = [];

    const failures: MonitorSyncFailure[] = [];

    const cron: SportsSystemMonitorResponse['sync']['cron'] = [];

    const syncStateDetails: MonitorSyncStateDetail[] = [];

    for (const state of states) {
      const status = String(state.status);

      byStatus[status] = (byStatus[status] ?? 0) + 1;

      if (state.kind === SportsSyncStateKind.QUEUE) {
        queueStates += 1;

        const context = state.leagueId
          ? contextByAlias.get(this.normalize(state.leagueId))
          : undefined;

        syncStateDetails.push(
          this.buildSyncStateDetail(state, context?.competition.name, now),
        );
      }

      if (state.kind === SportsSyncStateKind.CRON) {
        cronStates += 1;

        cron.push({
          stateKey: state.stateKey,

          taskKey: state.taskKey,

          status,

          cronExpression: state.cronExpression,

          timeZone: state.timeZone,

          lastStartedAt: this.toIso(state.lastStartedAt),

          lastSuccessfulAt: this.toIso(state.lastSuccessfulAt),

          lastCompletedAt: this.toIso(state.lastCompletedAt),

          nextRunAt: this.toIso(state.nextRunAt),

          consecutiveFailures: state.consecutiveFailures ?? 0,

          lastError: state.lastError,
        });
      }

      if (state.status === SportsSyncStateStatus.SUCCESS) {
        successfulStates += 1;
      }

      if (state.lastSuccessfulAt) {
        const value = new Date(state.lastSuccessfulAt);

        if (
          !latestSuccessfulAt ||
          value.getTime() > latestSuccessfulAt.getTime()
        ) {
          latestSuccessfulAt = value;
        }
      }

      if (state.lastCompletedAt) {
        const value = new Date(state.lastCompletedAt);

        if (
          !latestCompletedAt ||
          value.getTime() > latestCompletedAt.getTime()
        ) {
          latestCompletedAt = value;
        }
      }

      if (state.nextRunAt) {
        const value = new Date(state.nextRunAt);

        if (!nextRunAt || value.getTime() < nextRunAt.getTime()) {
          nextRunAt = value;
        }
      }

      for (const unit of state.units ?? []) {
        totalUnits += 1;

        switch (unit.status) {
          case SportsSyncUnitStatus.SUCCESS:
            successUnits += 1;
            break;

          case SportsSyncUnitStatus.PROCESSING:
            processingUnits += 1;
            break;

          case SportsSyncUnitStatus.PENDING:
            pendingUnits += 1;
            break;

          case SportsSyncUnitStatus.FAILED:
            failedUnits += 1;
            break;
        }

        if (unit.status !== SportsSyncUnitStatus.SUCCESS) {
          stages.push({
            jobType: state.jobType,

            stage: unit.stepKey ?? unit.dateKey ?? unit.key,

            unitType: String(unit.type),

            status: String(unit.status),

            count: 1,
          });
        }
      }

      if (
        state.status === SportsSyncStateStatus.FAILED ||
        (state.consecutiveFailures ?? 0) > 0 ||
        state.lastError
      ) {
        failures.push({
          stateKey: state.stateKey,

          jobType: state.jobType,

          leagueId: state.leagueId,

          season: state.season,

          eventId: state.eventId,

          error: state.lastError,

          at: this.toIso(
            state.lastCompletedAt ?? state.lastStartedAt ?? state.updatedAt,
          ),

          consecutiveFailures: state.consecutiveFailures ?? 0,
        });
      }
    }

    const groupedStages = this.groupSyncStages(stages);

    failures.sort(
      (a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime(),
    );

    syncStateDetails.sort((a, b) => {
      const leagueCompare = (a.leagueName ?? '').localeCompare(
        b.leagueName ?? '',
      );

      if (leagueCompare !== 0) {
        return leagueCompare;
      }

      const jobCompare = (a.jobType ?? '').localeCompare(b.jobType ?? '');

      if (jobCompare !== 0) {
        return jobCompare;
      }

      return a.stateKey.localeCompare(b.stateKey);
    });

    return {
      totalStates: states.length,

      queueStates,

      cronStates,

      byStatus,

      unitProgress: {
        total: totalUnits,

        success: successUnits,

        processing: processingUnits,

        pending: pendingUnits,

        failed: failedUnits,

        completionPercent:
          totalUnits > 0 ? this.percent(successUnits, totalUnits) : 0,
      },

      stateCompletionPercent:
        states.length > 0 ? this.percent(successfulStates, states.length) : 0,

      currentStages: groupedStages,

      failures: failures.slice(0, 100),

      cron,

      states: syncStateDetails,

      latestSuccessfulAt: this.toIso(latestSuccessfulAt),

      latestCompletedAt: this.toIso(latestCompletedAt),

      nextRunAt: this.toIso(nextRunAt),
    };
  }

  private aggregateSyncData(
    contexts: LeagueContext[],
    now: Date,
    allStates: MonitorSyncStateRecord[],
  ): Map<string, SyncAggregate> {
    const clauses = contexts.flatMap((context) =>
      context.aliases.map((leagueId) => ({
        leagueId,

        ...(typeof context.season === 'number'
          ? {
              season: context.season,
            }
          : {}),
      })),
    );

    if (!clauses.length) {
      return new Map();
    }

    const contextByAlias = new Map<string, LeagueContext>();

    for (const context of contexts) {
      for (const alias of context.aliases) {
        contextByAlias.set(alias, context);
      }
    }

    // The global monitor summary already loaded these projected records.
    // Reuse them rather than materializing a second copy of the same units.
    const states = allStates.filter((state) =>
      clauses.some(
        (clause) =>
          state.leagueId === clause.leagueId &&
          (typeof clause.season !== 'number' || state.season === clause.season),
      ),
    );

    const result = new Map<string, SyncAggregate>();

    for (const state of states) {
      const context = contextByAlias.get(this.normalize(state.leagueId));

      if (!context) {
        continue;
      }

      let aggregate = result.get(context.key);

      if (!aggregate) {
        aggregate = {
          stateCounts: {},

          queueStates: 0,

          cronStates: 0,

          unitProgress: {
            total: 0,
            monthUnits: 0,
            success: 0,
            processing: 0,
            pending: 0,
            failed: 0,
          },

          currentStages: [],

          failures: [],

          cron: [],

          states: [],
        };

        result.set(context.key, aggregate);
      }

      const status = String(state.status);

      aggregate.stateCounts[status] = (aggregate.stateCounts[status] ?? 0) + 1;

      if (state.kind === SportsSyncStateKind.QUEUE) {
        aggregate.queueStates += 1;

        aggregate.states.push(
          this.buildSyncStateDetail(state, context.competition.name, now),
        );
      }

      if (state.kind === SportsSyncStateKind.CRON) {
        aggregate.cronStates += 1;

        aggregate.cron.push({
          stateKey: state.stateKey,

          taskKey: state.taskKey,

          status,

          cronExpression: state.cronExpression,

          timeZone: state.timeZone,

          lastStartedAt: this.toIso(state.lastStartedAt),

          lastSuccessfulAt: this.toIso(state.lastSuccessfulAt),

          lastCompletedAt: this.toIso(state.lastCompletedAt),

          nextRunAt: this.toIso(state.nextRunAt),

          consecutiveFailures: state.consecutiveFailures ?? 0,

          lastError: state.lastError,
        });
      }

      if (state.lastSuccessfulAt) {
        const value = new Date(state.lastSuccessfulAt);

        if (
          !aggregate.latestSuccessfulAt ||
          value.getTime() > aggregate.latestSuccessfulAt.getTime()
        ) {
          aggregate.latestSuccessfulAt = value;
        }
      }

      if (state.lastCompletedAt) {
        const value = new Date(state.lastCompletedAt);

        if (
          !aggregate.latestCompletedAt ||
          value.getTime() > aggregate.latestCompletedAt.getTime()
        ) {
          aggregate.latestCompletedAt = value;
        }
      }

      if (state.nextRunAt) {
        const value = new Date(state.nextRunAt);

        if (
          !aggregate.nextRunAt ||
          value.getTime() < aggregate.nextRunAt.getTime()
        ) {
          aggregate.nextRunAt = value;
        }
      }

      for (const unit of state.units ?? []) {
        aggregate.unitProgress.total += 1;

        switch (unit.status) {
          case SportsSyncUnitStatus.SUCCESS:
            aggregate.unitProgress.success += 1;
            break;

          case SportsSyncUnitStatus.PROCESSING:
            aggregate.unitProgress.processing += 1;
            break;

          case SportsSyncUnitStatus.PENDING:
            aggregate.unitProgress.pending += 1;
            break;

          case SportsSyncUnitStatus.FAILED:
            aggregate.unitProgress.failed += 1;
            break;
        }

        if (unit.status !== SportsSyncUnitStatus.SUCCESS) {
          aggregate.currentStages.push({
            jobType: state.jobType,

            stage: unit.stepKey ?? unit.dateKey ?? unit.key,

            unitType: String(unit.type),

            status: String(unit.status),

            count: 1,
          });
        }
      }

      if (
        state.status === SportsSyncStateStatus.FAILED ||
        (state.consecutiveFailures ?? 0) > 0 ||
        state.lastError
      ) {
        aggregate.failures.push({
          stateKey: state.stateKey,

          jobType: state.jobType,

          leagueId: state.leagueId,

          season: state.season,

          eventId: state.eventId,

          error: state.lastError,

          at: this.toIso(
            state.lastCompletedAt ?? state.lastStartedAt ?? state.updatedAt,
          ),

          consecutiveFailures: state.consecutiveFailures ?? 0,
        });
      }
    }

    for (const aggregate of result.values()) {
      aggregate.currentStages = this.groupSyncStages(aggregate.currentStages);

      aggregate.failures.sort(
        (a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime(),
      );

      aggregate.states.sort((a, b) => {
        const jobCompare = (a.jobType ?? '').localeCompare(b.jobType ?? '');

        if (jobCompare !== 0) {
          return jobCompare;
        }

        return a.stateKey.localeCompare(b.stateKey);
      });
    }

    return result;
  }

  // ============================================================
  // UPCOMING
  // ============================================================

  private async loadUpcomingFixtures(
    contexts: LeagueContext[],
    now: Date,
  ): Promise<EspnFixtureDocument[]> {
    const clauses = contexts
      .filter((context) => typeof context.season === 'number')
      .flatMap((context) =>
        context.aliases.map((leagueId) => ({
          leagueId,

          season: context.season,
        })),
      );

    if (!clauses.length) {
      return [];
    }

    const until = new Date(now.getTime() + UPCOMING_WINDOW_HOURS * 60 * 60_000);

    return this.espnFixtureModel
      .find({
        $or: clauses,
        fixtureDate: { $gte: now, $lte: until },
        completed: { $ne: true },
      })
      .select({
        eventId: 1,
        leagueId: 1,
        season: 1,
        fixtureDate: 1,
        homeTeamId: 1,
        awayTeamId: 1,
        'payload.competitions': 1,
      })
      .sort({ fixtureDate: 1 })
      .lean()
      .exec();
  }

  private async buildUpcomingIndexes(
    fixtures: EspnFixtureDocument[],
  ): Promise<UpcomingIndexes> {
    const summaries = new Set<string>();

    const odds = new Set<string>();

    const fixtureIds = fixtures
      .map((fixture) => fixture.eventId)
      .filter((eventId): eventId is string => Boolean(eventId));

    if (fixtureIds.length) {
      const [summaryDocs, oddsDocs] = await Promise.all([
        this.espnFixtureModel
          .aggregate<{ eventId: string }>([
            { $match: { eventId: { $in: fixtureIds } } },
            {
              $project: {
                _id: 0,
                eventId: 1,
                summaryNonEmpty: {
                  $cond: [
                    { $eq: [{ $type: '$payload.summary' }, 'object'] },
                    {
                      $gt: [
                        { $size: { $objectToArray: '$payload.summary' } },
                        0,
                      ],
                    },
                    {
                      $cond: [
                        { $eq: [{ $type: '$payload.summary' }, 'array'] },
                        { $gt: [{ $size: '$payload.summary' }, 0] },
                        false,
                      ],
                    },
                  ],
                },
              },
            },
            { $match: { summaryNonEmpty: true } },
            { $project: { eventId: 1 } },
          ])
          .exec(),
        this.sportsOddsSnapshotModel
          .find({ eventId: { $in: fixtureIds } })
          .select({ eventId: 1 })
          .lean()
          .exec(),
      ]);

      for (const document of summaryDocs) {
        if (document.eventId) summaries.add(document.eventId);
      }

      for (const document of oddsDocs) {
        if (document.eventId) odds.add(document.eventId);
      }
    }

    return {
      summaries,
      odds,
    };
  }

  // ============================================================
  // STANDINGS
  // ============================================================

  private async aggregateStandings(
    contexts: LeagueContext[],
  ): Promise<Map<string, StandingAggregate>> {
    const clauses = contexts
      .filter((context) => typeof context.season === 'number')
      .flatMap((context) =>
        context.aliases.map((leagueId) => ({
          leagueId,
          season: context.season,
        })),
      );
    if (!clauses.length) return new Map();

    const contextByAlias = new Map<string, LeagueContext>();
    for (const context of contexts) {
      for (const alias of context.aliases) contextByAlias.set(alias, context);
    }

    const documents = await this.espnStandingModel
      .find({ $or: clauses })
      .select({ leagueId: 1, season: 1, payload: 1, fetchedAt: 1 })
      .lean()
      .exec();

    const result = new Map<string, StandingAggregate>();
    const collectTeamIds = (value: unknown, ids: Set<string>): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) collectTeamIds(item, ids);
        return;
      }
      const record = value as Record<string, unknown>;
      const team = record.team;
      if (team && typeof team === 'object' && !Array.isArray(team)) {
        const id = (team as Record<string, unknown>).id;
        if (typeof id === 'string' || typeof id === 'number')
          ids.add(String(id));
      }
      for (const child of Object.values(record)) collectTeamIds(child, ids);
    };

    for (const document of documents) {
      const context = contextByAlias.get(this.normalize(document.leagueId));
      if (!context || document.season !== context.season) continue;
      let aggregate = result.get(context.key);
      if (!aggregate) {
        aggregate = { rows: 0, teamIds: new Set<string>() };
        result.set(context.key, aggregate);
      }
      // One stored document represents one complete league-season response.
      aggregate.rows += 1;
      collectTeamIds(document.payload, aggregate.teamIds);
      const fetchedAt = document.fetchedAt;
      if (
        fetchedAt &&
        (!aggregate.latestCollectedAt ||
          fetchedAt.getTime() > aggregate.latestCollectedAt.getTime())
      ) {
        aggregate.latestCollectedAt = fetchedAt;
      }
    }
    return result;
  }

  // ============================================================
  // NEWS INVENTORY BY ACTIVE LEAGUE
  // ============================================================

  private async aggregateNews(
    contexts: LeagueContext[],
    now: Date,
  ): Promise<Map<string, NewsAggregate>> {
    const aliases = [
      ...new Set(contexts.flatMap((context) => context.aliases)),
    ];
    if (!aliases.length) {
      return new Map();
    }

    const contextByAlias = new Map<string, LeagueContext>();
    for (const context of contexts) {
      for (const alias of context.aliases) {
        contextByAlias.set(alias, context);
      }
    }

    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const rows = await this.espnNewsModel
      .aggregate<{
        _id: string;
        total: number;
        last24Hours: number;
        latestPublishedAt?: Date;
        latestCollectedAt?: Date;
      }>([
        { $match: { leagueId: { $in: aliases } } },
        {
          $group: {
            _id: '$leagueId',
            total: { $sum: 1 },
            last24Hours: {
              $sum: {
                $cond: [{ $gte: ['$feedPublishedAt', cutoff] }, 1, 0],
              },
            },
            latestPublishedAt: { $max: '$feedPublishedAt' },
            latestCollectedAt: { $max: '$collectedAt' },
          },
        },
      ])
      .exec();

    const result = new Map<string, NewsAggregate>();
    for (const row of rows) {
      const context = contextByAlias.get(this.normalize(row._id));
      if (!context) continue;

      const incoming: NewsAggregate = {
        total: Number(row.total ?? 0),
        last24Hours: Number(row.last24Hours ?? 0),
        latestPublishedAt: row.latestPublishedAt,
        latestCollectedAt: row.latestCollectedAt,
      };
      const current = result.get(context.key);

      if (!current) {
        result.set(context.key, incoming);
        continue;
      }

      current.total += incoming.total;
      current.last24Hours += incoming.last24Hours;
      if (
        incoming.latestPublishedAt &&
        (!current.latestPublishedAt ||
          incoming.latestPublishedAt.getTime() >
            current.latestPublishedAt.getTime())
      ) {
        current.latestPublishedAt = incoming.latestPublishedAt;
      }
      if (
        incoming.latestCollectedAt &&
        (!current.latestCollectedAt ||
          incoming.latestCollectedAt.getTime() >
            current.latestCollectedAt.getTime())
      ) {
        current.latestCollectedAt = incoming.latestCollectedAt;
      }
    }

    return result;
  }

  // ============================================================
  // LEAGUE SUMMARY
  // ============================================================

  private buildLeagueSummary(params: {
    context: LeagueContext;

    catalogueById: Map<string, EspnLeagueDocument>;

    operationalSeasonData: OperationalSeasonData;

    teamAggregates: Map<string, TeamAggregate>;

    standingAggregates: Map<string, StandingAggregate>;

    newsAggregates: Map<string, NewsAggregate>;

    queueAggregates: Map<string, QueueAggregate>;

    syncAggregates: Map<string, SyncAggregate>;

    upcomingFixtures: EspnFixtureDocument[];

    upcomingIndexes: UpcomingIndexes;
  }): MonitorLeagueSummary {
    const {
      context,
      catalogueById,
      operationalSeasonData,
      teamAggregates,
      standingAggregates,
      newsAggregates,
      queueAggregates,
      syncAggregates,
      upcomingFixtures,
      upcomingIndexes,
    } = params;

    const competition = context.competition;

    const catalogue =
      catalogueById.get(this.normalize(competition.espnLeagueSlug)) ??
      catalogueById.get(this.normalize(competition.competitionId));

    const fixtureSummary = operationalSeasonData.fixtures.get(context.key) ?? {
      total: 0,
      upcoming: 0,
      live: 0,
      finished: 0,
      finishedWithSummary: 0,
      withSummary: 0,
      missingSummary: 0,
      finishedMissingSummary: 0,
      postMatchMissingFinalResult: 0,
      staleUpcomingStatus: 0,
      summaryCoveragePercent: 0,
      storedSeasons: 0,
    };

    const expectedTeamIds =
      operationalSeasonData.expectedTeams.get(context.key) ?? new Set<string>();

    const teamSummary = teamAggregates.get(context.key) ?? {
      documents: 0,
      teamIds: new Set<string>(),
    };

    const expectedTeams = expectedTeamIds.size;

    const teamsCovered = [...expectedTeamIds].filter((teamId) =>
      teamSummary.teamIds.has(teamId),
    ).length;

    const standingAggregate = standingAggregates.get(context.key) ?? {
      rows: 0,
      teamIds: new Set<string>(),
    };
    const standingsExpectedTeams = expectedTeams || teamSummary.teamIds.size;
    const standingTeamsCovered = expectedTeamIds.size
      ? [...standingAggregate.teamIds].filter((teamId) =>
          expectedTeamIds.has(teamId),
        ).length
      : standingAggregate.teamIds.size;
    const standings = {
      rows: standingAggregate.rows,
      teams: standingAggregate.teamIds.size,
      expectedTeams: standingsExpectedTeams,
      missingTeams: Math.max(0, standingsExpectedTeams - standingTeamsCovered),
      coveragePercent:
        standingsExpectedTeams > 0
          ? this.percent(standingTeamsCovered, standingsExpectedTeams)
          : 0,
      latestCollectedAt: this.toIso(standingAggregate.latestCollectedAt),
    };

    const newsAggregate = newsAggregates.get(context.key);
    const news = {
      total: newsAggregate?.total ?? 0,
      last24Hours: newsAggregate?.last24Hours ?? 0,
      latestPublishedAt: this.toIso(newsAggregate?.latestPublishedAt),
      latestCollectedAt: this.toIso(newsAggregate?.latestCollectedAt),
    };

    const upcoming = this.buildUpcomingSummary(
      context,
      upcomingFixtures,
      upcomingIndexes,
    );

    const queue = this.toQueueSummary(queueAggregates.get(context.key));

    const sync = this.toSyncSummary(syncAggregates.get(context.key));

    const latestFixtureCollectedAt = fixtureSummary.latestCollectedAt;

    const staleCutoff = new Date(
      Date.now() - STALE_ACTIVE_LEAGUE_HOURS * 60 * 60 * 1000,
    );

    const stale =
      !latestFixtureCollectedAt ||
      latestFixtureCollectedAt.getTime() < staleCutoff.getTime();

    const expectedWork: MonitorExpectedWork = {
      finishedFixturesMissingSummary: fixtureSummary.finishedMissingSummary,

      upcomingFixturesMissingSummary: upcoming.missingSummary,

      staleActiveLeagues: stale ? 1 : 0,

      upcomingFixturesMissingOdds: upcoming.fixtures.filter(
        (fixture) => fixture.sources.oddsMatchable && !fixture.sources.odds,
      ).length,

      standingsMissingTeams: standings.missingTeams,

      postMatchFixturesMissingFinalResult:
        fixtureSummary.postMatchMissingFinalResult,

      staleUpcomingStatusFixtures: fixtureSummary.staleUpcomingStatus,
    };

    return {
      competitionId: competition.competitionId,

      espnLeagueSlug: competition.espnLeagueSlug,

      name: competition.name,

      type: String(competition.type),

      region: String(competition.region),

      priority: String(competition.priority),

      status: String(competition.status),

      season: competition.season,

      seasonStartDate: this.toIso(competition.seasonStartDate),

      seasonEndDate: this.toIso(competition.seasonEndDate),

      nextFixtureDate: this.toIso(competition.nextFixtureDate),

      lastFixtureDate: this.toIso(competition.lastFixtureDate),

      catalogue: {
        exists: Boolean(catalogue),

        name: catalogue?.name,

        country: catalogue?.country,

        isActive: catalogue?.isActive,

        isPriority: catalogue?.isPriority,

        lastSyncedAt: this.toIso(catalogue?.lastSyncedAt),

        detailLastSyncedAt: this.toIso(catalogue?.detailLastSyncedAt),
      },

      fixtures: {
        total: fixtureSummary.total,

        upcoming: fixtureSummary.upcoming,

        live: fixtureSummary.live,

        finished: fixtureSummary.finished,

        finishedWithSummary: fixtureSummary.finishedWithSummary,

        finishedMissingSummary: fixtureSummary.finishedMissingSummary,

        postMatchMissingFinalResult: fixtureSummary.postMatchMissingFinalResult,

        staleUpcomingStatus: fixtureSummary.staleUpcomingStatus,

        withSummary: fixtureSummary.withSummary,

        missingSummary: fixtureSummary.missingSummary,

        summaryCoveragePercent: fixtureSummary.summaryCoveragePercent,

        latestCollectedAt: this.toIso(fixtureSummary.latestCollectedAt),

        latestSummaryCollectedAt: this.toIso(
          fixtureSummary.latestSummaryCollectedAt,
        ),

        storedSeasons: fixtureSummary.storedSeasons,
      },

      teams: {
        documents: teamSummary.documents,

        distinctTeams: teamSummary.teamIds.size,

        expectedCurrentSeasonTeams: expectedTeams,

        missingCurrentSeasonTeams: Math.max(0, expectedTeams - teamsCovered),

        coveragePercent:
          expectedTeams > 0 ? this.percent(teamsCovered, expectedTeams) : 0,

        latestCollectedAt: this.toIso(teamSummary.latestCollectedAt),
      },

      standings,

      news,

      upcoming,

      queue,

      sync,

      expectedWork,
    };
  }

  // ============================================================
  // UPCOMING READINESS
  // ============================================================

  private buildUpcomingSummary(
    context: LeagueContext,
    allFixtures: EspnFixtureDocument[],
    indexes: UpcomingIndexes,
  ): MonitorUpcomingSummary {
    const fixtures = allFixtures.filter(
      (fixture) =>
        context.aliases.includes(this.normalize(fixture.leagueId)) &&
        fixture.season === context.season,
    );

    const readiness = fixtures.map((fixture): MonitorUpcomingFixture => {
      const hasSummary = Boolean(
        fixture.eventId && indexes.summaries.has(fixture.eventId),
      );

      const hasOdds = Boolean(
        fixture.eventId && indexes.odds.has(fixture.eventId),
      );

      const oddsMatchable = Boolean(context.competition.oddsApiSportKey);

      const missingSources: string[] = [];

      if (!hasSummary) {
        missingSources.push('summary');
      }

      if (oddsMatchable && !hasOdds) {
        missingSources.push('odds');
      }

      const ready = hasSummary && (!oddsMatchable || hasOdds);

      let status: 'READY' | 'PARTIAL' | 'MISSING';

      if (ready) {
        status = 'READY';
      } else if (hasSummary || hasOdds) {
        status = 'PARTIAL';
      } else {
        status = 'MISSING';
      }

      return {
        eventId: String(fixture.eventId),

        fixtureDate: this.toIso(fixture.fixtureDate) ?? '',

        homeTeamId: fixture.homeTeamId,

        awayTeamId: fixture.awayTeamId,

        homeTeamName: this.extractFixtureTeamName(fixture, 'home'),

        awayTeamName: this.extractFixtureTeamName(fixture, 'away'),

        sources: {
          espnFixture: true,

          summary: hasSummary,

          odds: hasOdds,

          oddsMatchable,
        },

        status,

        missingSources,
      };
    });

    const withSummary = readiness.filter(
      (fixture) => fixture.sources.summary,
    ).length;

    const missingSummary = readiness.length - withSummary;

    const withOdds = readiness.filter((fixture) => fixture.sources.odds).length;

    const ready = readiness.filter(
      (fixture) => fixture.status === 'READY',
    ).length;

    const partial = readiness.filter(
      (fixture) => fixture.status === 'PARTIAL',
    ).length;

    const missing = readiness.filter(
      (fixture) => fixture.status === 'MISSING',
    ).length;

    return {
      total: readiness.length,

      ready,

      partial,

      missing,

      withSummary,

      missingSummary,

      withOdds,

      nextFixtureDate: readiness[0]?.fixtureDate,

      fixtures: readiness,
    };
  }

  // ============================================================
  // PROVIDERS
  // ============================================================

  private async buildProviderSummaries(): Promise<MonitorProviderSummary[]> {
    const providers = Object.keys(
      PROVIDER_CONFIG,
    ) as ConfiguredSportsProvider[];

    // Providers are independent; do not wait for one provider's telemetry before
    // starting the next provider's queries.
    return Promise.all(
      providers.map(async (provider): Promise<MonitorProviderSummary> => {
        const config = PROVIDER_CONFIG[provider];
        const [
          dailyRequests,
          monthlyRequests,
          remainingDailyRequests,
          remainingMonthlyRequests,
          providerState,
          endpointDocuments,
        ] = await Promise.all([
          this.providerRateLimitService.getDailyUsage(provider),
          this.providerRateLimitService.getMonthlyUsage(provider),
          this.providerRateLimitService.getRemainingDailyRequests(provider),
          this.providerRateLimitService.getRemainingMonthlyRequests(provider),
          this.providerRateLimitService.getProviderState(provider),
          this.sportsProviderRateLimitModel
            .find({ provider, endpoint: { $ne: '__provider_quota__' } })
            .sort({ endpoint: 1 })
            .lean()
            .exec(),
        ]);

        const periods = providerState as unknown as
          | ProviderStatePeriods
          | null
          | undefined;

        const endpoints = endpointDocuments.map((document) => ({
          endpoint: document.endpoint,
          dailyRequests: Number(document.dailyRequests ?? 0),
          monthlyRequests: Number(document.monthlyRequests ?? 0),
          lastRequestAt: this.toIso(document.lastRequestAt),
          lockedUntil: this.toIso(document.lockedUntil),
        }));

        const activeLocks = endpoints.filter(
          (endpoint) =>
            endpoint.lockedUntil &&
            new Date(endpoint.lockedUntil).getTime() > Date.now(),
        ).length;

        const latestEndpointRequest = endpoints
          .map((endpoint) =>
            endpoint.lastRequestAt
              ? new Date(endpoint.lastRequestAt)
              : undefined,
          )
          .filter((value): value is Date => Boolean(value))
          .sort((a, b) => b.getTime() - a.getTime())[0];

        return {
          provider,
          limits: {
            minIntervalSeconds: config.minIntervalSeconds,
            dailyRequestLimit: config.dailyRequestLimit,
            monthlyRequestLimit: config.monthlyRequestLimit,
          },
          usage: {
            dailyRequests: Number(dailyRequests ?? 0),
            monthlyRequests: Number(monthlyRequests ?? 0),
            remainingDailyRequests: remainingDailyRequests ?? null,
            remainingMonthlyRequests: remainingMonthlyRequests ?? null,
            dailyPeriod: this.toIso(periods?.dailyPeriod),
            monthlyPeriod: this.toIso(periods?.monthlyPeriod),
            lastRequestAt: latestEndpointRequest?.toISOString(),
            activeLocks,
          },
          endpoints,
          telemetry: {
            historicalRequestEventsAvailable: false,
            historicalRateByHourAvailable: false,
            historicalRateByLeagueAvailable: false,
            note: 'Provider telemetry is read directly from the current rate-limit records.',
          },
        };
      }),
    );
  }

  // ============================================================
  // EXPECTED WORK
  // ============================================================

  private buildPipelineDefinitions(
    sync: MonitorSyncSummary,
  ): Record<string, MonitorPipelineDefinition> {
    const stateCounts = this.getPipelineStateCounts(sync);

    return {
      [EspnQueueJobType.FIXTURE_REFRESH]: {
        stages: ['DATE_WINDOW', 'FIXTURES', 'TEAMS'],

        operations: {
          DATE_WINDOW: {
            source: 'QUEUE',

            operation:
              'Track the rolling ESPN fixture window from today through today+8 days.',
          },

          FIXTURES: {
            source: 'ESPN',

            operation:
              'Collect ESPN scoreboard fixtures and upsert them into sports_espn_fixtures while preserving stored Summary data.',
          },

          TEAMS: {
            source: 'ESPN',

            operation:
              'Persist league-scoped ESPN team identities discovered in scoreboard responses.',
          },
        },

        stateCounts: stateCounts[EspnQueueJobType.FIXTURE_REFRESH] ?? {},
      },

      [EspnQueueJobType.SUMMARY_REFRESH]: {
        stages: ['SUMMARY', 'YOUTUBE'],

        operations: {
          SUMMARY: {
            source: 'ESPN',

            operation:
              'Fetch ESPN Summary and persist it under sports_espn_fixtures.payload.summary.',
          },

          YOUTUBE: {
            source: 'YOUTUBE',

            operation:
              'Search directly for a finished-match highlight without a separate YouTube queue.',
            conditional: true,
          },
        },

        stateCounts: stateCounts[EspnQueueJobType.SUMMARY_REFRESH] ?? {},
      },
    };
  }

  private getPipelineStateCounts(
    sync: MonitorSyncSummary,
  ): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = {};

    for (const stage of sync.currentStages) {
      const jobType = stage.jobType ?? 'UNKNOWN';

      if (!result[jobType]) {
        result[jobType] = {};
      }

      result[jobType][stage.status] =
        (result[jobType][stage.status] ?? 0) + stage.count;
    }

    return result;
  }

  // ============================================================
  // QUEUE CONVERSION
  // ============================================================

  private toQueueSummary(aggregate?: QueueAggregate): MonitorQueueSummary {
    if (!aggregate) {
      return {
        total: 0,

        pending: 0,

        processing: 0,

        completedRetained: 0,

        failed: 0,

        retryLaneJobs: 0,

        quarantinedJobs: 0,

        staleProcessing: 0,

        completedRetentionDays: QUEUE_COMPLETED_RETENTION_DAYS,

        byType: {},

        byTypeAndStatus: [],
      };
    }

    const byType: Record<string, number> = {};

    for (const [type, count] of aggregate.byType) {
      byType[type] = count;
    }

    const byTypeAndStatus: MonitorQueueItem[] = [];

    for (const [compoundKey, count] of aggregate.byTypeAndStatus) {
      const separator = compoundKey.indexOf(':');

      byTypeAndStatus.push({
        type: separator >= 0 ? compoundKey.slice(0, separator) : compoundKey,

        status: separator >= 0 ? compoundKey.slice(separator + 1) : 'UNKNOWN',

        count,
      });
    }

    return {
      total: aggregate.total,

      pending: aggregate.byStatus.get(EspnQueueStatus.PENDING) ?? 0,

      processing: aggregate.byStatus.get(EspnQueueStatus.PROCESSING) ?? 0,

      completedRetained: aggregate.byStatus.get(EspnQueueStatus.COMPLETED) ?? 0,

      failed: aggregate.byStatus.get(EspnQueueStatus.FAILED) ?? 0,

      retryLaneJobs: 0,

      quarantinedJobs: 0,

      staleProcessing: aggregate.staleProcessing,

      completedRetentionDays: QUEUE_COMPLETED_RETENTION_DAYS,

      byType,

      byTypeAndStatus,

      latestFailureAt: this.toIso(aggregate.latestFailureAt),

      latestFailure: aggregate.latestFailure,

      latestCompletedAt: this.toIso(aggregate.latestCompletedAt),
    };
  }

  // ============================================================
  // SYNC CONVERSION
  // ============================================================

  private toSyncSummary(aggregate?: SyncAggregate): MonitorSyncSummary {
    if (!aggregate) {
      return {
        totalStates: 0,

        queueStates: 0,

        cronStates: 0,

        byStatus: {},

        unitProgress: {
          total: 0,
          success: 0,
          processing: 0,
          pending: 0,
          failed: 0,
          completionPercent: 0,
        },

        stateCompletionPercent: 0,

        currentStages: [],

        failures: [],

        cron: [],

        states: [],
      };
    }

    const totalStates = Object.values(aggregate.stateCounts).reduce(
      (sum, value) => sum + value,
      0,
    );

    const successfulStates =
      aggregate.stateCounts[SportsSyncStateStatus.SUCCESS] ?? 0;

    return {
      totalStates,

      queueStates: aggregate.queueStates,

      cronStates: aggregate.cronStates,

      byStatus: aggregate.stateCounts,

      unitProgress: {
        ...aggregate.unitProgress,

        completionPercent:
          aggregate.unitProgress.total > 0
            ? this.percent(
                aggregate.unitProgress.success,
                aggregate.unitProgress.total,
              )
            : 0,
      },

      stateCompletionPercent:
        totalStates > 0 ? this.percent(successfulStates, totalStates) : 0,

      currentStages: aggregate.currentStages,

      failures: aggregate.failures.slice(0, 50),

      cron: aggregate.cron,

      states: aggregate.states,

      latestSuccessfulAt: this.toIso(aggregate.latestSuccessfulAt),

      latestCompletedAt: this.toIso(aggregate.latestCompletedAt),

      nextRunAt: this.toIso(aggregate.nextRunAt),
    };
  }

  // ============================================================
  // SYNC STATE DETAIL
  // ============================================================

  private buildSyncStateDetail(
    state: MonitorSyncStateRecord,
    leagueName: string | undefined,
    now: Date,
  ): MonitorSyncStateDetail {
    const units = state.units ?? [];

    let success = 0;

    let processing = 0;

    let pending = 0;

    let failed = 0;

    let monthUnits = 0;

    let dateUnits = 0;

    let stepUnits = 0;

    const durationsMs: number[] = [];

    let currentProcessingElapsedSeconds: number | undefined;

    for (const unit of units) {
      const unitType = String(unit.type).toUpperCase();

      if (unitType === 'MONTH') {
        monthUnits += 1;
      }

      if (unitType === 'DATE') {
        dateUnits += 1;
      }

      if (unitType === 'STEP') {
        stepUnits += 1;
      }

      switch (unit.status) {
        case SportsSyncUnitStatus.SUCCESS: {
          success += 1;

          if (unit.startedAt && unit.completedAt) {
            const startedAt = new Date(unit.startedAt).getTime();

            const completedAt = new Date(unit.completedAt).getTime();

            const durationMs = completedAt - startedAt;

            if (durationMs > 0) {
              durationsMs.push(durationMs);
            }
          }

          break;
        }

        case SportsSyncUnitStatus.PROCESSING: {
          processing += 1;

          if (unit.startedAt) {
            const startedAt = new Date(unit.startedAt).getTime();

            const elapsedSeconds = Math.max(
              0,
              (now.getTime() - startedAt) / 1000,
            );

            if (
              currentProcessingElapsedSeconds === undefined ||
              elapsedSeconds > currentProcessingElapsedSeconds
            ) {
              currentProcessingElapsedSeconds = elapsedSeconds;
            }
          }

          break;
        }

        case SportsSyncUnitStatus.PENDING:
          pending += 1;
          break;

        case SportsSyncUnitStatus.FAILED:
          failed += 1;
          break;
      }
    }

    const total = units.length;

    const completionPercent = total > 0 ? this.percent(success, total) : 0;

    const averageDurationMs =
      durationsMs.length > 0
        ? durationsMs.reduce((sum, value) => sum + value, 0) /
          durationsMs.length
        : undefined;

    const averageSecondsPerUnit =
      averageDurationMs !== undefined
        ? Number((averageDurationMs / 1000).toFixed(2))
        : undefined;

    const unitsPerMinute =
      averageSecondsPerUnit !== undefined && averageSecondsPerUnit > 0
        ? Number((60 / averageSecondsPerUnit).toFixed(2))
        : undefined;

    const remainingUnits = Math.max(0, total - success);

    const remainingSeconds =
      averageSecondsPerUnit !== undefined && remainingUnits > 0
        ? Number((remainingUnits * averageSecondsPerUnit).toFixed(2))
        : undefined;

    const estimatedCompletionAt =
      remainingSeconds !== undefined && remainingSeconds > 0
        ? new Date(now.getTime() + remainingSeconds * 1000)
        : undefined;

    return {
      stateKey: state.stateKey,

      kind: String(state.kind),

      leagueId: state.leagueId,

      leagueName,

      season: state.season,

      jobType: state.jobType,

      status: String(state.status),

      trackingMode: state.trackingMode,

      fixtureGranularity: state.fixtureGranularity,

      dateFrom: state.dateFrom,

      dateTo: state.dateTo,

      unitProgress: {
        total,

        monthUnits,

        dateUnits,

        stepUnits,

        success,

        processing,

        pending,

        failed,

        completionPercent,
      },

      timing: {
        sampleCount: durationsMs.length,

        averageSecondsPerUnit,

        unitsPerMinute,

        currentProcessingElapsedSeconds:
          currentProcessingElapsedSeconds !== undefined
            ? Number(currentProcessingElapsedSeconds.toFixed(2))
            : undefined,
      },

      estimate: {
        remainingUnits,

        remainingSeconds,

        estimatedCompletionAt: this.toIso(estimatedCompletionAt),
      },

      lastStartedAt: this.toIso(state.lastStartedAt),

      lastCompletedAt: this.toIso(state.lastCompletedAt),
    };
  }

  private groupSyncStages(
    stages: MonitorSyncStageSummary[],
  ): MonitorSyncStageSummary[] {
    const grouped = new Map<string, MonitorSyncStageSummary>();

    for (const stage of stages) {
      const key = [
        stage.jobType ?? 'UNKNOWN',
        stage.stage,
        stage.unitType,
        stage.status,
      ].join(':');

      const existing = grouped.get(key);

      if (existing) {
        existing.count += stage.count;
      } else {
        grouped.set(key, {
          ...stage,
        });
      }
    }

    return [...grouped.values()];
  }

  // ============================================================
  // EXPECTED WORK
  // ============================================================

  private sumExpectedWork(items: MonitorExpectedWork[]): MonitorExpectedWork {
    return items.reduce(
      (total, item) => ({
        finishedFixturesMissingSummary:
          total.finishedFixturesMissingSummary +
          item.finishedFixturesMissingSummary,

        upcomingFixturesMissingSummary:
          total.upcomingFixturesMissingSummary +
          item.upcomingFixturesMissingSummary,

        staleActiveLeagues: total.staleActiveLeagues + item.staleActiveLeagues,

        upcomingFixturesMissingOdds:
          total.upcomingFixturesMissingOdds + item.upcomingFixturesMissingOdds,

        standingsMissingTeams:
          total.standingsMissingTeams + item.standingsMissingTeams,

        postMatchFixturesMissingFinalResult:
          total.postMatchFixturesMissingFinalResult +
          item.postMatchFixturesMissingFinalResult,

        staleUpcomingStatusFixtures:
          total.staleUpcomingStatusFixtures + item.staleUpcomingStatusFixtures,
      }),

      this.emptyExpectedWork(),
    );
  }

  private emptyExpectedWork(): MonitorExpectedWork {
    return {
      finishedFixturesMissingSummary: 0,

      upcomingFixturesMissingSummary: 0,

      staleActiveLeagues: 0,

      upcomingFixturesMissingOdds: 0,

      standingsMissingTeams: 0,

      postMatchFixturesMissingFinalResult: 0,

      staleUpcomingStatusFixtures: 0,
    };
  }

  // ============================================================
  // ARCHITECTURE NOTES
  // ============================================================

  private getArchitectureNotes() {
    return {
      activeCompetitionSourceOfTruth:
        'sports_active_competitions defines the operational competition set used by startup, fixture collection and the normal queue.',

      catalogueRole:
        'sports_espn_leagues stores the complete ESPN catalogue, including active and inactive leagues. ActiveCompetition remains the operational source of truth.',

      fixtureStorageModel:
        'ESPN scoreboard fixtures are stored canonically in sports_espn_fixtures. Fixture payloads preserve the provider event data and stored Summary data.',

      summaryStorageModel:
        'ESPN Summary is stored inside sports_espn_fixtures.payload.summary with payload.summaryCollectedAt. No separate Summary collection is used.',

      fixtureRefreshModel:
        'FIXTURE_REFRESH maintains the rolling eight-day ESPN fixture window. The near-term first three days refresh every six hours, the outer days refresh daily, and the far edge extends daily. Post-match event dates receive their own kickoff+160-minute refresh and bounded result checkpoints.',

      summaryRefreshModel:
        'SUMMARY_REFRESH is event-specific. Upcoming Summary refreshes use the configured rolling window; post-match checks run at kickoff +160 minutes and at bounded +4h, +6h, +12h and +24h checkpoints while the canonical result remains incomplete. A rotating indexed integrity scan checks recent fixtures and queues only missing/inconsistent records.',

      queueHistoryWindow:
        'Completed ESPN queue documents are retained as operational history for seven days before cleanup.',

      syncProgressSource:
        'sports_sync_states.units[] is the source of detailed date/step progress. Queue types are FIXTURE_REFRESH and SUMMARY_REFRESH.',

      providerTelemetryLimit:
        'Current provider telemetry contains usage totals, endpoint usage, last requests and current locks. It does not contain immutable outbound request events.',

      oddsMatchingLimit:
        'The monitor treats an exact stored Sports Odds Snapshot eventId as confirmed odds availability. A missing exact eventId is reported as missing odds only for competitions that have an Odds API sport key.',
    };
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private normalize(value?: string): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  private percent(numerator: number, denominator: number): number {
    if (denominator <= 0 || numerator <= 0) {
      return 0;
    }

    return Number(((numerator / denominator) * 100).toFixed(2));
  }

  private toIso(value?: Date | string | null): string | undefined {
    if (!value) {
      return undefined;
    }

    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
      return undefined;
    }

    return date.toISOString();
  }

  private extractFixtureTeamName(
    fixture: EspnFixtureDocument,
    side: 'home' | 'away',
  ): string | undefined {
    const payload =
      fixture.payload && typeof fixture.payload === 'object'
        ? fixture.payload
        : {};

    const payloadRecord = payload as Record<string, unknown>;
    const competitions = Array.isArray(payloadRecord.competitions)
      ? payloadRecord.competitions
      : [];

    const competition =
      competitions[0] && typeof competitions[0] === 'object'
        ? (competitions[0] as Record<string, unknown>)
        : undefined;

    const competitors: unknown[] = Array.isArray(competition?.competitors)
      ? (competition.competitors as unknown[])
      : [];

    const competitor =
      competitors.find(
        (item) =>
          item &&
          typeof item === 'object' &&
          (item as Record<string, unknown>).homeAway === side,
      ) ?? competitors[side === 'home' ? 0 : 1];

    if (!competitor || typeof competitor !== 'object') {
      return undefined;
    }

    const record = competitor as Record<string, unknown>;

    const team =
      record.team && typeof record.team === 'object'
        ? (record.team as Record<string, unknown>)
        : record;

    return (
      (typeof team.displayName === 'string' ? team.displayName : undefined) ??
      (typeof team.name === 'string' ? team.name : undefined) ??
      (typeof team.shortDisplayName === 'string'
        ? team.shortDisplayName
        : undefined)
    );
  }
}
