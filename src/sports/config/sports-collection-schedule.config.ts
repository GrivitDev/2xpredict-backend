/**
 * ESPN collection cadence. These values are persisted as delayed queue jobs;
 * the module does not register NestJS cron jobs or interval timers.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SPORTS_COLLECTION_SCHEDULE = {
  leagueCatalogue: { enabled: true, intervalMs: 7 * DAY },
  leagueDetails: { enabled: true, intervalMs: 7 * DAY },
  seasonCatalogue: { enabled: true, intervalMs: 7 * DAY },
  teamCatalogue: { enabled: true, intervalMs: 7 * DAY },
  teamDetails: { enabled: true, intervalMs: 30 * DAY },

  /** Monthly scoreboards are a one-time operation for startup/new seasons. */
  monthlyFixtureBootstrap: { enabled: true, intervalMs: 0 },

  /** Date-scoped scoreboard refreshes. */
  fixtureRefresh48Hours: { enabled: true, leadMs: 48 * HOUR },
  fixtureRefresh18Hours: { enabled: true, leadMs: 18 * HOUR },
  fixtureRefreshAfterMatch: { enabled: true, delayMs: 5 * MINUTE },
  summaryAfterMatch: { enabled: true, delayMs: 5 * MINUTE },
  summaryNormalizationRetries: { delaysMs: [15 * MINUTE, HOUR, 6 * HOUR, DAY] },

  /** Historical Summary backfill is deliberately low-priority and keyset-paginated. */
  summaryBackfill: {
    enabled: true,
    pageSize: 50,
    requestSpacingMs: 1_500,
    nextPageDelayMs: 10_000,
    priority: 25,
  },

  /** Match odds are checked at three fixed pre-match checkpoints only. */
  matchOdds48Hours: { enabled: true, leadMs: 48 * HOUR },
  matchOdds24Hours: { enabled: true, leadMs: 24 * HOUR },
  matchOdds18Hours: { enabled: true, leadMs: 18 * HOUR },

  liveScoreboard: { enabled: true, intervalMs: 2 * MINUTE },
  playsAfterMatch: { enabled: true, delayMs: 2 * MINUTE },

  /** ESPN News feeds: general soccer daily; league news around each fixture. */
  soccerNews: { enabled: true, intervalMs: DAY, initialDelayMs: 0 },
  leagueNewsPreMatch: { enabled: true, leadMs: 12 * HOUR },
  leagueNewsAfterMatch: { enabled: true, delayMs: 0 },
  newsCoalesceWindow: { intervalMs: 30 * MINUTE },

  /** Projection work is event-driven; historical fanout is spaced and low-priority. */
  derivedData: {
    enabled: true,
    coalesceWindowMs: 10_000,
    historicalBackfillDelayMs: 5 * MINUTE,
    historicalBackfillSpacingMs: 10_000,
    historicalBackfillPriority: 20,
  },

  /** Small daily batches keep Mongo deletion work bounded. */
  retentionCleanup: { enabled: true, intervalMs: DAY, batchSize: 250 },

  /** Short delay before a bootstrap validation phase checks queued work. */
  bootstrapGate: { enabled: true, intervalMs: 30_000 },
} as const;

export type SportsCollectionScheduleKey =
  keyof typeof SPORTS_COLLECTION_SCHEDULE;

export const SPORTS_COLLECTION_TIME = { MINUTE, HOUR, DAY } as const;
