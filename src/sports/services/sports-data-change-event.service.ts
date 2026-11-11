import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';

import type { SportsDataChangedEvent, SportsSourceEntity } from '../interfaces/sports-derived-data.interface';
import {
  SportsDataChangeEvent,
  SportsDataChangeEventDocument,
} from '../schemas/operations/sports-data-change-event.schema';
import {
  SportsEntityRevision,
  SportsEntityRevisionDocument,
} from '../schemas/operations/sports-entity-revision.schema';

export interface EnqueueSportsDataChangeInput {
  entity: SportsSourceEntity;
  entityId: string;
  competitionIds?: string[];
  seasonIds?: string[];
  teamIds?: string[];
  athleteIds?: string[];
  fixtureIds?: string[];
  changedAt?: Date;
  sourceFingerprint: string;
}

/** Durable, transactional outbox for source facts consumed by downstream modules. */
@Injectable()
export class SportsDataChangeEventService {
  private wakeHandler?: () => void;

  constructor(
    @InjectModel(SportsDataChangeEvent.name)
    private readonly eventModel: Model<SportsDataChangeEventDocument>,
    @InjectModel(SportsEntityRevision.name)
    private readonly revisionModel: Model<SportsEntityRevisionDocument>,
  ) {}

  setWakeHandler(handler: (() => void) | undefined): void {
    this.wakeHandler = handler;
  }

  /** Read the latest committed revision for one normalized Sports entity. */
  async getCurrentRevision(
    entity: SportsSourceEntity,
    entityId: string,
  ): Promise<number> {
    const id = String(entityId ?? '').trim();
    if (!id) return 0;

    const record = await this.revisionModel
      .findOne({ entity, entityId: id })
      .select({ revision: 1 })
      .lean()
      .exec();
    const revision = Number(record?.revision ?? 0);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  }

  /**
   * Read current revisions in one query. Missing ledger rows represent the
   * bootstrap baseline and therefore have revision zero.
   */
  async getCurrentRevisions(
    entity: SportsSourceEntity,
    entityIds: string[],
  ): Promise<Map<string, number>> {
    const ids = [...new Set(
      entityIds.map((value) => String(value ?? '').trim()).filter(Boolean),
    )];
    const revisions = new Map<string, number>(ids.map((id) => [id, 0] as const));
    if (!ids.length) return revisions;

    const records = await this.revisionModel
      .find({ entity, entityId: { $in: ids } })
      .select({ entityId: 1, revision: 1 })
      .lean()
      .exec();
    for (const record of records) {
      const id = String(record.entityId ?? '');
      const revision = Number(record.revision ?? 0);
      if (revisions.has(id) && Number.isSafeInteger(revision) && revision >= 0) {
        revisions.set(id, revision);
      }
    }
    return revisions;
  }

  /**
   * Writes the event and increments its source revision in the same MongoDB
   * transaction as the normalized source fact. Revision-qualified event IDs
   * preserve the history when a source later returns to an earlier fingerprint.
   * Callers compare persisted source fingerprints before enqueueing, and must
   * notify the worker only after their transaction has committed.
   */
  async enqueueChanged(
    input: EnqueueSportsDataChangeInput,
    session: ClientSession,
  ): Promise<boolean> {
    const entity = input.entity;
    const entityId = String(input.entityId ?? '').trim();
    const sourceFingerprint = String(input.sourceFingerprint ?? '').trim();
    if (!entityId || !sourceFingerprint) {
      throw new Error('Sports outbox events require an entity ID and source fingerprint.');
    }

    // Initialize separately so the increment is unambiguous on the first
    // insert and remains monotonic for this source entity.
    await this.revisionModel.updateOne(
      { entity, entityId },
      { $setOnInsert: { entity, entityId, revision: 0 } },
      { upsert: true, setDefaultsOnInsert: true, session },
    ).exec();
    const revisionRecord = await this.revisionModel.findOneAndUpdate(
      { entity, entityId },
      { $inc: { revision: 1 } },
      { returnDocument: 'after', session },
    ).lean().exec();
    const revision = Number(revisionRecord?.revision ?? 0);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error(`Could not allocate a Sports source revision for ${entity}/${entityId}.`);
    }

    // Fingerprint-only IDs incorrectly suppressed a genuine A -> B -> A source
    // correction when the earlier A event was already completed. Including the
    // monotonic revision makes each material transition independently durable.
    const digest = createHash('sha256')
      .update(`${entity}\n${entityId}\n${revision}\n${sourceFingerprint}`)
      .digest('hex');
    const eventId = `sports-change:${entity}:${digest}`;

    const event: Omit<SportsDataChangedEvent, 'createdAt' | 'updatedAt'> = {
      eventId,
      entity,
      entityId,
      competitionIds: [...new Set(input.competitionIds ?? [])],
      seasonIds: [...new Set(input.seasonIds ?? [])],
      teamIds: [...new Set(input.teamIds ?? [])],
      athleteIds: [...new Set(input.athleteIds ?? [])],
      fixtureIds: [...new Set(input.fixtureIds ?? [])],
      changedAt: input.changedAt ?? new Date(),
      revision,
      sourceFingerprint,
    };

