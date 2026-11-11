import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { SportsDomainReadService } from '../../sports/services/sports-domain-read.service';
import { MarketPrediction } from '../schemas/market-prediction.schema';
import { PredictionRun } from '../schemas/prediction-run.schema';
import { PickCenter } from '../schemas/pick-center.schema';
import { CuratedPrediction } from '../schemas/curated-prediction.schema';
import { PredictionSlip } from '../schemas/prediction-slip.schema';
import { PredictionQueue } from '../schemas/prediction-queue.schema';

type RetentionRow = {
  _id: unknown;
  eventId?: string | number | null;
  selections?: Array<Record<string, unknown>>;
  legs?: Array<Record<string, unknown>>;
};

type BulkRetentionOperation = {
  updateOne: {
    filter: Record<string, unknown>;
    update: { $set: Record<string, unknown> };
  };
};

const asValidDate = (value: unknown): Date | null => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

/**
 * Backfills retention deadlines on prediction records created before Stage 4.
 * New writes already copy the canonical Sports fixture deadline directly.
 *
 * The migration is intentionally incremental: each pass reads a small page,
 * resolves Sports fixture deadlines with bounded concurrency, and writes only
 * records where retentionExpiresAt is still absent. Unknown deadlines are
 * stored as null rather than guessed, and are therefore never prematurely TTL'd.
 */
