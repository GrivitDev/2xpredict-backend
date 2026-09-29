import { Injectable } from '@nestjs/common';

import { InjectConnection, InjectModel } from '@nestjs/mongoose';

import { Connection, Model } from 'mongoose';

import {
  SystemMonitorStorageCollection,
  SystemMonitorStorageHistoryItem,
  SystemMonitorStorageResponse,
  SystemMonitorStorageSnapshot as SystemMonitorStorageSnapshotInterface,
  SystemMonitorStorageTotals,
} from './system-monitor-storage.interface';

import {
  SystemMonitorStorageSnapshot,
  SystemMonitorStorageSnapshotDocument,
} from './system-monitor-storage.schema';

// ============================================================
// MONGODB STORAGE STATS
// ============================================================

interface MongoStorageStats {
  count?: number;

  size?: number;

  storageSize?: number;

  avgObjSize?: number;

  nindexes?: number;

  totalIndexSize?: number;
}

interface MongoCollectionStatsResult {
  storageStats?: MongoStorageStats;
}

// ============================================================
// SERVICE
// ============================================================

@Injectable()
export class SystemMonitorStorageService {
  private readonly snapshotCollectionName = 'system_monitor_storage_snapshots';

  /*
   * Live monitor requests can happen every few seconds.
   * There is no reason to ask MongoDB for storage statistics
   * on every single frontend refresh.
   */
  private readonly cacheTtlMs = 30 * 1000;

  /*
   * Persist one storage snapshot at most every 10 minutes.
   */
  private readonly persistenceIntervalMs = 10 * 60 * 1000;

  private cachedSnapshot: SystemMonitorStorageResponse | undefined;

  private cacheExpiresAt = 0;

  private lastPersistedAt = 0;

  constructor(
    @InjectConnection()
    private readonly connection: Connection,

    @InjectModel(SystemMonitorStorageSnapshot.name)
    private readonly snapshotModel: Model<SystemMonitorStorageSnapshotDocument>,
  ) {}

  // ==========================================================
  // CURRENT STORAGE
  // ==========================================================

  async getStorageStats(): Promise<SystemMonitorStorageResponse> {
    const now = Date.now();

    if (this.cachedSnapshot && now < this.cacheExpiresAt) {
      await this.persistIfDue(this.cachedSnapshot);

      return this.cachedSnapshot;
    }

    const snapshot = await this.collectStorageStats();

    const persistedAt = await this.persistIfDue(snapshot);

    const response: SystemMonitorStorageResponse = {
      ...snapshot,

      ...(persistedAt
        ? {
            persistedAt,
          }
        : {}),
    };

    this.cachedSnapshot = response;

    this.cacheExpiresAt = now + this.cacheTtlMs;

    return response;
  }

  // ==========================================================
  // HISTORY
  // ==========================================================

  async getStorageHistory(
    limit = 30,
  ): Promise<SystemMonitorStorageHistoryItem[]> {
    const normalizedLimit = this.normalizeHistoryLimit(limit);

    const snapshots = await this.snapshotModel
      .find(
        {},
        {
          capturedAt: 1,
          databaseName: 1,
          totals: 1,
        },
      )
      .sort({
        capturedAt: -1,
      })
      .limit(normalizedLimit)
      .lean()
      .exec();

    return snapshots.map((snapshot) => ({
      capturedAt: snapshot.capturedAt,

      databaseName: snapshot.databaseName,

      totals: {
        collections: snapshot.totals.collections,

        documents: snapshot.totals.documents,

        dataSizeBytes: snapshot.totals.dataSizeBytes,

        storageSizeBytes: snapshot.totals.storageSizeBytes,

        indexSizeBytes: snapshot.totals.indexSizeBytes,

        totalSizeBytes: snapshot.totals.totalSizeBytes,
      },
    }));
  }

  // ==========================================================
  // COLLECT
  // ==========================================================

