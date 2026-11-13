import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  SPORTS_COLLECTION_SCHEDULE,
  SPORTS_COLLECTION_TIME,
} from '../config/sports-collection-schedule.config';
import type { FixtureCollectionResult } from '../interfaces/provider-response.interface';
import type {
  SportsCompetitionRecord,
  SportsFixtureRecord,
  SportsSeasonRecord,
} from '../interfaces/sports-domain.interface';
import {
  SportsBootstrapPhase,
  SportsQueueJobType,
  SportsQueueScope,
} from '../interfaces/sports-queue.interface';
import { SportsDomainCollectionService } from './sports-domain-collection.service';
import { SportsDomainReadService } from './sports-domain-read.service';
import { SportsDerivedProjectionService } from './sports-derived-projection.service';
import { SportsNewsCollectionService } from './sports-news-collection.service';
import { SportsYoutubeHighlightCollectionService } from './sports-youtube-highlight-collection.service';
import {
  SportsQueueService,
  ClaimedSportsQueueJob,
} from './sports-queue.service';
import { SettlementTriggerService } from '../../settlement/services/settlement-trigger.service';

const { DAY } = SPORTS_COLLECTION_TIME;

// Only these three persisted odds milestones are valid after the schedule fix.
// This also safely retires already-queued ODDS_60H and ODDS_CATCHUP jobs.
const ACTIVE_ODDS_MILESTONES = new Set(['ODDS_48H', 'ODDS_24H', 'ODDS_18H']);

type BootstrapStateRecord = {
  status?: string;
  currentPhase?: string;
  discoveredTeams?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

type UnknownRecord = Record<string, unknown>;

type BootstrapStateModel = {
  findOne: (query: UnknownRecord) => {
    lean: () => {
      exec: () => Promise<BootstrapStateRecord | null>;
    };
  };
  updateOne: (
    query: UnknownRecord,
    update: UnknownRecord,
  ) => {
    exec: () => Promise<unknown>;
  };
};

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  )
    return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object')
    return String(Object.prototype.toString.call(value));
  return '';
}

function describeError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  return asText(value);
}

/**
 * Executes the ESPN-only collection workflow.
 *
 * Bootstrap is a strict phase machine. A phase gate cannot advance until all
 * jobs belonging to that phase are completed. Fixtures are then discovered in
 * bulk through monthly Site scoreboards and validated day-by-day. After the
 * bootstrap, all maintenance is date/match-event timed.
 *
 */
@Injectable()
export class SportsQueueJobProcessorService {
  private readonly logger = new Logger(SportsQueueJobProcessorService.name);

  constructor(
    private readonly collection: SportsDomainCollectionService,
    private readonly sportsRead: SportsDomainReadService,
    private readonly queue: SportsQueueService,
    private readonly derived: SportsDerivedProjectionService,
    private readonly news: SportsNewsCollectionService,
    private readonly youtubeHighlights: SportsYoutubeHighlightCollectionService,
    @Inject(forwardRef(() => SettlementTriggerService))
    private readonly settlementTrigger: SettlementTriggerService,
    @InjectModel('SportsBootstrapState')
    private readonly bootstrapModel: BootstrapStateModel,
  ) {}

  private async getBootstrapState(
    runId: string,
  ): Promise<BootstrapStateRecord | null> {
    const result = await this.bootstrapModel
      .findOne({ key: 'espn-soccer-v2', runId })
      .lean()
      .exec();
    return result ?? null;
  }

  async process(job: ClaimedSportsQueueJob): Promise<void> {
    const type = job.type;
    switch (type) {
      case SportsQueueJobType.BOOTSTRAP_START:
        await this.processBootstrapStart(job.scope);
        return;
      case SportsQueueJobType.BOOTSTRAP_PHASE_GATE:
        await this.processBootstrapPhaseGate(job.scope);
        return;
      case SportsQueueJobType.SEASON_DISCOVERY_PHASE_GATE:
        await this.processSeasonDiscoveryPhaseGate(job.scope);
        return;
      case SportsQueueJobType.LEAGUE_CATALOGUE_REFRESH:
        await this.processLeagueCatalogue();
        return;
      case SportsQueueJobType.LEAGUE_DETAIL_REFRESH:
        await this.processLeagueDetails(job.scope);
        return;
      case SportsQueueJobType.SEASON_CATALOGUE_REFRESH:
        await this.processSeasonCatalogue(job.scope);
        return;
      case SportsQueueJobType.TEAM_CATALOGUE_REFRESH:
        await this.processTeamCatalogue(job.scope);
        return;
      case SportsQueueJobType.TEAM_DETAIL_REFRESH:
        await this.processTeamDetails(job.scope);
        return;
      case SportsQueueJobType.FIXTURE_SEASON_BOOTSTRAP:
        await this.processSeasonFixtureBootstrap(job.scope);
        return;
      case SportsQueueJobType.FIXTURE_SEASON_VALIDATION_GATE:
        await this.processSeasonValidationGate(job.scope);
        return;
      case SportsQueueJobType.FIXTURE_DAILY_VALIDATION:
        await this.processDailyScoreboard(job.scope, true);
        return;
      case SportsQueueJobType.FIXTURE_DAILY_REFRESH:
        await this.processDailyScoreboard(job.scope, false);
        return;
      case SportsQueueJobType.MATCH_ODDS_REFRESH:
        await this.processMatchOdds(job.scope);
        return;
      case SportsQueueJobType.LIVE_SCOREBOARD_REFRESH:
        await this.processLiveScoreboard(job.scope);
        return;
      case SportsQueueJobType.MATCH_SUMMARY_COLLECTION:
        await this.processMatchSummary(job.scope);
        return;
      case SportsQueueJobType.MATCH_SUMMARY_BACKFILL:
        await this.processMatchSummaryBackfill(job.scope);
        return;
      case SportsQueueJobType.MATCH_PLAYS_COLLECTION:
        await this.processMatchPlays(job.scope);
        return;
      case SportsQueueJobType.YOUTUBE_HIGHLIGHT:
        await this.youtubeHighlights.processAttempt(
          this.required(job.scope.fixtureId, 'fixtureId'),
          Math.max(1, Math.floor(Number(job.scope.youtubeAttempt ?? 1))),
        );
        return;
      case SportsQueueJobType.SOURCE_FACTS_CHANGED:
        await this.processSourceFactsChanged(job.scope);
        return;
      case SportsQueueJobType.SOCCER_NEWS_REFRESH:
        await this.news.collectSoccerNews();
        return;
      case SportsQueueJobType.LEAGUE_NEWS_REFRESH:
        await this.processLeagueNews(job.scope);
        return;
      case SportsQueueJobType.DERIVED_DATA_RECALCULATION:
        await this.processDerivedData(job.scope);
        return;
      case SportsQueueJobType.SPORTS_RETENTION_CLEANUP:
        await this.processSportsRetentionCleanup();
        return;
      default: {
        throw new Error(`Unsupported ESPN Sports queue type: ${type}`);
      }
    }
  }

  /** Persist the next recurring queue record before acknowledging this job. */
  async scheduleNext(
    job: ClaimedSportsQueueJob,
    workerId: string,
  ): Promise<void> {
    if (!job.recurrence) return;

    // Team details recur only while their originating season is current.
    // Legacy jobs without a season stamp are allowed one final execution but
    // cannot create an endless stale recurrence chain.
    if (job.type === SportsQueueJobType.TEAM_DETAIL_REFRESH) {
      const seasonYear = Number(job.scope.seasonYear);
      if (!Number.isInteger(seasonYear)) return;
      const leagueId = this.required(job.scope.leagueId, 'leagueId').toLowerCase();
      const competition = await this.collection.getCompetition(`competition:${leagueId}`);
      if (!competition || competition.currentSeasonYear !== seasonYear) return;
    }

    if (job.recurrence.repeatUntil === 'DATA_COMPLETE') {
      if (job.type === SportsQueueJobType.LIVE_SCOREBOARD_REFRESH) {
        const competitionId = this.required(
          job.scope.competitionId,
          'competitionId',
        );
        const date = this.required(job.scope.calendarDate, 'calendarDate');
        if (
          !(await this.collection.shouldContinueLiveScoreboard(
            competitionId,
            date,
          ))
        )
          return;
      } else if (
        job.type === SportsQueueJobType.FIXTURE_SEASON_VALIDATION_GATE
      ) {
        const competitionId = this.required(
          job.scope.competitionId,
          'competitionId',
        );
        const seasonId = this.required(job.scope.seasonId, 'seasonId');
        if (
          await this.collection.isSeasonDailyValidationComplete(
            competitionId,
            seasonId,
            job.scope.seasonEndDate,
          )
        )
          return;
      } else {
        return;
      }
    }

    const scheduledFor = await this.queue.getOrCreateSuccessorAt(
      job.jobKey,
      workerId,
      job.recurrence.intervalMs,
    );
    // Bootstrap phase jobs are one-shot for the gate, but their successors
    // become ordinary scheduled discovery jobs and must not keep the phase open.
    const successorScope = job.scope.bootstrapRunId
      ? Object.fromEntries(
          Object.entries(job.scope).filter(
            ([key]) => key !== 'bootstrapRunId' && key !== 'bootstrapPhase',
          ),
        )
      : job.scope;
    await this.queue.enqueue({
      type: job.type,
      scope: successorScope,
      priority: job.priority,
      scheduledFor,
      recurrence: job.recurrence,
      triggerEventId: job.triggerEventId,
    });
  }

  // ---------------------------------------------------------------------------
  // Ordered first-run bootstrap
  // ---------------------------------------------------------------------------

