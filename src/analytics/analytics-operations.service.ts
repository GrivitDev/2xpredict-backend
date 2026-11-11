import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { SportsDomainReadService } from '../sports/services/sports-domain-read.service';
import { OddsReadService } from '../odds/services/odds-read.service';
import { SettlementMonitorService } from '../settlement/services/settlement-monitor.service';
import { BetLabMonitorService } from '../bet-lab/services/bet-lab-monitor.service';
import { PredictionQueue } from '../predictions-engine/schemas/prediction-queue.schema';
import { PredictionRun } from '../predictions-engine/schemas/prediction-run.schema';
import { MarketCalibration } from '../predictions-engine/schemas/market-calibration.schema';
import { PREDICTION_ACCESS_CONFIG } from '../prediction-access/config/prediction-access.config';
import { PREDICTION_ENGINE_CONFIG } from '../predictions-engine/config/prediction-engine.config';

type StatusCount = { _id: string; count: number };

type SafeResult<T> = {
  status: 'OK' | 'DEGRADED';
  data: T | null;
  error?: string;
};

const CACHE_TTL_MS = 20_000;
const FIXTURE_LOOKBACK_HOURS = 6;
const FIXTURE_LOOKAHEAD_HOURS = 72;
const FIXTURE_SAMPLE_SIZE = 200;

/**
 * Admin-only cross-module operations snapshot. All reads are observational:
 * this service never refreshes Sports, prices Odds, settles tickets, or changes
 * Prediction Engine state.
 */
@Injectable()
export class AnalyticsOperationsService {
  private cached?: { expiresAt: number; value: Record<string, unknown> };
  private inFlight?: Promise<Record<string, unknown>>;

  constructor(
    private readonly sportsRead: SportsDomainReadService,
    private readonly oddsRead: OddsReadService,
    private readonly settlementMonitor: SettlementMonitorService,
    private readonly betLabMonitor: BetLabMonitorService,
    @InjectModel(PredictionQueue.name)
    private readonly predictionQueueModel: Model<PredictionQueue>,
    @InjectModel(PredictionRun.name)
    private readonly predictionRunModel: Model<PredictionRun>,
    @InjectModel(MarketCalibration.name)
    private readonly calibrationModel: Model<MarketCalibration>,
  ) {}

