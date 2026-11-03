export enum YoutubeHighlightStatus {
  PENDING = 'pending',
  SEARCHING = 'searching',
  RETRY = 'retry',
  FOUND = 'found',
  FAILED = 'failed',
}

export interface YoutubeHighlight {
  /**
   * Internal fixture identity.
   *
   * This remains one record per fixture.
   */
  fixtureId: string;

  competitionId?: string;

  homeTeam: string;

  awayTeam: string;

  status: YoutubeHighlightStatus;

  /**
   * Number of search attempts already performed.
   */
  retryCount: number;

  searchedAt?: Date;

  nextRetryAt?: Date;

  videoId?: string;

  videoUrl?: string;

  title?: string;

  channelId?: string;

  channelTitle?: string;

  publishedAt?: Date;

  thumbnailUrl?: string;

  /**
   * Latest provider/search data associated with
   * this fixture's current highlight.
   */
  payload?: Record<string, unknown>;

  error?: string;
}