    await this.eventModel.create(
      [{ ...event, status: 'PENDING', attempts: 0 }],
      { session },
    );
    return true;
  }

  notifyWorker(): void {
    this.wakeHandler?.();
  }

  getPendingEvents(limit = 100) {
    const now = new Date();
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    return this.eventModel.find({
      status: 'PENDING',
      $or: [
        { nextAttemptAt: { $exists: false } },
        { nextAttemptAt: null },
        { nextAttemptAt: { $lte: now } },
      ],
    })
      .sort({ changedAt: 1, createdAt: 1 })
      .limit(safeLimit)
      .lean()
      .exec();
  }

  async markProcessing(
    eventId: string,
    workerId: string,
    leaseMs = 120_000,
  ): Promise<boolean> {
    const now = new Date();
    const result = await this.eventModel.updateOne(
      {
        eventId,
        status: 'PENDING',
        $or: [
          { nextAttemptAt: { $exists: false } },
          { nextAttemptAt: null },
          { nextAttemptAt: { $lte: now } },
        ],
      },
      {
        $set: {
          status: 'PROCESSING',
          ownerId: workerId,
          processingAt: now,
          leaseExpiresAt: new Date(now.getTime() + Math.max(10_000, leaseMs)),
        },
        $inc: { attempts: 1 },
        $unset: { nextAttemptAt: 1 },
      },
    ).exec();
    return result.modifiedCount === 1;
  }

  async markHeartbeat(eventId: string, workerId: string, leaseMs = 120_000): Promise<boolean> {
    const now = new Date();
    const result = await this.eventModel.updateOne(
      { eventId, status: 'PROCESSING', ownerId: workerId },
      { $set: { leaseExpiresAt: new Date(now.getTime() + Math.max(10_000, leaseMs)) } },
    ).exec();
    return result.modifiedCount === 1;
  }

  async markCompleted(eventId: string, workerId?: string): Promise<void> {
    await this.eventModel.updateOne(
      {
        eventId,
        status: 'PROCESSING',
        ...(workerId ? { ownerId: workerId } : {}),
      },
      {
        $set: { status: 'COMPLETED', processedAt: new Date() },
        $unset: { lastError: 1, ownerId: 1, processingAt: 1, leaseExpiresAt: 1, nextAttemptAt: 1 },
      },
    ).exec();
  }

  async markFailed(eventId: string, error: unknown, workerId?: string): Promise<'RETRY' | 'FAILED'> {
    const current = await this.eventModel.findOne({
      eventId,
      status: 'PROCESSING',
      ...(workerId ? { ownerId: workerId } : {}),
    }).select({ attempts: 1 }).lean().exec();
    if (!current) return 'FAILED';

    const message = error instanceof Error ? error.message : String(error);
    const attempts = Number(current.attempts ?? 1);
    const retryability = error && typeof error === 'object' && 'retryable' in error
      ? (error as { retryable?: unknown }).retryable
      : undefined;
    // Provider/transport failures are retried with backoff without a fixed cap.
    // Lease expiry is also not a permanent failure; only ordinary or explicitly
    // permanent dispatch errors use the bounded attempt policy.
    const shouldRetry = retryability === true || (retryability !== false && attempts < 10);
    const delayMs = Math.min(30 * 60_000, 5_000 * 2 ** Math.min(attempts - 1, 8));
    const nextAttemptAt = new Date(Date.now() + delayMs);

    await this.eventModel.updateOne(
      {
        eventId,
        status: 'PROCESSING',
        ...(workerId ? { ownerId: workerId } : {}),
      },
      {
        $set: {
          status: shouldRetry ? 'PENDING' : 'FAILED',
          lastError: message.replace(/[\r\n]+/g, ' ').slice(0, 1_000),
          ...(shouldRetry ? { nextAttemptAt } : {}),
        },
        $unset: { ownerId: 1, processingAt: 1, leaseExpiresAt: 1 },
      },
    ).exec();

    if (shouldRetry) this.notifyWorker();
    return shouldRetry ? 'RETRY' : 'FAILED';
  }

  async recoverExpiredProcessing(limit = 100): Promise<number> {
    const now = new Date();
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const expired = await this.eventModel.find({
      status: 'PROCESSING',
      leaseExpiresAt: { $lte: now },
    }).select({ eventId: 1, attempts: 1 }).limit(safeLimit).lean().exec();
    if (expired.length === 0) return 0;

    let recovered = 0;
    for (const item of expired as any[]) {
      const eventId = String(item.eventId);
      const attempts = Number(item.attempts ?? 0);
      const retryAt = new Date(now.getTime() + Math.min(30 * 60_000, 5_000 * 2 ** Math.min(attempts, 8)));
      const result = await this.eventModel.updateOne(
        { eventId, status: 'PROCESSING', leaseExpiresAt: { $lte: now } },
        {
          // A disappeared worker is not evidence that Settlement rejected the
          // event. Keep the durable outbox item retryable, even after many leases.
          $set: { status: 'PENDING', nextAttemptAt: retryAt, lastError: 'Recovered after outbox worker lease expired.' },
          $unset: { ownerId: 1, processingAt: 1, leaseExpiresAt: 1 },
        },
      ).exec();
      recovered += result.modifiedCount;
    }
    if (recovered > 0) this.notifyWorker();
    return recovered;
  }

  async requeueFailed(eventId: string): Promise<boolean> {
    const now = new Date();
    const result = await this.eventModel.updateOne(
      { eventId, status: 'FAILED' },
      {
        $set: { status: 'PENDING', nextAttemptAt: now, attempts: 0 },
        $unset: { lastError: 1, ownerId: 1, processingAt: 1, leaseExpiresAt: 1 },
      },
    ).exec();
    if (result.modifiedCount === 1) this.notifyWorker();
    return result.modifiedCount === 1;
  }
}
