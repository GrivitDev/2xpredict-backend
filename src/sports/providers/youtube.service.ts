import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import axios, { AxiosError, AxiosInstance } from 'axios';

import {
  YouTubeSearchOptions,
  YouTubeSearchResponse,
  YouTubeVideoResult,
} from './youtube.interfaces';

import { YOUTUBE_CONFIG } from '../config/youtube.config';
import { SPORTS_DATA_COLLECTION_CONFIG } from '../config/sports-data-collection.config';

import {
  SportsProviderQuotaExceededError,
  SportsProviderRateLimitService,
} from '../services/sports-provider-rate-limit.service';

interface YouTubeChannelListResponse {
  items?: Array<{
    id?: string;
    snippet?: { title?: string };
  }>;
}

@Injectable()
export class YoutubeService implements OnModuleInit {
  private readonly logger = new Logger(YoutubeService.name);

  private readonly baseUrl = YOUTUBE_CONFIG.apiBaseUrl;

  private http!: AxiosInstance;

  private apiKey = '';
  private enabled = false;

  /** Resolved handles remain cached for the lifetime of this service instance. */
  private readonly channelIdByHandle = new Map<string, string>();

  constructor(
    private readonly configService: ConfigService,

    private readonly providerRateLimitService: SportsProviderRateLimitService,
  ) {}

  onModuleInit(): void {
    const apiKey = this.configService
      .get<string>('YOUTUBE_DATA_API_KEY')
      ?.trim();

    if (!apiKey) {
      this.enabled = false;
      this.logger.warn('YouTube highlights are disabled: YOUTUBE_DATA_API_KEY is not configured. ESPN sports collection will continue normally.');
      return;
    }

    this.apiKey = apiKey;
    this.enabled = true;

    this.http = axios.create({
      baseURL: this.baseUrl,

      timeout: 15_000,

      headers: {
        Accept: 'application/json',
      },
    });
    this.logger.log(
      `YouTube highlights activated (daily search cap=${SPORTS_DATA_COLLECTION_CONFIG.YOUTUBE.dailyRequestLimit}; per-search interval=${SPORTS_DATA_COLLECTION_CONFIG.YOUTUBE.rateLimit.minIntervalSeconds}s).`,
    );
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ============================================================
  // SEARCH
  // ============================================================

  async searchVideos(
    options: YouTubeSearchOptions,
  ): Promise<YouTubeSearchResponse> {
    if (!this.enabled) throw new InternalServerErrorException('YouTube highlights are disabled because YOUTUBE_DATA_API_KEY is not configured');
    if (!options.query?.trim()) {
      throw new BadRequestException('YouTube search query is required');
    }

    const maxResults = options.maxResults ?? 5;

    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
      throw new BadRequestException(
        'maxResults must be an integer between 1 and 50',
      );
    }

    const params: Record<string, string | number | boolean> = {
      key: this.apiKey,

      part: 'snippet',

      q: options.query.trim(),

      type: YOUTUBE_CONFIG.searchType,

      maxResults,
    };

    if (options.order) {
      params.order = options.order;
    }

    if (options.channelId?.trim()) {
      params.channelId = options.channelId.trim();
    }

    if (options.publishedAfter) {
      params.publishedAfter = options.publishedAfter;
    }

    if (YOUTUBE_CONFIG.requireEmbeddable) {
      // Embeddability matters because highlights are displayed inside 2xPredict.
      // videoSyndicated is intentionally omitted: it excludes otherwise valid
      // embeddable videos that YouTube does not classify as syndicated.
      params.videoEmbeddable = 'true';
    }

    return this.request<YouTubeSearchResponse>('/search', 'search', params);
  }

  // ============================================================
  // HIGHLIGHTS
  // ============================================================

