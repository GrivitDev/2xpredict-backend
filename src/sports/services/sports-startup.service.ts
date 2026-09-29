// backend/src/sports/services/sports-startup.service.ts

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { EspnActiveCompetitionService } from './espn-active-competition.service';
import { EspnQueueService } from './espn-queue.service';
import { SportsSyncStateService } from './sports-sync-state.service';

import { CompetitionPriority } from '../enums/competition-priority.enum';
import { EspnQueueJobType } from '../interfaces/espn-queue.interface';

import { EspnService } from '../providers/espn.service';

import { SportsCollectionService } from './sports-collection.service';
import { EspnQueueBuilderService } from './espn-queue-builder.service';
import { EspnQueueWorkerService } from './espn-queue-worker.service';

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

  fixtureStateKey: string;

  summaryStateKey: string;
}

// ============================================================
// SERVICE
// ============================================================

@Injectable()
export class SportsStartupService implements OnModuleInit {
  private readonly logger = new Logger(SportsStartupService.name);

  private readonly startupFixtureForwardDays = 8;

  /**
   * Summary requests are performed concurrently inside one league.
   *
   * The league itself remains sequential:
   *
   *   league 1 -> all summaries -> bulk write
   *   league 2 -> all summaries -> bulk write
   *   ...
   */
  private readonly startupSummaryConcurrency = 4;

  constructor(
    private readonly espnService: EspnService,

    private readonly espnActiveCompetitionService: EspnActiveCompetitionService,

    private readonly espnQueueService: EspnQueueService,

    private readonly espnQueueBuilderService: EspnQueueBuilderService,

    private readonly espnQueueWorkerService: EspnQueueWorkerService,

    private readonly sportsCollectionService: SportsCollectionService,

    private readonly sportsSyncStateService: SportsSyncStateService,
  ) {}

  // ============================================================
  // MODULE INIT
  // ============================================================

  onModuleInit(): void {
    this.logger.log('Starting ESPN background initialization');

    setTimeout(() => {
      void this.initializeEspn();
    }, 0);
  }

  // ============================================================
  // STARTUP PIPELINE
  // ============================================================

