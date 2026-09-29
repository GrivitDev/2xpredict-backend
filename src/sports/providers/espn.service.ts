import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';

import axios, { AxiosError, AxiosInstance } from 'axios';

import {
  EspnApiResponse,
  EspnEvent,
  EspnLeague,
  EspnMatchSummary,
  EspnNewsResponse,
  EspnStandingsResponse,
} from './espn.interfaces';

import {
  SportsProviderRateLimitService,
  SportsProviderRequestLane,
} from '../services/sports-provider-rate-limit.service';

@Injectable()
export class EspnService {
  private readonly logger = new Logger(EspnService.name);

  private readonly siteBaseUrl =
    'https://site.api.espn.com/apis/site/v2/sports/soccer';

  private readonly standingsBaseUrl =
    'https://site.api.espn.com/apis/v2/sports/soccer';

  private readonly coreBaseUrl =
    'https://sports.core.api.espn.com/v2/sports/soccer';

  private readonly newsBaseUrl = 'https://now.core.api.espn.com/v1/sports';

  private readonly http: AxiosInstance;

  constructor(
    private readonly providerRateLimitService: SportsProviderRateLimitService,
  ) {
    this.http = axios.create({
      timeout: 15_000,

      headers: {
        Accept: 'application/json',
      },
    });
  }

  // ============================================================
  // 1. LEAGUE CATALOGUE
  // ============================================================

  async getLeaguePage(page = 1, limit = 25): Promise<EspnApiResponse> {
    if (!Number.isInteger(page) || page < 1) {
      throw new BadRequestException('page must be a positive integer');
    }

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException(
        'limit must be an integer between 1 and 100',
      );
    }

