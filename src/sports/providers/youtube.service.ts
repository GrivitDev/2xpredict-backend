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
  YouTubeHighlightSearchDiagnostics,
  YouTubeHighlightSearchResult,
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
    competitionName?: string,
  ): Promise<YouTubeVideoResult | null> {
    const result = await this.findHighlightWithDiagnostics(
      homeTeam,
      awayTeam,
      matchDate,
      channelId,
      competitionName,
    );
    return result.video;
  }

  /**
   * Performs one bounded search and returns compact diagnostics with its
   * selected result. Diagnostics are returned with the request (rather than
   * stored in mutable service state) so concurrent fixture searches cannot
   * overwrite one another's counters.
   */
  async findHighlightWithDiagnostics(
    homeTeam: string,
    awayTeam: string,
    matchDate: Date,
    channelId?: string,
    competitionName?: string,
  ): Promise<YouTubeHighlightSearchResult> {
    const normalizedHome = homeTeam?.trim();
    const normalizedAway = awayTeam?.trim();
    const normalizedCompetition = competitionName?.trim();

    if (!normalizedHome || !normalizedAway) {
      throw new BadRequestException('Both homeTeam and awayTeam are required');
    }
    if (!(matchDate instanceof Date) || Number.isNaN(matchDate.getTime())) {
      throw new BadRequestException('A valid match date is required');
    }

    // Keep the actual search broad enough to return official clips whose
    // metadata omits the competition name. Competition and fixture date are
    // used below to rank results, not as mandatory search tokens.
    const query = [normalizedHome, normalizedAway].join(' ');
    const diagnostics: YouTubeHighlightSearchDiagnostics = {
      searchedAt: new Date(),
      query,
      itemsReturned: 0,
      videoCandidates: 0,
      acceptedCandidates: 0,
      rejected: {
        invalidPublicationTime: 0,
        publishedBeforeKickoff: 0,
        publishedInFuture: 0,
        missingMetadata: 0,
        insufficientFixtureIdentity: 0,
        contradictoryMatchDate: 0,
        nonHighlightContent: 0,
        notHighlightLike: 0,
        channelMismatch: 0,
      },
    };

    if (matchDate.getTime() > Date.now()) {
      this.logger.warn(
        `Skipping YouTube highlight search because match kickoff is in the future: ${matchDate.toISOString()}`,
      );
      return { video: null, diagnostics };
    }

    // Registry entries may be immutable channel IDs or official @handles.
    const channelReference = channelId?.trim() || undefined;
    if (channelReference) diagnostics.channelReference = channelReference;
    const resolvedChannelId = channelReference
      ? await this.resolveChannelId(channelReference)
      : undefined;
    if (channelReference && !resolvedChannelId) {
      diagnostics.channelResolutionFailed = true;
      this.logger.warn(
        `Could not resolve configured YouTube channel ${channelReference}`,
      );
      return { video: null, diagnostics };
    }
    if (resolvedChannelId) diagnostics.channelId = resolvedChannelId;

    // The fixture competition improves relevance without making a competition
    // name mandatory in a broadcaster's title or description. publishedAfter
    // remains the hard publication boundary.
    const searchResponse = await this.searchVideos({
      query,
      maxResults: YOUTUBE_CONFIG.searchWorkflow.maxResultsPerSearch,
      order: 'relevance',
      publishedAfter: matchDate.toISOString(),
      channelId: resolvedChannelId,
    });

    const items = searchResponse.items ?? [];
    diagnostics.itemsReturned = items.length;

    const videoItems = items.filter(
      (item) => item.id?.kind === 'youtube#video' && Boolean(item.id.videoId),
    );
    diagnostics.videoCandidates = videoItems.length;

    const candidates: YouTubeVideoResult[] = [];
    for (const item of videoItems) {
      const videoId = item.id!.videoId!;
      const video: YouTubeVideoResult = {
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

      if (resolvedChannelId && video.channelId !== resolvedChannelId) {
        diagnostics.rejected.channelMismatch += 1;
        continue;
      }

      const rejection = this.getCandidateRejectionReason(
        video,
        normalizedHome,
        normalizedAway,
        matchDate,
        normalizedCompetition,
        Boolean(resolvedChannelId),
      );
      if (rejection) {
        diagnostics.rejected[rejection] += 1;
        continue;
      }
      candidates.push(video);
    }

    diagnostics.acceptedCandidates = candidates.length;
    const selected = candidates.length
      ? this.selectBestHighlight(
          candidates,
          normalizedHome,
          normalizedAway,
          matchDate,
          normalizedCompetition,
          Boolean(resolvedChannelId),
        )
      : null;

    this.logger.debug(
      `YouTube highlight search completed: candidates=${diagnostics.videoCandidates}, accepted=${diagnostics.acceptedCandidates}, rejected=${JSON.stringify(diagnostics.rejected)}, channel=${resolvedChannelId ?? 'unrestricted'}.`,
    );

    return { video: selected, diagnostics };
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

  private getCandidateRejectionReason(
    video: YouTubeVideoResult,
    homeTeam: string,
    awayTeam: string,
    matchDate: Date,
    competitionName: string | undefined,
    trustedChannel: boolean,
  ): keyof YouTubeHighlightSearchDiagnostics['rejected'] | null {
    if (!video.publishedAt) return 'invalidPublicationTime';

    const publishedAt = new Date(video.publishedAt);
    const now = Date.now();
    if (Number.isNaN(publishedAt.getTime())) return 'invalidPublicationTime';
    if (publishedAt.getTime() < matchDate.getTime()) {
      // The kickoff boundary is strict. Earlier uploads can never qualify.
      return 'publishedBeforeKickoff';
    }
    if (publishedAt.getTime() > now) return 'publishedInFuture';

    const title = this.normalize(video.title);
    const description = this.normalize(video.description ?? '');
    const searchableText = `${title} ${description}`.trim();
    if (!title || !searchableText) return 'missingMetadata';

    // If the title explicitly identifies a different match date, do not attach
    // an older meeting between the same clubs to this fixture. Absence of a
    // date remains acceptable because many official clips omit it.
    if (this.hasContradictoryMatchDate(video.title, matchDate)) {
      return 'contradictoryMatchDate';
    }

    if (this.containsClearlyNonHighlightContent(title, description)) {
      return 'nonHighlightContent';
    }

    const homeMatches = this.teamAppearsInText(searchableText, homeTeam);
    const awayMatches = this.teamAppearsInText(searchableText, awayTeam);
    const bothTeamsMatch = homeMatches && awayMatches;
    const oneTeamMatches = homeMatches || awayMatches;
    const competitionMatches = Boolean(
      competitionName &&
        this.teamAppearsInText(searchableText, competitionName),
    );
    const dateMatches = this.matchDateAppearsInText(searchableText, matchDate);

    const hasTitleHighlightMarker = this.hasHighlightMarker(title);
    const hasDescriptionHighlightMarker = this.hasHighlightMarker(description);
    const hasActionLanguage = this.hasMatchActionLanguage(title);
    const recognizedPublisher = this.isRecognizedFootballPublisher(
      video.channelTitle ?? '',
    );
    const hasScoreline = /\b\d{1,2}\s*[-–:]\s*\d{1,2}\b/.test(title);

    // A restricted search is already scoped to a configured official channel.
    // In that case, one club plus a strong highlight marker can be sufficient
    // when publishers omit the opponent from player-centred titles. Unrestricted
    // results still need both sides of the fixture in their metadata.
    const fixtureIdentityMatches =
      bothTeamsMatch ||
      (trustedChannel &&
        oneTeamMatches &&
        (competitionMatches || dateMatches || hasTitleHighlightMarker));
    if (!fixtureIdentityMatches) return 'insufficientFixtureIdentity';

    const highlightLike =
      hasTitleHighlightMarker ||
      (hasDescriptionHighlightMarker &&
        (hasActionLanguage || recognizedPublisher || trustedChannel)) ||
      (hasActionLanguage &&
        (recognizedPublisher || trustedChannel) &&
        (bothTeamsMatch || competitionMatches || dateMatches)) ||
      (hasScoreline && bothTeamsMatch && recognizedPublisher);

    if (!highlightLike) return 'notHighlightLike';
    return null;
  }

  private containsClearlyNonHighlightContent(
    title: string,
    description: string,
  ): boolean {
    // The title is the strongest content-type signal. Do not reject a valid
    // match recap solely because the description includes a broadcaster's
    // interview, analysis, or programme tags.
    const titleExclusions =
      /\b(interviews?|press conferences?|previews?|predictions?|reactions?|watchalongs?|watch along|podcasts?|livestreams?|live streams?|full match live|commentary only|efootball|pes gameplay|gameplay|gaming|virtual football|virtual soccer|lego|cartoons?|animated|animation|fifa 2[0-9]|fc 2[0-9]|ultimate team)\b/;
    if (titleExclusions.test(title)) return true;

    // Full-match replays are not highlights. Preserve titles such as "Full
    // Match Highlights" because the explicit highlight marker makes that
    // content type unambiguous.
    if (
      /\b(full match|full game|full replay|full 90|full 90 minutes)\b/.test(title) &&
      !this.hasHighlightMarker(title)
    ) {
      return true;
    }

    const syntheticContentExclusions =
      /\b(lego|cartoons?|animated|animation|virtual football|virtual soccer|gameplay|gaming|efootball|pes gameplay|fifa ultimate team)\b/;
    return syntheticContentExclusions.test(`${title} ${description}`);
  }

  private hasMatchActionLanguage(title: string): boolean {
    return /\b(goals?|brace|hat trick|hat-trick|penalt(?:y|ies)|assists?|saves?|masterclass|performance|moments?|vs|versus|scor(?:ed|ing)|winner|equaliser|equalizer|red card|own goal|match action)\b/.test(
      title,
    );
  }

  private hasContradictoryMatchDate(title: string, matchDate: Date): boolean {
    const explicitDates: string[] = [];
    const addValidDate = (year: number, month: number, day: number) => {
      const parsed = new Date(Date.UTC(year, month - 1, day));
      if (
        parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() + 1 === month &&
        parsed.getUTCDate() === day
      ) {
        explicitDates.push(parsed.toISOString().slice(0, 10));
      }
    };

    const isoDatePattern = /\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/g;
    for (const match of title.matchAll(isoDatePattern)) {
      addValidDate(Number(match[1]), Number(match[2]), Number(match[3]));
    }

    // Also understand common day-first and month-first numeric formats. Both
    // interpretations are retained because the title's locale is not known.
    const numericDatePattern = /\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.](20\d{2})\b/g;
    for (const match of title.matchAll(numericDatePattern)) {
      const first = Number(match[1]);
      const second = Number(match[2]);
      const year = Number(match[3]);
      addValidDate(year, second, first);
      addValidDate(year, first, second);
    }

    const monthPattern =
      'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
    const dayMonthYear = new RegExp(
      `\\b(0?[1-9]|[12]\\d|3[01])\\s+(${monthPattern})[,\\s]+(20\\d{2})\\b`,
      'gi',
    );
    const monthDayYear = new RegExp(
      `\\b(${monthPattern})\\s+(0?[1-9]|[12]\\d|3[01])[,\\s]+(20\\d{2})\\b`,
      'gi',
    );
    for (const match of title.matchAll(dayMonthYear)) {
      const parsed = new Date(`${match[1]} ${match[2]} ${match[3]} 00:00:00 UTC`);
      if (!Number.isNaN(parsed.getTime())) explicitDates.push(parsed.toISOString().slice(0, 10));
    }
    for (const match of title.matchAll(monthDayYear)) {
      const parsed = new Date(`${match[1]} ${match[2]} ${match[3]} 00:00:00 UTC`);
      if (!Number.isNaN(parsed.getTime())) explicitDates.push(parsed.toISOString().slice(0, 10));
    }

    if (!explicitDates.length) return false;

    // A fixture's local calendar date can differ from UTC by one day depending
    // on the venue timezone. Accept that valid boundary rather than falsely
    // rejecting official clips whose title uses the local match date.
    const utcMidnight = Date.UTC(
      matchDate.getUTCFullYear(),
      matchDate.getUTCMonth(),
      matchDate.getUTCDate(),
    );
    const fixtureDateKeys = new Set(
      [-1, 0, 1].map((offset) =>
        new Date(utcMidnight + offset * 24 * 60 * 60_000)
          .toISOString()
          .slice(0, 10),
      ),
    );
    return !explicitDates.some((dateKey) => fixtureDateKeys.has(dateKey));
  }

  private matchDateAppearsInText(text: string, date: Date): boolean {
    const variants = new Set<string>();
    const addDateVariants = (year: number, month: number, day: number) => {
      const value = new Date(Date.UTC(year, month - 1, day));
      const dayNumber = value.getUTCDate();
      const monthLong = value.toLocaleString('en-US', {
        month: 'long',
        timeZone: 'UTC',
      }).toLowerCase();
      const monthShort = value.toLocaleString('en-US', {
        month: 'short',
        timeZone: 'UTC',
      }).toLowerCase();
      variants.add(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
      variants.add(`${dayNumber}/${String(month).padStart(2, '0')}/${year}`);
      variants.add(`${String(month).padStart(2, '0')}/${dayNumber}/${year}`);
      variants.add(`${dayNumber} ${monthLong} ${year}`);
      variants.add(`${monthLong} ${dayNumber} ${year}`);
      variants.add(`${dayNumber} ${monthShort} ${year}`);
      variants.add(`${monthShort} ${dayNumber} ${year}`);
    };

    // Score local-title dates as supporting evidence. Venue-local match dates
    // can fall one calendar day either side of the UTC kickoff date.
    const utcMidnight = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
    );
    for (const offset of [-1, 0, 1]) {
      const day = new Date(utcMidnight + offset * 24 * 60 * 60_000);
      addDateVariants(
        day.getUTCFullYear(),
        day.getUTCMonth() + 1,
        day.getUTCDate(),
      );
    }

    const normalizedText = this.normalize(text);
    return [...variants].some((variant) =>
      this.containsPhrase(normalizedText, this.normalize(variant)),
    );
  }

  // ============================================================
  // HIGHLIGHT SELECTION
  // ============================================================

  private selectBestHighlight(
    videos: YouTubeVideoResult[],
    homeTeam: string,
    awayTeam: string,
    matchDate: Date,
    competitionName: string | undefined,
    trustedChannel: boolean,
  ): YouTubeVideoResult | null {
    if (!videos.length) return null;

    const scored = videos.map((video) => {
      const title = this.normalize(video.title);
      const description = this.normalize(video.description ?? '');
      const searchableText = `${title} ${description}`;
      const channel = this.normalize(video.channelTitle ?? '');
      const homeTitle = this.teamAppearsInText(title, homeTeam);
      const awayTitle = this.teamAppearsInText(title, awayTeam);
      const homeText = this.teamAppearsInText(searchableText, homeTeam);
      const awayText = this.teamAppearsInText(searchableText, awayTeam);
      const competitionMatch = Boolean(
        competitionName &&
          this.teamAppearsInText(searchableText, competitionName),
      );
      const dateMatch = this.matchDateAppearsInText(searchableText, matchDate);
      let score = 0;

      score += homeTitle ? 14 : homeText ? 9 : 0;
      score += awayTitle ? 14 : awayText ? 9 : 0;
      score += competitionMatch ? 5 : 0;
      score += dateMatch ? 5 : 0;
      if (this.hasHighlightMarker(title)) score += 9;
      else if (this.hasHighlightMarker(description)) score += 5;
      if (this.hasMatchActionLanguage(title)) score += 3;
      if (trustedChannel) score += 3;
      if (this.isRecognizedFootballPublisher(channel)) score += 2;

      const publishedTime = video.publishedAt
        ? new Date(video.publishedAt).getTime()
        : 0;
      return { video, score, publishedTime };
    });

    // Fixture relevance comes first. Publication recency is only a tie-breaker.
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

  private isRecognizedFootballPublisher(channelTitle: string): boolean {
    return /\b(official|league|football|soccer|sports|sport|dazn|bein|espn|fifa|uefa|premier|sky|fox|tnt|sporty|sportytv|supersport)\b/.test(
      this.normalize(channelTitle),
    );
  }

  private hasHighlightMarker(value: string): boolean {
    const text = this.normalize(value);
    const highlightPattern =
      /\b(highlights?|extended highlights?|full highlights?|game highlights?|goal highlights?|goals?|all goals|all the goals|match recap|post match recap|game recap|recap|match summary|best moments|match action|key moments|goal compilation|matchday highlights|highlights and goals|goals and highlights|full time highlights|player highlights|best saves|top saves)\b/;
    return highlightPattern.test(text);
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
            if (rateLimitEndpoint === 'search') {
              // search.list has its own daily request bucket. Mark only this
              // application's reserved search allowance as exhausted.
              await this.providerRateLimitService.markDailyQuotaExhausted(
                'youtube',
              );
            } else {
              // channels.list consumes the general YouTube API quota pool.
              // Pause this provider lane without incorrectly consuming all
              // 90 reserved search.list requests.
              await this.providerRateLimitService.markProviderDailyQuotaBlocked(
                'youtube',
              );
            }
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







