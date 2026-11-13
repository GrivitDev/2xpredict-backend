export const YOUTUBE_CONFIG = {
  apiBaseUrl: 'https://www.googleapis.com/youtube/v3',
  searchType: 'video',

  /** Accept highlights published from kickoff through the next 24 hours. */
  highlightWindowHours: 24,

  /** Only these 15 high-following domestic leagues receive highlight searches. */
  supportedCompetitionSlugs: [
    'eng.1', // Premier League
    'esp.1', // La Liga
    'ita.1', // Serie A
    'ger.1', // Bundesliga
    'fra.1', // Ligue 1
    'ned.1', // Eredivisie
    'por.1', // Primeira Liga
    'usa.1', // MLS
    'ksa.1', // Saudi Pro League
    'bra.1', // Brazil Serie A
    'arg.1', // Argentina Primera
    'mex.1', // Liga MX
    'sco.1', // Scottish Premiership
    'tur.1', // Turkish Super Lig
    'nga.1', // Nigeria Professional Football League
  ] as const,

  /**
   * Four total requests per fixture: an initial search, then retries beginning
   * at one hour. The fourth search is unrestricted by channel; the first three
   * follow the competition/club/fallback channel priority order.
   */
  searchWorkflow: {
    maximumRequestsPerFixture: 4,
    attemptOffsetsMinutes: [10, 70, 130, 190] as const,
    maximumFallbackChannels: 4,
  },

  requireEmbeddable: true,
} as const;

export type YoutubeConfig = typeof YOUTUBE_CONFIG;
