/** ESPN Site API V2 and Core API V2 transport configuration. */
export const SPORTS_PROVIDER_CONFIG = {
  espn: {
    coreBaseUrl: 'https://sports.core.api.espn.com/v2/sports/soccer',
    siteBaseUrl: 'https://site.api.espn.com/apis/site/v2/sports/soccer',
    nowNewsBaseUrl: 'https://now.core.api.espn.com/v1/sports/news',
    timeoutMs: 25_000,
    minIntervalMs: 350,
    maxRetries: 4,
    pageSize: 100,
    maxPages: 500,
    referenceConcurrency: 4,
    playsPageSize: 100,
    playsSourceId: '38',
    summaryCacheTtlMs: 60_000,
  },
} as const;

export type SportsProviderConfig = typeof SPORTS_PROVIDER_CONFIG;