  private async initializeEspn(): Promise<void> {
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

      const activeLeagues =
        await this.espnActiveCompetitionService.getActiveLeagues();

      this.logger.log(
        `Preparing ESPN startup pipeline for ${activeLeagues.length} active leagues`,
      );

      // --------------------------------------------------------
      // PREPARE ACTIVE-LEAGUE SYNC STATES
      // --------------------------------------------------------

      const leagueContexts = await this.prepareLeagueContexts(activeLeagues);

      // --------------------------------------------------------
      // PHASE 3
      // FIXTURE COLLECTION
      // --------------------------------------------------------

      await this.runFixturePhase(leagueContexts);

      this.logger.log('ESPN FIXTURE PHASE completed. Moving to SUMMARY PHASE.');

      // --------------------------------------------------------
      // PHASE 4
      // SUMMARY COLLECTION
      //
      // Startup only synchronizes fixtures + summaries.
      // YouTube is deliberately not part of startup.
      // --------------------------------------------------------

      const summaryResult = await this.runStartupSummaryPhase(leagueContexts);

      this.logger.log(
        `ESPN SUMMARY PHASE completed: ` +
          `checked=${summaryResult.checked}, ` +
          `missing=${summaryResult.missingSummary}, ` +
          `processed=${summaryResult.processed}, ` +
          `skipped=${summaryResult.skipped}`,
      );

      // --------------------------------------------------------
      // FINAL STATE VALIDATION
      // --------------------------------------------------------

      for (const context of leagueContexts) {
        const fixtureComplete = await this.sportsSyncStateService.isComplete(
          context.fixtureStateKey,
        );

        if (!fixtureComplete) {
          throw new Error(
            `Fixture synchronization state ${context.fixtureStateKey} is not complete`,
          );
        }

        const summaryComplete = await this.sportsSyncStateService.isComplete(
          context.summaryStateKey,
        );

        if (!summaryComplete) {
          throw new Error(
            `Summary synchronization state ${context.summaryStateKey} is not complete`,
          );
        }
      }

      // --------------------------------------------------------
      // RESTORE PRE-EXISTING NORMAL FIXTURE QUEUE WORK
      //
      // Summary jobs are not restored from state because the
      // summary state is league/season scoped and contains many
      // event units. Normal summary queue discovery rebuilds
      // operational jobs from that persistent state after startup.
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
      // FINAL RELEASE
      // --------------------------------------------------------

      this.espnQueueService.markStartupReady();

      this.espnQueueService.markNormalOperationsReady();

      this.logger.log(
        'ESPN startup bootstrap is completely finished. ' +
          'Normal operations are now released.',
      );

      this.espnQueueWorkerService.start();
    } catch (error) {
      this.logger.error(
        'ESPN startup bootstrap failed. Sports synchronization remains locked.',
        error instanceof Error ? error.stack : String(error),
      );
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

      if (!league.seasonStartDate) {
        throw new Error(
          `Active league ${league.leagueId} has no seasonStartDate`,
        );
      }

      const leagueId = (league.slug || league.leagueId).trim().toLowerCase();

      if (!leagueId) {
        throw new Error('Active league has no valid ESPN league ID');
      }

      const priority = this.getQueuePriority(league.priority);

      // --------------------------------------------------------
      // FIXTURE STATE
      // --------------------------------------------------------

      const fixtureState =
        await this.sportsSyncStateService.ensureFixtureRefreshState({
          leagueId,

          season: league.season,

          priority,

          dateFrom: this.toDateOnly(new Date(league.seasonStartDate)),

          dateTo: this.toDateOnly(
            this.addUtcDays(
              this.startOfUtcDay(new Date()),
              this.startupFixtureForwardDays,
            ),
          ),

          trackingMode: 'HISTORY',
        });

      await this.sportsSyncStateService.resetInterruptedUnits(
        fixtureState.stateKey,
      );

      // --------------------------------------------------------
      // SUMMARY STATE
      // --------------------------------------------------------

      const summaryState =
        await this.sportsSyncStateService.ensureSummaryRefreshState({
          leagueId,

          season: league.season,

          priority,

          trackingMode: 'HISTORY',
        });

      await this.sportsSyncStateService.resetInterruptedUnits(
        summaryState.stateKey,
      );

      contexts.push({
        league,

        leagueId,

        season: league.season,

        priority,

        fixtureStateKey: fixtureState.stateKey,

        summaryStateKey: summaryState.stateKey,
      });
    }

