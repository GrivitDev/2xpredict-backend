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
    // Shared MongoDB quota reservation hard-stops search.list at 90/day,
    // leaving headroom below the requested absolute ceiling of 95.
    dailyRequestLimit: 90,
    rateLimit: {
      minIntervalSeconds: 200,
    },
  },
} as const;

export type SportsDataCollectionConfig = typeof SPORTS_DATA_COLLECTION_CONFIG;

