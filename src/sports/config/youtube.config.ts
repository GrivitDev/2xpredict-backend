/**
 * YouTube highlight collection is limited to 24 domestic leagues.
 *
 * Tier order is also the durable queue priority order. Higher tiers are always
 * claimed before lower tiers when their jobs are due in the YOUTUBE_HIGHLIGHT
 * lane. Priority values deliberately leave gaps for future adjustments.
 */
export const YOUTUBE_LEAGUE_GROUPS = {
  rank1: [
    'eng.1', // English Premier League
    'esp.1', // Spanish La Liga
    'ger.1', // German Bundesliga
    'ita.1', // Italian Serie A
    'fra.1', // French Ligue 1
    'bra.1', // Brazilian Série A
  ],
  rank2: [
    'usa.1', // Major League Soccer
    'mex.1', // Liga MX
    'tur.1', // Turkish Süper Lig
    'por.1', // Portuguese Primeira Liga
    'ned.1', // Dutch Eredivisie
    'eng.2', // English Championship
  ],
  rank3: [
    'arg.1', // Argentine Primera División
    'ksa.1', // Saudi Pro League
    'bel.1', // Belgian Pro League
    'sco.1', // Scottish Premiership
    'nga.1', // Nigerian Professional Football League
    'rsa.1', // South African Premiership
  ],
  rank4: [
    'gre.1', // Greek Super League
    'aut.1', // Austrian Bundesliga
    'den.1', // Danish Superliga
    'nor.1', // Norwegian Eliteserien
    'swe.1', // Swedish Allsvenskan
    'jpn.1', // Japanese J1 League
  ],
} as const;

export const YOUTUBE_LEAGUE_PRIORITY: Readonly<Record<string, number>> = {
  ...Object.fromEntries(YOUTUBE_LEAGUE_GROUPS.rank1.map((slug) => [slug, 40])),
  ...Object.fromEntries(YOUTUBE_LEAGUE_GROUPS.rank2.map((slug) => [slug, 30])),
  ...Object.fromEntries(YOUTUBE_LEAGUE_GROUPS.rank3.map((slug) => [slug, 20])),
  ...Object.fromEntries(YOUTUBE_LEAGUE_GROUPS.rank4.map((slug) => [slug, 10])),
};

export function getYoutubeLeaguePriority(competitionSlug: string): number {
  return YOUTUBE_LEAGUE_PRIORITY[competitionSlug.trim().toLowerCase()] ?? 1;
}

export const YOUTUBE_CONFIG = {
  apiBaseUrl: 'https://www.googleapis.com/youtube/v3',
  searchType: 'video',

  /** Recover missed completed-fixture enqueues for up to 30 days. */
  reconciliationLookbackDays: 30,

  /** The 24-league allowlist is derived from the four ranked groups above. */
  supportedCompetitionSlugs: [
    ...YOUTUBE_LEAGUE_GROUPS.rank1,
    ...YOUTUBE_LEAGUE_GROUPS.rank2,
    ...YOUTUBE_LEAGUE_GROUPS.rank3,
    ...YOUTUBE_LEAGUE_GROUPS.rank4,
  ] as const,

  /**
   * Four searches per fixture: league/club publisher, one fallback publisher,
   * then an unrestricted search. Quota pauses never consume an attempt.
   */
  searchWorkflow: {
    maximumRequestsPerFixture: 4,
    attemptOffsetsMinutes: [10, 60, 240, 720] as const,
    maximumFallbackChannels: 4,
    maxResultsPerSearch: 25,
  },

  requireEmbeddable: true,
} as const;

export type YoutubeConfig = typeof YOUTUBE_CONFIG;
