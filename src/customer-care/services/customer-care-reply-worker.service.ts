import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Interval } from '@nestjs/schedule';
import { ConnectionStates, Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { CustomerCareReplyJob } from '../schemas/customer-care-reply-job.schema';
import { SupportConversation } from '../schemas/support-conversation.schema';
import { CustomerCareService } from './customer-care.service';

const MAX_ATTEMPTS = 3;
const MAX_CONCURRENT_REPLIES = 3;
const LEASE_MS = 60_000;
const HEARTBEAT_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;
const MAINTENANCE_INTERVAL_MS = 30_000;

interface ReplyJobRecord {
  _id: Types.ObjectId;
  claimToken?: string;
  conversationId: Types.ObjectId;
  createdAt: Date;
  userId: Types.ObjectId;
  userMessageId: Types.ObjectId;
  jobKey: string;
  attempts: number;
  scheduledAt: Date;
}

/** Distributed, durable worker for potentially slow Groq support conversations. */
@Injectable()
export class CustomerCareReplyWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(CustomerCareReplyWorkerService.name);
  private readonly active = new Set<Promise<void>>();
  private ticking = false;
  private maintaining = false;
  private stopped = false;

  constructor(
    @InjectModel(CustomerCareReplyJob.name)
    private readonly jobs: Model<CustomerCareReplyJob>,
    @InjectModel(SupportConversation.name)
    private readonly conversations: Model<SupportConversation>,
    private readonly customerCare: CustomerCareService,
  ) {}

  onModuleDestroy(): void {
    this.stopped = true;
  }

  /** Poll the durable reply queue frequently; slow maintenance runs on a separate interval. */
  @Interval(POLL_INTERVAL_MS)
  async tick(): Promise<void> {
    if (
      this.stopped ||
      this.ticking ||
      this.jobs.db.readyState !== ConnectionStates.connected
    )
      return;
    this.ticking = true;
    try {
      while (!this.stopped && this.active.size < MAX_CONCURRENT_REPLIES) {
        const job = await this.claimOne();
        if (!job) break;
        const task = this.process(job);
        this.active.add(task);
        void task.then(
          () => this.active.delete(task),
          (error) => {
            this.active.delete(task);
            this.logger.error(
              `Unexpected reply-worker task rejection: ${safeError(error)}`,
            );
          },
        );
      }
    } catch (error) {
      this.logger.error(
        `Customer Care reply queue tick failed: ${safeError(error)}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  @Interval(MAINTENANCE_INTERVAL_MS)
  async maintenanceTick(): Promise<void> {
    if (
      this.stopped ||
      this.maintaining ||
      this.jobs.db.readyState !== ConnectionStates.connected
    ) {
      return;
    }

    this.maintaining = true;
    try {
      await this.failExpiredExhaustedJobs();
    } catch (error) {
      this.logger.error(
        `Customer Care reply maintenance failed: ${safeError(error)}`,
      );
    } finally {
      this.maintaining = false;
    }
  }

  private async claimOne(): Promise<ReplyJobRecord | null> {
    const now = new Date();
    const claimToken = randomUUID();
    return this.jobs
      .findOneAndUpdate(
        {
          attempts: { $lt: MAX_ATTEMPTS },
          $or: [
            { status: 'PENDING', scheduledAt: { $lte: now } },
            { status: 'PROCESSING', leaseExpiresAt: { $lte: now } },
          ],
        },
        {
          $set: {
            status: 'PROCESSING',
            claimToken,
            leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
            lastError: '',
          },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after', sort: { scheduledAt: 1, createdAt: 1 } },
      )
      .lean<ReplyJobRecord>()
      .exec();
  }

  private async process(job: ReplyJobRecord): Promise<void> {
    const jobId = job._id;
    const claimToken = String(job.claimToken ?? '');
    const conversationLockToken = randomUUID();
    let ownsConversationLock = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    try {
      // Keep replies for a conversation in order. ObjectId breaks same-millisecond
      // createdAt ties in a deterministic way for jobs created by this service.
      const olderUnfinished = await this.jobs
        .exists({
          conversationId: job.conversationId,
          _id: { $ne: jobId },
          status: { $in: ['PENDING', 'PROCESSING'] },
          $or: [
            { createdAt: { $lt: job.createdAt } },
            { createdAt: job.createdAt, _id: { $lt: jobId } },
          ],
        })
        .exec();
      if (olderUnfinished) {
        await this.deferWithoutPenalty(
          job,
          claimToken,
          'Waiting for an earlier message in this conversation.',
        );
        return;
      }

      const now = new Date();
      const conversationLock = await this.conversations
        .findOneAndUpdate(
          {
            _id: job.conversationId,
            retentionDeleting: { $ne: true },
            $or: [
              { replyProcessingLockExpiresAt: { $lte: now } },
              { replyProcessingLockExpiresAt: { $exists: false } },
            ],
          },
          {
            $set: {
              replyProcessingLockToken: conversationLockToken,
              replyProcessingLockExpiresAt: new Date(now.getTime() + LEASE_MS),
            },
          },
          { returnDocument: 'after' },
        )
        .lean()
        .exec();
      if (!conversationLock) {
        await this.deferWithoutPenalty(
          job,
          claimToken,
          'Another reply is already processing for this conversation, or the conversation is unavailable.',
        );
        return;
      }
      ownsConversationLock = true;

      let heartbeatInFlight = false;
      heartbeat = setInterval(() => {
        // Never allow slow MongoDB writes to stack up on overlapping heartbeats.
        if (heartbeatInFlight) return;
        heartbeatInFlight = true;

        void Promise.allSettled([
          this.conversations
            .updateOne(
              {
                _id: job.conversationId,
                replyProcessingLockToken: conversationLockToken,
              },
              {
                $set: {
                  replyProcessingLockExpiresAt: new Date(Date.now() + LEASE_MS),
                },
              },
            )
            .exec(),
          this.jobs
            .updateOne(
              { _id: jobId, status: 'PROCESSING', claimToken },
              { $set: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } },
            )
            .exec(),
        ])
          .then((results) => {
            const [conversationResult, jobResult] = results;
            for (const result of results) {
              if (result.status === 'rejected') {
                this.logger.warn(
                  `Could not renew reply processing leases for ${String(job.jobKey)}: ${safeError(result.reason)}`,
                );
              }
            }
            if (
              (conversationResult.status === 'fulfilled' &&
                conversationResult.value.matchedCount === 0) ||
              (jobResult.status === 'fulfilled' &&
                jobResult.value.matchedCount === 0)
            ) {
              this.logger.warn(
                `Reply worker lost a lease while processing ${String(job.jobKey)}.`,
              );
            }
          })
          .finally(() => {
            heartbeatInFlight = false;
          });
      }, HEARTBEAT_MS);

      await this.customerCare.processQueuedMessage(
        String(job.userId),
        String(job.conversationId),
        String(job.userMessageId),
      );
      const completed = await this.jobs
        .updateOne(
          { _id: jobId, status: 'PROCESSING', claimToken },
          {
            $set: {
              status: 'COMPLETED',
              completedAt: new Date(),
              lastError: '',
            },
            $unset: { leaseExpiresAt: 1, claimToken: 1 },
          },
        )
        .exec();
      if (completed.modifiedCount === 0) {
        this.logger.warn(
          `Reply job ${String(job.jobKey)} completed its handler but no longer owns the queue claim.`,
        );
      }
    } catch (error) {
      // Stop heartbeats before recording a retry. If MongoDB is temporarily unable
      // to persist the retry, the lease can expire and another worker can recover it.
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      await this.recordFailure(job, claimToken, error);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (ownsConversationLock) {
        await this.conversations
          .updateOne(
            {
              _id: job.conversationId,
              replyProcessingLockToken: conversationLockToken,
            },
            {
              $unset: {
                replyProcessingLockToken: 1,
                replyProcessingLockExpiresAt: 1,
              },
            },
          )
          .exec()
          .catch((error) =>
            this.logger.warn(
              `Could not release conversation reply lock: ${safeError(error)}`,
            ),
          );
      }
    }
  }

  private async recordFailure(
    job: ReplyJobRecord,
    claimToken: string,
    error: unknown,
  ): Promise<void> {
    const message = safeError(error);
    const attempts = Number(job.attempts || 1);
    const canRetry = attempts < MAX_ATTEMPTS;
    const backoffMs = Math.min(60_000, 5_000 * 2 ** Math.max(0, attempts - 1));

    if (!canRetry) {
      // Persist the fallback before terminally completing the queue job. If this
      // write fails, leave the lease immediately recoverable so the next tick can
      // retry fallback finalization instead of stranding a user message forever.
      try {
        await this.customerCare.finalizeQueuedMessageFailure(
          String(job.userId),
          String(job.conversationId),
          String(job.userMessageId),
          message,
        );
      } catch (finalizeError) {
        const finalizeMessage = safeError(finalizeError);
        this.logger.error(
          `Could not persist final fallback for ${String(job.jobKey)}: ${finalizeMessage}`,
        );
        await this.jobs
          .updateOne(
            { _id: job._id, status: 'PROCESSING', claimToken },
            {
              $set: {
                leaseExpiresAt: new Date(),
                lastError:
                  `Fallback finalization pending: ${finalizeMessage}`.slice(
                    0,
                    1200,
                  ),
              },
            },
          )
          .exec()
          .catch((updateError) =>
            this.logger.error(
              `Could not make failed reply job recoverable: ${safeError(updateError)}`,
            ),
          );
        return;
      }
    }

    try {
      const update = await this.jobs
        .updateOne(
          { _id: job._id, status: 'PROCESSING', claimToken },
          {
            $set: {
              status: canRetry ? 'PENDING' : 'FAILED',
              scheduledAt: canRetry
                ? new Date(Date.now() + backoffMs)
                : job.scheduledAt,
              lastError: message.slice(0, 1200),
              ...(!canRetry ? { completedAt: new Date() } : {}),
            },
            $unset: {
              leaseExpiresAt: 1,
              claimToken: 1,
              ...(canRetry ? { completedAt: 1 } : {}),
            },
          },
        )
        .exec();
      if (update.modifiedCount === 0) {
        this.logger.warn(
          `Reply job ${String(job.jobKey)} lost its claim before recording the failure.`,
        );
        return;
      }
    } catch (updateError) {
      this.logger.error(
        `Could not persist retry state for ${String(job.jobKey)}: ${safeError(updateError)}. Lease recovery will be attempted.`,
      );
      return;
    }

    if (canRetry) {
      this.logger.warn(
        `Reply job ${String(job.jobKey)} failed on attempt ${attempts}; retry scheduled: ${message}`,
      );
    } else {
      this.logger.error(
        `Reply job ${String(job.jobKey)} exhausted retries: ${message}`,
      );
    }
  }

  private async deferWithoutPenalty(
    job: ReplyJobRecord,
    claimToken: string,
    reason: string,
  ): Promise<void> {
    await this.jobs
      .updateOne(
        { _id: job._id, status: 'PROCESSING', claimToken },
        {
          $set: {
            status: 'PENDING',
            scheduledAt: new Date(Date.now() + 5000),
            lastError: reason,
          },
          $inc: { attempts: -1 },
          $unset: { leaseExpiresAt: 1, claimToken: 1 },
        },
      )
      .exec();
  }

  private async failExpiredExhaustedJobs(): Promise<void> {
    const now = new Date();
    const stale = await this.jobs
      .find({
        status: 'PROCESSING',
        attempts: { $gte: MAX_ATTEMPTS },
        leaseExpiresAt: { $lte: now },
      })
      .limit(20)
      .lean<ReplyJobRecord[]>()
      .exec();
    for (const job of stale) {
      try {
        await this.customerCare.finalizeQueuedMessageFailure(
          String(job.userId),
          String(job.conversationId),
          String(job.userMessageId),
          'Reply worker lease expired after the maximum number of attempts.',
        );
      } catch (error) {
        this.logger.error(
          `Could not finalize expired reply job ${String(job.jobKey)}: ${safeError(error)}`,
        );
        continue;
      }
      await this.jobs
        .updateOne(
          {
            _id: job._id,
            status: 'PROCESSING',
            attempts: { $gte: MAX_ATTEMPTS },
            leaseExpiresAt: { $lte: now },
          },
          {
            $set: {
              status: 'FAILED',
              completedAt: new Date(),
              lastError:
                'Reply worker lease expired after the maximum number of attempts.',
            },
            $unset: { leaseExpiresAt: 1, claimToken: 1 },
          },
        )
        .exec()
        .catch((error) =>
          this.logger.error(
            `Could not close expired reply job ${String(job.jobKey)}: ${safeError(error)}`,
          ),
        );
    }
  }
}

function safeError(error: unknown): string {
  return Array.from(error instanceof Error ? error.message : String(error))
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .join('')
    .slice(0, 1000);
}
