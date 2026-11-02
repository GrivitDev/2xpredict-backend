import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  OddsProviderCache,
  OddsProviderCacheDocument,
} from '../schemas/odds-provider-cache.schema';
import {
  OddsProviderState,
  OddsProviderStateDocument,
} from '../schemas/odds-provider-state.schema';

export type OddsProviderName = 'THE_ODDS_API';
export type OddsProviderStatus =
  | 'READY'
  | 'QUOTA_EXHAUSTED'
  | 'THROTTLED'
  | 'AUTH_ERROR'
  | 'DEGRADED'
  | 'DISABLED';

export interface ProviderRequestOptions {
  dailyLimit: number;
  minIntervalMs: number;
  lockWaitMs?: number;
}

export interface ProviderHttpResult<T> {
  data: T;
  headers?: Record<string, unknown>;
}

export interface ProviderStateSummary {
  provider: OddsProviderName;
  status: OddsProviderStatus;
  requestsToday: number;
  dailyLimit: number;
  providerRequestsRemaining?: number;
  providerRequestsUsed?: number;
  message?: string;
  blockedUntil?: Date;
  nextAllowedAt?: Date;
}

export class OddsProviderPausedError extends Error {
  constructor(
    public readonly provider: OddsProviderName,
    public readonly status: OddsProviderStatus,
    message: string,
  ) {
    super(message);
    this.name = 'OddsProviderPausedError';
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

@Injectable()
export class OddsProviderStateService {
  private readonly logger = new Logger(OddsProviderStateService.name);

  constructor(
    @InjectModel(OddsProviderState.name)
    private readonly stateModel: Model<OddsProviderStateDocument>,
    @InjectModel(OddsProviderCache.name)
    private readonly cacheModel: Model<OddsProviderCacheDocument>,
  ) {}

  async getCache<T>(cacheKey: string): Promise<{ data: T; fetchedAt: Date } | null> {
    const row = await this.cacheModel
      .findOne({ cacheKey, expiresAt: { $gt: new Date() } })
      .select({ data: 1, fetchedAt: 1 })
      .lean()
      .exec() as any;
    if (!row) return null;
    return { data: row.data as T, fetchedAt: new Date(row.fetchedAt) };
  }

  async getCaches<T>(cacheKeys: string[]): Promise<Map<string, { data: T; fetchedAt: Date }>> {
    const keys = [...new Set(cacheKeys.map((key) => key.trim()).filter(Boolean))];
    if (!keys.length) return new Map();
    const rows = await this.cacheModel
      .find({ cacheKey: { $in: keys }, expiresAt: { $gt: new Date() } })
      .select({ cacheKey: 1, data: 1, fetchedAt: 1 })
      .lean()
      .exec() as any[];
    return new Map(rows.map((row) => [
      String(row.cacheKey),
      { data: row.data as T, fetchedAt: new Date(row.fetchedAt) },
    ]));
  }

  async getCollectionCursor(provider: OddsProviderName): Promise<string | undefined> {
    const state = await this.ensureCurrentDay(provider);
    const cursor = state?.collectionCursor;
    return typeof cursor === 'string' && cursor.length ? cursor : undefined;
  }

  async setCollectionCursor(provider: OddsProviderName, cursor: string): Promise<void> {
    await this.ensureCurrentDay(provider);
    await this.stateModel.updateOne(
      { key: provider },
      { $set: { collectionCursor: cursor } },
    ).exec();
  }

  async putCache<T extends Record<string, unknown>>(
    provider: OddsProviderName,
    cacheKey: string,
    data: T,
    ttlMs: number,
    fetchedAt = new Date(),
  ): Promise<void> {
    const expiresAt = new Date(fetchedAt.getTime() + Math.max(60_000, ttlMs));
    await this.cacheModel.updateOne(
      { cacheKey },
      { $set: { provider, data, fetchedAt, expiresAt } },
      { upsert: true },
    ).exec();
  }

  async isNetworkAvailable(
    provider: OddsProviderName,
    dailyLimit: number,
  ): Promise<boolean> {
    const state = await this.ensureCurrentDay(provider);
    if (!state) return true;
    const now = Date.now();
    if (state.status === 'AUTH_ERROR' || state.status === 'DISABLED') return false;
    if (state.blockedUntil && new Date(state.blockedUntil).getTime() > now) return false;
    if (Number(state.requestsToday ?? 0) >= dailyLimit) {
      await this.setStatus(
        provider,
        'QUOTA_EXHAUSTED',
        `Internal daily request budget (${dailyLimit}) exhausted.`,
        this.nextUtcMidnight(),
      );
      return false;
    }
    return true;
  }

  async getSummary(
    provider: OddsProviderName,
    dailyLimit: number,
  ): Promise<ProviderStateSummary> {
    const state = await this.ensureCurrentDay(provider);
    return {
      provider,
      status: (state?.status ?? 'READY') as OddsProviderStatus,
      requestsToday: Number(state?.requestsToday ?? 0),
      dailyLimit,
      providerRequestsRemaining: this.optionalNumber(state?.providerRequestsRemaining),
      providerRequestsUsed: this.optionalNumber(state?.providerRequestsUsed),
      message: state?.message,
      blockedUntil: state?.blockedUntil ? new Date(state.blockedUntil) : undefined,
      nextAllowedAt: state?.nextAllowedAt ? new Date(state.nextAllowedAt) : undefined,
    };
  }

  /** True only when a new provider request is due now, without sleeping inside the worker. */
  async isRequestDue(
    provider: OddsProviderName,
    dailyLimit: number,
    minIntervalMs: number,
  ): Promise<boolean> {
    const state = await this.ensureCurrentDay(provider);
    if (!state || state.status === 'AUTH_ERROR' || state.status === 'DISABLED') return false;
    const now = Date.now();
    if (state.blockedUntil && new Date(state.blockedUntil).getTime() > now) return false;
    if (Number(state.requestsToday ?? 0) >= dailyLimit) {
      await this.setStatus(
        provider,
        'QUOTA_EXHAUSTED',
        `Internal daily request budget (${dailyLimit}) exhausted.`,
        this.nextUtcMidnight(),
      );
      return false;
    }
    const nextAllowedAt = state.nextAllowedAt
      ? new Date(state.nextAllowedAt).getTime()
      : state.lastRequestAt
        ? new Date(state.lastRequestAt).getTime() + Math.max(0, minIntervalMs)
        : 0;
    return nextAllowedAt <= now;
  }

  /**
   * Runs one network request under a Mongo-backed lease, shared daily budget,
   * and minimum start interval. HTTP 429/auth/permission errors are never
   * retried here; callers switch to their configured fallback instead.
   */
  async execute<T>(
    provider: OddsProviderName,
    options: ProviderRequestOptions,
    operation: () => Promise<ProviderHttpResult<T>>,
  ): Promise<T> {
    const key = provider;
    const dailyLimit = Math.max(1, Math.floor(options.dailyLimit));
    const intervalMs = Math.max(0, options.minIntervalMs);
    const maxWaitMs = Math.max(5_000, options.lockWaitMs ?? 90_000);
    const startedWaitingAt = Date.now();
    let leasedState: any;

    while (!leasedState) {
      const state = await this.ensureCurrentDay(provider);
      const now = new Date();
      if (state?.blockedUntil && new Date(state.blockedUntil).getTime() > now.getTime()) {
        throw new OddsProviderPausedError(
          provider,
          (state.status ?? 'DEGRADED') as OddsProviderStatus,
          `${provider} is paused until ${new Date(state.blockedUntil).toISOString()}: ${state.message ?? 'provider cooldown'}`,
        );
      }
      if (Number(state?.requestsToday ?? 0) >= dailyLimit) {
        await this.setStatus(provider, 'QUOTA_EXHAUSTED', `Internal daily request budget (${dailyLimit}) exhausted.`, this.nextUtcMidnight());
        throw new OddsProviderPausedError(provider, 'QUOTA_EXHAUSTED', `${provider} internal daily request budget is exhausted.`);
      }

      leasedState = await this.stateModel.findOneAndUpdate(
        {
          key,
          utcDate: this.utcDateKey(),
          requestsToday: { $lt: dailyLimit },
          $or: [
            { lockedUntil: { $exists: false } },
            { lockedUntil: null },
            { lockedUntil: { $lte: now } },
          ],
        },
        { $set: { lockedUntil: new Date(Date.now() + 120_000) } },
        { returnDocument: 'after', },
      ).lean().exec();

      if (!leasedState) {
        if (Date.now() - startedWaitingAt >= maxWaitMs) {
          throw new OddsProviderPausedError(provider, 'DEGRADED', `${provider} request lease is busy; this cycle will use cached data or the fallback provider.`);
        }
        await sleep(300);
      }
    }

    try {
      const allowedAt = leasedState.nextAllowedAt
        ? new Date(leasedState.nextAllowedAt).getTime()
        : leasedState.lastRequestAt
          ? new Date(leasedState.lastRequestAt).getTime() + intervalMs
          : 0;
      const waitMs = Math.max(0, allowedAt - Date.now());
      if (waitMs > maxWaitMs) {
        throw new OddsProviderPausedError(provider, 'THROTTLED', `${provider} minimum request interval cannot be satisfied in this worker cycle.`);
      }
      if (waitMs) await sleep(waitMs);

      const reservation = await this.stateModel.findOneAndUpdate(
        { key, utcDate: this.utcDateKey(), requestsToday: { $lt: dailyLimit } },
        {
          $inc: { requestsToday: 1 },
          $set: { lastRequestAt: new Date(), status: 'READY', message: null },
        },
        { returnDocument: 'after', },
      ).lean().exec();

      if (!reservation) {
        await this.setStatus(provider, 'QUOTA_EXHAUSTED', `Internal daily request budget (${dailyLimit}) exhausted.`, this.nextUtcMidnight());
        throw new OddsProviderPausedError(provider, 'QUOTA_EXHAUSTED', `${provider} internal daily request budget is exhausted.`);
      }

      const httpResult = await operation();
      const headers = this.normalizeHeaders(httpResult.headers);
      const providerRemaining = this.headerNumber(headers, ['x-requests-remaining', 'x-ratelimit-requests-remaining']);
      const providerUsed = this.headerNumber(headers, ['x-requests-used', 'x-ratelimit-requests-count']);
      const lastCost = this.headerNumber(headers, ['x-requests-last']);
      const updates: Record<string, unknown> = {
        nextAllowedAt: new Date(Date.now() + intervalMs),
        lockedUntil: null,
        status: 'READY',
        message: null,
        blockedUntil: null,
      };
      if (providerRemaining !== null) updates.providerRequestsRemaining = providerRemaining;
      if (providerUsed !== null) updates.providerRequestsUsed = providerUsed;
      if (lastCost !== null) updates.providerLastRequestCost = lastCost;

      if (providerRemaining !== null && providerRemaining <= 0) {
        updates.status = 'QUOTA_EXHAUSTED';
        updates.message = 'The Odds API reports zero remaining monthly usage credits; calls are paused until the next UTC month boundary.';
        updates.blockedUntil = this.nextUtcMonthStart();
      }
      await this.stateModel.updateOne({ key }, { $set: updates }).exec();
      return httpResult.data;
    } catch (error) {
      // A policy/lease pause is not an upstream failure and must not create a
      // second, overlapping circuit-breaker window.
      if (!(error instanceof OddsProviderPausedError)) {
        await this.recordError(provider, error, intervalMs);
      }
      throw error;
    } finally {
      await this.stateModel.updateOne({ key }, { $set: { lockedUntil: null } }).exec().catch(() => undefined);
    }
  }

  async setDisabled(provider: OddsProviderName, message: string): Promise<void> {
    await this.ensureCurrentDay(provider);
    await this.stateModel.updateOne(
      { key: provider },
      { $set: { status: 'DISABLED', message, blockedUntil: this.nextUtcMidnight(), lockedUntil: null } },
    ).exec();
  }

  private async ensureCurrentDay(provider: OddsProviderName): Promise<any | null> {
    const today = this.utcDateKey();
    await this.stateModel.updateOne(
      { key: provider },
      {
        $setOnInsert: {
          provider,
          utcDate: today,
          requestsToday: 0,
          status: 'READY',
        },
      },
      { upsert: true },
    ).exec();

    let state = await this.stateModel.findOne({ key: provider }).lean().exec() as any;
    if (state && state.utcDate !== today) {
      const now = Date.now();
      const hasActiveCooldown = state.blockedUntil && new Date(state.blockedUntil).getTime() > now;
      const remoteOddsApiQuotaLock = provider === 'THE_ODDS_API' &&
        state.status === 'QUOTA_EXHAUSTED' &&
        /usage credit|usage quota|no remaining account requests|quota appears exhausted/i.test(String(state.message ?? '')) &&
        hasActiveCooldown;
      const preserveState = Boolean(remoteOddsApiQuotaLock || hasActiveCooldown);
      await this.stateModel.updateOne(
        { key: provider, utcDate: state.utcDate },
        {
          $set: preserveState
            ? { utcDate: today, requestsToday: 0 }
            : {
                utcDate: today,
                requestsToday: 0,
                status: 'READY',
                message: null,
                blockedUntil: null,
                providerRequestsRemaining: null,
                providerRequestsUsed: null,
                providerLastRequestCost: null,
              },
        },
      ).exec();
      state = await this.stateModel.findOne({ key: provider }).lean().exec() as any;
    }
    return state;
  }

  private async setStatus(
    provider: OddsProviderName,
    status: OddsProviderStatus,
    message: string,
    blockedUntil?: Date,
  ): Promise<void> {
    const set: Record<string, unknown> = { status, message };
    if (blockedUntil) set.blockedUntil = blockedUntil;
    await this.stateModel.updateOne({ key: provider }, { $set: set }).exec();
  }

  private async recordError(provider: OddsProviderName, error: unknown, minIntervalMs: number): Promise<void> {
    const details = this.errorDetails(error, provider);
    const bodyText = this.safeText(details.body ?? details.message).toLowerCase();
    const dailyQuotaError = /daily.{0,20}(quota|limit)|quota.{0,20}(exhaust|reached|exceeded)|requests.{0,20}(limit|quota)|insufficient.{0,20}(credit|quota)|out of.{0,20}(credit|quota)|out[_\s-]+of[_\s-]+usage[_\s-]+credits|usage credit limit|usage credits? (?:have been )?(?:exhausted|reached|exceeded)/i.test(bodyText) || details.status === 402;
    const now = Date.now();
    let status: OddsProviderStatus = 'DEGRADED';
    let blockedUntil = new Date(now + Math.max(minIntervalMs, 5 * 60_000));
    let message = `${provider} request failed${details.status ? ` (HTTP ${details.status})` : ''}: ${details.message.slice(0, 300)}`;

    if (dailyQuotaError && provider === 'THE_ODDS_API') {
      status = 'QUOTA_EXHAUSTED';
      blockedUntil = this.nextUtcMonthStart();
      message = `${provider} monthly usage quota appears exhausted; calls are stopped until the next UTC month boundary. Confirm the account's actual reset date before manually resuming.`;
    } else if (details.status === 429 || /rate limit|too many requests|throttl/i.test(bodyText)) {
      status = dailyQuotaError ? 'QUOTA_EXHAUSTED' : 'THROTTLED';
      const retryAfter = this.retryAfterMs(details.headers);
      blockedUntil = dailyQuotaError ? this.nextUtcMonthStart() : new Date(now + Math.max(retryAfter ?? 60_000, 60_000));
      if (dailyQuotaError) {
        message = `${provider} usage quota exhausted; calls remain stopped until the next UTC month boundary.`;
      } else {
        message = `${provider} returned a rate-limit response; no automatic retry will be made before ${blockedUntil.toISOString()}.`;
      }
    } else if (
      details.status === 401 ||
      details.status === 403 ||
      /invalid api key|unauthorized|not authorized|access denied|forbidden|subscription|not available on.*plan|permission/i.test(bodyText)
    ) {
      // Stop this provider for the rest of the UTC day instead of repeatedly
      // hitting an account/key/plan denial. The other provider may still run.
      status = 'AUTH_ERROR';
      blockedUntil = this.nextUtcMidnight();
      message = `${provider} returned an authentication/permission denial${details.status ? ` (HTTP ${details.status})` : ''}. Requests are paused until the next UTC day for investigation; check the key, account permissions, and sport/market plan access.`;
    } else if (details.status === 400 || details.status === 404 || details.status === 422) {
      // Bad/unsupported league, market, or parameters should not disable every
      // competition on the provider. Callers cache deterministic failures.
      status = 'READY';
      // Keep the global provider available: the failed request is negative-
      // cached by the caller, while nextAllowedAt still enforces quota pacing.
      blockedUntil = new Date(now - 1_000);
      message = `${provider} rejected a request (HTTP ${details.status}); this exact query will not be blindly retried.`;
    }

    await this.stateModel.updateOne(
      { key: provider },
      {
        $set: {
          status,
          message,
          blockedUntil,
          nextAllowedAt: new Date(now + minIntervalMs),
          lockedUntil: null,
          ...(details.remaining !== null ? { providerRequestsRemaining: details.remaining } : {}),
          ...(details.used !== null ? { providerRequestsUsed: details.used } : {}),
          ...(details.lastCost !== null ? { providerLastRequestCost: details.lastCost } : {}),
        },
      },
    ).exec();
    this.logger.warn(message);
  }

  private errorDetails(error: unknown, providerContext: OddsProviderName): {
    status?: number;
    message: string;
    body?: unknown;
    headers: Record<string, string>;
    remaining: number | null;
    used: number | null;
    lastCost: number | null;
  } {
    const item = (error ?? {}) as any;
    const response = item.response ?? {};
    const headers = this.normalizeHeaders(response.headers);
    const provider = (item.provider as OddsProviderName | undefined) ?? providerContext;
    const remaining = this.headerNumber(headers, ['x-requests-remaining', 'x-ratelimit-requests-remaining']);
    const used = this.headerNumber(headers, ['x-requests-used', 'x-ratelimit-requests-count']);
    const lastCost = this.headerNumber(headers, ['x-requests-last']);
    return {
      status: Number.isFinite(Number(response.status ?? item.statusCode)) ? Number(response.status ?? item.statusCode) : undefined,
      message: item.message ? String(item.message) : String(error),
      body: response.data ?? item.body,
      headers,
      remaining,
      used,
      lastCost,
    };
  }

  private normalizeHeaders(value: unknown): Record<string, string> {
    const result: Record<string, string> = {};
    if (!value || typeof value !== 'object') return result;
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(raw)) result[key.toLowerCase()] = String(raw[0] ?? '');
      else if (raw !== undefined && raw !== null) result[key.toLowerCase()] = String(raw);
    }
    return result;
  }

  private headerNumber(headers: Record<string, string>, candidates: string[]): number | null {
    for (const candidate of candidates) {
      const raw = headers[candidate.toLowerCase()];
      if (raw === undefined) continue;
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  private retryAfterMs(headers: Record<string, string>): number | null {
    const raw = headers['retry-after'];
    if (!raw) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = new Date(raw).getTime();
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
  }

  private utcDateKey(date = new Date()): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  private nextUtcMidnight(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  }

  private nextUtcMonthStart(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  }

  private optionalNumber(value: unknown): number | undefined {
    const parsed = Number(value);
    return value === undefined || value === null || !Number.isFinite(parsed) ? undefined : parsed;
  }

  private safeText(value: unknown): string {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value) ?? ''; } catch { return String(value ?? ''); }
  }
}

