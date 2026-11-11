import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosInstance } from 'axios';

import type {
  ProviderCollection,
  ProviderJsonObject,
} from '../interfaces/provider-response.interface';
import { SportsProviderRequestError } from './sports-provider-request.error';
import {
  SportsProviderQuotaExceededError,
  SportsProviderRateLimitService,
} from '../services/sports-provider-rate-limit.service';

const ODDS_API_CONFIG = {
  baseUrl: 'https://api.the-odds-api.com/v4',
  timeoutMs: 10_000,
  defaultRegions: 'us',
  defaultMarkets: 'h2h',
  oddsFormat: 'decimal',
  dateFormat: 'iso',
  cacheTtlMs: 30_000,
  maxRetries: 2,
  minIntervalMs: 1_000,
} as const;

export interface OddsApiRequestOptions {
  regions?: string;
  markets?: string;
  oddsFormat?: 'decimal' | 'american' | 'fractional';
  dateFormat?: 'iso' | 'unix';
}

/** Odds API adapter. This adapter is used only when ESPN has no usable odds. */
@Injectable()
export class OddsApiClient {
  private readonly logger = new Logger(OddsApiClient.name);
  private readonly http: AxiosInstance;
  private readonly baseUrl = ODDS_API_CONFIG.baseUrl;
  private readonly cache = new Map<
    string,
    { expiresAt: number; value: ProviderCollection<unknown> }
  >();
  private readonly inFlight = new Map<
    string,
    Promise<ProviderCollection<unknown>>
  >();
  private requestGate: Promise<void> = Promise.resolve();
  private lastRequestStartedAt = 0;
  private providerCooldownUntil = 0;

  constructor(
    private readonly providerRateLimit: SportsProviderRateLimitService,
  ) {
    this.http = axios.create({
      timeout: ODDS_API_CONFIG.timeoutMs,
      headers: { Accept: 'application/json' },
    });
  }

