/** Normalized YouTube highlight metadata; this is a media feature, not a sports-data feed. */
export type SportsYoutubeHighlightStatus =
  | 'PENDING'
  | 'SEARCHING'
  | 'RETRY'
  | 'FOUND'
  | 'FAILED';

export interface SportsYoutubeHighlightRecord {
  fixtureId: string;
  competitionId?: string;
  homeTeam: string;
  awayTeam: string;
  status: SportsYoutubeHighlightStatus;
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
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

