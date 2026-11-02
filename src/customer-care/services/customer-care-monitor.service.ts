import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SupportConversation } from '../schemas/support-conversation.schema';
import { SupportMessage } from '../schemas/support-message.schema';
import { SupportActionAudit } from '../schemas/support-action-audit.schema';
import { SupportIncident } from '../schemas/support-incident.schema';
import { CustomerCareBroadcast } from '../schemas/customer-care-broadcast.schema';
import { CustomerCareJob } from '../schemas/customer-care-job.schema';
import { CustomerCareReplyJob } from '../schemas/customer-care-reply-job.schema';
import { SupportDiagnosticsService } from './support-diagnostics.service';

@Injectable()
export class CustomerCareMonitorService {
  private cachedOverview?: {
    expiresAt: number;
    value: Record<string, unknown>;
  };
  private inflightOverview?: Promise<Record<string, unknown>>;

  constructor(
    @InjectModel(SupportConversation.name)
    private readonly conversations: Model<SupportConversation>,
    @InjectModel(SupportMessage.name)
    private readonly messages: Model<SupportMessage>,
    @InjectModel(SupportActionAudit.name)
    private readonly actions: Model<SupportActionAudit>,
    @InjectModel(SupportIncident.name)
    private readonly incidents: Model<SupportIncident>,
    @InjectModel(CustomerCareBroadcast.name)
    private readonly broadcasts: Model<CustomerCareBroadcast>,
    @InjectModel(CustomerCareJob.name)
    private readonly jobs: Model<CustomerCareJob>,
    @InjectModel(CustomerCareReplyJob.name)
    private readonly replyJobs: Model<CustomerCareReplyJob>,
    private readonly diagnostics: SupportDiagnosticsService,
  ) {}

  async getOverview(): Promise<Record<string, unknown>> {
    const nowMs = Date.now();
    if (this.cachedOverview && this.cachedOverview.expiresAt > nowMs)
      return this.cachedOverview.value;
    // Coalesce simultaneous dashboard requests so cache expiry does not create a
    // burst of duplicate count/diagnostic queries against MongoDB.
    if (this.inflightOverview) return this.inflightOverview;
    const request = this.buildOverview(nowMs);
    this.inflightOverview = request;
    try {
      return await request;
    } finally {
      if (this.inflightOverview === request) this.inflightOverview = undefined;
    }
  }

