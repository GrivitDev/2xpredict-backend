import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BetLabTicket } from '../../bet-lab/schemas/bet-lab-ticket.schema';
import { MarketPrediction } from '../../predictions-engine/schemas/market-prediction.schema';
import {
  SettlementEvent,
  SettlementEventDocument,
} from '../schemas/settlement-event.schema';
import {
  SettlementJob,
  SettlementJobDocument,
} from '../schemas/settlement-job.schema';
import {
  SettlementRun,
  SettlementRunDocument,
} from '../schemas/settlement-run.schema';
import { SettlementJobStatus } from '../enums/settlement-job-status.enum';
import { SettlementWorkerService } from './settlement-worker.service';
import { SETTLEMENT_CONFIG } from '../config/settlement.config';
import { SettlementMonitorAlert, SettlementMonitorHealth, SettlementMonitorHealthStatus } from '../interfaces/settlement-monitor.interface';
import {
  SettlementEventQuery,
  SettlementJobQuery,
  SettlementRunQuery,
} from '../interfaces/settlement-monitor.interface';

@Injectable()
export class SettlementMonitorService {
  constructor(
    @InjectModel(SettlementJob.name)
    private readonly jobModel: Model<SettlementJobDocument>,
    @InjectModel(SettlementRun.name)
    private readonly runModel: Model<SettlementRunDocument>,
    @InjectModel(SettlementEvent.name)
    private readonly eventModel: Model<SettlementEventDocument>,
    @InjectModel(MarketPrediction.name)
    private readonly marketPredictionModel: Model<MarketPrediction>,
    @InjectModel(BetLabTicket.name)
    private readonly betLabTicketModel: Model<BetLabTicket>,
    private readonly worker: SettlementWorkerService,
  ) {}

