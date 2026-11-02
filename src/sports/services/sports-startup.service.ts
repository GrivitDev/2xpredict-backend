// backend/src/sports/services/sports-startup.service.ts

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { EspnActiveCompetitionService } from './espn-active-competition.service';
import { EspnQueueService } from './espn-queue.service';
import { SportsSyncStateService } from './sports-sync-state.service';

import { CompetitionPriority } from '../enums/competition-priority.enum';
import {
  EspnQueueJobType,
  EspnQueueStatus,
} from '../interfaces/espn-queue.interface';

import {
  SportsSyncUnitStatus,
  SportsSyncUnitType,
} from '../schemas/sports-sync-state.schema';

import { EspnService } from '../providers/espn.service';

import { SportsCollectionService } from './sports-collection.service';
import { EspnQueueBuilderService } from './espn-queue-builder.service';
import { EspnStandingsService } from './espn-standings.service';
import { EspnQueueWorkerService } from './espn-queue-worker.service';

import { SPORTS_DATA_COLLECTION_CONFIG } from '../config/sports-data-collection.config';
import { getEspnStandingsPolicy } from '../config/priority-competitions.config';

// ============================================================
// TYPES
// ============================================================

type ActiveLeague = Awaited<
  ReturnType<EspnActiveCompetitionService['getActiveLeagues']>
>[number];

interface StartupLeagueContext {
  league: ActiveLeague;
  leagueId: string;
  season: number;
  priority: number;
  fixtureDateFrom: string;
  fixtureDateTo: string;
  fixtureStateKey: string;
  summaryStateKey: string;
  standingsStateKey: string;
}

// ============================================================
// SERVICE
// ============================================================

