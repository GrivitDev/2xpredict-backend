export const YOUTUBE_CONFIG = {
  apiBaseUrl: 'https://www.googleapis.com/youtube/v3',

  /** YouTube Data API searches only return video results. */
  searchType: 'video',

  /**
   * The maximum accepted publication window after the scheduled kickoff.
   * The search job itself is queued after the fixture is confirmed completed.
   */
  defaultSearchWindowMinutes: 20,
  highlightWindowHours: 24,

  /**
   * Durable, one-search-per-stage workflow measured from full-time detection.
   * The search plan can include the competition channel, both clubs' channels,
   * four general fallbacks, and a final unrestricted search. The queue builder
   * still stops attempts when the fixture's kickoff + 24h window expires.
   */
  searchWorkflow: {
    maximumRequestsPerFixture: 9,
    attemptOffsetsMinutes: [10, 30, 60, 120, 240, 360, 540, 720, 960] as const,
    maximumFallbackChannels: 4,
  },

  /** Search only for videos that YouTube marks as embeddable/syndicated. */
  requireEmbeddable: true,
} as const;

export type YoutubeConfig = typeof YOUTUBE_CONFIG;
