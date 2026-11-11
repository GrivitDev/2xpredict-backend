import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosInstance } from 'axios';

import { SPORTS_PROVIDER_CONFIG } from '../config/sports-provider.config';
import { SPORTS_DATA_COLLECTION_CONFIG } from '../config/sports-data-collection.config';
import type {
  ProviderCollection,
  ProviderJsonObject,
  ProviderPagedResponse,
} from '../interfaces/provider-response.interface';
import { SportsProviderRequestError } from './sports-provider-request.error';

const CORE_HOSTS = new Set([
  'sports.core.api.espn.com',
  'sports.core.api.espn.pvt',
]);
const SITE_HOSTS = new Set(['site.api.espn.com']);

interface EspnEndpointRuntime {
  attempts: number;
  successes: number;
  failures: number;
  retries: number;
  lastRequestAt?: Date;
  lastSuccessfulAt?: Date;
  lastFailedAt?: Date;
  lastStatusCode?: number;
}

/**
 * Transport adapter for the ESPN Soccer Core API v2 and Site API v2.
 *
 * Core collection endpoints return paginated `items` arrays whose members are
 * commonly `$ref` pointers. This client expands season, odds and play pointers
 * before handing those datasets to the normalizer. Catalogue endpoints keep
 * team/league pointers intact because those pointers are the discovery source
 * for their dedicated detail jobs.
 */
@Injectable()
export class EspnV2Client {
  private readonly logger = new Logger(EspnV2Client.name);
  private readonly http: AxiosInstance;
  private readonly coreBaseUrl = SPORTS_PROVIDER_CONFIG.espn.coreBaseUrl;
  private readonly siteBaseUrl = SPORTS_PROVIDER_CONFIG.espn.siteBaseUrl;
  private readonly minIntervalMs = this.readPositiveConfig(
    process.env.SPORTS_ESPN_MIN_INTERVAL_MS,
    SPORTS_PROVIDER_CONFIG.espn.minIntervalMs,
  );
  private lastRequestStartedAt = 0;
  private readonly requestWaiters: Array<{ label: string; resolve: () => void }> = [];
  private requestSchedulerTimer?: ReturnType<typeof setTimeout>;
  private activeNormalRequests = 0;
  private activeLiveRequests = 0;
  private readonly maxNormalInFlight = Math.max(1, SPORTS_DATA_COLLECTION_CONFIG.ESPN.rateLimit.normalConcurrency);
  private readonly maxLiveInFlight = Math.max(1, SPORTS_DATA_COLLECTION_CONFIG.ESPN.rateLimit.liveConcurrency);
  private providerCooldownUntil = 0;
  private waitingRequests = 0;
  private activeRequests = 0;
  private requestAttempts = 0;
  private successfulResponses = 0;
  private failedResponses = 0;
  private retryAttempts = 0;
  private rateLimitedResponses = 0;
  private serverErrorResponses = 0;
  private consecutiveFailures = 0;
  private lastRequestAt?: Date;
  private lastSuccessfulAt?: Date;
  private lastFailedAt?: Date;
  private lastFailure?: string;
  private lastFailureStatusCode?: number;
  private lastRequestLabel?: string;
  private readonly endpointRuntime = new Map<string, EspnEndpointRuntime>();
  private readonly summaryCache = new Map<
    string,
    { expiresAt: number; value: ProviderJsonObject }
  >();
  private readonly summaryInflight = new Map<
    string,
    Promise<ProviderJsonObject>
  >();

  constructor() {
    this.http = axios.create({
      timeout: SPORTS_PROVIDER_CONFIG.espn.timeoutMs,
      headers: { Accept: 'application/json' },
      maxContentLength: 15 * 1024 * 1024,
      maxBodyLength: 15 * 1024 * 1024,
    });
  }