  /**
   * Searches for match highlights without assuming the publisher puts both
   * club names in the video title. Player-focused titles are common; fixture
   * identity is therefore checked against the title and description together.
   *
   * Publication time is a hard safety boundary: a video published before
   * kickoff is never accepted. There is deliberately no post-kickoff expiry,
   * because quota-paused queue jobs must remain eligible on later days.
   *
   * No videos.list request is made.
   */
  async findHighlight(
    homeTeam: string,
    awayTeam: string,
    matchDate: Date,
    channelId?: string,
  ): Promise<YouTubeVideoResult | null> {
    const normalizedHome = homeTeam?.trim();
    const normalizedAway = awayTeam?.trim();

    if (!normalizedHome || !normalizedAway) {
      throw new BadRequestException('Both homeTeam and awayTeam are required');
    }
    if (!(matchDate instanceof Date) || Number.isNaN(matchDate.getTime())) {
      throw new BadRequestException('A valid match date is required');
    }
    if (matchDate.getTime() > Date.now()) {
      this.logger.warn(
        `Skipping YouTube highlight search because match kickoff is in the future: ${matchDate.toISOString()}`,
      );
      return null;
    }

    // Registry entries may be immutable channel IDs or official @handles.
    const channelReference = channelId?.trim() || undefined;
    const resolvedChannelId = channelReference
      ? await this.resolveChannelId(channelReference)
      : undefined;
    if (channelReference && !resolvedChannelId) {
      this.logger.warn(
        `Could not resolve configured YouTube channel ${channelReference}`,
      );
      return null;
    }

    // Keep the query broad. Requiring a literal "highlights" term here can
    // suppress player-centred uploads whose descriptions identify the fixture.
    const searchResponse = await this.searchVideos({
      query: `${normalizedHome} ${normalizedAway}`,
      maxResults: YOUTUBE_CONFIG.searchWorkflow.maxResultsPerSearch,
      order: 'relevance',
      publishedAfter: matchDate.toISOString(),
      channelId: resolvedChannelId,
    });

    const candidates: YouTubeVideoResult[] = (searchResponse.items ?? [])
      .filter(
        (item) => item.id?.kind === 'youtube#video' && Boolean(item.id.videoId),
      )
      .map((item) => {
        const videoId = item.id!.videoId!;
        return {
          videoId,
          channelId: item.snippet?.channelId,
          channelTitle: item.snippet?.channelTitle,
          title: item.snippet?.title ?? '',
          description: item.snippet?.description,
          publishedAt: item.snippet?.publishedAt,
          thumbnailUrl:
            item.snippet?.thumbnails?.high?.url ??
            item.snippet?.thumbnails?.medium?.url ??
            item.snippet?.thumbnails?.default?.url,
          embeddable: true,
          videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        };
      })
      .filter(
        (video) =>
          (!resolvedChannelId || video.channelId === resolvedChannelId) &&
          this.isValidHighlightCandidate(
            video,
            normalizedHome,
            normalizedAway,
            matchDate,
          ),
      );

    return candidates.length
      ? this.selectBestHighlight(candidates, normalizedHome, normalizedAway)
      : null;
  }

  /**
   * Accepts immutable YouTube channel IDs unchanged and resolves @handles via
   * channels.list. Failed handles are not cached so configuration can recover
   * if a channel is renamed or corrected without restarting the backend.
   */
  private async resolveChannelId(
    channelReference: string,
  ): Promise<string | undefined> {
    const normalized = channelReference.trim();
    if (!normalized) return undefined;
    if (!normalized.startsWith('@')) return normalized;

    const cacheKey = normalized.toLowerCase();
    const cached = this.channelIdByHandle.get(cacheKey);
    if (cached) return cached;

    const response = await this.request<YouTubeChannelListResponse>(
      '/channels',
      'channel-lookup',
      {
        key: this.apiKey,
        part: 'id,snippet',
        forHandle: normalized,
        maxResults: 1,
      },
      // channels.list consumes YouTube quota units too, but it is not counted
      // against this application's reserved search.list request budget.
      { countTowardProviderQuota: false, minimumIntervalSeconds: 1 },
    );
    const channel = response.items?.[0];
    const channelId = channel?.id?.trim();
    if (!channelId) {
      this.logger.warn(
        `YouTube channel handle ${normalized} did not resolve to a channel`,
      );
      return undefined;
    }

    this.channelIdByHandle.set(cacheKey, channelId);
    this.logger.debug(`Resolved YouTube handle ${normalized} to ${channelId}`);
    return channelId;
  }

