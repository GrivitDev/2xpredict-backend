import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  ModuleHealthStatus,
  SystemMonitorService,
} from '../../system-monitor/system-monitor.service';
import { SportsDomainReadService } from '../../sports/services/sports-domain-read.service';
import { FOOTBALL_MARKET_CATALOG } from '../catalog/football-market-catalog';
import { ODDS_CONFIG } from '../config/odds.config';
import { FixtureOdds } from '../schemas/fixture-odds.schema';
import { OddsService } from './odds.service';
import { OddsWorkerService } from './odds-worker.service';

const MINUTE = 60_000;
const STARTUP_GRACE_MS = 2 * MINUTE;
const PRICING_QUEUE_WARNING_AGE_MS = 5 * MINUTE;
const PRICING_QUEUE_CRITICAL_AGE_MS = 15 * MINUTE;
const MAX_FIXTURE_SAMPLE = 80;
const ACTIVE_EXPIRY_FILTER = (now: Date) => ({
  $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }],
});

interface OddsMonitorAlert {
  code: string;
  severity: 'WARNING' | 'CRITICAL';
  message: string;
  count?: number;
  details?: Record<string, unknown>;
}

interface CountSummary {
  totalSelections: number;
  freshProviderSelections: number;
  staleProviderSelections: number;
  freshEstimatedSelections: number;
  staleEstimatedSelections: number;
  currentModelVersionSelections: number;
  outdatedModelVersionSelections: number;
  missingSourceHashSelections: number;
  missingFixtureSourceRevisionSelections: number;
  invalidDecimalOddsSelections: number;
  averageDataQuality: number | null;
}

/**
 * Read-only operational monitor for Sports-backed Odds calculation and pricing.
 * It does not collect provider data, alter quotes, or enqueue pricing work.
 */