  private async collectStorageStats(): Promise<SystemMonitorStorageSnapshotInterface> {
    const db = this.connection.db;

    if (!db) {
      throw new Error('MongoDB database connection is not available.');
    }

    const databaseName = db.databaseName;

    /*
     * We intentionally collect normal application collections
     * only. System collections and the monitor's own snapshot
     * collection are excluded.
     */
    const collectionInfos = await db.listCollections().toArray();

    const collectionNames = collectionInfos
      .filter(
        (collection) =>
          collection.type === 'collection' &&
          !collection.name.startsWith('system.') &&
          collection.name !== this.snapshotCollectionName,
      )
      .map((collection) => collection.name)
      .sort();

    const collections = await Promise.all(
      collectionNames.map((name) => this.getCollectionStats(name)),
    );

    // ========================================================
    // TOTALS
    // ========================================================

    const totals: SystemMonitorStorageTotals = collections.reduce(
      (accumulator, collection) => {
        accumulator.collections += 1;

        accumulator.documents += collection.documents;

        accumulator.dataSizeBytes += collection.dataSizeBytes;

        accumulator.storageSizeBytes += collection.storageSizeBytes;

        accumulator.indexSizeBytes += collection.totalIndexSizeBytes;

        accumulator.totalSizeBytes += collection.totalSizeBytes;

        return accumulator;
      },
      {
        collections: 0,

        documents: 0,

        dataSizeBytes: 0,

        storageSizeBytes: 0,

        indexSizeBytes: 0,

        totalSizeBytes: 0,
      },
    );

    return {
      capturedAt: new Date(),

      databaseName,

      totals,

      collections,
    };
  }

  // ==========================================================
  // COLLECTION STATISTICS
  // ==========================================================

  private async getCollectionStats(
    name: string,
  ): Promise<SystemMonitorStorageCollection> {
    const collection = this.connection.db!.collection(name);

    /*
     * $collStats is the MongoDB-native statistics source.
     *
     * It gives us:
     *
     * - logical data size
     * - allocated storage size
     * - document count
     * - average document size
     * - index count
     * - total index size
     *
     * without depending on Atlas UI.
     */
    const pipeline = [
      {
        $collStats: {
          storageStats: {},
        },
      },
    ] as unknown as Document[];

    const result = (await collection
      .aggregate<MongoCollectionStatsResult>(pipeline)
      .next()) ?? {
      storageStats: {},
    };

    const storageStats = result.storageStats ?? {};

    const documents = this.toNonNegativeNumber(storageStats.count);

    const dataSizeBytes = this.toNonNegativeNumber(storageStats.size);

    const storageSizeBytes = this.toNonNegativeNumber(storageStats.storageSize);

    const averageDocumentSizeBytes = this.toNonNegativeNumber(
      storageStats.avgObjSize,
    );

    const indexes = this.toNonNegativeNumber(storageStats.nindexes);

    const totalIndexSizeBytes = this.toNonNegativeNumber(
      storageStats.totalIndexSize,
    );

    const totalSizeBytes = storageSizeBytes + totalIndexSizeBytes;

    return {
      name,

      documents,

      dataSizeBytes,

      storageSizeBytes,

      averageDocumentSizeBytes,

      indexes,

      totalIndexSizeBytes,

      totalSizeBytes,
    };
  }

  // ==========================================================
  // PERSISTENCE
  // ==========================================================

  private async persistIfDue(
    snapshot: SystemMonitorStorageSnapshotInterface,
  ): Promise<Date | undefined> {
    const now = Date.now();

    if (
      this.lastPersistedAt > 0 &&
      now - this.lastPersistedAt < this.persistenceIntervalMs
    ) {
      return undefined;
    }

    /*
     * Persist the complete snapshot as one document.
     *
     * This makes historical storage inspection easy and avoids
     * creating one database document per collection.
     */
    await this.snapshotModel.create({
      capturedAt: snapshot.capturedAt,

      databaseName: snapshot.databaseName,

      totals: snapshot.totals,

      collections: snapshot.collections,
    });

    this.lastPersistedAt = now;

    return snapshot.capturedAt;
  }

  // ==========================================================
  // NUMBER HELPERS
  // ==========================================================

  private toNonNegativeNumber(value?: number): number {
    if (value === undefined || !Number.isFinite(value)) {
      return 0;
    }

    return Math.max(0, Math.round(value));
  }

  private normalizeHistoryLimit(value: number): number {
    if (!Number.isFinite(value)) {
      return 30;
    }

    return Math.min(Math.max(Math.floor(value), 1), 100);
  }
}