  // ============================================================
  // HIGHLIGHT VALIDATION
  // ============================================================

  private isValidHighlightCandidate(
    video: YouTubeVideoResult,
    homeTeam: string,
    awayTeam: string,
    matchDate: Date,
  ): boolean {
    if (!video.publishedAt) return false;

    const publishedAt = new Date(video.publishedAt);
    const now = Date.now();
    if (
      Number.isNaN(publishedAt.getTime()) ||
      publishedAt.getTime() < matchDate.getTime() ||
      publishedAt.getTime() > now
    ) {
      // The kickoff boundary is strict. Earlier uploads can never qualify.
      return false;
    }

    const title = this.normalize(video.title);
    const description = this.normalize(video.description ?? '');
    const searchableText = `${title} ${description}`.trim();
    if (!title || !searchableText) return false;

    // The fixture may be identified in the description while the title uses
    // the names of scorers or other key players. Both teams must still be
    // established somewhere in the video metadata to avoid generic/fake hits.
    if (
      !this.teamAppearsInText(searchableText, homeTeam) ||
      !this.teamAppearsInText(searchableText, awayTeam)
    ) {
      return false;
    }

    return this.isHighlightLike(title, description, video.channelTitle);
  }

  // ============================================================
  // HIGHLIGHT SELECTION
  // ============================================================

  private selectBestHighlight(
    videos: YouTubeVideoResult[],
    homeTeam: string,
    awayTeam: string,
  ): YouTubeVideoResult | null {
    if (!videos.length) return null;

    const scored = videos.map((video) => {
      const title = this.normalize(video.title);
      const description = this.normalize(video.description ?? '');
      const channel = this.normalize(video.channelTitle ?? '');
      let score = 0;

      // Give the strongest weight to fixture identity in the title, but do not
      // reject a player-focused title when the description identifies the match.
      score += this.teamAppearsInText(title, homeTeam) ? 10 : 4;
      score += this.teamAppearsInText(title, awayTeam) ? 10 : 4;
      if (this.hasHighlightMarker(title)) score += 6;
      else if (this.hasHighlightMarker(description)) score += 3;
      if (this.isRecognizedFootballPublisher(channel)) score += 2;
      if (/\b(extended|full|official|all goals|matchday)\b/.test(title)) score += 1;

      const publishedTime = video.publishedAt
        ? new Date(video.publishedAt).getTime()
        : 0;
      return { video, score, publishedTime };
    });

    // Relevance comes first. Publication recency is only a tie-breaker.
    scored.sort((a, b) =>
      b.score - a.score || b.publishedTime - a.publishedTime,
    );
    return scored[0]?.video ?? null;
  }

  // ============================================================
  // TEAM MATCHING
  // ============================================================

  private teamAppearsInText(text: string, teamName: string): boolean {
    const normalizedText = this.normalize(text);
    const normalizedTeam = this.normalize(teamName);

    if (!normalizedText || !normalizedTeam) {
      return false;
    }

    const variants = this.getTeamNameVariants(normalizedTeam);

    // Match whole normalized phrases. Avoid a raw substring match that could
    // accidentally treat a short club name as part of an unrelated word.
    if (
      variants.some((variant) => this.containsPhrase(normalizedText, variant))
    ) {
      return true;
    }

    // If a fixture provider supplies a longer formal name but the publisher
    // uses a common abbreviation, permit a strong token match. A single token
    // is never enough for a multi-word team unless it is a known alias above.
    const teamTokens = normalizedTeam
      .split(' ')
      .filter((token) => token.length >= 2)
      .filter(
        (token) =>
          !['fc', 'afc', 'cf', 'sc', 'ac', 'fk', 'club'].includes(token),
      );

    if (!teamTokens.length) {
      return false;
    }

    const textTokens = new Set(normalizedText.split(' ').filter(Boolean));
    const matched = teamTokens.filter((token) => textTokens.has(token)).length;

    if (teamTokens.length === 1) {
      return matched === 1;
    }

    // Requiring a strong majority limits accidental matches while tolerating
    // one omitted/shortened token in longer official club names.
    return matched >= Math.max(2, Math.ceil(teamTokens.length * 0.67));
  }