  /**
   * In-memory transport telemetry. It intentionally contains endpoint labels,
   * counters and timestamps only; no request URLs, query values or API data.
   */
  getRuntimeStatus(): Record<string, unknown> {
    const endpoints = Object.fromEntries(
      [...this.endpointRuntime.entries()].map(([label, metrics]) => [
        label,
        { ...metrics },
      ]),
    );
    return {
      provider: 'ESPN',
      requestAttempts: this.requestAttempts,
      successfulResponses: this.successfulResponses,
      failedResponses: this.failedResponses,
      retryAttempts: this.retryAttempts,
      rateLimitedResponses: this.rateLimitedResponses,
      serverErrorResponses: this.serverErrorResponses,
      activeRequests: this.activeRequests,
      activeNormalRequests: this.activeNormalRequests,
      activeLiveRequests: this.activeLiveRequests,
      maxNormalInFlight: this.maxNormalInFlight,
      maxLiveInFlight: this.maxLiveInFlight,
      waitingRequests: this.waitingRequests,
      consecutiveFailures: this.consecutiveFailures,
      lastRequestAt: this.lastRequestAt,
      lastSuccessfulAt: this.lastSuccessfulAt,
      lastFailedAt: this.lastFailedAt,
      lastFailure: this.lastFailure,
      lastFailureStatusCode: this.lastFailureStatusCode,
      lastRequestLabel: this.lastRequestLabel,
      cooldownUntil:
        this.providerCooldownUntil > 0
          ? new Date(this.providerCooldownUntil)
          : undefined,
      minIntervalMs: this.minIntervalMs,
      summaryCacheEntries: this.summaryCache.size,
      summaryInflightEntries: this.summaryInflight.size,
      endpointCount: this.endpointRuntime.size,
      endpoints,
    };
  }

  // ---------------------------------------------------------------------------
  // Discovery: Core API v2
  // ---------------------------------------------------------------------------

  getLeagueCatalogue(): Promise<ProviderCollection<unknown>> {
    return this.getPagedCollection(
      `${this.coreBaseUrl}/leagues`,
      'league-catalogue',
    );
  }

  async getLeagueDetails(leagueId: string): Promise<ProviderJsonObject> {
    const league = this.requiredPathId(leagueId, 'leagueId');
    const details = await this.get(
      `${this.coreBaseUrl}/leagues/${league}`,
      'league-details',
    );
    // The league detail response's `season` pointer contains the current season
    // reference. Expand it so the caller gets year and season boundaries.
    const season = await this.resolveNestedReference(
      details.season ?? details.currentSeason,
      'current-season-details',
    );
    return season ? { ...details, season } : details;
  }

  async getLeagueSeasons(
    leagueId: string,
    catalogueReference?: string,
  ): Promise<ProviderCollection<unknown>> {
    const league = this.requiredPathId(leagueId, 'leagueId');
    const url = catalogueReference
      ? this.normalizeReferenceUrl(catalogueReference, 'league-seasons')
      : `${this.coreBaseUrl}/leagues/${league}/seasons`;
    const collection = await this.getPagedCollection(url, 'league-seasons');
    const items = await this.resolveCollectionReferencesStrict(
      collection.items,
      'season-details',
    );
    return { ...collection, items };
  }

  getSeasonDetails(
    leagueId: string,
    season: number | string,
  ): Promise<ProviderJsonObject> {
    const league = this.requiredPathId(leagueId, 'leagueId');
    const seasonId = this.requiredPathId(String(season), 'season');
    return this.get(
      `${this.coreBaseUrl}/leagues/${league}/seasons/${seasonId}`,
      'season-details',
    );
  }

  getCompetitionTeams(
    leagueId: string,
    catalogueReference?: string,
  ): Promise<ProviderCollection<unknown>> {
    const league = this.requiredPathId(leagueId, 'leagueId');
    // ESPN league details exposes the authoritative season-scoped teams $ref
    // (for example /leagues/eng.1/seasons/2026/teams). Prefer it over
    // reconstructing a URL because the season path is present in live payloads.
    const url = catalogueReference
      ? this.normalizeReferenceUrl(catalogueReference, 'competition-teams')
      : `${this.coreBaseUrl}/leagues/${league}/teams`;
    // Team catalogue items are deliberately left as $ref pointers. Individual
    // team detail requests are separate queue jobs and use those exact pointers.
    return this.getPagedCollection(url, 'competition-teams');
  }

  getTeamDetails(
    leagueId: string,
    teamId: string,
    teamReference?: string,
  ): Promise<ProviderJsonObject> {
    const league = this.requiredPathId(leagueId, 'leagueId');
    const team = this.requiredPathId(teamId, 'teamId');
    const url = teamReference
      ? this.normalizeReferenceUrl(teamReference, 'team-details')
      : `${this.coreBaseUrl}/leagues/${league}/teams/${team}`;
    return this.get(url, 'team-details');
  }

  // ---------------------------------------------------------------------------
  // Fixtures: Site API scoreboard
  // ---------------------------------------------------------------------------

