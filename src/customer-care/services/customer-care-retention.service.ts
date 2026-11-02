import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { SupportConversation } from '../schemas/support-conversation.schema';
import { SupportMessage } from '../schemas/support-message.schema';
import { SupportActionAudit } from '../schemas/support-action-audit.schema';
import { SupportIncident } from '../schemas/support-incident.schema';
import { CustomerCareJob } from '../schemas/customer-care-job.schema';
import { CustomerCareBroadcast } from '../schemas/customer-care-broadcast.schema';
import { CustomerCareReplyJob } from '../schemas/customer-care-reply-job.schema';
import { SupportRateLimit } from '../schemas/support-rate-limit.schema';

const CHAT_RETENTION_DAYS = 30;
const ACTION_AUDIT_RETENTION_DAYS = 180;
const TERMINAL_JOB_RETENTION_DAYS = 90;
const BROADCAST_RETENTION_DAYS = 180;
const RESOLVED_INCIDENT_RETENTION_DAYS = 365;
const CHAT_BATCH_SIZE = 250;
const MAX_CHAT_BATCHES_PER_RUN = 20;
const OPERATIONAL_BATCH_SIZE = 1000;
const STALE_LOCK_RECOVERY_MS = 5 * 60 * 1000;

type CleanupTrigger = 'startup' | 'daily-cron' | 'periodic-retry';

/**
 * Deletes 30-day inactive chat transcripts and separately retains operational
 * records for longer windows. Every purge is bounded; open incidents and pending
 * jobs are never removed by operational retention.
 */
@Injectable()
export class CustomerCareRetentionService implements OnModuleInit {
  private readonly logger = new Logger(CustomerCareRetentionService.name);
  private running = false;

  constructor(
    @InjectModel(SupportConversation.name) private readonly conversations: Model<SupportConversation>,
    @InjectModel(SupportMessage.name) private readonly messages: Model<SupportMessage>,
    @InjectModel(SupportActionAudit.name) private readonly actions: Model<SupportActionAudit>,
    @InjectModel(SupportIncident.name) private readonly incidents: Model<SupportIncident>,
    @InjectModel(CustomerCareJob.name) private readonly jobs: Model<CustomerCareJob>,
    @InjectModel(CustomerCareBroadcast.name) private readonly broadcasts: Model<CustomerCareBroadcast>,
    @InjectModel(CustomerCareReplyJob.name) private readonly replyJobs: Model<CustomerCareReplyJob>,
    @InjectModel(SupportRateLimit.name) private readonly rateLimits: Model<SupportRateLimit>,
  ) {}

  onModuleInit(): void {
    void this.runCleanup('startup');
  }

  @Cron('17 3 * * *', { timeZone: 'Africa/Lagos' })
  async runDailyCleanup(): Promise<void> {
    await this.runCleanup('daily-cron');
  }

  @Interval(6 * 60 * 60 * 1000)
  async runPeriodicRetry(): Promise<void> {
    await this.runCleanup('periodic-retry');
  }