  private getTeamNameVariants(normalizedTeam: string): string[] {
    const aliases: Record<string, string[]> = {
      'manchester united': ['man united', 'man utd', 'man u'],
      'manchester city': ['man city'],
      'tottenham hotspur': ['tottenham', 'spurs'],
      'paris saint germain': ['paris sg', 'psg'],
      'atletico madrid': ['atletico', 'atleti'],
      barcelona: ['barca', 'barça'],
      'bayern munich': ['bayern'],
      'borussia dortmund': ['dortmund'],
      'real sociedad': ['la real'],
      'athletic bilbao': ['athletic club'],
      'brighton and hove albion': ['brighton', 'brighton hove albion'],
      'brighton hove albion': ['brighton'],
      'west ham united': ['west ham'],
      'crystal palace': ['palace'],
      'newcastle united': ['newcastle'],
      'nottingham forest': ['forest'],
      'wolverhampton wanderers': ['wolves', 'wolverhampton'],
      'afc bournemouth': ['bournemouth'],
      'inter miami cf': ['inter miami'],
      'los angeles fc': ['lafc'],
      'new york city fc': ['nycfc'],
      'mamelodi sundowns': ['sundowns'],
      'kerala blasters fc': ['kerala blasters'],
      'kaizer chiefs fc': ['kaizer chiefs'],
    };

    const variants = [normalizedTeam, ...(aliases[normalizedTeam] ?? [])];
    return [
      ...new Set(
        variants.map((variant) => this.normalize(variant)).filter(Boolean),
      ),
    ];
  }