    return this.request<EspnApiResponse>(
      `${this.coreBaseUrl}/leagues`,
      'leagues',
      {
        page: String(page),

        limit: String(limit),
      },
    );
  }

  async getLeagues(): Promise<EspnLeague[]> {
    const leagues: EspnLeague[] = [];

    const firstPage = await this.getLeaguePage(1, 25);

    leagues.push(...this.extractCatalogueLeagues(firstPage));

    const pageCount = this.getPageCount(firstPage);

    const pageSize = this.getPageSize(firstPage, 25);

    for (let page = 2; page <= pageCount; page += 1) {
      const response = await this.getLeaguePage(page, pageSize);

      leagues.push(...this.extractCatalogueLeagues(response));
    }

    return this.deduplicateLeagues(leagues);
  }

  // ============================================================
  // 2. LEAGUE DETAIL
  // ============================================================

  async getLeague(league: string): Promise<EspnLeague> {
    this.validateLeague(league);

    return this.request<EspnLeague>(
      `${this.coreBaseUrl}/leagues/${encodeURIComponent(
        league.trim().toLowerCase(),
      )}`,
      'league',
    );
  }

  // ============================================================
  // 3. SCOREBOARD — SINGLE DATE
  // ============================================================

  /**
   * Performs exactly ONE ESPN scoreboard request.
   *
   * The queue owns the date range and decides how many
   * individual dates must be processed.
   */
  async getFixturesForDate(
    league: string,
    date: string,
  ): Promise<EspnApiResponse> {
    this.validateLeague(league);

    if (!this.isValidDate(date)) {
      throw new BadRequestException('date must be a valid YYYY-MM-DD date');
    }

    return this.request<EspnApiResponse>(
      `${this.siteBaseUrl}/${encodeURIComponent(
        league.trim().toLowerCase(),
      )}/scoreboard`,
      'scoreboard',
      {
        dates: this.formatEspnDate(date),
      },
    );
  }

  // ============================================================
  // 4. LEAGUE SCOREBOARD
  // ============================================================

  /**
   * Legacy range-capable method.
   *
   * Queue workflows should prefer getFixturesForDate()
   * so each date is individually tracked.
   */
  async getFixtures(
    league: string,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<EspnApiResponse> {
    this.validateLeague(league);

    this.validateDateRange(dateFrom, dateTo);

    const normalizedLeague = league.trim().toLowerCase();

    if (dateFrom && dateTo) {
      const events: EspnEvent[] = [];

      let currentDate = dateFrom;

      while (currentDate <= dateTo) {
        const response = await this.getFixturesForDate(
          normalizedLeague,
          currentDate,
        );

        events.push(...this.extractEvents(response));

        currentDate = this.addOneDay(currentDate);
      }

      return {
        events: this.deduplicateEvents(events),
      };
    }

    if (dateFrom || dateTo) {
      return this.getFixturesForDate(normalizedLeague, dateFrom ?? dateTo!);
    }

    return this.request<EspnApiResponse>(
      `${this.siteBaseUrl}/${encodeURIComponent(normalizedLeague)}/scoreboard`,
      'scoreboard',
    );
  }

  // ============================================================
  // 5. RESULTS
  // ============================================================

  async getResults(
    league: string,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<EspnApiResponse> {
    return this.getFixtures(league, dateFrom, dateTo);
  }

  // ============================================================
  // 6. STANDINGS
  // ============================================================

  /**
   * Emergency/fallback provider endpoint.
   *
   * Normal match processing should first use:
   *
   *   fixture.payload.summary.standings
   *
   * This endpoint remains available when explicitly required.
   */
  async getStandings(league: string): Promise<EspnStandingsResponse> {
    this.validateLeague(league);

    return this.request<EspnStandingsResponse>(
      `${this.standingsBaseUrl}/${encodeURIComponent(
        league.trim().toLowerCase(),
      )}/standings`,
      'standings',
    );
  }

  // ============================================================
  // 7. MATCH SUMMARY
  // ============================================================

  /**
   * Primary detailed ESPN match-data endpoint.
   *
   * The returned payload is persisted directly as:
   *
   *   sports_espn_fixtures.payload.summary
   */
  async getMatchSummary(
    league: string,
    eventId: string,
  ): Promise<EspnMatchSummary> {
    this.validateLeague(league);

    this.validateId(eventId, 'eventId');

    return this.request<EspnMatchSummary>(
      `${this.siteBaseUrl}/${encodeURIComponent(
        league.trim().toLowerCase(),
      )}/summary`,
      'summary',
      {
        event: eventId.trim(),
      },
    );
  }

  // ============================================================
  // 8. GLOBAL LIVE SCOREBOARD
  // ============================================================

  /**
   * Live polling always uses the reserved ESPN live lane.
   *
   * The rate-limit service reserves one concurrent slot for
   * this lane so normal ESPN requests cannot starve live data.
   */
  async getLiveMatches(): Promise<EspnApiResponse> {
    return this.request<EspnApiResponse>(
      `${this.siteBaseUrl}/all/scoreboard`,
      'live-scoreboard',
      undefined,
      'live',
    );
  }

  // ============================================================
  // 9. GLOBAL SOCCER NEWS
  // ============================================================

  /**
   * Emergency/manual ESPN news endpoint.
   *
   * This remains available but is not part of the normal
   * scheduled sports synchronization pipeline.
   */
  async getNews(limit = 50): Promise<EspnNewsResponse> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException(
        'limit must be an integer between 1 and 100',
      );
    }

    return this.request<EspnNewsResponse>(`${this.newsBaseUrl}/news`, 'news', {
      sport: 'soccer',

      limit: String(limit),
    });
  }

  // ============================================================
  // REQUEST
  // ============================================================

  private async request<T>(
    endpoint: string,
    rateLimitEndpoint: string,
    params?: Record<string, string>,
    lane: SportsProviderRequestLane = 'normal',
  ): Promise<T> {
    return this.providerRateLimitService.execute(
      'espn',
      rateLimitEndpoint,
      async () => {
        try {
          const response = await this.http.get<T>(endpoint, {
            params,
          });

          this.assertResponse(response.data, endpoint);

          return response.data;
        } catch (error) {
          this.logApiError(error, endpoint);

          if (error instanceof InternalServerErrorException) {
            throw error;
          }

          throw new InternalServerErrorException('ESPN request failed');
        }
      },
      {
        lane,
      },
    );
  }

  // ============================================================
  // LEAGUE CATALOGUE EXTRACTION
  // ============================================================

  private extractCatalogueLeagues(response: EspnApiResponse): EspnLeague[] {
    const leagues: EspnLeague[] = [];

    if (Array.isArray(response.leagues)) {
      leagues.push(...response.leagues);
    }

    if (!Array.isArray(response.items)) {
      return leagues;
    }

    for (const item of response.items) {
      const reference = item.$ref?.trim();

      if (!reference) {
        continue;
      }

      const leagueSlug = this.extractLeagueSlug(reference);

      if (!leagueSlug) {
        continue;
      }

      leagues.push({
        id: leagueSlug,

        slug: leagueSlug,

        $ref: reference,
      });
    }

    return leagues;
  }

  private extractLeagueSlug(reference: string): string | null {
    try {
      const url = new URL(reference);

      const pathSegments = url.pathname.split('/').filter(Boolean);

      const leagueIndex = pathSegments.indexOf('leagues');

      if (leagueIndex < 0) {
        return null;
      }

      const slug = pathSegments[leagueIndex + 1];

      if (!slug) {
        return null;
      }

      return slug.trim().toLowerCase();
    } catch {
      return null;
    }
  }

  private deduplicateLeagues(leagues: EspnLeague[]): EspnLeague[] {
    const map = new Map<string, EspnLeague>();

    for (const league of leagues) {
      const slug =
        league.slug?.trim().toLowerCase() ?? league.id?.trim().toLowerCase();

      if (!slug) {
        continue;
      }

      const existing = map.get(slug);

      if (!existing) {
        map.set(slug, {
          ...league,

          id: league.id ?? slug,

          slug,
        });

        continue;
      }

      map.set(slug, {
        ...existing,

        ...league,

        id: league.id ?? existing.id ?? slug,

        slug,
      });
    }

    return [...map.values()];
  }

  // ============================================================
  // RESPONSE HELPERS
  // ============================================================

  private getPageCount(response: EspnApiResponse): number {
    const direct = this.toPositiveInteger(response.pageCount);

    if (direct) {
      return direct;
    }

    const pagination = (
      response as EspnApiResponse & {
        pagination?: Record<string, unknown>;
      }
    ).pagination;

    const nested = this.toPositiveInteger(pagination?.pageCount);

    return nested ?? 1;
  }

  private getPageSize(response: EspnApiResponse, fallback: number): number {
    const direct = this.toPositiveInteger(response.pageSize);

    if (direct) {
      return direct;
    }

    const pagination = (
      response as EspnApiResponse & {
        pagination?: Record<string, unknown>;
      }
    ).pagination;

    return this.toPositiveInteger(pagination?.pageSize) ?? fallback;
  }

  private extractEvents(response: EspnApiResponse): EspnEvent[] {
    if (Array.isArray(response.events)) {
      return response.events;
    }

    if (Array.isArray(response.items)) {
      return response.items as EspnEvent[];
    }

    return [];
  }

  private deduplicateEvents(events: EspnEvent[]): EspnEvent[] {
    const map = new Map<string, EspnEvent>();

    for (const event of events) {
      const eventId = this.toStringValue(event.id);

      if (!eventId) {
        continue;
      }

      map.set(eventId, event);
    }

    return [...map.values()];
  }

  private formatEspnDate(value: string): string {
    return value.replace(/-/g, '');
  }

  private addOneDay(value: string): string {
    const date = new Date(`${value}T00:00:00.000Z`);

    date.setUTCDate(date.getUTCDate() + 1);

    return date.toISOString().slice(0, 10);
  }

  private toPositiveInteger(value: unknown): number | undefined {
    const result = typeof value === 'number' ? value : Number(value);

    if (!Number.isInteger(result) || result < 1) {
      return undefined;
    }

    return result;
  }

  private toStringValue(value: unknown): string | undefined {
    if (value === null || value === undefined) {
      return undefined;
    }

    const result = String(value).trim();

    return result ? result : undefined;
  }

  // ============================================================
  // VALIDATION
  // ============================================================

  private validateLeague(league: string): void {
    if (!league || !league.trim()) {
      throw new BadRequestException('league is required');
    }
  }

  private validateId(value: string, field: string): void {
    if (!value || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }
  }

  private validateDateRange(dateFrom?: string, dateTo?: string): void {
    if (dateFrom !== undefined && !this.isValidDate(dateFrom)) {
      throw new BadRequestException('dateFrom must be a valid YYYY-MM-DD date');
    }

    if (dateTo !== undefined && !this.isValidDate(dateTo)) {
      throw new BadRequestException('dateTo must be a valid YYYY-MM-DD date');
    }

    if (dateFrom && dateTo && dateFrom > dateTo) {
      throw new BadRequestException('dateFrom cannot be after dateTo');
    }
  }

  private isValidDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }

    const date = new Date(`${value}T00:00:00.000Z`);

    if (Number.isNaN(date.getTime())) {
      return false;
    }

    return date.toISOString().slice(0, 10) === value;
  }

  // ============================================================
  // RESPONSE VALIDATION
  // ============================================================

  private assertResponse(data: unknown, endpoint: string): void {
    if (data === undefined || data === null) {
      throw new InternalServerErrorException(
        `ESPN returned an empty response for ${endpoint}`,
      );
    }
  }

  // ============================================================
  // ERROR LOGGING
  // ============================================================

  private logApiError(error: unknown, endpoint: string): void {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;

      this.logger.error(
        `ESPN request failed: ${endpoint} | ` +
          `status=${axiosError.response?.status ?? 'unknown'} | ` +
          `response=${JSON.stringify(axiosError.response?.data ?? null)} | ` +
          `message=${axiosError.message}`,
      );

      return;
    }

    this.logger.error(
      `ESPN request failed: ${endpoint} | ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
