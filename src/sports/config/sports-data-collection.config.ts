/**
 * Runtime provider limits used by the normalized Sports Module only.
 * Collection cadence belongs in sports-collection-schedule.config.ts and
 * provider retry limits live with each provider client.
 */
export const SPORTS_DATA_COLLECTION_CONFIG = {
  ESPN: {
    enabled: true,
    rateLimit: {
      // Keep provider traffic bounded on the small production instance.
      // Normal and reserved live slots each allow one in-flight request, with
      // at least one second between request starts.
      minIntervalSeconds: 1,
      normalConcurrency: 1,
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
