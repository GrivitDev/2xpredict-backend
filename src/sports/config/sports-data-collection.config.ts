/**
 * Runtime provider limits used by the normalized Sports Module only.
 * Collection cadence belongs in sports-collection-schedule.config.ts and
 * provider retry limits live with each provider client.
 */
export const SPORTS_DATA_COLLECTION_CONFIG = {
  ESPN: {
    enabled: true,
    rateLimit: {
      // ESPN has no published application quota. The client enforces a shared
      // 350ms start interval, two normal in-flight requests and one reserved
      // live-scoreboard request slot.
      minIntervalSeconds: 0.35,
      normalConcurrency: 2,
      liveConcurrency: 1,
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