    return contexts;
  }

  // ============================================================
  // PHASE 3
  // FIXTURE COLLECTION
  // ============================================================

  private async runFixturePhase(
    contexts: StartupLeagueContext[],
  ): Promise<void> {
    const failures: string[] = [];

    this.logger.log(`ESPN FIXTURE PHASE started: leagues=${contexts.length}`);

    for (const context of contexts) {
      const incompleteDates =
        await this.sportsSyncStateService.getIncompleteDates(
          context.fixtureStateKey,
        );

      this.logger.log(
        `Fixture bootstrap for ${context.leagueId}: ` +
          `remainingDates=${incompleteDates.length}`,
      );

      for (const dateKey of incompleteDates) {
        try {
          await this.processFixtureDate(
            context.fixtureStateKey,
            context.leagueId,
            dateKey,
          );
        } catch (error) {
          failures.push(
            `${context.leagueId} ${dateKey}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      await this.sportsSyncStateService.refreshOverallStatus(
        context.fixtureStateKey,
      );
    }

    if (failures.length > 0) {
      throw new Error(`Fixture phase failed: ${failures.join('; ')}`);
    }

    this.logger.log('ESPN FIXTURE PHASE completed successfully');
  }

  private async processFixtureDate(
    stateKey: string,
    leagueId: string,
    dateKey: string,
  ): Promise<void> {
    await this.sportsSyncStateService.markDateProcessing(stateKey, dateKey);

    try {
      const response = await this.espnService.getFixturesForDate(
        leagueId,
        dateKey,
      );

      await this.sportsCollectionService.collectEspnFixtures(
        leagueId,
        response,
      );

      await this.sportsSyncStateService.markDateSuccess(stateKey, dateKey);
    } catch (error) {
      await this.sportsSyncStateService.markDateFailed(
        stateKey,
        dateKey,
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
    skipped: number;
  }> {
    let checked = 0;

    let missingSummary = 0;

    let processed = 0;

    let skipped = 0;

    this.logger.log(
      `ESPN STARTUP SUMMARY PHASE started: leagues=${contexts.length}`,
    );

    for (const context of contexts) {
      /*
       * Reconcile MongoDB and persistent summary state once for
       * this league/season.
       */
      const state = await this.sportsSyncStateService.ensureSummaryRefreshState(
        {
          leagueId: context.leagueId,

          season: context.season,

          priority: context.priority,

          trackingMode: 'HISTORY',
        },
      );

      await this.sportsSyncStateService.resetInterruptedUnits(state.stateKey);

      /*
       * Re-read the state after interrupted-unit recovery.
       */
      const incompleteEvents =
        await this.sportsSyncStateService.getIncompleteSummaryEvents(
          state.stateKey,
        );

      checked += state.units.length;

      missingSummary += incompleteEvents.length;

      this.logger.log(
        `Summary bootstrap for ${context.leagueId}: ` +
          `checked=${state.units.length}, ` +
          `remainingEvents=${incompleteEvents.length}`,
      );

      if (incompleteEvents.length === 0) {
        continue;
      }

      /*
       * One state-document write marks the whole batch PROCESSING.
       *
       * Individual ESPN completions then update their own summary
       * synchronization units immediately.
       */
      await this.sportsSyncStateService.markSummaryEventsProcessing(
        state.stateKey,
        incompleteEvents,
      );

      const batchStartedAt = Date.now();

      const batchResults = await this.processSummaryBatch(
        context,
        state.stateKey,
        incompleteEvents,
      );

      const successfulResults = batchResults.filter(
        (result) => result.success && result.summary !== undefined,
      );

      const failedResults = batchResults.filter((result) => !result.success);

      this.logger.log(
        `SUMMARY ESPN FETCH PHASE completed for ${context.leagueId}: ` +
          `total=${batchResults.length}, ` +
          `successful=${successfulResults.length}, ` +
          `failed=${failedResults.length}, ` +
          `duration=${Date.now() - batchStartedAt}ms`,
      );

      /*
       * Persist all successfully fetched summaries into the
       * canonical fixture collection in ONE bulk operation.
       */
      if (successfulResults.length > 0) {
        const bulkStartedAt = Date.now();

        try {
          const bulkResult =
            await this.sportsCollectionService.collectEspnMatchSummariesBulk(
              successfulResults.map((result) => ({
                leagueId: context.leagueId,

                eventId: result.eventId,

                summary: result.summary,
              })),
            );

          this.logger.log(
            `SUMMARY fixture bulk write completed for ${context.leagueId}: ` +
              `requested=${bulkResult.requested}, ` +
              `matched=${bulkResult.matched}, ` +
              `modified=${bulkResult.modified}, ` +
              `duration=${Date.now() - bulkStartedAt}ms`,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);

          this.logger.error(
            `SUMMARY fixture bulk write FAILED for ${context.leagueId}: ` +
              `${message}`,
          );

          /*
           * Every summary fetched in this bulk belongs back in
           * FAILED because canonical fixture persistence did not
           * complete successfully.
           */
          await this.sportsSyncStateService.markSummaryBulkWriteFailed(
            state.stateKey,

            successfulResults.map((result) => result.eventId),

            error,
          );

          throw new Error(
            `Summary bulk persistence failed for ${context.leagueId}: ${message}`,
          );
        }
      }

      processed += successfulResults.length;

      skipped += failedResults.length;

      /*
       * SUCCESS means:
       *
       *   ESPN fetch succeeded
       *   +
       *   canonical fixture bulk persistence succeeded.
       *
       * FAILED means:
       *
       *   ESPN fetch failed
       *   OR
       *   canonical fixture bulk persistence failed.
       */
      await this.sportsSyncStateService.refreshOverallStatus(state.stateKey);

      const complete = await this.sportsSyncStateService.isComplete(
        state.stateKey,
      );

      if (!complete) {
        throw new Error(
          `Startup Summary synchronization state ${state.stateKey} is not complete`,
        );
      }
    }

    if (skipped > 0) {
      throw new Error(
        `Startup Summary phase did not complete for ${skipped} fixture(s)`,
      );
    }

    return {
      checked,

      missingSummary,

      processed,

      skipped,
    };
  }

  // ============================================================
  // SUMMARY BATCH PROCESSING
  // ============================================================

  private async processSummaryBatch(
    context: StartupLeagueContext,
    stateKey: string,
    eventIds: string[],
  ): Promise<
    Array<{
      eventId: string;
      success: boolean;
      summary?: unknown;
      error?: unknown;
    }>
  > {
    const results: Array<{
      eventId: string;
      success: boolean;
      summary?: unknown;
      error?: unknown;
    }> = [];

    let nextIndex = 0;

    let completed = 0;

    const total = eventIds.length;

    const workerCount = Math.min(this.startupSummaryConcurrency, total);

    const runWorker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++;

        if (index >= total) {
          return;
        }

        const eventId = eventIds[index];

        const startedAt = Date.now();

        try {
          const summary = await this.espnService.getMatchSummary(
            context.leagueId,
            eventId,
          );

          const duration = Date.now() - startedAt;

          /*
           * A completed HTTP/API request without a usable Summary
           * is not a successful synchronization result.
           */
          if (!this.hasSummaryPayload(summary)) {
            throw new Error(
              `ESPN returned no usable summary for event ${eventId}`,
            );
          }

          completed += 1;

          this.logger.log(
            `SUMMARY FETCH completed: ` +
              `${context.leagueId}/${eventId} ` +
              `duration=${duration}ms ` +
              `progress=${completed}/${total}`,
          );

          try {
            await this.sportsSyncStateService.markSummaryEventFetchSuccess(
              stateKey,
              eventId,
            );
          } catch (stateError) {
            this.logger.error(
              `Failed to record Summary fetch success for ` +
                `${context.leagueId}/${eventId}: ${
                  stateError instanceof Error
                    ? stateError.message
                    : String(stateError)
                }`,
            );
          }

          results.push({
            eventId,

            success: true,

            summary,
          });
        } catch (error) {
          const duration = Date.now() - startedAt;

          completed += 1;

          const message =
            error instanceof Error ? error.message : String(error);

          this.logger.error(
            `SUMMARY FETCH failed: ` +
              `${context.leagueId}/${eventId} ` +
              `duration=${duration}ms ` +
              `progress=${completed}/${total} ` +
              `error=${message}`,
          );

          try {
            await this.sportsSyncStateService.markSummaryEventFetchFailed(
              stateKey,
              eventId,
              error,
            );
          } catch (stateError) {
            this.logger.error(
              `Failed to record Summary fetch failure for ` +
                `${context.leagueId}/${eventId}: ${
                  stateError instanceof Error
                    ? stateError.message
                    : String(stateError)
                }`,
            );
          }

          results.push({
            eventId,

            success: false,

            error,
          });
        }
      }
    };

    await Promise.all(
      Array.from(
        {
          length: workerCount,
        },
        () => runWorker(),
      ),
    );

    return results;
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
        if (state.jobType !== EspnQueueJobType.FIXTURE_REFRESH) {
          skipped += 1;
          continue;
        }

        if (typeof state.season !== 'number') {
          skipped += 1;
          continue;
        }

        /*
         * The persistent FIXTURE_REFRESH state is independent of
         * the operational trigger that originally created work.
         *
         * Rebuilding one normal fixture queue job is enough because
         * the worker reads the persistent state and processes every
         * incomplete fixture date.
         */
        const job = await this.espnQueueService.addFixtureRefreshJob({
          leagueId: state.leagueId,

          season: state.season,

          priority: state.priority ?? 4,

          scheduledFor: new Date(),
        });

        if (
          String(job.status) === 'PENDING' &&
          Number(job.attempts ?? 0) === 0
        ) {
          queued += 1;
        }
      } catch (error) {
        skipped += 1;

        this.logger.error(
          `Failed to restore normal synchronization state ${state.stateKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
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
  // SUMMARY
  // ============================================================

  private hasSummaryPayload(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') {
      return false;
    }

    const record = payload as Record<string, unknown>;

    const summary = record.summary;

    return Boolean(
      summary &&
      typeof summary === 'object' &&
      Object.keys(summary as Record<string, unknown>).length > 0,
    );
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
}
