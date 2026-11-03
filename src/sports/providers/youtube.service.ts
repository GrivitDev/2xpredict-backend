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

  /**
   * A YouTube highlight is only relevant from the match kickoff
   * until 24 hours after the match.
   */
  private readonly highlightWindowHours = YOUTUBE_CONFIG.highlightWindowHours;

  private http!: AxiosInstance;

  private apiKey!: string;

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
      throw new Error('YOUTUBE_DATA_API_KEY is missing');
    }

    this.apiKey = apiKey;

    this.http = axios.create({
      baseURL: this.baseUrl,

      timeout: 15_000,

      headers: {
        Accept: 'application/json',
      },
    });
  }

  // ============================================================
  // SEARCH
  // ============================================================

  async searchVideos(
    options: YouTubeSearchOptions,
  ): Promise<YouTubeSearchResponse> {
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

    if (options.publishedBefore) {
      params.publishedBefore = options.publishedBefore;
    }

    if (YOUTUBE_CONFIG.requireEmbeddable) {
      params.videoEmbeddable = 'true';

      params.videoSyndicated = 'true';
    }

    return this.request<YouTubeSearchResponse>('/search', 'search', params);
  }

  // ============================================================
  // HIGHLIGHTS
  // ============================================================

  /**
   * Searches YouTube specifically for the finished fixture.
   *
   * Rules:
   *
   * 1. Search using both team names only; do not require the query to contain
   *    the word "highlights".
   * 2. Restrict early requests to configured channels; the final attempt is broad.
   * 3. Search only from kickoff through 24 hours after kickoff.
   * 4. Independently validate every returned video's publication date.
   * 5. Normalize team names and allow recognised common team-name variants.
   * 6. Accept common highlight/recap/goal terminology without requiring one
   *    exact title format; reject obvious non-highlight content.
   * 7. Select the best valid candidate.
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

    const now = new Date();
    if (matchDate.getTime() > now.getTime()) {
      this.logger.warn(
        `Skipping YouTube highlight search because match date is in the future: ${matchDate.toISOString()}`,
      );
      return null;
    }

    const windowEnd = new Date(
      matchDate.getTime() + this.highlightWindowHours * 60 * 60 * 1000,
    );
    if (now.getTime() > windowEnd.getTime()) {
      this.logger.debug(
        `Skipping YouTube highlight search because the 24-hour window has expired for ${normalizedHome} vs ${normalizedAway}`,
      );
      return null;
    }

    const searchEnd = windowEnd.getTime() < now.getTime() ? windowEnd : now;

    // Registry entries may be immutable channel IDs or official @handles.
    // Resolve handles through channels.list because search.list's channelId
    // filter requires the immutable channel ID. Channel lookups are tracked
    // separately from the reserved daily search-call budget.
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

    // Search only the fixture's two teams. Requiring "highlights" in the
    // query makes YouTube miss videos titled "Goals", "Match Recap", or
    // other reasonable variations. The queue still controls which channel
    // is searched for each attempt.
    const query = `${normalizedHome} ${normalizedAway}`;

    // One queue job performs exactly one API search. The final stage intentionally
    // omits the channel filter; retries are persisted by EspnQueueWorkerService.
    const searchResponse = await this.searchVideos({
      query,
      // The query is intentionally broader now that "highlights" is not
      // required. Return more candidates so validation can choose a suitable one.
      maxResults: 10,
      order: 'date',
      publishedAfter: matchDate.toISOString(),
      publishedBefore: searchEnd.toISOString(),
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
            windowEnd,
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
    windowEnd: Date,
  ): boolean {
    if (!video.publishedAt) {
      return false;
    }

    const publishedAt = new Date(video.publishedAt);

    if (Number.isNaN(publishedAt.getTime())) {
      return false;
    }

    /*
     * Absolute publication window.
     *
     * The result must have been published:
     *
     *     >= match kickoff
     *     <= match kickoff + 24h
     */
    if (
      publishedAt.getTime() < matchDate.getTime() ||
      publishedAt.getTime() > windowEnd.getTime() ||
      publishedAt.getTime() > Date.now()
    ) {
      return false;
    }

    const title = this.normalize(video.title);
    const searchText = this.normalize(
      `${video.title} ${video.description ?? ''}`,
    );

    if (!title || !searchText) {
      return false;
    }

    // Keep the fixture identity check, but normalize accents, punctuation,
    // spacing and common short forms before comparing the names.
    // Both team identities must appear in the TITLE. Description-only matches
    // are too weak and were a source of unrelated videos being accepted.
    if (!this.teamAppearsInText(title, homeTeam)) {
      return false;
    }

    if (!this.teamAppearsInText(title, awayTeam)) {
      return false;
    }

    // Do not require the literal word "highlight(s)". Legitimate publishers
    // also use terms such as "goals", "match recap", or "best moments".
    // At the same time, avoid selecting interviews, previews, livestreams,
    // reactions, podcasts, game-play videos and press conferences.
    if (!this.isHighlightLike(title, searchText, video.channelTitle)) {
      return false;
    }

    return true;
  }

  // ============================================================
  // HIGHLIGHT SELECTION
  // ============================================================

  private selectBestHighlight(
    videos: YouTubeVideoResult[],
    homeTeam: string,
    awayTeam: string,
  ): YouTubeVideoResult | null {
    if (!videos.length) {
      return null;
    }

    const scored = videos.map((video) => {
      const title = this.normalize(video.title);

      let score = 0;

      /*
       * Full team-name presence gets stronger weighting than
       * partial token matches.
       */
      if (title.includes(this.normalize(homeTeam))) {
        score += 8;
      } else if (this.teamAppearsInText(title, homeTeam)) {
        score += 6;
      }

      if (title.includes(this.normalize(awayTeam))) {
        score += 8;
      } else if (this.teamAppearsInText(title, awayTeam)) {
        score += 6;
      }

      if (title.includes('highlights')) {
        score += 3;
      } else if (title.includes('highlight')) {
        score += 2;
      } else if (title.includes('goals') || title.includes('match recap')) {
        score += 2;
      }

      const channelTitle = this.normalize(video.channelTitle ?? '');
      if (
        /\b(official|league|sports|football|soccer|dazn|bein|uefa|fifa)\b/.test(
          channelTitle,
        )
      ) {
        score += 1;
      }

      const publishedTime = video.publishedAt
        ? new Date(video.publishedAt).getTime()
        : 0;

      return {
        video,
        score,
        publishedTime,
      };
    });

    /*
     * Match relevance comes first. Publication time is only a tie-breaker
     * between candidates that already look equally relevant to this fixture.
     */
    scored.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return b.publishedTime - a.publishedTime;
    });

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
    searchText: string,
    channelTitle?: string,
  ): boolean {
    const titleText = this.normalize(title);
    const fullText = this.normalize(searchText);

    // These formats are not match highlights, even if both club names appear.
    const nonHighlightPattern =
      /\b(interviews?|press conference|preview|predictions?|reaction|watchalong|watch along|podcasts?|livestream|live stream|full match live|commentary only|analysis|tactics|efootball|pes gameplay|gameplay|gaming|virtual football|virtual soccer|lego|cartoon|animated|animation|fc 2[0-9]|fifa 2[0-9]|fifa ultimate team)\b/;
    const channelText = this.normalize(channelTitle ?? '');
    const metadataText = `${titleText} ${fullText} ${channelText}`;

    if (
      nonHighlightPattern.test(titleText) ||
      /\b(lego|cartoon|animated|animation|virtual football|virtual soccer|gameplay|gaming|efootball|pes gameplay)\b/.test(
        metadataText,
      )
    ) {
      return false;
    }

    // Do not enforce a single title vocabulary. Broadly-used labels for actual
    // match footage, goals and recaps are accepted as well as "highlights".
    const highlightPattern =
      /\b(highlights?|extended highlights?|goal highlights?|goals?|all goals|match recap|recap|match summary|best moments|match action|key moments|goal compilation)\b/;

    // A highlight marker in the description alone is not enough to identify
    // the video itself as match highlights. Require the title to establish it.
    return highlightPattern.test(titleText);
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

    return (
      serialized.includes('quotaexceeded') ||
      serialized.includes('dailylimitexceeded') ||
      serialized.includes('daily quota exceeded')
    );
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