  async getOverview() {
    const [
      jobRows,
      runRows,
      predictionRows,
      ticketRows,
      legRows,
      walletStats,
      recentJobs,
      recentRuns,
      recentErrors,
      oldestPartialJobs,
    ] = await Promise.all([
      this.jobModel
        .aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
        .exec() as Promise<Array<{ _id: string; count: number }>>,
      this.runModel
        .aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
        .exec() as Promise<Array<{ _id: string; count: number }>>,
      this.marketPredictionModel
        .aggregate([
          { $unwind: '$selections' },
          {
            $group: {
              _id: { $ifNull: ['$selections.actualOutcome', 'UNSETTLED'] },
              count: { $sum: 1 },
            },
          },
        ])
        .exec() as Promise<Array<{ _id: string; count: number }>>,
      this.betLabTicketModel
        .aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
        .exec() as Promise<Array<{ _id: string; count: number }>>,
      this.betLabTicketModel
        .aggregate([
          { $unwind: '$legs' },
          { $group: { _id: '$legs.status', count: { $sum: 1 } } },
        ])
        .exec() as Promise<Array<{ _id: string; count: number }>>,
      this.betLabTicketModel
        .aggregate([
          {
            $group: {
              _id: null,
              distinctUsers: { $addToSet: '$userId' },
              ticketCount: { $sum: 1 },
              stakePoints: { $sum: '$stake' },
              potentialReturnPoints: { $sum: '$potentialReturn' },
            },
          },
          {
            $project: {
              _id: 0,
              usersWithTickets: { $size: '$distinctUsers' },
              ticketCount: 1,
              stakePoints: 1,
              potentialReturnPoints: 1,
            },
          },
        ])
        .exec() as Promise<
        Array<{
          usersWithTickets: number;
          ticketCount: number;
          stakePoints: number;
          potentialReturnPoints: number;
        }>
      >,
      this.jobModel
        .find()
        .sort({ updatedAt: -1 })
        .limit(10)
        .select({
          jobKey: 1,
          eventId: 1,
          leagueId: 1,
          status: 1,
          attempts: 1,
          sourceFingerprint: 1,
          triggerReason: 1,
          lastError: 1,
          lastDurationMs: 1,
          resultCounts: 1,
          unresolvedReasons: 1,
          nextRunAt: 1,
          updatedAt: 1,
        })
        .lean()
        .exec(),
      this.runModel
        .find()
        .sort({ createdAt: -1 })
        .limit(10)
        .select({
          eventId: 1,
          leagueId: 1,
          sourceFingerprint: 1,
          status: 1,
          counts: 1,
          unresolvedReasons: 1,
          durationMs: 1,
          startedAt: 1,
          completedAt: 1,
          createdAt: 1,
        })
        .lean()
        .exec(),
      this.eventModel
        .find({
          level: { $in: ['WARN', 'ERROR'] as SettlementEvent['level'][] },
        })
        .sort({ occurredAt: -1 })
        .limit(20)
        .lean()
        .exec(),
      this.jobModel
        .find({ status: SettlementJobStatus.PARTIAL })
        .sort({ updatedAt: 1 })
        .limit(10)
        .select({
          jobKey: 1,
          eventId: 1,
          leagueId: 1,
          status: 1,
          nextRunAt: 1,
          resultCounts: 1,
          unresolvedReasons: 1,
          lastError: 1,
          lastDurationMs: 1,
          updatedAt: 1,
        })
        .lean()
        .exec(),
    ]);

    const jobsByStatus = this.toCountMap(jobRows);
    const runsByStatus = this.toCountMap(runRows);
    const predictionSelectionsByOutcome = this.toCountMap(predictionRows);
    const resolvedPredictionOutcomes = new Set(['WON', 'LOST', 'VOID', 'PUSH', 'HALF_WON', 'HALF_LOST']);
    const betLabTicketsByStatus = this.toCountMap(ticketRows);
    const betLabLegsByStatus = this.toCountMap(legRows);
    const usersWithTickets = Number(walletStats[0]?.usersWithTickets ?? 0);

    const overview = {
      generatedAt: new Date(),
      architecture: {
        trigger: 'Target creation and ESPN Summary updates, with an unresolved-target recovery scan',
        execution: 'Persistent MongoDB queue with event-woken worker',
        cronJobs: false,
        settlementOwner:
          'Shared Settlement module; outcomes are not calculated inside Sports, Predictions Engine or Bet Lab',
      },
      queue: {
        total: Object.values(jobsByStatus).reduce(
          (sum, count) => sum + count,
          0,
        ),
        byStatus: jobsByStatus,
        queued: jobsByStatus.QUEUED ?? 0,
        processing: jobsByStatus.PROCESSING ?? 0,
        retrying: jobsByStatus.RETRY ?? 0,
        partial: jobsByStatus.PARTIAL ?? 0,
        failed: jobsByStatus.FAILED ?? 0,
        completed: jobsByStatus.COMPLETED ?? 0,
        partialAwaitingRetry: jobsByStatus.PARTIAL ?? 0,
        oldestPartialJobs,
      },
      runs: {
        total: Object.values(runsByStatus).reduce(
          (sum, count) => sum + count,
          0,
        ),
        byStatus: runsByStatus,
      },
      predictionEngine: {
        marketDocuments: await this.marketPredictionModel
          .countDocuments()
          .exec(),
        selectionsByOutcome: predictionSelectionsByOutcome,
        settledSelections: Object.entries(predictionSelectionsByOutcome)
          .filter(([key]) => resolvedPredictionOutcomes.has(key.toUpperCase()))
          .reduce((sum, [, count]) => sum + count, 0),
        unsettledSelections: Object.entries(predictionSelectionsByOutcome)
          .filter(([key]) => !resolvedPredictionOutcomes.has(key.toUpperCase()))
          .reduce((sum, [, count]) => sum + count, 0),
      },
      betLab: {
        usersWithTickets,
        totalTickets: Number(walletStats[0]?.ticketCount ?? 0),
        totalStakedVirtualPoints: Number(walletStats[0]?.stakePoints ?? 0),
        potentialReturnVirtualPoints: Number(
          walletStats[0]?.potentialReturnPoints ?? 0,
        ),
        ticketsByStatus: betLabTicketsByStatus,
        legsByStatus: betLabLegsByStatus,
        unresolvedLegs: betLabLegsByStatus.OPEN ?? 0,
      },
      recentJobs,
      recentRuns,
      recentWarningsAndErrors: recentErrors,
    };
    return {
      ...overview,
      health: await this.getHealth(jobsByStatus, predictionSelectionsByOutcome, betLabLegsByStatus),
    };
  }

