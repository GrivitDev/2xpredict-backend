export interface YouTubeSearchOptions {
  query: string;
  channelId?: string;
  publishedAfter?: string;
  maxResults?: number;
  order?: 'date' | 'relevance';
}

export interface YouTubeVideoResult {
  videoId: string;
  videoUrl?: string;
  title: string;
  description?: string;
  channelTitle?: string;
  channelId?: string;
  publishedAt?: string;
  thumbnailUrl?: string;
  embeddable?: boolean;
}

export interface YouTubeSearchItem {
  id?: {
    kind?: string;
    videoId?: string;
  };

  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    channelId?: string;
    publishedAt?: string;

    thumbnails?: {
      default?: {
        url?: string;
      };

      medium?: {
        url?: string;
      };

      high?: {
        url?: string;
      };
    };
  };
}

export interface YouTubeSearchResponse {
  items?: YouTubeSearchItem[];

  nextPageToken?: string;

  pageInfo?: {
    totalResults?: number;
    resultsPerPage?: number;
  };
}






export interface YouTubeHighlightSearchDiagnostics {
  searchedAt: Date;
  query: string;
  channelReference?: string;
  channelId?: string;
  channelResolutionFailed?: boolean;
  itemsReturned: number;
  videoCandidates: number;
  acceptedCandidates: number;
  rejected: {
    invalidPublicationTime: number;
    publishedBeforeKickoff: number;
    publishedInFuture: number;
    missingMetadata: number;
    insufficientFixtureIdentity: number;
    contradictoryMatchDate: number;
    nonHighlightContent: number;
    notHighlightLike: number;
    channelMismatch: number;
  };
}

export interface YouTubeHighlightSearchResult {
  video: YouTubeVideoResult | null;
  diagnostics: YouTubeHighlightSearchDiagnostics;
}
