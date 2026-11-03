import { Injectable, Logger } from '@nestjs/common';

import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  SportsProviderRateLimit,
  SportsProviderRateLimitDocument,
} from '../schemas/sports-provider-rate-limit.schema';

import { SPORTS_DATA_COLLECTION_CONFIG } from '../config/sports-data-collection.config';

export type SportsProvider = 'espn' | 'football-data' | 'odds-api' | 'youtube';

export type SportsProviderRequestLane = 'live' | 'normal';

export class SportsProviderQuotaExceededError extends Error {
  constructor(
    public readonly provider: SportsProvider,
    public readonly period: 'daily' | 'monthly',
  ) {
    super(`${provider} ${period} request quota has been exhausted`);
    this.name = 'SportsProviderQuotaExceededError';
  }
}

interface ProviderLimitConfig {
  minIntervalSeconds: number;
  dailyLimit?: number;
  monthlyLimit?: number;
}

interface ExecuteOptions {
  lane?: SportsProviderRequestLane;
  /**
   * YouTube channels.list uses a separate general API quota pool from search.list.
   * Set false for channel-ID resolution so it is rate-limited and monitored but
   * does not consume the app's reserved daily YouTube search allowance.
   */
  countTowardProviderQuota?: boolean;
  /** Override the configured per-endpoint interval for low-cost lookups. */
  minimumIntervalSeconds?: number;
}

interface EndpointGateState {
  lastStartedAt: number;
  cooldownUntil: number;
}

class AsyncConcurrencyLimiter {
  private active = 0;

  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        `Concurrency limiter requires a positive integer limit. Received: ${limit}`,
      );
    }
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });

    this.active += 1;
  }

  release(): void {
    if (this.active > 0) {
      this.active -= 1;
    }

    const next = this.waiters.shift();

    if (next) {
      next();
    }
  }

  getActive(): number {
    return this.active;
  }

  getWaiting(): number {
    return this.waiters.length;
  }

  getLimit(): number {
    return this.limit;
  }
}

@Injectable()
export class SportsProviderRateLimitService {
  private readonly logger = new Logger(SportsProviderRateLimitService.name);

  private readonly limits: Record<SportsProvider, ProviderLimitConfig> = {
    espn: {
      /*
       * ESPN has no published public request quota. The gate controls
       * request-start bursts while the 20-request concurrency pool
       * controls how much work may be in flight.
       */
      minIntervalSeconds:
        SPORTS_DATA_COLLECTION_CONFIG.ESPN.rateLimit.minIntervalSeconds,
    },

    'football-data': {
      minIntervalSeconds: 60,
    },

    'odds-api': {
      minIntervalSeconds: 60,
      monthlyLimit: 450,
    },

    youtube: {
      minIntervalSeconds:
        SPORTS_DATA_COLLECTION_CONFIG.YOUTUBE.rateLimit.minIntervalSeconds,
      dailyLimit: SPORTS_DATA_COLLECTION_CONFIG.YOUTUBE.dailyRequestLimit,
    },
  };

  private readonly PROVIDER_QUOTA_ENDPOINT = '__provider_quota__';

  private readonly endpointGates = new Map<string, EndpointGateState>();

  /**
   * Each endpoint has a promise chain that serializes only request STARTS.
   * The HTTP operation itself is not serialized, so 20 ESPN requests can
   * remain in flight concurrently.
   */
  private readonly endpointStartTails = new Map<string, Promise<void>>();

  private readonly espnLiveLimiter = new AsyncConcurrencyLimiter(
    SPORTS_DATA_COLLECTION_CONFIG.ESPN.rateLimit.liveConcurrency,
  );

  private readonly espnNormalLimiter = new AsyncConcurrencyLimiter(
    SPORTS_DATA_COLLECTION_CONFIG.ESPN.rateLimit.normalConcurrency,
  );

  constructor(
    @InjectModel(SportsProviderRateLimit.name)
    private readonly rateLimitModel: Model<SportsProviderRateLimitDocument>,
  ) {}

  // ============================================================
  // PUBLIC REQUEST EXECUTION
  // ============================================================