  private async processBootstrapStart(scope: SportsQueueScope): Promise<void> {
    const runId = this.required(scope.bootstrapRunId, 'bootstrapRunId');
    const state = await this.getBootstrapState(runId);
    if (!state || state.status !== 'RUNNING')
      throw new Error(`ESPN bootstrap ${runId} is not in RUNNING state.`);

    const discovery = await this.collection.discoverLeagueCatalogue();
    const leagueIds = [
      ...new Set(
        discovery.leagueIds
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    if (!leagueIds.length)
      throw new Error(
        'ESPN league catalogue returned no discoverable soccer leagues.',
      );

    await this.bootstrapModel
      .updateOne(
        { key: 'espn-soccer-v2', runId },
        {
          $set: {
            currentPhase: 'LEAGUE_DETAILS',
            discoveredLeagueIds: leagueIds,
          },
        },
      )
      .exec();

    for (const leagueId of leagueIds) {
      await this.queue.enqueue({
        type: SportsQueueJobType.LEAGUE_DETAIL_REFRESH,
        scope: {
          leagueId,
          bootstrapRunId: runId,
          bootstrapPhase: 'LEAGUE_DETAILS',
        },
        priority: 95,
        scheduledFor: new Date(0),
        recurrence: {
          intervalMs: SPORTS_COLLECTION_SCHEDULE.leagueDetails.intervalMs,
          repeatUntil: 'NEVER',
        },
        triggerEventId: `bootstrap:${runId}:league-detail:${leagueId}`,
      });
    }
    await this.enqueuePhaseGate(runId, 'LEAGUE_DETAILS');
    this.logger.log(
      `ESPN bootstrap ${runId}: queued details for ${leagueIds.length} leagues.`,
    );
  }

  private async processBootstrapPhaseGate(
    scope: SportsQueueScope,
  ): Promise<void> {
    const runId = this.required(scope.bootstrapRunId, 'bootstrapRunId');
    const phase = scope.bootstrapPhase;
    if (!phase)
      throw new Error('Bootstrap phase gate is missing bootstrapPhase.');

    const state = await this.getBootstrapState(runId);
    if (!state || state.status !== 'RUNNING') return;
    if (state.currentPhase !== phase) return; // stale gate from a phase already advanced

    const progress = await this.queue.getBootstrapPhaseProgress(runId, phase);
    if (progress.hasTerminalFailure) {
      const message = `Bootstrap phase ${phase} has quarantined jobs (${progress.quarantined}).`;
      await this.bootstrapModel
        .updateOne(
          { key: 'espn-soccer-v2', runId },
          { $set: { status: 'FAILED', lastError: message } },
        )
        .exec();
      throw new Error(message);
    }
    if (!progress.isComplete) {
      await this.enqueuePhaseGate(runId, phase);
      return;
    }

    const next = this.nextPhase(phase);
    if (!next) {
      await this.finishBootstrap(runId);
      return;
    }

    await this.bootstrapModel
      .updateOne(
        { key: 'espn-soccer-v2', runId },
        { $set: { currentPhase: next } },
      )
      .exec();
    await this.enqueuePhaseJobs(runId, next);
    await this.enqueuePhaseGate(runId, next);
    this.logger.log(
      `ESPN bootstrap ${runId}: phase ${phase} completed; entered ${next}.`,
    );
  }

  private nextPhase(
    phase: SportsBootstrapPhase,
  ): SportsBootstrapPhase | undefined {
    const sequence: SportsBootstrapPhase[] = [
      'LEAGUE_DETAILS',
      'SEASON_CATALOGUES',
      'TEAM_CATALOGUES',
      'TEAM_DETAILS',
      'MONTHLY_FIXTURE_BOOTSTRAP',
      'DAILY_FIXTURE_VALIDATION',
    ];
    const index = sequence.indexOf(phase);
    return index >= 0 ? sequence[index + 1] : undefined;
  }

  private async enqueuePhaseJobs(
    runId: string,
    phase: SportsBootstrapPhase,
  ): Promise<void> {
    const competitions = await this.collection.getAllCompetitions();

    if (phase === 'SEASON_CATALOGUES' || phase === 'TEAM_CATALOGUES') {
      const type =
        phase === 'SEASON_CATALOGUES'
          ? SportsQueueJobType.SEASON_CATALOGUE_REFRESH
          : SportsQueueJobType.TEAM_CATALOGUE_REFRESH;
      for (const competition of competitions) {
        await this.queue.enqueue({
          type,
          scope: {
            leagueId: competition.slug,
            competitionId: competition.id,
            bootstrapRunId: runId,
            bootstrapPhase: phase,
          },
          priority: 85,
          scheduledFor: new Date(0),
          recurrence: {
            intervalMs:
              phase === 'SEASON_CATALOGUES'
                ? SPORTS_COLLECTION_SCHEDULE.seasonCatalogue.intervalMs
                : SPORTS_COLLECTION_SCHEDULE.teamCatalogue.intervalMs,
            repeatUntil: 'NEVER',
          },
          triggerEventId: `bootstrap:${runId}:${phase}:${competition.id}`,
        });
      }
      return;
    }

    if (phase === 'TEAM_DETAILS') {
      const bootstrap = await this.getBootstrapState(runId);
      const unique = new Map<
        string,
        { leagueId: string; teamId: string; teamReference?: string }
      >();
      for (const ref of bootstrap?.discoveredTeams ?? []) {
        const leagueId = asText(ref.leagueId).trim().toLowerCase();
        const teamId = asText(ref.teamId).trim();
        const teamReference =
          typeof ref.teamReference === 'string' ? ref.teamReference : undefined;
        if (leagueId && teamId)
          unique.set(`${leagueId}:${teamId}`, {
            leagueId,
            teamId,
            teamReference,
          });
      }
      for (const ref of unique.values()) {
        await this.queue.enqueue({
          type: SportsQueueJobType.TEAM_DETAIL_REFRESH,
          scope: { ...ref, bootstrapRunId: runId, bootstrapPhase: phase },
          priority: 80,
          scheduledFor: new Date(0),
          recurrence: {
            intervalMs: SPORTS_COLLECTION_SCHEDULE.teamDetails.intervalMs,
            repeatUntil: 'NEVER',
          },
          triggerEventId: `bootstrap:${runId}:team-detail:${ref.leagueId}:${ref.teamId}`,
        });
      }
      return;
    }

    if (phase === 'MONTHLY_FIXTURE_BOOTSTRAP') {
      const seasons = (await this.collection.getAllSeasons()).filter((season) => season.isCurrent);
      for (const season of seasons) {
        const competition = competitions.find(
          (item) => item.id === season.competitionId,
        );
        if (!competition) continue;
        await this.queue.enqueue({
          type: SportsQueueJobType.FIXTURE_SEASON_BOOTSTRAP,
          scope: {
            leagueId: competition.slug,
            competitionId: competition.id,
            seasonId: season.id,
            seasonYear: season.year,
            bootstrapRunId: runId,
            bootstrapPhase: phase,
          },
          priority: season.isCurrent ? 85 : 50,
          scheduledFor: new Date(0),
          triggerEventId: `bootstrap:${runId}:monthly:${season.id}`,
        });
      }
      return;
    }

    if (phase === 'DAILY_FIXTURE_VALIDATION') {
      const seasons = (await this.collection.getAllSeasons()).filter((season) => season.isCurrent);
      for (const season of seasons) {
        const competition = competitions.find(
          (item) => item.id === season.competitionId,
        );
        if (!competition) continue;
        const { start, end } = this.seasonDateRange(season);
        for (const date of this.eachDate(start, end)) {
          await this.queue.enqueue({
            type: SportsQueueJobType.FIXTURE_DAILY_VALIDATION,
            scope: {
              leagueId: competition.slug,
              competitionId: competition.id,
              seasonId: season.id,
              seasonYear: season.year,
              calendarDate: date,
              seasonEndDate: end.toISOString().slice(0, 10),
              bootstrapRunId: runId,
              bootstrapPhase: phase,
            },
            priority: this.priorityForDate(date),
            scheduledFor: new Date(0),
            triggerEventId: `bootstrap:${runId}:validate:${season.id}:${date}`,
          });
        }
      }
    }
  }

  private async forEachCompletedFixturePage(
    handler: (fixtures: SportsFixtureRecord[]) => Promise<void>,
    scope: {
      competitionId?: string;
      seasonId?: string;
      includeProjectionData?: boolean;
    } = {},
  ): Promise<number> {
    const pageSize = 100;
    let cursor: string | undefined;
    let processed = 0;

    do {
      const page = await this.collection.getCompletedFixturesPage({
        ...scope,
        limit: pageSize,
        ...(cursor ? { cursor } : {}),
      });
      if (page.items.length) {
        await handler(page.items);
        processed += page.items.length;
      }
      cursor = page.nextCursor;
    } while (cursor);

    return processed;
  }

  private async finishBootstrap(runId: string): Promise<void> {
    // Startup recovery is keyset-paginated. Each page is fully handed off before
    // the next one is read, so a large historical fixture catalogue is never
    // retained as one process-wide array.
    const completedCount = await this.forEachCompletedFixturePage(
      async (completed) => {
        for (const fixture of completed)
          await this.enqueuePlays(fixture, `bootstrap:${runId}:plays`);
        await this.enqueueRecentCompletedNews(
          completed,
          `bootstrap:${runId}:news`,
        );
      },
    );

    // Historical derived projections are queued after the Summary backfill
    // finishes, so the baseline consumes normalized match facts rather than
    // racing the first collection pass. Plays updates still trigger later
    // event-rich recalculations through SOURCE_FACTS_CHANGED.

    await this.enqueueRecurringDiscovery();
    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.MATCH_SUMMARY_BACKFILL,
      scope: { backfillRunId: runId },
      priority: SPORTS_COLLECTION_SCHEDULE.summaryBackfill.priority,
      scheduledFor: new Date(),
      triggerEventId: `summary-backfill:${runId}:start`,
    });

    // The Settlement worker may have completed its own startup catch-up before
    // Sports fixtures were fully bootstrapped. Reconcile unresolved target event
    // IDs again now that the normalized fixture domain is complete. This call
    // runs before the bootstrap is marked completed so a failed handoff causes
    // the durable Sports phase-gate job to retry instead of silently skipping it.
    const settlementCatchup =
      await this.settlementTrigger.onSportsBootstrapCompleted();

    await this.bootstrapModel
      .updateOne(
        { key: 'espn-soccer-v2', runId },
        {
          $set: { status: 'COMPLETED', completedAt: new Date() },
          $unset: { currentPhase: 1, lastError: 1 },
        },
      )
      .exec();

    this.logger.log(
      `ESPN bootstrap ${runId} completed. Queued Plays for ${completedCount} completed fixtures. Settlement catch-up: ${JSON.stringify(settlementCatchup)}.`,
    );
  }

