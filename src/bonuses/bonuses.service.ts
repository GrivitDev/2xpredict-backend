import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash } from 'node:crypto';
import { UsersService } from '../users/users.service';
import { BetLabWalletService } from '../bet-lab/services/bet-lab-wallet.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { BonusGrant, BonusGrantDocument } from './schemas/bonus-grant.schema';
import { BonusStatus } from './enums/bonus-status.enum';
import { BonusType } from './enums/bonus-type.enum';
import { GrantPointsBonusDto } from './dto/grant-points-bonus.dto';
import { GrantSubscriptionBonusDto } from './dto/grant-subscription-bonus.dto';
import { BulkGrantPointsBonusDto } from './dto/bulk-grant-points-bonus.dto';
import { BulkGrantSubscriptionBonusDto } from './dto/bulk-grant-subscription-bonus.dto';
import { BonusBulkGrantJob } from './schemas/bonus-bulk-grant-job.schema';
import { BonusBulkJobStatus } from './enums/bonus-bulk-job-status.enum';
import { NotificationEventsService } from '../notifications/in-app/notification-events.service';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class BonusesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BonusesService.name);
  private bulkWorkerRunning = false;
  private bulkWorkerTimer?: NodeJS.Timeout;

  constructor(
    @InjectModel(BonusGrant.name)
    private readonly bonusModel: Model<BonusGrant>,
    @InjectModel(BonusBulkGrantJob.name)
    private readonly bulkJobModel: Model<BonusBulkGrantJob>,
    private readonly usersService: UsersService,
    private readonly walletService: BetLabWalletService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly notificationEvents: NotificationEventsService,
  ) {}

  async grantPoints(dto: GrantPointsBonusDto, adminId: string) {
    await this.assertUserExists(dto.userId);
    let grant = await this.findOrCreateGrant({
      userId: dto.userId,
      grantedBy: adminId,
      type: BonusType.BET_LAB_POINTS,
      status: BonusStatus.PENDING,
      reason: dto.reason.trim(),
      points: dto.points,
      startsAt: new Date(),
      idempotencyKey: dto.idempotencyKey.trim(),
    });
    this.assertSameRequest(grant, {
      userId: dto.userId,
      type: BonusType.BET_LAB_POINTS,
      reason: dto.reason.trim(),
      points: dto.points,
    });

    if (grant.status === BonusStatus.REVOKED) {
      throw new ConflictException('This bonus grant has already been revoked. Use a new idempotency key for a new grant.');
    }
    if (grant.status !== BonusStatus.GRANTED) {
      await this.walletService.grantAdminBonusPoints(
        grant.userId,
        Number(grant.points),
        grant.reason,
        String(grant._id),
      );
      grant.status = BonusStatus.GRANTED;
      await grant.save();
    }
    if (grant.status === BonusStatus.GRANTED) {
      // Stable event keys make this safe on retries and repair a crash between
      // persisting the grant and enqueueing its notification.
      await this.notificationEvents.bonusGranted({
        userId: grant.userId,
        grantId: String(grant._id),
        kind: 'points',
        points: Number(grant.points),
        reason: grant.reason,
      });
    }
    return this.present(grant);
  }

  async grantSubscription(dto: GrantSubscriptionBonusDto, adminId: string) {
    await this.assertUserExists(dto.userId);
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : new Date();
    if (!Number.isFinite(startsAt.getTime())) {
      throw new BadRequestException('Invalid subscription bonus start date.');
    }
    const expiresAt = new Date(startsAt.getTime() + dto.durationDays * DAY_MS);
    let grant = await this.findOrCreateGrant({
      userId: dto.userId,
      grantedBy: adminId,
      type: BonusType.SUBSCRIPTION,
      status: BonusStatus.PENDING,
      reason: dto.reason.trim(),
      plan: dto.plan,
      durationDays: dto.durationDays,
      startsAt,
      expiresAt,
      idempotencyKey: dto.idempotencyKey.trim(),
    });
    this.assertSameRequest(grant, {
      userId: dto.userId,
      type: BonusType.SUBSCRIPTION,
      reason: dto.reason.trim(),
      plan: dto.plan,
      durationDays: dto.durationDays,
      ...(dto.startsAt ? { startsAt } : {}),
    });

    if (grant.status === BonusStatus.REVOKED) {
      throw new ConflictException('This bonus grant has already been revoked. Use a new idempotency key for a new grant.');
    }
    if (grant.status !== BonusStatus.GRANTED) {
      grant.status = BonusStatus.GRANTED;
      await grant.save();
    }
    if (grant.status === BonusStatus.GRANTED) {
      // Stable event keys make this safe on retries and repair a crash between
      // persisting the grant and enqueueing its notification.
      await this.notificationEvents.bonusGranted({
        userId: grant.userId,
        grantId: String(grant._id),
        kind: 'subscription',
        plan: grant.plan,
        durationDays: grant.durationDays,
        reason: grant.reason,
      });
      if (grant.expiresAt) {
        await this.notificationEvents.bonusExpiryScheduled({
          userId: grant.userId,
          grantId: String(grant._id),
          plan: String(grant.plan ?? 'subscription'),
          expiresAt: grant.expiresAt,
        });
      }
    }
    return this.present(grant);
  }

  onModuleInit() {
    // Resume durable jobs left queued/running after a server restart. No polling
    // runs while the queue is empty, so this does not add idle database load.
    this.scheduleBulkWorker(1000);
  }

  onModuleDestroy() {
    if (this.bulkWorkerTimer) clearTimeout(this.bulkWorkerTimer);
  }

  async grantPointsToAll(dto: BulkGrantPointsBonusDto, adminId: string) {
    return this.createBulkGrantJob({
      type: BonusType.BET_LAB_POINTS,
      grantedBy: adminId,
      reason: dto.reason.trim(),
      points: dto.points,
      idempotencyKey: dto.idempotencyKey.trim(),
      recipientIds: dto.userIds,
      recipientPlan: dto.recipientPlan,
    });
  }

  async grantSubscriptionToAll(dto: BulkGrantSubscriptionBonusDto, adminId: string) {
    const explicitStart = dto.startsAt ? new Date(dto.startsAt) : undefined;
    if (explicitStart && !Number.isFinite(explicitStart.getTime())) {
      throw new BadRequestException('Invalid subscription bonus start date.');
    }
    const baseStart = explicitStart ?? new Date();
    return this.createBulkGrantJob({
      type: BonusType.SUBSCRIPTION,
      grantedBy: adminId,
      reason: dto.reason.trim(),
      plan: dto.plan,
      durationDays: dto.durationDays,
      startsAt: baseStart,
      scheduledStart: Boolean(explicitStart),
      ...(explicitStart ? { expiresAt: new Date(explicitStart.getTime() + dto.durationDays * DAY_MS) } : {}),
      idempotencyKey: dto.idempotencyKey.trim(),
      recipientIds: dto.userIds,
      recipientPlan: dto.recipientPlan,
      ...(explicitStart ? { requestedStartAt: explicitStart } : {}),
    });
  }

  async getAdminBonusRecipients(query: { page?: number; limit?: number; search?: string } = {}) {
    const page = this.safePage(query.page);
    const limit = Math.min(100, this.safeLimit(query.limit));
    const search = String(query.search ?? '').trim();
    const result = await (this.usersService as any).findAll({
      page,
      limit,
      ...(search ? { search } : {}),
    });
    const users = Array.isArray(result?.users) ? result.users : Array.isArray(result?.items) ? result.items : [];
    const enriched = await Promise.all(users.map(async (user: any) => {
      const userId = String(user?._id ?? user?.id ?? '');
      let plan = 'free';
      try {
        // getUserPlan() returns the canonical PlanType string. Keep this
        // consumer aligned with that contract instead of supporting the old
        // object-shaped response that the service no longer returns.
        plan = await this.subscriptionsService.getUserPlan(userId);
      } catch {
        plan = 'free';
      }
      return {
        id: userId,
        username: user?.username ?? '',
        fullName: user?.fullName ?? '',
        email: user?.email ?? '',
        plan,
        status: user?.status ?? '',
      };
    }));
    return {
      items: enriched,
      page,
      limit,
      total: Number(result?.total ?? result?.count ?? enriched.length),
      pages: Number(result?.totalPages ?? Math.ceil(Number(result?.total ?? enriched.length) / limit)),
    };
  }

  async getBulkGrantJobs(limit = 20) {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
    const items = await this.bulkJobModel.find({})
      .sort({ createdAt: -1 })
      .limit(safeLimit)
      .lean()
      .exec();
    return items.map((item) => this.presentBulkJob(item));
  }

  async getBulkGrantJob(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid bulk job ID.');
    const job = await this.bulkJobModel.findById(id).lean().exec();
    if (!job) throw new NotFoundException('Bulk bonus job not found.');
    return this.presentBulkJob(job);
  }

  private async createBulkGrantJob(data: {
    type: BonusType;
    grantedBy: string;
    reason: string;
    idempotencyKey: string;
    points?: number;
    plan?: 'regular' | 'vip' | 'premium';
    durationDays?: number;
    startsAt?: Date;
    scheduledStart?: boolean;
    expiresAt?: Date;
    requestedStartAt?: Date;
    recipientIds?: string[];
    recipientPlan?: 'free' | 'regular' | 'vip' | 'premium';
  }) {
    const idempotencyKey = data.idempotencyKey.trim();
    const expected = {
      type: data.type,
      grantedBy: data.grantedBy,
      reason: data.reason,
      points: data.points,
      plan: data.plan,
      durationDays: data.durationDays,
      requestedStartAt: data.requestedStartAt,
      recipientIds: data.recipientIds?.length ? [...new Set(data.recipientIds)].sort() : undefined,
      recipientPlan: data.recipientPlan,
    };
    const existing = await this.bulkJobModel.findOne({ idempotencyKey }).exec();
    if (existing) {
      this.assertSameBulkRequest(existing, expected);
      return this.presentBulkJob(existing);
    }

    const [eligibleUsers, throughUserId] = await Promise.all([
      this.usersService.countBonusRecipients(),
      this.usersService.getLastBonusRecipientId(),
    ]);
    const recipientIds = data.recipientIds?.length ? [...new Set(data.recipientIds)] : undefined;
    const totalUsers = recipientIds ? recipientIds.length : eligibleUsers;
    const now = new Date();
    try {
      const job = await this.bulkJobModel.create({
        type: data.type,
        status: totalUsers > 0 ? BonusBulkJobStatus.QUEUED : BonusBulkJobStatus.COMPLETED,
        grantedBy: data.grantedBy,
        reason: data.reason,
        points: data.points,
        plan: data.plan,
        durationDays: data.durationDays,
        startsAt: data.startsAt ?? now,
        scheduledStart: data.scheduledStart ?? false,
        expiresAt: data.expiresAt ?? null,
        idempotencyKey,
        throughUserId: recipientIds ? null : throughUserId,
        lastUserId: null,
        recipientIds: recipientIds ?? [],
        recipientPlan: data.recipientPlan ?? null,
        recipientCursor: 0,
        totalUsers,
        processedUsers: 0,
        grantedCount: 0,
        failedCount: 0,
        recentErrors: [],
        completedAt: totalUsers > 0 ? null : now,
      });
      if (totalUsers > 0) this.scheduleBulkWorker(0);
      return this.presentBulkJob(job);
    } catch (error) {
      if (this.isDuplicateKey(error)) {
        const raced = await this.bulkJobModel.findOne({ idempotencyKey }).exec();
        if (raced) {
          this.assertSameBulkRequest(raced, expected);
          return this.presentBulkJob(raced);
        }
      }
      throw error;
    }
  }

  private assertSameBulkRequest(
    job: BonusBulkGrantJob,
    expected: {
      type: BonusType;
      grantedBy: string;
      reason: string;
      points?: number;
      plan?: string;
      durationDays?: number;
      requestedStartAt?: Date;
      recipientIds?: string[];
      recipientPlan?: string;
    },
  ) {
    const existingIds = Array.isArray((job as any).recipientIds) ? [...(job as any).recipientIds].sort() : [];
    const expectedIds = expected.recipientIds ?? [];
    const sameRecipients = existingIds.length === expectedIds.length && existingIds.every((id: string, i: number) => id === expectedIds[i]);
    const same = job.type === expected.type &&
      job.grantedBy === expected.grantedBy &&
      job.reason === expected.reason &&
      job.points === expected.points &&
      job.plan === expected.plan &&
      job.durationDays === expected.durationDays &&
      (expected.recipientPlan === undefined || (job as any).recipientPlan === expected.recipientPlan) &&
      sameRecipients &&
      (expected.requestedStartAt === undefined || job.startsAt.getTime() === expected.requestedStartAt.getTime());
    if (!same) throw new ConflictException('This idempotency key is already in use for a different bulk bonus request.');
  }

  private scheduleBulkWorker(delayMs: number) {
    if (this.bulkWorkerTimer) return;
    this.bulkWorkerTimer = setTimeout(() => {
      this.bulkWorkerTimer = undefined;
      void this.processNextBulkBatch();
    }, delayMs);
    this.bulkWorkerTimer.unref?.();
  }

  private async processNextBulkBatch() {
    if (this.bulkWorkerRunning) return;
    this.bulkWorkerRunning = true;
    let nextDelay: number | null = null;
    try {
      const job = await this.bulkJobModel.findOne({
        status: { $in: [BonusBulkJobStatus.QUEUED, BonusBulkJobStatus.PROCESSING] },
      }).sort({ createdAt: 1 }).exec();
      if (!job) return;

      if (job.status === BonusBulkJobStatus.QUEUED) {
        job.status = BonusBulkJobStatus.PROCESSING;
        job.startedAt = new Date();
        await job.save();
      }

      const selectedIds: string[] = Array.isArray((job as any).recipientIds) ? (job as any).recipientIds : [];
      let userIds: string[];
      if (selectedIds.length) {
        const cursor = Number((job as any).recipientCursor ?? 0);
        userIds = selectedIds.slice(cursor, cursor + 25);
      } else {
        userIds = await this.usersService.getBonusRecipientIds(job.lastUserId, job.throughUserId, 25);
      }

      if (!userIds.length) {
        job.status = BonusBulkJobStatus.COMPLETED;
        job.completedAt = new Date();
        await job.save();
        nextDelay = 0;
        return;
      }

      const operationHash = createHash('sha256').update(job.idempotencyKey).digest('hex').slice(0, 32);
      for (const userId of userIds) {
        try {
          const recipientPlan = (job as any).recipientPlan as string | null | undefined;
          if (recipientPlan) {
            const currentPlan = String(await this.subscriptionsService.getUserPlan(userId) ?? 'free').toLowerCase();
            if (currentPlan !== recipientPlan) {
              job.lastUserId = userId;
              job.processedUsers += 1;
              if (selectedIds.length) (job as any).recipientCursor = Number((job as any).recipientCursor ?? 0) + 1;
              await job.save();
              continue;
            }
          }
          const perUserKey = `bulk:${operationHash}:${userId}`;
          if (job.type === BonusType.BET_LAB_POINTS) {
            await this.grantPoints({
              userId,
              points: Number(job.points),
              reason: job.reason,
              idempotencyKey: perUserKey,
            }, job.grantedBy);
          } else {
            await this.grantSubscription({
              userId,
              plan: job.plan as 'regular' | 'vip' | 'premium',
              durationDays: Number(job.durationDays),
              reason: job.reason,
              idempotencyKey: perUserKey,
              ...(job.scheduledStart ? { startsAt: job.startsAt.toISOString() } : {}),
            }, job.grantedBy);
          }
          job.grantedCount += 1;
        } catch (error) {
          job.failedCount += 1;
          const message = error instanceof Error ? error.message : String(error);
          job.recentErrors = [...job.recentErrors, `${userId}: ${message}`.slice(0, 350)].slice(-10);
          this.logger.error(`Bulk bonus ${String(job._id)} failed for recipient ${userId}: ${message}`);
        }
        // Persist the cursor alongside counters. If a process crashes between
        // a wallet credit and this save, the per-user idempotency key prevents
        // a duplicate credit when the same recipient is retried after restart.
        job.lastUserId = userId;
        job.processedUsers += 1;
        if (selectedIds.length) (job as any).recipientCursor = Number((job as any).recipientCursor ?? 0) + 1;
        await job.save();
      }
      nextDelay = 100;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Bulk bonus worker batch failed: ${message}`);
      nextDelay = 5000;
    } finally {
      this.bulkWorkerRunning = false;
      if (nextDelay !== null) this.scheduleBulkWorker(nextDelay);
    }
  }

  private presentBulkJob(value: unknown) {
    const job = value && typeof value === 'object' && 'toObject' in value && typeof (value as { toObject?: unknown }).toObject === 'function'
      ? (value as { toObject: () => Record<string, unknown> }).toObject()
      : { ...(value as Record<string, unknown>) };
    delete job.idempotencyKey;
    delete job.recipientIds;
    delete job.recipientCursor;
    const totalUsers = Number(job.totalUsers ?? 0);
    const processedUsers = Number(job.processedUsers ?? 0);
    return {
      ...job,
      progressPercent: job.status === BonusBulkJobStatus.COMPLETED
        ? 100
        : totalUsers > 0 ? Math.min(99, Number(((processedUsers / totalUsers) * 100).toFixed(2))) : 0,
    };
  }

  async getMyBonuses(userId: string, page = 1, limit = 20) {
    const safePage = this.safePage(page);
    const safeLimit = this.safeLimit(limit);
    const filter = { userId };
    const [items, total] = await Promise.all([
      this.bonusModel.find(filter).sort({ createdAt: -1 }).skip((safePage - 1) * safeLimit).limit(safeLimit).lean().exec(),
      this.bonusModel.countDocuments(filter).exec(),
    ]);
    return { items: items.map((item) => this.present(item)), page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) };
  }

  async getAdminBonuses(query: { userId?: string; type?: BonusType; status?: string; page?: number; limit?: number } = {}) {
    const page = this.safePage(query.page);
    const limit = this.safeLimit(query.limit);
    const filter: Record<string, unknown> = {};
    if (query.userId) filter.userId = query.userId;
    if (query.type && Object.values(BonusType).includes(query.type)) filter.type = query.type;
    if (query.status === 'EXPIRED') {
      filter.status = BonusStatus.GRANTED;
      filter.type = BonusType.SUBSCRIPTION;
      filter.expiresAt = { $lte: new Date() };
    } else if (query.status && Object.values(BonusStatus).includes(query.status as BonusStatus)) {
      filter.status = query.status;
    }
    const [items, total] = await Promise.all([
      this.bonusModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.bonusModel.countDocuments(filter).exec(),
    ]);
    return { items: items.map((item) => this.present(item)), page, limit, total, pages: Math.ceil(total / limit) };
  }

  async revokeBonus(id: string, adminId: string, reason: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid bonus ID.');
    const grant = await this.bonusModel.findById(id).exec();
    if (!grant) throw new NotFoundException('Bonus grant not found.');
    if (grant.status === BonusStatus.REVOKED) return this.present(grant);
    if (grant.status !== BonusStatus.GRANTED) {
      throw new ConflictException('Only completed bonus grants can be revoked. Retry any pending grant before revoking it.');
    }

    if (grant.type === BonusType.BET_LAB_POINTS) {
      await this.walletService.revokeAdminBonusPoints(
        grant.userId,
        Number(grant.points),
        reason.trim(),
        String(grant._id),
      );
    }

    grant.status = BonusStatus.REVOKED;
    grant.revokedAt = new Date();
    grant.revokedBy = adminId;
    grant.revocationReason = reason.trim();
    await grant.save();
    await this.notificationEvents.cancelPendingEvent({
      recipientId: grant.userId,
      dedupeKey: `bonus:${String(grant._id)}:expired`,
      reason: 'The bonus was revoked before its scheduled expiry notification.',
    });
    await this.notificationEvents.bonusRevoked({
      userId: grant.userId,
      grantId: String(grant._id),
      reason: grant.revocationReason,
    });
    return this.present(grant);
  }

  private async findOrCreateGrant(data: Partial<BonusGrant>): Promise<BonusGrantDocument> {
    const idempotencyKey = String(data.idempotencyKey);
    const current = await this.bonusModel.findOne({ idempotencyKey }).exec();
    if (current) return current;
    try {
      return await this.bonusModel.create(data);
    } catch (error) {
      if (this.isDuplicateKey(error)) {
        const existing = await this.bonusModel.findOne({ idempotencyKey }).exec();
        if (existing) return existing;
      }
      throw error;
    }
  }

  private assertSameRequest(
    grant: BonusGrantDocument,
    expected: {
      userId: string;
      type: BonusType;
      reason: string;
      points?: number;
      plan?: string;
      durationDays?: number;
      startsAt?: Date;
    },
  ): void {
    const same = grant.userId === expected.userId && grant.type === expected.type && grant.reason === expected.reason &&
      (expected.points === undefined || grant.points === expected.points) &&
      (expected.plan === undefined || grant.plan === expected.plan) &&
      (expected.durationDays === undefined || grant.durationDays === expected.durationDays) &&
      (expected.startsAt === undefined || grant.startsAt.getTime() === expected.startsAt.getTime());
    if (!same) throw new ConflictException('This idempotency key has already been used for a different bonus request.');
  }

  private async assertUserExists(userId: string): Promise<void> {
    if (!Types.ObjectId.isValid(userId)) throw new BadRequestException('Invalid user ID.');
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException('User not found.');
  }

  private present(grant: unknown) {
    const item =
      grant && typeof grant === 'object' && 'toObject' in grant &&
      typeof (grant as { toObject?: unknown }).toObject === 'function'
        ? (grant as { toObject: () => Record<string, unknown> }).toObject()
        : { ...(grant as Record<string, unknown>) };

    // The idempotency key is an internal retry-control value, not user-facing
    // account data. Never return it from either the user or admin API.
    delete item.idempotencyKey;

    let status = item.status;
    if (
      status === BonusStatus.GRANTED &&
      item.type === BonusType.SUBSCRIPTION &&
      item.expiresAt &&
      new Date(String(item.expiresAt)).getTime() <= Date.now()
    ) {
      status = 'EXPIRED';
    }
    return { ...item, status };
  }

  private safePage(value?: number): number {
    return Number.isFinite(value) ? Math.max(1, Math.floor(value!)) : 1;
  }

  private safeLimit(value?: number): number {
    return Number.isFinite(value) ? Math.max(1, Math.min(100, Math.floor(value!))) : 20;
  }

  private isDuplicateKey(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 11000);
  }
}