  /**
   * Fetches the current odds for one sport and returns only in-memory records.
   * The caller must select the exact fixture before saving any odds snapshot.
   */
  async getSportOdds(
    sportKey: string,
    options: OddsApiRequestOptions = {},
  ): Promise<ProviderCollection<unknown>> {
    const sport = this.requiredId(sportKey, 'sportKey');
    const endpoint = `${this.baseUrl}/sports/${sport}/odds`;
    const params = {
      apiKey: this.getApiKey(),
      regions: options.regions ?? ODDS_API_CONFIG.defaultRegions,
      markets: options.markets ?? ODDS_API_CONFIG.defaultMarkets,
      oddsFormat: options.oddsFormat ?? ODDS_API_CONFIG.oddsFormat,
      dateFormat: options.dateFormat ?? ODDS_API_CONFIG.dateFormat,
    };
    const cacheKey = `${sport}|${params.regions}|${params.markets}|${params.oddsFormat}|${params.dateFormat}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) this.cache.delete(cacheKey);
    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending;

    const request = (async () => {
      const data = await this.request<unknown>(endpoint, 'sport-odds', params);
      if (!Array.isArray(data)) {
        throw new SportsProviderRequestError(
          'The Odds API returned an unexpected sport-odds response',
          this.errorOptions(endpoint, false),
        );
      }
      const collection = {
        items: data,
        pageCount: 1,
        totalCount: data.length,
        endpoint,
      };
      this.cache.set(cacheKey, {
        expiresAt: Date.now() + ODDS_API_CONFIG.cacheTtlMs,
        value: collection,
      });
      return collection;
    })();
    this.inFlight.set(cacheKey, request);
    try {
      return await request;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  /** Direct event lookup when a mapped Odds API event ID is already known. */
  async getEventOdds(
    sportKey: string,
    oddsApiEventId: string,
    options: OddsApiRequestOptions = {},
  ): Promise<ProviderJsonObject> {
    const sport = this.requiredId(sportKey, 'sportKey');
    const event = this.requiredId(oddsApiEventId, 'oddsApiEventId');
    const endpoint = `${this.baseUrl}/sports/${sport}/events/${event}/odds`;
    const data = await this.request<unknown>(endpoint, 'event-odds', {
      apiKey: this.getApiKey(),
      regions: options.regions ?? ODDS_API_CONFIG.defaultRegions,
      markets: options.markets ?? ODDS_API_CONFIG.defaultMarkets,
      oddsFormat: options.oddsFormat ?? ODDS_API_CONFIG.oddsFormat,
      dateFormat: options.dateFormat ?? ODDS_API_CONFIG.dateFormat,
    });

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new SportsProviderRequestError(
        'The Odds API returned an unexpected event-odds response',
        this.errorOptions(endpoint, false),
      );
    }
    return data as ProviderJsonObject;
  }

  private async request<T>(
    url: string,
    label: string,
    params: Record<string, string>,
  ): Promise<T> {
    let attempt = 0;
    const maxRetries = ODDS_API_CONFIG.maxRetries;

    while (true) {
      try {
        return await this.providerRateLimit.execute(
          'odds-api',
          label,
          async () => {
            await this.waitForRequestSlot();
            const response = await this.http.get<T>(url, { params });
            return response.data;
          },
        );
      } catch (error) {
        if (error instanceof SportsProviderQuotaExceededError) throw error;

        const axiosError = axios.isAxiosError(error)
          ? (error as AxiosError)
          : undefined;
        const statusCode = axiosError?.response?.status;
        const retryable = this.isTransient(error);
        attempt += 1;

        if (retryable && attempt <= maxRetries) {
          const retryAfter = this.retryAfterMs(axiosError);
          const delay = Math.min(
            24 * 60 * 60_000,
            retryAfter ?? Math.min(5_000, 500 * 2 ** (attempt - 1)),
          );
          if (statusCode === 429 || retryAfter !== undefined) {
            this.providerCooldownUntil = Math.max(
              this.providerCooldownUntil,
              Date.now() + delay,
            );
          }
          this.logger.warn(
            `Retrying The Odds API ${label}: attempt ${attempt}/${maxRetries}, delay=${delay}ms`,
          );
          await this.sleep(delay);
          continue;
        }

        throw new SportsProviderRequestError(
          `The Odds API ${label} request failed${statusCode ? ` (${statusCode})` : ''}: ${this.errorMessage(error)}`,
          this.errorOptions(url, retryable, statusCode),
          { cause: error },
        );
      }
    }
  }

  private async waitForRequestSlot(): Promise<void> {
    const previous = this.requestGate;
    let release!: () => void;
    this.requestGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const dueAt = Math.max(
        this.lastRequestStartedAt + ODDS_API_CONFIG.minIntervalMs,
        this.providerCooldownUntil,
      );
      const delay = dueAt - Date.now();
      if (delay > 0) await this.sleep(delay);
      this.lastRequestStartedAt = Date.now();
    } finally {
      release();
    }
  }

  private getApiKey(): string {
    const key =
      process.env.ODDS_API_KEY?.trim() || process.env.THE_ODDS_API_KEY?.trim();
    if (!key) {
      throw new SportsProviderRequestError(
        'ODDS_API_KEY is not configured; the Odds API fallback is unavailable',
        this.errorOptions(this.baseUrl, false),
      );
    }
    return key;
  }

  private isTransient(error: unknown): boolean {
    if (!axios.isAxiosError(error)) return false;
    const status = error.response?.status;
    if (status === 408 || status === 425 || status === 429) return true;
    if (status !== undefined && status >= 500) return true;
    return ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(
      error.code ?? '',
    );
  }

  private retryAfterMs(error?: AxiosError): number | undefined {
    const value = error?.response?.headers?.['retry-after'] as unknown;
    if (typeof value !== 'string') return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? undefined
      : Math.max(0, date.getTime() - Date.now());
  }

  private errorOptions(
    endpoint: string,
    retryable: boolean,
    statusCode?: number,
  ): ConstructorParameters<typeof SportsProviderRequestError>[1] {
    return {
      provider: 'ODDS_API',
      endpoint,
      retryable,
      ...(statusCode === undefined ? {} : { statusCode }),
    } as unknown as ConstructorParameters<typeof SportsProviderRequestError>[1];
  }

  private requiredId(value: string, field: string): string {
    const normalized = String(value ?? '').trim();
    if (!normalized)
      throw new Error(`${field} is required for an Odds API request`);
    return encodeURIComponent(normalized);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 220)
      : String(error);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

