/**
 * Runtime provider limits used by the normalized Sports Module only.
 * Collection cadence belongs in sports-collection-schedule.config.ts and
 * provider retry limits live with each provider client.
 */
export const SPORTS_DATA_COLLECTION_CONFIG = {
  ESPN: {
    enabled: true,
    rateLimit: {
      // Bounded parallel transport: 15 ordinary ESPN requests plus 3
      // reserved live-scoreboard requests may be in flight per backend process.
      // A shared 200ms start interval caps aggregate starts at about 5/sec.
      minIntervalSeconds: 0.2,
      normalConcurrency: 15,
      liveConcurrency: 3,
    },
  },
  YOUTUBE: {
    enabled: true,
    // Google currently grants 100 search.list calls per quota day by default.
    // Keep an internal ceiling of 90 to preserve a safety margin.
    dailyRequestLimit: 90,
    // YouTube resets daily quota at midnight Pacific Time, not Nigeria time.
    dailyQuotaTimeZone: 'America/Los_Angeles',
    rateLimit: {
      minIntervalSeconds: 200,
    },
  },
} as const;

export type SportsDataCollectionConfig = typeof SPORTS_DATA_COLLECTION_CONFIG;