  async execute<T>(
    provider: SportsProvider,
    endpoint: string,
    operation: () => Promise<T>,
    options: ExecuteOptions = {},
  ): Promise<T> {
    const normalizedEndpoint = this.normalizeEndpoint(endpoint);

    const lane =
      provider === 'espn'
        ? (options.lane ?? 'normal')
        : ('normal' as SportsProviderRequestLane);

    const limiter = this.getConcurrencyLimiter(provider, lane);

    if (limiter) {
      await limiter.acquire();
    }

    try {
      await this.acquireSlot(
        provider,
        normalizedEndpoint,
        options.countTowardProviderQuota !== false,
        options.minimumIntervalSeconds,
      );

      return await operation();
    } finally {
      /*
       * Request accounting is deliberately outside the critical path.
       * ESPN has no application quota, so MongoDB must not become the
       * bottleneck for every ESPN HTTP call.
       */
      if (provider === 'espn') {
        void this.recordUsageAsync(provider, normalizedEndpoint).catch(
          (error) => {
            this.logger.warn(
              `ESPN request telemetry write failed for ${normalizedEndpoint}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          },
        );
      }

      if (limiter) {
        limiter.release();
      }
    }
  }

  // ============================================================
  // ESPN CONCURRENCY STATE
  // ============================================================

  getEspnConcurrencyState(): {
    totalLimit: number;
    active: number;
    waiting: number;
    live: {
      limit: number;
      active: number;
      waiting: number;
    };
    normal: {
      limit: number;
      active: number;
      waiting: number;
    };
  } {
    const liveLimit = this.espnLiveLimiter.getLimit();
    const normalLimit = this.espnNormalLimiter.getLimit();

    const liveActive = this.espnLiveLimiter.getActive();
    const normalActive = this.espnNormalLimiter.getActive();

    const liveWaiting = this.espnLiveLimiter.getWaiting();
    const normalWaiting = this.espnNormalLimiter.getWaiting();

    return {
      totalLimit: liveLimit + normalLimit,
      active: liveActive + normalActive,
      waiting: liveWaiting + normalWaiting,
      live: {
        limit: liveLimit,
        active: liveActive,
        waiting: liveWaiting,
      },
      normal: {
        limit: normalLimit,
        active: normalActive,
        waiting: normalWaiting,
      },
    };
  }

  // ============================================================
  // ADAPTIVE THROTTLE REPORTING
  // ============================================================

  /**
   * Called by the ESPN HTTP client when the provider reports a throttle
   * or transient service failure. The next request start for that endpoint
   * is delayed without reducing the number of in-flight workers.
   */
  reportThrottle(
    provider: SportsProvider,
    endpoint: string,
    status?: number,
    retryAfterMs?: number,
  ): void {
    const key = this.getEndpointGateKey(provider, endpoint);
    const now = Date.now();

    const current = this.endpointGates.get(key) ?? {
      lastStartedAt: 0,
      cooldownUntil: 0,
    };

    const fallback =
      status === 429 ? 30_000 : status && status >= 500 ? 2000 : 1000;

    const cooldown = Math.min(60_000, retryAfterMs ?? fallback);

    current.cooldownUntil = Math.max(current.cooldownUntil, now + cooldown);

    this.endpointGates.set(key, current);
  }

  // ============================================================
  // ENDPOINT SLOT
  // ============================================================

  async acquireSlot(
    provider: SportsProvider,
    endpoint: string,
    countTowardProviderQuota = true,
    minimumIntervalSeconds?: number,
  ): Promise<Date> {
    const normalizedEndpoint = this.normalizeEndpoint(endpoint);
    const config = this.getConfig(provider);
    const key = this.getEndpointGateKey(provider, normalizedEndpoint);

    /*
     * Serialize only the START timestamp. This is intentionally much
     * cheaper than the previous Mongo lock because all 20 workers can
     * perform their HTTP calls concurrently after their turn is granted.
     */
    let releaseTail!: () => void;

    const nextTail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });

    const previousTail = this.endpointStartTails.get(key) ?? Promise.resolve();

    this.endpointStartTails.set(key, nextTail);

    await previousTail;

    try {
      while (true) {
        const now = Date.now();
        const state = this.endpointGates.get(key) ?? {
          lastStartedAt: 0,
          cooldownUntil: 0,
        };

        const effectiveIntervalSeconds =
          typeof minimumIntervalSeconds === 'number' &&
          Number.isFinite(minimumIntervalSeconds)
            ? Math.max(0, minimumIntervalSeconds)
            : config.minIntervalSeconds;
        const intervalUntil =
          state.lastStartedAt + effectiveIntervalSeconds * 1000;

        const nextAllowedAt = Math.max(intervalUntil, state.cooldownUntil);

        if (nextAllowedAt > now) {
          await this.sleep(nextAllowedAt - now);
          continue;
        }

        state.lastStartedAt = Date.now();
        this.endpointGates.set(key, state);

        if (provider !== 'espn') {
          const configuredQuota =
            config.dailyLimit !== undefined ||
            config.monthlyLimit !== undefined;
          const hasQuota = configuredQuota && countTowardProviderQuota;

          if (hasQuota) {
            const reserved = await this.reserveProviderQuota(
              provider,
              new Date(),
            );

            if (!reserved) {
              const quotaError = await this.createQuotaExceededError(provider);
              if (quotaError.period === 'daily') {
                await this.markDailyQuotaExhausted(provider);
              }
              throw quotaError;
            }

            void this.recordEndpointRequest(
              provider,
              normalizedEndpoint,
              new Date(),
            ).catch((error) => {
              this.logger.warn(
                `Provider endpoint telemetry write failed for ${provider}/${normalizedEndpoint}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            });
          } else if (configuredQuota) {
            // Track channel lookup activity without consuming the shared
            // daily search quota; YouTube assigns channels.list to a separate
            // general quota pool from search.list.
            void this.recordEndpointRequest(
              provider,
              normalizedEndpoint,
              new Date(),
            ).catch((error) => {
              this.logger.warn(
                `Provider endpoint telemetry write failed for ${provider}/${normalizedEndpoint}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            });
          } else {
            void this.recordUsageAsync(provider, normalizedEndpoint).catch(
              (error) => {
                this.logger.warn(
                  `Provider telemetry write failed for ${provider}/${normalizedEndpoint}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              },
            );
          }
        }

        return new Date(state.lastStartedAt);
      }
    } finally {
      releaseTail();

      if (this.endpointStartTails.get(key) === nextTail) {
        this.endpointStartTails.delete(key);
      }
    }
  }

