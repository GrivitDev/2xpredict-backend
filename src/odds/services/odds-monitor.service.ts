import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EspnFixture } from '../../sports/schemas/espn/espn-fixture.schema';
import { FixtureOdds } from '../schemas/fixture-odds.schema';
import { OddsProviderCache } from '../schemas/odds-provider-cache.schema';
import { OddsProviderState } from '../schemas/odds-provider-state.schema';
import { TheOddsApiService } from '../providers/the-odds-api.service';
import {
  FOOTBALL_MARKET_CATALOG,
  expandCanonicalSelections,
} from '../catalog/football-market-catalog';
import { OddsWorkerService } from './odds-worker.service';

type CheckStatus = 'OK' | 'WARN' | 'FAIL' | 'UNKNOWN';
type Check = {
  name: string;
  status: CheckStatus;
  message: string;
  value?: unknown;
};

type FixtureSample = { eventId?: unknown };
type InventoryRow = { [key: string]: unknown };
type CacheStatsRow = {
  total?: number;
  expired?: number;
  latestFetchedAt?: Date | string;
  [key: string]: unknown;
};
type ProviderState = {
  status?: string;
  requestsToday?: number;
  blockedUntil?: Date | string | null;
  providerRequestsRemaining?: unknown;
  providerRequestsUsed?: unknown;
  providerLastRequestCost?: unknown;
  lastRequestAt?: unknown;
  nextAllowedAt?: unknown;
  message?: unknown;
};
type UpcomingPriceRow = {
  _id: string;
  prices?: number;
  providerPrices?: number;
  readyPrices?: number;
};
type WorkerMonitorStatus = {
  running: boolean;
  stopping: boolean;
  lastCycleCompletedAt?: Date | string | null;
  lastCycleError?: unknown;
  [key: string]: unknown;
};
type IndexGroup = {
  declared: string[];
  actual: string[];
  missing: string[];
  verification: string;
};
type IndexStatus = {
  fixtureOdds: IndexGroup;
  providerState: IndexGroup;
  providerCache: IndexGroup;
};

@Injectable()
export class OddsMonitorService {
  private readonly staleProviderPriceMs = 6 * 60 * 60_000;
  private readonly upcomingWindowMs = 72 * 60 * 60_000;
  private readonly upcomingFixtureSampleLimit = 2000;
  private readonly overviewCacheMs = 15_000;
  private overviewCache?: { cachedAt: number; value: Record<string, unknown> };

  constructor(
    @InjectModel(EspnFixture.name)
    private readonly fixtureModel: Model<EspnFixture>,
    @InjectModel(FixtureOdds.name)
    private readonly oddsModel: Model<FixtureOdds>,
    @InjectModel(OddsProviderState.name)
    private readonly providerStateModel: Model<OddsProviderState>,
    @InjectModel(OddsProviderCache.name)
    private readonly providerCacheModel: Model<OddsProviderCache>,
    private readonly oddsApi: TheOddsApiService,
    private readonly worker: OddsWorkerService,
  ) {}

