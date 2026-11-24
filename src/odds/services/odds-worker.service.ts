import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AdminGateway } from '../../realtime/admin.gateway';
import { BackgroundWorkLimiterService } from '../../common/background-work/background-work-limiter.service';
import { SportsDomainReadService } from '../../sports/services/sports-domain-read.service';
import { SportsQueueJobType } from '../../sports/interfaces/sports-queue.interface';
import type { SportsFixtureRecord } from '../../sports/interfaces/sports-domain.interface';
import { SportsQueueService } from '../../sports/services/sports-queue.service';
import type { ClaimedSportsQueueJob } from '../../sports/services/sports-queue.service';
import { ODDS_CONFIG } from '../config/odds.config';
import { OddsService } from './odds.service';

const QUEUE_POLL_MS = 3_000;
const QUEUE_LEASE_MS = 10 * 60_000;
const QUEUE_HEARTBEAT_MS = 60_000;

type FixturePricingOutcome =
  | { status: 'PRICED'; priceCount: number }
  | { status: 'UNPRICEABLE'; priceCount: 0 }
  | { status: 'NO_PRICE'; priceCount: 0 };

/** A valid upcoming fixture that produced no prices must remain retryable. */
class RetryableOddsPricingOutputError extends Error {
  readonly retryable = true;

  constructor(fixtureId: string) {
    super(`Grivit pricing produced no price rows for eligible fixture ${fixtureId}.`);
    this.name = 'RetryableOddsPricingOutputError';
  }
}