@Injectable()
export class OddsMonitorService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OddsMonitorService.name);
  private readonly monitorIntervalMs = this.readPositiveInteger(
    process.env.ODDS_MONITOR_INTERVAL_MS,
    60_000,
  );
  private readonly cacheTtlMs = 15_000;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private startedAt?: Date;
  private lastCheckAt?: Date;
  private lastSuccessfulCheckAt?: Date;
  private lastCheckError?: string;
  private cachedOverview?: {
    at: number;
    value: Record<string, unknown>;
  };
  private probePromise?: Promise<Record<string, unknown>>;

  constructor(
    @InjectModel(FixtureOdds.name)
    private readonly oddsModel: Model<FixtureOdds>,
    private readonly oddsService: OddsService,
    private readonly worker: OddsWorkerService,
    private readonly sportsRead: SportsDomainReadService,
    private readonly systemMonitor: SystemMonitorService,
  ) {}

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.startedAt = new Date();
    this.systemMonitor.registerModule('odds', 'deep', false);
    this.systemMonitor.reportMonitorSnapshot('odds', {
      status: 'UNKNOWN',
      checkedAt: this.startedAt,
    });
    this.schedule(10_000);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Returns a cached operational snapshot unless refresh=true is requested. */
  async getOverview(forceRefresh = false): Promise<Record<string, unknown>> {
    if (
      !forceRefresh &&
      this.cachedOverview &&
      Date.now() - this.cachedOverview.at < this.cacheTtlMs
    ) {
      return { ...this.cachedOverview.value, cached: true };
    }

    if (this.probePromise) {
      if (this.cachedOverview) {
        return {
          ...this.cachedOverview.value,
          cached: true,
          refreshInProgress: true,
        };
      }
      const current = await this.probePromise;
      return { ...current, cached: true };
    }

    return this.refreshOverview();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runScheduledCheck();
    }, Math.max(1_000, delayMs));
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private async runScheduledCheck(): Promise<void> {
    try {
      await this.refreshOverview();
    } catch (error) {
      this.logger.error(
        `Odds health probe failed: ${this.errorMessage(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.schedule(this.monitorIntervalMs);
    }
  }

  private async refreshOverview(): Promise<Record<string, unknown>> {
    if (this.probePromise) return this.probePromise;

    const pending = this.collectAndReportOverview();
    this.probePromise = pending;
    try {
      return await pending;
    } finally {
      if (this.probePromise === pending) this.probePromise = undefined;
    }
  }

  private async collectAndReportOverview(): Promise<Record<string, unknown>> {
    const checkedAt = new Date();
    this.lastCheckAt = checkedAt;

    try {
      const overview = await this.collectOverview(checkedAt);
      this.cachedOverview = { at: Date.now(), value: overview };
      this.lastSuccessfulCheckAt = checkedAt;
      this.lastCheckError = undefined;
      this.publishHealth(overview, checkedAt);
      return { ...overview, cached: false };
    } catch (error) {
      const message = this.errorMessage(error).slice(0, 500);
      this.lastCheckError = message;

      const workerStatus = this.worker.getMonitorStatus();
      this.systemMonitor.reportMonitorSnapshot('odds', {
        status: 'FAILED',
        checkedAt,
        checks: [{
          name: 'health-probe',
          status: 'FAILED',
          error: message,
        }],
        details: {
          lastSuccessfulCheckAt:
            this.lastSuccessfulCheckAt?.toISOString() ?? 'NEVER',
          workerInitialized: Boolean(workerStatus.initialized),
          workerRunning: Boolean(workerStatus.running),
        },
      });

      const failedOverview = {
        generatedAt: checkedAt.toISOString(),
        status: 'FAILED',
        message: `Odds operational health probe failed: ${message}`,
        monitor: this.monitorMetadata(),
        worker: this.worker.getMonitorStatus(),
        alerts: [
          {
            code: 'ODDS_HEALTH_PROBE_FAILED',
            severity: 'CRITICAL',
            message,
          },
        ],
        cached: false,
      };
      this.cachedOverview = { at: Date.now(), value: failedOverview };
      return failedOverview;
    }
  }

  private async collectOverview(
    checkedAt: Date,
  ): Promise<Record<string, unknown>> {
    const now = checkedAt;
    const worker = this.worker.getMonitorStatus();
    const [inventoryAndQuality, indexResult, sportsCoverage, pricingQueue] =
      await Promise.all([
        this.getInventoryAndQuality(now),
        this.readIndexes(),
        this.getSportsCoverage(now),
        this.worker.getQueueMonitorStatus(),
      ]);
    const inventory = inventoryAndQuality.inventory;
    const quality = inventoryAndQuality.quality;

    const indexNames = new Set(indexResult.indexes.map((item) => item.name));
    const expectedIndexes = [
      {
        name: 'uniq_fixture_market_selection_line',
        critical: true,
        description: 'Prevents duplicate canonical selection prices.',
      },
      {
        name: 'ttl_fixture_odds_expiry',
        critical: false,
        description: 'Expires Grivit prices at the Sports fixture season-relative retention deadline.',
      },
      {
        name: 'fixture_odds_readiness_lookup',
        critical: false,
        description: 'Supports event-level prediction-readiness lookups.',
      },
      {
        name: 'fixture_odds_market_lookup',
        critical: false,
        description: 'Supports fixture and market price retrieval.',
      },
    ];
    const indexChecks = expectedIndexes.map((expected) => {
      const present = indexNames.has(expected.name);
      return {
        name: expected.name,
        present,
        critical: expected.critical,
        description: expected.description,
        status: present ? 'OK' : expected.critical ? 'FAIL' : 'WARN',
      };
    });

    const dbReady = this.oddsModel.db.readyState === 1;
    const alerts: OddsMonitorAlert[] = [];
    const startupAgeMs = this.startedAt
      ? Math.max(0, now.getTime() - this.startedAt.getTime())
      : 0;
    const lastCycleCompletedAt = this.toDate(worker.lastCycleCompletedAt);
    const lastCycleStartedAt = this.toDate(worker.lastCycleStartedAt);
    const lastSuccessfulCycleAt = this.toDate(worker.lastSuccessfulCycleAt);
    const lastRetentionCompletedAt = this.toDate(
      worker.lastRetentionCompletedAt,
    );
    const lastCycleAgeMs = lastCycleCompletedAt
      ? Math.max(0, now.getTime() - lastCycleCompletedAt.getTime())
      : undefined;
    const lastSuccessfulCycleAgeMs = lastSuccessfulCycleAt
      ? Math.max(0, now.getTime() - lastSuccessfulCycleAt.getTime())
      : undefined;
    const activeBatchAgeMs = worker.busy && lastCycleStartedAt
      ? Math.max(0, now.getTime() - lastCycleStartedAt.getTime())
      : 0;
    const expectedCycleGraceMs = Math.max(
      3 * ODDS_CONFIG.workerIntervalMs,
      15 * MINUTE,
    );
    const expectedRetentionGraceMs = Math.max(
      2 * ODDS_CONFIG.cleanupIntervalMs,
      90 * MINUTE,
    );

    if (!dbReady) {
      alerts.push({
        code: 'ODDS_DATABASE_DISCONNECTED',
        severity: 'CRITICAL',
        message: 'Odds cannot read or persist prices because MongoDB is not connected.',
        details: { readyState: this.oddsModel.db.readyState },
      });
    }

    if (indexResult.error) {
      alerts.push({
        code: 'ODDS_INDEX_INSPECTION_FAILED',
        severity: 'WARNING',
        message: 'The monitor could not verify Odds collection indexes.',
        details: { error: indexResult.error },
      });
    } else {
      for (const check of indexChecks) {
        if (check.present) continue;
        alerts.push({
          code: `ODDS_INDEX_MISSING_${check.name.toUpperCase()}`,
          severity: check.critical ? 'CRITICAL' : 'WARNING',
          message: `Expected Odds index ${check.name} is missing.`,
          details: { index: check.name, critical: check.critical },
        });
      }
    }

    if (ODDS_CONFIG.enabled && startupAgeMs > STARTUP_GRACE_MS) {
      if (!worker.initialized) {
        alerts.push({
          code: 'ODDS_WORKER_NOT_INITIALIZED',
          severity: 'CRITICAL',
          message: 'Grivit pricing worker has not initialized.',
        });
      } else if (!worker.running && !worker.stopping) {
        alerts.push({
          code: 'ODDS_WORKER_NOT_RUNNING',
          severity: 'CRITICAL',
          message: 'Grivit pricing worker is not running although pricing is enabled.',
        });
      }
    }

    if (
      ODDS_CONFIG.enabled &&
      startupAgeMs > expectedCycleGraceMs &&
      !lastCycleCompletedAt
    ) {
      alerts.push({
        code: 'ODDS_WORKER_NO_COMPLETED_BATCH',
        severity: 'CRITICAL',
        message: 'Grivit has not completed its first pricing batch within the startup window.',
        details: { startupAgeMs, expectedCycleGraceMs },
      });
    } else if (
      ODDS_CONFIG.enabled &&
      !worker.busy &&
      lastCycleAgeMs !== undefined &&
      lastCycleAgeMs > expectedCycleGraceMs
    ) {
      alerts.push({
        code: 'ODDS_WORKER_CYCLE_STALE',
        severity: 'WARNING',
        message: 'The Odds worker has not completed a pricing batch within the expected interval.',
        details: {
          lastCycleCompletedAt: lastCycleCompletedAt?.toISOString(),
          ageMs: lastCycleAgeMs,
          expectedCycleGraceMs,
        },
      });
    }

    if (
      ODDS_CONFIG.enabled &&
      worker.busy &&
      activeBatchAgeMs > expectedCycleGraceMs
    ) {
      alerts.push({
        code: 'ODDS_WORKER_BATCH_LONG_RUNNING',
        severity: 'WARNING',
        message: 'The current Odds pricing batch has remained active longer than the expected batch interval.',
        details: { activeBatchAgeMs, expectedCycleGraceMs },
      });
    }

    if (
      ODDS_CONFIG.enabled &&
      startupAgeMs > expectedCycleGraceMs &&
      (!lastSuccessfulCycleAt ||
        (lastSuccessfulCycleAgeMs !== undefined &&
          lastSuccessfulCycleAgeMs > expectedCycleGraceMs))
    ) {
      alerts.push({
        code: 'ODDS_NO_RECENT_SUCCESSFUL_CYCLE',
        severity: 'WARNING',
        message: 'Grivit has not completed a fully successful pricing batch within the expected interval.',
        details: {
          lastSuccessfulCycleAt: lastSuccessfulCycleAt?.toISOString(),
          ageMs: lastSuccessfulCycleAgeMs ?? null,
          expectedCycleGraceMs,
        },
      });
    }

    if (Number(worker.consecutiveCycleFailures ?? 0) >= 2) {
      alerts.push({
        code: 'ODDS_WORKER_CONSECUTIVE_FAILURES',
        severity: 'CRITICAL',
        message: 'Odds pricing cycles have failed consecutively.',
        count: Number(worker.consecutiveCycleFailures),
        details: { lastCycleError: worker.lastCycleError },
      });
    } else if (Number(worker.consecutiveCycleFailures ?? 0) === 1) {
      alerts.push({
        code: 'ODDS_WORKER_CYCLE_FAILURE',
        severity: 'WARNING',
        message: 'The latest Odds pricing cycle failed.',
        details: { lastCycleError: worker.lastCycleError },
      });
    }

    if (
      Number(worker.consecutivePartialFailureCycles ?? 0) >= 2 ||
      Number(worker.lastFailedCount ?? 0) > 0
    ) {
      alerts.push({
        code: 'ODDS_FIXTURE_PRICING_FAILURES',
        severity: Number(worker.consecutivePartialFailureCycles ?? 0) >= 2
          ? 'CRITICAL'
          : 'WARNING',
        message: 'One or more Grivit fixture calculations failed and will be revisited by the inventory sweep or source-change queue.',
        count: Number(worker.lastFailedCount ?? 0),
        details: {
          consecutivePartialFailureCycles: Number(
            worker.consecutivePartialFailureCycles ?? 0,
          ),
          lastCycleError: worker.lastCycleError,
        },
      });
    }

    if (
      Number(worker.retentionConsecutiveFailures ?? 0) >= 2 ||
      (worker.lastRetentionError &&
        Number(worker.retentionConsecutiveFailures ?? 0) > 0)
    ) {
      alerts.push({
        code: 'ODDS_RETENTION_FAILURE',
        severity: Number(worker.retentionConsecutiveFailures ?? 0) >= 2
          ? 'CRITICAL'
          : 'WARNING',
        message: 'Expired Grivit fixture-price cleanup has failed.',
        details: {
          consecutiveFailures: Number(worker.retentionConsecutiveFailures ?? 0),
          lastError: worker.lastRetentionError,
        },
      });
    } else if (
      ODDS_CONFIG.enabled &&
      startupAgeMs > expectedRetentionGraceMs &&
      !lastRetentionCompletedAt
    ) {
      alerts.push({
        code: 'ODDS_RETENTION_NOT_RUN',
        severity: 'WARNING',
        message: 'The season-relative expired-price cleanup worker has not completed its first pass.',
      });
    } else if (
      ODDS_CONFIG.enabled &&
      lastRetentionCompletedAt &&
      now.getTime() - lastRetentionCompletedAt.getTime() > expectedRetentionGraceMs
    ) {
      alerts.push({
        code: 'ODDS_RETENTION_STALE',
        severity: 'WARNING',
        message: 'The expired-price cleanup pass is overdue.',
        details: {
          lastCompletedAt: lastRetentionCompletedAt.toISOString(),
          ageMs: now.getTime() - lastRetentionCompletedAt.getTime(),
          expectedRetentionGraceMs,
        },
      });
    }

    if (sportsCoverage.error) {
      alerts.push({
        code: 'ODDS_SPORTS_READ_UNAVAILABLE',
        severity: 'CRITICAL',
        message: 'Odds could not read the normalized Sports fixture feed.',
        details: { error: sportsCoverage.error },
      });
    } else if (
      startupAgeMs > expectedCycleGraceMs &&
      Boolean(lastSuccessfulCycleAt) &&
      sportsCoverage.sampleFixtureCount >= 10 &&
      sportsCoverage.predictionReadyCoveragePercent !== null &&
      sportsCoverage.predictionReadyCoveragePercent < 20
    ) {
      alerts.push({
        code: 'ODDS_UPCOMING_READINESS_CRITICALLY_LOW',
        severity: 'CRITICAL',
        message: 'Fewer than one in five sampled upcoming fixtures has any prediction-ready Odds selection.',
        details: sportsCoverage,
      });
    } else if (
      startupAgeMs > expectedCycleGraceMs &&
      Boolean(lastSuccessfulCycleAt) &&
      sportsCoverage.sampleFixtureCount >= 10 &&
      sportsCoverage.predictionReadyCoveragePercent !== null &&
      sportsCoverage.predictionReadyCoveragePercent < 50
    ) {
      alerts.push({
        code: 'ODDS_UPCOMING_READINESS_LOW',
        severity: 'WARNING',
        message: 'Prediction-ready Odds coverage is below half of the sampled upcoming fixtures.',
        details: sportsCoverage,
      });
    }

    if (quality.invalidDecimalOddsSelections > 0) {
      alerts.push({
        code: 'ODDS_INVALID_DECIMAL_PRICES',
        severity: 'CRITICAL',
        message: 'The active Odds inventory contains decimal prices outside the configured valid range.',
        count: quality.invalidDecimalOddsSelections,
      });
    }
    if (quality.missingSourceHashSelections > 0) {
      alerts.push({
        code: 'ODDS_SOURCE_FINGERPRINTS_MISSING',
        severity: 'WARNING',
        message: 'Some active Grivit selections do not contain a source-data fingerprint.',
        count: quality.missingSourceHashSelections,
      });
    }

    if (quality.missingFixtureSourceRevisionSelections > 0) {
      alerts.push({
        code: 'ODDS_FIXTURE_SOURCE_REVISIONS_MISSING',
        severity: 'WARNING',
        message: 'Some active Grivit prices predate the Sports fixture revision contract and are stale until repriced.',
        count: quality.missingFixtureSourceRevisionSelections,
      });
    }

    if (Number(sportsCoverage.staleSourceRevisionSelections ?? 0) > 0) {
      alerts.push({
        code: 'ODDS_STALE_SPORTS_REVISION_PRICES',
        severity: 'WARNING',
        message: 'Upcoming fixture prices were found with a Sports source revision older than the current fixture revision.',
        count: Number(sportsCoverage.staleSourceRevisionSelections),
      });
    }

    const queueAvailable = pricingQueue.available === true;
    if (!queueAvailable) {
      alerts.push({
        code: 'ODDS_PRICING_QUEUE_MONITOR_UNAVAILABLE',
        severity: 'WARNING',
        message: 'The monitor could not inspect the durable Odds source-change pricing queue.',
        details: { error: pricingQueue.error ?? null },
      });
    } else {
      const duePendingCount = Number(pricingQueue.duePendingCount ?? 0);
      const oldestDuePendingAt = this.toDate(pricingQueue.oldestDuePendingAt);
      const oldestDuePendingAgeMs = oldestDuePendingAt
        ? Math.max(0, now.getTime() - oldestDuePendingAt.getTime())
        : 0;
      const staleProcessingCount = Number(pricingQueue.staleProcessingCount ?? 0);
      const quarantinedCount = Number(pricingQueue.quarantinedCount ?? 0);

      if (staleProcessingCount > 0) {
        alerts.push({
          code: 'ODDS_PRICING_QUEUE_EXPIRED_LEASES',
          severity: 'WARNING',
          message: 'One or more Odds pricing jobs remain PROCESSING after their queue lease expired.',
          count: staleProcessingCount,
        });
      }
      const failedQueueCount = Number(pricingQueue.failedCount ?? 0);
      if (quarantinedCount > 0) {
        alerts.push({
          code: 'ODDS_PRICING_QUEUE_QUARANTINED_JOBS',
          severity: 'WARNING',
          message: 'One or more Odds source-change pricing jobs have been quarantined and require inspection.',
          count: quarantinedCount,
        });
      }
      if (failedQueueCount > 0) {
        alerts.push({
          code: 'ODDS_PRICING_QUEUE_FAILED_JOBS',
          severity: 'WARNING',
          message: 'One or more Odds source-change pricing jobs remain in FAILED state.',
          count: failedQueueCount,
        });
      }
      if (duePendingCount > 0 && oldestDuePendingAgeMs >= PRICING_QUEUE_CRITICAL_AGE_MS) {
        alerts.push({
          code: 'ODDS_PRICING_QUEUE_BACKLOG_CRITICAL',
          severity: 'CRITICAL',
          message: 'Due Odds source-change pricing jobs have remained pending for at least 15 minutes.',
          count: duePendingCount,
          details: { oldestDuePendingAgeMs },
        });
      } else if (duePendingCount > 0 && oldestDuePendingAgeMs >= PRICING_QUEUE_WARNING_AGE_MS) {
        alerts.push({
          code: 'ODDS_PRICING_QUEUE_BACKLOG',
          severity: 'WARNING',
          message: 'Due Odds source-change pricing jobs are accumulating.',
          count: duePendingCount,
          details: { oldestDuePendingAgeMs },
        });
      }
    }

    const inventorySweep = (worker.inventorySweep ?? {}) as Record<string, any>;
    if (Number(inventorySweep.lastFailedFixtures ?? 0) > 0) {
      alerts.push({
        code: 'ODDS_INVENTORY_SWEEP_WITH_FAILURES',
        severity: Number(inventorySweep.consecutivePartialFailureSweeps ?? 0) >= 2
          ? 'CRITICAL'
          : 'WARNING',
        message: 'The most recently completed full Odds inventory sweep contained fixture pricing failures.',
        count: Number(inventorySweep.lastFailedFixtures ?? 0),
        details: {
          lastSweepCompletedAt: inventorySweep.lastCompletedAt ?? null,
          lastSweepFixtures: Number(inventorySweep.lastFixtures ?? 0),
          lastSweepPages: Number(inventorySweep.lastPages ?? 0),
        },
      });
    }

    const providerTotal =
      quality.staleProviderSelections + quality.freshProviderSelections;
    const staleProviderPercent = providerTotal
      ? (quality.staleProviderSelections / providerTotal) * 100
      : null;

    const enabledMarketIds = new Set(
      FOOTBALL_MARKET_CATALOG.filter((market) => market.pricingEnabled !== false)
        .map((market) => market.id),
    );
    const inventoryMarketIds = new Set(
      ((inventory.marketInventory as Array<Record<string, unknown>>) ?? [])
        .map((item) => String(item._id ?? ''))
        .filter((id) => enabledMarketIds.has(id)),
    );
    const marketCoveragePercent = enabledMarketIds.size
      ? Number(((inventoryMarketIds.size / enabledMarketIds.size) * 100).toFixed(1))
      : 100;

    const criticalAlerts = alerts.filter(
      (alert) => alert.severity === 'CRITICAL',
    ).length;
    const warningAlerts = alerts.filter(
      (alert) => alert.severity === 'WARNING',
    ).length;
    const inventoryTotal = Number(inventory.totalSelections ?? 0);
    const healthStatus: ModuleHealthStatus = !ODDS_CONFIG.enabled
      ? 'UNKNOWN'
      : criticalAlerts > 0
        ? 'FAILED'
        : warningAlerts > 0
          ? 'DEGRADED'
          : inventoryTotal === 0 && sportsCoverage.sampleFixtureCount === 0
            ? 'UNKNOWN'
            : 'HEALTHY';
    const message = !ODDS_CONFIG.enabled
      ? 'Odds pricing is disabled by configuration.'
      : healthStatus === 'HEALTHY'
        ? 'Grivit pricing worker, Sports dependency, active prices and readiness checks are healthy.'
        : healthStatus === 'DEGRADED'
          ? `Grivit pricing is operational with ${warningAlerts} warning(s) requiring attention.`
          : healthStatus === 'FAILED'
            ? `Grivit pricing has ${criticalAlerts} critical operational issue(s).`
            : 'Odds monitoring is active; fixture data and pricing inventory are not yet available.';

    const checks = [
      {
        name: 'mongodb_connection',
        status: dbReady ? 'OK' : 'FAIL',
        value: this.oddsModel.db.readyState,
      },
      {
        name: 'sports_domain_read_source',
        status: sportsCoverage.error ? 'FAIL' : 'OK',
        message: 'Grivit calculates its own prices from normalized Sports records.',
        sampleFixtureCount: sportsCoverage.sampleFixtureCount,
      },
      {
        name: 'external_api_calls',
        status: 'OK',
        value: 0,
        message: 'External bookmaker references are optional and never gate Grivit pricing.',
      },
      ...indexChecks,
      {
        name: 'pricing_worker',
        status: !ODDS_CONFIG.enabled
          ? 'UNKNOWN'
          : worker.running && !worker.stopping
            ? 'OK'
            : startupAgeMs <= STARTUP_GRACE_MS
              ? 'UNKNOWN'
              : 'FAIL',
        value: {
          initialized: worker.initialized,
          running: worker.running,
          busy: worker.busy,
        },
      },
      {
        name: 'pricing_source_change_queue',
        status: !pricingQueue.available
          ? 'WARN'
          : Number(pricingQueue.staleProcessingCount ?? 0) > 0 ||
              Number(pricingQueue.failedCount ?? 0) > 0 ||
              Number(pricingQueue.quarantinedCount ?? 0) > 0 ||
              Number(pricingQueue.duePendingCount ?? 0) > 0
            ? 'WARN'
            : 'OK',
        value: pricingQueue,
      },
      {
        name: 'inventory_sweep_progress',
        status: inventorySweep.inProgress ? 'OK' : 'UNKNOWN',
        value: inventorySweep,
      },
      {
        name: 'prediction_ready_coverage',
        status: sportsCoverage.predictionReadyCoveragePercent === null
          ? 'UNKNOWN'
          : sportsCoverage.predictionReadyCoveragePercent >= 50
            ? 'OK'
            : 'WARN',
        value: sportsCoverage.predictionReadyCoveragePercent,
        sampleFixtureCount: sportsCoverage.sampleFixtureCount,
      },
    ];

    const overview: Record<string, unknown> = {
      generatedAt: now.toISOString(),
      status: healthStatus,
      message,
      monitor: this.monitorMetadata(),
      checks,
      alerts,
      worker,
      inventorySweep,
      pricingQueue,
      inventory: {
        ...inventory,
        freshnessAndIntegrity: {
          ...quality,
          estimatedRevisionMetricScope: 'INVENTORY_WIDE_REVISION_STAMP_PRESENCE; EXACT_CURRENT_REVISION_IS_CHECKED_FOR_UPCOMING_FIXTURE_SAMPLE',
        },
        providerQuoteFreshnessPercent: providerTotal
          ? Number((100 - (staleProviderPercent ?? 0)).toFixed(1))
          : null,
      },
      sportsDependency: sportsCoverage,
      configuration: {
        enabled: ODDS_CONFIG.enabled,
        pricingScope: 'ALL_RETAINED_FIXTURES',
        predictionCoverageWindowHours: 72,
        workerIntervalMs: ODDS_CONFIG.workerIntervalMs,
        workerBatchSize: ODDS_CONFIG.workerBatchSize,
        workerConcurrency: ODDS_CONFIG.workerConcurrency,
        maximumQuoteAgeHours: ODDS_CONFIG.maximumQuoteAgeHours,
        seasonRetentionGraceMonths: ODDS_CONFIG.seasonRetentionGraceMonths,
        cleanupIntervalMs: ODDS_CONFIG.cleanupIntervalMs,
        minimumHistoricalSampleSize: ODDS_CONFIG.minimumHistoricalSampleSize,
        minimumPredictionDataQuality: ODDS_CONFIG.minimumPredictionDataQuality,
        grivitOverroundPercent: ODDS_CONFIG.grivitOverroundPercent,
        minimumEventTimelineSampleSize:
          ODDS_CONFIG.minimumEventTimelineSampleSize,
        minimumEventTimelineCoverage: ODDS_CONFIG.minimumEventTimelineCoverage,
        modelVersion: ODDS_CONFIG.modelVersion,
      },
      catalogue: {
        totalMarkets: FOOTBALL_MARKET_CATALOG.length,
        pricingEnabled: enabledMarketIds.size,
        awaitingSportsData: FOOTBALL_MARKET_CATALOG.filter(
          (item) => item.pricingEnabled === false,
        ).map((item) => ({
          id: item.id,
          requiredData: item.requiredData,
          notes: item.notes,
        })),
        activePricedMarkets: inventoryMarketIds.size,
        activePricedMarketCoveragePercent: marketCoveragePercent,
      },
      indexes: {
        names: [...indexNames],
        checks: indexChecks,
        inspectionError: indexResult.error ?? null,
      },
      externalApiCalls: 0,
      dataSource: 'SPORTS_MODULE',
    };

    return overview;
  }

  /**
   * One bounded-response aggregation supplies inventory and quality metrics.
   * The collection is scanned once per monitor interval instead of issuing
   * separate count/group queries for each metric.
   */
  private async getInventoryAndQuality(
    now: Date,
  ): Promise<{
    inventory: Record<string, unknown>;
    quality: CountSummary;
  }> {
    const cutoff = new Date(
      now.getTime() - ODDS_CONFIG.maximumQuoteAgeHours * 3_600_000,
    );
    const futureLimit = new Date(
      now.getTime() + ODDS_CONFIG.futureTimestampToleranceMs,
    );

    const [result] = await this.oddsModel
      .aggregate([
        { $match: ACTIVE_EXPIRY_FILTER(now) },
        {
          $facet: {
            summary: [
              {
                $group: {
                  _id: null,
                  totalSelections: { $sum: 1 },
                  predictionReadySelections: {
                    $sum: { $cond: ['$predictionReady', 1, 0] },
                  },
                  providerSelections: {
                    $sum: {
                      $cond: [{ $eq: ['$priceType', 'PROVIDER'] }, 1, 0],
                    },
                  },
                  estimatedSelections: {
                    $sum: {
                      $cond: [{ $eq: ['$priceType', 'ESTIMATED'] }, 1, 0],
                    },
                  },
                  freshProviderSelections: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ['$priceType', 'PROVIDER'] },
                            { $gte: ['$providerUpdatedAt', cutoff] },
                            { $lte: ['$providerUpdatedAt', futureLimit] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  freshEstimatedSelections: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ['$priceType', 'ESTIMATED'] },
                            { $eq: ['$bookmaker', 'Grivit'] },
                            { $eq: ['$pricingSource', 'GRIVIT_MODEL'] },
                            { $eq: ['$calculationVersion', ODDS_CONFIG.modelVersion] },
                            { $ne: ['$sourceDataHash', null] },
                            { $ne: ['$sourceDataHash', ''] },
                            { $ne: ['$fixtureSourceRevision', null] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  missingFixtureSourceRevisionSelections: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ['$priceType', 'ESTIMATED'] },
                            { $eq: ['$bookmaker', 'Grivit'] },
                            { $eq: ['$pricingSource', 'GRIVIT_MODEL'] },
                            { $eq: ['$fixtureSourceRevision', null] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  currentModelVersionSelections: {
                    $sum: {
                      $cond: [
                        {
                          $eq: [
                            '$calculationVersion',
                            ODDS_CONFIG.modelVersion,
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  missingSourceHashSelections: {
                    $sum: {
                      $cond: [
                        {
                          $or: [
                            { $eq: ['$sourceDataHash', null] },
                            { $eq: ['$sourceDataHash', ''] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  invalidDecimalOddsSelections: {
                    $sum: {
                      $cond: [
                        {
                          $or: [
                            { $lt: ['$decimalOdds', 1.01] },
                            {
                              $gt: [
                                '$decimalOdds',
                                ODDS_CONFIG.maximumDecimalOdds,
                              ],
                            },
                            { $eq: ['$decimalOdds', null] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  averageDataQuality: { $avg: '$dataQuality' },
                  latestUpdatedAt: { $max: '$updatedAt' },
                },
              },
            ],
            marketInventory: [
              {
                $group: {
                  _id: '$marketId',
                  selections: { $sum: 1 },
                  predictionReady: {
                    $sum: { $cond: ['$predictionReady', 1, 0] },
                  },
                },
              },
              { $sort: { selections: -1 } },
            ],
          },
        },
      ])
      .exec();

    const row = result?.summary?.[0] ?? {};
    const totalSelections = Number(row.totalSelections ?? 0);
    const providerSelections = Number(row.providerSelections ?? 0);
    const estimatedSelections = Number(row.estimatedSelections ?? 0);
    const freshProviderSelections = Number(
      row.freshProviderSelections ?? 0,
    );
    const freshEstimatedSelections = Number(
      row.freshEstimatedSelections ?? 0,
    );
    const currentModelVersionSelections = Number(
      row.currentModelVersionSelections ?? 0,
    );

    const quality: CountSummary = {
      totalSelections,
      freshProviderSelections,
      staleProviderSelections: Math.max(
        0,
        providerSelections - freshProviderSelections,
      ),
      freshEstimatedSelections,
      staleEstimatedSelections: Math.max(
        0,
        estimatedSelections - freshEstimatedSelections,
      ),
      currentModelVersionSelections,
      outdatedModelVersionSelections: Math.max(
        0,
        totalSelections - currentModelVersionSelections,
      ),
      missingSourceHashSelections: Number(
        row.missingSourceHashSelections ?? 0,
      ),
      missingFixtureSourceRevisionSelections: Number(
        row.missingFixtureSourceRevisionSelections ?? 0,
      ),
      invalidDecimalOddsSelections: Number(
        row.invalidDecimalOddsSelections ?? 0,
      ),
      averageDataQuality:
        typeof row.averageDataQuality === 'number'
          ? Number(row.averageDataQuality.toFixed(4))
          : null,
    };

    const inventory: Record<string, unknown> = {
      generatedAt: now,
      totalSelections,
      predictionReadySelections: Number(
        row.predictionReadySelections ?? 0,
      ),
      providerSelections,
      estimatedSelections,
      marketInventory: result?.marketInventory ?? [],
      latestUpdatedAt: row.latestUpdatedAt ?? null,
    };

    return { inventory, quality };
  }

  private async getSportsCoverage(now: Date): Promise<Record<string, any>> {
    const to = new Date(
      now.getTime() + ODDS_CONFIG.predictionCoverageWindowHours * 3_600_000,
    );

    try {
      const page = await this.sportsRead.getFixtures({
        from: now,
        to,
        limit: MAX_FIXTURE_SAMPLE,
      });
      const fixtures = (page.items ?? []).filter((fixture: any) => {
        const state = String(fixture.status?.state ?? '').toUpperCase();
        return (
          !fixture.status?.isFinal &&
          !['COMPLETED', 'POSTPONED', 'CANCELLED', 'ABANDONED'].includes(state)
        );
      });
      const ids = fixtures.map((fixture) => fixture.id).filter(Boolean);
      const readiness = await this.oddsService.getPredictionReadinessForEvents(
        ids,
      );

      let fixturesWithPrices = 0;
      let predictionReadyFixtures = 0;
      let pricedButNotReadyFixtures = 0;
      let fixturesWithoutPrices = 0;
      let predictionReadySelections = 0;
      let providerSelections = 0;
      let estimatedSelections = 0;
      let staleSourceRevisionSelections = 0;

      for (const id of ids) {
        const row = readiness.get(id);
        const expectedSelections = Number(row?.expectedSelections ?? 0);
        const readySelections = Number(row?.readySelections ?? 0);
        if (expectedSelections > 0) fixturesWithPrices += 1;
        else fixturesWithoutPrices += 1;
        if (row?.ready === true && readySelections > 0) {
          predictionReadyFixtures += 1;
          predictionReadySelections += readySelections;
        } else if (expectedSelections > 0) {
          pricedButNotReadyFixtures += 1;
        }
        providerSelections += Number(row?.bookmakerSelections ?? 0);
        estimatedSelections += Number(row?.historicalEstimates ?? 0);
        staleSourceRevisionSelections += Number(row?.staleSelections ?? 0);
      }

      return {
        available: true,
        source: 'SPORTS_DOMAIN_READ_SERVICE',
        windowHours: ODDS_CONFIG.predictionCoverageWindowHours,
        sampleLimit: MAX_FIXTURE_SAMPLE,
        sampleFixtureCount: ids.length,
        nextPageAvailable: Boolean(page.nextCursor),
        fixturesWithPrices,
        predictionReadyFixtures,
        pricedButNotReadyFixtures,
        fixturesWithoutPrices,
        predictionReadySelections,
        providerSelections,
        estimatedSelections,
        staleSourceRevisionSelections,
        predictionReadyCoveragePercent: ids.length
          ? Number(((predictionReadyFixtures / ids.length) * 100).toFixed(1))
          : null,
        priceCoveragePercent: ids.length
          ? Number(((fixturesWithPrices / ids.length) * 100).toFixed(1))
          : null,
        checkedAt: now.toISOString(),
        error: null,
      };
    } catch (error) {
      return {
        available: false,
        source: 'SPORTS_DOMAIN_READ_SERVICE',
        windowHours: ODDS_CONFIG.predictionCoverageWindowHours,
        sampleLimit: MAX_FIXTURE_SAMPLE,
        sampleFixtureCount: 0,
        nextPageAvailable: false,
        fixturesWithPrices: 0,
        predictionReadyFixtures: 0,
        pricedButNotReadyFixtures: 0,
        fixturesWithoutPrices: 0,
        predictionReadySelections: 0,
        providerSelections: 0,
        estimatedSelections: 0,
        staleSourceRevisionSelections: 0,
        predictionReadyCoveragePercent: null,
        priceCoveragePercent: null,
        checkedAt: now.toISOString(),
        error: this.errorMessage(error).slice(0, 300),
      };
    }
  }

  private async readIndexes(): Promise<{
    indexes: Array<{ name: string }>;
    error?: string;
  }> {
    try {
      const indexes = await this.oddsModel.collection.indexes();
      return {
        indexes: indexes.map((item: any) => ({ name: String(item.name ?? '') })),
      };
    } catch (error) {
      return { indexes: [], error: this.errorMessage(error).slice(0, 300) };
    }
  }

  private publishHealth(
    overview: Record<string, any>,
    checkedAt: Date,
  ): void {
    const status = overview.status as ModuleHealthStatus;
    const alerts = Array.isArray(overview.alerts)
      ? (overview.alerts as OddsMonitorAlert[])
      : [];

    this.systemMonitor.reportMonitorSnapshot('odds', {
      status,
      checkedAt,
      checks: alerts,
      warnings: alerts
        .filter((alert) => alert.severity === 'WARNING')
        .map((alert) => alert.message),
      details: {
        alertCount: alerts.length,
        criticalAlerts: alerts.filter(
          (alert) => alert.severity === 'CRITICAL',
        ).length,
        warningAlerts: alerts.filter(
          (alert) => alert.severity === 'WARNING',
        ).length,
        activeSelections: Number(overview.inventory?.totalSelections ?? 0),
        predictionReadySelections: Number(
          overview.inventory?.predictionReadySelections ?? 0,
        ),
        sampleFixtureCount: Number(
          overview.sportsDependency?.sampleFixtureCount ?? 0,
        ),
        predictionReadyCoveragePercent:
          overview.sportsDependency?.predictionReadyCoveragePercent ?? null,
        workerRunning: Boolean(overview.worker?.running),
        workerBusy: Boolean(overview.worker?.busy),
        inventorySweepInProgress: Boolean(overview.inventorySweep?.inProgress),
        inventorySweepPages: Number(overview.inventorySweep?.completedPages ?? 0),
        inventorySweepFixtures: Number(overview.inventorySweep?.visitedFixtures ?? 0),
        pricingQueueDuePending: Number(overview.pricingQueue?.duePendingCount ?? 0),
        pricingQueueQuarantined: Number(overview.pricingQueue?.quarantinedCount ?? 0),
        externalApiCalls: 0,
        alertCodes: alerts.map((alert) => alert.code).slice(0, 20).join(','),
      },
    });

    if (status !== 'HEALTHY') {
      this.logger.warn(`Odds monitor: ${alerts.length} operational alert(s).`);
    }
  }

  private monitorMetadata(): Record<string, unknown> {
    return {
      intervalMs: this.monitorIntervalMs,
      cacheTtlMs: this.cacheTtlMs,
      startedAt: this.startedAt?.toISOString() ?? null,
      lastCheckAt: this.lastCheckAt?.toISOString() ?? null,
      lastSuccessfulCheckAt:
        this.lastSuccessfulCheckAt?.toISOString() ?? null,
      lastCheckError: this.lastCheckError ?? null,
    };
  }

  private toDate(value: unknown): Date | undefined {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private readPositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}