  getDailyScoreboard(
    leagueId: string,
    date: string,
  ): Promise<ProviderJsonObject> {
    const league = this.requiredPathId(leagueId, 'leagueId');
    return this.get(
      `${this.siteBaseUrl}/${league}/scoreboard`,
      'daily-scoreboard',
      { dates: this.toCompactDate(date) },
    );
  }

  getMonthlyScoreboard(
    leagueId: string,
    month: string,
  ): Promise<ProviderJsonObject> {
    const league = this.requiredPathId(leagueId, 'leagueId');
    return this.get(
      `${this.siteBaseUrl}/${league}/scoreboard`,
      'monthly-scoreboard',
      { dates: this.toCompactMonth(month) },
    );
  }

  getLiveScoreboard(leagueId: string): Promise<ProviderJsonObject> {
    const league = this.requiredPathId(leagueId, 'leagueId');
    return this.get(
      `${this.siteBaseUrl}/${league}/scoreboard`,
      'live-scoreboard',
    );
  }

  // ---------------------------------------------------------------------------
  // ESPN Soccer news (Site API v2)
  // ---------------------------------------------------------------------------

  getSoccerNews(limit = 50, offset = 0): Promise<ProviderJsonObject> {
    // Use the sport-filtered Now feed, never the unfiltered cross-sport feed.
    // The response exposes headlines[] and breakingNews[] rather than the
    // Site API's league-news `news.articles` envelope. Offset is supported by
    // the feed so a daily run can collect more than its first page.
    return this.get(SPORTS_PROVIDER_CONFIG.espn.nowNewsBaseUrl, 'soccer-news', {
      sport: 'soccer',
      limit: String(this.clampLimit(limit)),
      offset: String(Math.max(0, Math.floor(offset))),
    });
  }

  getLeagueNews(leagueId: string, limit = 100): Promise<ProviderJsonObject> {
    const league = this.requiredPathId(leagueId, 'leagueId');
    return this.get(`${this.siteBaseUrl}/${league}/news`, 'league-news', {
      limit: String(this.clampLimit(limit)),
    });
  }

  private clampLimit(value: number): number {
    return Math.max(
      1,
      Math.min(100, Math.floor(Number.isFinite(value) ? value : 100)),
    );
  }

  // ---------------------------------------------------------------------------
  // Fixture-specific Core API endpoints
  // ---------------------------------------------------------------------------

  async getMatchOdds(
    leagueId: string,
    eventId: string,
    competitionId = eventId,
  ): Promise<ProviderCollection<unknown>> {
    const path = this.matchCompetitionPath(leagueId, eventId, competitionId);
    const collection = await this.getPagedCollection(
      `${path}/odds`,
      'match-odds',
      {},
      SPORTS_PROVIDER_CONFIG.espn.pageSize,
    );
    const items = await this.resolveCollectionReferencesStrict(
      collection.items,
      'match-odds-detail',
    );
    const expanded = await this.mapWithConcurrency(
      items,
      SPORTS_PROVIDER_CONFIG.espn.referenceConcurrency,
      (item) => this.expandOddsPropBets(item),
    );
    return {
      ...collection,
      items: expanded,
      rawResponse: { ...(collection.rawResponse ?? {}), items: expanded },
    };
  }