  async runCleanup(trigger: CleanupTrigger = 'daily-cron'): Promise<void> {
    if (this.running || this.conversations.db.readyState !== 1) return;
    this.running = true;
    const startedAt = Date.now();
    const now = new Date();
    const chatCutoff = daysAgo(now, CHAT_RETENTION_DAYS);
    const recoverBefore = new Date(now.getTime() - STALE_LOCK_RECOVERY_MS);
    let chatBatches = 0;
    let conversationsDeleted = 0;
    let messagesDeleted = 0;
    let replyJobsDeletedWithChats = 0;
    let chatBacklogLikely = false;
    const conversationsWithActiveReplies = new Set<string>();
    const operationalPurged: Record<string, number> = {};

    try {
      while (chatBatches < MAX_CHAT_BATCHES_PER_RUN) {
        const lockableFilter = {
          $and: [
            {
              $or: [
                { retentionDeleting: true, retentionDeletionStartedAt: { $lte: recoverBefore } },
                {
                  retentionDeleting: { $ne: true },
                  $or: [
                    { lastMessageAt: { $lt: chatCutoff } },
                    { lastMessageAt: { $exists: false }, createdAt: { $lt: chatCutoff } },
                    { lastMessageAt: null, createdAt: { $lt: chatCutoff } },
                  ],
                },
              ],
            },
            // Never start transcript deletion while the async reply worker holds
            // the conversation lock, even if the latest message status just flipped.
            {
              $or: [
                { replyProcessingLockExpiresAt: { $lte: now } },
                { replyProcessingLockExpiresAt: { $exists: false } },
              ],
            },
          ],
        };
        const candidateFilter = {
          $and: [
            lockableFilter,
            ...(conversationsWithActiveReplies.size ? [{ _id: { $nin: [...conversationsWithActiveReplies].map((id) => new Types.ObjectId(id)) } }] : []),
          ],
        };
        const candidates = await this.conversations.find(candidateFilter)
          .select('_id').sort({ lastMessageAt: 1, createdAt: 1 })
          .limit(CHAT_BATCH_SIZE).maxTimeMS(5000).lean().exec();
        if (!candidates.length) break;

        const ids = candidates.map((item: any) => item._id as Types.ObjectId);
        const activeReplyConversations = await this.messages.distinct('conversationId', {
          conversationId: { $in: ids }, role: 'USER', replyStatus: { $in: ['QUEUED', 'PROCESSING'] },
        }).exec();
        for (const activeId of activeReplyConversations) conversationsWithActiveReplies.add(String(activeId));
        if (activeReplyConversations.length) {
          // If an old process crashed after taking a retention lock, release only
          // that stale lock and refresh activity so the queued reply can recover.
          await this.conversations.updateMany(
            { _id: { $in: activeReplyConversations }, retentionDeleting: true, retentionDeletionStartedAt: { $lte: recoverBefore } },
            { $set: { retentionDeleting: false, lastMessageAt: new Date() }, $unset: { retentionLockToken: 1, retentionDeletionStartedAt: 1 } },
          ).exec();
          // If no cleanup lock is held, keep queued/processing conversations out of
          // the inactive-candidate set even if their activity timestamp was stale.
          await this.conversations.updateMany(
            { _id: { $in: activeReplyConversations }, retentionDeleting: { $ne: true } },
            { $set: { lastMessageAt: new Date() } },
          ).exec();
        }
        const activeKeys = new Set(activeReplyConversations.map((id: any) => String(id)));
        const deletableIds = ids.filter((id) => !activeKeys.has(String(id)));
        if (!deletableIds.length) {
          chatBacklogLikely = true;
          chatBatches += 1;
          continue;
        }
        const lockToken = randomUUID();
        await this.conversations.updateMany(
          { $and: [{ _id: { $in: deletableIds } }, lockableFilter] },
          { $set: { retentionDeleting: true, retentionLockToken: lockToken, retentionDeletionStartedAt: new Date() } },
        ).exec();
        const locked = await this.conversations.find({ _id: { $in: deletableIds }, retentionLockToken: lockToken })
          .select('_id').lean().exec();
        if (!locked.length) { chatBatches += 1; continue; }

        const lockedIds = locked.map((item: any) => item._id as Types.ObjectId);
        const replyJobResult = await this.replyJobs.deleteMany({ conversationId: { $in: lockedIds } }).exec();
        replyJobsDeletedWithChats += Number(replyJobResult.deletedCount || 0);
        const messageResult = await this.messages.deleteMany({ conversationId: { $in: lockedIds } }).exec();
        messagesDeleted += Number(messageResult.deletedCount || 0);
        const conversationResult = await this.conversations.deleteMany({ _id: { $in: lockedIds }, retentionLockToken: lockToken }).exec();
        conversationsDeleted += Number(conversationResult.deletedCount || 0);
        chatBatches += 1;
        chatBacklogLikely = candidates.length === CHAT_BATCH_SIZE;
        if (candidates.length < CHAT_BATCH_SIZE) break;
      }

      // Remove only bounded terminal/expired operational records. Open incidents,
      // broadcasts flagged for manual delivery review, and pending/processing jobs survive.
      operationalPurged.expiredRateLimits = await this.purgeByIds(
        this.rateLimits,
        { expiresAt: { $lte: now } },
      );
      operationalPurged.replyJobs = await this.purgeByIds(
        this.replyJobs,
        { status: { $in: ['COMPLETED', 'FAILED'] }, updatedAt: { $lt: daysAgo(now, TERMINAL_JOB_RETENTION_DAYS) } },
      );
      operationalPurged.broadcastJobs = await this.purgeByIds(
        this.jobs,
        { status: { $in: ['COMPLETED', 'FAILED'] }, updatedAt: { $lt: daysAgo(now, TERMINAL_JOB_RETENTION_DAYS) } },
      );
      operationalPurged.broadcasts = await this.purgeByIds(
        this.broadcasts,
        { status: { $in: ['SENT', 'SKIPPED', 'FAILED'] }, manualReviewRequired: { $ne: true }, updatedAt: { $lt: daysAgo(now, BROADCAST_RETENTION_DAYS) } },
      );
      operationalPurged.resolvedIncidents = await this.purgeByIds(
        this.incidents,
        { status: { $in: ['RESOLVED', 'CLOSED'] }, resolvedAt: { $lt: daysAgo(now, RESOLVED_INCIDENT_RETENTION_DAYS) } },
      );
      operationalPurged.actionAudits = await this.purgeByIds(
        this.actions,
        { createdAt: { $lt: daysAgo(now, ACTION_AUDIT_RETENTION_DAYS) }, },
      );

      await this.writeAudit('SUCCEEDED', {
        trigger,
        policyDays: {
          inactiveChats: CHAT_RETENTION_DAYS,
          actionAudits: ACTION_AUDIT_RETENTION_DAYS,
          terminalJobs: TERMINAL_JOB_RETENTION_DAYS,
          broadcasts: BROADCAST_RETENTION_DAYS,
          resolvedIncidents: RESOLVED_INCIDENT_RETENTION_DAYS,
        },
        chatCutoff: chatCutoff.toISOString(),
        chatBatches,
        conversationsDeleted,
        messagesDeleted,
        replyJobsDeletedWithChats,
        chatBacklogLikely: chatBacklogLikely && chatBatches >= MAX_CHAT_BATCHES_PER_RUN,
        deletionDeferredForActiveReplies: conversationsWithActiveReplies.size > 0,
        conversationsWithQueuedRepliesDeferred: conversationsWithActiveReplies.size,
        operationalPurged,
      }, startedAt).catch((error) => this.logger.warn(`Retention completed but its audit failed: ${safeError(error)}`));

      this.logger.log(`Customer Care retention completed (${trigger}): chats=${conversationsDeleted}, messages=${messagesDeleted}, operational=${JSON.stringify(operationalPurged)}.`);
      if (chatBacklogLikely && chatBatches >= MAX_CHAT_BATCHES_PER_RUN) {
        this.logger.warn('Chat retention reached its per-run cap; remaining expired conversations will be processed by the next run.');
      }
    } catch (error) {
      const message = safeError(error);
      this.logger.error(`Customer Care retention failed (${trigger}): ${message}`);
      await this.writeAudit('FAILED', {
        trigger, chatCutoff: chatCutoff.toISOString(), chatBatches,
        conversationsDeleted, messagesDeleted, replyJobsDeletedWithChats, operationalPurged, error: message,
      }, startedAt).catch((auditError) => this.logger.warn(`Could not persist retention failure audit: ${safeError(auditError)}`));
    } finally {
      this.running = false;
    }
  }

  private async purgeByIds<T>(model: Model<T>, filter: Record<string, unknown>): Promise<number> {
    const candidates = await model.find(filter as any).select('_id').limit(OPERATIONAL_BATCH_SIZE).maxTimeMS(3000).lean().exec();
    if (!candidates.length) return 0;
    const ids = candidates.map((item: any) => item._id);
    const result = await model.deleteMany({ _id: { $in: ids }, ...filter } as any).exec();
    return Number(result.deletedCount || 0);
  }

  private async writeAudit(outcome: 'SUCCEEDED' | 'FAILED', details: Record<string, unknown>, startedAt: number): Promise<void> {
    await this.actions.create({
      actorRole: 'SYSTEM', actionName: 'chat_retention_cleanup', actionType: 'DIAGNOSTIC', outcome,
      summary: outcome === 'SUCCEEDED'
        ? 'Customer Care retention run completed.'
        : 'Customer Care retention run failed.',
      details, durationMs: Math.max(0, Date.now() - startedAt),
    });
  }
}

function daysAgo(value: Date, days: number): Date {
  return new Date(value.getTime() - days * 24 * 60 * 60 * 1000);
}
function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 800);
}