@Injectable()
export class OddsWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OddsWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private queueTimer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private initialized = false;
  private busy = false;
  private cleanupBusy = false;
  private queueBusy = false;
  private queuePasses = 0;
  private queueJobsClaimed = 0;
  private queueJobsCompleted = 0;
  private queueJobsFailed = 0;
  private lastQueuePassAt?: Date;
  private lastQueueError?: string;
  private cursor?: string;
  private startedAt?: Date;

  private inventorySweepStartedAt?: Date;
  /** Fixed window boundaries are retained until the current keyset sweep completes. */
  private inventoryWindowFrom?: Date;
  private inventoryWindowTo?: Date;
  private inventorySweepPages = 0;
  private inventorySweepFixtures = 0;
  private inventorySweepSucceeded = 0;
  private inventorySweepFailed = 0;
  private inventorySweepNoPriceCount = 0;
  private inventorySweepsCompleted = 0;
  private lastInventorySweepStartedAt?: Date;
  private lastInventorySweepCompletedAt?: Date;
  private lastInventorySweepDurationMs?: number;
  private lastInventorySweepPages = 0;
  private lastInventorySweepFixtures = 0;
  private lastInventorySweepSucceeded = 0;
  private lastInventorySweepFailed = 0;
  private lastInventorySweepNoPriceCount = 0;
  private lastSuccessfulInventorySweepAt?: Date;
  private inventoryBackfillRequested = false;
  private inventoryBackfillInProgress = false;
  private lastInventoryBackfillRequestedAt?: Date;
  private lastInventoryBackfillStartedAt?: Date;
  private lastInventoryBackfillCompletedAt?: Date;
  private consecutivePartialInventorySweeps = 0;

  private cyclesCompleted = 0;
  private cyclesFailed = 0;
  private consecutiveCycleFailures = 0;
  private consecutivePartialFailureCycles = 0;
  private lastCycleStartedAt?: Date;
  private lastCycleCompletedAt?: Date;
  private lastSuccessfulCycleAt?: Date;
  private lastCycleDurationMs?: number;
  private lastCycleError?: string;
  private lastBatchSize = 0;
  private lastRefreshedCount = 0;
  private lastFailedCount = 0;
  private lastNoPriceCount = 0;

  private retentionCyclesCompleted = 0;
  private retentionCyclesFailed = 0;
  private retentionConsecutiveFailures = 0;
  private lastRetentionStartedAt?: Date;
  private lastRetentionCompletedAt?: Date;
  private lastRetentionDurationMs?: number;
  private lastRetentionError?: string;
  private lastRetentionFixtureCount = 0;
  private lastRetentionPages = 0;
  private lastCompletedRetentionCount = 0;

  private readonly workerId = `odds-queue:${process.env.HOSTNAME ?? 'node'}:${randomUUID()}`;

  constructor(
    private readonly sportsRead: SportsDomainReadService,
    private readonly oddsService: OddsService,
    private readonly adminGateway: AdminGateway,
    private readonly queue: SportsQueueService,
    private readonly backgroundWork: BackgroundWorkLimiterService,
  ) {}

  onModuleInit(): void {
    this.initialized = true;
    this.startedAt = new Date();

    if (!ODDS_CONFIG.enabled) {
      this.adminGateway.setModuleOperationalStatus(
        'odds', 'STOPPED', 'Grivit odds pricing is disabled by configuration.',
      );
      return;
    }

    this.adminGateway.setModuleOperationalStatus(
      'odds', 'STARTING',
      `Grivit is pricing upcoming Sports fixtures within the next ${ODDS_CONFIG.pricingLookaheadHours / 24} days and consuming eligible source-change jobs.`,
    );

    void this.runSafely();
    void this.runRetentionSafely();
    void this.runQueueSafely();
    this.timer = setInterval(() => void this.runSafely(), ODDS_CONFIG.workerIntervalMs);
    this.cleanupTimer = setInterval(() => void this.runRetentionSafely(), ODDS_CONFIG.cleanupIntervalMs);
    this.queueTimer = setInterval(() => void this.runQueueSafely(), QUEUE_POLL_MS);
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.queueTimer) clearInterval(this.queueTimer);
    this.timer = undefined;
    this.cleanupTimer = undefined;
    this.queueTimer = undefined;
  }

  /** Read-only worker telemetry for the Odds operational monitor. */
  getMonitorStatus() {
    return {
      enabled: ODDS_CONFIG.enabled,
      initialized: this.initialized,
      running: Boolean(this.timer) && !this.stopping,
      stopping: this.stopping,
      startedAt: this.startedAt ?? null,
      busy: this.busy,
      cleanupBusy: this.cleanupBusy,
      queueBusy: this.queueBusy,
      sourceChangeQueue: {
        passes: this.queuePasses,
        jobsClaimed: this.queueJobsClaimed,
        jobsCompleted: this.queueJobsCompleted,
        jobsFailed: this.queueJobsFailed,
        lastPassAt: this.lastQueuePassAt ?? null,
        lastError: this.lastQueueError ?? null,
      },
      cyclesCompleted: this.cyclesCompleted,
      cyclesFailed: this.cyclesFailed,
      consecutiveCycleFailures: this.consecutiveCycleFailures,
      consecutivePartialFailureCycles: this.consecutivePartialFailureCycles,
      lastCycleStartedAt: this.lastCycleStartedAt ?? null,
      lastCycleCompletedAt: this.lastCycleCompletedAt ?? null,
      lastSuccessfulCycleAt: this.lastSuccessfulCycleAt ?? null,
      lastCycleDurationMs: this.lastCycleDurationMs ?? null,
      lastCycleError: this.lastCycleError ?? null,
      lastBatchSize: this.lastBatchSize,
      lastRefreshedCount: this.lastRefreshedCount,
      lastFailedCount: this.lastFailedCount,
      lastNoPriceCount: this.lastNoPriceCount,
      cursorPresent: Boolean(this.cursor),
      inventoryBackfill: {
        requested: this.inventoryBackfillRequested,
        inProgress: this.inventoryBackfillInProgress,
        lastRequestedAt: this.lastInventoryBackfillRequestedAt ?? null,
        lastStartedAt: this.lastInventoryBackfillStartedAt ?? null,
        lastCompletedAt: this.lastInventoryBackfillCompletedAt ?? null,
      },
      inventorySweep: {
        inProgress: Boolean(this.inventorySweepStartedAt),
        startedAt: this.inventorySweepStartedAt ?? null,
        elapsedMs: this.inventorySweepStartedAt
          ? Math.max(0, Date.now() - this.inventorySweepStartedAt.getTime())
          : 0,
        completedPages: this.inventorySweepPages,
        visitedFixtures: this.inventorySweepFixtures,
        successfullyPricedFixtures: this.inventorySweepSucceeded,
        failedFixtures: this.inventorySweepFailed,
        fixturesWithNoPriceOutput: this.inventorySweepNoPriceCount,
        fixturesPerMinute: this.inventorySweepStartedAt
          ? Number((this.inventorySweepFixtures / Math.max(1 / 60, (Date.now() - this.inventorySweepStartedAt.getTime()) / 60_000)).toFixed(1))
          : null,
        sweepsCompleted: this.inventorySweepsCompleted,
        lastStartedAt: this.lastInventorySweepStartedAt ?? null,
        lastCompletedAt: this.lastInventorySweepCompletedAt ?? null,
        lastDurationMs: this.lastInventorySweepDurationMs ?? null,
        lastPages: this.lastInventorySweepPages,
        lastFixtures: this.lastInventorySweepFixtures,
        lastSuccessfullyPricedFixtures: this.lastInventorySweepSucceeded,
        lastFailedFixtures: this.lastInventorySweepFailed,
        lastFixturesWithNoPriceOutput: this.lastInventorySweepNoPriceCount,
        lastSuccessfulAt: this.lastSuccessfulInventorySweepAt ?? null,
        consecutivePartialFailureSweeps: this.consecutivePartialInventorySweeps,
      },
      retentionCyclesCompleted: this.retentionCyclesCompleted,
      retentionCyclesFailed: this.retentionCyclesFailed,
      retentionConsecutiveFailures: this.retentionConsecutiveFailures,
      lastRetentionStartedAt: this.lastRetentionStartedAt ?? null,
      lastRetentionCompletedAt: this.lastRetentionCompletedAt ?? null,
      lastRetentionDurationMs: this.lastRetentionDurationMs ?? null,
      lastRetentionError: this.lastRetentionError ?? null,
      lastRetentionFixtureCount: this.lastRetentionFixtureCount,
      lastRetentionPages: this.lastRetentionPages,
      lastCompletedRetentionCount: this.lastCompletedRetentionCount,
      configuredIntervalMs: ODDS_CONFIG.workerIntervalMs,
      configuredBatchSize: ODDS_CONFIG.workerBatchSize,
      configuredConcurrency: ODDS_CONFIG.workerConcurrency,
      configuredLookaheadHours: ODDS_CONFIG.pricingLookaheadHours,
      configuredScanScope: 'UPCOMING_NEXT_7_DAYS',
      configuredCleanupIntervalMs: ODDS_CONFIG.cleanupIntervalMs,
      configuredRetentionGraceMonths: ODDS_CONFIG.seasonRetentionGraceMonths,
      queueWorkerId: this.workerId,
      dataSource: 'SPORTS_MODULE',
      externalApiCalls: 0,
    };
  }

  /**
   * Schedule a fresh pass over the configured upcoming-fixture window.
   * This does not run an unbounded HTTP request or bypass the worker's normal
   * page size, concurrency, background-work limiter, or retry behaviour.
   */
  requestInventoryBackfill(): {
    accepted: boolean;
    status: 'QUEUED' | 'ALREADY_PENDING' | 'DISABLED';
    requestedAt: Date | null;
    lookaheadHours: number;
  } {
    if (this.stopping || !ODDS_CONFIG.enabled) {
      return {
        accepted: false,
        status: 'DISABLED',
        requestedAt: null,
        lookaheadHours: ODDS_CONFIG.pricingLookaheadHours,
      };
    }

    if (this.inventoryBackfillRequested || this.inventoryBackfillInProgress) {
      return {
        accepted: false,
        status: 'ALREADY_PENDING',
        requestedAt: this.lastInventoryBackfillRequestedAt ?? null,
        lookaheadHours: ODDS_CONFIG.pricingLookaheadHours,
      };
    }

    const requestedAt = new Date();
    this.inventoryBackfillRequested = true;
    this.lastInventoryBackfillRequestedAt = requestedAt;
    // Run immediately when idle. If the worker is busy, its next scheduled
    // cycle consumes the request after the active page has safely completed.
    if (!this.busy) void this.runSafely();

    return {
      accepted: true,
      status: 'QUEUED',
      requestedAt,
      lookaheadHours: ODDS_CONFIG.pricingLookaheadHours,
    };
  }

  /** Queue telemetry is intentionally read-only and scoped to Odds-owned pricing jobs. */
  async getQueueMonitorStatus(): Promise<Record<string, unknown>> {
    try {
      return {
        available: true,
        type: SportsQueueJobType.ODDS_PRICING_RECALCULATION,
        ...(await this.queue.getTypeOperationalSummary(
          SportsQueueJobType.ODDS_PRICING_RECALCULATION,
        )),
      };
    } catch (error) {
      return {
        available: false,
        type: SportsQueueJobType.ODDS_PRICING_RECALCULATION,
        error: this.errorMessage(error).slice(0, 300),
      };
    }
  }

  private beginInventorySweep(at: Date): void {
    if (this.inventorySweepStartedAt) return;
    this.inventorySweepStartedAt = at;
    this.inventoryWindowFrom = new Date(at);
    this.inventoryWindowTo = new Date(
      at.getTime() + ODDS_CONFIG.pricingLookaheadHours * 60 * 60_000,
    );
    this.lastInventorySweepStartedAt = at;
    this.inventorySweepPages = 0;
    this.inventorySweepFixtures = 0;
    this.inventorySweepSucceeded = 0;
    this.inventorySweepFailed = 0;
    this.inventorySweepNoPriceCount = 0;
  }

  private completeInventorySweep(at: Date): void {
    if (!this.inventorySweepStartedAt) return;
    this.inventorySweepsCompleted += 1;
    this.lastInventorySweepCompletedAt = at;
    this.lastInventorySweepDurationMs = Math.max(
      0,
      at.getTime() - this.inventorySweepStartedAt.getTime(),
    );
    this.lastInventorySweepPages = this.inventorySweepPages;
    this.lastInventorySweepFixtures = this.inventorySweepFixtures;
    this.lastInventorySweepSucceeded = this.inventorySweepSucceeded;
    this.lastInventorySweepFailed = this.inventorySweepFailed;
    this.lastInventorySweepNoPriceCount = this.inventorySweepNoPriceCount;
    if (this.inventoryBackfillInProgress) {
      this.inventoryBackfillInProgress = false;
      this.lastInventoryBackfillCompletedAt = at;
    }
    if (this.inventorySweepFailed > 0) {
      this.consecutivePartialInventorySweeps += 1;
    } else {
      this.consecutivePartialInventorySweeps = 0;
      this.lastSuccessfulInventorySweepAt = at;
    }
    this.inventorySweepStartedAt = undefined;
    this.inventoryWindowFrom = undefined;
    this.inventoryWindowTo = undefined;
    this.inventorySweepPages = 0;
    this.inventorySweepFixtures = 0;
    this.inventorySweepSucceeded = 0;
    this.inventorySweepFailed = 0;
    this.inventorySweepNoPriceCount = 0;
  }

  /** One page per pass; repeated passes cover upcoming fixtures within the seven-day window. */
  private async runSafely(): Promise<void> {
    if (this.stopping || !ODDS_CONFIG.enabled || this.busy) return;
    this.busy = true;
    const startedAt = Date.now();
    this.lastCycleStartedAt = new Date(startedAt);

    if (this.inventoryBackfillRequested) {
      // Restart from the first keyset page using a new stable time window.
      // Existing prices are upserted idempotently by OddsService.
      this.cursor = undefined;
      this.inventorySweepStartedAt = undefined;
      this.inventoryWindowFrom = undefined;
      this.inventoryWindowTo = undefined;
      this.inventorySweepPages = 0;
      this.inventorySweepFixtures = 0;
      this.inventorySweepSucceeded = 0;
      this.inventorySweepFailed = 0;
      this.inventorySweepNoPriceCount = 0;
      this.inventoryBackfillRequested = false;
      this.inventoryBackfillInProgress = true;
      this.lastInventoryBackfillStartedAt = new Date(startedAt);
    }

    this.beginInventorySweep(new Date(startedAt));

    let releasePermit: (() => void) | undefined;
    try {
      releasePermit = await this.backgroundWork.acquire('odds:inventory');
      if (this.stopping) return;

      // A stable window prevents a moving `now` boundary from changing the
      // keyset result set while a multi-page inventory sweep is in progress.
      const windowFrom = this.inventoryWindowFrom ?? new Date(startedAt);
      const windowTo = this.inventoryWindowTo ?? new Date(
        windowFrom.getTime() + ODDS_CONFIG.pricingLookaheadHours * 60 * 60_000,
      );
      let result = await this.sportsRead.getFixtures({
        from: windowFrom,
        to: windowTo,
        limit: ODDS_CONFIG.workerBatchSize,
        cursor: this.cursor,
        sortOrder: 'ASC',
      });
      if (!result.items.length && this.cursor) {
        // An empty page after a cursor means the previous cursor-based sweep
        // reached its end. Close its metrics before restarting at the first page.
        this.completeInventorySweep(new Date());
        this.cursor = undefined;
        this.beginInventorySweep(new Date());
        const restartedWindowFrom = this.inventoryWindowFrom ?? new Date();
        const restartedWindowTo = this.inventoryWindowTo ?? new Date(
          restartedWindowFrom.getTime() + ODDS_CONFIG.pricingLookaheadHours * 60 * 60_000,
        );
        result = await this.sportsRead.getFixtures({
          from: restartedWindowFrom,
          to: restartedWindowTo,
          limit: ODDS_CONFIG.workerBatchSize,
          sortOrder: 'ASC',
        });
      }

      const fixtures = result.items;
      this.lastBatchSize = fixtures.length;
      let refreshed = 0;
      let failed = 0;
      let noPriceCount = 0;
      const successfullyRefreshedFixtures: SportsFixtureRecord[] = [];
      let interrupted = false;
      for (let offset = 0; offset < fixtures.length; offset += ODDS_CONFIG.workerConcurrency) {
        if (this.stopping) {
          interrupted = true;
          break;
        }
        const batch = fixtures.slice(offset, offset + ODDS_CONFIG.workerConcurrency);
        const outcomes = await Promise.all(batch.map(async (fixture) => {
          // A long page may span several minutes. Recheck each kickoff just
          // before pricing so a fixture that has since started is not repriced.
          if (!this.isWithinPricingWindow(fixture)) {
            return { fixture, success: false, skipped: true };
          }
          try {
            const outcome = await this.refreshFixtureWithOutcome(fixture);
            if (outcome.status === 'PRICED') {
              return { fixture, success: true, skipped: false, noPrice: false };
            }
            if (outcome.status === 'UNPRICEABLE') {
              return { fixture, success: false, skipped: true, noPrice: false };
            }
            this.logger.warn(
              `Grivit pricing produced zero price rows for eligible fixture ${fixture.id}; it will be retried on a later inventory sweep.`,
            );
            return { fixture, success: false, skipped: false, noPrice: true };
          } catch (error) {
            this.logger.warn(`Grivit pricing failed for fixture ${fixture.id}: ${this.errorMessage(error)}`);
            return { fixture, success: false, skipped: false, noPrice: false };
          }
        }));
        const succeeded = outcomes.filter((item) => item.success);
        successfullyRefreshedFixtures.push(...succeeded.map((item) => item.fixture));
        refreshed += succeeded.length;
        noPriceCount += outcomes.filter((item) => item.noPrice).length;
        failed += outcomes.filter((item) => !item.success && !item.skipped && !item.noPrice).length;
      }

      // Do not advance the keyset cursor for an interrupted page. The page is
      // safely revisited after restart instead of being counted as completed.
      if (interrupted || this.stopping) return;

      // This also covers the initial upcoming-fixture Odds backfill. A prediction
      // trigger is coalesced by the latest persisted Grivit price timestamp, so
      // an unchanged rolling scan cannot create duplicate work every cycle.
      const predictionTriggers = await this.enqueuePredictionRecalculations(successfullyRefreshedFixtures);
      if (predictionTriggers > 0) {
        this.logger.log(`Grivit refresh released ${predictionTriggers} prediction recalculation trigger(s).`);
      }

      this.inventorySweepPages += 1;
      this.inventorySweepFixtures += fixtures.length;
      const failedTotal = failed + noPriceCount;
      this.inventorySweepSucceeded += refreshed;
      this.inventorySweepFailed += failedTotal;
      this.inventorySweepNoPriceCount += noPriceCount;
      this.cursor = result.nextCursor;
      if (!result.nextCursor) this.completeInventorySweep(new Date());
      this.lastRefreshedCount = refreshed;
      this.lastFailedCount = failedTotal;
      this.lastNoPriceCount = noPriceCount;
      this.cyclesCompleted += 1;
      this.consecutiveCycleFailures = 0;
      if (failedTotal > 0) {
        this.consecutivePartialFailureCycles += 1;
        this.lastCycleError = `${failedTotal} fixture(s) were not priced (${noPriceCount} returned zero price rows; ${failed} raised calculation errors); the full scan will revisit them.`;
      } else {
        this.consecutivePartialFailureCycles = 0;
        this.lastCycleError = undefined;
        this.lastSuccessfulCycleAt = new Date();
      }

      this.adminGateway.setModuleOperationalStatus(
        'odds', failedTotal ? 'DEGRADED' : 'READY',
        `Grivit pricing batch processed ${fixtures.length} fixtures (${refreshed} priced, ${noPriceCount} returned no prices, ${failed} calculation errors) within the configured upcoming-fixture horizon.`,
      );
      this.adminGateway.publishModuleEvent('odds', 'odds:cycle-completed', {
        fixtureCount: fixtures.length,
        refreshed,
        failed: failedTotal,
        calculationErrors: failed,
        noPriceCount,
        nextPageAvailable: Boolean(result.nextCursor),
        scanScope: 'UPCOMING_NEXT_7_DAYS',
        inventorySweep: this.getMonitorStatus().inventorySweep,
        bookmaker: 'Grivit',
        externalApiCalls: 0,
        occurredAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = this.errorMessage(error);
      this.lastCycleError = message.slice(0, 500);
      this.cyclesFailed += 1;
      this.consecutiveCycleFailures += 1;
      this.adminGateway.setModuleOperationalStatus(
        'odds', 'DEGRADED', `Grivit inventory pricing batch failed: ${message.slice(0, 300)}`,
      );
      this.adminGateway.publishModuleEvent('odds', 'odds:worker-error', {
        message: message.slice(0, 500), occurredAt: new Date().toISOString(),
      });
      this.logger.error(`Grivit inventory pricing batch failed: ${message}`);
    } finally {
      releasePermit?.();
      this.lastCycleCompletedAt = new Date();
      this.lastCycleDurationMs = Date.now() - startedAt;
      this.busy = false;
    }
  }

  /** Consume only Odds-owned source-change jobs from the shared durable Sports queue. */
  private async runQueueSafely(): Promise<void> {
    if (this.stopping || !ODDS_CONFIG.enabled || this.queueBusy) return;
    this.queueBusy = true;
    this.queuePasses += 1;
    this.lastQueuePassAt = new Date();
    let releasePermit: (() => void) | undefined;
    try {
      releasePermit = await this.backgroundWork.acquire('odds:pricing-queue');
      if (this.stopping) return;

      const claims: Array<{ job: ClaimedSportsQueueJob; workerId: string }> = [];
      for (let slot = 0; slot < ODDS_CONFIG.workerConcurrency; slot += 1) {
        const workerId = `${this.workerId}:${slot}`;
        const job = await this.queue.claimNext(
          workerId,
          QUEUE_LEASE_MS,
          SportsQueueJobType.ODDS_PRICING_RECALCULATION,
        );
        if (!job) break;
        claims.push({ job, workerId });
      }
      this.queueJobsClaimed += claims.length;
      await Promise.all(claims.map(({ job, workerId }) => this.processQueuedJob(job, workerId)));
    } catch (error) {
      this.lastQueueError = this.errorMessage(error).slice(0, 500);
      this.logger.warn(`Odds source-change queue pass failed: ${this.lastQueueError}`);
    } finally {
      releasePermit?.();
      this.queueBusy = false;
    }
  }

  private async processQueuedJob(job: ClaimedSportsQueueJob, workerId: string): Promise<void> {
    const heartbeat = setInterval(() => {
      void this.queue.markHeartbeat(job.jobKey, workerId, QUEUE_LEASE_MS)
        .then((renewed) => {
          if (!renewed) this.logger.warn(`Odds queue lease ${job.jobKey} is no longer owned by this worker.`);
        })
        .catch((error: unknown) => this.logger.warn(`Odds queue heartbeat failed: ${this.errorMessage(error)}`));
    }, QUEUE_HEARTBEAT_MS);
    (heartbeat as unknown as { unref?: () => void }).unref?.();

    try {
      const fixtureId = String(job.scope.fixtureId ?? '').trim();
      if (!fixtureId) throw new Error('Odds pricing queue job is missing fixtureId.');
      const fixture = await this.sportsRead.getFixture(fixtureId);
      if (!fixture || !this.isWithinPricingWindow(fixture)) {
        const completed = await this.queue.markCompleted(job.jobKey, workerId);
        if (completed) {
          this.queueJobsCompleted += 1;
          this.logger.debug(
            `Skipped out-of-window Grivit pricing job for ${fixtureId}; the rolling inventory sweep will pick it up if it enters the seven-day horizon.`,
          );
        } else {
          this.logger.warn(`Odds queue job ${job.jobKey} lost its processing lease before skip completion.`);
        }
        return;
      }
      const pricingOutcome = await this.refreshFixtureWithOutcome(fixture);
      if (pricingOutcome.status === 'NO_PRICE') {
        throw new RetryableOddsPricingOutputError(fixtureId);
      }
      if (pricingOutcome.status === 'UNPRICEABLE') {
        const completed = await this.queue.markCompleted(job.jobKey, workerId);
        if (completed) {
          this.queueJobsCompleted += 1;
          this.logger.debug(
            `Completed Grivit pricing job for ${fixtureId}; fixture status ${String(fixture.status?.state ?? 'UNKNOWN')} is not priceable.`,
          );
        } else {
          this.logger.warn(`Odds queue job ${job.jobKey} lost its processing lease before invalid-fixture completion.`);
        }
        return;
      }
      await this.enqueuePredictionRecalculationForFixture(fixtureId);
      const completed = await this.queue.markCompleted(job.jobKey, workerId);
      if (completed) {
        this.queueJobsCompleted += 1;
        this.lastQueueError = undefined;
      } else {
        this.logger.warn(`Odds queue job ${job.jobKey} lost its processing lease before completion.`);
      }
    } catch (error) {
      this.queueJobsFailed += 1;
      this.lastQueueError = this.errorMessage(error).slice(0, 500);
      const outcome = await this.queue.markFailed(job, workerId, error);
      this.logger.warn(`Odds source-change job ${job.jobKey} failed and was ${outcome.toLowerCase()}: ${this.lastQueueError}`);
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * A successful method call is not enough: refreshFixture returns the number
   * of persisted rows, and zero rows on an eligible fixture is missing coverage.
   */
  private async refreshFixtureWithOutcome(
    fixture: SportsFixtureRecord,
  ): Promise<FixturePricingOutcome> {
    const priceCount = Number(await this.oddsService.refreshFixture(String(fixture.id)));
    if (Number.isFinite(priceCount) && priceCount > 0) {
      return { status: 'PRICED', priceCount };
    }
    if (this.isPermanentlyUnpriceableFixture(fixture)) {
      return { status: 'UNPRICEABLE', priceCount: 0 };
    }
    return { status: 'NO_PRICE', priceCount: 0 };
  }

  /** Only genuinely non-priceable fixture states are acknowledged without retry. */
  private isPermanentlyUnpriceableFixture(fixture: SportsFixtureRecord): boolean {
    const state = String(fixture.status?.state ?? 'UNKNOWN').toUpperCase();
    if (['POSTPONED', 'CANCELLED', 'CANCELED', 'ABANDONED'].includes(state)) return true;
    const retentionExpiresAt = this.toDate((fixture as any).retentionExpiresAt);
    return Boolean(retentionExpiresAt && retentionExpiresAt.getTime() <= Date.now());
  }

  private async enqueuePredictionRecalculationForFixture(
    fixtureId: string,
  ): Promise<void> {
    const fixture = await this.sportsRead.getFixture(fixtureId);
    if (!fixture || !this.isUpcomingPredictionFixture(fixture)) return;
    await this.enqueuePredictionRecalculations([fixture]);
  }

  private async enqueuePredictionRecalculations(
    fixtures: SportsFixtureRecord[],
  ): Promise<number> {
    const candidates = fixtures.filter((fixture) => this.isUpcomingPredictionFixture(fixture));
    if (!candidates.length) return 0;

    let enqueued = 0;
    const readinessBatchSize = 500;
    for (let offset = 0; offset < candidates.length; offset += readinessBatchSize) {
      const batch = candidates.slice(offset, offset + readinessBatchSize);
      const readinessByEvent = await this.oddsService.getPredictionReadinessForEvents(
        batch.map((fixture) => String(fixture.id)),
      );

      // Report why fixtures are still waiting for a prediction trigger. This
      // keeps insufficient Sports history, stale source revisions and invalid
      // prices distinguishable without weakening Grivit's quality thresholds.
      const waitingReasons = new Map<string, { count: number; examples: string[] }>();
      let readyFixtureCount = 0;
      for (const fixture of batch) {
        const fixtureId = String(fixture.id);
        const readiness = readinessByEvent.get(fixtureId);
        if (readiness?.ready === true) {
          readyFixtureCount += 1;
          continue;
        }
        const reason = String(readiness?.reason ?? 'No Grivit readiness record was returned.');
        const bucket = waitingReasons.get(reason) ?? { count: 0, examples: [] };
        bucket.count += 1;
        if (bucket.examples.length < 3) bucket.examples.push(fixtureId);
        waitingReasons.set(reason, bucket);
      }
      if (waitingReasons.size > 0) {
        const summary = [...waitingReasons.entries()]
          .map(([reason, value]) => `${value.count}× ${reason} [${value.examples.join(', ')}]`)
          .join('; ');
        this.logger.debug(
          `Grivit readiness batch ${batch.length}: ready=${readyFixtureCount}, waiting=${batch.length - readyFixtureCount}; ${summary}`,
        );
      }

      const enqueueConcurrency = 2;
      for (let cursor = 0; cursor < batch.length; cursor += enqueueConcurrency) {
        const enqueueBatch = batch.slice(cursor, cursor + enqueueConcurrency);
        const results = await Promise.all(enqueueBatch.map(async (fixture) => {
          const fixtureId = String(fixture.id);
          const readiness = readinessByEvent.get(fixtureId);
          if (!readiness?.ready) return false;
          const latestOddsUpdatedAt = this.toDate(readiness.latestOddsUpdatedAt);
          if (!latestOddsUpdatedAt) return false;

          const predictionSourceUpdatedAt = latestOddsUpdatedAt.toISOString();
          const result = await this.queue.enqueueIfMissing({
            type: SportsQueueJobType.PREDICTION_ENGINE_RECALCULATION,
            scope: {
              fixtureId,
              predictionSourceUpdatedAt,
            },
            priority: 75,
            scheduledFor: new Date(),
            triggerEventId: `prediction:grivit:${fixtureId}:${predictionSourceUpdatedAt}`,
          });
          return result.created;
        }));
        enqueued += results.filter(Boolean).length;
      }
    }

    return enqueued;
  }

  private isUpcomingPredictionFixture(fixture: SportsFixtureRecord): boolean {
    if (!this.isWithinPricingWindow(fixture)) return false;
    const state = String(fixture.status?.state ?? 'UNKNOWN').toUpperCase();
    return ![
      'LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES',
      'COMPLETED', 'POSTPONED', 'CANCELLED', 'CANCELED', 'ABANDONED',
    ].includes(state) && fixture.status?.isFinal !== true;
  }

  /** Date eligibility is separate from prediction eligibility so cancelled
   * fixtures in-window still pass through OddsService and lose stale quotes. */
  private isWithinPricingWindow(fixture: SportsFixtureRecord): boolean {
    const kickoffAt = this.toDate(fixture.kickoffAt);
    const now = Date.now();
    const horizonEnd = now + ODDS_CONFIG.pricingLookaheadHours * 60 * 60_000;
    return Boolean(
      kickoffAt &&
      kickoffAt.getTime() > now &&
      kickoffAt.getTime() <= horizonEnd,
    );
  }

  private toDate(value: unknown): Date | null {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date : null;
    }
    return null;
  }

  /** TTL is the primary expiry mechanism; this bounded sweep removes expired rows promptly. */
  private async runRetentionSafely(): Promise<void> {
    if (this.stopping || !ODDS_CONFIG.enabled || this.cleanupBusy) return;
    this.cleanupBusy = true;
    const startedAt = Date.now();
    this.lastRetentionStartedAt = new Date(startedAt);
    let releasePermit: (() => void) | undefined;
    try {
      releasePermit = await this.backgroundWork.acquire('odds:retention');
      if (this.stopping) return;
      const deleted = await this.oddsService.pruneExpiredPrices(ODDS_CONFIG.expiredPriceCleanupBatchSize);
      this.lastRetentionFixtureCount = deleted;
      this.lastRetentionPages = deleted > 0 ? 1 : 0;
      this.lastCompletedRetentionCount = deleted;
      this.retentionCyclesCompleted += 1;
      this.retentionConsecutiveFailures = 0;
      this.lastRetentionError = undefined;
      if (deleted > 0) {
        this.adminGateway.publishModuleEvent('odds', 'odds:retention-completed', {
          expiredSelectionsDeleted: deleted,
          retentionRule: 'SPORTS_FIXTURE_SEASON_DURATION_PLUS_3_MONTHS',
          occurredAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      const message = this.errorMessage(error);
      this.lastRetentionError = message.slice(0, 500);
      this.retentionCyclesFailed += 1;
      this.retentionConsecutiveFailures += 1;
      this.logger.warn(`Grivit expired-price cleanup failed: ${message}`);
      this.adminGateway.publishModuleEvent('odds', 'odds:retention-error', {
        message: message.slice(0, 300), occurredAt: new Date().toISOString(),
      });
    } finally {
      releasePermit?.();
      this.lastRetentionCompletedAt = new Date();
      this.lastRetentionDurationMs = Date.now() - startedAt;
      this.cleanupBusy = false;
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}