  async getMatchPlays(
    leagueId: string,
    eventId: string,
    competitionId = eventId,
  ): Promise<ProviderCollection<unknown>> {
    const path = this.matchCompetitionPath(leagueId, eventId, competitionId);
    const endpoint = `${path}/plays`;
    let sourceFiltered: ProviderCollection<unknown> | undefined;
    let sourceFilteredError: unknown;

    // Source 38 (SA.ENVOY) is populated for many ESPN soccer fixtures, but it
    // is not guaranteed to be available for every competition or event. Do not
    // treat an empty source-filtered collection as proof that ESPN has no plays.
    try {
      sourceFiltered = await this.getPagedCollection(
        endpoint,
        'match-plays-source-38',
        { source: SPORTS_PROVIDER_CONFIG.espn.playsSourceId },
        SPORTS_PROVIDER_CONFIG.espn.playsPageSize,
      );
    } catch (error) {
      sourceFilteredError = error;
    }

    let collection = sourceFiltered;
    let sourceFallbackUsed = false;
    if (!collection?.items.length) {
      try {
        collection = await this.getPagedCollection(
          endpoint,
          'match-plays-all-sources',
          {},
          SPORTS_PROVIDER_CONFIG.espn.playsPageSize,
        );
        sourceFallbackUsed = true;
      } catch (fallbackError) {
        // Preserve the first provider failure where possible. The collection
        // service will still attempt the Site Summary fallback afterwards.
        if (!sourceFilteredError) throw fallbackError;
        throw new SportsProviderRequestError(
          `ESPN Core Plays failed with source=${SPORTS_PROVIDER_CONFIG.espn.playsSourceId} and without a source filter.`,
          {
            provider: 'ESPN',
            endpoint,
            retryable: true,
          },
          { cause: sourceFilteredError },
        );
      }
    }

    if (!collection) {
      throw sourceFilteredError ?? new SportsProviderRequestError(
        'ESPN Core Plays returned no collection response.',
        { provider: 'ESPN', endpoint, retryable: true },
      );
    }

    const items = await this.resolveCollectionReferencesStrict(
      collection.items,
      'match-play-detail',
    );
    return {
      ...collection,
      items,
      rawResponse: {
        ...(collection.rawResponse ?? {}),
        items,
        playsCollectionDiagnostics: {
          sourceFilteredCount: sourceFiltered?.items.length ?? 0,
          sourceFilteredError: sourceFilteredError instanceof Error
            ? sourceFilteredError.message.slice(0, 300)
            : undefined,
          selectedSource: sourceFallbackUsed ? 'ALL_SOURCES' : SPORTS_PROVIDER_CONFIG.espn.playsSourceId,
          sourceFallbackUsed,
        },
      },
    };
  }

  async getMatchSummary(
    leagueId: string,
    eventId: string,
  ): Promise<ProviderJsonObject> {
    const league = this.requiredPathId(leagueId, 'leagueId');
    const event = this.requiredPathId(eventId, 'eventId');
    const key = `${league}:${event}`;
    const cached = this.summaryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) this.summaryCache.delete(key);
    const existing = this.summaryInflight.get(key);
    if (existing) return existing;