  // ============================================================
  // RELEASE SLOT
  // ============================================================

  /**
   * Kept for compatibility with existing callers. Endpoint throttling is
   * now process-local and is released when the request-start gate advances.
   */
  async releaseSlot(
    _provider: SportsProvider,
    _endpoint: string,
    _lockedUntil?: Date,
  ): Promise<void> {
    return;
  }

  // ============================================================
  // PROVIDER QUOTA
  // ============================================================

  private async reserveProviderQuota(
    provider: SportsProvider,
    now: Date,
  ): Promise<boolean> {
    const config = this.getConfig(provider);
    const dailyPeriod = this.getDailyPeriod(now);
    const monthlyPeriod = this.getMonthlyPeriod(now);

    /*
     * The quota record has exactly one Mongo document per provider +
     * endpoint. Periods are mutable fields on that document; they are NOT
     * part of the document identity. Ensure the current period is in place
     * before applying the quota predicate so an exhausted record can never
     * be accidentally upserted as a second provider + endpoint document.
     */
    await this.ensurePeriodState(provider, now);

    const filter: Record<string, unknown> = {
      provider,
      endpoint: this.PROVIDER_QUOTA_ENDPOINT,
      dailyPeriod,
      monthlyPeriod,
    };

    if (config.dailyLimit !== undefined) {
      filter.dailyRequests = {
        $lt: config.dailyLimit,
      };
    }

    if (config.monthlyLimit !== undefined) {
      filter.monthlyRequests = {
        $lt: config.monthlyLimit,
      };
    }

    filter.$or = [
      { quotaBlockedUntil: { $exists: false } },
      { quotaBlockedUntil: null },
      { quotaBlockedUntil: { $lte: now } },
    ];

    const updated = await this.rateLimitModel
      .findOneAndUpdate(
        filter,
        {
          $inc: {
            dailyRequests: 1,
            monthlyRequests: 1,
          },
          $set: {
            provider,
            endpoint: this.PROVIDER_QUOTA_ENDPOINT,
            dailyPeriod,
            monthlyPeriod,
          },
        },
        {
          returnDocument: 'after',
        },
      )
      .exec();

    return Boolean(updated);
  }