  private async getHealth(
    jobsByStatus: Record<string, number>,
    predictionSelectionsByOutcome: Record<string, number>,
    betLabLegsByStatus: Record<string, number>,
  ): Promise<SettlementMonitorHealth> {
    const now = new Date();
    const staleCutoff = new Date(now.getTime() - SETTLEMENT_CONFIG.queue.processingLeaseMinutes * 60_000);
    const [dueQueuedJobs, staleProcessingJobs, recentFailedJobs, oldestDueQueued, overdueBetLabRows] = await Promise.all([
      this.jobModel.countDocuments({
        status: { $in: [SettlementJobStatus.QUEUED, SettlementJobStatus.RETRY, SettlementJobStatus.PARTIAL] },
        nextRunAt: { $lte: now },
      }).exec(),
      this.jobModel.countDocuments({
        status: SettlementJobStatus.PROCESSING,
        $or: [
          { lockedAt: { $lte: staleCutoff } },
          { lockedAt: { $exists: false }, updatedAt: { $lte: staleCutoff } },
        ],
      }).exec(),
      this.jobModel.countDocuments({
        status: SettlementJobStatus.FAILED,
        updatedAt: { $gte: new Date(now.getTime() - 24 * 60 * 60_000) },
      }).exec(),
      this.jobModel.findOne({
        status: { $in: [SettlementJobStatus.QUEUED, SettlementJobStatus.RETRY, SettlementJobStatus.PARTIAL] },
        nextRunAt: { $lte: now },
      }).sort({ nextRunAt: 1 }).select({ nextRunAt: 1 }).lean().exec(),
      this.betLabTicketModel.aggregate([
        { $match: { status: { $in: ['OPEN', 'PENDING_SETTLEMENT'] } } },
        { $unwind: '$legs' },
        { $match: { 'legs.status': 'OPEN', 'legs.fixtureDate': { $lte: new Date(now.getTime() - 3.5 * 60 * 60_000) } } },
        { $count: 'count' },
      ]).exec() as Promise<Array<{ count: number }>>,
    ]);
    const worker = this.worker.getRuntimeStatus();
    const oldestDueAt = oldestDueQueued?.nextRunAt instanceof Date
      ? oldestDueQueued.nextRunAt
      : oldestDueQueued?.nextRunAt ? new Date(oldestDueQueued.nextRunAt as unknown as string) : undefined;
    const oldestDueQueuedAgeMs = oldestDueAt && Number.isFinite(oldestDueAt.getTime())
      ? Math.max(0, now.getTime() - oldestDueAt.getTime())
      : undefined;
    const resolvedOutcomes = new Set(['WON', 'LOST', 'VOID', 'PUSH', 'HALF_WON', 'HALF_LOST']);
    const unsettledPredictionSelections = Object.entries(predictionSelectionsByOutcome)
      .filter(([outcome]) => !resolvedOutcomes.has(outcome.toUpperCase()))
      .reduce((sum, [, count]) => sum + count, 0);
    const openBetLabLegs = Number(betLabLegsByStatus.OPEN ?? 0);
    const overdueBetLabLegs = Number(overdueBetLabRows[0]?.count ?? 0);
    const alerts: SettlementMonitorAlert[] = [];

    if (!worker.initialized) {
      alerts.push({
        code: 'WORKER_NOT_READY',
        severity: worker.lastStartupError ? 'CRITICAL' : 'WARNING',
        message: worker.lastStartupError
          ? 'Settlement worker has not completed startup recovery.'
          : 'Settlement worker is awaiting startup recovery.',
        details: { startupAttempts: worker.startupAttempts, lastStartupError: worker.lastStartupError },
      });
    }
    if (staleProcessingJobs > 0) alerts.push({
      code: 'STALE_PROCESSING_JOBS', severity: 'CRITICAL',
      message: 'Settlement jobs are marked PROCESSING beyond the configured lease window.',
      count: staleProcessingJobs,
    });
    if (dueQueuedJobs > 0 && !worker.busy && worker.initialized && (oldestDueQueuedAgeMs ?? 0) > 5 * 60_000) alerts.push({
      code: 'DUE_QUEUE_BACKLOG', severity: 'WARNING',
      message: 'Runnable settlement jobs have been waiting for more than five minutes while the worker is idle.',
      count: dueQueuedJobs,
      details: { oldestDueQueuedAgeMs },
    });
    if (worker.busy && worker.activeJob && worker.activeJob.durationMs > 10 * 60_000) alerts.push({
      code: 'LONG_RUNNING_JOB', severity: 'WARNING',
      message: 'A settlement job has been active for more than ten minutes.',
      details: { jobKey: worker.activeJob.jobKey, eventId: worker.activeJob.eventId, durationMs: worker.activeJob.durationMs },
    });
    if (recentFailedJobs > 0) alerts.push({
      code: 'RECENT_TERMINAL_FAILURES', severity: 'CRITICAL',
      message: 'Settlement jobs entered FAILED status within the last 24 hours.',
      count: recentFailedJobs,
    });
    if (overdueBetLabLegs > 0) alerts.push({
      code: 'OVERDUE_BET_LAB_LEGS', severity: 'WARNING',
      message: 'Bet Lab legs remain open more than 3.5 hours after their fixture date.',
      count: overdueBetLabLegs,
    });
    if ((jobsByStatus.PARTIAL ?? 0) > 0) alerts.push({
      code: 'PARTIAL_SETTLEMENTS', severity: 'WARNING',
      message: 'Some settlement jobs still have unresolved markets or Bet Lab legs.',
      count: jobsByStatus.PARTIAL,
    });
    if (worker.lastDrainErrorAt && (!worker.lastJobAt || new Date(worker.lastDrainErrorAt).getTime() > new Date(worker.lastJobAt).getTime())) {
      alerts.push({
        code: 'RECENT_DRAIN_FAILURES', severity: 'WARNING',
        message: 'The worker has encountered a queue-drain failure since its last recorded job.',
        count: worker.drainFailures,
        details: { lastDrainErrorAt: worker.lastDrainErrorAt },
      });
    }

    const critical = alerts.some((alert) => alert.severity === 'CRITICAL');
    const degraded = alerts.some((alert) => alert.severity === 'WARNING');
    const status: SettlementMonitorHealthStatus = !worker.initialized && !worker.lastStartupError
      ? 'UNKNOWN'
      : critical ? 'CRITICAL' : degraded ? 'DEGRADED' : 'HEALTHY';

    return {
      status,
      checkedAt: now.toISOString(),
      worker,
      queue: {
        dueQueuedJobs,
        staleProcessingJobs,
        failedJobs: Number(jobsByStatus.FAILED ?? 0),
        partialJobs: Number(jobsByStatus.PARTIAL ?? 0),
        oldestDueQueuedAt: oldestDueAt && Number.isFinite(oldestDueAt.getTime()) ? oldestDueAt.toISOString() : undefined,
        oldestDueQueuedAgeMs,
      },
      outcomes: { unsettledPredictionSelections, openBetLabLegs },
      alerts,
    };
  }

