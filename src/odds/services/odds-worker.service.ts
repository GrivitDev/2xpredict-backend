import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EspnFixture } from '../../sports/schemas/espn/espn-fixture.schema';
import { OddsService } from './odds.service';
import { OddsCollectionService } from './odds-collection.service';
import { AdminGateway } from '../../realtime/admin.gateway';
import { ODDS_CONFIG } from '../config/odds.config';
import { EspnQueueService } from '../../sports/services/espn-queue.service';

const WORKER_INTERVAL_MS = 5 * 60_000;
const FIXTURES_PER_CYCLE = 20; // Bounded page; refreshes run with concurrency 2.
const CANDIDATE_COUNT_REFRESH_MS = 30 * 60_000;
const EXPIRY_CLEANUP_INTERVAL_MS = 15 * 60_000;

@Injectable()
export class OddsWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OddsWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private expiryTimer?: ReturnType<typeof setInterval>;
  private busy = false;
  private expiryBusy = false;
  private candidateCountCache = 0;
  private candidateCountRefreshedAt = 0;
  private fixtureExplainLogged = false;
  private stopping = false;
  private cursor: { fixtureDate: Date; eventId: string } | null = null;
  private cyclesCompleted = 0;
  private cyclesFailed = 0;
  private lastCycleStartedAt?: Date;
  private lastCycleCompletedAt?: Date;
  private lastCycleSucceeded?: boolean;
  private lastCycleError?: string;
  private lastCandidateCount = 0;
  private lastBatchSize = 0;
  private lastRefreshedCount = 0;
  private lastPredictionReadyCount = 0;

  /** Read-only runtime diagnostics for the Odds monitor. */
  getMonitorStatus() {
    return {
      running: Boolean(this.timer) && !this.stopping,
      stopping: this.stopping,
      busy: this.busy,
      expiryCleanupBusy: this.expiryBusy,
      startupReleased: Boolean(this.timer),
      cyclesCompleted: this.cyclesCompleted,
      cyclesFailed: this.cyclesFailed,
      lastCycleStartedAt: this.lastCycleStartedAt ?? null,
      lastCycleCompletedAt: this.lastCycleCompletedAt ?? null,
      lastCycleSucceeded: this.lastCycleSucceeded ?? null,
      lastCycleError: this.lastCycleError ?? null,
      lastCandidateCount: this.lastCandidateCount,
      lastBatchSize: this.lastBatchSize,
      lastRefreshedCount: this.lastRefreshedCount,
      lastPredictionReadyCount: this.lastPredictionReadyCount,
      candidateCountCache: this.candidateCountCache,
      candidateCountRefreshedAt: this.candidateCountRefreshedAt
        ? new Date(this.candidateCountRefreshedAt)
        : null,
      configuredCycleIntervalMs: WORKER_INTERVAL_MS,
      configuredBatchSize: FIXTURES_PER_CYCLE,
      configuredExpiryCleanupIntervalMs: EXPIRY_CLEANUP_INTERVAL_MS,
    };
  }

  constructor(
    @InjectModel(EspnFixture.name)
    private readonly fixtureModel: Model<EspnFixture>,
    private readonly oddsService: OddsService,
    private readonly oddsCollectionService: OddsCollectionService,
    private readonly adminGateway: AdminGateway,
    private readonly espnQueueService: EspnQueueService,
  ) {}

  onModuleInit(): void {
    // The Sports startup pipeline owns the provider/API startup order. Do not
    // query fixtures, call ESPN Summary, or request Odds API feeds until it has
    // explicitly released normal operations.
    this.logger.log(
      'Odds worker initialized; waiting for ESPN startup to finish before any collection begins.',
    );
    void this.startAfterSportsStartup();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.timer = undefined;
    this.expiryTimer = undefined;
  }

  private async startAfterSportsStartup(): Promise<void> {
    await this.espnQueueService.waitForNormalOperationsReady();
    if (this.stopping) return;

    this.logger.log(
      'ESPN startup finished and released normal operations; starting Odds collection.',
    );
    this.adminGateway.setModuleOperationalStatus(
      'odds',
      'STARTING',
      'ESPN startup is complete. The first Odds refresh cycle is starting.',
    );

    void this.runSafely();
    this.timer = setInterval(() => void this.runSafely(), WORKER_INTERVAL_MS);
    // Expiry discovery is housekeeping, not part of the five-minute price refresh.
    // Its bounded work must never delay the next regular Odds worker cycle.
    void this.runExpiryCleanupSafely();
    this.expiryTimer = setInterval(
      () => void this.runExpiryCleanupSafely(),
      EXPIRY_CLEANUP_INTERVAL_MS,
    );
  }

  private async runSafely(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.lastCycleStartedAt = new Date();
    try {
      const now = new Date();
      const nowWat = new Date(now.getTime() + 60 * 60_000);
      const todayStartWat = new Date(Date.UTC(nowWat.getUTCFullYear(), nowWat.getUTCMonth(), nowWat.getUTCDate()) - 60 * 60_000);
      const horizon = new Date(now.getTime() + ODDS_CONFIG.lookaheadHours * 60 * 60_000);
      // Use indexed fixtureDate/live fields for discovery. Text/regex status
      // checks are deliberately left to OddsService after a bounded batch has
      // been loaded; putting many regex branches in this hot query prevents an
      // efficient keyset scan on the 2 GB host.
      const fixtureFilter = {
        $and: [
          {
            $or: [
              { fixtureDate: { $gte: todayStartWat, $lte: horizon } },
              { live: true },
            ],
          },
          { completed: { $ne: true } },
        ],
      };
      await this.logFixtureDiscoveryExplainIfRequested(fixtureFilter);
      const candidateCount = await this.getCandidateCount(fixtureFilter);
      this.lastCandidateCount = candidateCount;
      // Keep the cursor unchanged until the batch has completed. A provider
      // failure or a failed fixture must not advance the scan past work that
      // still needs a retry.
      let queryCursor = this.cursor;
      const loadBatch = async (cursor: { fixtureDate: Date; eventId: string } | null) => {
        const cursorFilter = cursor
          ? {
              $or: [
                { fixtureDate: { $gt: cursor.fixtureDate } },
                {
                  fixtureDate: cursor.fixtureDate,
                  eventId: { $gt: cursor.eventId },
                },
              ],
            }
          : undefined;
        const filter = cursorFilter
          ? { $and: [...(fixtureFilter.$and ?? []), cursorFilter] }
          : fixtureFilter;
        return (await this.fixtureModel
          .find(filter)
            .select({
            eventId: 1,
            leagueId: 1,
            homeScore: 1,
            awayScore: 1,
            season: 1,
            fixtureDate: 1,
            live: 1,
            completed: 1,
            status: 1,
            statusDetail: 1,
            statusShortDetail: 1,
            homeTeamId: 1,
            awayTeamId: 1,
            'payload.summary.odds': 1,
            'payload.summary.pickcenter': 1,
            'payload.summary.meta.lastUpdatedAt': 1,
            'payload.summaryCollectedAt': 1,
            'payload.oddsSummaryAttemptedAt': 1,
            'payload.competitions.competitors': 1,
            'payload.competitions.odds': 1,
          })
          .sort({ fixtureDate: 1, eventId: 1 })
          .limit(FIXTURES_PER_CYCLE)
          .lean()
          .exec()) as any[];
      };
      let batch = await loadBatch(queryCursor);
      // Keyset pagination avoids increasingly expensive skip/offset scans. If
      // the cursor reaches the end, wrap locally; do not commit until work ends.
      if (!batch.length && queryCursor) {
        queryCursor = null;
        batch = await loadBatch(queryCursor);
      }
      this.lastBatchSize = batch.length;

      // Keep provider and database concurrency bounded for the 2 GB host while
      // rotating through the complete eligible fixture set with indexed paging.
      const providerCollection =
        await this.oddsCollectionService.collectProviderQuotes(batch);
      let refreshed = 0;
      const failedEventIds = new Set<string>();
      if (batch.length) {
        const seen = new Set<string>();
        const uniqueBatch = batch.filter((fixture) => {
          const eventId = String(fixture.eventId ?? '').trim();
          if (!eventId || seen.has(eventId)) return false;
          seen.add(eventId);
          return true;
        });
        // Keep database/provider pressure bounded while avoiding one full
        // sequential round-trip per fixture. Provider collection remains batched.
        const refreshConcurrency = 2;
        for (let offset = 0; offset < uniqueBatch.length; offset += refreshConcurrency) {
          const refreshBatch = uniqueBatch.slice(offset, offset + refreshConcurrency);
          const outcomes = await Promise.all(refreshBatch.map(async (fixture) => {
            const eventId = String(fixture.eventId);
            const quotes = providerCollection.pricesByEvent.get(eventId) ?? [];
            try {
              await this.oddsService.refreshFixture(
                eventId,
                quotes,
                providerCollection.updatedAtByEvent.get(eventId),
              );
              return { eventId, ok: true as const };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              this.logger.warn(
                `Odds refresh failed for fixture ${eventId}; other fixtures in the batch will continue: ${message}`,
              );
              return { eventId, ok: false as const };
            }
          }));
          refreshed += outcomes.filter((outcome) => outcome.ok).length;
          for (const outcome of outcomes) {
            if (!outcome.ok) failedEventIds.add(outcome.eventId);
          }
        }

        const firstFailedIndex = uniqueBatch.findIndex((fixture) =>
          failedEventIds.has(String(fixture.eventId)),
        );
        const cursorFixture = firstFailedIndex >= 0
          ? (firstFailedIndex > 0 ? uniqueBatch[firstFailedIndex - 1] : null)
          : batch[batch.length - 1];
        if (firstFailedIndex >= 0 && firstFailedIndex === 0) {
          this.cursor = queryCursor;
        } else if (cursorFixture) {
          const cursorDate = cursorFixture.fixtureDate instanceof Date
            ? cursorFixture.fixtureDate
            : new Date(cursorFixture.fixtureDate);
          const cursorEventId = String(cursorFixture.eventId ?? '').trim();
          if (Number.isFinite(cursorDate.getTime()) && cursorEventId) {
            this.cursor = { fixtureDate: cursorDate, eventId: cursorEventId };
          }
        } else {
          this.cursor = queryCursor;
        }
      } else {
        // An empty result means this cursor reached the end of the current set.
        this.cursor = null;
      }
      const batchEventIds = batch
        .map((fixture) => String(fixture.eventId))
        .filter(Boolean);
      const readinessByEvent =
        await this.oddsService.getPredictionReadinessForEvents(batchEventIds);
      const readyCount = [...readinessByEvent.values()].filter(
        (item) => item.ready,
      ).length;
      this.lastRefreshedCount = refreshed;
      this.lastPredictionReadyCount = readyCount;
      this.lastCycleSucceeded = true;
      this.lastCycleError = undefined;
      this.cyclesCompleted += 1;
      const moduleMessage = `${providerCollection.statusMessage || 'Odds worker cycle completed.'} Current Odds batch processed ${batch.length} of ${candidateCount} eligible fixtures; readiness: ${readyCount}/${batchEventIds.length} fixtures in this batch are ready for the Prediction Engine.`;
      // A missing ESPN bookmaker quote is not an Odds module outage: the Odds
      // API and the labelled historical fallback still complete price coverage.
      this.adminGateway.setModuleOperationalStatus(
        'odds',
        'READY',
        moduleMessage,
      );
      this.adminGateway.publishModuleEvent('odds', 'odds:cycle-completed', {
        candidates: candidateCount,
        batchSize: batch.length,
        refreshed,
        predictionReady: readyCount,
        predictionNotReady: batchEventIds.length - readyCount,
        primaryAvailable: providerCollection.primaryAvailable,
        fallbackActive: providerCollection.fallbackActive,
        providerStatus: moduleMessage,
        occurredAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastCycleSucceeded = false;
      this.lastCycleError = message.slice(0, 500);
      this.cyclesFailed += 1;
      this.adminGateway.setModuleOperationalStatus('odds', 'DEGRADED', message);
      this.adminGateway.publishModuleEvent('odds', 'odds:worker-error', {
        message: message.slice(0, 500),
        occurredAt: new Date().toISOString(),
      });
      this.logger.error(`Odds worker cycle failed: ${message}`);
    } finally {
      this.lastCycleCompletedAt = new Date();
      this.busy = false;
    }
  }

  private async getCandidateCount(fixtureFilter: Record<string, any>): Promise<number> {
    const now = Date.now();
    // This count is diagnostic only; it never gates batch discovery. Cache
    // even a zero count so an empty result does not trigger a full count scan
    // on every five-minute worker pass.
    if (now - this.candidateCountRefreshedAt >= CANDIDATE_COUNT_REFRESH_MS) {
      this.candidateCountCache = await this.fixtureModel.countDocuments(fixtureFilter).exec();
      this.candidateCountRefreshedAt = now;
    }
    return this.candidateCountCache;
  }

  /**
   * Run only when explicitly enabled so the real MongoDB plan can be measured
   * before considering a fixture discovery index or pagination redesign.
   * Enable with ODDS_FIXTURE_QUERY_EXPLAIN=true and inspect documents/keys examined
   * and whether the winning plan contains a blocking SORT stage.
   */
  private async logFixtureDiscoveryExplainIfRequested(fixtureFilter: Record<string, any>): Promise<void> {
    if (this.fixtureExplainLogged || process.env.ODDS_FIXTURE_QUERY_EXPLAIN !== 'true') return;
    this.fixtureExplainLogged = true;
    try {
      const explanation: any = await this.fixtureModel
        .find(fixtureFilter)
        .select({ eventId: 1, live: 1, fixtureDate: 1 })
        .sort({ fixtureDate: 1, eventId: 1 })
        .limit(FIXTURES_PER_CYCLE)
        .explain('executionStats');
      const execution = explanation?.executionStats ?? {};
      const planner = explanation?.queryPlanner ?? {};
      this.logger.log(`Odds fixture discovery explain: ${JSON.stringify({
        executionTimeMillis: execution.executionTimeMillis,
        nReturned: execution.nReturned,
        totalKeysExamined: execution.totalKeysExamined,
        totalDocsExamined: execution.totalDocsExamined,
        winningPlan: planner.winningPlan,
      })}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not collect Odds fixture discovery explain plan: ${message}`);
    }
  }

  private async runExpiryCleanupSafely(): Promise<void> {
    if (this.stopping || this.expiryBusy) return;
    this.expiryBusy = true;
    try {
      const updatedOddsDocuments = await this.oddsService.expireCompletedFixtures(100);
      this.adminGateway.publishModuleEvent('odds', 'odds:expiry-cleanup-completed', {
        updatedOddsDocuments,
        occurredAt: new Date().toISOString(),
      });
      if (updatedOddsDocuments > 0) {
        this.logger.log(`Odds expiry cleanup assigned retention dates to ${updatedOddsDocuments} odds documents.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Odds expiry cleanup failed; normal Odds refresh continues: ${message}`);
      this.adminGateway.publishModuleEvent('odds', 'odds:expiry-cleanup-error', {
        message: message.slice(0, 500),
        occurredAt: new Date().toISOString(),
      });
    } finally {
      this.expiryBusy = false;
    }
  }

}