  // ============================================================
  // ASYNCHRONOUS REQUEST ACCOUNTING
  // ============================================================

  private async recordUsageAsync(
    provider: SportsProvider,
    endpoint: string,
  ): Promise<void> {
    const now = new Date();

    await Promise.all([
      this.recordProviderUsage(provider, now),
      this.recordEndpointRequest(provider, endpoint, now),
    ]);
  }

  private async recordProviderUsage(
    provider: SportsProvider,
    now: Date,
  ): Promise<void> {
    const dailyPeriod = this.getDailyPeriod(now);
    const monthlyPeriod = this.getMonthlyPeriod(now);

    /*
     * IMPORTANT: provider + endpoint is the unique identity of the record.
     * The old implementation included dailyPeriod/monthlyPeriod in the
     * upsert filter. When the date changed, MongoDB saw no matching record
     * and attempted to insert another document with the same provider +
     * endpoint, which correctly violated provider_1_endpoint_1.
     *
     * This pipeline keeps one record and atomically resets/increments the
     * counters when the period rolls over. It is safe for concurrent writes.
     */
    await this.rateLimitModel
      .findOneAndUpdate(
        {
          provider,
          endpoint: this.PROVIDER_QUOTA_ENDPOINT,
        },
        [
          {
            $set: {
              provider,
              endpoint: this.PROVIDER_QUOTA_ENDPOINT,
              dailyPeriod,
              monthlyPeriod,
              dailyRequests: {
                $cond: [
                  { $ne: ['$dailyPeriod', dailyPeriod] },
                  1,
                  { $add: [{ $ifNull: ['$dailyRequests', 0] }, 1] },
                ],
              },
              monthlyRequests: {
                $cond: [
                  { $ne: ['$monthlyPeriod', monthlyPeriod] },
                  1,
                  { $add: [{ $ifNull: ['$monthlyRequests', 0] }, 1] },
                ],
              },
            },
          },
        ],
        {
          returnDocument: 'after',
          upsert: true,
          updatePipeline: true,
        },
      )
      .exec();
  }

  private async recordEndpointRequest(
    provider: SportsProvider,
    endpoint: string,
    now: Date,
  ): Promise<void> {
    const dailyPeriod = this.getDailyPeriod(now);
    const monthlyPeriod = this.getMonthlyPeriod(now);

    /*
     * Keep one document per provider + endpoint. Period rollover is handled
     * atomically inside the update pipeline so concurrent requests cannot
     * create duplicate period-specific documents or lose the first request
     * after midnight.
     */
    await this.rateLimitModel
      .findOneAndUpdate(
        {
          provider,
          endpoint,
        },
        [
          {
            $set: {
              provider,
              endpoint,
              dailyPeriod,
              monthlyPeriod,
              dailyRequests: {
                $cond: [
                  { $ne: ['$dailyPeriod', dailyPeriod] },
                  1,
                  { $add: [{ $ifNull: ['$dailyRequests', 0] }, 1] },
                ],
              },
              monthlyRequests: {
                $cond: [
                  { $ne: ['$monthlyPeriod', monthlyPeriod] },
                  1,
                  { $add: [{ $ifNull: ['$monthlyRequests', 0] }, 1] },
                ],
              },
              lastRequestAt: now,
            },
          },
        ],
        {
          returnDocument: 'after',
          upsert: true,
          updatePipeline: true,
        },
      )
      .exec();
  }

  // ============================================================
  // REMAINING DAILY
  // ============================================================

