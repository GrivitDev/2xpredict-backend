/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { SystemMonitorService } from '../../system-monitor/system-monitor.service';
import { EspnV2Client } from '../providers/espn-v2.client';
import { SportsDataChangeEvent } from '../schemas/operations/sports-data-change-event.schema';
import { SportsBootstrapState } from '../schemas/operations/sports-bootstrap-state.schema';
import { SportsCollectionState } from '../schemas/operations/sports-collection-state.schema';
import { SportsQueue } from '../schemas/operations/sports-queue.schema';
import {
  SportsCalculatedStandings,
  SportsCompetitionScoringTotals,
  SportsHeadToHead,
  SportsPlayerEventTotals,
  SportsTeamForm,
  SportsTeamHomeAwayRecord,
  SportsTeamScoringRecord,
  SportsTeamStatisticsAggregate,
} from '../schemas/derived/sports-derived.schema';
import { SportsCompetition } from '../schemas/domain/competition.schema';
import { SportsFixture } from '../schemas/domain/fixture.schema';
import { SportsMatchOddsSnapshot } from '../schemas/domain/match-odds-snapshot.schema';
import { SportsMatchTimelineEvent } from '../schemas/domain/match-timeline-event.schema';
import { SportsSeason } from '../schemas/domain/season.schema';
import { SportsQueueService } from './sports-queue.service';
import { SportsQueueWorkerService } from './sports-queue-worker.service';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ODDS_FIRST_CHECKPOINT_LEAD_MS = 48 * HOUR;

const LIVE_FIXTURE_STATES = ['LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES'];
const ACTIVE_QUEUE_STATUSES = [
  'PENDING',
  'PROCESSING',
  'FAILED',
  'QUARANTINED',
];

interface SportsMonitorAlert {
  code: string;
  severity: 'WARNING' | 'CRITICAL';
  message: string;
  count?: number;
  details?: Record<string, unknown>;
}

interface CountRow {
  _id: string;
  count: number;
}

interface OddsCoverage {
  eligibleFixtureSampleSize: number;
  sampleLimit: number;
  sampleSize: number;
  freshSnapshots: number;
  staleSnapshots?: number;
  missingOrStale: number;
  failedCollections?: number;
  coveragePercent: number | null;
  freshnessWindowMs: number;
}

interface TimelineCoverage {
  sampleSize: number;
  sampleLimit?: number;
  covered: number;
  missing: number;
  failedCollections?: number;
  coveragePercent: number | null;
  gracePeriodMs: number;
}

/**
 * Operational monitor for normalized ESPN Sports collection and its durable
 * queue/outbox. It is intentionally read-only: it observes the Sports, Odds,
 * Predictions and Settlement data contracts but never changes their work.
 */
