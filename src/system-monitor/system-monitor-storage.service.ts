import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import type { Document } from 'mongodb';
import {
  SystemMonitorStorageCollection, SystemMonitorStorageHistoryItem,
  SystemMonitorStorageResponse, SystemMonitorStorageSnapshot as SnapshotShape,
  SystemMonitorStorageTotals,
} from './system-monitor-storage.interface';
import { SystemMonitorStorageSnapshot, SystemMonitorStorageSnapshotDocument } from './system-monitor-storage.schema';
import { SystemMonitorService } from './system-monitor.service';

interface NativeStats { count?: number; size?: number; storageSize?: number; avgObjSize?: number; nindexes?: number; totalIndexSize?: number; }

@Injectable()
export class SystemMonitorStorageService {
  private readonly logger = new Logger(SystemMonitorStorageService.name);
  private readonly snapshotCollectionName = 'system_monitor_storage_snapshots';
  private readonly cacheTtlMs = 5 * 60_000;
  private readonly persistenceIntervalMs = 30 * 60_000;
  private cachedSnapshot?: SystemMonitorStorageResponse;
  private cacheExpiresAt = 0;
  private lastPersistedAt = 0;
  private lastDatabaseHealth?: Record<string, unknown>;
  private lastDatabaseHealthAt = 0;
  private databaseHealthInFlight?: Promise<Record<string, unknown>>;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(SystemMonitorStorageSnapshot.name) private readonly snapshotModel: Model<SystemMonitorStorageSnapshotDocument>,
    private readonly systemMonitor: SystemMonitorService,
  ) {}

  async getStorageStats(): Promise<SystemMonitorStorageResponse> {
    const now = Date.now();
    if (this.cachedSnapshot && now < this.cacheExpiresAt) {
      await this.persistIfDue(this.cachedSnapshot);
      return this.cachedSnapshot;
    }
    const snapshot = await this.collectStorageStats();
    const persistedAt = await this.persistIfDue(snapshot);
    const response: SystemMonitorStorageResponse = { ...snapshot, ...(persistedAt ? { persistedAt } : {}) };
    this.cachedSnapshot = response;
    this.cacheExpiresAt = now + this.cacheTtlMs;
    return response;
  }

  async refreshStorageSnapshot(): Promise<SystemMonitorStorageResponse> {
    this.cacheExpiresAt = 0;
    return this.getStorageStats();
  }

  async getStorageHistory(limit = 30): Promise<SystemMonitorStorageHistoryItem[]> {
    const normalizedLimit = this.normalizeLimit(limit);
    const snapshots = await this.snapshotModel.find({}, { capturedAt: 1, databaseName: 1, totals: 1 })
      .sort({ capturedAt: -1 }).limit(normalizedLimit).lean().exec();
    return snapshots.map((item: any) => ({ capturedAt: item.capturedAt, databaseName: item.databaseName, totals: {
      collections: item.totals.collections, documents: item.totals.documents, dataSizeBytes: item.totals.dataSizeBytes,
      storageSizeBytes: item.totals.storageSizeBytes, indexSizeBytes: item.totals.indexSizeBytes, totalSizeBytes: item.totals.totalSizeBytes,
    } }));
  }

  async getDatabaseHealth(force = false): Promise<Record<string, unknown>> {
    if (!force && this.lastDatabaseHealth && Date.now() - this.lastDatabaseHealthAt < 5 * 60_000) return this.lastDatabaseHealth;
    if (this.databaseHealthInFlight) return this.databaseHealthInFlight;
    this.databaseHealthInFlight = this.collectDatabaseHealth();
    try {
      this.lastDatabaseHealth = await this.databaseHealthInFlight;
      this.lastDatabaseHealthAt = Date.now();
      return this.lastDatabaseHealth;
    } finally {
      this.databaseHealthInFlight = undefined;
    }
  }

  async getCollectionDetail(name: string): Promise<SystemMonitorStorageCollection> {
    const normalized = String(name ?? '').trim();
    if (!normalized || normalized.startsWith('system.') || normalized === this.snapshotCollectionName || normalized.includes('\0')) {
      throw new BadRequestException('Collection name is not available for inspection.');
    }
    const db = this.connection.db;
    if (!db) throw new Error('MongoDB database connection is not available.');
    const exists = await db.listCollections({ name: normalized }, { nameOnly: true }).hasNext();
    if (!exists) throw new NotFoundException('MongoDB collection was not found.');
    return this.getCollectionStats(normalized);
  }

  private async collectDatabaseHealth(): Promise<Record<string, unknown>> {
    const started = Date.now();
    const database = this.connection.db;
    const readyState = this.connection.readyState;
    const stateNames: Record<number, string> = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting',
    };
    const stateName = stateNames[readyState] ?? 'unknown';
    if (readyState !== 1 || !database) {
      const result = { status: 'FAILED', state: stateName, readyState, databaseName: this.connection.name || null, pingMs: null, checkedAt: new Date() };
      this.systemMonitor.reportModuleHealth('database', 'FAILED', { source: 'database-probe', message: `MongoDB connection is ${stateName}.`, details: { readyState } });
      return result;
    }
    try {
      await database.command({ ping: 1 });
      const pingMs = Date.now() - started;
      let stats: Record<string, any> = {};
      try { stats = await database.stats(); } catch (error) { this.logger.warn(`MongoDB db.stats failed: ${this.errorMessage(error)}`); }
      const result = {
        status: 'HEALTHY', state: stateName, readyState, databaseName: database.databaseName,
        pingMs, checkedAt: new Date(), collections: this.toNumber(stats.collections),
        documents: this.toNumber(stats.objects), dataSizeBytes: this.toNumber(stats.dataSize),
        storageSizeBytes: this.toNumber(stats.storageSize), indexSizeBytes: this.toNumber(stats.indexSize),
        totalSizeBytes: this.toNumber(stats.storageSize) + this.toNumber(stats.indexSize),
      };
      this.systemMonitor.reportModuleHealth('database', 'HEALTHY', { source: 'database-probe', message: `MongoDB ping completed in ${pingMs} ms.`, details: { pingMs, collections: result.collections, documents: result.documents } });
      return result;
    } catch (error) {
      const message = this.errorMessage(error);
      this.systemMonitor.reportModuleHealth('database', 'FAILED', { source: 'database-probe', message, details: { readyState } });
      this.systemMonitor.reportError({ module: 'database', source: 'database-probe', operation: 'ping', message, occurredAt: new Date(), stack: error instanceof Error ? error.stack : undefined });
      return { status: 'FAILED', state: stateName, readyState, databaseName: database?.databaseName ?? this.connection.name ?? null, pingMs: Date.now() - started, checkedAt: new Date(), error: message };
    }
  }

  private async collectStorageStats(): Promise<SnapshotShape> {
    const db = this.connection.db;
    if (!db) throw new Error('MongoDB database connection is not available.');
    const collectionInfos = await db.listCollections().toArray();
    const names = collectionInfos.filter((item) => item.type === 'collection' && !item.name.startsWith('system.') && item.name !== this.snapshotCollectionName).map((item) => item.name).sort();
    const collections: SystemMonitorStorageCollection[] = [];
    // Bound concurrency: collection-level stats can be expensive on larger databases.
    for (let i = 0; i < names.length; i += 8) {
      const group = names.slice(i, i + 8);
      const stats = await Promise.all(group.map((name) => this.getCollectionStats(name).catch((error) => {
        this.logger.warn(`Could not collect stats for ${name}: ${this.errorMessage(error)}`);
        return { name, documents: 0, dataSizeBytes: 0, storageSizeBytes: 0, averageDocumentSizeBytes: 0, indexes: 0, totalIndexSizeBytes: 0, totalSizeBytes: 0 } as SystemMonitorStorageCollection;
      })));
      collections.push(...stats);
    }
    const totals = collections.reduce((acc, value) => {
      acc.collections += 1; acc.documents += value.documents; acc.dataSizeBytes += value.dataSizeBytes;
      acc.storageSizeBytes += value.storageSizeBytes; acc.indexSizeBytes += value.totalIndexSizeBytes; acc.totalSizeBytes += value.totalSizeBytes;
      return acc;
    }, { collections: 0, documents: 0, dataSizeBytes: 0, storageSizeBytes: 0, indexSizeBytes: 0, totalSizeBytes: 0 } as SystemMonitorStorageTotals);
    return { capturedAt: new Date(), databaseName: db.databaseName, totals, collections };
  }

  private async getCollectionStats(name: string): Promise<SystemMonitorStorageCollection> {
    const db = this.connection.db;
    if (!db) throw new Error('MongoDB database connection is not available.');
    const result = await db.collection(name).aggregate([{ $collStats: { storageStats: {} } }] as unknown as Document[]).next() as any;
    const stats: NativeStats = result?.storageStats ?? {};
    const documents = this.toNumber(stats.count);
    const dataSizeBytes = this.toNumber(stats.size);
    const storageSizeBytes = this.toNumber(stats.storageSize);
    const averageDocumentSizeBytes = this.toNumber(stats.avgObjSize);
    const indexes = this.toNumber(stats.nindexes);
    const totalIndexSizeBytes = this.toNumber(stats.totalIndexSize);
    return { name, documents, dataSizeBytes, storageSizeBytes, averageDocumentSizeBytes, indexes, totalIndexSizeBytes, totalSizeBytes: storageSizeBytes + totalIndexSizeBytes };
  }

  private async persistIfDue(snapshot: SnapshotShape): Promise<Date | undefined> {
    const now = Date.now();
    if (this.lastPersistedAt > 0 && now - this.lastPersistedAt < this.persistenceIntervalMs) return undefined;
    try {
      await this.snapshotModel.create({ capturedAt: snapshot.capturedAt, databaseName: snapshot.databaseName, totals: snapshot.totals, collections: snapshot.collections });
      this.lastPersistedAt = now;
      return snapshot.capturedAt;
    } catch (error) {
      this.logger.warn(`Could not persist storage snapshot: ${this.errorMessage(error)}`);
      // Monitoring should not take down application behavior if history persistence fails.
      return undefined;
    }
  }

  private toNumber(value: unknown): number {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
  }
  private normalizeLimit(value: number) { return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 1), 100) : 30; }
  private errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
}