  async getRemainingDailyRequests(
    provider: SportsProvider,
  ): Promise<number | null> {
    const config = this.getConfig(provider);

    if (config.dailyLimit === undefined) {
      return null;
    }

    const now = new Date();
    await this.ensurePeriodState(provider, now);

    const state = await this.rateLimitModel
      .findOne({
        provider,
        endpoint: this.PROVIDER_QUOTA_ENDPOINT,
      })
      .lean()
      .exec();

    if (
      state?.quotaBlockedUntil instanceof Date &&
      state.quotaBlockedUntil.getTime() > now.getTime()
    ) {
      return 0;
    }

    const remaining = Math.max(0, config.dailyLimit - (state?.dailyRequests ?? 0));
    if (remaining <= 0) {
      await this.markDailyQuotaExhausted(provider);
      return 0;
    }

    return remaining;
  }

  /**
   * Persist a provider-reported daily quota exhaustion. This sets the shared
   * quota counter to the configured limit for the current quota day so every
   * worker stops before making another outbound request.
   */
  async markDailyQuotaExhausted(provider: SportsProvider): Promise<void> {
    const config = this.getConfig(provider);
    if (config.dailyLimit === undefined) return;

    const now = new Date();
    const dailyPeriod = this.getDailyPeriod(now);
    const monthlyPeriod = this.getMonthlyPeriod(now);
    const blockedUntil = this.getNextLagosMidnight(now);

    await this.ensurePeriodState(provider, now);
    await this.rateLimitModel.updateOne(
      {
        provider,
        endpoint: this.PROVIDER_QUOTA_ENDPOINT,
        dailyPeriod,
      },
      {
        $set: {
          dailyRequests: config.dailyLimit,
          dailyPeriod,
          monthlyPeriod,
          quotaBlockedUntil: blockedUntil,
        },
      },
    ).exec();

    this.logger.warn(
      `${provider} provider daily quota is exhausted; outbound requests are blocked until ${blockedUntil.toISOString()} (Nigeria time)`,
    );
  }

  // ============================================================
  // REMAINING MONTHLY
  // ============================================================

  async getRemainingMonthlyRequests(
    provider: SportsProvider,
  ): Promise<number | null> {
    const config = this.getConfig(provider);

    if (config.monthlyLimit === undefined) {
      return null;
    }

    const now = new Date();
    await this.ensurePeriodState(provider, now);

    const state = await this.rateLimitModel
      .findOne({
        provider,
        endpoint: this.PROVIDER_QUOTA_ENDPOINT,
      })
      .lean()
      .exec();

    return Math.max(0, config.monthlyLimit - (state?.monthlyRequests ?? 0));
  }

  // ============================================================
  // DAILY USAGE
  // ============================================================

  async getDailyUsage(provider: SportsProvider): Promise<number> {
    const now = new Date();
    await this.ensurePeriodState(provider, now);

    const state = await this.rateLimitModel
      .findOne({
        provider,
        endpoint: this.PROVIDER_QUOTA_ENDPOINT,
      })
      .lean()
      .exec();

    return state?.dailyPeriod === this.getDailyPeriod(now)
      ? (state.dailyRequests ?? 0)
      : 0;
  }

  // ============================================================
  // MONTHLY USAGE
  // ============================================================

  async getMonthlyUsage(provider: SportsProvider): Promise<number> {
    const now = new Date();
    await this.ensurePeriodState(provider, now);

    const state = await this.rateLimitModel
      .findOne({
        provider,
        endpoint: this.PROVIDER_QUOTA_ENDPOINT,
      })
      .lean()
      .exec();

    return state?.monthlyPeriod === this.getMonthlyPeriod(now)
      ? (state.monthlyRequests ?? 0)
      : 0;
  }

  // ============================================================
  // ENDPOINT DAILY USAGE
  // ============================================================

  async getEndpointDailyUsage(
    provider: SportsProvider,
    endpoint: string,
  ): Promise<number> {
    const normalizedEndpoint = this.normalizeEndpoint(endpoint);
    const now = new Date();

    await this.ensureEndpointPeriodState(provider, normalizedEndpoint, now);

    const state = await this.rateLimitModel
      .findOne({
        provider,
        endpoint: normalizedEndpoint,
      })
      .lean()
      .exec();

    return state?.dailyPeriod === this.getDailyPeriod(now)
      ? (state.dailyRequests ?? 0)
      : 0;
  }

