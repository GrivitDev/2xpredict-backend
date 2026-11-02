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
const FIXTURES_PER_CYCLE = 20;
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
  private offset = 0;
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
      const liveStatus = /IN[_ -]?PROGRESS|INPROGRESS|LIVE|HALF[_ -]?TIME|FIRST[_ -]?HALF|SECOND[_ -]?HALF|STATUS_HALFTIME|STATUS_IN_PROGRESS/i;
      const fixtureFilter = {
        $and: [
          { $or: [
            { fixtureDate: { $gte: todayStartWat, $lte: horizon } },
            { live: true },
            { status: liveStatus },
            { statusDetail: liveStatus },
            { statusShortDetail: liveStatus },
            { 'payload.summary.header.competitions.status.state': /^(in|in_progress|in-progress)$/i },
            { 'payload.summary.header.competitions.status.type.state': /^(in|in_progress|in-progress)$/i },
            { 'payload.competitions.status.state': /^(in|in_progress|in-progress)$/i },
            { 'payload.competitions.status.type.state': /^(in|in_progress|in-progress)$/i },
          ] },
          { completed: { $ne: true } },
          { $nor: [
            { status: /(^|[^A-Z])(FINAL|FINISHED|FULL[ _-]?TIME|AFTER EXTRA TIME|AFTER PENALTIES|FT)([^A-Z]|$)/i },
            { statusDetail: /(^|[^A-Z])(FINAL|FINISHED|FULL[ _-]?TIME|AFTER EXTRA TIME|AFTER PENALTIES|FT)([^A-Z]|$)/i },
            { statusShortDetail: /(^|[^A-Z])(FINAL|FINISHED|FULL[ _-]?TIME|AFTER EXTRA TIME|AFTER PENALTIES|FT)([^A-Z]|$)/i },
            { 'payload.summary.header.competitions.status.completed': true },
            { 'payload.summary.header.competitions.status.type.completed': true },
            { 'payload.competitions.status.completed': true },
            { 'payload.competitions.status.type.completed': true },
            { 'payload.summary.header.competitions.status.name': /(^|[^A-Z])(FINAL|FINISHED|FULL[ _-]?TIME|AFTER EXTRA TIME|AFTER PENALTIES|FT)([^A-Z]|$)/i },
            { 'payload.summary.header.competitions.status.type.name': /(^|[^A-Z])(FINAL|FINISHED|FULL[ _-]?TIME|AFTER EXTRA TIME|AFTER PENALTIES|FT)([^A-Z]|$)/i },
            { 'payload.competitions.status.name': /(^|[^A-Z])(FINAL|FINISHED|FULL[ _-]?TIME|AFTER EXTRA TIME|AFTER PENALTIES|FT)([^A-Z]|$)/i },
            { 'payload.competitions.status.type.name': /(^|[^A-Z])(FINAL|FINISHED|FULL[ _-]?TIME|AFTER EXTRA TIME|AFTER PENALTIES|FT)([^A-Z]|$)/i },
            { 'payload.summary.header.competitions.status.detail': /postpon|cancel|abandon|delay/i },
            { 'payload.competitions.status.detail': /postpon|cancel|abandon|delay/i },
            { status: /postpon|cancel|abandon|delay/i },
            { statusDetail: /postpon|cancel|abandon|delay/i },
            { statusShortDetail: /postpon|cancel|abandon|delay/i },
          ] },
        ],
      };
      await this.logFixtureDiscoveryExplainIfRequested(fixtureFilter);
      let candidateCount = await this.getCandidateCount(fixtureFilter);
      this.lastCandidateCount = candidateCount;
      if (candidateCount === 0 || this.offset >= candidateCount) this.offset = 0;
      const loadBatch = async () => (await this.fixtureModel
        .find(fixtureFilter)
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
          'payload.summary.header.competitions.status': 1,
          'payload.summaryCollectedAt': 1,
          'payload.oddsSummaryAttemptedAt': 1,
          'payload.competitions.competitors': 1,
          'payload.competitions.odds': 1,
          'payload.competitions.status': 1,
        })
        .sort({ live: -1, fixtureDate: 1, eventId: 1 })
        .skip(this.offset)
        .limit(FIXTURES_PER_CYCLE)
        .lean()
        .exec()) as any[];
      let batch = await loadBatch();
      // Fixture state can change during the five-minute count cache window.
      // If the cached offset points beyond the current result set, refresh the
      // count and retry from the first page rather than idling on an empty batch.
      if (!batch.length && this.offset > 0) {
        this.offset = 0;
        candidateCount = await this.getCandidateCount(fixtureFilter, true);
        batch = await loadBatch();
      }
      this.lastBatchSize = batch.length;
      this.offset += batch.length;
      if (this.offset >= candidateCount) this.offset = 0;

      // Keep API work bounded to this batch while the persistent offset rotates
      // through the complete eligible fixture set, not just the first page.
      const providerCollection =
        await this.oddsCollectionService.collectProviderQuotes(batch);
      let refreshed = 0;
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
        const refreshConcurrency = 4;
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
        }
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

  private async getCandidateCount(fixtureFilter: Record<string, any>, force = false): Promise<number> {
    const now = Date.now();
    if (force || this.candidateCountCache === 0
      || now - this.candidateCountRefreshedAt >= CANDIDATE_COUNT_REFRESH_MS) {
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
        .sort({ live: -1, fixtureDate: 1, eventId: 1 })
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

