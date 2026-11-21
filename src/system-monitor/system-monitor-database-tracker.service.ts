import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import type { MongoClient } from 'mongodb';
import { SystemMonitorService } from './system-monitor.service';
import {
  SystemMonitorRequestContext,
  SystemMonitorRequestContextService,
} from './system-monitor-request-context.service';

interface InFlightCommand {
  startedAt: number;
  database: string;
  collection: string;
  command: string;
  requestContext?: SystemMonitorRequestContext;
}
interface OperationMetric {
  database: string; collection: string; command: string; count: number; failures: number;
  slow: number; lastDurationMs: number; averageDurationMs: number; lastAt?: Date;
}
interface RecentDatabaseOperation { database: string; collection: string; command: string; durationMs: number; status: 'SUCCESS' | 'FAILED'; occurredAt: Date; message?: string; }
interface MongoPoolMetric {
  address: string;
  state: 'INITIALIZING' | 'READY' | 'CLEARED' | 'CLOSED';
  created: number; ready: number; cleared: number; closed: number;
  connectionsCreated: number; connectionsReady: number; connectionsClosed: number;
  checkoutStarted: number; checkoutSucceeded: number; checkoutFailed: number; checkedIn: number;
  options: Record<string, number | null>;
  inUseConnectionIds: Set<string>;
  checkoutDurations: number[];
  checkoutFailureReasons: Map<string, number>;
  lastEventAt?: Date;
}
const SLOW_OPERATION_MS = 500;
const MAX_TRACKED_KEYS = 300;
const MAX_IN_FLIGHT = 2000;
const MAX_RECENT = 100;
const MAX_DURATION_SAMPLES = 200;
const MAX_TRACKED_POOLS = 16;
const MAX_POOL_DURATION_SAMPLES = 200;
const TRACKED_COMMANDS = new Set(['find', 'findAndModify', 'aggregate', 'count', 'distinct', 'insert', 'update', 'delete', 'bulkWrite', 'create', 'drop', 'createIndexes', 'deleteIndexes', 'getMore', 'killCursors']);