  private containsPhrase(text: string, phrase: string): boolean {
    if (!text || !phrase) {
      return false;
    }

    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`).test(text);
  }

  private isHighlightLike(
    title: string,
    description: string,
    channelTitle?: string,
  ): boolean {
    const titleText = this.normalize(title);
    const descriptionText = this.normalize(description);
    const channelText = this.normalize(channelTitle ?? '');

    // Explicitly reject formats that are commonly returned for team searches.
    const nonHighlightPattern =
      /\b(interviews?|press conference|preview|predictions?|reaction|watchalong|watch along|podcasts?|livestream|live stream|full match live|commentary only|tactical analysis|analysis|tactics|efootball|pes gameplay|gameplay|gaming|virtual football|virtual soccer|lego|cartoon|animated|animation|fifa 2[0-9]|fc 2[0-9]|ultimate team)\b/;
    if (nonHighlightPattern.test(titleText)) return false;

    // Game-play/animation exclusions apply to the wider metadata too.
    if (
      /\b(lego|cartoon|animated|animation|virtual football|virtual soccer|gameplay|gaming|efootball|pes gameplay|fifa ultimate team)\b/.test(
        `${titleText} ${descriptionText}`,
      )
    ) {
      return false;
    }

    if (this.hasHighlightMarker(titleText)) return true;

    // Allow a player-centred title only when the video description itself
    // carries highlight language and the title describes match action, or the
    // uploader is a recognisable football broadcaster/competition channel.
    const playerOrMatchActionPattern =
      /\b(goals?|brace|hat trick|hat-trick|penalt(?:y|ies)|assists?|saves?|masterclass|performance|moments?|vs|versus|match action)\b/;
    return (
      this.hasHighlightMarker(descriptionText) &&
      (playerOrMatchActionPattern.test(titleText) ||
        this.isRecognizedFootballPublisher(channelText))
    );
  }

  private hasHighlightMarker(value: string): boolean {
    const text = this.normalize(value);
    const highlightPattern =
      /\b(highlights?|extended highlights?|full highlights?|game highlights?|goal highlights?|goals?|all goals|all the goals|match recap|post match recap|game recap|recap|match summary|best moments|match action|key moments|goal compilation|matchday highlights|highlights and goals|goals and highlights|full time highlights|player highlights|best saves|top saves)\b/;
    return highlightPattern.test(text);
  }

  private isRecognizedFootballPublisher(channelTitle: string): boolean {
    return /\b(official|league|football|soccer|sports|sport|dazn|bein|espn|fifa|uefa|premier|sky|fox|tnt|sporty|sportytv|supersport)\b/.test(
      this.normalize(channelTitle),
    );
  }

  // ============================================================
  // REQUEST
  // ============================================================

  private async request<T>(
    endpoint: string,
    rateLimitEndpoint: string,
    params: Record<string, string | number | boolean>,
    rateLimitOptions: {
      countTowardProviderQuota?: boolean;
      minimumIntervalSeconds?: number;
    } = {},
  ): Promise<T> {
    return this.providerRateLimitService.execute(
      'youtube',
      rateLimitEndpoint,
      async () => {
        try {
          const response = await this.http.get<T>(endpoint, {
            params,
          });

          return response.data;
        } catch (error) {
          this.logApiError(error, endpoint);

          if (this.isDailyQuotaExhaustion(error)) {
            // Persist the exhausted state in the shared provider quota record.
            // Every worker then sees zero remaining capacity and stops for the
            // rest of the configured quota day, including after a restart.
            await this.providerRateLimitService.markDailyQuotaExhausted(
              'youtube',
            );
            throw new SportsProviderQuotaExceededError('youtube', 'daily');
          }

          throw new InternalServerErrorException(
            `YouTube API request failed: ${endpoint}`,
          );
        }
      },
      rateLimitOptions,
    );
  }

  // ============================================================
  // NORMALIZATION
  // ============================================================

  private normalize(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\bman utd\b/g, 'manchester united')
      .replace(/\bman united\b/g, 'manchester united')
      .replace(/\bman u\b/g, 'manchester united')
      .replace(/\bman city\b/g, 'manchester city')
      .replace(/\butd\.?\b/g, 'united')
      .replace(/\bspurs\b/g, 'tottenham hotspur')
      .replace(/\bbarca\b/g, 'barcelona')
      .replace(/\batleti\b/g, 'atletico madrid')
      .replace(/\bpsg\b/g, 'paris saint germain')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isDailyQuotaExhaustion(error: unknown): boolean {
    if (!axios.isAxiosError(error)) return false;
    const axiosError = error as AxiosError;

    const data = axiosError.response?.data;
    let serialized: string;
    if (typeof data === 'string') {
      serialized = data.toLowerCase();
    } else if (data !== null && typeof data === 'object') {
      try {
        serialized =
          JSON.stringify(data)?.toLowerCase() ??
          axiosError.message.toLowerCase();
      } catch {
        serialized = axiosError.message.toLowerCase();
      }
    } else {
      serialized = (
        data === null || data === undefined ? axiosError.message : String(data)
      ).toLowerCase();
    }

    const isDailySearchQuota =
      serialized.includes('search queries per day') ||
      serialized.includes('defaultsearchlistperdayperproject') ||
      serialized.includes('youtube.googleapis.com/search_list') ||
      serialized.includes('quota_limit_value') && serialized.includes('1/d/{project}');
    const isExplicitDailyLimit =
      serialized.includes('quotaexceeded') ||
      serialized.includes('quota exceeded') ||
      serialized.includes('dailylimitexceeded') ||
      serialized.includes('daily quota exceeded') ||
      serialized.includes('daily limit exceeded');

    return isDailySearchQuota || isExplicitDailyLimit;
  }

  // ============================================================
  // ERROR LOGGING
  // ============================================================

  private logApiError(error: unknown, endpoint: string): void {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;

      this.logger.error(`YouTube API request failed: ${endpoint}`, {
        status: axiosError.response?.status,

        data: axiosError.response?.data,
      });

      return;
    }

    this.logger.error(`YouTube API request failed: ${endpoint}`, error);
  }
}






