export interface SportsSystemMonitorQuery {
  leagueId?: string;
}

// ============================================================
// FIXTURES
// ============================================================

export interface MonitorFixtureSummary {
  total: number;

  upcoming: number;

  live: number;

  finished: number;

  withSummary: number;

  missingSummary: number;

  summaryCoveragePercent: number;

  latestCollectedAt?: string;

  latestSummaryCollectedAt?: string;

  storedSeasons: number;
}

// ============================================================
// TEAMS
// ============================================================

export interface MonitorTeamSummary {
  documents: number;

  distinctTeams: number;

  expectedCurrentSeasonTeams: number;

  missingCurrentSeasonTeams: number;

  coveragePercent: number;

  latestCollectedAt?: string;
}

// ============================================================
// QUEUE
// ============================================================

export interface MonitorQueueItem {
  type: string;

  status: string;

  count: number;
}

export interface MonitorQueueSummary {
  total: number;

  pending: number;

  processing: number;

  completedRetained: number;

  failed: number;

  staleProcessing: number;

  completedRetentionDays: number;

  byType: Record<string, number>;

  byTypeAndStatus: MonitorQueueItem[];

  latestFailureAt?: string;

  latestFailure?: string;

  latestCompletedAt?: string;
}

// ============================================================
// SYNC
// ============================================================

export interface MonitorSyncStageSummary {
  jobType?: string;

  stage: string;

  unitType: string;

  status: string;

  count: number;
}

export interface MonitorSyncFailure {
  stateKey: string;

  jobType?: string;

  leagueId?: string;

  season?: number;

  eventId?: string;

  error?: string;

  at?: string;

  consecutiveFailures: number;
}

export interface MonitorCronState {
  stateKey: string;

  taskKey?: string;

  status: string;

  cronExpression?: string;

  timeZone?: string;

  lastStartedAt?: string;

  lastSuccessfulAt?: string;

  lastCompletedAt?: string;

  nextRunAt?: string;

  consecutiveFailures: number;

  lastError?: string;
}

export interface MonitorSyncStateDetail {
  stateKey: string;

  kind: string;

  leagueId?: string;

  leagueName?: string;

  season?: number;

  jobType?: string;

  status: string;

  trackingMode?: string;

  dateFrom?: string;

  dateTo?: string;

  unitProgress: {
    total: number;

    dateUnits: number;

    stepUnits: number;

    success: number;

    processing: number;

    pending: number;

    failed: number;

    completionPercent: number;
  };

  timing: {
    sampleCount: number;

    averageSecondsPerUnit?: number;

    unitsPerMinute?: number;

    currentProcessingElapsedSeconds?: number;
  };

  estimate: {
    remainingUnits: number;

    remainingSeconds?: number;

    estimatedCompletionAt?: string;
  };

  lastStartedAt?: string;

  lastCompletedAt?: string;
}

export interface MonitorSyncSummary {
  totalStates: number;

  queueStates: number;

  cronStates: number;

  byStatus: Record<string, number>;

  unitProgress: {
    total: number;

    success: number;

    processing: number;

    pending: number;

    failed: number;

    completionPercent: number;
  };

  stateCompletionPercent: number;

  currentStages: MonitorSyncStageSummary[];

  failures: MonitorSyncFailure[];

  cron: MonitorCronState[];

  states: MonitorSyncStateDetail[];

  latestSuccessfulAt?: string;

  latestCompletedAt?: string;

  nextRunAt?: string;
}

// ============================================================
// EXPECTED WORK
// ============================================================

export interface MonitorExpectedWork {
  /**
   * Completed fixtures that still do not contain
   * payload.summary.
   */
  finishedFixturesMissingSummary: number;

  /**
   * Upcoming fixtures inside the normal four-day Summary
   * window that do not yet contain payload.summary.
   */
  upcomingFixturesMissingSummary: number;

  /**
   * Active leagues whose fixture collection is older
   * than the 48-hour freshness threshold.
   */
  staleActiveLeagues: number;

  /**
   * Upcoming fixtures without a corresponding Odds API
   * record where odds collection is enabled.
   */
  upcomingFixturesMissingOdds: number;
}

// ============================================================
// READINESS
// ============================================================

export type MonitorReadinessStatus = 'READY' | 'PARTIAL' | 'MISSING';

// ============================================================
// UPCOMING FIXTURES
// ============================================================

export interface MonitorUpcomingFixture {
  eventId: string;

  fixtureDate: string;

  homeTeamId?: string;

  awayTeamId?: string;

  homeTeamName?: string;

  awayTeamName?: string;

