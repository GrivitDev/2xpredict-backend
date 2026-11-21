import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Mutable telemetry scoped to one HTTP request. It never contains user data. */
export interface SystemMonitorRequestContext {
  module: string;
  operation: string;
  databaseOperations: number;
  databaseCompletedOperations: number;
  databaseDurationMs: number;
  slowDatabaseOperations: number;
  databaseFailures: number;
}

@Injectable()
export class SystemMonitorRequestContextService {
  private readonly storage =
    new AsyncLocalStorage<SystemMonitorRequestContext>();

  run<T>(context: SystemMonitorRequestContext, callback: () => T): T {
    return this.storage.run(context, callback);
  }

  getCurrent(): SystemMonitorRequestContext | undefined {
    return this.storage.getStore();
  }

  recordDatabaseOperationStarted(): SystemMonitorRequestContext | undefined {
    const context = this.storage.getStore();
    if (context) context.databaseOperations += 1;
    return context;
  }

  recordDatabaseOperationCompleted(
    context: SystemMonitorRequestContext | undefined,
    durationMs: number,
    failed: boolean,
    slowThresholdMs: number,
  ): void {
    if (!context) return;

    const safeDuration = Number.isFinite(durationMs)
      ? Math.max(0, durationMs)
      : 0;

    context.databaseCompletedOperations += 1;
    context.databaseDurationMs += safeDuration;
    if (safeDuration >= slowThresholdMs) {
      context.slowDatabaseOperations += 1;
    }
    if (failed) context.databaseFailures += 1;
  }
}