  async getOverview(): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) {
      return { ...this.cached.value, cached: true };
    }
    if (this.inFlight) return this.inFlight;

    const request = this.buildOverview();
    this.inFlight = request;
    try {
      const value = await request;
      this.cached = { expiresAt: Date.now() + CACHE_TTL_MS, value };
      return value;
    } finally {
      if (this.inFlight === request) this.inFlight = undefined;
    }
  }

  private async buildOverview(): Promise<Record<string, unknown>> {
    const now = new Date();
    const from = new Date(now.getTime() - FIXTURE_LOOKBACK_HOURS * 3_600_000);
    const to = new Date(now.getTime() + FIXTURE_LOOKAHEAD_HOURS * 3_600_000);

    const sportsContext = await this.safe('sports', async () => {
      const [activeCompetitionCount, fixturePage] = await Promise.all([
        this.sportsRead.countCompetitions({ activeOnly: true }),
        this.sportsRead.getFixtures({ from, to, limit: FIXTURE_SAMPLE_SIZE }),
      ]);
      const fixtures = fixturePage.items ?? [];
      const byState: Record<string, number> = {};
      let latestSourceUpdate = 0;
      for (const fixture of fixtures as any[]) {
        const state = String(fixture?.status?.state ?? 'UNKNOWN').toUpperCase();
        byState[state] = (byState[state] ?? 0) + 1;
        const timestamps = [
          fixture?.updatedAt,
          fixture?.source?.collectedAt,
          fixture?.source?.providerUpdatedAt,
        ];
        for (const timestamp of timestamps) {
          const value = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp ?? '').getTime();
          if (Number.isFinite(value)) latestSourceUpdate = Math.max(latestSourceUpdate, value);
        }
      }
      return {
        summary: {
          activeCompetitions: activeCompetitionCount,
          fixtureWindow: {
          from,
          to,
          total: fixturePage.total ?? fixtures.length,
          sampled: fixtures.length,
          sampleLimit: FIXTURE_SAMPLE_SIZE,
            mayBeTruncated: (fixturePage.total ?? fixtures.length) > fixtures.length,
            byState,
          },
          latestFixtureSourceUpdateAt:
            latestSourceUpdate > 0 ? new Date(latestSourceUpdate) : null,
        },
        fixtureIds: fixtures.map((fixture: any) => String(fixture.id)).filter(Boolean),
      };
    });

    const fixtureIds = sportsContext.data?.fixtureIds ?? [];
    const sportsResult: SafeResult<Record<string, unknown>> = {
      status: sportsContext.status,
      data: sportsContext.data?.summary ?? null,
      ...(sportsContext.error ? { error: sportsContext.error } : {}),
    };

    const [odds, predictions, settlement, betLab] = await Promise.all([
      this.safe('odds', async () => {
        const [catalog, inventory, readiness] = await Promise.all([
          Promise.resolve(this.oddsRead.getMarketCatalog()),
          this.oddsRead.getInventorySummary(),
          this.oddsRead.getPredictionReadinessForEvents(fixtureIds),
        ]);
        let readyFixtures = 0;
        let fixturesWithQuotes = 0;
        let readySelections = 0;
        let pricedSelections = 0;
        for (const eventId of fixtureIds) {
          const item = (readiness as Map<string, any>).get(eventId);
          if (!item) continue;
          if (item.ready) readyFixtures += 1;
          const priced = Number(item.pricedSelections ?? 0);
          const ready = Number(item.readySelections ?? 0);
          if (priced > 0) fixturesWithQuotes += 1;
          pricedSelections += Number.isFinite(priced) ? priced : 0;
          readySelections += Number.isFinite(ready) ? ready : 0;
        }
        const pricingEnabled = catalog.filter((market: any) => market.pricingEnabled !== false).length;
        return {
          catalogue: {
            totalMarketGroups: catalog.length,
            pricingEnabledMarketGroups: pricingEnabled,
            notCurrentlyPricingEnabled: catalog.length - pricingEnabled,
          },
          inventory,
          sampledFixtureReadiness: {
            sampleSize: fixtureIds.length,
            readyFixtures,
            fixturesWithQuotes,
            readySelections,
            pricedSelections,
            selectionReadinessRate:
              pricedSelections > 0
                ? Number((readySelections / pricedSelections).toFixed(4))
                : 0,
          },
        };
      }),
      this.safe('prediction_engine', async () => {
        const [
          queueRows,
          runRows,
          calibrationRows,
          activeCalibrators,
          latestRun,
        ] = await Promise.all([
          this.predictionQueueModel.aggregate<StatusCount>([
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ]).exec(),
          this.predictionRunModel.aggregate<StatusCount>([
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ]).exec(),
          this.calibrationModel.countDocuments({}).exec(),
          this.calibrationModel.countDocuments({ active: true }).exec(),
          this.predictionRunModel.findOne({}).sort({ startedAt: -1 }).select({ startedAt: 1, modelVersion: 1, status: 1 }).lean().exec(),
        ]);
        const queueByStatus = Object.fromEntries(queueRows.map((row) => [String(row._id), row.count]));
        const runsByStatus = Object.fromEntries(runRows.map((row) => [String(row._id), row.count]));
        return {
          queue: {
            total: queueRows.reduce((sum, row) => sum + row.count, 0),
            byStatus: queueByStatus,
            waitingForOdds: queueByStatus.WAITING_FOR_ODDS ?? 0,
            failed: queueByStatus.FAILED ?? 0,
          },
          runs: {
            total: runRows.reduce((sum, row) => sum + row.count, 0),
            byStatus: runsByStatus,
          },
          calibration: {
            marketCalibrators: calibrationRows,
            activeMarketCalibrators: activeCalibrators,
            configuredMinimumSamples:
              PREDICTION_ENGINE_CONFIG.calibration.minimumSettledSamples,
            latestRun: latestRun ?? null,
          },
          accessMarketTiers: Object.fromEntries(
            Object.entries(
              PREDICTION_ACCESS_CONFIG.marketVisibility as Record<
                string,
                { limit: number | null; marketKeys: readonly string[] }
              >,
            ).map(([plan, tier]) => [
              plan,
              {
                marketLimit: tier.limit,
                visibleMarketTypeCount: tier.marketKeys.length,
              },
            ]),
          ),
        };
      }),
      this.safe('settlement', () => this.settlementMonitor.getOverview()),
      this.safe('bet_lab', () => this.betLabMonitor.getOverview()),
    ]);

    const sections = [sportsResult, odds, predictions, settlement, betLab];
    const overallStatus = sections.some((section) => section.status === 'DEGRADED')
      ? 'DEGRADED'
      : 'OK';

    return {
      generatedAt: new Date(),
      status: overallStatus,
      cacheTtlMs: CACHE_TTL_MS,
      readOnly: true,
      sports: sportsResult,
      odds,
      predictions,
      settlement,
      betLab,
      cached: false,
    };
  }

  private async safe<T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<SafeResult<T>> {
    try {
      return { status: 'OK', data: await operation() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 'DEGRADED',
        data: null,
        error: `${name}: ${message}`.slice(0, 500),
      };
    }
  }
}
