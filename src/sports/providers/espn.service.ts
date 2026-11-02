import {
  BadRequestException,
  Injectable,
  BadGatewayException,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import axios, { AxiosError, AxiosInstance } from 'axios';

import {
  EspnApiResponse,
  EspnEvent,
  EspnLeague,
  EspnMatchSummary,
  EspnStandingsPayload,
} from './espn.interfaces';

import {
  SportsProviderRateLimitService,
  SportsProviderRequestLane,
} from '../services/sports-provider-rate-limit.service';

import { SPORTS_DATA_COLLECTION_CONFIG } from '../config/sports-data-collection.config';

@Injectable()
export class EspnService {
  private readonly logger = new Logger(EspnService.name);

  private readonly siteBaseUrl =
    'https://site.api.espn.com/apis/site/v2/sports/soccer';

  private readonly standingsBaseUrl =
    'https://site.api.espn.com/apis/v2/sports/soccer';

  private readonly coreBaseUrl =
    'https://sports.core.api.espn.com/v2/sports/soccer';

  private readonly http: AxiosInstance;

  private readonly scoreboardMonthLimit =
    SPORTS_DATA_COLLECTION_CONFIG.ESPN.fixtures.startupMonthLimit;

  private readonly transientRetryCount =
    SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.maxRetries;

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
   * Returns fixtures for one date using a calendar-month scoreboard request.
   * The API is never queried with a single-day dates parameter.
   */
  async getFixturesForDate(
    league: string,
    date: string,
  ): Promise<EspnApiResponse> {
    this.validateLeague(league);

    if (!this.isValidDate(date)) {
      throw new BadRequestException('date must be a valid YYYY-MM-DD date');
    }

    const month = date.slice(0, 7).replace('-', '');
    const response = await this.getFixturesForMonth(league, month);

    return {
      ...response,
      events: this.extractEvents(response).filter(
        (event) =>
          typeof event.date === 'string' && event.date.slice(0, 10) === date,
      ),
    };
  }

  // ============================================================
  // 4. SCOREBOARD — SINGLE MONTH
  // ============================================================

  /**
   * Performs exactly one ESPN scoreboard request for a calendar month.
   *
   * Current public ESPN scoreboard testing supports YYYYMM. The old
   * YYYYMMDD-YYYYMMDD range form is intentionally not used.
   */
  async getFixturesForMonth(
    league: string,
    month: string,
    limit = this.scoreboardMonthLimit,
  ): Promise<EspnApiResponse> {
    this.validateLeague(league);

    if (!this.isValidMonth(month)) {
      throw new BadRequestException(
        'month must be a valid YYYYMM calendar month',
      );
    }

    const maxLimit =
      SPORTS_DATA_COLLECTION_CONFIG.ESPN.fixtures.startupMonthLimit;

    if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
      throw new BadRequestException(
        `limit must be an integer between 1 and ${maxLimit}`,
      );
    }

    const response = await this.request<EspnApiResponse>(
      `${this.siteBaseUrl}/${encodeURIComponent(
        league.trim().toLowerCase(),
      )}/scoreboard`,
      'scoreboard',
      {
        dates: month,
        limit: String(limit),
      },
    );

    if (this.extractEvents(response).length >= limit) {
      const message =
        `ESPN monthly scoreboard reached the configured limit=${limit} ` +
        `for ${league}/${month}. Completeness cannot be guaranteed; ` +
        'the month must remain incomplete until a complete monthly response is available.';
      this.logger.error(message);
      throw new ServiceUnavailableException(message);
    }

    return response;
  }

  // ============================================================
  // 5. LEAGUE SCOREBOARD
  // ============================================================

  /**
   * Returns the fixture events for the requested date window.
   *
   * Date ranges are fulfilled month-by-month rather than using ESPN's
   * currently unreliable hyphenated date-range syntax. Events are then
   * filtered back to the exact requested date window.
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
      const months = this.buildMonthRange(dateFrom, dateTo);

      for (const month of months) {
        const response = await this.getFixturesForMonth(
          normalizedLeague,
          month,
          this.scoreboardMonthLimit,
        );

        for (const event of this.extractEvents(response)) {
          const eventDate =
            typeof event.date === 'string' ? event.date.slice(0, 10) : '';

          if (eventDate >= dateFrom && eventDate <= dateTo) {
            events.push(event);
          }
        }
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
   * Dedicated ESPN standings endpoint.
   *
   * The only source of standings for leagues and cup/group competitions.
   * The complete response is persisted unchanged by EspnStandingsService.
   */
  async getStandings(
    league: string,
    season?: number,
  ): Promise<EspnStandingsPayload> {
    if (
      !SPORTS_DATA_COLLECTION_CONFIG.ESPN.endpoints.dedicatedStandingsEnabled &&
      process.env.SPORTS_ENABLE_ESPN_STANDINGS_ENDPOINT !== 'true'
    ) {
      throw new ServiceUnavailableException(
        'Dedicated ESPN standings endpoint is disabled',
      );
    }
    this.validateLeague(league);

    const normalizedLeague = league.trim().toLowerCase();
    const params = Number.isInteger(season)
      ? { season: String(season) }
      : undefined;
    const endpoint = `${this.standingsBaseUrl}/${encodeURIComponent(normalizedLeague)}/standings`;
    const base = await this.request<EspnStandingsPayload>(
      endpoint,
      'standings',
      params,
    );
    const rawPayloads: Record<string, EspnStandingsPayload> = { default: base };
    const discoveredStages = this.discoverStandingsStages(base);
    const baseHasTable = this.hasUsableStandingsTable(base);
    const stagePayloads: Array<{
      id: string;
      name: string;
      payload: EspnStandingsPayload;
    }> = [];
    const failedStageIds: string[] = [];

    // A single-table competition should not receive duplicate stage requests.
    // Multi-stage competitions are queried per stage so one available table
    // cannot hide another stage's missing data.
    const shouldQueryStages = discoveredStages.length > 1 || !baseHasTable;
    if (shouldQueryStages) {
      for (const stage of discoveredStages) {
        try {
          const stagePayload = await this.request<EspnStandingsPayload>(
            endpoint,
            'standings',
            {
              ...(params ?? {}),
              seasontype: stage.id,
            },
          );
          rawPayloads[`stage:${stage.id}`] = stagePayload;
          if (this.hasUsableStandingsTable(stagePayload)) {
            stagePayloads.push({ ...stage, payload: stagePayload });
          } else {
            failedStageIds.push(stage.id);
          }
        } catch (error) {
          failedStageIds.push(stage.id);
          this.logger.warn(
            `ESPN standings stage unavailable: league=${normalizedLeague} season=${season ?? 'current'} stage=${stage.id} reason=${this.errorSummary(error)}`,
          );
        }
      }
    }

    const retrievedStageIds = stagePayloads.map((stage) => stage.id);
    if (!shouldQueryStages && baseHasTable && discoveredStages.length === 1) {
      retrievedStageIds.push(discoveredStages[0].id);
    }
    const missingStageIds = discoveredStages
      .map((stage) => stage.id)
      .filter((id) => failedStageIds.includes(id));
    const mergedChildren: unknown[] = Array.isArray(base.children)
      ? [...base.children]
      : [];
    for (const stage of stagePayloads) {
      const stageChildren = Array.isArray(stage.payload.children)
        ? stage.payload.children
        : [];
      if (stageChildren.length > 0) {
        for (const child of stageChildren) {
          const childRecord = this.asPlainRecord(child);
          const childId =
            childRecord && typeof childRecord.id === 'string'
              ? childRecord.id
              : '';
          const duplicate =
            childId &&
            mergedChildren.some((existing) => {
              const existingRecord = this.asPlainRecord(existing);
              return (
                existingRecord &&
                this.toStringValue(existingRecord.id) === childId
              );
            });
          if (!duplicate) mergedChildren.push(child);
        }
      } else if (stage.payload.standings) {
        mergedChildren.push({
          id: stage.id,
          name: stage.name,
          standings: stage.payload.standings,
        });
      }
    }

    const mergedTableView = {
      ...base,
      ...(mergedChildren.length ? { children: mergedChildren } : {}),
    };
    const tableCount = this.countStandingsTables(mergedTableView);

    const merged: EspnStandingsPayload = {
      ...base,
      ...(mergedChildren.length
        ? { children: mergedChildren as EspnStandingsPayload['children'] }
        : {}),
      rawPayloads,
      standingsCollection: {
        discoveredStageIds: discoveredStages.map((stage) => stage.id),
        retrievedStageIds,
        missingStageIds,
        tableCount,
        baseHasTable,
      },
    };

    if (tableCount === 0) {
      const payloadDiagnostics = Object.entries(rawPayloads)
        .map(
          ([payloadKey, payload]) =>
            `${payloadKey}{${this.describeStandingsPayload(payload)}}`,
        )
        .join('; ')
        .slice(0, 900);
      const reason =
        `ESPN standings unavailable: no usable table for ${normalizedLeague}/${season ?? 'current'}; ` +
        `discoveredStages=${discoveredStages.length}; retrievedStages=${stagePayloads.length}; ` +
        `payloadDiagnostics=${payloadDiagnostics || 'none'}`;

      // Log only payload structure and counts. Do not dump the full provider
      // response into logs, because it can be large and contain irrelevant data.
      this.logger.warn(reason);
      throw new ServiceUnavailableException(reason);
    }

    this.logger.log(
      `ESPN standings fetched: league=${normalizedLeague} season=${season ?? 'current'} tables=${tableCount} stages=${retrievedStageIds.length}/${discoveredStages.length} missing=${missingStageIds.length}`,
    );
    return merged;
  }

  private discoverStandingsStages(
    value: unknown,
  ): Array<{ id: string; name: string }> {
    const found = new Map<string, { id: string; name: string }>();
    const visited = new Set<object>();
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (visited.has(node)) return;
      visited.add(node);
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      const record = node as Record<string, unknown>;
      if (record.hasStandings === true) {
        const rawId = record.id ?? record.value ?? record.typeId;
        const id = this.toStringValue(rawId) ?? '';
        if (id && id.length <= 32) {
          const name =
            typeof record.name === 'string' && record.name.trim()
              ? record.name.trim()
              : `Stage ${id}`;
          found.set(id, { id, name });
        }
      }
      for (const child of Object.values(record)) visit(child);
    };
    visit(value);
    return [...found.values()];
  }

  /** Summarize likely ESPN standings response shapes without logging the payload. */
  private describeStandingsPayload(value: unknown): string {
    const visited = new Set<object>();
    let standingsNodes = 0;
    let populatedTables = 0;
    let entryCount = 0;
    let stageFlags = 0;

    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object' || visited.has(node)) return;
      visited.add(node);
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }

      const record = node as Record<string, unknown>;
      if (record.hasStandings === true) stageFlags += 1;
      const standings = record.standings;
      if (
        standings &&
        typeof standings === 'object' &&
        !Array.isArray(standings)
      ) {
        standingsNodes += 1;
        const entries = (standings as Record<string, unknown>).entries;
        if (Array.isArray(entries)) {
          if (entries.length > 0) populatedTables += 1;
          entryCount += entries.length;
        }
      }
      for (const [key, child] of Object.entries(record)) {
        if (key !== 'rawPayloads' && key !== 'standingsCollection')
          visit(child);
      }
    };

    visit(value);
    const record =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    const topLevelKeys = record
      ? Object.keys(record).slice(0, 12).join(',')
      : 'non-object';
    const childCount =
      record && Array.isArray(record.children) ? record.children.length : 0;
    return `keys=${topLevelKeys || 'none'},children=${childCount},stageFlags=${stageFlags},standingsNodes=${standingsNodes},populatedTables=${populatedTables},entries=${entryCount}`;
  }

  private hasUsableStandingsTable(value: unknown): boolean {
    const visited = new Set<object>();
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== 'object') return false;
      if (visited.has(node)) return false;
      visited.add(node);
      if (Array.isArray(node)) return node.some(visit);
      const record = node as Record<string, unknown>;
      const standings = record.standings;
      if (
        standings &&
        typeof standings === 'object' &&
        !Array.isArray(standings)
      ) {
        const entries = (standings as Record<string, unknown>).entries;
        if (Array.isArray(entries) && entries.length > 0) return true;
      }
      return Object.entries(record)
        .filter(
          ([key]) => key !== 'rawPayloads' && key !== 'standingsCollection',
        )
        .some(([, child]) => visit(child));
    };
    return visit(value);
  }

  private countStandingsTables(value: unknown): number {
    const visited = new Set<object>();
    let count = 0;
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object' || visited.has(node)) return;
      visited.add(node);
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      const record = node as Record<string, unknown>;
      const standings = record.standings;
      if (
        standings &&
        typeof standings === 'object' &&
        !Array.isArray(standings)
      ) {
        const entries = (standings as Record<string, unknown>).entries;
        if (Array.isArray(entries) && entries.length > 0) count += 1;
      }
      for (const [key, child] of Object.entries(record)) {
        if (key !== 'rawPayloads' && key !== 'standingsCollection')
          visit(child);
      }
    };
    visit(value);
    return count;
  }

  private asPlainRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private errorSummary(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\r\n]+/g, ' ').slice(0, 180);
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
    if (
      !SPORTS_DATA_COLLECTION_CONFIG.ESPN.endpoints
        .globalLiveScoreboardEnabled &&
      process.env.SPORTS_ENABLE_ESPN_GLOBAL_LIVE_SCOREBOARD !== 'true'
    ) {
      throw new ServiceUnavailableException(
        'ESPN global live scoreboard is disabled; per-league scoreboards are used for normal collection',
      );
    }
    return this.request<EspnApiResponse>(
      `${this.siteBaseUrl}/all/scoreboard`,
      'live-scoreboard',
      undefined,
      'live',
    );
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
        let attempt = 0;

        while (true) {
          try {
            const response = await this.http.get<T>(endpoint, {
              params,
            });

            this.assertResponse(response.data, endpoint);

            return response.data;
          } catch (error) {
            attempt += 1;

            const isAxiosError = axios.isAxiosError(error);

            const axiosError = isAxiosError ? (error as AxiosError) : undefined;

            const status = axiosError?.response?.status;
            const errorCode = axiosError?.code ?? 'UNKNOWN';
            const errorMessage =
              error instanceof Error ? error.message : String(error);

            const retryable = this.isTransientError(error);

            if (retryable && attempt <= this.transientRetryCount) {
              const retryAfterMs = this.getRetryAfterMilliseconds(error);

              this.providerRateLimitService.reportThrottle(
                'espn',
                rateLimitEndpoint,
                status,
                retryAfterMs,
              );

              const delay =
                retryAfterMs ?? this.getTransientRetryDelay(attempt, status);

              this.logger.warn(
                `Retrying ESPN request: ` +
                  `endpoint=${this.endpointLabel(endpoint, params)} ` +
                  `attempt=${attempt}/${this.transientRetryCount} ` +
                  `status=${status ?? 'unknown'} ` +
                  `code=${errorCode} ` +
                  `message=${JSON.stringify(errorMessage)} ` +
                  `delay=${delay}ms`,
              );

              await this.sleep(delay);

              continue;
            }

            this.logApiError(error, endpoint, params);

            if (error instanceof InternalServerErrorException) {
              throw error;
            }

            if (axiosError && status) {
              if (status >= 400 && status < 500) {
                throw new BadGatewayException(
                  `ESPN request failed with status ${status}`,
                );
              }
            }

            throw new ServiceUnavailableException('ESPN request failed');
          }
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

  private buildMonthRange(dateFrom: string, dateTo: string): string[] {
    const start = new Date(`${dateFrom.slice(0, 7)}-01T00:00:00.000Z`);
    const end = new Date(`${dateTo.slice(0, 7)}-01T00:00:00.000Z`);

    const months: string[] = [];

    while (start.getTime() <= end.getTime()) {
      months.push(
        `${start.getUTCFullYear()}${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
      );

      start.setUTCMonth(start.getUTCMonth() + 1);
    }

    return months;
  }

  private isValidMonth(value: string): boolean {
    if (!/^\d{6}$/.test(value)) {
      return false;
    }

    const month = Number(value.slice(4, 6));

    return month >= 1 && month <= 12;
  }

  private isTransientError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return error instanceof ServiceUnavailableException;
    }

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return true;
    }

    const status = error.response?.status;

    return (
      status === 429 ||
      status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504
    );
  }

  private getRetryAfterMilliseconds(error: unknown): number | undefined {
    if (!axios.isAxiosError(error)) {
      return undefined;
    }

    const value: unknown = error.response?.headers?.['retry-after'];

    if (value === undefined) {
      return undefined;
    }

    const raw: unknown = Array.isArray(value) ? value[0] : value;
    const numeric = Number(raw);

    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.min(60_000, numeric * 1000);
    }

    const date = new Date(String(raw));

    if (!Number.isNaN(date.getTime())) {
      return Math.min(60_000, Math.max(0, date.getTime() - Date.now()));
    }

    return undefined;
  }

  private getTransientRetryDelay(attempt: number, status?: number): number {
    const base = status === 429 ? 30_000 : 500;
    const exponential = Math.min(60_000, base * Math.pow(2, attempt - 1));
    const jitter = Math.floor(
      Math.random() * Math.max(100, exponential * 0.25),
    );

    return exponential + jitter;
  }

  private async sleep(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) {
      return;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }

  private toPositiveInteger(value: unknown): number | undefined {
    const result = typeof value === 'number' ? value : Number(value);

    if (!Number.isInteger(result) || result < 1) {
      return undefined;
    }

    return result;
  }

  private toStringValue(value: unknown): string | undefined {
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'bigint' &&
      typeof value !== 'boolean'
    ) {
      return undefined;
    }

    const result = value.toString().trim();

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

  private endpointLabel(
    endpoint: string,
    params?: Record<string, string>,
  ): string {
    try {
      const url = new URL(endpoint);

      if (params) {
        for (const [key, value] of Object.entries(params)) {
          url.searchParams.set(key, value);
        }
      }

      const query = url.searchParams.toString();

      return `${url.pathname}${query ? `?${query}` : ''}`;
    } catch {
      return endpoint.split('?')[0].slice(0, 180);
    }
  }

  private logApiError(
    error: unknown,
    endpoint: string,
    params?: Record<string, string>,
  ): void {
    const requestEndpoint = this.endpointLabel(endpoint, params);

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;

      const status = axiosError.response?.status ?? 'unknown';
      const code = axiosError.code ?? 'UNKNOWN';
      const message = axiosError.message || 'No error message available';

      let responseBody = 'none';

      if (axiosError.response?.data !== undefined) {
        try {
          const serialized = JSON.stringify(axiosError.response.data);

          responseBody =
            serialized.length > 1000
              ? `${serialized.slice(0, 1000)}...[truncated]`
              : serialized;
        } catch {
          responseBody = '[Unable to serialize response body]';
        }
      }

      this.logger.error(
        `ESPN request failed: ` +
          `endpoint=${requestEndpoint} ` +
          `method=${axiosError.config?.method?.toUpperCase() ?? 'GET'} ` +
          `status=${status} ` +
          `code=${code} ` +
          `message=${JSON.stringify(message)} ` +
          `responseBody=${responseBody}`,
      );

      return;
    }

    const message = error instanceof Error ? error.message : String(error);

    this.logger.error(
      `ESPN request failed: ` +
        `endpoint=${requestEndpoint} ` +
        `status=unknown ` +
        `code=NON_AXIOS_ERROR ` +
        `message=${JSON.stringify(message)}`,
    );
  }
}