  private async buildOverview(nowMs: number): Promise<Record<string, unknown>> {
    const checkedAt = new Date(nowMs);
    const last24Hours = new Date(checkedAt.getTime() - 24 * 60 * 60 * 1000);
    const staleBefore = new Date(checkedAt.getTime() - 5 * 60 * 1000);
    const safe = async <T>(
      label: string,
      query: () => Promise<T>,
      fallback: T,
    ): Promise<{ value: T; error?: string }> => {
      try {
        return { value: await query() };
      } catch (error) {
        return {
          value: fallback,
          error: `${label}: ${error instanceof Error ? error.message.slice(0, 250) : 'query failed'}`,
        };
      }
    };

    const results = await Promise.all([
      safe(
        'conversations.total',
        () => this.conversations.countDocuments({}).exec(),
        0,
      ),
      safe(
        'conversations.open',
        () =>
          this.conversations
            .countDocuments({
              status: 'OPEN',
              retentionDeleting: { $ne: true },
            })
            .exec(),
        0,
      ),
      safe(
        'conversations.last24h',
        () =>
          this.conversations
            .countDocuments({ createdAt: { $gte: last24Hours } })
            .exec(),
        0,
      ),
      safe(
        'messages.last24h',
        () =>
          this.messages
            .countDocuments({ createdAt: { $gte: last24Hours } })
            .exec(),
        0,
      ),
      safe(
        'actions.last24h',
        () =>
          this.actions
            .countDocuments({ createdAt: { $gte: last24Hours } })
            .exec(),
        0,
      ),
      safe(
        'actions.failed24h',
        () =>
          this.actions
            .countDocuments({
              outcome: { $in: ['FAILED', 'DENIED'] },
              createdAt: { $gte: last24Hours },
            })
            .exec(),
        0,
      ),
      safe(
        'groq.failed24h',
        () =>
          this.actions
            .countDocuments({
              actionName: 'groq_completion',
              outcome: 'FAILED',
              createdAt: { $gte: last24Hours },
            })
            .exec(),
        0,
      ),
      safe(
        'groq.succeeded24h',
        () =>
          this.actions
            .countDocuments({
              actionName: 'groq_completion',
              outcome: 'SUCCEEDED',
              createdAt: { $gte: last24Hours },
            })
            .exec(),
        0,
      ),
      safe(
        'incidents.open',
        () =>
          this.incidents
            .countDocuments({ status: { $in: ['OPEN', 'IN_PROGRESS'] } })
            .exec(),
        0,
      ),
      safe(
        'incidents.critical',
        () =>
          this.incidents
            .countDocuments({
              status: { $in: ['OPEN', 'IN_PROGRESS'] },
              severity: 'CRITICAL',
            })
            .exec(),
        0,
      ),
      safe(
        'incidents.last24h',
        () =>
          this.incidents
            .countDocuments({ createdAt: { $gte: last24Hours } })
            .exec(),
        0,
      ),
      safe(
        'broadcasts.sent24h',
        () =>
          this.broadcasts
            .countDocuments({ status: 'SENT', sentAt: { $gte: last24Hours } })
            .exec(),
        0,
      ),
      safe(
        'broadcasts.failed',
        () => this.broadcasts.countDocuments({ status: 'FAILED' }).exec(),
        0,
      ),
      safe(
        'broadcasts.review-required',
        () =>
          this.broadcasts.countDocuments({ manualReviewRequired: true }).exec(),
        0,
      ),
      safe(
        'broadcastJobs.pending',
        () => this.jobs.countDocuments({ type: { $ne: 'SUPPORT_NOTIFICATION' }, status: 'PENDING' }).exec(),
        0,
      ),
      safe(
        'broadcastJobs.processing',
        () => this.jobs.countDocuments({ type: { $ne: 'SUPPORT_NOTIFICATION' }, status: 'PROCESSING' }).exec(),
        0,
      ),
      safe(
        'broadcastJobs.failed',
        () => this.jobs.countDocuments({ type: { $ne: 'SUPPORT_NOTIFICATION' }, status: 'FAILED' }).exec(),
        0,
      ),
      safe(
        'replyJobs.pending',
        () => this.replyJobs.countDocuments({ status: 'PENDING' }).exec(),
        0,
      ),
      safe(
        'replyJobs.processing',
        () => this.replyJobs.countDocuments({ status: 'PROCESSING' }).exec(),
        0,
      ),
      safe(
        'replyJobs.failed',
        () => this.replyJobs.countDocuments({ status: 'FAILED' }).exec(),
        0,
      ),
      safe(
        'replyJobs.stalePending',
        () =>
          this.replyJobs
            .countDocuments({
              status: 'PENDING',
              scheduledAt: { $lte: staleBefore },
            })
            .exec(),
        0,
      ),
      safe(
        'replyJobs.staleLease',
        () =>
          this.replyJobs
            .countDocuments({
              status: 'PROCESSING',
              leaseExpiresAt: { $lte: checkedAt },
            })
            .exec(),
        0,
      ),
      safe(
        'broadcasts.failedLast24Hours',
        () =>
          this.broadcasts
            .countDocuments({
              status: 'FAILED',
              updatedAt: { $gte: last24Hours },
            })
            .exec(),
        0,
      ),
      safe(
        'broadcastJobs.failedLast24Hours',
        () =>
          this.jobs
            .countDocuments({
              type: { $ne: 'SUPPORT_NOTIFICATION' },
              status: 'FAILED',
              updatedAt: { $gte: last24Hours },
            })
            .exec(),
        0,
      ),
      safe(
        'replyJobs.failedLast24Hours',
        () =>
          this.replyJobs
            .countDocuments({
              status: 'FAILED',
              updatedAt: { $gte: last24Hours },
            })
            .exec(),
        0,
      ),
      safe(
        'humanSupport.waitingForAdmin',
        () => this.conversations.countDocuments({ status: 'OPEN', humanSupportStatus: 'WAITING_FOR_ADMIN', retentionDeleting: { $ne: true } }).exec(),
        0,
      ),
      safe(
        'humanSupport.assignedAwaitingReply',
        () => this.conversations.countDocuments({ status: 'OPEN', assignedAdminId: { $exists: true }, lastCustomerMessageAt: { $exists: true }, $expr: { $gt: ['$lastCustomerMessageAt', { $ifNull: ['$lastSupportReplyAt', new Date(0)] }] } }).exec(),
        0,
      ),
      safe(
        'supportNotifications.pending',
        () => this.jobs.countDocuments({ type: 'SUPPORT_NOTIFICATION', status: 'PENDING' }).exec(),
        0,
      ),
      safe(
        'supportNotifications.failed',
        () => this.jobs.countDocuments({ type: 'SUPPORT_NOTIFICATION', status: 'FAILED' }).exec(),
        0,
      ),
    ]);

    const errors = results.flatMap((result) =>
      result.error ? [result.error] : [],
    );
    const [
      latestIncidents,
      latestActions,
      latestBroadcasts,
      latestJobs,
      latestReplyJobs,
      systemHealth,
      latestRetentionRun,
    ] = await Promise.all([
      this.incidents
        .find({})
        .sort({ lastSeenAt: -1 })
        .limit(10)
        .lean()
        .exec()
        .catch(() => []),
      this.actions
        .find({})
        .sort({ createdAt: -1 })
        .limit(20)
        .lean()
        .exec()
        .catch(() => []),
      this.broadcasts
        .find({})
        .sort({ updatedAt: -1 })
        .limit(15)
        .lean()
        .exec()
        .catch(() => []),
      this.jobs
        .find({})
        .sort({ updatedAt: -1 })
        .limit(15)
        .select(
          'jobKey type dateKey sourceId status attempts scheduledAt completedAt lastError updatedAt',
        )
        .lean()
        .exec()
        .catch(() => []),
      this.replyJobs
        .find({})
        .sort({ scheduledAt: 1 })
        .limit(20)
        .select(
          'jobKey userId conversationId userMessageId status attempts scheduledAt completedAt lastError updatedAt leaseExpiresAt',
        )
        .lean()
        .exec()
        .catch(() => []),
      this.diagnostics.getSystemHealth(),
      this.actions
        .findOne({ actionName: 'chat_retention_cleanup' })
        .sort({ createdAt: -1 })
        .select('createdAt outcome summary details durationMs')
        .lean<{
          createdAt?: Date;
          outcome?: string;
          summary?: unknown;
          details?: unknown;
        }>()
        .exec()
        .catch(() => null),
    ]);

    const v = results.map((result) => result.value);
    // Old terminal failures stay visible as historical metrics but do not keep the
    // whole module degraded forever after they have been handled/resolved.
    const recentBroadcastFailures = v[22];
    const recentBroadcastJobFailures = v[23];
    const recentReplyFailures = v[24];
    const degraded =
      errors.length > 0 ||
      v[6] > 0 ||
      v[8] > 0 ||
      v[13] > 0 ||
      v[20] > 0 ||
      v[21] > 0 ||
      recentBroadcastFailures > 0 ||
      recentBroadcastJobFailures > 0 ||
      recentReplyFailures > 0 ||
      v[28] > 0 ||
      latestRetentionRun?.outcome === 'FAILED';
    const overview: Record<string, unknown> = {
      module: 'customer-care',
      checkedAt,
      status: degraded ? 'DEGRADED' : 'OK',
      metrics: {
        conversations: { total: v[0], open: v[1], createdLast24Hours: v[2] },
        messages: { createdLast24Hours: v[3] },
        actions: { executedLast24Hours: v[4], failedOrDeniedLast24Hours: v[5] },
        groq: { failedLast24Hours: v[6], succeededLast24Hours: v[7] },
        incidents: {
          open: v[8],
          criticalOpen: v[9],
          createdLast24Hours: v[10],
        },
        broadcasts: {
          sentLast24Hours: v[11],
          failedTotal: v[12],
          failedLast24Hours: recentBroadcastFailures,
          manualReviewRequired: v[13],
        },
        broadcastJobs: {
          pending: v[14],
          processing: v[15],
          failed: v[16],
          failedLast24Hours: recentBroadcastJobFailures,
        },
        replies: {
          pending: v[17],
          processing: v[18],
          failed: v[19],
          pendingOlderThanFiveMinutes: v[20],
          expiredLeases: v[21],
          failedLast24Hours: recentReplyFailures,
          workerConcurrency: 3,
          processingMode: 'durable-queue',
        },
        humanSupport: {
          waitingForAdmin: v[25],
          assignedAwaitingReply: v[26],
        },
        supportNotifications: {
          pending: v[27],
          failed: v[28],
        },
      },
      latestIncidents,
      latestActions,
      latestBroadcasts,
      latestJobs,
      latestReplyJobs,
      systemHealth,
      retention: {
        chatRetentionDays: 30,
        actionAuditRetentionDays: 180,
        terminalJobRetentionDays: 90,
        broadcastRetentionDays: 180,
        resolvedIncidentRetentionDays: 365,
        lastRunAt: latestRetentionRun?.createdAt ?? null,
        lastOutcome: latestRetentionRun?.outcome ?? 'NOT_RUN',
        lastSummary: latestRetentionRun?.summary ?? null,
        lastDetails: latestRetentionRun?.details ?? null,
      },
      errors,
    };
    this.cachedOverview = { expiresAt: Date.now() + 10_000, value: overview };
    return overview;
  }
}
