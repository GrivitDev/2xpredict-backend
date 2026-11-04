// backend/src/sports/services/sports-startup.service.ts

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */

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
  private readonly fixtureIntegrityAuditTaskKey =
    'espn-fixture-integrity-audit';
  private readonly fixtureIntegrityAuditVersion =
    'monthly-source-reconciliation-v1';
  private readonly fixtureIntegrityAuditIntervalMs = 30 * 24 * 60 * 60_000;

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
    const timer = this.startupTimer as
      | (NodeJS.Timeout & { unref?: () => void })
      | undefined;
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  private getStartupRetryDelayMs(): number {
    const exponent = Math.min(Math.max(this.startupFailureCount - 1, 0), 10);
    return Math.min(
      this.startupRetryMaxMs,
      this.startupRetryBaseMs * 2 ** exponent,
    );
  }

  private toError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    if (typeof error === 'string' && error.trim()) {
      return new Error(error);
    }

    if (typeof error === 'object' && error !== null && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      return new Error(
        typeof message === 'string' ? message : 'Unknown error object',
      );
    }

    if (
      typeof error === 'number' ||
      typeof error === 'boolean' ||
      typeof error === 'bigint'
    ) {
      return new Error(String(error));
    }

    return new Error('Unknown error');
  }

  // ============================================================
  // STARTUP PIPELINE
  // ============================================================

  private async initializeEspn(): Promise<void> {
    if (this.startupStopping || this.startupCompleted || this.startupRunning)
      return;

    this.startupRunning = true;
    let fixtureIntegrityAuditStarted = false;
    try {
      // PHASE 1: refresh and verify the complete persisted catalogue.
      const leagues =
        await this.espnActiveCompetitionService.synchronizeLeagueCatalogue();
      await this.espnActiveCompetitionService.assertLeagueCatalogueComplete();
      this.logger.log(
        `ESPN league catalogue verified: ${leagues.length} competitions`,
      );

      // PHASE 2: repair missing/incomplete details with bounded concurrency.
      const detailResult =
        await this.espnActiveCompetitionService.synchronizeMissingLeagueDetails();
      if (detailResult.failed > 0 || detailResult.skipped > 0) {
        throw new Error(
          `ESPN league-detail phase incomplete: failed=${detailResult.failed}, skipped=${detailResult.skipped}`,
        );
      }
      await this.espnActiveCompetitionService.assertLeagueDetailsComplete();
      this.logger.log(
        `ESPN league details verified: catalogue=${leagues.length}, ` +
          `processed=${detailResult.processed}, synchronized=${detailResult.synchronized}, ` +
          `active=${detailResult.active}, inactive=${detailResult.inactive}`,
      );

      const activeLeagues =
        await this.espnActiveCompetitionService.getActiveLeagues();
      const leagueContexts = await this.prepareLeagueContexts(activeLeagues);
      this.logger.log(
        `Preparing mandatory ESPN data bootstrap: activeSeasons=${leagueContexts.length}`,
      );

      // The first run after this integrity version is deployed, and then every
      // 30 days, re-request every previously successful month. That repairs
      // old partial-success ledgers without deleting any stored documents.
      const priorFixtureAudit = await this.sportsSyncStateService.getCronState(
        this.fixtureIntegrityAuditTaskKey,
      );
      const lastFixtureAuditAt = priorFixtureAudit?.lastSuccessfulAt
        ? new Date(priorFixtureAudit.lastSuccessfulAt)
        : undefined;
      const fixtureAuditDue =
        !priorFixtureAudit ||
        priorFixtureAudit.cronExpression !==
          this.fixtureIntegrityAuditVersion ||
        String(priorFixtureAudit.status) !== 'SUCCESS' ||
        !lastFixtureAuditAt ||
        Number.isNaN(lastFixtureAuditAt.getTime()) ||
        Date.now() - lastFixtureAuditAt.getTime() >=
          this.fixtureIntegrityAuditIntervalMs;

      await this.sportsSyncStateService.ensureCronState({
        taskKey: this.fixtureIntegrityAuditTaskKey,
        cronExpression: this.fixtureIntegrityAuditVersion,
        timeZone: 'UTC',
      });

      if (fixtureAuditDue) {
        await this.sportsSyncStateService.markCronStarted(
          this.fixtureIntegrityAuditTaskKey,
        );
        fixtureIntegrityAuditStarted = true;
        let reopenedMonths = 0;
        for (const context of leagueContexts) {
          reopenedMonths +=
            await this.sportsSyncStateService.reopenSuccessfulMonthUnitsForIntegrityAudit(
              context.fixtureStateKey,
            );
        }
        this.logger.warn(
          `Full ESPN fixture integrity audit required: reopened ${reopenedMonths} previously successful month(s). Existing fixture documents are preserved and refreshed from ESPN.`,
        );
      }

      // Seed standings before fixture ingestion so its independent workload can
      // run concurrently with the bounded fixture lane.
      const standingsSeed =
        await this.seedStartupStandingsRefreshes(leagueContexts);
      if (standingsSeed.skipped > 0) {
        throw new Error(
          `Could not queue initial standings refresh for ${standingsSeed.skipped} league-season(s)`,
        );
      }

      // PHASES 3 and 5: fixtures and standings have independent worker capacity.
      // Summary depends on the complete fixture catalogue and runs afterwards.
      const fixtureTask = this.runFixturePhase(leagueContexts).then(
        async (result) => {
          // Complete the audit marker as soon as fixture verification finishes;
          // a slow standings endpoint must not force a full fixture re-audit
          // after a process restart.
          if (fixtureIntegrityAuditStarted) {
            await this.sportsSyncStateService.markCronSuccess({
              taskKey: this.fixtureIntegrityAuditTaskKey,
              nextRunAt: new Date(
                Date.now() + this.fixtureIntegrityAuditIntervalMs,
              ),
            });
            fixtureIntegrityAuditStarted = false;
          }
          return result;
        },
      );
      const [fixturePhase, standingsPhase] = await Promise.allSettled([
        fixtureTask,
        this.espnQueueWorkerService.runStartupStandingsPhase(
          leagueContexts.map((context) => ({
            leagueId: context.leagueId,
            season: context.season,
            standingsStateKey: context.standingsStateKey,
          })),
        ),
      ]);
      if (fixturePhase.status === 'rejected') {
        throw this.toError(fixturePhase.reason);
      }
      if (standingsPhase.status === 'rejected') {
        throw this.toError(standingsPhase.reason);
      }
      const fixtureResult = fixturePhase.value;
      const standingsResult = standingsPhase.value;
      this.logger.log(
        `ESPN fixture phase verified for ${fixtureResult.leagues} league-seasons; ` +
          `months=${fixtureResult.verifiedMonths}`,
      );
      this.logger.log(
        `ESPN standings phase verified: required=${standingsSeed.queued + standingsSeed.alreadyComplete}, ` +
          `succeeded=${standingsResult.succeeded}, notApplicable=${standingsResult.unavailable}`,
      );

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
          // The full season date-range requests were valid and persisted, but
          // ESPN currently has no fixture documents for this season. Keep the
          // season lifecycle marker unset so the normal queue schedules a
          // six-hour recheck; this is not a failed fixture API request.
          this.logger.warn(
            `Fixture date-range coverage verified but ESPN returned no fixture documents for ${context.leagueId}/${context.season}; a delayed season bootstrap will recheck publication.`,
          );
        }
      }

      // PHASE 4: every historical Summary and every Summary currently inside
      // the provider's 72-hour availability horizon must exist in MongoDB.
      const summaryResult = await this.runStartupSummaryPhase(leagueContexts);
      this.logger.log(
        `ESPN Summary startup phase verified: checked=${summaryResult.checked}, ` +
          `missingAtStart=${summaryResult.missingSummary}, ` +
          `processed=${summaryResult.processed}`,
      );

      // FINAL AUDIT: re-check the source records, not just the queue state.
      await this.espnActiveCompetitionService.assertLeagueCatalogueComplete();
      await this.espnActiveCompetitionService.assertLeagueDetailsComplete();
      for (const context of leagueContexts) {
        await this.sportsSyncStateService.assertFixtureStartupComplete(
          context.leagueId,
          context.season,
        );
        if (getEspnStandingsPolicy(context.leagueId) !== 'NONE') {
          await this.espnStandingsService.assertStartupCollectionVerified(
            context.leagueId,
            context.season,
          );
        }
        const summaryWindow = this.getStartupSummaryWindow(context);
        if (summaryWindow) {
          const missing =
            await this.sportsSyncStateService.countMissingSummaryFixtures({
              leagueId: context.leagueId,
              season: context.season,
              kickoffWindowStart: summaryWindow.start,
              kickoffWindowEnd: summaryWindow.end,
            });
          if (missing > 0) {
            throw new Error(
              `Final Summary audit found ${missing} missing document(s) for ${context.leagueId}/${context.season}`,
            );
          }
        }
      }

      // Restore and seed normal queue records only after every mandatory dataset
      // has passed the final integrity audit. Consumers remain gated until below.
      const restored = await this.restoreNormalOperationsQueueStates();
      if (restored.skipped > 0) {
        throw new Error(
          `Normal queue-state restoration is incomplete: skipped=${restored.skipped}`,
        );
      }

      const initialQueue =
        await this.espnQueueBuilderService.buildDailyLeagueRefreshQueue();
      this.logger.log(
        `Initial normal ESPN fixture queue prepared: active=${initialQueue.active}, ` +
          `queued=${initialQueue.queued}, skipped=${initialQueue.skipped}`,
      );
      if (initialQueue.skipped > 0) {
        // Queue seeding is post-audit maintenance, not evidence that the
        // mandatory startup datasets are incomplete. Skipped jobs remain
        // visible in the operational logs and are re-evaluated by builders.
        this.logger.warn(
          `Initial normal ESPN queue had ${initialQueue.skipped} non-blocking skipped item(s); mandatory startup data has already passed verification.`,
        );
      }

      this.espnQueueService.markStartupReady();
      this.espnQueueService.markNormalOperationsReady();
      this.espnQueueWorkerService.start();
      this.logger.log(
        'ESPN startup integrity audit passed. Normal operations are now released.',
      );

      // This is derived work from already-persisted Summary payloads. It is safe
      // to run after release and does not hold the bootstrap barrier open.
      void this.sportsCollectionService
        .backfillSummaryNewsFromStoredFixtures()
        .then((result) => {
          if (!result.skipped) {
            this.logger.log(
              `ESPN Summary news backfill completed: scanned=${result.scanned}, upserted=${result.upserted}`,
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
    } catch (error) {
      const startupError = this.toError(error);
      this.startupFailureCount += 1;
      const retryDelayMs = this.getStartupRetryDelayMs();
      if (fixtureIntegrityAuditStarted) {
        await this.sportsSyncStateService
          .markCronFailure({
            taskKey: this.fixtureIntegrityAuditTaskKey,
            error: startupError,
            nextRunAt: new Date(Date.now() + retryDelayMs),
          })
          .catch((stateError: unknown) => {
            this.logger.error(
              `Could not persist fixture integrity audit failure: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
            );
          });
      }
      this.logger.error(
        `ESPN startup bootstrap remains incomplete (attempt ${this.startupFailureCount}). ` +
          `Normal operations remain locked; retrying in ${Math.ceil(retryDelayMs / 1000)}s.`,
        startupError.stack,
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
      const policy = getEspnStandingsPolicy(context.leagueId);

      if (policy === 'NONE') {
        const reason = `Standings not applicable for competition format: ${context.leagueId}/${context.season}`;
        await this.espnStandingsService.markNotApplicable(
          context.leagueId,
          context.season,
        );
        await this.sportsSyncStateService.markStepUnavailable(
          context.standingsStateKey,
          'STANDINGS_INITIAL',
          reason,
        );
        await this.sportsSyncStateService.markStepUnavailable(
          context.standingsStateKey,
          'STANDINGS_REFRESH',
          reason,
        );
        await this.sportsSyncStateService.refreshOverallStatus(
          context.standingsStateKey,
        );
        unavailable += 1;
        continue;
      }

      let unitSuccessful = await this.sportsSyncStateService.isUnitSuccessful(
        context.standingsStateKey,
        'STEP:STANDINGS_INITIAL',
      );

      // A previous SUCCESS marker is reusable only while the corresponding
      // snapshot and its complete stage coverage still exist in MongoDB.
      if (unitSuccessful) {
        try {
          await this.espnStandingsService.assertStartupCollectionVerified(
            context.leagueId,
            context.season,
          );
          alreadyComplete += 1;
          continue;
        } catch (error) {
          this.logger.warn(
            `Standings integrity check reopened ${context.leagueId}/${context.season}: ${error instanceof Error ? error.message : String(error)}`,
          );
          await this.sportsSyncStateService.resetStepForRefresh(
            context.standingsStateKey,
            'STANDINGS_INITIAL',
          );
          await this.sportsSyncStateService.resetStepForRefresh(
            context.standingsStateKey,
            'STANDINGS_REFRESH',
          );
          unitSuccessful = false;
        }
      }

      if (
        !unitSuccessful &&
        (await this.sportsSyncStateService.isUnitUnavailable(
          context.standingsStateKey,
          'STEP:STANDINGS_INITIAL',
        ))
      ) {
        // UNAVAILABLE is a terminal outcome only for explicit policy NONE.
        // Required/optional competitions are reopened and retried.
        await this.sportsSyncStateService.resetStepForRefresh(
          context.standingsStateKey,
          'STANDINGS_INITIAL',
        );
        await this.sportsSyncStateService.resetStepForRefresh(
          context.standingsStateKey,
          'STANDINGS_REFRESH',
        );
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
          if (
            job.status === EspnQueueStatus.FAILED &&
            String(job.lane) === 'QUARANTINE'
          ) {
            this.logger.error(
              `Required startup standings job is quarantined for ${context.leagueId}/${context.season}: ${job.lastError ?? 'no error detail'}`,
            );
          }
          queued += 1;
        } else if (job.status === EspnQueueStatus.COMPLETED) {
          const nowSuccessful =
            await this.sportsSyncStateService.isUnitSuccessful(
              context.standingsStateKey,
              'STEP:STANDINGS_INITIAL',
            );
          if (nowSuccessful) {
            await this.espnStandingsService.assertStartupCollectionVerified(
              context.leagueId,
              context.season,
            );
            alreadyComplete += 1;
          } else {
            // The durable job completed previously, but its source data did
            // not pass verification. The queue service will reopen this job.
            const retryJob = await this.espnQueueService.addStandingsRefreshJob(
              {
                leagueId: context.leagueId,
                season: context.season,
                priority: context.priority,
                scheduledFor: new Date(),
                triggerEventId: `STARTUP_STANDINGS:${context.season}`,
              },
            );
            if (retryJob.status === EspnQueueStatus.COMPLETED) {
              skipped += 1;
            } else {
              queued += 1;
            }
          }
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
  ): Promise<{ leagues: number; verifiedMonths: number }> {
    if (contexts.length === 0) return { leagues: 0, verifiedMonths: 0 };

    this.logger.log(
      `ESPN FIXTURE PHASE started: leagues=${contexts.length}, ` +
        `concurrency=${this.startupFixtureConcurrency}, granularity=MONTH`,
    );

    let contextCursor = 0;
    let verifiedMonths = 0;

    while (true) {
      const work: Array<{ context: StartupLeagueContext; monthKey: string }> =
        [];
      let visited = 0;

      // With one active league, use both bounded fixture slots on distinct
      // months. With multiple leagues, round-robin preserves cross-league
      // fairness and prevents one large competition from monopolising them.
      if (contexts.length === 1 && this.startupFixtureConcurrency > 1) {
        const context = contexts[0];
        const dueMonths =
          await this.sportsSyncStateService.getDueIncompleteMonths(
            context.fixtureStateKey,
            this.startupFixtureConcurrency,
          );
        for (const monthKey of dueMonths) {
          work.push({ context, monthKey });
        }
      } else {
        while (
          visited < contexts.length &&
          work.length < this.startupFixtureConcurrency
        ) {
          const context = contexts[contextCursor];
          contextCursor = (contextCursor + 1) % contexts.length;
          visited += 1;

          const dueMonths =
            await this.sportsSyncStateService.getDueIncompleteMonths(
              context.fixtureStateKey,
              1,
            );
          const monthKey = dueMonths[0];
          if (monthKey) work.push({ context, monthKey });
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
            verifiedMonths += 1;
            return;
          }
          failed += 1;
          this.logger.error(
            `Fixture bootstrap failed for ${item.context.leagueId} ${item.monthKey}: ${
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason)
            }. The month remains incomplete and will be retried.`,
          );
        });

        this.logger.log(
          `ESPN fixture startup batch completed: requested=${work.length}, ` +
            `verified=${succeeded}, failed=${failed}, duration=${Date.now() - startedAt}ms`,
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
        if (!progress.complete) allComplete = false;

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
        for (const context of contexts) {
          await this.sportsSyncStateService.assertFixtureStartupComplete(
            context.leagueId,
            context.season,
          );
        }
        this.logger.log(
          `ESPN FIXTURE PHASE fully verified: leagues=${contexts.length}, months=${verifiedMonths}`,
        );
        return { leagues: contexts.length, verifiedMonths };
      }

      if (earliestRetryAt) {
        const delay = Math.max(1_000, earliestRetryAt.getTime() - Date.now());
        this.logger.warn(
          `Fixture startup has incomplete months; next retry=${earliestRetryAt.toISOString()} wait=${Math.ceil(delay / 1000)}s`,
        );
        await this.sleep(Math.min(delay, 60_000));
      } else {
        // A processing unit may belong to a still-running owner after a
        // failover. Keep the gate closed and inspect again without busy-looping.
        await this.sleep(5_000);
      }
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
      const events = (seasonScopedResponse as { events: unknown[] }).events;
      const expectedIds = [
        ...new Set(
          events.map((event) => String((event as { id: unknown }).id)),
        ),
      ];

      const collection = await this.sportsCollectionService.collectEspnFixtures(
        leagueId,
        seasonScopedResponse,
        { suppressFollowUpTriggers: true, season },
      );
      const transformedUniqueCount = new Set(collection.fixtureIds).size;
      if (transformedUniqueCount !== expectedIds.length) {
        throw new Error(
          `Fixture transformation mismatch for ${leagueId}/${season}/${monthKey}: receivedUnique=${expectedIds.length}, transformedUnique=${transformedUniqueCount}`,
        );
      }

      await this.sportsCollectionService.assertEspnFixtureIdsPersisted(
        leagueId,
        season,
        expectedIds,
      );

      // A valid empty ESPN events array is a verified empty month. A missing
      // or malformed events array never reaches this success transition.
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
    const startupSummaryContexts: Array<{
      leagueId: string;
      season: number;
      summaryStateKey: string;
      kickoffWindowStart: Date;
      kickoffWindowEnd: Date;
      missingAtStart: number;
    }> = [];

    this.logger.log(
      `ESPN STARTUP SUMMARY PHASE started: full season history through the provider's ${SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.startupWindowHours}h upcoming availability horizon; enqueueBatch=${this.startupSummaryBatchSize}.`,
    );

    for (const context of contexts) {
      await this.sportsSyncStateService.assertFixtureStartupComplete(
        context.leagueId,
        context.season,
      );

      const window = this.getStartupSummaryWindow(context);
      if (!window) {
        this.logger.debug(
          `No startup Summary window is currently open for ${context.leagueId}/${context.season}; its season begins beyond the configured provider horizon.`,
        );
        continue;
      }

      const state = await this.sportsSyncStateService.ensureSummaryRefreshState(
        {
          leagueId: context.leagueId,
          season: context.season,
          priority: context.priority,
          trackingMode: 'WINDOW',
          kickoffWindowStart: window.start,
          kickoffWindowEnd: window.end,
        },
      );
      await this.sportsSyncStateService.resetInterruptedUnits(state.stateKey);

      const eligibleEventIds =
        await this.sportsSyncStateService.getSummaryEventIdsInWindow(
          state.stateKey,
          window.start,
          window.end,
        );
      const refreshedState = await this.sportsSyncStateService.requireState(
        state.stateKey,
      );
      const unitsByEvent = new Map<
        string,
        (typeof refreshedState.units)[number]
      >();
      for (const unit of refreshedState.units) {
        if (
          unit.type !== SportsSyncUnitType.STEP ||
          typeof unit.stepKey !== 'string' ||
          !unit.stepKey.startsWith('SUMMARY:')
        ) {
          continue;
        }
        unitsByEvent.set(unit.stepKey.slice('SUMMARY:'.length), unit);
      }

      const missingAtStart =
        await this.sportsSyncStateService.countMissingSummaryFixtures({
          leagueId: context.leagueId,
          season: context.season,
          kickoffWindowStart: window.start,
          kickoffWindowEnd: window.end,
        });
      checked += eligibleEventIds.size;
      missingSummary += missingAtStart;

      let batch: string[] = [];
      let missingUnits = 0;
      const enqueueBatch = async (): Promise<void> => {
        if (batch.length === 0) return;
        const eventIds = batch;
        batch = [];

        const results = await Promise.allSettled(
          eventIds.map((eventId) =>
            this.espnQueueService.addSummaryRefreshJob({
              leagueId: context.leagueId,
              eventId,
              season: context.season,
              priority: context.priority,
              scheduledFor: new Date(),
              triggerEventId: `STARTUP_SUMMARY:${eventId}`,
            }),
          ),
        );

        for (let index = 0; index < results.length; index += 1) {
          const result = results[index];
          const eventId = eventIds[index];
          if (result.status === 'rejected') {
            throw new Error(
              `Could not enqueue startup Summary ${context.leagueId}/${eventId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
            );
          }
          if (
            result.value.status === EspnQueueStatus.FAILED &&
            String(result.value.lane) === 'QUARANTINE'
          ) {
            throw new Error(
              `Startup Summary ${context.leagueId}/${eventId} is quarantined: ${result.value.lastError ?? 'no error detail'}`,
            );
          }
          queued += 1;
        }
      };

      for (const eventId of eligibleEventIds) {
        const unit = unitsByEvent.get(eventId);
        if (!unit) {
          throw new Error(
            `Summary reconciliation has no sync unit for persisted fixture ${context.leagueId}/${context.season}/${eventId}`,
          );
        }

        if (unit.status === SportsSyncUnitStatus.SUCCESS) {
          continue;
        }
        if (unit.status === SportsSyncUnitStatus.UNAVAILABLE) {
          throw new Error(
            `Startup Summary is marked unavailable for ${context.leagueId}/${context.season}/${eventId}; it cannot satisfy the startup barrier`,
          );
        }
        if (unit.status === SportsSyncUnitStatus.PROCESSING) {
          throw new Error(
            `Startup Summary unit remains PROCESSING after interrupted-work recovery: ${context.leagueId}/${context.season}/${eventId}`,
          );
        }

        batch.push(eventId);
        missingUnits += 1;
        if (batch.length >= this.startupSummaryBatchSize) {
          await enqueueBatch();
        }
      }
      await enqueueBatch();
      if (missingUnits !== missingAtStart) {
        throw new Error(
          `Summary integrity reconciliation mismatch for ${context.leagueId}/${context.season}: databaseMissing=${missingAtStart}, missingUnits=${missingUnits}. One or more fixture records may have invalid event IDs or inconsistent sync state.`,
        );
      }

      startupSummaryContexts.push({
        leagueId: context.leagueId,
        season: context.season,
        summaryStateKey: state.stateKey,
        kickoffWindowStart: window.start,
        kickoffWindowEnd: window.end,
        missingAtStart,
      });

      this.logger.log(
        `Startup Summary work prepared: league=${context.leagueId}, fixtures=${eligibleEventIds.size}, missing=${missingAtStart}, queued=${queued}`,
      );
    }

    const workerResult =
      await this.espnQueueWorkerService.runStartupSummaryPhase(
        startupSummaryContexts,
      );

    // The worker only returns after the database audit finds no missing
    // usable Summary payload in any required startup window.
    for (const context of startupSummaryContexts) {
      const missing =
        await this.sportsSyncStateService.countMissingSummaryFixtures({
          leagueId: context.leagueId,
          season: context.season,
          kickoffWindowStart: context.kickoffWindowStart,
          kickoffWindowEnd: context.kickoffWindowEnd,
        });
      if (missing > 0) {
        throw new Error(
          `Startup Summary phase ended with ${missing} missing payload(s) for ${context.leagueId}/${context.season}`,
        );
      }
    }

    this.logger.log(
      `ESPN STARTUP SUMMARY PHASE verified: fixturesChecked=${checked}, ` +
        `missingAtStart=${missingSummary}, queued=${queued}, ` +
        `persistedAndVerified=${workerResult.succeeded}`,
    );

    return {
      checked,
      missingSummary,
      processed: workerResult.succeeded,
      failedAttempts: workerResult.failed,
    };
  }

  private filterFixtureResponseToSeason(
    response: unknown,
    season: number,
    dateFrom: string,
    dateTo: string,
  ): unknown {
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new Error('ESPN monthly scoreboard response was not an object');
    }

    const record = response as Record<string, unknown>;
    const events = record.events;

    if (!Array.isArray(events)) {
      throw new Error(
        'ESPN monthly scoreboard response omitted the events array',
      );
    }

    for (const event of events) {
      if (!event || typeof event !== 'object') {
        throw new Error('ESPN monthly scoreboard contained a malformed event');
      }
      const eventRecord = event as Record<string, unknown>;
      const eventId = this.getString(eventRecord.id);
      const eventDate =
        typeof eventRecord.date === 'string'
          ? new Date(eventRecord.date)
          : new Date(Number.NaN);
      if (!eventId || Number.isNaN(eventDate.getTime())) {
        throw new Error(
          'ESPN monthly scoreboard contained an event without a valid ID or date',
        );
      }
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

  private getString(value: unknown): string | undefined {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return undefined;
    }
    const normalized = String(value).trim();
    return normalized || undefined;
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

  private getStartupSummaryWindow(
    context: StartupLeagueContext,
  ): { start: Date; end: Date } | undefined {
    const start = new Date(`${context.fixtureDateFrom}T00:00:00.000Z`);
    const seasonEnd = new Date(`${context.fixtureDateTo}T23:59:59.999Z`);
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(seasonEnd.getTime()) ||
      start.getTime() > seasonEnd.getTime()
    ) {
      throw new Error(
        `Invalid Summary startup date window for ${context.leagueId}/${context.season}`,
      );
    }

    const providerHorizon = new Date(
      Date.now() +
        SPORTS_DATA_COLLECTION_CONFIG.ESPN.summary.startupWindowHours *
          60 *
          60_000,
    );
    const end =
      providerHorizon.getTime() < seasonEnd.getTime()
        ? providerHorizon
        : seasonEnd;

    return start.getTime() <= end.getTime() ? { start, end } : undefined;
  }

  // ============================================================
  // DATE HELPERS
  // ============================================================

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
