export interface YouTubeSearchOptions {
  query: string;
  channelId?: string;
  publishedAfter?: string;
  publishedBefore?: string;
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