  // ============================================================
  // ENDPOINT MONTHLY USAGE
  // ============================================================

  async getEndpointMonthlyUsage(
    provider: SportsProvider,
    endpoint: string,
  ): Promise<number> {
    const normalizedEndpoint = this.normalizeEndpoint(endpoint);
    const now = new Date();

    await this.ensureEndpointPeriodState(provider, normalizedEndpoint, now);

    const state = await this.rateLimitModel
      .findOne({
        provider,
        endpoint: normalizedEndpoint,
      })
      .lean()
      .exec();

    return state?.monthlyPeriod === this.getMonthlyPeriod(now)
      ? (state.monthlyRequests ?? 0)
      : 0;
  }

  // ============================================================
  // QUOTA AVAILABILITY
  // ============================================================

  async isQuotaAvailable(provider: SportsProvider): Promise<boolean> {
    try {
      await this.assertQuotaAvailable(provider, new Date());
      return true;
    } catch (error) {
      if (error instanceof SportsProviderQuotaExceededError) {
        return false;
      }

      throw error;
    }
  }

  // ============================================================
  // PROVIDER STATE
  // ============================================================

  async getProviderState(
    provider: SportsProvider,
  ): Promise<SportsProviderRateLimitDocument | null> {
    await this.ensurePeriodState(provider, new Date());

    return this.rateLimitModel
      .findOne({
        provider,
        endpoint: this.PROVIDER_QUOTA_ENDPOINT,
      })
      .exec();
  }

  // ============================================================
  // ASSERT QUOTA
  // ============================================================

  private async assertQuotaAvailable(
    provider: SportsProvider,
    now: Date,
  ): Promise<void> {
    const config = this.getConfig(provider);

    if (config.dailyLimit === undefined && config.monthlyLimit === undefined) {
      return;
    }

    await this.ensurePeriodState(provider, now);

    const state = await this.rateLimitModel
      .findOne({
        provider,
        endpoint: this.PROVIDER_QUOTA_ENDPOINT,
      })
      .lean()
      .exec();

    if (!state) {
      return;
    }

    if (
      state.quotaBlockedUntil instanceof Date &&
      state.quotaBlockedUntil.getTime() > now.getTime()
    ) {
      throw new SportsProviderQuotaExceededError(provider, 'daily');
    }

    const dailyPeriod = this.getDailyPeriod(now);
    const monthlyPeriod = this.getMonthlyPeriod(now);

    if (
      config.dailyLimit !== undefined &&
      state.dailyPeriod === dailyPeriod &&
      state.dailyRequests >= config.dailyLimit
    ) {
      throw new SportsProviderQuotaExceededError(provider, 'daily');
    }

    if (
      config.monthlyLimit !== undefined &&
      state.monthlyPeriod === monthlyPeriod &&
      state.monthlyRequests >= config.monthlyLimit
    ) {
      throw new SportsProviderQuotaExceededError(provider, 'monthly');
    }
  }

  private async createQuotaExceededError(
    provider: SportsProvider,
  ): Promise<SportsProviderQuotaExceededError> {
    const config = this.getConfig(provider);
    const now = new Date();

    const state = await this.rateLimitModel
      .findOne({
        provider,
        endpoint: this.PROVIDER_QUOTA_ENDPOINT,
      })
      .lean()
      .exec();

    const dailyPeriod = this.getDailyPeriod(now);
    const monthlyPeriod = this.getMonthlyPeriod(now);

    if (
      state?.quotaBlockedUntil instanceof Date &&
      state.quotaBlockedUntil.getTime() > now.getTime()
    ) {
      return new SportsProviderQuotaExceededError(provider, 'daily');
    }

    if (
      config.dailyLimit !== undefined &&
      state?.dailyPeriod === dailyPeriod &&
      (state.dailyRequests ?? 0) >= config.dailyLimit
    ) {
      return new SportsProviderQuotaExceededError(provider, 'daily');
    }

    return new SportsProviderQuotaExceededError(provider, 'monthly');
  }

  // ============================================================
  // PERIOD STATE
  // ============================================================