  private async processSeasonDiscoveryPhaseGate(
    scope: SportsQueueScope,
  ): Promise<void> {
    const runId = this.required(scope.bootstrapRunId, 'bootstrapRunId');
    const phase = scope.bootstrapPhase;
    if (phase !== 'TEAM_CATALOGUES' && phase !== 'TEAM_DETAILS') {
      throw new Error(
        `Unsupported new-season discovery phase: ${String(phase)}`,
      );
    }

    const progress = await this.queue.getBootstrapPhaseProgress(runId, phase);
    if (progress.hasTerminalFailure) {
      throw new Error(
        `New-season team discovery ${phase} failed for ${scope.seasonId}; ${progress.quarantined} job(s) quarantined.`,
      );
    }
    if (!progress.isComplete) {
      await this.enqueueSeasonDiscoveryGate(scope, phase);
      return;
    }

    if (phase === 'TEAM_CATALOGUES') {
      await this.enqueueSeasonDiscoveryGate(scope, 'TEAM_DETAILS');
      return;
    }

    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.FIXTURE_SEASON_BOOTSTRAP,
      scope: {
        leagueId: this.required(scope.leagueId, 'leagueId'),
        competitionId: this.required(scope.competitionId, 'competitionId'),
        seasonId: this.required(scope.seasonId, 'seasonId'),
        seasonYear: scope.seasonYear,
      },
      priority: 90,
      scheduledFor: new Date(),
      triggerEventId: `new-season-fixture-bootstrap:${scope.seasonId}`,
    });
    this.logger.log(
      `New-season team discovery completed for ${scope.seasonId}; fixture bootstrap released.`,
    );
  }

  private async enqueueSeasonDiscoveryGate(
    scope: SportsQueueScope,
    phase: 'TEAM_CATALOGUES' | 'TEAM_DETAILS',
  ): Promise<void> {
    const due = new Date(
      Date.now() + SPORTS_COLLECTION_SCHEDULE.bootstrapGate.intervalMs,
    );
    await this.queue.enqueue({
      type: SportsQueueJobType.SEASON_DISCOVERY_PHASE_GATE,
      scope: { ...scope, bootstrapPhase: phase },
      priority: 88,
      scheduledFor: due,
      triggerEventId: `season-discovery-gate:${scope.seasonId}:${phase}:${Math.floor(due.getTime() / SPORTS_COLLECTION_SCHEDULE.bootstrapGate.intervalMs)}`,
    });
  }

  private async enqueuePhaseGate(
    runId: string,
    phase: SportsBootstrapPhase,
  ): Promise<void> {
    const due = new Date(
      Date.now() + SPORTS_COLLECTION_SCHEDULE.bootstrapGate.intervalMs,
    );
    await this.queue.enqueue({
      type: SportsQueueJobType.BOOTSTRAP_PHASE_GATE,
      scope: { bootstrapRunId: runId, bootstrapPhase: phase },
      priority: 90,
      scheduledFor: due,
      triggerEventId: `bootstrap-gate:${runId}:${phase}:${Math.floor(due.getTime() / SPORTS_COLLECTION_SCHEDULE.bootstrapGate.intervalMs)}`,
    });
  }

  private async enqueueRecurringDiscovery(): Promise<void> {
    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.LEAGUE_CATALOGUE_REFRESH,
      scope: {},
      priority: 90,
      scheduledFor: new Date(
        Date.now() + SPORTS_COLLECTION_SCHEDULE.leagueCatalogue.intervalMs,
      ),
      recurrence: {
        intervalMs: SPORTS_COLLECTION_SCHEDULE.leagueCatalogue.intervalMs,
        repeatUntil: 'NEVER',
      },
      triggerEventId: 'espn-recurring-league-catalogue',
    });
    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.SOCCER_NEWS_REFRESH,
      scope: {},
      priority: 55,
      scheduledFor: new Date(
        Date.now() + SPORTS_COLLECTION_SCHEDULE.soccerNews.initialDelayMs,
      ),
      recurrence: {
        intervalMs: SPORTS_COLLECTION_SCHEDULE.soccerNews.intervalMs,
        repeatUntil: 'NEVER',
      },
      triggerEventId: 'espn-recurring-soccer-news',
    });
    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.SPORTS_RETENTION_CLEANUP,
      scope: {},
      priority: 25,
      scheduledFor: new Date(Date.now() + SPORTS_COLLECTION_SCHEDULE.retentionCleanup.intervalMs),
      recurrence: {
        intervalMs: SPORTS_COLLECTION_SCHEDULE.retentionCleanup.intervalMs,
        repeatUntil: 'NEVER',
      },
      triggerEventId: 'sports-recurring-retention-cleanup',
    });
  }

  // ---------------------------------------------------------------------------
  // Routine discovery and maintenance
  // ---------------------------------------------------------------------------

  private async processLeagueCatalogue(): Promise<void> {
    const result = await this.collection.discoverLeagueCatalogue();
    for (const leagueId of result.leagueIds) {
      await this.queue.enqueueIfMissing({
        type: SportsQueueJobType.LEAGUE_DETAIL_REFRESH,
        scope: { leagueId },
        priority: 80,
        scheduledFor: new Date(),
        recurrence: {
          intervalMs: SPORTS_COLLECTION_SCHEDULE.leagueDetails.intervalMs,
          repeatUntil: 'NEVER',
        },
        triggerEventId: `league-detail:${leagueId}`,
      });
    }
    this.logger.log(
      `ESPN league catalogue refreshed: ${result.leagueIds.length} leagues.`,
    );
  }

  private async processLeagueDetails(scope: SportsQueueScope): Promise<void> {
    const leagueId = this.required(scope.leagueId, 'leagueId').toLowerCase();
    const competition = await this.collection.collectLeagueDetails(leagueId);
    if (scope.bootstrapRunId) return; // bootstrap phases are deliberately serialized by the gate

    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.SEASON_CATALOGUE_REFRESH,
      scope: { leagueId, competitionId: competition.id },
      priority: 75,
      scheduledFor: new Date(),
      recurrence: {
        intervalMs: SPORTS_COLLECTION_SCHEDULE.seasonCatalogue.intervalMs,
        repeatUntil: 'NEVER',
      },
      triggerEventId: `season-catalogue:${competition.id}`,
    });
    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.TEAM_CATALOGUE_REFRESH,
      scope: { leagueId, competitionId: competition.id },
      priority: 70,
      scheduledFor: new Date(),
      recurrence: {
        intervalMs: SPORTS_COLLECTION_SCHEDULE.teamCatalogue.intervalMs,
        repeatUntil: 'NEVER',
      },
      triggerEventId: `team-catalogue:${competition.id}`,
    });
  }

  private async processSeasonCatalogue(scope: SportsQueueScope): Promise<void> {
    const leagueId = this.required(scope.leagueId, 'leagueId').toLowerCase();
    const competitionId = this.required(scope.competitionId, 'competitionId');
    const result = await this.collection.collectSeasonCatalogue(
      leagueId,
      competitionId,
    );
    if (scope.bootstrapRunId) return;

    // A newly discovered current season has its own ordered team-discovery
    // phase. Fixture bootstrap cannot begin until its new-season team catalogue
    // and all corresponding team-detail requests have completed.
    for (const season of result.newlyDiscovered) {
      if (season.isCurrent) {
        const discoveryRunId = `season-discovery:${season.id}`;
        await this.queue.enqueueIfMissing({
          type: SportsQueueJobType.TEAM_CATALOGUE_REFRESH,
          scope: {
            leagueId,
            competitionId,
            seasonId: season.id,
            seasonYear: season.year,
            bootstrapRunId: discoveryRunId,
            bootstrapPhase: 'TEAM_CATALOGUES',
          },
          priority: 92,
          scheduledFor: new Date(),
          triggerEventId: `new-season-team-catalogue:${season.id}`,
        });
        await this.enqueueSeasonDiscoveryGate(
          {
            leagueId,
            competitionId,
            seasonId: season.id,
            seasonYear: season.year,
            bootstrapRunId: discoveryRunId,
          },
          'TEAM_CATALOGUES',
        );
      }
    }
  }

  private async processTeamCatalogue(scope: SportsQueueScope): Promise<void> {
    const leagueId = this.required(scope.leagueId, 'leagueId').toLowerCase();
    const competitionId = this.required(scope.competitionId, 'competitionId');
    const result = await this.collection.collectTeamCatalogue(
      leagueId,
      competitionId,
    );
    const competition = await this.collection.getCompetition(competitionId);
    const seasonYear = competition?.currentSeasonYear;

    if (scope.bootstrapRunId) {
      const bootstrap = await this.getBootstrapState(scope.bootstrapRunId);
      if (bootstrap?.status === 'RUNNING') {
        // Initial global bootstrap records refs first; the next strict phase
        // gate fans them out into individual 30-day team-detail jobs.
        const teamRefs = result.teamIds.map((teamId) => ({
          leagueId,
          teamId,
          teamReference: result.teamReferences[teamId],
          seasonYear,
        }));
        if (teamRefs.length) {
          await this.bootstrapModel
            .updateOne(
              { key: 'espn-soccer-v2', runId: scope.bootstrapRunId },
              { $addToSet: { discoveredTeams: { $each: teamRefs } } },
            )
            .exec();
        }
        return;
      }

      // New-season discovery uses a lightweight phase run which is independent
      // of the global startup bootstrap state.
      for (const teamId of result.teamIds) {
        await this.queue.enqueueIfMissing({
          type: SportsQueueJobType.TEAM_DETAIL_REFRESH,
          scope: {
            leagueId,
            teamId,
            teamReference: result.teamReferences[teamId],
            seasonYear,
            bootstrapRunId: scope.bootstrapRunId,
            bootstrapPhase: 'TEAM_DETAILS',
          },
          priority: 85,
          scheduledFor: new Date(),
          recurrence: {
            intervalMs: SPORTS_COLLECTION_SCHEDULE.teamDetails.intervalMs,
            repeatUntil: 'NEVER',
          },
          triggerEventId: `new-season-team-detail:${scope.seasonId}:${teamId}`,
        });
      }
      return;
    }

    for (const teamId of result.teamIds) {
      await this.queue.enqueueIfMissing({
        type: SportsQueueJobType.TEAM_DETAIL_REFRESH,
        scope: {
          leagueId,
          teamId,
          teamReference: result.teamReferences[teamId],
          seasonYear,
        },
        priority: 45,
        scheduledFor: new Date(),
        recurrence: {
          intervalMs: SPORTS_COLLECTION_SCHEDULE.teamDetails.intervalMs,
          repeatUntil: 'NEVER',
        },
        triggerEventId: `team-detail:${leagueId}:${teamId}`,
      });
    }
  }

  private async processTeamDetails(scope: SportsQueueScope): Promise<void> {
    const leagueId = this.required(scope.leagueId, 'leagueId').toLowerCase();
    const teamId = this.required(scope.teamId, 'teamId');
    // Delayed jobs from a previous season become harmless after season rollover.
    if (scope.seasonYear !== undefined) {
      const competition = await this.collection.getCompetition(`competition:${leagueId}`);
      if (!competition || competition.currentSeasonYear !== scope.seasonYear) return;
    }
    await this.collection.collectTeamDetails(leagueId, teamId, scope.teamReference);
  }

  // ---------------------------------------------------------------------------
  // Monthly fixture bootstrap and daily validation
  // ---------------------------------------------------------------------------

  private async processSeasonFixtureBootstrap(
    scope: SportsQueueScope,
  ): Promise<void> {
    const leagueId = this.required(scope.leagueId, 'leagueId').toLowerCase();
    const competitionId = this.required(scope.competitionId, 'competitionId');
    const seasonId = this.required(scope.seasonId, 'seasonId');
    const season = await this.collection.getSeason(seasonId);
    if (!season) {
      this.logger.debug(`Skipping stale fixture bootstrap ${seasonId}; it is not the persisted current season.`);
      return;
    }
    if (!season.isCurrent) {
      this.logger.debug(`Skipping historical season fixture bootstrap ${seasonId}; only current seasons are collected.`);
      return;
    }
    if (await this.collection.isSeasonMonthlyBootstrapComplete(seasonId)) {
      if (!scope.bootstrapRunId)
        await this.enqueueSeasonDailyValidation(
          season,
          leagueId,
          competitionId,
        );
      return;
    }

    const { start, end } = this.seasonDateRange(season);
    const months = this.eachMonth(start, end);
    let collectedMonths = 0;
    for (const month of months) {
      if (
        await this.collection.isMonthlyFixtureMonthCollected(seasonId, month)
      ) {
        collectedMonths += 1;
        continue;
      }
      const result = await this.collection.collectMonthlyFixtures(
        leagueId,
        month,
        {
          competitionId,
          seasonId,
          seasonYear: Number(scope.seasonYear ?? season.year),
        },
      );
      // Do not start Plays until every day in this season has passed validation.
      await this.scheduleFixtureJobs(
        result.items,
        `monthly:${seasonId}:${month}`,
        false,
        scope.bootstrapRunId
          ? { bootstrapRunId: scope.bootstrapRunId }
          : {
              seasonBootstrap: true,
              seasonEndDate: end.toISOString().slice(0, 10),
            },
      );
      collectedMonths += 1;
      if (result.rejected.length) {
        this.logger.warn(
          `Monthly ESPN scoreboard ${leagueId}/${month} contained ${result.rejected.length} unnormalizable event(s).`,
        );
      }
    }

    await this.collection.markSeasonMonthlyBootstrapCompleted(
      seasonId,
      `/leagues/${leagueId}/scoreboard?monthly-season=${season.year}`,
    );
    if (!scope.bootstrapRunId)
      await this.enqueueSeasonDailyValidation(season, leagueId, competitionId);
    this.logger.log(
      `Monthly fixture bootstrap completed for ${leagueId} season ${season.year} (${collectedMonths}/${months.length} months).`,
    );
  }

  private async enqueueSeasonDailyValidation(
    season: SportsSeasonRecord,
    leagueId: string,
    competitionId: string,
  ): Promise<void> {
    const { start, end } = this.seasonDateRange(season);
    const fixtureDates = new Set(await this.collection.getFixtureDateKeysForSeason(competitionId, season.id));
    for (const date of this.eachDate(start, end)) {
      // A date with at least one persisted fixture is already represented in
      // the monthly import and will be reconciled by the fixture's normal
      // date-level refresh milestones. Only truly empty dates need the
      // bootstrap zero-fixture confirmation path.
      if (fixtureDates.has(date)) continue;
      await this.queue.enqueueIfMissing({
        type: SportsQueueJobType.FIXTURE_DAILY_VALIDATION,
        scope: {
          leagueId,
          competitionId,
          seasonId: season.id,
          seasonYear: season.year,
          calendarDate: date,
          seasonBootstrap: true,
          seasonEndDate: end.toISOString().slice(0, 10),
        },
        priority: this.priorityForDate(date),
        scheduledFor: new Date(),
        triggerEventId: `season-daily-validation:${season.id}:${date}`,
      });
    }
    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.FIXTURE_SEASON_VALIDATION_GATE,
      scope: {
        leagueId,
        competitionId,
        seasonId: season.id,
        seasonYear: season.year,
        seasonEndDate: end.toISOString().slice(0, 10),
      },
      priority: 65,
      scheduledFor: new Date(
        Date.now() + SPORTS_COLLECTION_SCHEDULE.bootstrapGate.intervalMs,
      ),
      recurrence: {
        intervalMs: SPORTS_COLLECTION_SCHEDULE.bootstrapGate.intervalMs,
        repeatUntil: 'DATA_COMPLETE',
      },
      triggerEventId: `season-validation-gate:${season.id}`,
    });
  }

  private async processSeasonValidationGate(
    scope: SportsQueueScope,
  ): Promise<void> {
    const competitionId = this.required(scope.competitionId, 'competitionId');
    const seasonId = this.required(scope.seasonId, 'seasonId');
    const season = await this.collection.getSeason(seasonId);
    if (!season?.isCurrent) return;
    if (
      !(await this.collection.isSeasonDailyValidationComplete(
        competitionId,
        seasonId,
        scope.seasonEndDate,
      ))
    )
      return;

    const completedCount = await this.forEachCompletedFixturePage(
      async (completed) => {
        for (const fixture of completed) {
          await this.enqueuePlays(
            fixture,
            `season-bootstrap-complete:${seasonId}`,
          );
        }
        await this.enqueueRecentCompletedNews(
          completed,
          `season-bootstrap:${seasonId}:news`,
        );
      },
      { competitionId, seasonId },
    );
    await this.enqueueDerivedProjection(
      competitionId,
      seasonId,
      `season-validation:${seasonId}`,
    );
    this.logger.log(
      `Season ${seasonId} passed daily fixture validation; recovered ${completedCount} completed fixtures and queued Plays and initial derived projections.`,
    );
  }

  private async processDailyScoreboard(
    scope: SportsQueueScope,
    validateCoverage: boolean,
  ): Promise<void> {
    const leagueId = this.required(scope.leagueId, 'leagueId').toLowerCase();
    const competitionId = this.required(scope.competitionId, 'competitionId');
    const seasonId = this.required(scope.seasonId, 'seasonId');
    const season = await this.collection.getSeason(seasonId);
    if (!season?.isCurrent) return;
    const date = this.required(scope.calendarDate, 'calendarDate');
    const dateScope = {
      competitionId,
      seasonId,
      seasonYear: Number(scope.seasonYear),
    };

    if (
      validateCoverage &&
      (await this.collection.isDailyValidationComplete(
        competitionId,
        seasonId,
        date,
      ))
    ) {
      return;
    }

    // A date-level job is tied to the kickoff anchor that created it. If a
    // fixture moves, newer jobs are created for its new date and stale work exits.
    if (scope.milestone && scope.expectedKickoffAt) {
      const anchorFixtures = (
        await this.collection.getFixturesForCompetitionDate(competitionId, date)
      ).filter(
        (item) =>
          !['POSTPONED', 'CANCELLED', 'ABANDONED'].includes(item.status.state),
      );
      const anchorFixture = anchorFixtures.find(
        (item) => item.kickoffAt.toISOString() === scope.expectedKickoffAt,
      );
      const anchor = anchorFixture
        ? new Date(scope.expectedKickoffAt).getTime()
        : Number.POSITIVE_INFINITY;
      if (
        !Number.isFinite(anchor) ||
        new Date(anchor).toISOString() !== scope.expectedKickoffAt
      )
        return;
      const extendedScope = scope;
      if (extendedScope.milestone === 'AFTER_MATCH') {
        const expectedCompletedAt = extendedScope.expectedCompletedAt
          ? new Date(extendedScope.expectedCompletedAt).getTime()
          : Number.NaN;
        const actualCompletedAt = anchorFixture?.completedAt
          ? new Date(anchorFixture.completedAt).getTime()
          : Number.NaN;
        if (
          !anchorFixture ||
          !(
            anchorFixture.status.state === 'COMPLETED' ||
            anchorFixture.status.isFinal
          ) ||
          !Number.isFinite(expectedCompletedAt) ||
          actualCompletedAt !== expectedCompletedAt
        )
          return;
      }
    }

    // Compatibility guard for any in-flight fixture-scoped jobs from a previous deployment.
    if (scope.fixtureId) {
      const fixture = await this.collection.getFixture(scope.fixtureId);
      if (!fixture) return;
      if (
        scope.expectedKickoffAt &&
        new Date(scope.expectedKickoffAt).getTime() !==
          fixture.kickoffAt.getTime()
      )
        return;
      if (this.dateKey(fixture.kickoffAt) !== date) return;
    }

    const knownBefore = await this.collection.getFixturesForCompetitionDate(
      competitionId,
      date,
    );
    let result: FixtureCollectionResult | undefined;
    let primaryError: unknown;
    try {
      result = await this.collection.collectDailyFixtures(
        leagueId,
        date,
        dateScope,
      );
    } catch (error) {
      primaryError = error;
    }

    // Never conclude that an entire calendar date is empty from one response.
    // Double-check zero-fixture dates after 30 seconds; a failed confirmation
    // remains incomplete and the durable queue retries the validation job.
    if (
      validateCoverage &&
      !primaryError &&
      knownBefore.length === 0 &&
      result?.receivedCount === 0 &&
      result.rejected.length === 0
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 30_000));
      try {
        result = await this.collection.collectDailyFixtures(
          leagueId,
          date,
          dateScope,
        );
      } catch (error) {
        primaryError = error;
        result = undefined;
      }
    }

    const dailyIds = new Set((result?.items ?? []).map((item) => item.id));
    const fallbackEventIds = new Set<string>();
    for (const fixture of knownBefore) {
      if (!dailyIds.has(fixture.id)) fallbackEventIds.add(fixture.espnEventId);
    }
    for (const rejected of result?.rejected ?? []) {
      if (rejected.eventId) fallbackEventIds.add(rejected.eventId);
    }

    const fallbackItems: SportsFixtureRecord[] = [];
    const failedFallbackEventIds: string[] = [];
    let retryableFallbackError: unknown;
    for (const eventId of fallbackEventIds) {
      try {
        const recovered = await this.collection.collectFixtureSummary(
          leagueId,
          eventId,
          dateScope,
        );
        if (recovered) fallbackItems.push(recovered);
        else failedFallbackEventIds.push(eventId);
      } catch (error) {
        failedFallbackEventIds.push(eventId);
        if (this.isRetryableProviderError(error)) retryableFallbackError ??= error;
        this.logger.warn(
          `ESPN Summary fallback failed for ${leagueId}/${eventId}: ${describeError(error)}`,
        );
      }
    }

    // A partial Summary recovery cannot prove the date was fully checked when
    // the primary scoreboard request or a required Summary fallback failed
    // transiently. Preserve the typed provider error so the queue backs off.
    if (primaryError && this.isRetryableProviderError(primaryError)) throw primaryError;
    if (retryableFallbackError) throw retryableFallbackError;

    const unidentifiedRejected = (result?.rejected ?? []).filter(
      (item) => !item.eventId,
    ).length;
    const unresolvedFallbackCount =
      failedFallbackEventIds.length + unidentifiedRejected;
    const receivedCount = result?.receivedCount ?? 0;
    const persistedCount = (result?.items.length ?? 0) + fallbackItems.length;

    if (validateCoverage) {
      let validation:
        | 'FIXTURES_FOUND'
        | 'NO_FIXTURES_CONFIRMED'
        | 'RECOVERED_FROM_SUMMARY'
        | 'INCOMPLETE';
      if (
        (primaryError && knownBefore.length === 0) ||
        unresolvedFallbackCount > 0
      )
        validation = 'INCOMPLETE';
      else if (fallbackItems.length > 0 || primaryError)
        validation = 'RECOVERED_FROM_SUMMARY';
      else if (receivedCount === 0 && knownBefore.length === 0)
        validation = 'NO_FIXTURES_CONFIRMED';
      else validation = 'FIXTURES_FOUND';

      await this.collection.recordFixtureDayValidation({
        competitionId,
        seasonId,
        leagueId,
        date,
        endpoint: `/leagues/${leagueId}/scoreboard?dates=${date.replace(/-/g, '')}`,
        result: validation,
        receivedCount,
        persistedCount,
        missingCount: unresolvedFallbackCount,
        resultSummary: {
          rejectedCount: result?.rejected.length ?? 0,
          summaryRecoveryCount: fallbackItems.length,
          failedSummaryEventIds: failedFallbackEventIds,
          primaryError:
            primaryError === undefined
              ? undefined
              : describeError(primaryError),
        },
      });
      if (validation === 'INCOMPLETE') {
        throw new Error(
          `Daily fixture validation is incomplete for ${leagueId} on ${date}; ${unresolvedFallbackCount} item(s) could not be recovered.`,
        );
      }
    } else if (
      primaryError &&
      (knownBefore.length === 0 || unresolvedFallbackCount > 0)
    ) {
      throw primaryError instanceof Error
        ? primaryError
        : new Error(describeError(primaryError));
    } else if (unresolvedFallbackCount > 0) {
      throw new Error(
        `Daily scoreboard ${leagueId}/${date} omitted fixture data that Summary could not recover.`,
      );
    }

    let allowPlays = !validateCoverage;
    let bootstrapContext:
      | Pick<
          SportsQueueScope,
          'bootstrapRunId' | 'seasonBootstrap' | 'seasonEndDate'
        >
      | undefined;
    if (scope.bootstrapRunId) {
      const bootstrap = await this.getBootstrapState(scope.bootstrapRunId);
      const bootstrapCompleted = bootstrap?.status === 'COMPLETED';
      allowPlays = !validateCoverage && bootstrapCompleted;
      if (!bootstrapCompleted)
        bootstrapContext = { bootstrapRunId: scope.bootstrapRunId };
    } else if (scope.seasonBootstrap && scope.seasonId) {
      const seasonValidationComplete =
        await this.collection.isSeasonDailyValidationComplete(
          competitionId,
          scope.seasonId,
          scope.seasonEndDate,
        );
      allowPlays = !validateCoverage && seasonValidationComplete;
      if (!seasonValidationComplete)
        bootstrapContext = {
          seasonBootstrap: true,
          seasonEndDate: scope.seasonEndDate,
        };
    }
    await this.scheduleFixtureJobs(
      [...(result?.items ?? []), ...fallbackItems],
      `daily:${date}`,
      allowPlays,
      bootstrapContext,
    );
    if (validateCoverage && allowPlays) {
      const knownAfter = await this.collection.getFixturesForCompetitionDate(
        competitionId,
        date,
      );
      await this.scheduleFixtureJobs(
        knownAfter,
        `daily-validated:${date}`,
        true,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Match-specific odds, live scoreboard and completed Plays
  // ---------------------------------------------------------------------------

  private async processMatchOdds(scope: SportsQueueScope): Promise<void> {
    if (!scope.milestone || !ACTIVE_ODDS_MILESTONES.has(scope.milestone)) {
      this.logger.debug(
        `Skipping legacy or retired odds job (milestone=${scope.milestone ?? 'missing'}) for fixture ${scope.fixtureId ?? 'unknown'}.`,
      );
      return;
    }
    const fixtureId = this.required(scope.fixtureId, 'fixtureId');
    const fixture = await this.collection.getFixture(fixtureId);
    if (!fixture)
      throw new Error(`Odds job references missing fixture ${fixtureId}.`);
    if (
      scope.expectedKickoffAt &&
      new Date(scope.expectedKickoffAt).getTime() !==
        fixture.kickoffAt.getTime()
    ) {
      this.logger.debug(
        `Skipping stale odds job for ${fixtureId}; kickoff changed.`,
      );
      return;
    }
    if (
      fixture.status.state !== 'SCHEDULED' ||
      fixture.status.isFinal ||
      Date.now() >= fixture.kickoffAt.getTime()
    )
      return;
    await this.collection.collectMatchOdds(fixture);
  }

  private async processLiveScoreboard(scope: SportsQueueScope): Promise<void> {
    const leagueId = this.required(scope.leagueId, 'leagueId').toLowerCase();
    const competitionId = this.required(scope.competitionId, 'competitionId');
    const date = this.required(scope.calendarDate, 'calendarDate');
    const result = await this.collection.collectLiveScoreboard(
      leagueId,
      {
        competitionId,
        seasonId: scope.seasonId,
        seasonYear: scope.seasonYear,
      },
      date,
    );

    // Live monitoring may be scheduled during bootstrap, but Plays must wait
    // until all initial fixture validation (or this new season's validation) is complete.
    let allowPlays = true;
    let bootstrapContext:
      | Pick<
          SportsQueueScope,
          'bootstrapRunId' | 'seasonBootstrap' | 'seasonEndDate'
        >
      | undefined;
    if (scope.bootstrapRunId) {
      const bootstrap = await this.getBootstrapState(scope.bootstrapRunId);
      allowPlays = bootstrap?.status === 'COMPLETED';
      if (!allowPlays)
        bootstrapContext = { bootstrapRunId: scope.bootstrapRunId };
    } else if (scope.seasonBootstrap && scope.seasonId) {
      allowPlays = await this.collection.isSeasonDailyValidationComplete(
        competitionId,
        scope.seasonId,
        scope.seasonEndDate,
      );
      if (!allowPlays)
        bootstrapContext = {
          seasonBootstrap: true,
          seasonEndDate: scope.seasonEndDate,
        };
    }
    await this.scheduleFixtureJobs(
      result.items,
      `live-scoreboard:${date}`,
      allowPlays,
      bootstrapContext,
    );
  }

  private async processMatchSummary(scope: SportsQueueScope): Promise<void> {
    const fixtureId = this.required(scope.fixtureId, 'fixtureId');
    const fixture = await this.collection.getFixture(fixtureId);
    if (!fixture) throw new Error(`Summary job references missing fixture ${fixtureId}.`);
    if (!(fixture.status.state === 'COMPLETED' || fixture.status.isFinal)) return;

    if (scope.expectedCompletedAt && fixture.completedAt) {
      const expected = new Date(scope.expectedCompletedAt).getTime();
      const actual = new Date(fixture.completedAt).getTime();
      if (Number.isFinite(expected) && Number.isFinite(actual) && expected !== actual) {
        this.logger.debug(`Skipping stale Summary job for ${fixtureId}; completion timestamp changed.`);
        return;
      }
    }

    const eventId = fixture.espnEventId;
    if (!eventId) throw new Error(`Summary job references fixture ${fixtureId} without an ESPN event ID.`);
    const competition = await this.collection.getCompetition(fixture.competitionId);
    if (!competition?.slug) throw new Error(`Summary job references fixture ${fixtureId} without a competition slug.`);

    // A backfill must not be suppressed by legacy success state created before
    // raw Summary snapshots were persisted. The backfill run has its own queue identity.
    if (!scope.summaryBackfillRunId && await this.collection.isFixtureSummaryFallbackFresh(eventId)) return;

    const normalizedFixture = await this.collection.collectFixtureSummary(
      competition.slug,
      eventId,
      {
        competitionId: fixture.competitionId,
        seasonId: fixture.seasonId,
        seasonYear: fixture.seasonYear,
      },
    );
    if (normalizedFixture) return;

    const rawAttempt = Number(scope.summaryAttempt ?? 0);
    const attempt = Number.isInteger(rawAttempt) && rawAttempt >= 0 ? rawAttempt : 0;
    const retryDelays = SPORTS_COLLECTION_SCHEDULE.summaryNormalizationRetries.delaysMs;
    const retryDelayMs = retryDelays[attempt];
    if (retryDelayMs === undefined) {
      this.logger.warn(`ESPN Summary remained unnormalizable for ${fixtureId} after ${retryDelays.length + 1} attempts; raw payload remains retained.`);
      return;
    }

    const nextAttempt = attempt + 1;
    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.MATCH_SUMMARY_COLLECTION,
      scope: {
        fixtureId: fixture.id,
        espnEventId: eventId,
        competitionId: fixture.competitionId,
        seasonId: fixture.seasonId,
        seasonYear: fixture.seasonYear,
        leagueId: competition.slug,
        ...(fixture.completedAt ? { expectedCompletedAt: new Date(fixture.completedAt).toISOString() } : {}),
        summaryAttempt: nextAttempt,
        ...(scope.summaryBackfillRunId ? { summaryBackfillRunId: scope.summaryBackfillRunId } : {}),
      },
      priority: 94,
      scheduledFor: new Date(Date.now() + retryDelayMs),
      triggerEventId: `summary-retry:${fixture.id}:attempt:${nextAttempt}`,
    });
  }

  /**
   * The first page fans out one durable cursor chain per competition. This
   * keeps startup seeding bounded and lets each competition progress/retry
   * independently without loading the full historical fixture catalogue.
   */
  private async processMatchSummaryBackfill(scope: SportsQueueScope): Promise<void> {
    const runId = this.required(scope.backfillRunId, 'backfillRunId');
    const competitionId = String(scope.competitionId ?? '').trim();

    if (!competitionId) {
      const competitions = await this.collection.getAllCompetitions();
      let enqueued = 0;
      for (const competition of competitions) {
        if (!competition.id || !competition.slug) continue;
        const result = await this.queue.enqueueIfMissing({
          type: SportsQueueJobType.MATCH_SUMMARY_BACKFILL,
          scope: {
            competitionId: competition.id,
            backfillRunId: runId,
          },
          priority: SPORTS_COLLECTION_SCHEDULE.summaryBackfill.priority,
          scheduledFor: new Date(Date.now() + enqueued * 1_000),
          triggerEventId: `summary-backfill:${runId}:${competition.id}:start`,
        });
        if (result.created) enqueued += 1;
      }
      this.logger.log(`Historical Summary backfill ${runId}: seeded ${enqueued} competition scans.`);
      return;
    }

    const competition = await this.collection.getCompetition(competitionId);
    if (!competition?.slug) {
      this.logger.warn(`Skipping Summary backfill for ${competitionId}: competition or ESPN slug is missing.`);
      return;
    }

    const pageSize = SPORTS_COLLECTION_SCHEDULE.summaryBackfill.pageSize;
    const page = await this.collection.getSummaryBackfillPage({
      competitionId,
      cursorKickoffAt: scope.backfillCursorKickoffAt,
      cursorFixtureId: scope.backfillCursorFixtureId,
      limit: pageSize,
    });

    if (!page.length) {
      await this.enqueueCompetitionDerivedBackfill(competitionId, runId);
      this.logger.log(`Historical Summary backfill ${runId}: completed ${competitionId}.`);
      return;
    }

    const startedAt = Date.now();
    let queued = 0;
    let normalized = 0;
    let skipped = 0;
    for (const item of page) {
      const fixture = item.fixture;
      if (!item.summaryPayloadHash) {
        const scheduledFor = new Date(
          startedAt + queued * SPORTS_COLLECTION_SCHEDULE.summaryBackfill.requestSpacingMs,
        );
        const result = await this.queue.enqueueIfMissing({
          type: SportsQueueJobType.MATCH_SUMMARY_COLLECTION,
          scope: {
            fixtureId: fixture.id,
            espnEventId: fixture.espnEventId,
            competitionId: fixture.competitionId,
            seasonId: fixture.seasonId,
            seasonYear: fixture.seasonYear,
            leagueId: competition.slug,
            ...(fixture.completedAt
              ? { expectedCompletedAt: new Date(fixture.completedAt).toISOString() }
              : {}),
            summaryAttempt: 0,
            summaryBackfillRunId: runId,
          },
          priority: 35,
          scheduledFor,
          triggerEventId: `summary-backfill:${runId}:${fixture.id}:attempt:0`,
        });
        if (result.created) queued += 1;
        else skipped += 1;
        continue;
      }

      if (item.factsPayloadHash !== item.summaryPayloadHash) {
        const wasNormalized = await this.collection.normalizeStoredMatchSummary(fixture);
        if (wasNormalized) normalized += 1;
        else skipped += 1;
      } else {
        skipped += 1;
      }
    }

    const lastFixture = page[page.length - 1].fixture;
    if (page.length === pageSize) {
      const nextCursorKickoffAt = new Date(lastFixture.kickoffAt).toISOString();
      const nextCursorFixtureId = lastFixture.id;
      const pageDelay = Math.max(
        SPORTS_COLLECTION_SCHEDULE.summaryBackfill.nextPageDelayMs,
        queued * SPORTS_COLLECTION_SCHEDULE.summaryBackfill.requestSpacingMs,
      );
      await this.queue.enqueueIfMissing({
        type: SportsQueueJobType.MATCH_SUMMARY_BACKFILL,
        scope: {
          competitionId,
          backfillRunId: runId,
          backfillCursorKickoffAt: nextCursorKickoffAt,
          backfillCursorFixtureId: nextCursorFixtureId,
        },
        priority: SPORTS_COLLECTION_SCHEDULE.summaryBackfill.priority,
        scheduledFor: new Date(startedAt + pageDelay),
        triggerEventId: `summary-backfill:${runId}:${competitionId}:${nextCursorKickoffAt}:${nextCursorFixtureId}`,
      });
    } else {
      await this.enqueueCompetitionDerivedBackfill(competitionId, runId);
      this.logger.log(`Historical Summary backfill ${runId}: completed ${competitionId}; queued ${queued}, locally normalized ${normalized}, already covered/skipped ${skipped}.`);
    }

    this.logger.debug(
      `Historical Summary backfill ${runId}/${competitionId}: scanned ${page.length}, queued ${queued}, locally normalized ${normalized}, skipped ${skipped}.`,
    );
  }

  private async processMatchPlays(scope: SportsQueueScope): Promise<void> {
    const fixtureId = this.required(scope.fixtureId, 'fixtureId');
    const fixture = await this.collection.getFixture(fixtureId);
    if (!fixture)
      throw new Error(`Plays job references missing fixture ${fixtureId}.`);
    if (!fixture.status.isFinal && fixture.status.state !== 'COMPLETED') return;
    // Settlement may have accelerated this collection for a finished match.
    // Avoid a duplicate ESPN request when the durable Plays job runs later.
    if (await this.collection.hasCompleteMatchPlays(fixture.id)) return;
    // Several older schedule/source-change jobs may already be pending for the
    // same completed fixture. Honour the same cooldown at execution time so
    // those persisted duplicates do not immediately repeat a no-data request.
    if (!(await this.collection.shouldCollectMatchPlays(fixture.id))) return;
    await this.collection.collectMatchPlays(fixture);
    // Timeline persistence emits a durable source-change event. That event
    // coalesces all dependent projections instead of recalculating inline.
  }

  private async processSourceFactsChanged(
    scope: SportsQueueScope,
  ): Promise<void> {
    const extendedScope = scope;
    const competitionId = this.required(scope.competitionId, 'competitionId');
    const fixtureId = this.required(scope.fixtureId, 'fixtureId');
    const fixture = await this.collection.getFixture(fixtureId);
    if (
      !fixture ||
      !(fixture.status.state === 'COMPLETED' || fixture.status.isFinal)
    )
      return;
    const seasons = (await this.collection.getAllSeasons())
      .filter((season) => season.competitionId === competitionId)
      .sort((a, b) => a.year - b.year);
    const fixtureSeason = seasons.find((season) => season.id === fixture.seasonId);
    const currentSeason = seasons.find((season) => season.isCurrent);
    const affectedSeasons = fixtureSeason
      ? seasons.filter((season) => season.year >= fixtureSeason.year)
      : currentSeason ? [currentSeason] : [];
    const cause = `source-change:${extendedScope.sourceKind ?? 'UNKNOWN'}:${fixtureId}:${extendedScope.sourceFingerprint ?? 'unfingerprinted'}`;
    for (const season of affectedSeasons) {
      await this.enqueueDerivedProjection(competitionId, season.id, cause);
    }
  }

  private async processLeagueNews(scope: SportsQueueScope): Promise<void> {
    const extendedScope = scope;
    const leagueId = this.required(scope.leagueId, 'leagueId').toLowerCase();
    const competitionId = this.required(scope.competitionId, 'competitionId');
    const fixtureIds = [
      ...new Set(
        extendedScope.fixtureIds ?? (scope.fixtureId ? [scope.fixtureId] : []),
      ),
    ];
    const fixtures: SportsFixtureRecord[] = [];
    for (const fixtureId of fixtureIds) {
      const fixture = await this.collection.getFixture(fixtureId);
      if (fixture) fixtures.push(fixture);
    }
    await this.news.collectLeagueNews(leagueId, competitionId, fixtures);
  }

  private async processSportsRetentionCleanup(): Promise<void> {
    const result = await this.collection.pruneExpiredFixtures(
      SPORTS_COLLECTION_SCHEDULE.retentionCleanup.batchSize,
    );
    if (result.deletedCount > 0) {
      for (const competitionId of result.affectedCompetitionIds) {
        const seasons = (await this.collection.getAllSeasons())
          .filter((season) => season.competitionId === competitionId)
          .sort((a, b) => a.year - b.year);
        for (const season of seasons) {
          await this.enqueueDerivedProjection(
            competitionId,
            season.id,
            `retention:${result.deletedCount}`,
          );
        }
      }
      this.logger.log(`Sports retention cleanup removed ${result.deletedCount} expired fixtures from ${result.affectedCompetitionIds.length} competitions.`);
    }
  }

  private async processDerivedData(scope: SportsQueueScope): Promise<void> {
    const competitionId = this.required(scope.competitionId, 'competitionId');
    const seasonId = this.required(scope.seasonId, 'seasonId');
    const season = await this.collection.getSeason(seasonId);
    if (!season || season.competitionId !== competitionId) {
      this.logger.warn(`Skipping derived recalculation: season ${seasonId} does not belong to ${competitionId}.`);
      return;
    }

    // Current-season Summary fallback checks only need completed fixtures.
    // Stream those rows so the recovery pass never loads the full season.
    const completedTeamIds = new Set<string>();
    if (season.isCurrent) {
      await this.forEachCompletedFixturePage(
        async (completed) => {
          for (const fixture of completed) {
            for (const competitor of fixture.competitors ?? []) {
              if (competitor.teamId) completedTeamIds.add(competitor.teamId);
            }

            const hasPrimaryStatistics =
              fixture.competitors.length === 2 &&
              fixture.competitors.every(
                (competitor) => (competitor.statistics?.length ?? 0) > 0,
              );
            const rawPayload = asRecord(fixture.rawPayload);
            const summary = asRecord(rawPayload.summaryFallback ?? rawPayload);
            const summaryTeams = asArray(asRecord(summary.boxscore).teams);
            const summaryHasStatistics =
              fixture.competitors.length === 2 &&
              fixture.competitors.every((competitor) => {
                const espnTeamId = competitor.teamId.replace(/^team:/, '');
                return summaryTeams.some((teamValue) => {
                  const team = asRecord(teamValue);
                  const nestedTeam = asRecord(team.team ?? teamValue);
                  return (
                    asText(nestedTeam.id) === espnTeamId &&
                    asArray(team.statistics).length > 0
                  );
                });
              });
            const summaryHasPlayerAppearances =
              this.hasSummaryPlayerAppearanceData(summary);
            const summaryFallbackFresh = fixture.espnEventId
              ? await this.collection.isFixtureSummaryFallbackFresh(
                  fixture.espnEventId,
                )
              : false;
            const missingTeamStatistics =
              !hasPrimaryStatistics && !summaryHasStatistics;
            const missingPlayerAppearances = !summaryHasPlayerAppearances;
            if (
              (missingTeamStatistics || missingPlayerAppearances) &&
              !summaryFallbackFresh &&
              fixture.espnEventId
            ) {
              const competition = await this.collection.getCompetition(
                fixture.competitionId,
              );
              if (competition) {
                // ESPN Summary is also the reliable source for the root-level rosters[]
                // lineup payload. Fetch it when either team statistics or player
                // appearance facts are absent, then retain the complete raw response.
                await this.collection.collectFixtureSummary(
                  competition.slug,
                  fixture.espnEventId,
                  {
                    competitionId,
                    seasonId,
                    seasonYear: fixture.seasonYear,
                  },
                );
              }
            }
          }
        },
        { competitionId, seasonId, includeProjectionData: true },
      );
    }

    await this.derived.recalculateSeason(competitionId, seasonId);

    // Repriced Grivit markets must consume the freshly calculated form,
    // standings, home/away records, scoring rates and player-event totals.
    // The periodic Odds scan remains a recovery path, not the primary trigger.
    const projectionWindow = String(
      scope.projectionWindow ?? Math.floor(
        Date.now() / SPORTS_COLLECTION_SCHEDULE.derivedData.coalesceWindowMs,
      ),
    );
    const now = new Date();
    const completedTeamIdList = [...completedTeamIds];

    // A season projection may be used by upcoming fixtures from another
    // competition when one of the participating teams also appears there.
    // Query all retained upcoming fixtures in this competition first, then
    // add cross-competition fixtures for teams represented in this season.
    const sameCompetitionUpcoming = await this.getUpcomingFixtures({
      competitionId,
      from: now,
    });
    const crossCompetitionUpcoming = await this.getUpcomingCrossCompetitionFixtures(
      completedTeamIdList,
      competitionId,
      now,
    );
    const upcomingById = new Map<string, SportsFixtureRecord>();
    for (const fixture of [...sameCompetitionUpcoming, ...crossCompetitionUpcoming]) {
      if (this.isUpcomingFixture(fixture, now)) upcomingById.set(String(fixture.id), fixture);
    }
    const upcomingFixtures = [...upcomingById.values()];

    for (let offset = 0; offset < upcomingFixtures.length; offset += 20) {
      const batch = upcomingFixtures.slice(offset, offset + 20);
      await Promise.all(batch.map((fixture) => this.queue.enqueueIfMissing({
        type: SportsQueueJobType.ODDS_PRICING_RECALCULATION,
        scope: {
          fixtureId: String(fixture.id),
          projectionWindow,
          sourceKind: 'FIXTURE',
          sourceFingerprint: `DERIVED_PROJECTION:${competitionId}:${seasonId}:${projectionWindow}`,
        },
        priority: 70,
        scheduledFor: now,
        triggerEventId: `odds:projection:${competitionId}:${seasonId}:${projectionWindow}:${fixture.id}`,
      })));
    }

    if (upcomingFixtures.length) {
      this.logger.log(
        `Derived projections refreshed for ${competitionId}/${seasonId}; queued Grivit repricing for ${upcomingFixtures.length} upcoming fixtures.`,
      );
    }
  }

  private async getUpcomingFixtures(query: {
    competitionId?: string;
    teamId?: string;
    from: Date;
  }): Promise<SportsFixtureRecord[]> {
    const items = new Map<string, SportsFixtureRecord>();
    let cursor: string | undefined;
    do {
      const page = await this.sportsRead.getFixtures({
        ...(query.competitionId ? { competitionId: query.competitionId } : {}),
        ...(query.teamId ? { teamId: query.teamId } : {}),
        from: query.from,
        limit: 100,
        cursor,
        sortOrder: 'ASC',
        retainedOnly: true,
      });
      for (const fixture of page.items) items.set(String(fixture.id), fixture);
      cursor = page.nextCursor;
    } while (cursor);
    return [...items.values()];
  }

  private async getUpcomingCrossCompetitionFixtures(
    teamIds: string[],
    sourceCompetitionId: string,
    now: Date,
  ): Promise<SportsFixtureRecord[]> {
    const uniqueTeamIds = [...new Set(teamIds.map((id) => String(id ?? '').trim()).filter(Boolean))];
    const results = new Map<string, SportsFixtureRecord>();
    // Keep DB concurrency bounded; a team can have many retained fixtures but
    // each read is keyset-paginated and deduplicated across both opponents.
    for (let offset = 0; offset < uniqueTeamIds.length; offset += 5) {
      const batch = uniqueTeamIds.slice(offset, offset + 5);
      const pages = await Promise.all(batch.map((teamId) =>
        this.getUpcomingFixtures({ teamId, from: now }),
      ));
      for (const fixturesForTeam of pages) {
        for (const fixture of fixturesForTeam) {
          if (fixture.competitionId !== sourceCompetitionId && this.isUpcomingFixture(fixture, now)) {
            results.set(String(fixture.id), fixture);
          }
        }
      }
    }
    return [...results.values()];
  }

  private isUpcomingFixture(fixture: SportsFixtureRecord, now: Date): boolean {
    const kickoffAt = fixture.kickoffAt instanceof Date
      ? fixture.kickoffAt
      : new Date(fixture.kickoffAt as unknown as string);
    const state = String(fixture.status?.state ?? 'UNKNOWN').toUpperCase();
    return Number.isFinite(kickoffAt.getTime())
      && kickoffAt.getTime() > now.getTime()
      && !['LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES', 'COMPLETED', 'POSTPONED', 'CANCELLED', 'CANCELED', 'ABANDONED'].includes(state)
      && fixture.status?.isFinal !== true;
  }

  private hasSummaryPlayerAppearanceData(summaryValue: unknown): boolean {
    const summary = asRecord(summaryValue);
    const rootRosters = asArray(summary.rosters);
    const rosters = rootRosters.length
      ? rootRosters
      : asArray(asRecord(summary.boxscore).rosters);
    return rosters.some((sectionValue) => {
      const section = asRecord(sectionValue);
      const roster = asArray(section.roster ?? section.players);
      return roster.some((playerValue) => {
        const player = asRecord(playerValue);
        const athleteId =
          asRecord(player.athlete).id ??
          player.athleteId ??
          asRecord(player.player).id;
        if (!athleteId) return false;
        const stats = asArray(player.stats ?? player.statistics);
        const hasAppearanceStat = stats.some((statValue) => {
          const stat = asRecord(statValue);
          const key = asText(
            stat.name ??
              stat.displayName ??
              stat.shortDisplayName ??
              stat.abbreviation,
          )
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
          return key === 'appearances' || key === 'appearance' || key === 'app';
        });
        return (
          hasAppearanceStat ||
          player.starter === true ||
          player.subbedIn === true ||
          player.subbed_in === true
        );
      });
    });
  }

  private async enqueueRecentCompletedNews(
    fixtures: SportsFixtureRecord[],
    cause: string,
  ): Promise<void> {
    const recentCutoff = Date.now() - 48 * 60 * 60_000;
    for (const fixture of fixtures) {
      const completedAt =
        fixture.completedAt?.getTime() ??
        fixture.kickoffAt.getTime() +
          SPORTS_COLLECTION_SCHEDULE.fixtureRefreshAfterMatch.delayMs;
      if (completedAt < recentCutoff) continue; // Historical backfill is for Plays, not post-match news.
      const competition = await this.collection.getCompetition(
        fixture.competitionId,
      );
      if (!competition) continue;
      await this.enqueueLeagueNews(
        competition.slug,
        competition.id,
        fixture,
        'AFTER_MATCH',
        new Date(Math.max(Date.now(), completedAt)),
      );
    }
    if (fixtures.length)
      this.logger.debug(
        `Recent post-match news follow-ups checked for ${fixtures.length} completed fixtures (${cause}).`,
      );
  }

  private async enqueueCompetitionDerivedBackfill(
    competitionId: string,
    runId: string,
  ): Promise<void> {
    const seasons = (await this.collection.getAllSeasons())
      .filter((season) => season.competitionId === competitionId)
      .sort((a, b) => a.year - b.year);
    const baseTime = Date.now() + SPORTS_COLLECTION_SCHEDULE.derivedData.historicalBackfillDelayMs;
    let enqueued = 0;
    for (const [index, season] of seasons.entries()) {
      const result = await this.queue.enqueueIfMissing({
        type: SportsQueueJobType.DERIVED_DATA_RECALCULATION,
        scope: {
          competitionId,
          seasonId: season.id,
          projectionWindow: `SUMMARY_BACKFILL:${runId}`,
        },
        priority: SPORTS_COLLECTION_SCHEDULE.derivedData.historicalBackfillPriority,
        scheduledFor: new Date(baseTime + index * SPORTS_COLLECTION_SCHEDULE.derivedData.historicalBackfillSpacingMs),
        triggerEventId: `derived:summary-backfill:${runId}:${competitionId}:${season.id}`,
      });
      if (result.created) enqueued += 1;
    }
    this.logger.log(
      `Historical derived-data backfill ${runId}/${competitionId}: queued ${enqueued} retained season projections.`,
    );
  }

  private async enqueueDerivedProjection(
    competitionId: string,
    seasonId: string,
    cause: string,
  ): Promise<void> {
    const window = Math.floor(
      Date.now() / SPORTS_COLLECTION_SCHEDULE.derivedData.coalesceWindowMs,
    );
    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.DERIVED_DATA_RECALCULATION,
      scope: {
        competitionId,
        seasonId,
        projectionWindow: String(window),
      },
      priority: 45,
      scheduledFor: new Date(),
      triggerEventId: `derived:${competitionId}:${seasonId}:${window}:${cause}`,
    });
  }

  private async enqueueLeagueNews(
    leagueId: string,
    competitionId: string,
    fixture: SportsFixtureRecord,
    milestone: 'PRE_MATCH' | 'AFTER_MATCH',
    scheduledFor: Date,
  ): Promise<void> {
    const coalesceAt =
      milestone === 'AFTER_MATCH'
        ? (fixture.completedAt?.getTime() ??
          fixture.kickoffAt.getTime() +
            SPORTS_COLLECTION_SCHEDULE.fixtureRefreshAfterMatch.delayMs)
        : scheduledFor.getTime();
    const bucket = Math.floor(
      coalesceAt / SPORTS_COLLECTION_SCHEDULE.newsCoalesceWindow.intervalMs,
    );
    const newsWindow = `${milestone}:${competitionId}:${bucket}`;
    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.LEAGUE_NEWS_REFRESH,
      scope: {
        leagueId,
        competitionId,
        newsWindow,
        fixtureIds: [fixture.id],
        milestone,
      },
      priority: milestone === 'PRE_MATCH' ? 65 : 70,
      scheduledFor: new Date(Math.max(Date.now(), scheduledFor.getTime())),
      triggerEventId: `league-news:${newsWindow}`,
    });
  }

  // ---------------------------------------------------------------------------
  // Shared fixture event scheduling
  // ---------------------------------------------------------------------------

  private async scheduleFixtureJobs(
    fixtures: SportsFixtureRecord[],
    cause: string,
    allowPlays = true,
    bootstrapContext?: Pick<
      SportsQueueScope,
      'bootstrapRunId' | 'seasonBootstrap' | 'seasonEndDate'
    >,
  ): Promise<void> {
    if (!fixtures.length) return;

    const byCompetitionDate = new Map<
      string,
      {
        competition: SportsCompetitionRecord;
        calendarDate: string;
        fixtures: Map<string, SportsFixtureRecord>;
      }
    >();

    for (const fixture of fixtures) {
      const competition = await this.collection.getCompetition(
        fixture.competitionId,
      );
      if (!competition) {
        this.logger.warn(
          `Fixture ${fixture.id} references missing competition ${fixture.competitionId}; no timed jobs scheduled.`,
        );
        continue;
      }

      const completed =
        fixture.status.state === 'COMPLETED' || fixture.status.isFinal;

      // Match Summary is the primary post-match facts source and must not wait
      // for the Plays bootstrap/coverage gate. Plays remains independently gated.
      if (completed) {
        await this.enqueueSummary(fixture, competition, cause);
      }
      if (allowPlays && completed) {
        await this.enqueuePlays(fixture, cause);
      }

      const calendarDate = this.dateKey(fixture.kickoffAt);
      const key = `${fixture.competitionId}:${calendarDate}`;
      let group = byCompetitionDate.get(key);
      if (!group) {
        group = { competition, calendarDate, fixtures: new Map() };
        byCompetitionDate.set(key, group);
      }
      // Keep the latest copy encountered in this batch; it carries the freshest
      // status/scoreboard payload for the same ESPN fixture ID.
      group.fixtures.set(fixture.id, fixture);
    }

    for (const group of byCompetitionDate.values()) {
      const stored = await this.collection.getFixturesForCompetitionDate(
        group.competition.id,
        group.calendarDate,
      );
      const allById = new Map<string, SportsFixtureRecord>();
      // Persistence is the source of truth here: it may have attached the
      // first confirmed completedAt timestamp while protecting a terminal
      // fixture from a stale incoming scoreboard payload.
      for (const item of stored) allById.set(item.id, item);
      for (const item of group.fixtures.values()) {
        if (!allById.has(item.id)) allById.set(item.id, item);
      }
      const dayFixtures = [...allById.values()];
      for (const fixture of dayFixtures) {
        if (fixture.status.state === 'COMPLETED' || fixture.status.isFinal) {
          // YouTube is an independent post-match media workflow. It is
          // scheduled from the persisted fixture state so both fresh updates
          // and recovery passes can enqueue a missing highlight attempt.
          await this.youtubeHighlights.ensureFirstAttempt(fixture);
        }
      }
      const actionable = dayFixtures.filter(
        (item) =>
          !['POSTPONED', 'CANCELLED', 'ABANDONED'].includes(item.status.state),
      );
      if (!actionable.length) continue;

      const scheduled = actionable.filter(
        (item) =>
          item.status.state === 'SCHEDULED' &&
          item.kickoffAt.getTime() > Date.now(),
      );
      const scopeSeason = scheduled[0] ?? actionable[0];

      // One daily scoreboard refresh per competition/date/milestone. A daily
      // scoreboard returns the complete date, so per-fixture duplicate calls
      // would waste requests without increasing coverage.
      if (scheduled.length) {
        // The Site scoreboard returns a whole date, but its refresh milestones
        // are anchored to every distinct kickoff on that date. This prevents
        // an early fixture from consuming the only 48h/18h refresh for matches
        // that start later the same day.
        const kickoffGroups = new Map<number, SportsFixtureRecord[]>();
        for (const fixture of scheduled) {
          const kickoff = fixture.kickoffAt.getTime();
          const groupAtKickoff = kickoffGroups.get(kickoff) ?? [];
          groupAtKickoff.push(fixture);
          kickoffGroups.set(kickoff, groupAtKickoff);
        }
        for (const kickoff of kickoffGroups.keys()) {
          const dateScope: SportsQueueScope = {
            leagueId: group.competition.slug,
            competitionId: group.competition.id,
            seasonId: scopeSeason.seasonId,
            seasonYear: scopeSeason.seasonYear,
            calendarDate: group.calendarDate,
            expectedKickoffAt: new Date(kickoff).toISOString(),
            ...(bootstrapContext ?? {}),
          };
          await this.enqueueThresholdJobs(
            SportsQueueJobType.FIXTURE_DAILY_REFRESH,
            dateScope,
            [
              {
                name: 'FIXTURE_48H',
                leadMs: SPORTS_COLLECTION_SCHEDULE.fixtureRefresh48Hours.leadMs,
                priority: 75,
              },
              {
                name: 'FIXTURE_18H',
                leadMs: SPORTS_COLLECTION_SCHEDULE.fixtureRefresh18Hours.leadMs,
                priority: 80,
              },
            ],
            kickoff,
            `fixture-scoreboard:${group.competition.id}:${group.calendarDate}:${cause}:${kickoff}`,
            'FIXTURE_CATCHUP',
          );
        }

        // League News requests are coalesced by competition and a 30-minute
        // due-time bucket, so matches sharing the same news window use one call.
        for (const fixture of scheduled) {
          const newsAt = new Date(
            fixture.kickoffAt.getTime() -
              SPORTS_COLLECTION_SCHEDULE.leagueNewsPreMatch.leadMs,
          );
          await this.enqueueLeagueNews(
            group.competition.slug,
            group.competition.id,
            fixture,
            'PRE_MATCH',
            newsAt,
          );
        }

        // Odds are fixture-specific Core collections. Only the 48h, 24h and
        // 18h checkpoints are valid; missed checkpoints are skipped rather than
        // triggering an extra immediate collection on late fixture discovery.
        for (const fixture of scheduled) {
          const kickoff = fixture.kickoffAt.getTime();
          const oddsScope: SportsQueueScope = {
            fixtureId: fixture.id,
            espnEventId: fixture.espnEventId,
            leagueId: group.competition.slug,
            competitionId: fixture.competitionId,
            seasonId: fixture.seasonId,
            seasonYear: fixture.seasonYear,
            calendarDate: group.calendarDate,
            expectedKickoffAt: new Date(kickoff).toISOString(),
          };
          await this.enqueueThresholdJobs(
            SportsQueueJobType.MATCH_ODDS_REFRESH,
            oddsScope,
            [
              {
                name: 'ODDS_48H',
                leadMs: SPORTS_COLLECTION_SCHEDULE.matchOdds48Hours.leadMs,
                priority: 90,
              },
              {
                name: 'ODDS_24H',
                leadMs: SPORTS_COLLECTION_SCHEDULE.matchOdds24Hours.leadMs,
                priority: 92,
              },
              {
                name: 'ODDS_18H',
                leadMs: SPORTS_COLLECTION_SCHEDULE.matchOdds18Hours.leadMs,
                priority: 95,
              },
            ],
            kickoff,
            `fixture-odds:${fixture.id}:${cause}`,
            'ODDS_CATCHUP',
            false,
          );
        }
      }

      // Schedule a post-match date refresh for each completion-time bucket.
      // A single latest-completion job would delay earlier finished matches
      // on busy dates.
      // During initial bootstrap, the daily validation pass already covers each
      // date, so only ordinary maintenance work creates these follow-ups.
      if (allowPlays) {
        const newlyCompleted = actionable.filter(
          (item) => item.status.state === 'COMPLETED' || item.status.isFinal,
        );
        const newsAt = new Date();
        for (const fixture of newlyCompleted) {
          await this.enqueueLeagueNews(
            group.competition.slug,
            group.competition.id,
            fixture,
            'AFTER_MATCH',
            newsAt,
          );
        }

        const completedWithTimestamp = actionable.filter(
          (item) =>
            (item.status.state === 'COMPLETED' || item.status.isFinal) &&
            Boolean(item.completedAt),
        );
        const completionBuckets = new Map<number, SportsFixtureRecord[]>();
        const bucketSize = 5 * SPORTS_COLLECTION_TIME.MINUTE;
        for (const fixture of completedWithTimestamp) {
          const completedAt = new Date(fixture.completedAt as Date).getTime();
          if (!Number.isFinite(completedAt)) continue;
          const bucket = Math.floor(completedAt / bucketSize);
          const bucketFixtures = completionBuckets.get(bucket) ?? [];
          bucketFixtures.push(fixture);
          completionBuckets.set(bucket, bucketFixtures);
        }
        for (const [bucket, bucketFixtures] of completionBuckets) {
          const anchorFixture = bucketFixtures[0];
          const latestCompletion = Math.max(
            ...bucketFixtures.map((item) =>
              new Date(item.completedAt as Date).getTime(),
            ),
          );
          const afterMatchScope: SportsQueueScope = {
            leagueId: group.competition.slug,
            competitionId: group.competition.id,
            seasonId: anchorFixture.seasonId ?? scopeSeason.seasonId,
            seasonYear: anchorFixture.seasonYear ?? scopeSeason.seasonYear,
            calendarDate: group.calendarDate,
            expectedKickoffAt: anchorFixture.kickoffAt.toISOString(),
            expectedCompletedAt: new Date(
              anchorFixture.completedAt as Date,
            ).toISOString(),
            ...(bootstrapContext ?? {}),
          };
          await this.enqueueMilestone(
            SportsQueueJobType.FIXTURE_DAILY_REFRESH,
            afterMatchScope,
            'AFTER_MATCH',
            latestCompletion +
              SPORTS_COLLECTION_SCHEDULE.fixtureRefreshAfterMatch.delayMs,
            85,
            `${cause}:after-match:${group.competition.id}:${group.calendarDate}:${bucket}`,
          );
        }
      }

      if (
        actionable.some(
          (item) => item.status.state !== 'COMPLETED' && !item.status.isFinal,
        )
      ) {
        await this.scheduleLiveScoreboard(
          group.competition,
          actionable[0],
          bootstrapContext,
        );
      }
    }
  }

  private async enqueueThresholdJobs(
    type: SportsQueueJobType,
    scope: SportsQueueScope,
    milestones: Array<{ name: string; leadMs: number; priority: number }>,
    kickoffAt: number,
    cause: string,
    catchupName: string,
    allowCatchup = true,
  ): Promise<void> {
    const now = Date.now();
    let missedMilestone = false;
    for (const item of milestones) {
      const scheduledAt = kickoffAt - item.leadMs;
      if (scheduledAt <= now) {
        missedMilestone = true;
        continue;
      }
      await this.enqueueMilestone(
        type,
        scope,
        item.name,
        scheduledAt,
        item.priority,
        `${cause}:${item.name}:${scope.expectedKickoffAt ?? ''}`,
      );
    }
    if (missedMilestone && allowCatchup) {
      await this.enqueueMilestone(
        type,
        scope,
        catchupName,
        now,
        Math.max(...milestones.map((item) => item.priority)),
        `${cause}:${catchupName}:${scope.expectedKickoffAt ?? ''}`,
      );
    }
  }

  private async enqueueMilestone(
    type: SportsQueueJobType,
    scope: SportsQueueScope,
    milestone: string,
    scheduledAt: number,
    priority: number,
    triggerEventId: string,
  ): Promise<void> {
    await this.queue.enqueueIfMissing({
      type,
      scope: { ...scope, milestone },
      priority,
      scheduledFor: new Date(Math.max(Date.now(), scheduledAt)),
      triggerEventId,
    });
  }

  private async scheduleLiveScoreboard(
    competition: SportsCompetitionRecord,
    fixture: SportsFixtureRecord,
    bootstrapContext?: Pick<
      SportsQueueScope,
      'bootstrapRunId' | 'seasonBootstrap' | 'seasonEndDate'
    >,
  ): Promise<void> {
    const date = this.dateKey(fixture.kickoffAt);
    const dayFixtures = await this.collection.getFixturesForCompetitionDate(
      competition.id,
      date,
    );
    const firstKickoff = dayFixtures
      .filter(
        (item) =>
          !['POSTPONED', 'CANCELLED', 'ABANDONED'].includes(item.status.state),
      )
      .reduce(
        (earliest, item) => Math.min(earliest, item.kickoffAt.getTime()),
        fixture.kickoffAt.getTime(),
      );
    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.LIVE_SCOREBOARD_REFRESH,
      scope: {
        leagueId: competition.slug,
        competitionId: competition.id,
        seasonId: fixture.seasonId,
        seasonYear: fixture.seasonYear,
        calendarDate: date,
        expectedKickoffAt: new Date(firstKickoff).toISOString(),
        ...(bootstrapContext ?? {}),
      },
      priority: 100,
      scheduledFor: new Date(Math.max(Date.now(), firstKickoff - 15 * 60_000)),
      recurrence: {
        intervalMs: SPORTS_COLLECTION_SCHEDULE.liveScoreboard.intervalMs,
        repeatUntil: 'DATA_COMPLETE',
      },
      triggerEventId: `live-scoreboard:${competition.id}:${date}`,
    });
  }

  private async enqueueSummary(
    fixture: SportsFixtureRecord,
    competition: SportsCompetitionRecord,
    cause: string,
  ): Promise<void> {
    if (!(fixture.status.isFinal || fixture.status.state === 'COMPLETED')) return;
    if (!fixture.espnEventId) return;
    if (!(await this.collection.shouldCollectFixtureSummary(fixture.espnEventId, 24 * 60 * 60_000))) return;

    const completedAt = fixture.completedAt?.getTime() ?? fixture.kickoffAt.getTime();
    const scheduledAt = completedAt + SPORTS_COLLECTION_SCHEDULE.summaryAfterMatch.delayMs;
    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.MATCH_SUMMARY_COLLECTION,
      scope: {
        fixtureId: fixture.id,
        espnEventId: fixture.espnEventId,
        competitionId: fixture.competitionId,
        seasonId: fixture.seasonId,
        seasonYear: fixture.seasonYear,
        leagueId: competition.slug,
        ...(fixture.completedAt ? { expectedCompletedAt: new Date(fixture.completedAt).toISOString() } : {}),
        summaryAttempt: 0,
      },
      priority: 96,
      scheduledFor: new Date(Math.max(Date.now(), scheduledAt)),
      triggerEventId: `${cause}:summary:${fixture.id}:attempt:0`,
    });
  }

  private async enqueuePlays(
    fixture: SportsFixtureRecord,
    cause: string,
  ): Promise<void> {
    if (!fixture.status.isFinal && fixture.status.state !== 'COMPLETED') return;
    if (!(await this.collection.shouldCollectMatchPlays(fixture.id))) return;
    const competition = await this.collection.getCompetition(
      fixture.competitionId,
    );
    await this.queue.enqueueIfMissing({
      type: SportsQueueJobType.MATCH_PLAYS_COLLECTION,
      scope: {
        fixtureId: fixture.id,
        espnEventId: fixture.espnEventId,
        competitionId: fixture.competitionId,
        seasonId: fixture.seasonId,
        leagueId: competition?.slug,
      },
      priority: 95,
      scheduledFor: new Date(
        Date.now() + SPORTS_COLLECTION_SCHEDULE.playsAfterMatch.delayMs,
      ),
      triggerEventId: `${cause}:plays:${fixture.id}`,
    });
  }

  private seasonDateRange(season: SportsSeasonRecord): {
    start: Date;
    end: Date;
  } {
    if (!season.startDate)
      throw new Error(
        `Season ${season.id} has no startDate; refusing an incomplete fixture bootstrap.`,
      );
    const start = this.utcDay(new Date(season.startDate));
    const rawEnd = season.endDate;
    if (!rawEnd)
      throw new Error(
        `Season ${season.id} has no endDate; refusing to truncate its monthly and daily fixture coverage.`,
      );
    const end = this.utcDay(new Date(rawEnd));
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      start > end
    ) {
      throw new Error(`Season ${season.id} has an invalid date range.`);
    }
    return { start, end };
  }

  private eachMonth(start: Date, end: Date): string[] {
    const months: string[] = [];
    const cursor = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1),
    );
    const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    while (cursor <= last) {
      months.push(
        `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`,
      );
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return months;
  }

  private eachDate(start: Date, end: Date): string[] {
    const dates: string[] = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return dates;
  }

  private priorityForDate(date: string): number {
    const day = new Date(`${date}T00:00:00.000Z`).getTime();
    const distance = Math.floor(
      (day - this.utcDay(new Date()).getTime()) / DAY,
    );
    return distance >= 0 && distance <= 2 ? 70 : 35;
  }

  private isRetryableProviderError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'retryable' in error
      && (error as { retryable?: unknown }).retryable === true);
  }

  private dateKey(value: Date): string {
    return this.utcDay(new Date(value)).toISOString().slice(0, 10);
  }

  private utcDay(value: Date): Date {
    return new Date(
      Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
    );
  }

  private required(value: string | undefined, field: string): string {
    const normalized = String(value ?? '').trim();
    if (!normalized)
      throw new Error(`${field} is required for this ESPN collection job.`);
    return normalized;
  }
}