/** Captures MongoDB driver command telemetry in memory; query payloads are never retained. */
@Injectable()
export class SystemMonitorDatabaseTrackerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SystemMonitorDatabaseTrackerService.name);
  private client?: MongoClient;
  private readonly inFlight = new Map<number, InFlightCommand>();
  private readonly metrics = new Map<string, OperationMetric>();
  private readonly durationSamples = new Map<string, number[]>();
  private readonly recent: RecentDatabaseOperation[] = [];
  private readonly poolMetrics = new Map<string, MongoPoolMetric>();
  private poolMonitoringStartedAt?: Date;
  private readonly poolEventHandlers: Record<string, (event: any) => void> = {
    connectionPoolCreated: (event) => this.onPoolCreated(event),
    connectionPoolReady: (event) => this.onPoolReady(event),
    connectionPoolCleared: (event) => this.onPoolCleared(event),
    connectionPoolClosed: (event) => this.onPoolClosed(event),
    connectionCreated: (event) => this.onConnectionCreated(event),
    connectionReady: (event) => this.onConnectionReady(event),
    connectionClosed: (event) => this.onConnectionClosed(event),
    connectionCheckOutStarted: (event) => this.onCheckoutStarted(event),
    connectionCheckOutFailed: (event) => this.onCheckoutFailed(event),
    connectionCheckedOut: (event) => this.onCheckedOut(event),
    connectionCheckedIn: (event) => this.onCheckedIn(event),
  };
  private readonly commandStarted = (event: any) => this.onCommandStarted(event);
  private readonly commandSucceeded = (event: any) => this.onCommandSucceeded(event);
  private readonly commandFailed = (event: any) => this.onCommandFailed(event);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly systemMonitor: SystemMonitorService,
    private readonly requestContext?: SystemMonitorRequestContextService,
  ) {}

  onApplicationBootstrap(): void {
    try {
      this.client = this.connection.getClient();
      this.client.on('commandStarted', this.commandStarted);
      this.client.on('commandSucceeded', this.commandSucceeded);
      this.client.on('commandFailed', this.commandFailed);
      this.poolMonitoringStartedAt = new Date();
      for (const [eventName, handler] of Object.entries(this.poolEventHandlers)) {
        (this.client as any).on(eventName, handler);
      }
      this.systemMonitor.reportModuleHealth('database-operations', 'HEALTHY', { source: 'mongodb-driver', message: 'MongoDB command and connection-pool telemetry are attached.' });
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
    for (const [eventName, handler] of Object.entries(this.poolEventHandlers)) {
      (this.client as any).off(eventName, handler);
    }
    this.inFlight.clear();
    this.durationSamples.clear();
    this.poolMetrics.clear();
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

  /**
   * Returns latency percentiles separately from getOperations() so the
   * existing database-operations response shape remains unchanged.
   */
  getLatencyMetrics(options: { limit?: number; collection?: string } = {}) {
    const limit = Number.isFinite(options.limit)
      ? Math.max(1, Math.min(100, Math.floor(options.limit!)))
      : 50;

    const aggregates = [...this.metrics.entries()]
      .filter(([, metric]) =>
        !options.collection || metric.collection === options.collection,
      )
      .map(([key, metric]) => {
        const sortedSamples = [
          ...(this.durationSamples.get(key) ?? []),
        ].sort((a, b) => a - b);

        return {
          database: metric.database,
          collection: metric.collection,
          command: metric.command,
          count: metric.count,
          failures: metric.failures,
          slow: metric.slow,
          lastDurationMs: metric.lastDurationMs,
          averageDurationMs: metric.averageDurationMs,
          p50DurationMs: this.percentile(sortedSamples, 0.5),
          p95DurationMs: this.percentile(sortedSamples, 0.95),
          p99DurationMs: this.percentile(sortedSamples, 0.99),
          sampleWindowOperations: sortedSamples.length,
          lastAt: metric.lastAt,
        };
      })
      .sort(
        (a, b) =>
          b.p95DurationMs - a.p95DurationMs ||
          b.count - a.count,
      );

    return {
      generatedAt: new Date(),
      slowThresholdMs: SLOW_OPERATION_MS,
      maxSamplesPerAggregate: MAX_DURATION_SAMPLES,
      trackedAggregates: this.metrics.size,
      aggregates: aggregates.slice(0, limit),
    };
  }

  /**
   * Returns bounded, in-memory MongoDB connection-pool telemetry.
   * Server addresses and connection identifiers are intentionally omitted.
   */
  getPoolMetrics() {
    const pools = [...this.poolMetrics.values()].map((pool, index) => {
      const durations = [...pool.checkoutDurations].sort((a, b) => a - b);
      const average = durations.length
        ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        : 0;
      const maxPoolSize = pool.options.maxPoolSize;
      return {
        poolId: `pool-${index + 1}`,
        state: pool.state,
        options: { ...pool.options },
        poolEvents: {
          created: pool.created,
          ready: pool.ready,
          cleared: pool.cleared,
          closed: pool.closed,
        },
        connectionEvents: {
          created: pool.connectionsCreated,
          ready: pool.connectionsReady,
          closed: pool.connectionsClosed,
          checkedOutObserved: pool.checkoutSucceeded,
          checkedInObserved: pool.checkedIn,
          inUseObserved: pool.inUseConnectionIds.size,
        },
        checkout: {
          started: pool.checkoutStarted,
          succeeded: pool.checkoutSucceeded,
          failed: pool.checkoutFailed,
          failureReasons: Object.fromEntries(pool.checkoutFailureReasons),
          sampleWindowSize: durations.length,
          averageRecentWaitMs: average,
          p50WaitMs: this.percentile(durations, 0.5),
          p95WaitMs: this.percentile(durations, 0.95),
          p99WaitMs: this.percentile(durations, 0.99),
        },
        observedUtilizationPercent:
          typeof maxPoolSize === 'number' && maxPoolSize > 0
            ? Number(((pool.inUseConnectionIds.size / maxPoolSize) * 100).toFixed(2))
            : null,
        lastEventAt: pool.lastEventAt,
      };
    });

    return {
      generatedAt: new Date(),
      monitoringActive: Boolean(this.client),
      monitoringStartedAt: this.poolMonitoringStartedAt ?? null,
      trackedPools: pools.length,
      maxTrackedPools: MAX_TRACKED_POOLS,
      maxCheckoutDurationSamplesPerPool: MAX_POOL_DURATION_SAMPLES,
      totals: pools.reduce(
        (total, pool) => ({
          checkoutStarted: total.checkoutStarted + pool.checkout.started,
          checkoutSucceeded: total.checkoutSucceeded + pool.checkout.succeeded,
          checkoutFailed: total.checkoutFailed + pool.checkout.failed,
          inUseObserved: total.inUseObserved + pool.connectionEvents.inUseObserved,
        }),
        { checkoutStarted: 0, checkoutSucceeded: 0, checkoutFailed: 0, inUseObserved: 0 },
      ),
      pools,
      notes: [
        'Counters and latency samples are in-memory observations since monitoring started; they reset when this backend process restarts.',
        'The in-use count reflects observed checkout/check-in events, not a separate live driver pool inspection.',
        'Checkout latency percentiles use the most recent bounded sample window for each pool.',
        'Pool addresses and connection identifiers are intentionally omitted.',
        'No MongoDB pool settings are changed by this telemetry.',
      ],
    };
  }

  private getOrCreatePool(event: any): MongoPoolMetric | undefined {
    const address = typeof event?.address === 'string' && event.address
      ? event.address
      : 'unknown';
    let pool = this.poolMetrics.get(address);
    if (!pool) {
      if (this.poolMetrics.size >= MAX_TRACKED_POOLS) {
        const oldestKey = this.poolMetrics.keys().next().value;
        if (typeof oldestKey === 'string') this.poolMetrics.delete(oldestKey);
      }
      pool = {
        address,
        state: 'INITIALIZING',
        created: 0,
        ready: 0,
        cleared: 0,
        closed: 0,
        connectionsCreated: 0,
        connectionsReady: 0,
        connectionsClosed: 0,
        checkoutStarted: 0,
        checkoutSucceeded: 0,
        checkoutFailed: 0,
        checkedIn: 0,
        options: {
          maxPoolSize: null,
          minPoolSize: null,
          maxConnecting: null,
          maxIdleTimeMS: null,
          waitQueueTimeoutMS: null,
        },
        inUseConnectionIds: new Set<string>(),
        checkoutDurations: [],
        checkoutFailureReasons: new Map<string, number>(),
      };
      this.poolMetrics.set(address, pool);
    }
    pool.lastEventAt = event?.time instanceof Date ? event.time : new Date();
    return pool;
  }

  private onPoolCreated(event: any): void {
    const pool = this.getOrCreatePool(event);
    if (!pool) return;
    pool.created += 1;
    pool.state = 'INITIALIZING';
    const options = event?.options && typeof event.options === 'object' ? event.options : {};
    for (const key of Object.keys(pool.options)) {
      const value = options[key];
      pool.options[key] = Number.isFinite(value) ? Number(value) : null;
    }
  }

  private onPoolReady(event: any): void {
    const pool = this.getOrCreatePool(event);
    if (pool) { pool.ready += 1; pool.state = 'READY'; }
  }

  private onPoolCleared(event: any): void {
    const pool = this.getOrCreatePool(event);
    if (pool) { pool.cleared += 1; pool.state = 'CLEARED'; }
  }

  private onPoolClosed(event: any): void {
    const pool = this.getOrCreatePool(event);
    if (pool) { pool.closed += 1; pool.state = 'CLOSED'; }
  }

  private onConnectionCreated(event: any): void {
    const pool = this.getOrCreatePool(event);
    if (pool) pool.connectionsCreated += 1;
  }

  private onConnectionReady(event: any): void {
    const pool = this.getOrCreatePool(event);
    if (pool) pool.connectionsReady += 1;
  }

  private onConnectionClosed(event: any): void {
    const pool = this.getOrCreatePool(event);
    if (!pool) return;
    pool.connectionsClosed += 1;
    if (event?.connectionId !== undefined) {
      pool.inUseConnectionIds.delete(String(event.connectionId));
    }
  }

  private onCheckoutStarted(event: any): void {
    const pool = this.getOrCreatePool(event);
    if (pool) pool.checkoutStarted += 1;
  }

  private onCheckoutFailed(event: any): void {
    const pool = this.getOrCreatePool(event);
    if (!pool) return;
    pool.checkoutFailed += 1;
    const reason = String(event?.reason ?? 'unknown').slice(0, 80);
    pool.checkoutFailureReasons.set(reason, (pool.checkoutFailureReasons.get(reason) ?? 0) + 1);
    this.recordCheckoutDuration(pool, event);
  }

  private onCheckedOut(event: any): void {
    const pool = this.getOrCreatePool(event);
    if (!pool) return;
    pool.checkoutSucceeded += 1;
    if (event?.connectionId !== undefined) {
      pool.inUseConnectionIds.add(String(event.connectionId));
    }
    this.recordCheckoutDuration(pool, event);
  }

  private onCheckedIn(event: any): void {
    const pool = this.getOrCreatePool(event);
    if (!pool) return;
    pool.checkedIn += 1;
    if (event?.connectionId !== undefined) {
      pool.inUseConnectionIds.delete(String(event.connectionId));
    }
  }

  private recordCheckoutDuration(pool: MongoPoolMetric, event: any): void {
    const duration = Number(event?.durationMS ?? event?.duration);
    if (!Number.isFinite(duration) || duration < 0) return;
    pool.checkoutDurations.push(duration);
    if (pool.checkoutDurations.length > MAX_POOL_DURATION_SAMPLES) {
      pool.checkoutDurations.shift();
    }
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
    const requestContext =
      this.requestContext?.recordDatabaseOperationStarted();

    this.inFlight.set(event.requestId, {
      startedAt: Date.now(),
      database: String(event.databaseName ?? this.connection.name ?? 'unknown'),
      collection,
      command: commandName,
      requestContext,
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
    this.requestContext?.recordDatabaseOperationCompleted(
      command.requestContext,
      durationMs,
      !success,
      SLOW_OPERATION_MS,
    );

    const key = `${command.database}:${command.collection}:${command.command}`;
    let item = this.metrics.get(key);
    if (!item) {
      item = {
        database: command.database,
        collection: command.collection,
        command: command.command,
        count: 0,
        failures: 0,
        slow: 0,
        lastDurationMs: 0,
        averageDurationMs: 0,
      };
      this.metrics.set(key, item);
    }

    const samples = this.durationSamples.get(key) ?? [];
    samples.push(Math.max(0, durationMs));
    if (samples.length > MAX_DURATION_SAMPLES) samples.shift();
    this.durationSamples.set(key, samples);

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
      if (oldest) {
        this.metrics.delete(oldest[0]);
        this.durationSamples.delete(oldest[0]);
      }
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

  /**
   * Backward-compatible shape for the original Stage 0 pool endpoint.
   * The Stage 7 getPoolMetrics() response remains the canonical endpoint shape.
   */
  getConnectionPoolMetrics() {
    const current = this.getPoolMetrics();
    const pools = current.pools.map((pool) => {
      const waiting = Math.max(
        0,
        pool.checkout.started - pool.checkout.succeeded - pool.checkout.failed,
      );
      return {
        poolId: pool.poolId,
        state: pool.state === 'READY' ? 'OPEN' : pool.state,
        connectionsCreated: pool.connectionEvents.created,
        connectionsReady: pool.connectionEvents.ready,
        connectionsClosed: pool.connectionEvents.closed,
        checkedOut: pool.connectionEvents.inUseObserved,
        waiting,
        checkoutStarted: pool.checkout.started,
        checkoutSucceeded: pool.checkout.succeeded,
        checkoutFailed: pool.checkout.failed,
        checkedIn: pool.connectionEvents.checkedInObserved,
        poolClears: pool.poolEvents.cleared,
        maxObservedWaiters: waiting,
        lastEventAt: pool.lastEventAt,
      };
    });
    const totals = pools.reduce(
      (result, pool) => ({
        connectionsReady: result.connectionsReady + pool.connectionsReady,
        checkedOut: result.checkedOut + pool.checkedOut,
        waiting: result.waiting + pool.waiting,
        checkoutStarted: result.checkoutStarted + pool.checkoutStarted,
        checkoutSucceeded: result.checkoutSucceeded + pool.checkoutSucceeded,
        checkoutFailed: result.checkoutFailed + pool.checkoutFailed,
        checkedIn: result.checkedIn + pool.checkedIn,
        poolClears: result.poolClears + pool.poolClears,
        maxObservedWaiters: Math.max(result.maxObservedWaiters, pool.maxObservedWaiters),
      }),
      {
        connectionsReady: 0, checkedOut: 0, waiting: 0, checkoutStarted: 0,
        checkoutSucceeded: 0, checkoutFailed: 0, checkedIn: 0, poolClears: 0,
        maxObservedWaiters: 0,
      },
    );
    const clientOptions = (this.client as any)?.options ?? {};
    const configuredMaxPoolSize = Number.isFinite(clientOptions.maxPoolSize)
      && clientOptions.maxPoolSize > 0
      ? Math.floor(clientOptions.maxPoolSize)
      : null;
    const activePools = pools.filter((pool) => pool.state !== 'CLOSED').length;
    const configuredCapacityAcrossObservedPools =
      configuredMaxPoolSize && activePools > 0
        ? configuredMaxPoolSize * activePools
        : null;

    return {
      generatedAt: current.generatedAt,
      observationStartedAt: current.monitoringStartedAt,
      clientReady: current.monitoringActive,
      configuredMaxPoolSize,
      poolCount: pools.length,
      totals: {
        ...totals,
        configuredCapacityAcrossObservedPools,
        utilizationPercent: configuredCapacityAcrossObservedPools
          ? Number(((totals.checkedOut / configuredCapacityAcrossObservedPools) * 100).toFixed(2))
          : null,
      },
      pools,
      notes: [
        'Compatibility view of Stage 7 pool events using the original Stage 0 response field names.',
        'Waiting counts are derived from checkout-started, succeeded and failed events observed by this process.',
        'No MongoDB pool settings are changed by this compatibility view.',
      ],
    };
  }

  private percentile(sortedSamples: number[], percentile: number): number {
    if (sortedSamples.length === 0) return 0;

    const index = Math.max(
      0,
      Math.ceil(percentile * sortedSamples.length) - 1,
    );

    return Math.round(sortedSamples[index]);
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