  private async ensurePeriodState(
    provider: SportsProvider,
    now: Date,
  ): Promise<void> {
    const dailyPeriod = this.getDailyPeriod(now);
    const monthlyPeriod = this.getMonthlyPeriod(now);

    /*
     * The unique key remains { provider, endpoint }. Never include period
     * fields in the upsert filter. Period changes are represented by
     * updating this same document. The pipeline makes the reset atomic.
     */
    await this.rateLimitModel
      .findOneAndUpdate(
        {
          provider,
          endpoint: this.PROVIDER_QUOTA_ENDPOINT,
        },
        [
          {
            $set: {
              provider,
              endpoint: this.PROVIDER_QUOTA_ENDPOINT,
              dailyPeriod,
              monthlyPeriod,
              dailyRequests: {
                $cond: [
                  { $eq: ['$dailyPeriod', dailyPeriod] },
                  { $ifNull: ['$dailyRequests', 0] },
                  0,
                ],
              },
              monthlyRequests: {
                $cond: [
                  { $eq: ['$monthlyPeriod', monthlyPeriod] },
                  { $ifNull: ['$monthlyRequests', 0] },
                  0,
                ],
              },
            },
          },
        ],
        {
          upsert: true,
          returnDocument: 'after',
          updatePipeline: true,
        },
      )
      .exec();
  }

  private async ensureEndpointPeriodState(
    provider: SportsProvider,
    endpoint: string,
    now: Date,
  ): Promise<void> {
    const dailyPeriod = this.getDailyPeriod(now);
    const monthlyPeriod = this.getMonthlyPeriod(now);

    await this.rateLimitModel
      .findOneAndUpdate(
        {
          provider,
          endpoint,
        },
        [
          {
            $set: {
              provider,
              endpoint,
              dailyPeriod,
              monthlyPeriod,
              dailyRequests: {
                $cond: [
                  { $eq: ['$dailyPeriod', dailyPeriod] },
                  { $ifNull: ['$dailyRequests', 0] },
                  0,
                ],
              },
              monthlyRequests: {
                $cond: [
                  { $eq: ['$monthlyPeriod', monthlyPeriod] },
                  { $ifNull: ['$monthlyRequests', 0] },
                  0,
                ],
              },
            },
          },
        ],
        {
          upsert: true,
          returnDocument: 'after',
          updatePipeline: true,
        },
      )
      .exec();
  }

  // ============================================================
  // EXPIRED LEGACY LOCKS
  // ============================================================

  async clearExpiredLocks(): Promise<number> {
    const result = await this.rateLimitModel
      .updateMany(
        {
          lockedUntil: {
            $lte: new Date(),
          },
        },
        {
          $unset: {
            lockedUntil: 1,
          },
        },
      )
      .exec();

    return result.modifiedCount ?? 0;
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private getConcurrencyLimiter(
    provider: SportsProvider,
    lane: SportsProviderRequestLane,
  ): AsyncConcurrencyLimiter | null {
    if (provider !== 'espn') {
      return null;
    }

    return lane === 'live' ? this.espnLiveLimiter : this.espnNormalLimiter;
  }

  private getConfig(provider: SportsProvider): ProviderLimitConfig {
    return this.limits[provider];
  }

  private getEndpointGateKey(
    provider: SportsProvider,
    endpoint: string,
  ): string {
    return `${provider}:${this.normalizeEndpoint(endpoint)}`;
  }

  private normalizeEndpoint(endpoint: string): string {
    return (
      String(endpoint ?? '')
        .trim()
        .toLowerCase() || 'unknown'
    );
  }

  private getNextLagosMidnight(date: Date): Date {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Lagos',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const year = Number(values.get('year'));
    const month = Number(values.get('month'));
    const day = Number(values.get('day'));

    // Nigeria is UTC+1 year-round: 00:00 WAT is 23:00 UTC on the prior date.
    return new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0) - 60 * 60_000);
  }

  private getDailyPeriod(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Lagos',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const values = new Map(parts.map((part) => [part.type, part.value]));
    return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
  }

  private getMonthlyPeriod(date: Date): string {
    return date.toISOString().slice(0, 7);
  }

  private async sleep(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
}