  sources: {
    espnFixture: boolean;

    summary: boolean;

    odds: boolean;

    oddsMatchable: boolean;
  };

  status: MonitorReadinessStatus;

  missingSources: string[];
}

export interface MonitorUpcomingSummary {
  total: number;

  ready: number;

  partial: number;

  missing: number;

  withSummary: number;

  missingSummary: number;

  withOdds: number;

  nextFixtureDate?: string;

  fixtures: MonitorUpcomingFixture[];
}

// ============================================================
// PIPELINE
// ============================================================

export interface MonitorPipelineDefinition {
  stages: string[];

  operations: Record<
    string,
    {
      source: 'ESPN' | 'ODDS_API' | 'YOUTUBE' | 'QUEUE' | 'APPLICATION';

      operation: string;

      conditional?: boolean;

      note?: string;
    }
  >;

  stateCounts: Record<string, number>;
}

// ============================================================
// PROVIDERS
// ============================================================

export interface MonitorProviderSummary {
  provider: string;

  limits: {
    minIntervalSeconds: number;

    dailyRequestLimit: number | null;

    monthlyRequestLimit: number | null;
  };

  usage: {
    dailyRequests: number;

    monthlyRequests: number;

    remainingDailyRequests: number | null;

    remainingMonthlyRequests: number | null;

    dailyPeriod?: string;

    monthlyPeriod?: string;

    lastRequestAt?: string;

    activeLocks: number;
  };

  endpoints: Array<{
    endpoint: string;

    dailyRequests: number;

    monthlyRequests: number;

    lastRequestAt?: string;

    lockedUntil?: string;
  }>;

  telemetry: {
    historicalRequestEventsAvailable: boolean;

    historicalRateByHourAvailable: boolean;

    historicalRateByLeagueAvailable: boolean;

    note: string;
  };
}

// ============================================================
// INVENTORY
// ============================================================

export interface MonitorInventory {
  activeCompetitions: number;

  espnCatalogue: number;

  espnFixtures: number;

  espnTeams: number;

  /**
   * Retained for inventory visibility only.
   *
   * Standings are no longer part of the normal ESPN
   * match synchronization pipeline.
   */
  espnStandings: number;

  /**
   * Retained for inventory visibility only.
   *
   * News is no longer part of the normal scheduled ESPN
   * synchronization pipeline.
   */
  espnNews: number;

  espnQueue: number;

  sportsSyncStates: number;

  footballDataCompetitions: number;

  footballDataMatches: number;

  footballDataStandings: number;

  footballDataTeams: number;

  oddsApiSports: number;

  sportsOddsSnapshots: number;

  youtubeHighlights: number;
}

// ============================================================
// LEAGUE SUMMARY
// ============================================================

export interface MonitorLeagueSummary {
  competitionId: string;

  espnLeagueSlug: string;

  name: string;

  type: string;

  region: string;

  priority: string;

  status: string;

  season?: number;

  seasonStartDate?: string;

  seasonEndDate?: string;

  nextFixtureDate?: string;

  lastFixtureDate?: string;

  catalogue: {
    exists: boolean;

    name?: string;

    country?: string;

    isActive?: boolean;

    isPriority?: boolean;

    lastSyncedAt?: string;

    detailLastSyncedAt?: string;
  };

  fixtures: MonitorFixtureSummary;

  teams: MonitorTeamSummary;

  upcoming: MonitorUpcomingSummary;

  queue: MonitorQueueSummary;

  sync: MonitorSyncSummary;

  expectedWork: MonitorExpectedWork;
}

// ============================================================
// SYSTEM RESPONSE
// ============================================================

export interface SportsSystemMonitorResponse {
  generatedAt: string;

  scope: {
    activeLeagueFilter?: string;

    activeCompetitions: number;

    catalogueCompetitions: number;

    operationalSeasonScope: boolean;
  };

  inventory: MonitorInventory;

  queue: MonitorQueueSummary;

  sync: MonitorSyncSummary;

  pipeline: Record<string, MonitorPipelineDefinition>;

  providers: MonitorProviderSummary[];

  expectedWork: MonitorExpectedWork;

  leagues: MonitorLeagueSummary[];

  architectureNotes: {
    activeCompetitionSourceOfTruth: string;

    catalogueRole: string;

    fixtureStorageModel: string;

    summaryStorageModel: string;

    fixtureRefreshModel: string;

    summaryRefreshModel: string;

    queueHistoryWindow: string;

    syncProgressSource: string;

    providerTelemetryLimit: string;

    oddsMatchingLimit: string;
  };
}