  async getJobs(query: SettlementJobQuery = {}) {
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const limit = Math.min(
      200,
      Math.max(1, Math.floor(Number(query.limit) || 50)),
    );
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.eventId?.trim()) filter.eventId = query.eventId.trim();
    const [items, total] = await Promise.all([
      this.jobModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.jobModel.countDocuments(filter).exec(),
    ]);
    return {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async getRuns(query: SettlementRunQuery = {}) {
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const limit = Math.min(
      200,
      Math.max(1, Math.floor(Number(query.limit) || 50)),
    );
    const filter: Record<string, unknown> = {};
    if (query.eventId?.trim()) filter.eventId = query.eventId.trim();
    const [items, total] = await Promise.all([
      this.runModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.runModel.countDocuments(filter).exec(),
    ]);
    return {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async getEvents(query: SettlementEventQuery = {}) {
    const limit = Math.min(
      200,
      Math.max(1, Math.floor(Number(query.limit) || 100)),
    );
    const filter: Record<string, unknown> = {};
    if (query.level) filter.level = query.level;
    if (query.eventId?.trim()) filter.eventId = query.eventId.trim();
    if (query.action?.trim()) filter.action = query.action.trim();
    const items = await this.eventModel
      .find(filter)
      .sort({ occurredAt: -1 })
      .limit(limit)
      .lean()
      .exec();
    return { items, limit };
  }

  private toCountMap(
    rows: Array<{ _id: string; count: number }>,
  ): Record<string, number> {
    return Object.fromEntries(
      rows.map((row) => [String(row._id ?? 'UNKNOWN'), Number(row.count ?? 0)]),
    );
  }
}
