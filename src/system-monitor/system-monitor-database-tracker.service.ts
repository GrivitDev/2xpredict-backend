import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import type { MongoClient } from 'mongodb';
import { SystemMonitorService } from './system-monitor.service';

interface InFlightCommand { startedAt: number; database: string; collection: string; command: string; }
interface OperationMetric {
  database: string; collection: string; command: string; count: number; failures: number;
  slow: number; lastDurationMs: number; averageDurationMs: number; lastAt?: Date;
}
interface RecentDatabaseOperation { database: string; collection: string; command: string; durationMs: number; status: 'SUCCESS' | 'FAILED'; occurredAt: Date; message?: string; }
const SLOW_OPERATION_MS = 500;
const MAX_TRACKED_KEYS = 300;
const MAX_IN_FLIGHT = 2000;
const MAX_RECENT = 100;
const TRACKED_COMMANDS = new Set(['find', 'findAndModify', 'aggregate', 'count', 'distinct', 'insert', 'update', 'delete', 'bulkWrite', 'create', 'drop', 'createIndexes', 'deleteIndexes', 'getMore', 'killCursors']);

/** Captures MongoDB driver command telemetry in memory; query payloads are never retained. */
@Injectable()
export class SystemMonitorDatabaseTrackerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SystemMonitorDatabaseTrackerService.name);
  private client?: MongoClient;
  private readonly inFlight = new Map<number, InFlightCommand>();
  private readonly metrics = new Map<string, OperationMetric>();
  private readonly recent: RecentDatabaseOperation[] = [];
  private readonly commandStarted = (event: any) => this.onCommandStarted(event);
  private readonly commandSucceeded = (event: any) => this.onCommandSucceeded(event);
  private readonly commandFailed = (event: any) => this.onCommandFailed(event);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly systemMonitor: SystemMonitorService,
  ) {}

  onApplicationBootstrap(): void {
    try {
      this.client = this.connection.getClient();
      this.client.on('commandStarted', this.commandStarted);
      this.client.on('commandSucceeded', this.commandSucceeded);
      this.client.on('commandFailed', this.commandFailed);
      this.systemMonitor.reportModuleHealth('database-operations', 'HEALTHY', { source: 'mongodb-driver', message: 'MongoDB command telemetry is attached.' });
    } catch (error) {
      this.systemMonitor.reportModuleHealth('database-operations', 'DEGRADED', { source: 'mongodb-driver', message: this.errorMessage(error) });
      this.logger.warn(`MongoDB driver telemetry could not start: ${this.errorMessage(error)}`);
    }
  }

  onModuleDestroy(): void {
    if (!this.client) return;
    this.client.off('commandStarted', this.commandStarted);
    this.client.off('commandSucceeded', this.commandSucceeded);
    this.client.off('commandFailed', this.commandFailed);
    this.inFlight.clear();
  }

  getOperations(options: { limit?: number; collection?: string; status?: string } = {}) {
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(100, Math.floor(options.limit!))) : 30;
    let metrics = [...this.metrics.values()];
    if (options.collection) metrics = metrics.filter((item) => item.collection === options.collection);
    metrics.sort((a, b) => (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0));
    let recent = [...this.recent];
    if (options.collection) recent = recent.filter((item) => item.collection === options.collection);
    if (options.status) recent = recent.filter((item) => item.status === options.status);
    return { slowThresholdMs: SLOW_OPERATION_MS, aggregates: metrics.slice(0, limit), recent: recent.slice(0, limit) };
  }

  private onCommandStarted(event: any): void {
    if (!event || typeof event.requestId !== 'number') return;
    const commandName = String(event.commandName ?? 'unknown');
    if (!this.isTrackedCommand(commandName)) return;
    const command = event.command && typeof event.command === 'object' ? event.command : {};
    const collection = this.resolveCollection(commandName, command);
    if (!collection || collection.startsWith('system.') || collection === 'system_monitor_storage_snapshots') return;
    if (this.inFlight.size >= MAX_IN_FLIGHT) {
      const oldest = this.inFlight.keys().next().value;
      if (typeof oldest === 'number') this.inFlight.delete(oldest);
    }
    this.inFlight.set(event.requestId, {
      startedAt: Date.now(), database: String(event.databaseName ?? this.connection.name ?? 'unknown'),
      collection, command: commandName,
    });
  }

  private onCommandSucceeded(event: any): void {
    if (!event || typeof event.requestId !== 'number') return;
    const started = this.inFlight.get(event.requestId);
    this.inFlight.delete(event.requestId);
    if (!started) return;
    const durationMs = Number.isFinite(event.duration) ? Math.max(0, event.duration) : Date.now() - started.startedAt;
    this.record(started, durationMs, true);
  }

  private onCommandFailed(event: any): void {
    if (!event || typeof event.requestId !== 'number') return;
    const started = this.inFlight.get(event.requestId);
    this.inFlight.delete(event.requestId);
    if (!started) return;
    const durationMs = Number.isFinite(event.duration) ? Math.max(0, event.duration) : Date.now() - started.startedAt;
    this.record(started, durationMs, false, this.safeFailure(event.failure));
  }

  private record(command: InFlightCommand, durationMs: number, success: boolean, message?: string): void {
    const key = `${command.database}:${command.collection}:${command.command}`;
    let item = this.metrics.get(key);
    if (!item) {
      item = { ...command, count: 0, failures: 0, slow: 0, lastDurationMs: 0, averageDurationMs: 0 };
      this.metrics.set(key, item);
    }
    const expectedSlipLockContention =
      !success &&
      command.collection === 'slip_center_generation_locks' &&
      Boolean(message?.includes('E11000'));

    const previousCount = item.count;
    item.count += 1;
    if (!success && !expectedSlipLockContention) item.failures += 1;
    if (durationMs >= SLOW_OPERATION_MS) item.slow += 1;
    item.lastDurationMs = Math.round(durationMs);
    item.averageDurationMs = Math.round(((item.averageDurationMs * previousCount) + durationMs) / item.count);
    item.lastAt = new Date();
    this.recent.unshift({ database: command.database, collection: command.collection, command: command.command,
      durationMs: Math.round(durationMs), status: success ? 'SUCCESS' : 'FAILED', occurredAt: new Date(), message });
    if (this.recent.length > MAX_RECENT) this.recent.length = MAX_RECENT;
    if (this.metrics.size > MAX_TRACKED_KEYS) {
      const oldest = [...this.metrics.entries()].sort((a, b) => (a[1].lastAt?.getTime() ?? 0) - (b[1].lastAt?.getTime() ?? 0))[0];
      if (oldest) this.metrics.delete(oldest[0]);
    }
    // Keep expected lock races visible in database-operation telemetry, but do not
    // mark MongoDB itself degraded when Slip Center correctly skips a competing run.
    if (!success && item.failures === 1 && !expectedSlipLockContention) {
      this.systemMonitor.reportError({
        module: 'database',
        source: 'mongodb-command',
        operation: command.command,
        message: `MongoDB command failed for ${command.collection}${message ? `: ${message}` : ''}`,
        occurredAt: new Date(),
      });
    }
  }

  private isTrackedCommand(name: string): boolean {
    return TRACKED_COMMANDS.has(name);
  }
  private resolveCollection(commandName: string, command: Record<string, unknown>): string {
    const value = command[commandName];
    if (typeof value === 'string') return value.slice(0, 120);
    if (commandName === 'bulkWrite' && typeof command.bulkWrite === 'string') return command.bulkWrite.slice(0, 120);
    return commandName === 'aggregate' && typeof command.aggregate === 'string' ? command.aggregate.slice(0, 120) : '';
  }
  private safeFailure(failure: unknown): string | undefined {
    const text = failure instanceof Error ? failure.message : String((failure as any)?.errmsg ?? '');
    return text.replace(/(password|token|secret|authorization|cookie)=?[^&\s]*/ig, '$1=[redacted]').slice(0, 300) || undefined;
  }
  private errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
}