    const pending = this.get(
      `${this.siteBaseUrl}/${league}/summary`,
      'match-summary-fallback',
      { event },
    );
    this.summaryInflight.set(key, pending);
    try {
      const value = await pending;
      this.pruneSummaryCache();
      // Keep the fallback cache bounded even when many distinct finished
      // matches are recovered only once during a long-lived worker process.
      if (this.summaryCache.size >= 250) {
        let oldest: string | undefined;
        for (const cacheKey of this.summaryCache.keys()) {
          oldest = cacheKey;
          break;
        }
        if (oldest) this.summaryCache.delete(oldest);
      }
      this.summaryCache.set(key, {
        expiresAt: Date.now() + SPORTS_PROVIDER_CONFIG.espn.summaryCacheTtlMs,
        value,
      });
      return value;
    } finally {
      this.summaryInflight.delete(key);
    }
  }

  invalidateSummary(leagueId: string, eventId: string): void {
    this.summaryCache.delete(`${leagueId}:${eventId}`);
  }

  private pruneSummaryCache(): void {
    const now = Date.now();
    for (const [key, cached] of this.summaryCache) {
      if (cached.expiresAt <= now) this.summaryCache.delete(key);
    }
  }

  // ---------------------------------------------------------------------------
  // Collection and reference handling
  // ---------------------------------------------------------------------------

  private async getPagedCollection(
    url: string,
    label: string,
    extraParams: Record<string, string> = {},
    pageSize = SPORTS_PROVIDER_CONFIG.espn.pageSize,
  ): Promise<ProviderCollection<unknown>> {
    const safePageSize = Math.max(1, Math.min(1_000, Math.floor(pageSize)));
    const first = await this.get<ProviderPagedResponse>(url, label, {
      ...extraParams,
      page: '1',
      limit: String(safePageSize),
    });
    const firstItems = this.extractItems(first);
    const totalCount = this.readNonNegativeInteger(first.count);
    const declaredPageCount = this.readPositiveInteger(first.pageCount);
    const declaredPageSize =
      this.readPositiveInteger(first.pageSize, safePageSize) ?? safePageSize;
    const inferredPageCount =
      totalCount === undefined
        ? undefined
        : Math.ceil(totalCount / declaredPageSize);
    const pageCount = Math.max(1, declaredPageCount ?? inferredPageCount ?? 1);
    const probeUntilShortPage =
      declaredPageCount === undefined &&
      totalCount === undefined &&
      firstItems.length >= safePageSize;

    if (pageCount > SPORTS_PROVIDER_CONFIG.espn.maxPages) {
      throw new SportsProviderRequestError(
        `ESPN ${label} declares ${pageCount} pages, exceeding the configured ceiling.`,
        {
          provider: 'ESPN',
          endpoint: url,
          retryable: false,
        },
      );
    }

    const allItems = [...firstItems];
    const pageFingerprints = new Set([this.pageFingerprint(firstItems)]);
    let completedPages = 1;
    const lastPage = probeUntilShortPage
      ? SPORTS_PROVIDER_CONFIG.espn.maxPages
      : pageCount;

    for (let page = 2; page <= lastPage; page += 1) {
      const response = await this.get<ProviderPagedResponse>(url, label, {
        ...extraParams,
        page: String(page),
        limit: String(safePageSize),
      });
      const pageItems = this.extractItems(response);
      if (pageItems.length === 0) {
        if (!probeUntilShortPage && page <= pageCount) {
          throw new SportsProviderRequestError(
            `ESPN ${label} stopped at page ${page}; pageCount declares ${pageCount}.`,
            { provider: 'ESPN', endpoint: url, retryable: true },
          );
        }
        break;
      }

      const fingerprint = this.pageFingerprint(pageItems);
      if (pageFingerprints.has(fingerprint)) {
        throw new SportsProviderRequestError(
          `ESPN ${label} repeated page ${page}; the collection is incomplete.`,
          { provider: 'ESPN', endpoint: url, retryable: true },
        );
      }
      pageFingerprints.add(fingerprint);
      allItems.push(...pageItems);
      completedPages = page;
      if (probeUntilShortPage && pageItems.length < safePageSize) break;
    }

    if (
      probeUntilShortPage &&
      completedPages >= SPORTS_PROVIDER_CONFIG.espn.maxPages &&
      allItems.length % safePageSize === 0
    ) {
      throw new SportsProviderRequestError(
        `ESPN ${label} reached the configured page ceiling without a final short page.`,
        {
          provider: 'ESPN',
          endpoint: url,
          retryable: false,
        },
      );
    }

    if (totalCount !== undefined && allItems.length !== totalCount) {
      throw new SportsProviderRequestError(
        `ESPN ${label} pagination mismatch: expected ${totalCount} items, received ${allItems.length}.`,
        { provider: 'ESPN', endpoint: url, retryable: true },
      );
    }

    return {
      items: allItems,
      pageCount: probeUntilShortPage ? completedPages : pageCount,
      totalCount,
      endpoint: url,
      rawResponse: {
        ...first,
        count: totalCount ?? first.count,
        pageCount: probeUntilShortPage ? completedPages : pageCount,
        pageSize: declaredPageSize,
        items: allItems,
      },
    };
  }

  private extractItems(response: ProviderPagedResponse): unknown[] {
    if (Array.isArray(response.items)) return response.items;
    for (const key of [
      'events',
      'data',
      'leagues',
      'teams',
      'seasons',
      'plays',
      'odds',
      'results',
      'entries',
    ]) {
      const value = response[key];
      if (Array.isArray(value)) return value;
      const nested = this.asRecord(value);
      if (nested && Array.isArray(nested.items)) return nested.items;
    }
    return [];
  }

  private pageFingerprint(items: unknown[]): string {
    return JSON.stringify(
      items.map((item) => {
        const row = this.asRecord(item);
        return row?.id ?? row?.$ref ?? item;
      }),
    );
  }

  private async resolveCollectionReferencesStrict(
    items: unknown[],
    label: string,
  ): Promise<unknown[]> {
    return this.mapWithConcurrency(
      items,
      SPORTS_PROVIDER_CONFIG.espn.referenceConcurrency,
      async (item) => this.resolveReference(item, label),
    );
  }

  private async resolveNestedReference(
    value: unknown,
    label: string,
  ): Promise<ProviderJsonObject | undefined> {
    const resolved = await this.resolveReference(value, label);
    return this.asRecord(resolved);
  }

  private async resolveReference(
    value: unknown,
    label: string,
  ): Promise<unknown> {
    const record = this.asRecord(value);
    const reference =
      typeof record?.$ref === 'string' ? record.$ref.trim() : '';
    if (!record || !reference) return value;

    // ESPN embeds complete entity objects beside their $ref in many responses
    // (notably scoreboard competitors, odds rows and Plays records). Preserve
    // those full objects instead of making a second request for the same data.
    const meaningfulKeys = Object.keys(record).filter(
      (key) => !['$ref', 'id', 'uid'].includes(key),
    );
    if (meaningfulKeys.length > 0) return value;

    const url = this.normalizeReferenceUrl(reference, label);
    return this.get(url, label);
  }

  /** Expand the nested player-prop catalogue linked by each Core Odds row. */
  private async expandOddsPropBets(value: unknown): Promise<unknown> {
    const row = this.asRecord(value);
    if (!row) return value;
    const propBets = this.asRecord(row.propBets);
    const reference =
      typeof propBets?.$ref === 'string' ? propBets.$ref.trim() : '';
    if (
      !reference ||
      Object.keys(propBets ?? {}).some(
        (key) => !['$ref', 'id', 'uid'].includes(key),
      )
    ) {
      return value;
    }

    const endpoint = this.normalizeReferenceUrl(
      reference,
      'match-odds-prop-bets',
    );
    const collection = await this.getPagedCollection(
      endpoint,
      'match-odds-prop-bets',
      {},
      SPORTS_PROVIDER_CONFIG.espn.pageSize,
    );
    const items = await this.resolveCollectionReferencesStrict(
      collection.items,
      'match-odds-prop-bet-detail',
    );
    return {
      ...row,
      propBets: {
        ...(collection.rawResponse ?? {}),
        items,
      },
    };
  }

  private normalizeReferenceUrl(reference: string, label: string): string {
    let url: URL;
    try {
      url = new URL(reference, `${this.coreBaseUrl}/`);
    } catch {
      throw new SportsProviderRequestError(
        `ESPN ${label} returned an invalid resource reference.`,
        {
          provider: 'ESPN',
          endpoint: reference,
          retryable: false,
        },
      );
    }

    // ESPN's supplied $ref values in the verified payloads use plain HTTP.
    // Upgrade those trusted ESPN references to HTTPS before making the request.
    // ESPN occasionally also publishes `.pvt` references which map to `.com`.
    if (url.hostname === 'sports.core.api.espn.pvt')
      url.hostname = 'sports.core.api.espn.com';
    const corePath = url.pathname.startsWith('/v2/sports/soccer/');
    const sitePath = url.pathname.startsWith('/apis/site/v2/sports/soccer/');
    const trustedHost =
      (CORE_HOSTS.has(url.hostname) && corePath) ||
      (SITE_HOSTS.has(url.hostname) && sitePath);
    if (url.protocol === 'http:' && trustedHost) url.protocol = 'https:';
    if (
      url.protocol !== 'https:' ||
      !trustedHost ||
      url.username ||
      url.password
    ) {
      throw new SportsProviderRequestError(
        `ESPN ${label} returned an untrusted resource reference.`,
        {
          provider: 'ESPN',
          endpoint: reference,
          retryable: false,
        },
      );
    }
    return url.toString();
  }

  private matchCompetitionPath(
    leagueId: string,
    eventId: string,
    competitionId: string,
  ): string {
    const league = this.requiredPathId(leagueId, 'leagueId');
    const event = this.requiredPathId(eventId, 'eventId');
    const competition = this.requiredPathId(competitionId, 'competitionId');
    return `${this.coreBaseUrl}/leagues/${league}/events/${event}/competitions/${competition}`;
  }

  private async mapWithConcurrency<T, R>(
    values: T[],
    concurrency: number,
    mapper: (value: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const output = new Array<R>(values.length);
    let nextIndex = 0;
    const workers = Math.min(
      values.length,
      Math.max(1, Math.floor(concurrency)),
    );
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (true) {
          const index = nextIndex++;
          if (index >= values.length) return;
          output[index] = await mapper(values[index], index);
        }
      }),
    );
    return output;
  }

  private async get<T extends ProviderJsonObject = ProviderJsonObject>(
    url: string,
    label: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const maxRetries = SPORTS_PROVIDER_CONFIG.espn.maxRetries;
    let attempt = 0;
    while (true) {
      await this.waitForRequestSlot(label);
      let requestSlotAcquired = true;
      this.requestAttempts += 1;
      this.lastRequestAt = new Date();
      this.lastRequestLabel = label;
      const endpoint = this.getEndpointRuntime(label);
      endpoint.attempts += 1;
      endpoint.lastRequestAt = this.lastRequestAt;

      try {
        const queryAlreadyHasDefaults = (() => {
          try {
            const query = new URL(url).searchParams;
            return { lang: query.has('lang'), region: query.has('region') };
          } catch {
            return { lang: false, region: false };
          }
        })();
        const response = await this.http.get<T>(url, {
          params: {
            ...(queryAlreadyHasDefaults.lang || params?.lang
              ? {}
              : { lang: 'en' }),
            ...(queryAlreadyHasDefaults.region || params?.region
              ? {}
              : { region: 'us' }),
            ...(params ?? {}),
          },
        });
        if (
          !response.data ||
          typeof response.data !== 'object' ||
          Array.isArray(response.data)
        ) {
          throw new SportsProviderRequestError(
            `ESPN ${label} returned an invalid JSON object.`,
            {
              provider: 'ESPN',
              endpoint: url,
              retryable: false,
            },
          );
        }
        this.successfulResponses += 1;
        this.consecutiveFailures = 0;
        this.lastSuccessfulAt = new Date();
        endpoint.successes += 1;
        endpoint.lastSuccessfulAt = this.lastSuccessfulAt;
        return response.data;
      } catch (error) {
        const axiosError = axios.isAxiosError(error)
          ? (error as AxiosError)
          : undefined;
        const statusCode =
          axiosError?.response?.status ??
          (error instanceof SportsProviderRequestError
            ? error.statusCode
            : undefined);
        const retryable = this.isTransient(error);
        const failureAt = new Date();
        const failureMessage = this.errorMessage(error);
        this.failedResponses += 1;
        this.consecutiveFailures += 1;
        this.lastFailedAt = failureAt;
        this.lastFailure = failureMessage;
        this.lastFailureStatusCode = statusCode;
        endpoint.failures += 1;
        endpoint.lastFailedAt = failureAt;
        endpoint.lastStatusCode = statusCode;
        if (statusCode === 429) this.rateLimitedResponses += 1;
        if (statusCode !== undefined && statusCode >= 500)
          this.serverErrorResponses += 1;

        attempt += 1;
        if (retryable && attempt <= maxRetries) {
          const retryAfter = this.retryAfterMs(axiosError);
          const delay = Math.min(
            60_000,
            retryAfter ?? Math.min(8_000, 500 * 2 ** (attempt - 1)),
          );
          if (statusCode === 429 || retryAfter !== undefined) {
            this.providerCooldownUntil = Math.max(
              this.providerCooldownUntil,
              Date.now() + delay,
            );
          }
          this.retryAttempts += 1;
          endpoint.retries += 1;
          this.logger.warn(
            `Retrying ESPN ${label}; attempt ${attempt}/${maxRetries}, delay ${delay}ms.`,
          );
          // Do not hold a scarce provider slot during backoff. Other endpoint
          // lanes, especially live-scoreboard, must keep using available slots.
          this.releaseRequestSlot(label);
          requestSlotAcquired = false;
          await this.sleep(delay);
          continue;
        }
        if (error instanceof SportsProviderRequestError) throw error;
        throw new SportsProviderRequestError(
          `ESPN ${label} request failed${statusCode ? ` (${statusCode})` : ''}: ${failureMessage}`,
          { provider: 'ESPN', endpoint: url, statusCode, retryable },
          { cause: error },
        );
      } finally {
        if (requestSlotAcquired) this.releaseRequestSlot(label);
      }
    }
  }

  /**
   * Shared ESPN request-start scheduler. Live scoreboard requests have
   * priority over normal collection work and have one reserved in-flight slot.
   * Normal requests retain two slots. The provider-wide start interval and
   * Retry-After cooldown still apply to every endpoint.
   */
  private waitForRequestSlot(label: string): Promise<void> {
    this.waitingRequests += 1;
    return new Promise<void>((resolve) => {
      this.requestWaiters.push({ label, resolve });
      this.drainRequestQueue();
    });
  }

  private releaseRequestSlot(label: string): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    if (this.isLiveRequest(label)) {
      this.activeLiveRequests = Math.max(0, this.activeLiveRequests - 1);
    } else {
      this.activeNormalRequests = Math.max(0, this.activeNormalRequests - 1);
    }
    this.drainRequestQueue();
  }

  private isLiveRequest(label: string): boolean {
    return label.toLowerCase().includes('live-scoreboard');
  }

  private drainRequestQueue(): void {
    if (this.requestSchedulerTimer) {
      clearTimeout(this.requestSchedulerTimer);
      this.requestSchedulerTimer = undefined;
    }
    if (this.requestWaiters.length === 0) return;

    // Prefer live requests, but do not let a full live slot block normal work.
    const ordered = this.requestWaiters
      .map((request, index) => ({ request, index }))
      .sort((a, b) => Number(this.isLiveRequest(b.request.label)) - Number(this.isLiveRequest(a.request.label)) || a.index - b.index);
    const eligible = ordered.find(({ request }) => this.isLiveRequest(request.label)
      ? this.activeLiveRequests < this.maxLiveInFlight
      : this.activeNormalRequests < this.maxNormalInFlight);
    if (!eligible) return;

    const dueAt = Math.max(this.lastRequestStartedAt + this.minIntervalMs, this.providerCooldownUntil);
    const delay = Math.max(0, dueAt - Date.now());
    this.requestSchedulerTimer = setTimeout(() => {
      this.requestSchedulerTimer = undefined;
      // Re-evaluate at dispatch time: a live request may have arrived while
      // this timer was waiting behind an ordinary request.
      const candidates = this.requestWaiters
        .map((request, index) => ({ request, index }))
        .sort((a, b) => Number(this.isLiveRequest(b.request.label)) - Number(this.isLiveRequest(a.request.label)) || a.index - b.index);
      const selected = candidates.find(({ request }) => this.isLiveRequest(request.label)
        ? this.activeLiveRequests < this.maxLiveInFlight
        : this.activeNormalRequests < this.maxNormalInFlight);
      if (!selected) return;

      const [request] = this.requestWaiters.splice(selected.index, 1);
      if (!request) return;
      this.waitingRequests = Math.max(0, this.waitingRequests - 1);
      this.lastRequestStartedAt = Date.now();
      if (this.isLiveRequest(request.label)) this.activeLiveRequests += 1;
      else this.activeNormalRequests += 1;
      this.activeRequests += 1;
      request.resolve();
      this.drainRequestQueue();
    }, delay);
    (this.requestSchedulerTimer as unknown as { unref?: () => void }).unref?.();
  }

  private getEndpointRuntime(label: string): EspnEndpointRuntime {
    const existing = this.endpointRuntime.get(label);
    if (existing) return existing;
    const created: EspnEndpointRuntime = {
      attempts: 0,
      successes: 0,
      failures: 0,
      retries: 0,
    };
    // Labels are internal constants, but bound the map defensively in case a
    // future caller supplies dynamic labels.
    if (this.endpointRuntime.size >= 40) {
      const oldest = [...this.endpointRuntime.keys()][0];
      if (oldest) this.endpointRuntime.delete(oldest);
    }
    this.endpointRuntime.set(label, created);
    return created;
  }

  private readPositiveConfig(
    value: string | undefined,
    fallback: number,
  ): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0
      ? Math.floor(parsed)
      : fallback;
  }

  private isTransient(error: unknown): boolean {
    if (!axios.isAxiosError(error)) return false;
    const status = error.response?.status;
    if (
      status === 408 ||
      status === 425 ||
      status === 429 ||
      (status !== undefined && status >= 500)
    )
      return true;
    return [
      'ECONNABORTED',
      'ETIMEDOUT',
      'ECONNRESET',
      'EAI_AGAIN',
      'ENOTFOUND',
    ].includes(error.code ?? '');
  }

  private retryAfterMs(error?: AxiosError): number | undefined {
    const value: unknown = error?.response?.headers?.['retry-after'];
    if (typeof value !== 'string') return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? undefined
      : Math.max(0, date.getTime() - Date.now());
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 220)
      : String(error);
  }

  private readPositiveInteger(
    value: unknown,
    fallback?: number,
  ): number | undefined {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private readNonNegativeInteger(value: unknown): number | undefined {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }

  private asRecord(value: unknown): ProviderJsonObject | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as ProviderJsonObject)
      : undefined;
  }

  private requiredPathId(value: string, field: string): string {
    const normalized = String(value ?? '').trim();
    if (!normalized)
      throw new Error(`${field} is required for an ESPN request.`);
    return encodeURIComponent(normalized);
  }

  private toCompactDate(value: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new Error('date must use YYYY-MM-DD.');
    const date = new Date(`${value}T00:00:00.000Z`);
    if (
      Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
    )
      throw new Error('date is not a valid calendar date.');
    return value.replace(/-/g, '');
  }

  private toCompactMonth(value: string): string {
    if (!/^\d{4}-?\d{2}$/.test(value))
      throw new Error('month must use YYYY-MM or YYYYMM.');
    const compact = value.replace('-', '');
    const month = Number(compact.slice(4, 6));
    if (month < 1 || month > 12)
      throw new Error('month must contain a valid month.');
    return compact;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}