@Injectable()
export class SportsMonitorService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SportsMonitorService.name);
  private readonly monitorIntervalMs = this.readPositiveInteger(
    process.env.SPORTS_MONITOR_INTERVAL_MS,
    60_000,
  );
  private readonly cacheTtlMs = 15_000;
  private stopped = false;
  private checking = false;
  private timer?: ReturnType<typeof setTimeout>;
  private startedAt?: Date;
  private lastCheckAt?: Date;
  private lastSuccessfulCheckAt?: Date;
  private lastCheckError?: string;
  private lastReportedProviderFailureKey?: string;
  private lastReportedQueueFailureKey?: string;
  private lastReportedCollectionFailureKey?: string;
  private lastReportedWorkerFailureKey?: string;
  private cachedOverview?: { at: number; value: Record<string, unknown> };

  constructor(
    @InjectModel(SportsQueue.name) private readonly queueModel: Model<any>,
    @InjectModel(SportsCollectionState.name)
    private readonly collectionStateModel: Model<any>,
    @InjectModel(SportsBootstrapState.name)
    private readonly bootstrapModel: Model<any>,
    @InjectModel(SportsDataChangeEvent.name)
    private readonly changeEventModel: Model<any>,
    @InjectModel(SportsCompetition.name)
    private readonly competitionModel: Model<any>,
    @InjectModel(SportsSeason.name) private readonly seasonModel: Model<any>,
    @InjectModel(SportsFixture.name) private readonly fixtureModel: Model<any>,
    @InjectModel(SportsMatchTimelineEvent.name)
    private readonly timelineModel: Model<any>,
    @InjectModel(SportsMatchOddsSnapshot.name)
    private readonly oddsSnapshotModel: Model<any>,
    @InjectModel(SportsCalculatedStandings.name)
    private readonly standingsModel: Model<any>,
    @InjectModel(SportsTeamForm.name)
    private readonly teamFormModel: Model<any>,
    @InjectModel(SportsTeamHomeAwayRecord.name)
    private readonly homeAwayModel: Model<any>,
    @InjectModel(SportsTeamScoringRecord.name)
    private readonly teamScoringModel: Model<any>,
    @InjectModel(SportsHeadToHead.name)
    private readonly headToHeadModel: Model<any>,
    @InjectModel(SportsCompetitionScoringTotals.name)
    private readonly competitionScoringModel: Model<any>,
    @InjectModel(SportsTeamStatisticsAggregate.name)
    private readonly teamStatisticsModel: Model<any>,
    @InjectModel(SportsPlayerEventTotals.name)
    private readonly playerEventTotalsModel: Model<any>,
    private readonly espn: EspnV2Client,
    private readonly queue: SportsQueueService,
    private readonly worker: SportsQueueWorkerService,
    private readonly systemMonitor: SystemMonitorService,
  ) {}

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.startedAt = new Date();
    this.systemMonitor.registerModule('sports', 'deep', true);
    this.systemMonitor.reportMonitorSnapshot('sports', {
      status: 'UNKNOWN',
      checkedAt: this.startedAt,
    });
    this.schedule(10_000);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Returns the latest detailed monitor snapshot; admin reads are briefly cached. */
  async getOverview(forceRefresh = false): Promise<Record<string, unknown>> {
    if (
      !forceRefresh &&
      this.cachedOverview &&
      Date.now() - this.cachedOverview.at < this.cacheTtlMs
    ) {
      return { ...this.cachedOverview.value, cached: true };
    }
    if (this.checking && this.cachedOverview) {
      return {
        ...this.cachedOverview.value,
        cached: true,
        refreshInProgress: true,
      };
    }
    return this.refreshOverview();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.runScheduledCheck();
      },
      Math.max(1_000, delayMs),
    );
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private async runScheduledCheck(): Promise<void> {
    try {
      await this.refreshOverview();
    } catch (error) {
      this.logger.error(
        `Sports health probe failed: ${this.errorMessage(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.schedule(this.monitorIntervalMs);
    }
  }

  private async refreshOverview(): Promise<Record<string, unknown>> {
    if (this.checking && this.cachedOverview) {
      return {
        ...this.cachedOverview.value,
        cached: true,
        refreshInProgress: true,
      };
    }
    this.checking = true;
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
      const message = this.errorMessage(error);
      this.lastCheckError = message;
      const workerStatus = this.worker.getMonitorStatus();
      this.systemMonitor.reportMonitorSnapshot('sports', {
        status: 'FAILED',
        checkedAt,
        checks: [
          {
            name: 'health-probe',
            status: 'FAILED',
            error: message,
          },
        ],
        details: {
          lastSuccessfulCheckAt:
            this.lastSuccessfulCheckAt?.toISOString() ?? 'NEVER',
          workerInitialized: Boolean(workerStatus.initialized),
          workerRunning: Boolean(workerStatus.running),
        },
      });
      throw error;
    } finally {
      this.checking = false;
    }
  }

  private async collectOverview(
    checkedAt: Date,
  ): Promise<Record<string, unknown>> {
    const now = checkedAt;
    const cutoff24h = new Date(now.getTime() - DAY);
    const cutoff14d = new Date(now.getTime() - 14 * DAY);
    const timelineGraceCutoff = new Date(now.getTime() - 15 * MINUTE);
    const upcomingCutoff = new Date(now.getTime() + 72 * HOUR);
    const queueDueFilter = {
      status: 'PENDING',
      scheduledFor: { $lte: now },
      $or: [
        { nextAttemptAt: { $exists: false } },
        { nextAttemptAt: null },
        { nextAttemptAt: { $lte: now } },
      ],
    };

    const [
      bootstrap,
      queueStatusRows,
      dueQueueJobs,
      oldestDueQueueJob,
      staleQueueJobs,
      recentTerminalQueueFailures,
      latestQueueFailure,
      overdueQueueJobsByType,
      collectionStatusRows,
      recentCollectionFailures,
      staleCollectionProcessing,
      overdueScheduledCollections,
      recentCollectionFailureRows,
      latestCollectionStates,
      competitionTotal,
      fixtureTotal,
      timelineEventTotal,
      upcomingFixtureTotal,
      liveFixtureTotal,
      recentCompletedFixtureTotal,
      latestCompletedFixture,
      recentCompletedFixtures,
      upcomingFixtures,
      currentSeasons,
      oddsSnapshotTotal,
      latestOddsSnapshot,
      outboxStatusRows,
      expiredOutboxLeases,
      failedOutboxEvents,
      oldestPendingOutboxEvent,
    ] = await Promise.all([
      this.bootstrapModel.findOne({ key: 'espn-soccer-v2' }).lean().exec(),
      this.queueModel
        .aggregate([
          { $match: { status: { $in: ACTIVE_QUEUE_STATUSES } } },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ])
        .exec() as Promise<CountRow[]>,
      this.queueModel.countDocuments(queueDueFilter).exec(),
      this.queueModel
        .findOne(queueDueFilter)
        .sort({ scheduledFor: 1, createdAt: 1 })
        .select({ jobKey: 1, type: 1, scheduledFor: 1, attempts: 1, scope: 1 })
        .lean()
        .exec(),
      this.queueModel
        .countDocuments({
          status: 'PROCESSING',
          leaseExpiresAt: { $lte: now },
        })
        .exec(),
      this.queueModel
        .countDocuments({
          status: { $in: ['FAILED', 'QUARANTINED'] },
          updatedAt: { $gte: cutoff24h },
        })
        .exec(),
      this.queueModel
        .findOne({
          status: { $in: ['FAILED', 'QUARANTINED'] },
          updatedAt: { $gte: cutoff24h },
        })
        .sort({ updatedAt: -1 })
        .select({
          jobKey: 1,
          type: 1,
          status: 1,
          lastError: 1,
          updatedAt: 1,
          scope: 1,
        })
        .lean()
        .exec(),
      this.queueModel
        .aggregate([
          { $match: { ...queueDueFilter } },
          { $group: { _id: '$type', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 12 },
        ])
        .exec() as Promise<CountRow[]>,
      this.collectionStateModel
        .aggregate([
          { $match: { provider: 'ESPN' } },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ])
        .exec() as Promise<CountRow[]>,
      this.collectionStateModel
        .countDocuments({
          provider: 'ESPN',
          status: 'FAILED',
          updatedAt: { $gte: cutoff24h },
        })
        .exec(),
      this.collectionStateModel
        .countDocuments({
          provider: 'ESPN',
          status: 'PROCESSING',
          lastStartedAt: { $lte: new Date(now.getTime() - 20 * MINUTE) },
        })
        .exec(),
      this.collectionStateModel
        .countDocuments({
          provider: 'ESPN',
          enabled: true,
          intervalMs: { $gt: 0 },
          nextRunAt: { $lte: new Date(now.getTime() - 10 * MINUTE) },
          status: { $nin: ['PROCESSING', 'DISABLED'] },
        })
        .exec(),
      this.collectionStateModel
        .find({
          provider: 'ESPN',
          status: 'FAILED',
          updatedAt: { $gte: cutoff24h },
        })
        .sort({ updatedAt: -1 })
        .limit(10)
        .select({
          collectionType: 1,
          scopeType: 1,
          scopeId: 1,
          endpoint: 1,
          lastError: 1,
          failureCount: 1,
          updatedAt: 1,
        })
        .lean()
        .exec(),
      this.getLatestCollectionStates(),
      this.competitionModel.estimatedDocumentCount().exec(),
      this.fixtureModel.estimatedDocumentCount().exec(),
      this.timelineModel.estimatedDocumentCount().exec(),
      this.fixtureModel
        .countDocuments({
          'status.state': 'SCHEDULED',
          kickoffAt: { $gte: now, $lte: upcomingCutoff },
        })
        .exec(),
      this.fixtureModel
        .countDocuments({ 'status.state': { $in: LIVE_FIXTURE_STATES } })
        .exec(),
      this.fixtureModel
        .countDocuments({
          'status.state': 'COMPLETED',
          kickoffAt: { $gte: cutoff14d, $lte: timelineGraceCutoff },
        })
        .exec(),
      this.fixtureModel
        .findOne({ 'status.state': 'COMPLETED' })
        .sort({ completedAt: -1, kickoffAt: -1 })
        .select({
          id: 1,
          competitionId: 1,
          seasonId: 1,
          kickoffAt: 1,
          completedAt: 1,
          updatedAt: 1,
        })
        .lean()
        .exec(),
      this.fixtureModel
        .find({
          'status.state': 'COMPLETED',
          kickoffAt: { $gte: cutoff14d, $lte: timelineGraceCutoff },
        })
        .sort({ completedAt: -1, kickoffAt: -1 })
        .limit(200)
        .select({
          id: 1,
          competitionId: 1,
          seasonId: 1,
          kickoffAt: 1,
          completedAt: 1,
        })
        .lean()
        .exec(),
      this.fixtureModel
        .find({
          'status.state': 'SCHEDULED',
          kickoffAt: { $gte: now, $lte: upcomingCutoff },
        })
        .sort({ kickoffAt: 1 })
        .limit(300)
        .select({ id: 1, competitionId: 1, seasonId: 1, kickoffAt: 1 })
        .lean()
        .exec(),
      this.seasonModel
        .find({ isCurrent: true })
        .sort({ updatedAt: -1 })
        .limit(300)
        .select({
          id: 1,
          competitionId: 1,
          year: 1,
          startDate: 1,
          endDate: 1,
          createdAt: 1,
        })
        .lean()
        .exec(),
      this.oddsSnapshotModel.estimatedDocumentCount().exec(),
      this.oddsSnapshotModel
        .findOne()
        .sort({ collectedAt: -1 })
        .select({ fixtureId: 1, provider: 1, collectedAt: 1, isFallback: 1 })
        .lean()
        .exec(),
      this.changeEventModel
        .aggregate([
          { $match: { status: { $in: ['PENDING', 'PROCESSING', 'FAILED'] } } },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ])
        .exec() as Promise<CountRow[]>,
      this.changeEventModel
        .countDocuments({
          status: 'PROCESSING',
          leaseExpiresAt: { $lte: now },
        })
        .exec(),
      this.changeEventModel.countDocuments({ status: 'FAILED' }).exec(),
      this.changeEventModel
        .findOne({
          status: 'PENDING',
          $or: [
            { nextAttemptAt: { $exists: false } },
            { nextAttemptAt: null },
            { nextAttemptAt: { $lte: now } },
          ],
        })
        .sort({ changedAt: 1 })
        .select({
          eventId: 1,
          entity: 1,
          entityId: 1,
          changedAt: 1,
          attempts: 1,
          nextAttemptAt: 1,
        })
        .lean()
        .exec(),
    ]);

    const bootstrapPhaseProgress =
      bootstrap?.runId && bootstrap?.currentPhase
        ? await this.queue.getBootstrapPhaseProgress(
            String(bootstrap.runId),
            bootstrap.currentPhase,
          )
        : undefined;

    const currentSeasonIds = currentSeasons
      .map((item: any) => String(item.id ?? ''))
      .filter(Boolean);
    const currentCompetitionIds = [
      ...new Set(
        currentSeasons
          .map((item: any) => String(item.competitionId ?? ''))
          .filter(Boolean),
      ),
    ];
    const [
      monthlyBootstrapRows,
      incompleteDailyValidations,
      upcomingOddsData,
      recentTimelineStates,
      projectionLatestRows,
    ] = await Promise.all([
      currentSeasonIds.length
        ? this.collectionStateModel
            .find({
              collectionType: 'FIXTURE_MONTHLY_BOOTSTRAP_COMPLETE',
              scopeType: 'SEASON',
              scopeId: { $in: currentSeasonIds },
              status: 'SUCCEEDED',
            })
            .select({ scopeId: 1, lastSuccessfulAt: 1 })
            .lean()
            .exec()
        : Promise.resolve([]),
      currentSeasonIds.length && currentCompetitionIds.length
        ? this.collectionStateModel
            .countDocuments({
              collectionType: 'FIXTURE_DAILY_VALIDATION',
              validationResult: 'INCOMPLETE',
              validatedAt: { $gte: cutoff14d },
              'resultSummary.seasonId': { $in: currentSeasonIds },
              'resultSummary.competitionId': { $in: currentCompetitionIds },
            })
            .exec()
        : Promise.resolve(0),
      this.getUpcomingOddsCoverage(upcomingFixtures, now),
      this.getRecentTimelineCoverage(recentCompletedFixtures),
      this.getLatestProjectionRows(
        latestCompletedFixture?.competitionId
          ? String(latestCompletedFixture.competitionId)
          : undefined,
        latestCompletedFixture?.seasonId
          ? String(latestCompletedFixture.seasonId)
          : undefined,
      ),
    ]);

    const queueCounts = this.toCountMap(queueStatusRows);
    const collectionCounts = this.toCountMap(collectionStatusRows);
    const outboxCounts = this.toCountMap(outboxStatusRows);
    const dueJobTypes = Object.fromEntries(
      overdueQueueJobsByType.map((item) => [
        String(item._id),
        Number(item.count ?? 0),
      ]),
    );
    const worker = this.worker.getMonitorStatus();
    const oldestDueAt = this.toDate(oldestDueQueueJob?.scheduledFor);
    const oldestDueAgeMs = oldestDueAt
      ? Math.max(0, now.getTime() - oldestDueAt.getTime())
      : undefined;
    const oldestOutboxAt = this.toDate(oldestPendingOutboxEvent?.changedAt);
    const oldestOutboxAgeMs = oldestOutboxAt
      ? Math.max(0, now.getTime() - oldestOutboxAt.getTime())
      : undefined;
    const completedAt =
      this.toDate(latestCompletedFixture?.completedAt) ??
      this.toDate(latestCompletedFixture?.kickoffAt);
    const latestProjectionAt = this.latestDate(projectionLatestRows);
    const projectionFreshness = this.getProjectionFreshness(
      projectionLatestRows,
      completedAt,
    );
    const oldestProjectionAt = projectionFreshness.oldestCalculatedAt
      ? this.toDate(projectionFreshness.oldestCalculatedAt)
      : undefined;
    const latestLiveScoreboardAt = this.getLatestStateDate(
      latestCollectionStates,
      'LIVE_SCOREBOARD',
      'lastSuccessfulAt',
    );
    const latestDailyScoreboardAt = this.getLatestStateDate(
      latestCollectionStates,
      'FIXTURE_DAILY_SCOREBOARD',
      'lastSuccessfulAt',
    );
    const latestPlaysAt = this.getLatestStateDate(
      latestCollectionStates,
      'MATCH_PLAYS',
      'lastSuccessfulAt',
    );
    const latestMatchOddsCollectionAt = this.getLatestStateDate(
      latestCollectionStates,
      'MATCH_ODDS',
      'lastSuccessfulAt',
    );
    const latestFixtureValidationAt = this.getLatestStateDate(
      latestCollectionStates,
      'FIXTURE_DAILY_VALIDATION',
      'validatedAt',
    );
    const monthlyBootstrapCompleteIds = new Set(
      monthlyBootstrapRows.map((row: any) => String(row.scopeId ?? '')),
    );
    const staleCurrentSeasons = currentSeasons.filter((season: any) => {
      const createdAt = this.toDate(season.createdAt);
      return (
        !monthlyBootstrapCompleteIds.has(String(season.id ?? '')) &&
        createdAt &&
        now.getTime() - createdAt.getTime() > DAY
      );
    });
    const currentSeasonsMissingDates = currentSeasons.filter(
      (season: any) => !season.startDate || !season.endDate,
    ).length;
    const bootstrapAgeMs = this.toDate(bootstrap?.startedAt)
      ? Math.max(0, now.getTime() - this.toDate(bootstrap.startedAt)!.getTime())
      : undefined;

    const derivedLagMs =
      completedAt && projectionFreshness.missingStores > 0
        ? Number.POSITIVE_INFINITY
        : completedAt && oldestProjectionAt
          ? Math.max(0, completedAt.getTime() - oldestProjectionAt.getTime())
          : 0;
    const derivedJobsPending = Number(
      dueJobTypes.DERIVED_DATA_RECALCULATION ?? 0,
    );
    const derivedJobsActive = await this.queueModel
      .countDocuments({
        type: 'DERIVED_DATA_RECALCULATION',
        status: { $in: ['PENDING', 'PROCESSING'] },
      })
      .exec();
    const derivedJobsTerminal = await this.queueModel
      .countDocuments({
        type: 'DERIVED_DATA_RECALCULATION',
        status: { $in: ['FAILED', 'QUARANTINED'] },
      })
      .exec();

    const provider = this.espn.getRuntimeStatus();
    const providerLastFailureAt = this.toDate(provider.lastFailedAt);
    const providerCooldownUntil = this.toDate(provider.cooldownUntil);
    const providerCooldownActive = Boolean(
      providerCooldownUntil && providerCooldownUntil.getTime() > now.getTime(),
    );
    const providerConsecutiveFailures = Number(
      provider.consecutiveFailures ?? 0,
    );
    const workerLastPassErrorAt = this.toDate(worker.lastPassErrorAt);
    const workerLastPassCompletedAt = this.toDate(worker.lastPassCompletedAt);

    const alerts: SportsMonitorAlert[] = [];

    const monitorStartupAgeMs = this.startedAt
      ? now.getTime() - this.startedAt.getTime()
      : 0;
    if (!worker.initialized && monitorStartupAgeMs > 2 * MINUTE) {
      alerts.push({
        code: 'SPORTS_WORKER_NOT_READY',
        severity: 'CRITICAL',
        message: 'The Sports queue worker has not completed initialization.',
      });
    }
    if (Number(staleQueueJobs) > 0)
      alerts.push({
        code: 'STALE_QUEUE_LEASES',
        severity: 'CRITICAL',
        message:
          'Sports queue jobs remain PROCESSING after their durable lease expired.',
        count: Number(staleQueueJobs),
      });
    if (Number(queueCounts.QUARANTINED ?? 0) > 0)
      alerts.push({
        code: 'QUARANTINED_QUEUE_JOBS',
        severity: 'CRITICAL',
        message:
          'Sports queue jobs have exhausted their retry allowance and entered quarantine.',
        count: Number(queueCounts.QUARANTINED ?? 0),
      });
    if (Number(dueQueueJobs) > 0 && (oldestDueAgeMs ?? 0) > 5 * MINUTE)
      alerts.push({
        code: 'DUE_QUEUE_BACKLOG',
        severity: 'WARNING',
        message:
          'Due Sports queue jobs have remained runnable for more than five minutes.',
        count: Number(dueQueueJobs),
        details: { oldestDueAgeMs, workerBusy: Boolean(worker.running) },
      });
    if (Number(recentTerminalQueueFailures) > 0)
      alerts.push({
        code: 'RECENT_QUEUE_FAILURES',
        severity: 'WARNING',
        message:
          'Sports queue jobs entered FAILED or QUARANTINED status within the last 24 hours.',
        count: Number(recentTerminalQueueFailures),
      });
    if (
      workerLastPassErrorAt &&
      (!workerLastPassCompletedAt ||
        workerLastPassErrorAt > workerLastPassCompletedAt)
    )
      alerts.push({
        code: 'WORKER_PASS_FAILURE',
        severity: 'WARNING',
        message:
          'The Sports queue worker has recorded a pass-level error since its last successful pass.',
        details: {
          lastPassErrorAt: workerLastPassErrorAt.toISOString(),
          lastError: worker.lastError,
        },
      });

    if (Number(staleCollectionProcessing) > 0)
      alerts.push({
        code: 'STALE_COLLECTION_STATES',
        severity: 'CRITICAL',
        message:
          'Sports collection state records have remained PROCESSING for more than twenty minutes.',
        count: Number(staleCollectionProcessing),
      });
    if (Number(recentCollectionFailures) > 0)
      alerts.push({
        code: 'RECENT_COLLECTION_FAILURES',
        severity: 'WARNING',
        message: 'ESPN collection operations failed within the last 24 hours.',
        count: Number(recentCollectionFailures),
      });
    if (Number(overdueScheduledCollections) > 0)
      alerts.push({
        code: 'OVERDUE_RECURRING_COLLECTIONS',
        severity: 'WARNING',
        message:
          'Recurring ESPN collection states are past their next scheduled run by more than ten minutes.',
        count: Number(overdueScheduledCollections),
      });

    if (bootstrap?.status === 'FAILED')
      alerts.push({
        code: 'BOOTSTRAP_FAILED',
        severity: 'CRITICAL',
        message: 'The durable ESPN Sports bootstrap is marked FAILED.',
        details: {
          currentPhase: bootstrap.currentPhase,
          lastError: bootstrap.lastError,
        },
      });
    if (bootstrap?.status === 'RUNNING' && (bootstrapAgeMs ?? 0) > 24 * HOUR)
      alerts.push({
        code: 'BOOTSTRAP_STALLED',
        severity: 'CRITICAL',
        message:
          'The ESPN Sports bootstrap has been RUNNING for more than twenty-four hours.',
        details: {
          currentPhase: bootstrap.currentPhase,
          ageMs: bootstrapAgeMs,
          phaseProgress: bootstrapPhaseProgress,
        },
      });
    else if (
      bootstrap?.status === 'RUNNING' &&
      (bootstrapAgeMs ?? 0) > 6 * HOUR
    )
      alerts.push({
        code: 'BOOTSTRAP_SLOW',
        severity: 'WARNING',
        message:
          'The ESPN Sports bootstrap has been running for more than six hours.',
        details: {
          currentPhase: bootstrap.currentPhase,
          ageMs: bootstrapAgeMs,
          phaseProgress: bootstrapPhaseProgress,
        },
      });
    if (Number(currentSeasonsMissingDates) > 0)
      alerts.push({
        code: 'CURRENT_SEASONS_MISSING_DATES',
        severity: 'WARNING',
        message:
          'Some current seasons do not have both startDate and endDate, preventing complete fixture bootstrap validation.',
        count: Number(currentSeasonsMissingDates),
      });
    if (staleCurrentSeasons.length > 0 && bootstrap?.status === 'COMPLETED')
      alerts.push({
        code: 'CURRENT_SEASONS_NOT_BOOTSTRAPPED',
        severity: 'WARNING',
        message:
          'Current seasons older than twenty-four hours are missing their monthly fixture bootstrap completion marker.',
        count: staleCurrentSeasons.length,
      });
    if (Number(incompleteDailyValidations) > 0)
      alerts.push({
        code: 'INCOMPLETE_DAILY_FIXTURE_VALIDATIONS',
        severity: 'WARNING',
        message:
          'Recent fixture-day validation records for current seasons remain incomplete.',
        count: Number(incompleteDailyValidations),
      });
    if (
      bootstrap?.status === 'RUNNING' &&
      bootstrapPhaseProgress?.hasTerminalFailure
    )
      alerts.push({
        code: 'BOOTSTRAP_PHASE_FAILURES',
        severity: 'CRITICAL',
        message: `The active bootstrap phase ${bootstrap.currentPhase} contains failed or quarantined queue jobs.`,
        count:
          bootstrapPhaseProgress.failed + bootstrapPhaseProgress.quarantined,
        details: { ...bootstrapPhaseProgress },
      });

    if (Number(fixtureTotal) === 0 && bootstrap?.status === 'COMPLETED')
      alerts.push({
        code: 'NO_NORMALIZED_FIXTURES',
        severity: 'CRITICAL',
        message:
          'Sports bootstrap is complete but the normalized fixture collection is empty.',
      });
    const liveScoreboardAgeMs = latestLiveScoreboardAt
      ? Math.max(0, now.getTime() - latestLiveScoreboardAt.getTime())
      : undefined;
    if (
      Number(liveFixtureTotal) > 0 &&
      (liveScoreboardAgeMs === undefined || liveScoreboardAgeMs > 10 * MINUTE)
    )
      alerts.push({
        code: 'LIVE_SCOREBOARD_STALE',
        severity: 'CRITICAL',
        message:
          'Live fixtures exist but the latest successful ESPN live scoreboard collection is missing or older than ten minutes.',
        count: Number(liveFixtureTotal),
        details: {
          latestSuccessfulAt: latestLiveScoreboardAt?.toISOString(),
          ageMs: liveScoreboardAgeMs,
        },
      });
    if (
      recentTimelineStates.sampleSize >= 10 &&
      recentTimelineStates.coveragePercent !== null &&
      recentTimelineStates.coveragePercent < 95
    )
      alerts.push({
        code: 'RECENT_TIMELINE_COVERAGE_LOW',
        severity: 'WARNING',
        message:
          'Recent completed fixtures are missing a successful Core Plays collection state.',
        count: recentTimelineStates.missing,
        details: { ...recentTimelineStates },
      });
    if (
      upcomingOddsData.sampleSize >= 10 &&
      upcomingOddsData.coveragePercent !== null &&
      upcomingOddsData.coveragePercent < 80
    )
      alerts.push({
        code: 'UPCOMING_ODDS_SNAPSHOT_COVERAGE_LOW',
        severity: 'WARNING',
        message:
          'A material share of upcoming fixtures in the 72-hour prediction and pricing horizon has no odds snapshot collected within the last twenty-four hours.',
        count: upcomingOddsData.missingOrStale,
        details: { ...upcomingOddsData },
      });

    if (
      derivedLagMs > 15 * MINUTE &&
      derivedJobsActive === 0 &&
      Number(fixtureTotal) > 0
    )
      alerts.push({
        code: 'DERIVED_PROJECTIONS_STALE',
        severity: 'WARNING',
        message:
          'The latest completed fixture is newer than the latest derived projection and no recalculation job is pending or processing.',
        details: {
          latestCompletedFixtureAt: completedAt?.toISOString(),
          latestProjectionAt: latestProjectionAt?.toISOString(),
          oldestProjectionAt: oldestProjectionAt?.toISOString(),
          projectionFreshness,
          lagMs: Number.isFinite(derivedLagMs) ? derivedLagMs : null,
        },
      });
    if (Number(derivedJobsTerminal) > 0)
      alerts.push({
        code: 'DERIVED_RECALCULATION_FAILURES',
        severity: 'WARNING',
        message:
          'Derived-data recalculation jobs have entered FAILED or QUARANTINED status.',
        count: Number(derivedJobsTerminal),
      });

    if (Number(expiredOutboxLeases) > 0)
      alerts.push({
        code: 'STALE_SPORTS_OUTBOX_LEASES',
        severity: 'CRITICAL',
        message:
          'Sports source-change outbox events remain PROCESSING after their lease expired.',
        count: Number(expiredOutboxLeases),
      });
    if (Number(failedOutboxEvents) > 0)
      alerts.push({
        code: 'FAILED_SPORTS_OUTBOX_EVENTS',
        severity: 'CRITICAL',
        message:
          'Sports source-change outbox events exhausted retries and require operational attention.',
        count: Number(failedOutboxEvents),
      });
    if (
      Number(outboxCounts.PENDING ?? 0) > 0 &&
      (oldestOutboxAgeMs ?? 0) > 5 * MINUTE
    )
      alerts.push({
        code: 'SPORTS_OUTBOX_BACKLOG',
        severity: 'WARNING',
        message:
          'Sports source-change events have remained pending for more than five minutes.',
        count: Number(outboxCounts.PENDING ?? 0),
        details: { oldestPendingAgeMs: oldestOutboxAgeMs },
      });

    if (providerConsecutiveFailures >= 3)
      alerts.push({
        code: 'ESPN_PROVIDER_CONSECUTIVE_FAILURES',
        severity: 'WARNING',
        message:
          'ESPN requests have failed consecutively; provider health is degraded.',
        count: providerConsecutiveFailures,
        details: {
          lastFailedAt: providerLastFailureAt?.toISOString(),
          lastFailure: provider.lastFailure,
        },
      });
    if (providerCooldownActive)
      alerts.push({
        code: 'ESPN_PROVIDER_COOLDOWN',
        severity: 'WARNING',
        message:
          'ESPN request starts are currently delayed by the provider cooldown gate.',
        details: { cooldownUntil: providerCooldownUntil?.toISOString() },
      });

    const criticalAlerts = alerts.filter(
      (alert) => alert.severity === 'CRITICAL',
    ).length;
    const warningAlerts = alerts.filter(
      (alert) => alert.severity === 'WARNING',
    ).length;
    const providerHasRequests = Number(provider.requestAttempts ?? 0) > 0;
    const healthStatus: 'FAILED' | 'DEGRADED' | 'UNKNOWN' | 'HEALTHY' =
      criticalAlerts > 0
        ? 'FAILED'
        : warningAlerts > 0
          ? 'DEGRADED'
          : !providerHasRequests && Number(fixtureTotal) === 0
            ? 'UNKNOWN'
            : 'HEALTHY';
    const statusMessage =
      healthStatus === 'HEALTHY'
        ? 'Sports collection, durable queue, source outbox and normalized data checks are healthy.'
        : healthStatus === 'DEGRADED'
          ? `Sports is operational with ${warningAlerts} warning(s) requiring attention.`
          : healthStatus === 'FAILED'
            ? `Sports has ${criticalAlerts} critical operational issue(s).`
            : 'Sports monitoring is active; initial ESPN collection and fixture data are not yet verified.';

    const downstream = this.buildDownstreamReadiness({
      fixtureTotal: Number(fixtureTotal),
      upcomingFixtureTotal: Number(upcomingFixtureTotal),
      oddsCoverage: upcomingOddsData,
      timelineCoverage: recentTimelineStates,
      latestProjectionAt,
      latestCompletedAt: completedAt,
      derivedLagMs,
      outboxCounts,
      failedOutboxEvents: Number(failedOutboxEvents),
      expiredOutboxLeases: Number(expiredOutboxLeases),
      oldestOutboxAgeMs,
    });

    return {
      generatedAt: now.toISOString(),
      status: healthStatus,
      message: statusMessage,
      monitor: {
        intervalMs: this.monitorIntervalMs,
        cacheTtlMs: this.cacheTtlMs,
        startedAt: this.startedAt?.toISOString(),
        lastCheckAt: this.lastCheckAt?.toISOString(),
        lastSuccessfulCheckAt: this.lastSuccessfulCheckAt?.toISOString(),
        lastCheckError: this.lastCheckError,
      },
      provider: {
        espn: {
          ...provider,
          health:
            providerConsecutiveFailures >= 3 || providerCooldownActive
              ? 'DEGRADED'
              : providerHasRequests
                ? 'HEALTHY'
                : 'UNKNOWN',
        },
      },
      worker,
      queue: {
        totalTracked: Object.values(queueCounts).reduce(
          (sum, value) => sum + Number(value),
          0,
        ),
        byStatus: queueCounts,
        duePendingJobs: Number(dueQueueJobs),
        oldestDueAt: oldestDueAt?.toISOString(),
        oldestDueAgeMs,
        staleProcessingJobs: Number(staleQueueJobs),
        terminalFailuresUpdatedLast24Hours: Number(recentTerminalQueueFailures),
        latestFailure: latestQueueFailure
          ? {
              jobKey: latestQueueFailure.jobKey,
              type: latestQueueFailure.type,
              status: latestQueueFailure.status,
              message: latestQueueFailure.lastError,
              updatedAt: this.toDate(
                latestQueueFailure.updatedAt,
              )?.toISOString(),
            }
          : null,
        dueJobsByType: dueJobTypes,
        derivedRecalculation: {
          pendingDue: derivedJobsPending,
          pendingOrProcessing: Number(derivedJobsActive),
          failedOrQuarantined: Number(derivedJobsTerminal),
        },
      },
      collection: {
        byStatus: collectionCounts,
        recentFailuresLast24Hours: Number(recentCollectionFailures),
        staleProcessingStates: Number(staleCollectionProcessing),
        overdueRecurringStates: Number(overdueScheduledCollections),
        latest: latestCollectionStates,
        recentFailureSamples: recentCollectionFailureRows,
        latestMilestones: {
          liveScoreboardAt: latestLiveScoreboardAt?.toISOString(),
          dailyScoreboardAt: latestDailyScoreboardAt?.toISOString(),
          matchOddsAt: latestMatchOddsCollectionAt?.toISOString(),
          matchPlaysAt: latestPlaysAt?.toISOString(),
          fixtureDayValidationAt: latestFixtureValidationAt?.toISOString(),
        },
      },
      bootstrap: {
        state: bootstrap
          ? {
              status: bootstrap.status,
              runId: bootstrap.runId,
              currentPhase: bootstrap.currentPhase,
              startedAt: this.toDate(bootstrap.startedAt)?.toISOString(),
              completedAt: this.toDate(bootstrap.completedAt)?.toISOString(),
              ageMs: bootstrapAgeMs,
              lastError: bootstrap.lastError,
            }
          : null,
        phaseProgress: bootstrapPhaseProgress,
        currentSeasons: {
          total: currentSeasons.length,
          monthlyBootstrapCompleted: monthlyBootstrapRows.length,
          monthlyBootstrapMissing: Math.max(
            0,
            currentSeasons.length - monthlyBootstrapRows.length,
          ),
          monthlyBootstrapMissingOver24Hours: staleCurrentSeasons.length,
          missingDateRanges: Number(currentSeasonsMissingDates),
          incompleteDailyValidationsLast14Days: Number(
            incompleteDailyValidations,
          ),
        },
      },
      fixtures: {
        competitions: Number(competitionTotal),
        total: Number(fixtureTotal),
        upcomingWithin60Hours: Number(upcomingFixtureTotal),
        live: Number(liveFixtureTotal),
        completedLast14Days: Number(recentCompletedFixtureTotal),
        latestCompletedAt: completedAt?.toISOString(),
        latestFixtureUpdatedAt: this.toDate(
          latestCompletedFixture?.updatedAt,
        )?.toISOString(),
      },
      timeline: {
        totalEvents: Number(timelineEventTotal),
        recentCompletedFixtureCoverage: recentTimelineStates,
      },
      oddsSnapshots: {
        total: Number(oddsSnapshotTotal),
        latestCollectedAt: this.toDate(
          latestOddsSnapshot?.collectedAt,
        )?.toISOString(),
        latestProvider: latestOddsSnapshot?.provider,
        latestFixtureId: latestOddsSnapshot?.fixtureId,
        upcomingCoverage: upcomingOddsData,
      },
      derivedData: {
        latestCalculatedAt: latestProjectionAt?.toISOString(),
        latestCompletedFixtureAt: completedAt?.toISOString(),
        lagMs: Number.isFinite(derivedLagMs) ? derivedLagMs : null,
        stale: derivedLagMs > 15 * MINUTE && derivedJobsActive === 0,
        projections: projectionLatestRows,
        freshness: projectionFreshness,
        pendingOrProcessingJobs: Number(derivedJobsActive),
        failedOrQuarantinedJobs: Number(derivedJobsTerminal),
      },
      sourceOutbox: {
        byStatus: outboxCounts,
        expiredProcessingLeases: Number(expiredOutboxLeases),
        failedEvents: Number(failedOutboxEvents),
        oldestPendingEvent: oldestPendingOutboxEvent
          ? {
              eventId: oldestPendingOutboxEvent.eventId,
              entity: oldestPendingOutboxEvent.entity,
              entityId: oldestPendingOutboxEvent.entityId,
              changedAt: oldestOutboxAt?.toISOString(),
              ageMs: oldestOutboxAgeMs,
              attempts: Number(oldestPendingOutboxEvent.attempts ?? 0),
            }
          : null,
      },
      downstream,
      alerts,
      summary: {
        criticalAlerts,
        warningAlerts,
        totalAlerts: alerts.length,
        queuePending: Number(queueCounts.PENDING ?? 0),
        queueProcessing: Number(queueCounts.PROCESSING ?? 0),
        queueQuarantined: Number(queueCounts.QUARANTINED ?? 0),
        collectionFailures: Number(recentCollectionFailures),
        outboxPending: Number(outboxCounts.PENDING ?? 0),
      },
    };
  }

  private async getLatestCollectionStates(): Promise<Record<string, unknown>> {
    const types = [
      'LEAGUE_CATALOGUE',
      'LEAGUE_DETAILS',
      'SEASON_CATALOGUE',
      'TEAM_CATALOGUE',
      'TEAM_DETAILS',
      'FIXTURE_DAILY_SCOREBOARD',
      'LIVE_SCOREBOARD',
      'MATCH_ODDS',
      'MATCH_PLAYS',
      'FIXTURE_DAILY_VALIDATION',
    ];
    const rows = await Promise.all(
      types.map((collectionType) => {
        const dateField =
          collectionType === 'FIXTURE_DAILY_VALIDATION'
            ? 'validatedAt'
            : 'lastSuccessfulAt';
        const sortField = dateField;
        return this.collectionStateModel
          .findOne({ collectionType })
          .sort({ [sortField]: -1, updatedAt: -1 })
          .select({
            collectionType: 1,
            scopeType: 1,
            scopeId: 1,
            status: 1,
            lastStartedAt: 1,
            lastSuccessfulAt: 1,
            nextRunAt: 1,
            validatedAt: 1,
            validationResult: 1,
            failureCount: 1,
            lastError: 1,
            endpoint: 1,
          })
          .lean()
          .exec();
      }),
    );
    return Object.fromEntries(
      types.map((type, index) => [type, rows[index] ?? null]),
    );
  }

  private async getLatestProjectionRows(
    latestCompetitionId?: string,
    latestSeasonId?: string,
  ): Promise<Record<string, unknown>> {
    const models: Array<[string, Model<any>]> = [
      ['standings', this.standingsModel],
      ['teamForm', this.teamFormModel],
      ['homeAway', this.homeAwayModel],
      ['teamScoring', this.teamScoringModel],
      ['headToHead', this.headToHeadModel],
      ['competitionScoring', this.competitionScoringModel],
      ['teamStatistics', this.teamStatisticsModel],
      ['playerEventTotals', this.playerEventTotalsModel],
    ];
    const rows = await Promise.all(
      models.map(async ([name, model]) => {
        // Season-scoped projections must be checked against the most recently
        // completed fixture's own competition/season. Comparing the oldest row
        // across every historical season would falsely mark healthy data stale.
        const filter =
          latestCompetitionId && latestSeasonId
            ? name === 'headToHead'
              ? { competitionId: latestCompetitionId }
              : { competitionId: latestCompetitionId, seasonId: latestSeasonId }
            : {};
        const latest = await model
          .findOne(filter)
          .sort({ calculatedAt: -1 })
          .select({
            calculatedAt: 1,
            competitionId: 1,
            seasonId: 1,
            sourceFixtureCount: 1,
          })
          .lean()
          .exec();
        return [
          name,
          latest
            ? {
                calculatedAt: this.toDate(latest.calculatedAt)?.toISOString(),
                competitionId: latest.competitionId,
                seasonId: latest.seasonId,
                sourceFixtureCount: Number(latest.sourceFixtureCount ?? 0),
              }
            : null,
        ] as const;
      }),
    );
    return Object.fromEntries(rows);
  }

  private getProjectionFreshness(
    rows: Record<string, any>,
    latestCompletedAt?: Date,
  ): Record<string, unknown> & {
    missingStores: number;
    oldestCalculatedAt?: string;
  } {
    // These seven stores are populated by recalculateSeason for a season with
    // completed scorelines. Player-event totals may legitimately be empty.
    const requiredStores = [
      'standings',
      'teamForm',
      'homeAway',
      'teamScoring',
      'headToHead',
      'competitionScoring',
      'teamStatistics',
    ];
    const staleCutoff = latestCompletedAt
      ? latestCompletedAt.getTime() - 15 * MINUTE
      : undefined;
    const missing: string[] = [];
    const stale: string[] = [];
    const dates: Date[] = [];
    for (const store of requiredStores) {
      const date = this.toDate(rows[store]?.calculatedAt);
      if (!date) {
        missing.push(store);
        continue;
      }
      dates.push(date);
      if (staleCutoff !== undefined && date.getTime() < staleCutoff)
        stale.push(store);
    }
    const oldest = dates.length
      ? dates.reduce((value, current) => (current < value ? current : value))
      : undefined;
    return {
      requiredStores: requiredStores.length,
      missingStores: missing.length,
      missing,
      staleStores: stale.length,
      stale,
      oldestCalculatedAt: oldest?.toISOString(),
      latestCompletedFixtureAt: latestCompletedAt?.toISOString(),
    };
  }

  private async getUpcomingOddsCoverage(
    fixtures: any[],
    now: Date,
  ): Promise<OddsCoverage> {
    // Odds are not expected before the first 48-hour collection checkpoint.
    // Excluding earlier fixtures prevents healthy pre-market waiting time from
    // making Sports/ Odds readiness appear degraded.
    const firstCheckpointCutoff =
      now.getTime() + ODDS_FIRST_CHECKPOINT_LEAD_MS;
    const eligibleFixtures = fixtures.filter((fixture) => {
      const kickoffAt = this.toDate(fixture.kickoffAt);
      return Boolean(kickoffAt && kickoffAt.getTime() <= firstCheckpointCutoff);
    });
    if (!eligibleFixtures.length) {
      return {
        eligibleFixtureSampleSize: 0,
        sampleLimit: 300,
        sampleSize: 0,
        freshSnapshots: 0,
        missingOrStale: 0,
        coveragePercent: null,
        freshnessWindowMs: DAY,
      };
    }
    const fixtureIds = eligibleFixtures
      .map((fixture) => String(fixture.id ?? ''))
      .filter(Boolean);
    if (!fixtureIds.length) {
      return {
        eligibleFixtureSampleSize: 0,
        sampleLimit: 300,
        sampleSize: 0,
        freshSnapshots: 0,
        missingOrStale: 0,
        coveragePercent: null,
        freshnessWindowMs: DAY,
      };
    }
    const [snapshotRows, stateRows] = await Promise.all([
      this.oddsSnapshotModel
        .aggregate([
          { $match: { fixtureId: { $in: fixtureIds } } },
          { $sort: { fixtureId: 1, collectedAt: -1 } },
          {
            $group: {
              _id: '$fixtureId',
              collectedAt: { $first: '$collectedAt' },
              provider: { $first: '$provider' },
            },
          },
        ])
        .exec(),
      this.collectionStateModel
        .find({
          collectionType: 'MATCH_ODDS',
          scopeType: 'FIXTURE',
          scopeId: { $in: fixtureIds },
        })
        .select({ scopeId: 1, status: 1, lastSuccessfulAt: 1, lastError: 1 })
        .lean()
        .exec(),
    ]);
    const snapshotByFixture = new Map<string, any>(
      snapshotRows.map((row: any) => [String(row._id), row]),
    );
    const stateByFixture = new Map<string, any>(
      stateRows.map((row: any) => [String(row.scopeId), row]),
    );
    const staleCutoff = now.getTime() - DAY;
    let freshSnapshots = 0;
    let staleSnapshots = 0;
    let failedCollections = 0;
    for (const fixtureId of fixtureIds) {
      const snapshotAt = this.toDate(
        snapshotByFixture.get(fixtureId)?.collectedAt,
      );
      if (snapshotAt && snapshotAt.getTime() >= staleCutoff)
        freshSnapshots += 1;
      else if (snapshotAt) staleSnapshots += 1;
      if (stateByFixture.get(fixtureId)?.status === 'FAILED')
        failedCollections += 1;
    }
    const sampleSize = fixtureIds.length;
    const missingOrStale = Math.max(0, sampleSize - freshSnapshots);
    return {
      eligibleFixtureSampleSize: sampleSize,
      sampleLimit: 300,
      sampleSize,
      freshSnapshots,
      staleSnapshots,
      missingOrStale,
      failedCollections,
      coveragePercent: sampleSize
        ? Math.round((freshSnapshots / sampleSize) * 10_000) / 100
        : null,
      freshnessWindowMs: DAY,
    };
  }

  private async getRecentTimelineCoverage(
    fixtures: any[],
  ): Promise<TimelineCoverage> {
    if (!fixtures.length) {
      return {
        sampleSize: 0,
        covered: 0,
        missing: 0,
        coveragePercent: null,
        gracePeriodMs: 15 * MINUTE,
      };
    }
    const fixtureIds = fixtures
      .map((fixture) => String(fixture.id ?? ''))
      .filter(Boolean);
    const states = await this.collectionStateModel
      .find({
        collectionType: 'MATCH_PLAYS',
        scopeType: 'FIXTURE',
        scopeId: { $in: fixtureIds },
      })
      .select({
        scopeId: 1,
        status: 1,
        endpoint: 1,
        lastSuccessfulAt: 1,
        lastError: 1,
      })
      .lean()
      .exec();
    const byFixture = new Map<string, any>(
      states.map((row: any) => [String(row.scopeId), row]),
    );
    let covered = 0;
    let failed = 0;
    for (const fixtureId of fixtureIds) {
      const state = byFixture.get(fixtureId);
      if (
        state?.status === 'SUCCEEDED' &&
        /\/plays(?:[?#]|$)/i.test(String(state.endpoint ?? ''))
      )
        covered += 1;
      if (state?.status === 'FAILED') failed += 1;
    }
    const sampleSize = fixtureIds.length;
    const missing = Math.max(0, sampleSize - covered);
    return {
      sampleSize,
      sampleLimit: 200,
      covered,
      missing,
      failedCollections: failed,
      coveragePercent: sampleSize
        ? Math.round((covered / sampleSize) * 10_000) / 100
        : null,
      gracePeriodMs: 15 * MINUTE,
    };
  }

  private buildDownstreamReadiness(input: {
    fixtureTotal: number;
    upcomingFixtureTotal: number;
    oddsCoverage: OddsCoverage;
    timelineCoverage: TimelineCoverage;
    latestProjectionAt?: Date;
    latestCompletedAt?: Date;
    derivedLagMs: number;
    outboxCounts: Record<string, number>;
    failedOutboxEvents: number;
    expiredOutboxLeases: number;
    oldestOutboxAgeMs?: number;
  }): Record<string, unknown> {
    const oddsCoverage = input.oddsCoverage.coveragePercent;
    const oddsStatus =
      input.oddsCoverage.eligibleFixtureSampleSize === 0
        ? 'NOT_REQUIRED'
        : typeof oddsCoverage === 'number' && oddsCoverage >= 80
          ? 'READY'
          : 'DEGRADED';
    const predictionsReady =
      input.fixtureTotal > 0 &&
      (!input.latestCompletedAt ||
        (Boolean(input.latestProjectionAt) &&
          input.derivedLagMs <= 15 * MINUTE));
    const timelineCoverageReady =
      typeof input.timelineCoverage.coveragePercent !== 'number' ||
      Number(input.timelineCoverage.sampleSize ?? 0) < 10 ||
      Number(input.timelineCoverage.coveragePercent) >= 95;
    const settlementReady =
      input.fixtureTotal > 0 &&
      input.failedOutboxEvents === 0 &&
      input.expiredOutboxLeases === 0 &&
      Number(input.oldestOutboxAgeMs ?? 0) <= 5 * MINUTE &&
      timelineCoverageReady;
    return {
      odds: {
        status: oddsStatus,
        fixtureSourceAvailable: input.fixtureTotal > 0,
        upcomingFixturesWithin60Hours: input.upcomingFixtureTotal,
        freshOddsSnapshotCoveragePercent: oddsCoverage,
        observedConsumerHealth:
          this.systemMonitor.getModuleHealth('odds')?.status ?? 'UNKNOWN',
      },
      predictions: {
        status: predictionsReady ? 'READY' : 'DEGRADED',
        fixtureSourceAvailable: input.fixtureTotal > 0,
        derivedProjectionAvailable: Boolean(input.latestProjectionAt),
        latestProjectionAt: input.latestProjectionAt?.toISOString(),
        derivedProjectionLagMs: Number.isFinite(input.derivedLagMs)
          ? input.derivedLagMs
          : null,
        observedConsumerHealth:
          this.systemMonitor.getModuleHealth('predictions-engine')?.status ??
          'UNKNOWN',
      },
      settlement: {
        status: settlementReady ? 'READY' : 'DEGRADED',
        fixtureSourceAvailable: input.fixtureTotal > 0,
        recentTimelineCoveragePercent: input.timelineCoverage.coveragePercent,
        pendingSourceEvents: Number(input.outboxCounts.PENDING ?? 0),
        oldestPendingSourceEventAgeMs: input.oldestOutboxAgeMs ?? null,
        failedSourceEvents: input.failedOutboxEvents,
        expiredSourceEventLeases: input.expiredOutboxLeases,
        observedConsumerHealth:
          this.systemMonitor.getModuleHealth('settlement')?.status ?? 'UNKNOWN',
      },
    };
  }

  private publishHealth(overview: Record<string, any>, checkedAt: Date): void {
    const status = String(overview.status ?? 'UNKNOWN');
    const message = String(
      overview.message ?? 'Sports health check completed.',
    );
    const details = {
      queuePending: Number(overview.summary?.queuePending ?? 0),
      queueProcessing: Number(overview.summary?.queueProcessing ?? 0),
      queueQuarantined: Number(overview.summary?.queueQuarantined ?? 0),
      dueQueueJobs: Number(overview.queue?.duePendingJobs ?? 0),
      staleQueueLeases: Number(overview.queue?.staleProcessingJobs ?? 0),
      terminalQueueFailures24h: Number(
        overview.queue?.terminalFailuresUpdatedLast24Hours ?? 0,
      ),
      collectionFailures24h: Number(
        overview.collection?.recentFailuresLast24Hours ?? 0,
      ),
      staleCollectionStates: Number(
        overview.collection?.staleProcessingStates ?? 0,
      ),
      overdueRecurringCollections: Number(
        overview.collection?.overdueRecurringStates ?? 0,
      ),
      bootstrapStatus: String(overview.bootstrap?.state?.status ?? 'UNKNOWN'),
      bootstrapPhase: String(overview.bootstrap?.state?.currentPhase ?? 'NONE'),
      fixtureCount: Number(overview.fixtures?.total ?? 0),
      upcomingFixtureCount: Number(
        overview.fixtures?.upcomingWithin60Hours ?? 0,
      ),
      liveFixtureCount: Number(overview.fixtures?.live ?? 0),
      timelineCoveragePercent: Number(
        overview.timeline?.recentCompletedFixtureCoverage?.coveragePercent ??
          -1,
      ),
      upcomingOddsCoveragePercent: Number(
        overview.oddsSnapshots?.upcomingCoverage?.coveragePercent ?? -1,
      ),
      derivedProjectionLagMs: Number(overview.derivedData?.lagMs ?? -1),
      missingDerivedStores: Number(
        overview.derivedData?.freshness?.missingStores ?? 0,
      ),
      failedDerivedJobs: Number(
        overview.derivedData?.failedOrQuarantinedJobs ?? 0,
      ),
      outboxPending: Number(overview.sourceOutbox?.byStatus?.PENDING ?? 0),
      outboxFailed: Number(overview.sourceOutbox?.failedEvents ?? 0),
      expiredOutboxLeases: Number(
        overview.sourceOutbox?.expiredProcessingLeases ?? 0,
      ),
      espnRequestAttempts: Number(
        overview.provider?.espn?.requestAttempts ?? 0,
      ),
      espnFailedResponses: Number(
        overview.provider?.espn?.failedResponses ?? 0,
      ),
      espnRateLimitedResponses: Number(
        overview.provider?.espn?.rateLimitedResponses ?? 0,
      ),
      espnConsecutiveFailures: Number(
        overview.provider?.espn?.consecutiveFailures ?? 0,
      ),
      alerts: (overview.alerts ?? [])
        .map((item: SportsMonitorAlert) => item.code)
        .join(','),
      oddsReadiness: String(overview.downstream?.odds?.status ?? 'UNKNOWN'),
      predictionsReadiness: String(
        overview.downstream?.predictions?.status ?? 'UNKNOWN',
      ),
      settlementReadiness: String(
        overview.downstream?.settlement?.status ?? 'UNKNOWN',
      ),
    };
    const alerts = Array.isArray(overview.alerts)
      ? (overview.alerts as SportsMonitorAlert[])
      : [];
    this.systemMonitor.reportMonitorSnapshot('sports', {
      status,
      checkedAt,
      checks: alerts,
      warnings: alerts
        .filter((alert) => alert.severity === 'WARNING')
        .map((alert) => alert.message),
      details,
    });

    const provider = overview.provider?.espn;
    const failureAt = this.toDate(provider?.lastFailedAt);
    const failureKey = failureAt
      ? `${failureAt.toISOString()}:${String(provider?.lastFailure ?? '')}`
      : undefined;
    if (failureKey && failureKey !== this.lastReportedProviderFailureKey) {
      this.systemMonitor.reportError({
        module: 'sports',
        source: 'espn-provider',
        operation: String(provider?.lastRequestLabel ?? 'request'),
        message: String(provider?.lastFailure ?? 'ESPN request failed.'),
        occurredAt: failureAt!,
        referenceKey: `espn:${String(provider?.lastRequestLabel ?? 'request')}`,
      });
      this.lastReportedProviderFailureKey = failureKey;
    }

    const workerLastJob = overview.worker?.lastJob;
    if (
      workerLastJob &&
      ['RETRY', 'QUARANTINED'].includes(String(workerLastJob.outcome))
    ) {
      const workerJobAt = this.toDate(workerLastJob.occurredAt);
      const workerFailureKey = workerJobAt
        ? `${String(workerLastJob.jobKey ?? '')}:${workerJobAt.toISOString()}:${String(workerLastJob.outcome)}`
        : undefined;
      if (
        workerFailureKey &&
        workerFailureKey !== this.lastReportedWorkerFailureKey
      ) {
        this.systemMonitor.reportError({
          module: 'sports',
          source: 'sports-queue-worker',
          operation: String(workerLastJob.type ?? 'queue-job'),
          message: String(
            workerLastJob.error ??
              `Sports queue job outcome: ${workerLastJob.outcome}.`,
          ),
          occurredAt: workerJobAt!,
          referenceKey: String(workerLastJob.jobKey ?? 'sports-queue'),
        });
        this.lastReportedWorkerFailureKey = workerFailureKey;
      }
    }

    const queueFailure = overview.queue?.latestFailure;
    const queueFailureAt = this.toDate(queueFailure?.updatedAt);
    const queueFailureKey = queueFailureAt
      ? `${String(queueFailure?.jobKey ?? '')}:${queueFailureAt.toISOString()}:${String(queueFailure?.status ?? '')}`
      : undefined;
    if (
      queueFailureKey &&
      queueFailureKey !== this.lastReportedQueueFailureKey
    ) {
      this.systemMonitor.reportError({
        module: 'sports',
        source: 'sports-queue',
        operation: String(queueFailure?.type ?? 'queue-job'),
        message: String(
          queueFailure?.message ??
            `Sports queue job entered ${queueFailure?.status ?? 'a terminal state'}.`,
        ),
        occurredAt: queueFailureAt!,
        referenceKey: String(queueFailure?.jobKey ?? 'sports-queue'),
      });
      this.lastReportedQueueFailureKey = queueFailureKey;
    }

    const collectionFailure = overview.collection?.recentFailureSamples?.[0];
    const collectionFailureAt = this.toDate(collectionFailure?.updatedAt);
    const collectionFailureKey = collectionFailureAt
      ? `${String(collectionFailure?.collectionType ?? '')}:${String(collectionFailure?.scopeId ?? '')}:${collectionFailureAt.toISOString()}`
      : undefined;
    if (
      collectionFailureKey &&
      collectionFailureKey !== this.lastReportedCollectionFailureKey
    ) {
      this.systemMonitor.reportError({
        module: 'sports',
        source: 'sports-collection',
        operation: String(collectionFailure?.collectionType ?? 'collection'),
        message: String(
          collectionFailure?.lastError ?? 'ESPN collection failed.',
        ),
        occurredAt: collectionFailureAt!,
        referenceKey: `${String(collectionFailure?.collectionType ?? 'collection')}:${String(collectionFailure?.scopeId ?? '')}`,
      });
      this.lastReportedCollectionFailureKey = collectionFailureKey;
    }

    if (status !== 'HEALTHY') {
      this.logger.warn(`Sports monitor: ${message}`);
    }
  }

  private toCountMap(rows: CountRow[]): Record<string, number> {
    return Object.fromEntries(
      rows.map((row) => [String(row._id ?? 'UNKNOWN'), Number(row.count ?? 0)]),
    );
  }

  private getLatestStateDate(
    states: Record<string, any>,
    collectionType: string,
    field: string,
  ): Date | undefined {
    return this.toDate(states[collectionType]?.[field]);
  }

  private latestDate(rows: Record<string, any>): Date | undefined {
    const dates = Object.values(rows)
      .map((row: any) => this.toDate(row?.calculatedAt))
      .filter((value): value is Date => Boolean(value));
    if (!dates.length) return undefined;
    return dates.reduce((latest, current) =>
      current > latest ? current : latest,
    );
  }

  private toDate(value: unknown): Date | undefined {
    if (!value) return undefined;
    const date =
      value instanceof Date ? value : new Date(value as string | number);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }

  private readPositiveInteger(
    value: string | undefined,
    fallback: number,
  ): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 500)
      : String(error)
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 500);
  }
}