@Injectable()
export class PredictionRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PredictionRetentionService.name);
  private readonly batchSize = 25;
  private readonly lookupConcurrency = 8;
  private readonly retryIntervalMs = 15_000;
  private timer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private stopped = false;
  private completed = false;

  constructor(
    @InjectModel(MarketPrediction.name)
    private readonly marketPredictionModel: Model<MarketPrediction>,
    @InjectModel(PredictionRun.name)
    private readonly predictionRunModel: Model<PredictionRun>,
    @InjectModel(PickCenter.name)
    private readonly pickCenterModel: Model<PickCenter>,
    @InjectModel(CuratedPrediction.name)
    private readonly curatedPredictionModel: Model<CuratedPrediction>,
    @InjectModel(PredictionSlip.name)
    private readonly predictionSlipModel: Model<PredictionSlip>,
    @InjectModel(PredictionQueue.name)
    private readonly predictionQueueModel: Model<PredictionQueue>,
    private readonly sportsRead: SportsDomainReadService,
  ) {}

  onModuleInit(): void {
    this.schedule(10_000);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.completed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.runBatchSafely(), delayMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private async runBatchSafely(): Promise<void> {
    if (this.stopped || this.completed || this.busy) return;
    this.busy = true;
    const startedAt = Date.now();
    const deadlineCache = new Map<string, Promise<Date | null>>();

    try {
      const results = await Promise.all([
        this.backfillFixtureRows(this.marketPredictionModel, 'market-predictions', deadlineCache),
        this.backfillFixtureRows(this.predictionRunModel, 'prediction-runs', deadlineCache),
        this.backfillFixtureRows(this.pickCenterModel, 'pick-center', deadlineCache),
        this.backfillCuratedRows(deadlineCache),
        this.backfillSlipRows(deadlineCache),
        this.backfillFixtureRows(this.predictionQueueModel, 'prediction-queue', deadlineCache),
      ]);

      const failed = results.some((result) => result === null);
      const processed = results.reduce<number>((sum, result) => sum + (result ?? 0), 0);
      this.logger.log(
        `Prediction retention migration pass: updated=${processed}, durationMs=${Date.now() - startedAt}, failed=${failed}.`,
      );

      if (!failed && processed === 0) {
        this.completed = true;
        this.logger.log('Prediction retention backfill completed; TTL indexes now govern retained prediction records.');
      } else {
        this.schedule(this.retryIntervalMs);
      }
    } catch (error) {
      this.logger.warn(
        `Prediction retention backfill pass failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.schedule(this.retryIntervalMs);
    } finally {
      this.busy = false;
    }
  }

  private async backfillFixtureRows<T>(
    model: Model<T>,
    label: string,
    deadlineCache: Map<string, Promise<Date | null>>,
  ): Promise<number | null> {
    try {
      const rows = (await model
        .find({ retentionExpiresAt: { $exists: false } })
        .select({ _id: 1, eventId: 1 })
        .sort({ _id: 1 })
        .limit(this.batchSize)
        .lean()
        .exec()) as unknown as RetentionRow[];

      if (!rows.length) return 0;
      const operations = await this.mapWithConcurrency(
        rows,
        this.lookupConcurrency,
        async (row): Promise<BulkRetentionOperation> => {
          const eventId = String(row.eventId ?? '').trim();
          const expiry = eventId ? await this.resolveDeadline(eventId, deadlineCache) : null;
          return {
            updateOne: {
              filter: { _id: row._id, retentionExpiresAt: { $exists: false } },
              update: { $set: { retentionExpiresAt: expiry } },
            },
          };
        },
      );
      const result = await model.bulkWrite(operations as never[], { ordered: false });
      const modified = Number(result.modifiedCount ?? 0);
      this.logger.debug(`Retention backfill ${label}: scanned=${rows.length}, updated=${modified}.`);
      return modified;
    } catch (error) {
      this.logger.warn(
        `Retention backfill failed for ${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async backfillCuratedRows(
    deadlineCache: Map<string, Promise<Date | null>>,
  ): Promise<number | null> {
    try {
      const rows = (await this.curatedPredictionModel
        .find({ retentionExpiresAt: { $exists: false } })
        .select({ _id: 1, eventId: 1, selections: 1 })
        .sort({ _id: 1 })
        .limit(this.batchSize)
        .lean()
        .exec()) as unknown as RetentionRow[];
      if (!rows.length) return 0;

      const operations = await this.mapWithConcurrency(
        rows,
        this.lookupConcurrency,
        async (row): Promise<BulkRetentionOperation> => {
          const eventId = String(row.eventId ?? '').trim();
          const expiry = eventId ? await this.resolveDeadline(eventId, deadlineCache) : null;
          const selections = (Array.isArray(row.selections) ? row.selections : []).map((selection) => ({
            ...selection,
            retentionExpiresAt: expiry,
          }));
          return {
            updateOne: {
              filter: { _id: row._id, retentionExpiresAt: { $exists: false } },
              update: { $set: { retentionExpiresAt: expiry, selections } },
            },
          };
        },
      );
      const result = await this.curatedPredictionModel.bulkWrite(operations as never[], { ordered: false });
      return Number(result.modifiedCount ?? 0);
    } catch (error) {
      this.logger.warn(
        `Retention backfill failed for curated-predictions: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async backfillSlipRows(
    deadlineCache: Map<string, Promise<Date | null>>,
  ): Promise<number | null> {
    try {
      const rows = (await this.predictionSlipModel
        .find({ retentionExpiresAt: { $exists: false } })
        .select({ _id: 1, legs: 1 })
        .sort({ _id: 1 })
        .limit(this.batchSize)
        .lean()
        .exec()) as unknown as RetentionRow[];
      if (!rows.length) return 0;

      const operations = await this.mapWithConcurrency(
        rows,
        this.lookupConcurrency,
        async (row): Promise<BulkRetentionOperation> => {
          const priorLegs = Array.isArray(row.legs) ? row.legs : [];
          const legs = await this.mapWithConcurrency(
            priorLegs,
            this.lookupConcurrency,
            async (leg) => {
              const eventId = String(leg.eventId ?? '').trim();
              const expiry = eventId ? await this.resolveDeadline(eventId, deadlineCache) : null;
              return { ...leg, retentionExpiresAt: expiry };
            },
          );
          const allLegsHaveExpiry = legs.length > 0 && legs.every((leg) =>
            asValidDate(leg.retentionExpiresAt) !== null,
          );
          const slipExpiry = allLegsHaveExpiry
            ? new Date(Math.max(...legs.map((leg) => asValidDate(leg.retentionExpiresAt)!.getTime())))
            : null;
          return {
            updateOne: {
              filter: { _id: row._id, retentionExpiresAt: { $exists: false } },
              update: { $set: { retentionExpiresAt: slipExpiry, legs } },
            },
          };
        },
      );
      const result = await this.predictionSlipModel.bulkWrite(operations as never[], { ordered: false });
      return Number(result.modifiedCount ?? 0);
    } catch (error) {
      this.logger.warn(
        `Retention backfill failed for prediction-slips: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private resolveDeadline(
    eventId: string,
    cache: Map<string, Promise<Date | null>>,
  ): Promise<Date | null> {
    const existing = cache.get(eventId);
    if (existing) return existing;

    const lookup = this.sportsRead.getFixture(eventId)
      .then((fixture) => asValidDate(fixture?.retentionExpiresAt))
      .catch((error: unknown) => {
        this.logger.warn(
          `Could not read Sports retention deadline for fixture ${eventId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      });
    cache.set(eventId, lookup);
    return lookup;
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const output = new Array<R>(items.length);
    let cursor = 0;
    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await mapper(items[index]);
      }
    }));
    return output;
  }
}