  async getOverview() {
    const cached = this.overviewCache;
    if (cached && Date.now() - cached.cachedAt < this.overviewCacheMs) {
      return { ...cached.value, cached: true };
    }
    const generatedAt = new Date();
    const checks: Check[] = [];
    const failures: string[] = [];
    const warnings: string[] = [];
    const dbReady = Number(this.fixtureModel.db.readyState) === 1;

    checks.push({
      name: 'mongodb_connection',
      status: dbReady ? 'OK' : 'FAIL',
      message: dbReady
        ? 'Odds module MongoDB connection is ready.'
        : `MongoDB connection is not ready (readyState=${this.fixtureModel.db.readyState}).`,
      value: { readyState: this.fixtureModel.db.readyState },
    });

    const safe = async <T>(
      name: string,
      fallback: T,
      work: () => Promise<T>,
    ): Promise<T> => {
      try {
        const result = await work();
        checks.push({
          name,
          status: 'OK',
          message: `${name} query completed.`,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        checks.push({
          name,
          status: 'FAIL',
          message: `${name} query failed: ${message.slice(0, 250)}`,
        });
        failures.push(name);
        return fallback;
      }
    };

    const now = new Date();
    const windowEnd = new Date(now.getTime() + this.upcomingWindowMs);
    const fixtureFilter: Record<string, unknown> = {
      fixtureDate: { $gte: now, $lte: windowEnd },
      live: { $ne: true },
      completed: { $ne: true },
    };

    const [
      fixtureCount,
      fixtureSample,
      inventoryRows,
      providerState,
      cacheStatsRows,
      cacheExpiredCount,
      indexStatus,
      workerStatus,
    ] = await Promise.all([
      safe('upcoming_fixture_count', 0, () =>
        this.fixtureModel.countDocuments(fixtureFilter).exec(),
      ),
      safe<FixtureSample[]>(
        'upcoming_fixture_sample',
        [],
        () =>
          this.fixtureModel
            .find(fixtureFilter)
            .select({
              eventId: 1,
              fixtureDate: 1,
              leagueId: 1,
              live: 1,
              completed: 1,
            })
            .sort({ fixtureDate: 1 })
            .limit(this.upcomingFixtureSampleLimit)
            .lean()
            .exec() as Promise<FixtureSample[]>,
      ),
      safe<InventoryRow[]>(
        'odds_inventory',
        [],
        () =>
          this.oddsModel
            .aggregate([
              {
                $match: {
                  $or: [
                    { expiresAt: { $exists: false } },
                    { expiresAt: { $gt: now } },
                  ],
                },
              },
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  provider: {
                    $sum: {
                      $cond: [{ $eq: ['$priceType', 'PROVIDER'] }, 1, 0],
                    },
                  },
                  oddsApiProvider: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ['$priceType', 'PROVIDER'] },
                            { $eq: ['$provider', 'THE_ODDS_API'] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  espnProvider: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ['$priceType', 'PROVIDER'] },
                            { $eq: ['$provider', 'ESPN'] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  estimated: {
                    $sum: {
                      $cond: [{ $eq: ['$priceType', 'ESTIMATED'] }, 1, 0],
                    },
                  },
                  bookmakerOnly: {
                    $sum: {
                      $cond: [{ $eq: ['$oddsBasis', 'BOOKMAKER_ONLY'] }, 1, 0],
                    },
                  },
                  bookmakerPlusHistory: {
                    $sum: {
                      $cond: [
                        { $eq: ['$oddsBasis', 'BOOKMAKER_PLUS_HISTORY'] },
                        1,
                        0,
                      ],
                    },
                  },
                  historicalOnly: {
                    $sum: {
                      $cond: [{ $eq: ['$oddsBasis', 'HISTORICAL_ONLY'] }, 1, 0],
                    },
                  },
                  priorOnly: {
                    $sum: {
                      $cond: [{ $eq: ['$oddsBasis', 'PRIOR_ONLY'] }, 1, 0],
                    },
                  },
                  predictionReady: {
                    $sum: {
                      $cond: [{ $eq: ['$predictionReady', true] }, 1, 0],
                    },
                  },
                  invalidOdds: {
                    $sum: {
                      $cond: [
                        {
                          $or: [
                            { $not: [{ $isNumber: '$decimalOdds' }] },
                            { $lte: ['$decimalOdds', 1] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  missingFairOdds: {
                    $sum: {
                      $cond: [
                        {
                          $or: [
                            { $eq: ['$fairOdds', null] },
                            { $not: [{ $isNumber: '$fairOdds' }] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  missingOddsBasis: {
                    $sum: {
                      $cond: [
                        {
                          $or: [
                            { $eq: ['$oddsBasis', null] },
                            { $not: ['$oddsBasis'] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  missingCalculationMethod: {
                    $sum: {
                      $cond: [
                        {
                          $or: [
                            { $eq: ['$oddsCalculationMethod', null] },
                            { $not: ['$oddsCalculationMethod'] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  missingProviderTimestamp: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ['$priceType', 'PROVIDER'] },
                            { $eq: ['$providerUpdatedAt', null] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  staleProviderPrices: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ['$priceType', 'PROVIDER'] },
                            { $ne: ['$providerUpdatedAt', null] },
                            {
                              $lt: [
                                '$providerUpdatedAt',
                                new Date(
                                  now.getTime() - this.staleProviderPriceMs,
                                ),
                              ],
                            },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  unknownMarkets: {
                    $sum: {
                      $cond: [
                        {
                          $not: [
                            {
                              $in: [
                                '$marketId',
                                FOOTBALL_MARKET_CATALOG.map((m) => m.id),
                              ],
                            },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  markedReadyButInvalid: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ['$predictionReady', true] },
                            {
                              $or: [
                                { $not: [{ $isNumber: '$decimalOdds' }] },
                                { $lte: ['$decimalOdds', 1] },
                              ],
                            },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                },
              },
            ])
            .exec() as Promise<InventoryRow[]>,
      ),
      safe<ProviderState | null>(
        'provider_state',
        null,
        () =>
          this.providerStateModel
            .findOne({ key: 'THE_ODDS_API' })
            .lean()
            .exec() as Promise<ProviderState | null>,
      ),
      safe<CacheStatsRow[]>(
        'provider_cache_stats',
        [],
        () =>
          this.providerCacheModel
            .aggregate([
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  unexpired: {
                    $sum: { $cond: [{ $gt: ['$expiresAt', now] }, 1, 0] },
                  },
                  expired: {
                    $sum: { $cond: [{ $lte: ['$expiresAt', now] }, 1, 0] },
                  },
                  latestFetchedAt: { $max: '$fetchedAt' },
                  oldestFetchedAt: { $min: '$fetchedAt' },
                },
              },
            ])
            .exec() as Promise<CacheStatsRow[]>,
      ),
      safe('expired_cache_documents', 0, () =>
        this.providerCacheModel
          .countDocuments({ expiresAt: { $lte: now } })
          .exec(),
      ),
      safe(
        'declared_index_coverage',
        {
          fixtureOdds: {
            declared: [],
            actual: [],
            missing: [],
            verification: 'UNKNOWN',
          },
          providerState: {
            declared: [],
            actual: [],
            missing: [],
            verification: 'UNKNOWN',
          },
          providerCache: {
            declared: [],
            actual: [],
            missing: [],
            verification: 'UNKNOWN',
          },
        } satisfies IndexStatus,
        async () => this.inspectIndexes(),
      ),
      (
        this.worker as unknown as {
          getMonitorStatus(): Promise<WorkerMonitorStatus>;
        }
      ).getMonitorStatus(),
    ]);

    const inventory = inventoryRows[0] ?? {};
    const cacheStats = cacheStatsRows[0] ?? {};
    const eventIds: string[] = [
      ...new Set(
        fixtureSample
          .map((fixture) =>
            typeof fixture.eventId === 'string'
              ? fixture.eventId.trim()
              : typeof fixture.eventId === 'number'
                ? String(fixture.eventId)
                : '',
          )
          .filter(Boolean),
      ),
    ];
    const upcomingPrices = await safe<UpcomingPriceRow[]>(
      'upcoming_odds_coverage',
      [],
      () =>
        eventIds.length
          ? (this.oddsModel
              .aggregate([
                {
                  $match: {
                    eventId: { $in: eventIds },
                    $or: [
                      { expiresAt: { $exists: false } },
                      { expiresAt: { $gt: now } },
                    ],
                  },
                },
                {
                  $group: {
                    _id: '$eventId',
                    prices: { $sum: 1 },
                    providerPrices: {
                      $sum: {
                        $cond: [{ $eq: ['$priceType', 'PROVIDER'] }, 1, 0],
                      },
                    },
                    readyPrices: {
                      $sum: {
                        $cond: [{ $eq: ['$predictionReady', true] }, 1, 0],
                      },
                    },
                    latestUpdatedAt: { $max: '$updatedAt' },
                  },
                },
              ])
              .exec() as Promise<UpcomingPriceRow[]>)
          : Promise.resolve([]),
    );

    const priceByEvent = new Map<string, UpcomingPriceRow>(
      upcomingPrices.map((row) => [String(row._id), row]),
    );
    const readyFixtureCount = eventIds.filter(
      (id) => Number(priceByEvent.get(id)?.readyPrices ?? 0) > 0,
    ).length;
    const pricedFixtureCount = eventIds.filter(
      (id) => Number(priceByEvent.get(id)?.prices ?? 0) > 0,
    ).length;
    const providerPricedFixtureCount = eventIds.filter(
      (id) => Number(priceByEvent.get(id)?.providerPrices ?? 0) > 0,
    ).length;
    const sampledFixturesWithoutOdds = eventIds.filter(
      (id) => !priceByEvent.has(id),
    ).length;
    const sampleCoverage = {
      sampleSize: eventIds.length,
      sampleLimit: this.upcomingFixtureSampleLimit,
      truncated: fixtureCount > eventIds.length,
      fixturesWithAnyOdds: pricedFixtureCount,
      fixturesWithProviderOdds: providerPricedFixtureCount,
      predictionReadyFixtures: readyFixtureCount,
      fixturesWithoutOdds: sampledFixturesWithoutOdds,
      anyOddsCoveragePercent: this.percent(pricedFixtureCount, eventIds.length),
      providerOddsCoveragePercent: this.percent(
        providerPricedFixtureCount,
        eventIds.length,
      ),
      predictionReadinessPercent: this.percent(
        readyFixtureCount,
        eventIds.length,
      ),
    };

    const providerConfigured = this.oddsApi.isConfigured();
    const providerStatus = String(
      providerState?.status ?? (providerConfigured ? 'UNKNOWN' : 'DISABLED'),
    );
    const requestsToday = Number(providerState?.requestsToday ?? 0);
    const configuredDailyLimit = Number(
      process.env.THE_ODDS_API_DAILY_REQUEST_LIMIT ?? 4,
    );
    const dailyLimit =
      Number.isFinite(configuredDailyLimit) && configuredDailyLimit >= 1
        ? Math.floor(configuredDailyLimit)
        : 4;
    const providerQuotaRemainingInternal = Math.max(
      0,
      dailyLimit - requestsToday,
    );
    const blockedUntil = providerState?.blockedUntil
      ? new Date(providerState.blockedUntil)
      : null;
    const activeProviderBlock = Boolean(
      blockedUntil && blockedUntil.getTime() > now.getTime(),
    );
    const cacheAgeMs = cacheStats.latestFetchedAt
      ? Math.max(
          0,
          now.getTime() - new Date(cacheStats.latestFetchedAt).getTime(),
        )
      : null;
    const workerAgeMs = workerStatus.lastCycleCompletedAt
      ? Math.max(
          0,
          now.getTime() - new Date(workerStatus.lastCycleCompletedAt).getTime(),
        )
      : null;

    if (!providerConfigured)
      warnings.push(
        'THE_ODDS_API_KEY is not configured; provider odds depend on ESPN prices and labelled estimates.',
      );
    if (providerConfigured && !providerState)
      warnings.push(
        'The Odds API is configured but no provider-state record exists yet; no completed provider request has been recorded.',
      );
    if (
      !workerStatus.running &&
      !workerStatus.stopping &&
      !workerStatus.lastCycleCompletedAt
    )
      warnings.push(
        'Odds worker has not completed startup and its first cycle yet.',
      );
    if (providerStatus === 'AUTH_ERROR')
      failures.push('provider_authentication');
    else if (
      ['QUOTA_EXHAUSTED', 'THROTTLED', 'DEGRADED'].includes(providerStatus)
    )
      warnings.push(`The Odds API provider state is ${providerStatus}.`);
    if (activeProviderBlock)
      warnings.push(
        `The Odds API is blocked until ${blockedUntil!.toISOString()}.`,
      );
    if (Number(inventory.invalidOdds ?? 0) > 0)
      failures.push('invalid_decimal_odds');
    if (Number(inventory.markedReadyButInvalid ?? 0) > 0)
      failures.push('prediction_ready_invalid_price');
    if (Number(inventory.staleProviderPrices ?? 0) > 0)
      warnings.push(
        `${String(inventory.staleProviderPrices)} provider prices are older than six hours.`,
      );
    if (Number(inventory.missingProviderTimestamp ?? 0) > 0)
      warnings.push(
        `${String(inventory.missingProviderTimestamp)} provider prices have no providerUpdatedAt timestamp.`,
      );
    if (Number(inventory.unknownMarkets ?? 0) > 0)
      warnings.push(
        `${String(inventory.unknownMarkets)} odds rows reference markets outside the canonical catalogue.`,
      );
    if (Number(inventory.missingOddsBasis ?? 0) > 0)
      warnings.push(
        `${String(inventory.missingOddsBasis)} active odds rows have no oddsBasis provenance.`,
      );
    if (Number(inventory.missingCalculationMethod ?? 0) > 0)
      warnings.push(
        `${String(inventory.missingCalculationMethod)} active odds rows have no oddsCalculationMethod.`,
      );
    if (fixtureCount > 0 && sampleCoverage.predictionReadinessPercent < 50)
      warnings.push(
        'Less than half of the sampled upcoming fixtures are prediction-ready.',
      );
    if (sampledFixturesWithoutOdds > 0)
      warnings.push(
        `${sampledFixturesWithoutOdds} sampled upcoming fixtures have no active odds rows.`,
      );
    if (
      workerStatus.lastCycleCompletedAt &&
      workerAgeMs !== null &&
      workerAgeMs > 5 * 60_000
    )
      warnings.push(
        'Odds worker has not completed a cycle in the last five minutes.',
      );
    if (workerStatus.lastCycleError)
      warnings.push(
        `Last worker error: ${(workerStatus.lastCycleError instanceof Error
          ? workerStatus.lastCycleError.message
          : typeof workerStatus.lastCycleError === 'string'
            ? workerStatus.lastCycleError
            : (JSON.stringify(workerStatus.lastCycleError) ?? 'Unknown error')
        ).slice(0, 250)}.`,
      );
    if (Number(cacheStats.expired ?? 0) > 0)
      warnings.push(
        `${cacheStats.expired} expired cache rows remain in MongoDB; TTL deletion may be delayed.`,
      );
    if (
      cacheAgeMs !== null &&
      Number(cacheStats.total ?? 0) > 0 &&
      cacheAgeMs > 2 * 60 * 60_000
    )
      warnings.push('The newest provider cache entry is older than two hours.');
    for (const group of Object.values(indexStatus)) {
      if (Array.isArray(group.missing) && group.missing.length)
        warnings.push(
          `Missing declared MongoDB indexes: ${group.missing.join(', ')}.`,
        );
    }

    const failedChecks = checks
      .filter((item) => item.status === 'FAIL')
      .map((item) => item.name);
    failures.push(...failedChecks);
    const uniqueFailures = [...new Set(failures)];
    const uniqueWarnings = [...new Set(warnings)];
    const status = uniqueFailures.length
      ? 'DEGRADED'
      : uniqueWarnings.length
        ? 'DEGRADED'
        : 'OK';

    const marketDefinitions = FOOTBALL_MARKET_CATALOG.map((market) => ({
      id: market.id,
      name: market.fullName,
      selectionMode: market.selectionMode,
      selectionCount: expandCanonicalSelections(market).length,
    }));
    const expectedCanonicalSelections = marketDefinitions.reduce(
      (sum, market) => sum + market.selectionCount,
      0,
    );

    const overview: Record<string, unknown> = {
      generatedAt,
      status,
      summary: {
        databaseReady: dbReady,
        canonicalMarkets: FOOTBALL_MARKET_CATALOG.length,
        expectedCanonicalSelections,
        upcomingFixtures72h: fixtureCount,
        sampledUpcomingFixtures: eventIds.length,
        activeOddsRows: Number(inventory.total ?? 0),
        providerOddsRows: Number(inventory.provider ?? 0),
        oddsApiProviderRows: Number(inventory.oddsApiProvider ?? 0),
        espnProviderRows: Number(inventory.espnProvider ?? 0),
        estimatedOddsRows: Number(inventory.estimated ?? 0),
        predictionReadyOddsRows: Number(inventory.predictionReady ?? 0),
        providerStatus,
        workerRunning: Boolean(workerStatus.running),
        checksPassed: checks.filter((item) => item.status === 'OK').length,
        checksFailed: checks.filter((item) => item.status === 'FAIL').length,
        warningCount: uniqueWarnings.length,
      },
      health: {
        status,
        database: {
          ready: dbReady,
          readyState: this.fixtureModel.db.readyState,
        },
        provider: {
          name: 'THE_ODDS_API',
          configured: providerConfigured,
          status: providerStatus,
          requestsToday,
          internalDailyLimit: dailyLimit,
          internalRequestsRemaining: providerQuotaRemainingInternal,
          providerRequestsRemaining:
            providerState?.providerRequestsRemaining ?? null,
          providerRequestsUsed: providerState?.providerRequestsUsed ?? null,
          providerLastRequestCost:
            providerState?.providerLastRequestCost ?? null,
          lastRequestAt: providerState?.lastRequestAt ?? null,
          nextAllowedAt: providerState?.nextAllowedAt ?? null,
          blockedUntil,
          activeBlock: activeProviderBlock,
          message: providerState?.message ?? null,
        },
        worker: {
          ...workerStatus,
          ageSinceLastCompletedCycleMs: workerAgeMs,
        },
      },
      coverage: {
        upcomingWindow: { from: now, to: windowEnd, hours: 72 },
        ...sampleCoverage,
      },
      oddsQuality: {
        activeRows: Number(inventory.total ?? 0),
        providerRows: Number(inventory.provider ?? 0),
        oddsApiProviderRows: Number(inventory.oddsApiProvider ?? 0),
        espnProviderRows: Number(inventory.espnProvider ?? 0),
        estimatedRows: Number(inventory.estimated ?? 0),
        oddsBasisBreakdown: {
          bookmakerOnly: Number(inventory.bookmakerOnly ?? 0),
          bookmakerPlusHistory: Number(inventory.bookmakerPlusHistory ?? 0),
          historicalOnly: Number(inventory.historicalOnly ?? 0),
          priorOnly: Number(inventory.priorOnly ?? 0),
        },
        predictionReadyRows: Number(inventory.predictionReady ?? 0),
        invalidDecimalOdds: Number(inventory.invalidOdds ?? 0),
        markedReadyButInvalid: Number(inventory.markedReadyButInvalid ?? 0),
        missingFairOdds: Number(inventory.missingFairOdds ?? 0),
        missingOddsBasis: Number(inventory.missingOddsBasis ?? 0),
        missingCalculationMethod: Number(
          inventory.missingCalculationMethod ?? 0,
        ),
        providerPricesMissingTimestamp: Number(
          inventory.missingProviderTimestamp ?? 0,
        ),
        staleProviderPricesOverSixHours: Number(
          inventory.staleProviderPrices ?? 0,
        ),
        unknownCanonicalMarkets: Number(inventory.unknownMarkets ?? 0),
      },
      providerCache: {
        ...cacheStats,
        expiredRowsRemaining: cacheExpiredCount,
        latestCacheAgeMs: cacheAgeMs,
      },
      storage: {
        models: {
          fixtureOdds: {
            collection: this.oddsModel.collection.name,
            declaredIndexes: this.oddsModel.schema.indexes().length,
          },
          providerState: {
            collection: this.providerStateModel.collection.name,
            declaredIndexes: this.providerStateModel.schema.indexes().length,
          },
          providerCache: {
            collection: this.providerCacheModel.collection.name,
            declaredIndexes: this.providerCacheModel.schema.indexes().length,
          },
        },
        indexStatus,
      },
      marketCatalog: marketDefinitions,
      checks,
      failures: uniqueFailures,
      warnings: uniqueWarnings,
      readOnly: true,
      cached: false,
    };
    this.overviewCache = { cachedAt: Date.now(), value: overview };
    return overview;
  }

  private percent(numerator: number, denominator: number): number {
    return denominator > 0
      ? Math.round((numerator / denominator) * 10000) / 100
      : 100;
  }

  private async inspectIndexes(): Promise<IndexStatus> {
    const inspect = async (model: Model<any>) => {
      const declared = model.schema
        .indexes()
        .map(([keys, options]) =>
          String(
            (options as { name?: string } | undefined)?.name ??
              Object.entries(keys)
                .map(([key, direction]) => `${key}_${String(direction)}`)
                .join('_'),
          ),
        )
        .filter(Boolean);
      let actual: string[] = [];
      try {
        const collection = (
          model.collection as unknown as {
            collection?: {
              indexes?: () => {
                toArray(): Promise<Array<{ name?: string }>>;
              };
            };
          }
        ).collection;
        if (collection?.indexes) {
          const indexes = await collection.indexes().toArray();
          actual = indexes
            .map((item: { name?: string }) => item.name ?? '')
            .filter(Boolean);
        }
      } catch {
        // Some MongoDB roles do not grant listIndexes; unknown is not treated as absent.
        return {
          declared,
          actual: [],
          missing: [],
          verification: 'UNAVAILABLE',
        };
      }
      return {
        declared,
        actual,
        missing: declared.filter((name) => !actual.includes(name)),
        verification: 'VERIFIED',
      };
    };
    const [fixtureOdds, providerState, providerCache] = await Promise.all([
      inspect(this.oddsModel),
      inspect(this.providerStateModel),
      inspect(this.providerCacheModel),
    ]);
    return { fixtureOdds, providerState, providerCache };
  }
}