@Injectable()
export class SportsStartupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SportsStartupService.name);

  private readonly startupFixtureConcurrency =
    SPORTS_DATA_COLLECTION_CONFIG.ESPN.fixtures.startupConcurrency;

  private readonly startupSummaryBatchSize =
    SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.startupBatchSize;

  private readonly seasonCollectionInProgress = new Set<string>();

  /** Startup is a durable gate: transient boot failures must not leave ESPN locked forever. */
  private startupTimer?: NodeJS.Timeout;
  private startupRunning = false;
  private startupCompleted = false;
  private startupStopping = false;
  private startupFailureCount = 0;
  private readonly startupRetryBaseMs = 5_000;
  private readonly startupRetryMaxMs = 5 * 60_000;

  constructor(
    private readonly espnService: EspnService,

    private readonly espnActiveCompetitionService: EspnActiveCompetitionService,

    private readonly espnQueueService: EspnQueueService,

    private readonly espnQueueBuilderService: EspnQueueBuilderService,

    private readonly espnQueueWorkerService: EspnQueueWorkerService,

    private readonly sportsCollectionService: SportsCollectionService,

    private readonly sportsSyncStateService: SportsSyncStateService,

    private readonly espnStandingsService: EspnStandingsService,
  ) {}

  // ============================================================
  // MODULE INIT
  // ============================================================

  onModuleInit(): void {
    this.logger.log('Starting ESPN background initialization');
    this.scheduleStartupAttempt(0);
  }

  onModuleDestroy(): void {
    this.startupStopping = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
  }

  private scheduleStartupAttempt(delayMs: number): void {
    if (this.startupStopping || this.startupCompleted || this.startupRunning)
      return;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = setTimeout(
      () => {
        this.startupTimer = undefined;
        void this.initializeEspn();
      },
      Math.max(0, delayMs),
    );
    this.startupTimer.unref?.();
  }

  private getStartupRetryDelayMs(): number {
    const exponent = Math.min(Math.max(this.startupFailureCount - 1, 0), 10);
    return Math.min(
      this.startupRetryMaxMs,
      this.startupRetryBaseMs * 2 ** exponent,
    );
  }

  // ============================================================
  // STARTUP PIPELINE
  // ============================================================

  private async initializeEspn(): Promise<void> {
    if (this.startupStopping || this.startupCompleted || this.startupRunning)
      return;
    this.startupRunning = true;
    try {
      // --------------------------------------------------------
      // PHASE 1
      // LEAGUE CATALOGUE
      // --------------------------------------------------------

      const leagues =
        await this.espnActiveCompetitionService.synchronizeLeagueCatalogue();

      this.logger.log(
        `ESPN league catalogue synchronized: ${leagues.length} leagues`,
      );

      // --------------------------------------------------------
      // PHASE 2
      // LEAGUE DETAILS
      // --------------------------------------------------------

      const detailResult =
        await this.espnActiveCompetitionService.synchronizeMissingLeagueDetails();

      this.logger.log(
        `ESPN missing league-detail synchronization completed: ` +
          `processed=${detailResult.processed}, ` +
          `synchronized=${detailResult.synchronized}, ` +
          `active=${detailResult.active}, ` +
          `inactive=${detailResult.inactive}, ` +
          `skipped=${detailResult.skipped}, ` +
          `failed=${detailResult.failed}`,
      );

      // --------------------------------------------------------
      // AUTHORITATIVE ACTIVE LEAGUE LIST
      // --------------------------------------------------------

      const activeLeagues =
        await this.espnActiveCompetitionService.getActiveLeagues();

      this.logger.log(
        `Preparing ESPN startup pipeline for ${activeLeagues.length} active leagues`,
      );

      // --------------------------------------------------------
      // PREPARE FIXTURE SYNCHRONIZATION STATES
      //
      // Fixture and standings states are prepared here.
      // SUMMARY_REFRESH state is deliberately not reconciled until
      // every fixture state has completed.
      // --------------------------------------------------------

      const leagueContexts = await this.prepareLeagueContexts(activeLeagues);

      this.logger.log(
        `ESPN fixture synchronization states prepared: leagues=${leagueContexts.length}`,
      );

      // --------------------------------------------------------
      // PHASE 3
      // FIXTURE COLLECTION
      // --------------------------------------------------------

      await this.runFixturePhase(leagueContexts);

      for (const context of leagueContexts) {
        await this.sportsSyncStateService.assertFixtureStartupComplete(
          context.leagueId,
          context.season,
        );
        const catalogueReady =
          await this.espnActiveCompetitionService.markSeasonFixturesCollected(
            context.leagueId,
            context.season,
          );

        if (!catalogueReady) {
          // Keep the completed startup ledger intact so the global startup
          // barrier can release normally. A persistent season-bootstrap job
          // retries the MONTH units after the six-hour empty-catalogue cooldown.
          this.logger.warn(
            `ESPN has not published fixture documents for ${context.leagueId}/${context.season}; ` +
              'a persistent season-bootstrap job will retry the catalogue after its cooldown',
          );
        }
      }

      this.logger.log('ESPN FIXTURE PHASE completed. Moving to SUMMARY PHASE.');

      // --------------------------------------------------------
      // PHASE 4
      // SUMMARY COLLECTION
      // --------------------------------------------------------

      await this.runStartupSummaryPhase(leagueContexts);

      this.logger.log('ESPN Summary startup phase completed');

      // --------------------------------------------------------
      // PHASE 5
      // STANDINGS REFRESH
      // Queue and fully process one initial ESPN standings refresh for every
      // active league/season. Normal operations remain locked until every job
      // succeeds or reaches an explicit terminal failure/unavailable outcome.
      // --------------------------------------------------------

      const standingsSeed =
        await this.seedStartupStandingsRefreshes(leagueContexts);
      this.logger.log(
        `ESPN initial standings jobs prepared: ` +
          `queued=${standingsSeed.queued}, alreadyComplete=${standingsSeed.alreadyComplete}, ` +
          `alreadyUnavailable=${standingsSeed.unavailable}, failedToQueue=${standingsSeed.skipped}`,
      );

      if (standingsSeed.skipped > 0) {
        throw new Error(
          `Could not queue initial standings refresh for ${standingsSeed.skipped} active league-season(s)`,
        );
      }

      const standingsResult =
        await this.espnQueueWorkerService.runStartupStandingsPhase(
          leagueContexts.map((context) => ({
            leagueId: context.leagueId,
            season: context.season,
            standingsStateKey: context.standingsStateKey,
          })),
        );

      this.logger.log(
        `ESPN STANDINGS PHASE completed: ` +
          `active=${leagueContexts.length}, succeeded=${standingsResult.succeeded}, ` +
          `unavailable=${standingsResult.unavailable}, failed=${standingsResult.failed}`,
      );

      // --------------------------------------------------------
      // FINAL STATE VALIDATION
      // --------------------------------------------------------

      for (const context of leagueContexts) {
        await this.sportsSyncStateService.assertFixtureStartupComplete(
          context.leagueId,
          context.season,
        );
      }

      // --------------------------------------------------------
      // RESTORE NORMAL OPERATIONS
      // --------------------------------------------------------

      const restored = await this.restoreNormalOperationsQueueStates();

      this.logger.log(
        `ESPN normal queue-state restoration completed: ` +
          `states=${restored.states}, ` +
          `queued=${restored.queued}, ` +
          `skipped=${restored.skipped}`,
      );

      // --------------------------------------------------------
      // INITIAL NORMAL FIXTURE REFRESH QUEUE
      // --------------------------------------------------------

      const initialQueue =
        await this.espnQueueBuilderService.buildDailyLeagueRefreshQueue();

      this.logger.log(
        `Initial normal ESPN fixture-refresh queue created: ` +
          `active=${initialQueue.active}, ` +
          `queued=${initialQueue.queued}, ` +
          `skipped=${initialQueue.skipped}`,
      );

      // --------------------------------------------------------
      // RELEASE NORMAL OPERATIONS
      // --------------------------------------------------------

      this.espnQueueService.markStartupReady();

      this.espnQueueService.markNormalOperationsReady();

      this.logger.log(
        'ESPN startup bootstrap is completely finished. ' +
          'Normal operations are now released.',
      );

      this.espnQueueWorkerService.start();

      // News is extracted from saved Summaries into sports_espn_news.
      // Backfill older stored Summaries in the background without blocking
      // normal queue operations. Once normalized feed records exist, this
      // one-time backfill is skipped on subsequent starts.
      void this.sportsCollectionService
        .backfillSummaryNewsFromStoredFixtures()
        .then((result) => {
          if (!result.skipped) {
            this.logger.log(
              `ESPN Summary news backfill completed: scanned=${result.scanned}, ` +
                `upserted=${result.upserted}`,
            );
          }
        })
        .catch((error) => {
          this.logger.warn(
            `ESPN Summary news backfill failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });

      this.startupCompleted = true;
      this.startupFailureCount = 0;
      this.logger.log(
        'ESPN startup retry guard marked initialization complete',
      );
    } catch (error) {
      this.startupFailureCount += 1;
      const retryDelayMs = this.getStartupRetryDelayMs();
      this.logger.error(
        `ESPN startup bootstrap failed (attempt ${this.startupFailureCount}). ` +
          `Sports synchronization remains locked; retrying in ${Math.ceil(retryDelayMs / 1000)}s.`,
        error instanceof Error ? error.stack : String(error),
      );
      this.startupRunning = false;
      this.scheduleStartupAttempt(retryDelayMs);
    } finally {
      this.startupRunning = false;
    }
  }

  // ============================================================
  // NEW-SEASON FIXTURE COLLECTION
  // ============================================================

  /**
   * Reuses the same bounded month-based fixture pipeline used at startup for
   * one newly active season. It does not lock normal operations globally and
   * does not rerun the expensive all-fixtures Summary startup phase.
   */
  async collectNewSeasonFixtures(
    leagueId: string,
    season: number,
  ): Promise<void> {
    const normalizedLeagueId = leagueId.trim().toLowerCase();
    if (!normalizedLeagueId || !Number.isInteger(season)) {
      throw new Error('New-season collection requires leagueId and season');
    }

    const collectionKey = `${normalizedLeagueId}:${season}`;
    if (this.seasonCollectionInProgress.has(collectionKey)) {
      return;
    }

    this.seasonCollectionInProgress.add(collectionKey);

    try {
      const activeLeagues =
        await this.espnActiveCompetitionService.getActiveLeagues();
      const league = activeLeagues.find(
        (candidate) =>
          candidate.season === season &&
          [candidate.leagueId, candidate.slug]
            .filter((value): value is string => typeof value === 'string')
            .some((value) => value.trim().toLowerCase() === normalizedLeagueId),
      );

      if (!league?.isActive) {
        this.logger.warn(
          `Skipping new-season fixture collection for ${normalizedLeagueId}/${season}: league is not currently active`,
        );
        return;
      }

      const contexts = await this.prepareLeagueContexts([league]);
      if (contexts.length !== 1) {
        throw new Error(
          `Could not prepare fixture state for ${normalizedLeagueId}/${season}`,
        );
      }

      // The previous catalogue attempt completed successfully but returned no
      // fixture documents. Reopen month units only here, after the lifecycle
      // cooldown, not during initial startup (which must still release its
      // global fixture barrier).
      if (
        league.fixtureCollectionAttemptSeason === season &&
        league.fixturesCollectedSeason !== season
      ) {
        const resetMonths =
          await this.sportsSyncStateService.resetMonthUnitsForRetry(
            contexts[0].fixtureStateKey,
          );
        this.logger.log(
          `Reopened ${resetMonths} month unit(s) for ${normalizedLeagueId}/${season} after the empty-catalogue cooldown`,
        );
      }

      await this.runFixturePhase(contexts);
      await this.sportsSyncStateService.assertFixtureStartupComplete(
        contexts[0].leagueId,
        contexts[0].season,
      );
      const catalogueReady =
        await this.espnActiveCompetitionService.markSeasonFixturesCollected(
          contexts[0].leagueId,
          contexts[0].season,
        );

      if (!catalogueReady) {
        const resetMonths =
          await this.sportsSyncStateService.resetMonthUnitsForRetry(
            contexts[0].fixtureStateKey,
          );
        this.logger.warn(
          `ESPN has not published fixture documents for ${normalizedLeagueId}/${season}; ` +
            `${resetMonths} season-month units will be retried by a persistent lifecycle job`,
        );
        return;
      }

      // Start the configured upcoming 60-hour Summary freshness work immediately.
      const summaryResult =
        await this.espnQueueBuilderService.buildSummaryRefreshQueue({
          leagueId: normalizedLeagueId,
          season,
        });
      const postMatchResult =
        await this.espnQueueBuilderService.buildPostMatchCheckQueue({
          leagueId: normalizedLeagueId,
          season,
        });

      this.logger.log(
        `New-season fixture catalogue completed for ${normalizedLeagueId}/${season}; ` +
          `Summary jobs queued=${summaryResult.queued}, ` +
          `post-match jobs queued=${postMatchResult.queued}`,
      );
    } catch (error) {
      this.logger.error(
        `New-season fixture collection failed for ${normalizedLeagueId}/${season}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    } finally {
      this.seasonCollectionInProgress.delete(collectionKey);
    }
  }

  // ============================================================
  // PREPARE LEAGUE CONTEXTS
  // ============================================================

  private async prepareLeagueContexts(
    activeLeagues: ActiveLeague[],
  ): Promise<StartupLeagueContext[]> {
    const contexts: StartupLeagueContext[] = [];

    for (const league of activeLeagues) {
      if (!league.isActive) {
        continue;
      }

      if (typeof league.season !== 'number') {
        throw new Error(`Active league ${league.leagueId} has no valid season`);
      }

      if (!league.seasonStartDate || !league.seasonEndDate) {
        throw new Error(
          `Active league ${league.leagueId} requires both seasonStartDate and seasonEndDate`,
        );
      }

      const leagueId = (league.slug || league.leagueId).trim().toLowerCase();

      if (!leagueId) {
        throw new Error('Active league has no valid ESPN league ID');
      }

      const priority = this.getQueuePriority(league.priority);

      // --------------------------------------------------------
      // FIXTURE STATE
      //
      // This is the only synchronization state prepared here.
      // --------------------------------------------------------

      const seasonStartDate = new Date(league.seasonStartDate);
      const seasonEndDate = new Date(league.seasonEndDate);

      if (
        Number.isNaN(seasonStartDate.getTime()) ||
        Number.isNaN(seasonEndDate.getTime())
      ) {
        throw new Error(
          `Active league ${league.leagueId} has an invalid season start or end date`,
        );
      }

      // Startup fixture state covers every calendar month in the season.
      const fixtureDateFrom = this.toDateOnly(seasonStartDate);
      const fixtureDateTo = this.toDateOnly(seasonEndDate);
      if (fixtureDateFrom > fixtureDateTo) {
        throw new Error(
          `Active league ${league.leagueId} has a season start date after its end date`,
        );
      }

      const fixtureState =
        await this.sportsSyncStateService.ensureFixtureRefreshState({
          leagueId,
          season: league.season,
          priority,

          dateFrom: fixtureDateFrom,

          dateTo: fixtureDateTo,

          trackingMode: 'HISTORY',
          granularity: 'MONTH',
        });

      await this.sportsSyncStateService.resetInterruptedUnits(
        fixtureState.stateKey,
      );

      // --------------------------------------------------------
      // STANDINGS STATE
      // One persistent state and explicit completion unit per active season.
      // The initial job is seeded after fixture/summary startup phases finish.
      // --------------------------------------------------------

      const standingsState = await this.sportsSyncStateService.ensureQueueState(
        {
          jobType: EspnQueueJobType.STANDINGS_REFRESH,
          leagueId,
          season: league.season,
          priority,
          trackingMode: 'HISTORY',
        },
      );
      await this.sportsSyncStateService.ensureStepUnits(
        standingsState.stateKey,
        ['STANDINGS_INITIAL', 'STANDINGS_REFRESH'],
      );
      await this.sportsSyncStateService.resetInterruptedUnits(
        standingsState.stateKey,
      );

      // --------------------------------------------------------
      // SUMMARY STATE KEY
      //
      // Do not create/reconcile Summary state yet.
      // --------------------------------------------------------

      const summaryStateKey = this.sportsSyncStateService.getQueueStateKey({
        jobType: EspnQueueJobType.SUMMARY_REFRESH,
        leagueId,
        season: league.season,
      });

      contexts.push({
        league,
        leagueId,
        season: league.season,
        priority,
        fixtureDateFrom,
        fixtureDateTo,
        fixtureStateKey: fixtureState.stateKey,
        summaryStateKey,
        standingsStateKey: standingsState.stateKey,
      });
    }

    return contexts;
  }

  private async seedStartupStandingsRefreshes(
    contexts: StartupLeagueContext[],
  ): Promise<{
    queued: number;
    alreadyComplete: number;
    unavailable: number;
    skipped: number;
  }> {
    let queued = 0;
    let alreadyComplete = 0;
    let unavailable = 0;
    let skipped = 0;

    for (const context of contexts) {
      const unitSuccessful = await this.sportsSyncStateService.isUnitSuccessful(
        context.standingsStateKey,
        'STEP:STANDINGS_INITIAL',
      );
      if (unitSuccessful) {
        alreadyComplete += 1;
        continue;
      }

      if (getEspnStandingsPolicy(context.leagueId) === 'NONE') {
        const reason = `Standings not applicable for competition format: ${context.leagueId}/${context.season}`;
        await this.espnStandingsService.markNotApplicable(context.leagueId, context.season);
        await this.sportsSyncStateService.markStepUnavailable(
          context.standingsStateKey,
          'STANDINGS_INITIAL',
          reason,
        );
        const refreshSuccessful = await this.sportsSyncStateService.isUnitSuccessful(
          context.standingsStateKey,
          'STEP:STANDINGS_REFRESH',
        );
        if (!refreshSuccessful) {
          await this.sportsSyncStateService.markStepUnavailable(
            context.standingsStateKey,
            'STANDINGS_REFRESH',
            reason,
          );
        }
        await this.sportsSyncStateService
          .refreshOverallStatus(context.standingsStateKey)
          .catch(() => undefined);
        unavailable += 1;
        this.logger.debug(
          `Initial standings skipped: league=${context.leagueId} season=${context.season} policy=NONE`,
        );
        continue;
      }
      if (
        await this.sportsSyncStateService.isUnitUnavailable(
          context.standingsStateKey,
          'STEP:STANDINGS_INITIAL',
        )
      ) {
        unavailable += 1;
        continue;
      }

      try {
        const job = await this.espnQueueService.addStandingsRefreshJob({
          leagueId: context.leagueId,
          season: context.season,
          priority: context.priority,
          scheduledFor: new Date(),
          triggerEventId: `STARTUP_STANDINGS:${context.season}`,
        });
        if (
          job.status === EspnQueueStatus.PENDING ||
          job.status === EspnQueueStatus.PROCESSING ||
          job.status === EspnQueueStatus.FAILED
        ) {
          queued += 1;
        } else if (job.status === EspnQueueStatus.COMPLETED) {
          const nowSuccessful =
            await this.sportsSyncStateService.isUnitSuccessful(
              context.standingsStateKey,
              'STEP:STANDINGS_INITIAL',
            );
          if (nowSuccessful) alreadyComplete += 1;
          else queued += 1;
        } else {
          skipped += 1;
        }
      } catch (error) {
        skipped += 1;
        this.logger.error(
          `Could not seed initial standings refresh for ${context.leagueId}/${context.season}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { queued, alreadyComplete, unavailable, skipped };
  }

  // ============================================================
  // PHASE 3
  // FIXTURE COLLECTION
  // ============================================================

  private async runFixturePhase(
    contexts: StartupLeagueContext[],
  ): Promise<void> {
    this.logger.log(
      `ESPN FIXTURE PHASE started: leagues=${contexts.length}, ` +
        `concurrency=${this.startupFixtureConcurrency}, ` +
        `granularity=MONTH`,
    );

    while (true) {
      const work: Array<{
        context: StartupLeagueContext;
        monthKey: string;
      }> = [];

      /*
       * Fill one bounded global work batch. The worker pool is shared across
       * all leagues so a single league cannot consume more than the available
       * startup concurrency indefinitely.
       */
      for (const context of contexts) {
        if (work.length >= this.startupFixtureConcurrency) {
          break;
        }

        const remaining = this.startupFixtureConcurrency - work.length;
        const dueMonths =
          await this.sportsSyncStateService.getDueIncompleteMonths(
            context.fixtureStateKey,
            remaining,
          );

        for (const monthKey of dueMonths) {
          work.push({
            context,
            monthKey,
          });

          if (work.length >= this.startupFixtureConcurrency) {
            break;
          }
        }
      }

      if (work.length > 0) {
        const startedAt = Date.now();

        const results = await Promise.allSettled(
          work.map(({ context, monthKey }) =>
            this.processFixtureMonth(
              context.fixtureStateKey,
              context.leagueId,
              context.season,
              monthKey,
              context.fixtureDateFrom,
              context.fixtureDateTo,
            ),
          ),
        );

        let succeeded = 0;
        let failed = 0;

        results.forEach((result, index) => {
          const item = work[index];

          if (result.status === 'fulfilled') {
            succeeded += 1;
            return;
          }

          failed += 1;

          this.logger.error(
            `Fixture bootstrap failed for ${item.context.leagueId} ` +
              `${item.monthKey}: ${
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason)
              }. The month will be retried by sync state.`,
          );
        });

        this.logger.log(
          `ESPN fixture startup batch completed: ` +
            `requested=${work.length}, ` +
            `succeeded=${succeeded}, ` +
            `failed=${failed}, ` +
            `duration=${Date.now() - startedAt}ms`,
        );

        continue;
      }

      let allComplete = true;
      let earliestRetryAt: Date | null = null;

      for (const context of contexts) {
        const progress =
          await this.sportsSyncStateService.getFixtureStartupProgress(
            context.fixtureStateKey,
          );

        this.logger.log(
          `ESPN fixture startup progress ${context.leagueId}: ` +
            `${progress.successMonths}/${progress.totalMonths} months ` +
            `(${progress.completionPercent.toFixed(1)}%)`,
        );

        if (!progress.complete) {
          allComplete = false;
        }

        const nextRetryAt =
          await this.sportsSyncStateService.getNextIncompleteMonthRetryAt(
            context.fixtureStateKey,
          );

        if (
          nextRetryAt &&
          (!earliestRetryAt ||
            nextRetryAt.getTime() < earliestRetryAt.getTime())
        ) {
          earliestRetryAt = nextRetryAt;
        }
      }

      if (allComplete) {
        await Promise.all(
          contexts.map((context) =>
            this.sportsSyncStateService.refreshOverallStatus(
              context.fixtureStateKey,
            ),
          ),
        );

        const terminalFailures = (
          await Promise.all(
            contexts.map((context) =>
              this.sportsSyncStateService.getFixtureStartupProgress(
                context.fixtureStateKey,
              ),
            ),
          )
        ).reduce((total, progress) => total + progress.terminalFailedMonths, 0);
        if (terminalFailures > 0) {
          this.logger.warn(
            `ESPN FIXTURE PHASE resolved with ${terminalFailures} terminal month failure(s); summary processing will continue for available fixtures.`,
          );
        } else {
          this.logger.log('ESPN FIXTURE PHASE completed successfully');
        }
        return;
      }

      if (earliestRetryAt) {
        const delay = Math.max(0, earliestRetryAt.getTime() - Date.now());

        this.logger.warn(
          `Fixture startup waiting for next retry at ` +
            `${earliestRetryAt.toISOString()} (wait=${delay}ms)`,
        );

        await this.sleep(delay);
        continue;
      }

      await this.sleep(1000);
    }
  }

  private async processFixtureMonth(
    stateKey: string,
    leagueId: string,
    season: number,
    monthKey: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<void> {
    await this.sportsSyncStateService.markMonthProcessing(stateKey, monthKey);

    try {
      const response = await this.espnService.getFixturesForMonth(
        leagueId,
        monthKey,
      );

      const seasonScopedResponse = this.filterFixtureResponseToSeason(
        response,
        season,
        dateFrom,
        dateTo,
      );

      await this.sportsCollectionService.collectEspnFixtures(
        leagueId,
        seasonScopedResponse,
      );

      /*
       * A successful ESPN month request is a successful synchronization even
       * when the month contains zero fixtures. This is why MONTH units are
       * not inferred from fixture-document existence.
       */
      await this.sportsSyncStateService.markMonthSuccess(stateKey, monthKey);
    } catch (error) {
      await this.sportsSyncStateService.markMonthFailed(
        stateKey,
        monthKey,
        error,
      );

      throw error;
    }
  }

  // ============================================================
  // PHASE 4
  // SUMMARY COLLECTION
  // ============================================================

  private async runStartupSummaryPhase(
    contexts: StartupLeagueContext[],
  ): Promise<{
    checked: number;
    missingSummary: number;
    processed: number;
    failedAttempts: number;
  }> {
    let checked = 0;
    let missingSummary = 0;
    let queued = 0;

    const startupWindowStart = new Date();
    const startupWindowEnd = new Date(
      startupWindowStart.getTime() +
        SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.startupWindowHours *
          60 *
          60_000,
    );

    this.logger.log(
      `ESPN STARTUP SUMMARY PHASE started: seasonStart-to-upcomingWindowHours=${SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.startupWindowHours}, ` +
        `batchSize=${this.startupSummaryBatchSize}. Summary jobs cover each active season from its first calendar day through ${startupWindowEnd.toISOString()} and are processed by the durable queue.`,
    );

    // Fixture collection must complete before Summary state is reconciled.
    for (const context of contexts) {
      await this.sportsSyncStateService.assertFixtureStartupComplete(
        context.leagueId,
        context.season,
      );
    }

    const retryScheduledFor = new Date(
      Date.now() +
        SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.retryDelayMinutes * 60_000,
    );
    const jobs: Array<{
      leagueId: string;
      eventId: string;
      season: number;
      priority: number;
      scheduledFor: Date;
    }> = [];

    for (const context of contexts) {
      // The initial Summary phase covers the season from its first calendar
      // day through the rolling 66-hour-ahead boundary. It must include past,
      // live and completed fixtures too; completed matches are still useful
      // Summary/history evidence for downstream systems.
      const seasonStartDate = new Date(
        `${context.fixtureDateFrom}T00:00:00.000Z`,
      );
      if (!Number.isFinite(seasonStartDate.getTime())) {
        throw new Error(
          `Invalid season start date for ${context.leagueId}/${context.season}: ${context.fixtureDateFrom}`,
        );
      }

      const state = await this.sportsSyncStateService.ensureSummaryRefreshState(
        {
          leagueId: context.leagueId,
          season: context.season,
          priority: context.priority,
          trackingMode: 'WINDOW',
          kickoffWindowStart: seasonStartDate,
          kickoffWindowEnd: startupWindowEnd,
        },
      );
      await this.sportsSyncStateService.resetInterruptedUnits(state.stateKey);

      const eligibleEventIds =
        await this.sportsSyncStateService.getSummaryEventIdsInWindow(
          state.stateKey,
          seasonStartDate,
          startupWindowEnd,
        );
      const refreshedState = await this.sportsSyncStateService.requireState(
        state.stateKey,
      );
      const eligibleSummaryUnits = refreshedState.units.filter(
        (unit) =>
          unit.type === SportsSyncUnitType.STEP &&
          typeof unit.stepKey === 'string' &&
          unit.stepKey.startsWith('SUMMARY:') &&
          eligibleEventIds.has(String(unit.stepKey).slice('SUMMARY:'.length)),
      );
      const summaryTotalAttempts =
        SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.maxAttempts + 1;
      const eligibleByEvent = new Map(
        eligibleSummaryUnits.map((unit) => [
          String(unit.stepKey).slice('SUMMARY:'.length),
          unit,
        ]),
      );

      const toQueue = [...eligibleByEvent.entries()].filter(
        ([, unit]) =>
          (unit.status === SportsSyncUnitStatus.PENDING &&
            unit.attempts === 0) ||
          ((unit.status === SportsSyncUnitStatus.PENDING ||
            unit.status === SportsSyncUnitStatus.FAILED) &&
            unit.attempts > 0 &&
            unit.attempts < summaryTotalAttempts),
      );
      checked += eligibleSummaryUnits.length;
      missingSummary += toQueue.length;

      for (const [eventId, unit] of toQueue) {
        jobs.push({
          leagueId: context.leagueId,
          eventId,
          season: context.season,
          priority: context.priority,
          scheduledFor:
            unit.attempts > 0 ? retryScheduledFor : startupWindowStart,
        });
      }
    }

    // Persist jobs in small concurrent writes. No ESPN HTTP calls happen in the
    // startup critical path; normal workers execute the queued Summary requests.
    const enqueueBatchSize = Math.max(1, this.startupSummaryBatchSize);
    for (let offset = 0; offset < jobs.length; offset += enqueueBatchSize) {
      const batch = jobs.slice(offset, offset + enqueueBatchSize);
      const results = await Promise.allSettled(
        batch.map((job) =>
          this.espnQueueService.addSummaryRefreshJob({
            ...job,
            triggerEventId: `STARTUP_SUMMARY_66H:${job.eventId}`,
          }),
        ),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') queued += 1;
        else
          this.logger.warn(
            `Could not queue startup Summary work: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
      }
    }

    this.logger.log(
      `ESPN STARTUP SUMMARY PHASE completed: checked=${checked}, missing=${missingSummary}, queued=${queued}, seasonStart-through-${SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.startupWindowHours}hAhead. Provider requests are delegated to the normal durable queue.`,
    );

    return {
      checked,
      missingSummary,
      processed: 0,
      failedAttempts: jobs.length - queued,
    };
  }

  private filterFixtureResponseToSeason(
    response: unknown,
    season: number,
    dateFrom: string,
    dateTo: string,
  ): unknown {
    if (!response || typeof response !== 'object') {
      return response;
    }

    const record = response as Record<string, unknown>;
    const events = record.events;

    if (!Array.isArray(events)) {
      return response;
    }

    const filteredEvents = events.filter((event) => {
      if (!event || typeof event !== 'object') {
        return false;
      }

      const eventRecord = event as Record<string, unknown>;
      const eventDate =
        typeof eventRecord.date === 'string'
          ? eventRecord.date.slice(0, 10)
          : '';
      if (!eventDate || eventDate < dateFrom || eventDate > dateTo)
        return false;

      const eventSeason = this.toNumber(
        (eventRecord.season as Record<string, unknown> | undefined)?.year,
      );

      if (eventSeason !== undefined) {
        return eventSeason === season;
      }

      const competitions = eventRecord.competitions;

      if (!Array.isArray(competitions) || !competitions[0]) {
        return true;
      }

      const firstCompetition = competitions[0] as Record<string, unknown>;
      const competitionSeason = this.toNumber(
        (firstCompetition.season as Record<string, unknown> | undefined)?.year,
      );

      return competitionSeason === undefined || competitionSeason === season;
    });

    return {
      ...record,
      events: filteredEvents,
    };
  }

  private toNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value.trim());

      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  // ============================================================
  // PERSISTENT QUEUE RESTORATION
  // ============================================================

  private async restoreNormalOperationsQueueStates(): Promise<{
    states: number;
    queued: number;
    skipped: number;
  }> {
    const states = await this.sportsSyncStateService.getIncompleteQueueStates([
      EspnQueueJobType.FIXTURE_REFRESH,
    ]);

    let queued = 0;
    let skipped = 0;

    for (const state of states) {
      if (!state.leagueId) {
        skipped += 1;
        continue;
      }

      try {
        if (typeof state.season !== 'number') {
          skipped += 1;
          continue;
        }

        const job = await this.espnQueueService.addFixtureRefreshJob({
          leagueId: state.leagueId,
          season: state.season,
          priority: state.priority ?? 4,
          scheduledFor: new Date(),
        });

        if (!job) {
          skipped += 1;
          continue;
        }

        if (
          String(job.status) === 'PENDING' &&
          Number(job.attempts ?? 0) === 0
        ) {
          queued += 1;
        }
      } catch (error) {
        skipped += 1;

        this.logger.error(
          `Failed to restore normal synchronization state ` +
            `${state.stateKey}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      states: states.length,
      queued,
      skipped,
    };
  }

  // ============================================================
  // PRIORITY
  // ============================================================

  private getQueuePriority(priority: CompetitionPriority | undefined): number {
    switch (priority) {
      case CompetitionPriority.ELITE:
        return 1;

      case CompetitionPriority.HIGH:
        return 2;

      case CompetitionPriority.REGIONAL:
        return 3;

      case CompetitionPriority.SELECTIVE:
      default:
        return 4;
    }
  }

  // ============================================================
  // DATE HELPERS
  // ============================================================

  private startOfUtcDay(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }

  private addUtcDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
  }

  private toDateOnly(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  // ============================================================
  // SLEEP
  // ============================================================

  private async sleep(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
}

