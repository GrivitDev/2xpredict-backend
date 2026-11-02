import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { OddsApiEventOdds, OddsApiSport } from './the-odds-api.interfaces';
import {
  OddsProviderPausedError,
  OddsProviderStateService,
} from '../services/odds-provider-state.service';
import { OddsProviderCacheResult } from './odds-provider.interfaces';

// Keep shared sport feeds warm without letting an empty/error response spin the worker.
const ODDS_CACHE_MS = 30 * 60_000;
const ODDS_NEGATIVE_CACHE_MS = 90 * 60_000;
// Global provider-state lease enforces at least 12 seconds between request starts
// across all app instances (at most five new API requests per rolling minute).

@Injectable()
export class TheOddsApiService {
  private readonly logger = new Logger(TheOddsApiService.name);
  private readonly apiKey: string;
  private readonly http: AxiosInstance;
  private readonly dailyRequestLimit: number;
  private readonly minimumIntervalMs: number;
  private readonly regions: string;
  private readonly markets: string[];

  constructor(
    private readonly configService: ConfigService,
    private readonly providerState: OddsProviderStateService,
  ) {
    this.apiKey = (
      this.configService.get<string>('THE_ODDS_API_KEY') ?? ''
    ).trim();
    this.dailyRequestLimit = this.integerEnv(
      'THE_ODDS_API_DAILY_REQUEST_LIMIT',
      4,
      1,
      100_000,
    );
    const configuredMinimumIntervalMs = this.integerEnv(
      'THE_ODDS_API_MIN_INTERVAL_MS',
      12_000,
      12_000,
      86_400_000,
    );
    // Do not turn a daily budget into a six-hour minimum interval. The daily
    // budget remains a hard account-protection cap; the global Mongo lease is
    // responsible for pacing allowed calls at no more than 5 per minute.
    this.minimumIntervalMs = Math.max(12_000, configuredMinimumIntervalMs);
    this.regions = (
      this.configService.get<string>('THE_ODDS_API_REGIONS') ?? 'eu'
    )
      .trim()
      .toLowerCase();
    this.markets = (
      this.configService.get<string>('THE_ODDS_API_MARKETS') ??
      'h2h,totals,spreads'
    )
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    this.http = axios.create({
      baseURL: 'https://api.the-odds-api.com/v4',
      timeout: 15_000,
      headers: { Accept: 'application/json' },
    });
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async isNetworkAvailable(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    return await this.providerState.isNetworkAvailable(
      'THE_ODDS_API',
      this.dailyRequestLimit,
    );
  }

  async getStatus() {
    const summary = await this.providerState.getSummary(
      'THE_ODDS_API',
      this.dailyRequestLimit,
    );
    return this.isConfigured()
      ? summary
      : {
          ...summary,
          status: 'DISABLED' as const,
          message: 'THE_ODDS_API_KEY is not configured.',
        };
  }

  async getCollectionCursor(): Promise<string | undefined> {
    return this.providerState.getCollectionCursor('THE_ODDS_API');
  }

  async setCollectionCursor(cursor: string): Promise<void> {
    return this.providerState.setCollectionCursor('THE_ODDS_API', cursor);
  }

  async isRequestDue(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    return this.providerState.isRequestDue(
      'THE_ODDS_API',
      this.dailyRequestLimit,
      this.minimumIntervalMs,
    );
  }

  async getCachedOdds(
    sportKey: string,
  ): Promise<OddsProviderCacheResult<OddsApiEventOdds[]> | null> {
    const normalizedKey = sportKey.trim();
    if (!normalizedKey) return null;
    const cached = await this.providerState.getCache<OddsApiEventOdds[]>(
      this.cacheKey(normalizedKey),
    );
    return cached
      ? { data: cached.data, fetchedAt: cached.fetchedAt, fromCache: true }
      : null;
  }

  async getOdds(
    sportKey: string,
    allowNetwork = true,
  ): Promise<OddsProviderCacheResult<OddsApiEventOdds[]> | null> {
    const key = sportKey.trim();
    if (!key) return null;
    const cached = await this.getCachedOdds(key);
    if (cached) return cached;
    if (!allowNetwork || !this.apiKey || !(await this.isNetworkAvailable()))
      return null;
    if (
      !(await this.providerState.isRequestDue(
        'THE_ODDS_API',
        this.dailyRequestLimit,
        this.minimumIntervalMs,
      ))
    )
      return null;
    if (!this.markets.length) {
      this.logger.error(
        'The Odds API has no configured markets; THE_ODDS_API_MARKETS must contain at least one market.',
      );
      return null;
    }

    try {
      const data = await this.providerState.execute<OddsApiEventOdds[]>(
        'THE_ODDS_API',
        {
          dailyLimit: this.dailyRequestLimit,
          minIntervalMs: this.minimumIntervalMs,
        },
        async () => {
          const response = await this.http.get<OddsApiEventOdds[]>(
            `/sports/${encodeURIComponent(key)}/odds`,
            {
              params: {
                apiKey: this.apiKey,
                regions: this.regions,
                markets: this.markets.join(','),
                oddsFormat: 'decimal',
                dateFormat: 'iso',
              },
            },
          );
          return {
            data: response.data,
            headers: response.headers as unknown as Record<string, unknown>,
          };
        },
      );

      const fetchedAt = new Date();
      const cacheTtl = Array.isArray(data) && data.length === 0
        ? ODDS_NEGATIVE_CACHE_MS
        : ODDS_CACHE_MS;
      await this.providerState.putCache(
        'THE_ODDS_API',
        this.cacheKey(key),
        data as unknown as Record<string, unknown>,
        cacheTtl,
        fetchedAt,
      );
      return { data, fetchedAt, fromCache: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const details = error as AxiosError & {
        statusCode?: number;
        body?: unknown;
        response?: { status?: number; data?: unknown };
      };
      const status = Number(
        details?.response?.status ?? details?.statusCode ?? 0,
      );
      if ([400, 404, 422].includes(status)) {
        // Missing/out-of-season/unavailable sport keys are cached negatively so
        // they cannot repeatedly consume account credits every worker cycle.
        await this.providerState.putCache(
          'THE_ODDS_API',
          this.cacheKey(key),
          [] as unknown as Record<string, unknown>,
          ODDS_NEGATIVE_CACHE_MS,
          new Date(),
        ).catch((cacheError) => {
          this.logger.warn(`Could not cache rejected Odds API sport key ${key}: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`);
        });
        this.logger.warn(
          `The Odds API rejected sport key ${key} (HTTP ${status}); cached as unavailable for 90 minutes.`,
        );
      } else if (!(error instanceof OddsProviderPausedError)) {
        // The worker must not hammer the same unavailable feed every 30 seconds.
        // Estimates are created immediately by OddsService; a later normal pass
        // may try again after this short, bounded negative-cache interval.
        await this.providerState.putCache(
          'THE_ODDS_API',
          this.cacheKey(key),
          [] as unknown as Record<string, unknown>,
          ODDS_NEGATIVE_CACHE_MS,
          new Date(),
        ).catch((cacheError) => {
          this.logger.warn(`Could not cache unavailable Odds API feed ${key}: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`);
        });
        this.logger.warn(
          `The Odds API feed unavailable for ${key}; no immediate retry will be made: ${message.slice(0, 300)}`,
        );
      }
      return null;
    }
  }

  async getSports(): Promise<OddsApiSport[] | null> {
    if (!this.apiKey || !(await this.isNetworkAvailable())) return null;
    try {
      const result = await this.providerState.execute<OddsApiSport[]>(
        'THE_ODDS_API',
        {
          dailyLimit: this.dailyRequestLimit,
          minIntervalMs: this.minimumIntervalMs,
        },
        async () => {
          const response = await this.http.get<OddsApiSport[]>('/sports', {
            params: { apiKey: this.apiKey },
          });
          return {
            data: response.data,
            headers: response.headers as unknown as Record<string, unknown>,
          };
        },
      );
      return result;
    } catch (error) {
      this.logger.warn(
        `The Odds API sports catalogue request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private cacheKey(sportKey: string): string {
    return `THE_ODDS_API:odds:${sportKey}`;
  }

  private integerEnv(
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const value = Number(
      this.configService.get<string>(name) ?? process.env[name] ?? fallback,
    );
    return Number.isFinite(value)
      ? Math.max(min, Math.min(max, Math.floor(value)))
      : fallback;
  }
}
