import { Injectable } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OnModuleInit } from '@nestjs/common';
import { AdminGateway } from '../realtime/admin.gateway';
import {
  getSystemMonitorDefaultCritical,
  getSystemMonitorDefaultMonitoringLevel,
  getSystemMonitorModuleDefinition,
  normalizeSystemMonitorModuleKey,
  SYSTEM_MONITOR_MODULE_REGISTRY,
} from './system-monitor-module-registry';
import type {
  SystemMonitorModuleCategory,
  SystemMonitorProbeMode,
  SystemMonitorExternalProbeMode,
} from './system-monitor-module-registry';

export type SystemMonitorCronStatus =
  | 'REGISTERED'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'IDLE';
export type ModuleHealthStatus = 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'UNKNOWN';
export type ModuleMonitoringLevel = 'deep' | 'health';

export interface SystemMonitorCronDefinition {
  key: string;
  module: string;
  name: string;
  expression?: string;
  timeZone?: string;
  enabled?: boolean;
}
export interface SystemMonitorError {
  module: string;
  source: string;
  operation: string;
  message: string;
  occurredAt: Date;
  stack?: string;
  referenceKey?: string;
}
export interface SystemMonitorActivity {
  module: string;
  source: string;
  operation: string;
  status: 'STARTED' | 'SUCCESS' | 'FAILED' | 'INFO';
  message: string;
  occurredAt: Date;
  durationMs?: number;
  referenceKey?: string;
}

/** Common input contract used by every module-local operational monitor. */
export interface SystemMonitorModuleSnapshot {
  status: string;
  checkedAt?: Date | string;
  warnings?: readonly unknown[];
  checks?: readonly unknown[];
  details?: Record<string, unknown>;
}
export interface SystemMonitorCronView {
  key: string;
  module: string;
  name: string;
  expression?: string;
  timeZone?: string;
  enabled: boolean;
  status: SystemMonitorCronStatus;
  lastStartedAt?: Date;
  lastSuccessfulAt?: Date;
  lastFailedAt?: Date;
  lastDurationMs?: number;
  consecutiveFailures: number;
  lastError?: string;
  scheduler: {
    active: boolean;
    callbackRunning: boolean;
    lastRunAt?: Date;
    nextRunAt?: Date;
  };
}
export interface ModuleDependencyHealthView {
  module: string;
  status: ModuleHealthStatus;
  critical: boolean;
  kind: 'module-import' | 'data' | 'runtime';
}
export interface ModuleHealthView {
  module: string;
  status: ModuleHealthStatus;
  monitoringLevel: ModuleMonitoringLevel;
  critical: boolean;
  category: SystemMonitorModuleCategory | 'unclassified';
  description: string;
  probeMode: SystemMonitorProbeMode | 'UNCLASSIFIED';
  moduleImports?: string[];
  dataDependencies?: string[];
  runtimeDependencies?: string[];
  actualModuleImports?: string[];
  missingModuleImports?: string[];
  unexpectedModuleImports?: string[];
  observedStatus?: ModuleHealthStatus;
  healthIsStale?: boolean;
  healthAgeMs?: number;
  healthFreshnessMs?: number;
  externalProbeMode?: SystemMonitorExternalProbeMode;
  dependencies: ModuleDependencyHealthView[];
  externalDependencies: string[];
  dependencyStatus: ModuleHealthStatus;
  dependencyIssues: ModuleDependencyHealthView[];
  message: string;
  source: string;
  checkedAt: Date;
  lastSuccessfulAt?: Date;
  lastFailedAt?: Date;
  consecutiveFailures: number;
  activeOperations: number;
  requests: number;
  requestFailures: number;
  averageDurationMs: number;
  lastDurationMs?: number;
  lastActivityAt?: Date;
  lastOperation?: string;
  details?: Record<string, unknown>;
}
interface CronRuntimeState extends Omit<SystemMonitorCronView, 'scheduler'> {}

const DEEP_MODULES = new Set(
  SYSTEM_MONITOR_MODULE_REGISTRY
    .filter((definition) => definition.monitoringLevel === 'deep')
    .map((definition) => definition.module),
);
const TELEMETRY_MODULES = new Set([
  'payments',
  'payment-gateways',
  'subscriptions',
  'plan-config',
]);

@Injectable()
export class SystemMonitorService implements OnModuleInit {
  private readonly startedAt = new Date();
  private readonly cronStates = new Map<string, CronRuntimeState>();
  private readonly recentErrors: SystemMonitorError[] = [];
  private readonly recentActivity: SystemMonitorActivity[] = [];
  private readonly moduleHealth = new Map<string, ModuleHealthView>();
  private discoveredModules = new Set<string>();
  private discoveredModuleImports = new Map<string, Set<string>>();
  private readonly monitorErrorDedupUntil = new Map<string, number>();
  private readonly MAX_MONITOR_ERROR_KEYS = 300;
  private readonly MONITOR_ERROR_DEDUP_MS = 5 * 60_000;
  private readonly MAX_ERRORS = 100;
  private readonly MAX_ACTIVITY = 200;
  private readonly MAX_MODULES = 100;

  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly adminGateway: AdminGateway,
  ) {
    this.registerModule('application', 'health', false);
    this.registerModule('database', 'deep', true);
  }

  onModuleInit(): void {
    this.adminGateway.registerModule('system-monitor', {
      message:
        'System Monitor service initialized; health, errors and activity are streamed to admin clients.',
      operationalStatus: 'READY',
    });
    this.adminGateway.registerModule('database', {
      message:
        'Database telemetry is connected; operational health will follow driver health checks.',
      operationalStatus: 'UNKNOWN',
    });
    this.reportModuleHealth('system-monitor', 'HEALTHY', {
      source: 'system-monitor-lifecycle',
      message: 'Central System Monitor initialized and realtime health reporting is available.',
    });
  }

  registerModule(
    moduleName: string,
    level?: ModuleMonitoringLevel,
    critical?: boolean,
  ): void {
    const key = this.normalizeModule(moduleName);
    if (!key) return;
    const definition = getSystemMonitorModuleDefinition(key);
    const current = this.moduleHealth.get(key);
    if (current) {
      // Classification is canonical and may be applied after an early worker or
      // monitor has already registered the module.
      this.moduleHealth.set(key, {
        ...current,
        monitoringLevel: definition?.monitoringLevel ?? level ?? current.monitoringLevel,
        critical: definition?.critical ?? critical ?? current.critical,
        category: definition?.category ?? current.category,
        description: definition?.description ?? current.description,
        probeMode: definition?.probeMode ?? current.probeMode,
        externalDependencies: definition ? [...definition.externalDependencies] : current.externalDependencies,
      });
      return;
    }
    const now = new Date();
    this.moduleHealth.set(key, {
      module: key,
      status: 'UNKNOWN',
      monitoringLevel: getSystemMonitorModuleDefinition(key)?.monitoringLevel ?? level ?? getSystemMonitorDefaultMonitoringLevel(key),
      critical: getSystemMonitorModuleDefinition(key)?.critical ?? critical ?? getSystemMonitorDefaultCritical(key),
      category: definition?.category ?? 'unclassified',
      description: definition?.description ?? 'Module discovered at runtime; no classification entry exists.',
      probeMode: definition?.probeMode ?? 'UNCLASSIFIED',
      dependencies: [],
      externalDependencies: definition ? [...definition.externalDependencies] : [],
      dependencyStatus: 'UNKNOWN',
      dependencyIssues: [],
      message: 'Awaiting first health check.',
      source: 'registry',
      checkedAt: now,
      consecutiveFailures: 0,
      activeOperations: 0,
      requests: 0,
      requestFailures: 0,
      averageDurationMs: 0,
    });
    this.trimModules();
  }

  /** Records discovered Nest modules without overwriting earlier health results. */
  setDiscoveredModules(moduleNames: readonly string[]): void {
    this.discoveredModules = new Set(
      moduleNames.map((name) => this.normalizeModule(name)).filter(Boolean),
    );
    for (const name of this.discoveredModules) this.registerModule(name);
  }

  /**
   * Records actual Nest module imports. Duplicate monitoring aliases (for
   * example SportsModule and SportsDataModule) are merged into one domain node.
   */
  setDiscoveredModuleGraph(
    entries: readonly { module: string; imports: readonly string[] }[],
  ): void {
    const discovered = new Set<string>(['database', 'application']);
    const graph = new Map<string, Set<string>>();

    for (const entry of entries) {
      const module = this.normalizeModule(entry.module);
      if (!module) continue;
      discovered.add(module);
      const imports = graph.get(module) ?? new Set<string>();
      for (const importedName of entry.imports ?? []) {
        const imported = this.normalizeModule(importedName);
        if (imported && imported !== module) imports.add(imported);
      }
      graph.set(module, imports);
    }

    this.discoveredModuleImports = graph;
    this.setDiscoveredModules([...discovered]);
  }

  reportModuleHealth(
    moduleName: string,
    status: ModuleHealthStatus,
    options: {
      message?: string;
      source?: string;
      details?: Record<string, unknown>;
      checkedAt?: Date;
    } = {},
  ): void {
    const key = this.normalizeModule(moduleName);
    this.registerModule(key);
    const previous = this.moduleHealth.get(key)!;
    const checkedAt = options.checkedAt ?? new Date();
    // An older asynchronous probe must never overwrite a newer health result.
    if (checkedAt.getTime() < previous.checkedAt.getTime()) return;
    const failed = status === 'FAILED' || status === 'DEGRADED';
    const nextMessage = this.safeTelemetryText(
      options.message ?? previous.message,
      500,
    );
    const statusChanged =
      previous.status !== status || previous.message !== nextMessage;
    this.moduleHealth.set(key, {
      ...previous,
      status,
      message: nextMessage,
      source: options.source ?? previous.source,
      checkedAt,
      lastSuccessfulAt:
        status === 'HEALTHY' ? checkedAt : previous.lastSuccessfulAt,
      lastFailedAt: failed ? checkedAt : previous.lastFailedAt,
      consecutiveFailures: failed
        ? previous.consecutiveFailures + 1
        : status === 'HEALTHY'
          ? 0
          : previous.consecutiveFailures,
      details: options.details
        ? this.safeDetails(options.details)
        : previous.details,
    });
    const realtimeStatus =
      status === 'HEALTHY'
        ? 'READY'
        : status === 'DEGRADED'
          ? 'DEGRADED'
          : status === 'FAILED'
            ? 'FAILED'
            : 'UNKNOWN';
    this.adminGateway.setModuleOperationalStatus(
      key,
      realtimeStatus,
      nextMessage,
      options.details,
    );
    if (statusChanged)
      this.adminGateway.publishModuleEvent(
        'system-monitor',
        'system:module-health',
        {
          module: key,
          status,
          message: nextMessage,
          source: options.source ?? previous.source,
          checkedAt: checkedAt.toISOString(),
          details: options.details,
        },
      );
  }

  /**
   * Normalizes a module-local monitor snapshot into the central health model.
   * Detailed monitor payloads remain with their owning module; only compact,
   * payload-free health summaries and failed check metadata are forwarded here.
   */
  reportMonitorSnapshot(
    moduleName: string,
    snapshot: SystemMonitorModuleSnapshot,
  ): void {
    const module = this.normalizeModule(moduleName);
    this.registerModule(module);

    const checkedAt = this.toMonitorDate(snapshot.checkedAt) ?? new Date();
    const currentSnapshot = this.moduleHealth.get(module);
    // Ignore a delayed monitor result before it can add stale errors or activity.
    if (currentSnapshot && checkedAt.getTime() < currentSnapshot.checkedAt.getTime()) return;
    const rawStatus = String(snapshot.status ?? 'UNKNOWN').trim().toUpperCase();
    const status: ModuleHealthStatus =
      ['HEALTHY', 'OK', 'SUCCESS', 'READY'].includes(rawStatus)
        ? 'HEALTHY'
        : ['DEGRADED', 'WARN', 'WARNING'].includes(rawStatus)
          ? 'DEGRADED'
          : ['FAILED', 'FAIL', 'ERROR', 'CRITICAL', 'STOPPED'].includes(rawStatus)
            ? 'FAILED'
            : 'UNKNOWN';

    const checkRows = (snapshot.checks ?? []).map((item, index) => {
      const row = this.asRecord(item);
      const checkStatus = String(row.status ?? row.severity ?? '').toUpperCase();
      const name = this.safeTelemetryText(
        String(row.name ?? row.code ?? row.operation ?? `check-${index + 1}`),
        100,
      );
      const message = this.safeTelemetryText(
        String(row.error ?? row.message ?? ''),
        500,
      );
      return { name, status: checkStatus, message };
    });

    const failedChecks = checkRows.filter((item) =>
      ['FAILED', 'FAIL', 'ERROR', 'CRITICAL'].includes(item.status),
    );
    const warningChecks = checkRows.filter((item) =>
      ['DEGRADED', 'WARN', 'WARNING'].includes(item.status),
    );
    const warnings = (snapshot.warnings ?? [])
      .map((item) => {
        if (typeof item === 'string') return this.safeTelemetryText(item, 300);
        const row = this.asRecord(item);
        return this.safeTelemetryText(
          String(row.message ?? row.error ?? row.code ?? ''),
          300,
        );
      })
      .filter(Boolean);

    const message =
      status === 'HEALTHY'
        ? `${module} operational monitor checks are healthy.`
        : status === 'DEGRADED'
          ? `${module} operational monitor detected warnings or degraded checks.`
          : status === 'FAILED'
            ? `${module} operational monitor detected critical failures or could not complete its probe.`
            : `${module} operational status has not yet been verified.`;

    const details: Record<string, unknown> = {
      ...(snapshot.details ?? {}),
      monitorCheckCount: checkRows.length,
      monitorFailedCheckCount: failedChecks.length,
      monitorWarningCheckCount: warningChecks.length,
      monitorWarningCount: warnings.length,
      monitorFailedCheckNames: failedChecks
        .map((item) => item.name)
        .slice(0, 10)
        .join(', '),
      monitorWarningSummary: warnings.slice(0, 3).join(' | '),
    };

    // A single failing check is enough to create an error record, but repeat
    // snapshots of the same failure are rate-limited in memory.
    const errorRows = failedChecks.length
      ? failedChecks
      : status === 'FAILED'
        ? [{
            name: 'operational-health',
            status: 'FAILED',
            message: message,
          }]
        : [];

    for (const item of errorRows.slice(0, 10)) {
      const errorMessage = item.message || `${item.name} failed.`;
      const dedupKey = `${module}|${item.name}|${errorMessage}`;
      const until = this.monitorErrorDedupUntil.get(dedupKey) ?? 0;
      if (until > checkedAt.getTime()) continue;
      this.monitorErrorDedupUntil.set(
        dedupKey,
        checkedAt.getTime() + this.MONITOR_ERROR_DEDUP_MS,
      );
      this.reportError({
        module,
        source: 'local-monitor',
        operation: item.name,
        message: errorMessage,
        occurredAt: checkedAt,
        referenceKey: `${module}:${item.name}`,
      });
    }

    // reportError() also updates the Admin Gateway; report the normalized
    // snapshot afterwards so FAILED remains FAILED rather than DEGRADED.
    const previousStatus = this.moduleHealth.get(module)?.status ?? 'UNKNOWN';
    this.reportModuleHealth(module, status, {
      source: 'local-monitor',
      message,
      checkedAt,
      details,
    });

    if (previousStatus !== status) {
      this.reportActivity({
        module,
        source: 'local-monitor',
        operation: 'health-check',
        status:
          status === 'HEALTHY'
            ? 'SUCCESS'
            : status === 'FAILED'
              ? 'FAILED'
              : 'INFO',
        message,
        occurredAt: checkedAt,
        referenceKey: `${module}:health`,
      });
    }

    // Bound the in-memory deduplication map and discard expired keys.
    if (this.monitorErrorDedupUntil.size > this.MAX_MONITOR_ERROR_KEYS) {
      for (const [key, expiresAt] of this.monitorErrorDedupUntil) {
        if (expiresAt <= checkedAt.getTime() || this.monitorErrorDedupUntil.size > this.MAX_MONITOR_ERROR_KEYS) {
          this.monitorErrorDedupUntil.delete(key);
        }
        if (this.monitorErrorDedupUntil.size <= this.MAX_MONITOR_ERROR_KEYS) break;
      }
    }
  }

  /** Wraps an important background operation without changing its result/error semantics. */
  async trackOperation<T>(
    moduleName: string,
    source: string,
    operationName: string,
    operation: () => Promise<T> | T,
    options: {
      logSuccess?: boolean;
      referenceKey?: string;
      isExpectedFailure?: (error: unknown) => boolean;
    } = {},
  ): Promise<T> {
    const module = this.normalizeModule(moduleName);
    this.registerModule(module);
    const startedAt = Date.now();
    const current = this.moduleHealth.get(module)!;
    this.moduleHealth.set(module, {
      ...current,
      activeOperations: current.activeOperations + 1,
      lastActivityAt: new Date(),
      lastOperation: operationName,
    });
    try {
      const result = await operation();
      const durationMs = Date.now() - startedAt;
      this.finishOperation(module, durationMs, true, operationName, false);
      if (options.logSuccess)
        this.reportActivity({
          module,
          source,
          operation: operationName,
          status: 'SUCCESS',
          message: `${operationName} completed.`,
          occurredAt: new Date(),
          durationMs,
          referenceKey: options.referenceKey,
        });
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = this.getErrorMessage(error);
      const expectedFailure = options.isExpectedFailure?.(error) === true;
      this.finishOperation(
        module,
        durationMs,
        false,
        operationName,
        expectedFailure,
      );
      if (!expectedFailure) {
        this.reportError({
          module,
          source,
          operation: operationName,
          message,
          occurredAt: new Date(),
          stack: this.getErrorStack(error),
          referenceKey: options.referenceKey,
        });
        this.reportActivity({
          module,
          source,
          operation: operationName,
          status: 'FAILED',
          message: `${operationName} failed: ${message}`,
          occurredAt: new Date(),
          durationMs,
          referenceKey: options.referenceKey,
        });
      } else {
        this.reportActivity({
          module,
          source,
          operation: operationName,
          status: 'INFO',
          message: `${operationName} returned a client error.`,
          occurredAt: new Date(),
          durationMs,
        });
      }
      throw error;
    }
  }

  reportRuntimeMetrics(metrics: Record<string, number>): void {
    this.registerModule('application', 'health', false);
    const current = this.moduleHealth.get('application')!;
    const checkedAt = new Date();
    const next = {
      ...current,
      source: 'runtime-sampler',
      message:
        'Process and event-loop metrics sampled; operational health is tracked separately.',
      checkedAt,
      details: { ...(current.details ?? {}), ...this.safeDetails(metrics) },
    };
    this.moduleHealth.set('application', next);
  }

  /** In-memory request metrics: no per-request MongoDB writes and no payload/PII capture. */
  recordHttpRequest(
    moduleName: string,
    operation: string,
    statusCode: number,
    durationMs: number,
  ): void {
    const module = this.normalizeModule(moduleName);
    this.registerModule(module);
    const current = this.moduleHealth.get(module)!;
    const requests = current.requests + 1;
    const failures = current.requestFailures + (statusCode >= 500 ? 1 : 0);
    const averageDurationMs = Math.round(
      (current.averageDurationMs * current.requests + Math.max(0, durationMs)) /
        requests,
    );
    this.moduleHealth.set(module, {
      ...current,
      requests,
      requestFailures: failures,
      averageDurationMs,
      lastDurationMs: Math.max(0, durationMs),
      lastActivityAt: new Date(),
      lastOperation: operation,
    });
    if (statusCode >= 500) {
      this.reportModuleHealth(module, 'DEGRADED', {
        source: 'http',
        message: `HTTP ${statusCode} from ${operation}.`,
      });
      if (failures === 1 || failures % 10 === 0) {
        this.reportError({
          module,
          source: 'http',
          operation,
          message: `HTTP ${statusCode}`,
          occurredAt: new Date(),
        });
      }
    }

    // Keep a bounded, payload-free activity trail for operational modules.
    // HTTP success is evidence of a completed request, not a health probe.
    if (TELEMETRY_MODULES.has(module) || DEEP_MODULES.has(module)) {
      this.reportActivity({
        module,
        source: 'http',
        operation,
        status:
          statusCode >= 500 ? 'FAILED' : statusCode >= 400 ? 'INFO' : 'SUCCESS',
        message:
          statusCode >= 500
            ? `Request failed with HTTP ${statusCode}.`
            : statusCode >= 400
              ? `Request returned HTTP ${statusCode}.`
              : 'Request completed.',
        occurredAt: new Date(),
        durationMs: Math.max(0, durationMs),
      });
    }
  }

  private finishOperation(
    module: string,
    durationMs: number,
    success: boolean,
    operationName: string,
    expectedFailure = false,
  ): void {
    const current = this.moduleHealth.get(module)!;
    const completedOperations = current.details?.completedOperations;
    const count =
      typeof completedOperations === 'number' ? completedOperations : 0;
    const successCount = current.details?.successfulOperations;
    const successTotal = typeof successCount === 'number' ? successCount : 0;
    const failedCount = current.details?.failedOperations;
    const failedTotal = typeof failedCount === 'number' ? failedCount : 0;
    this.moduleHealth.set(module, {
      ...current,
      activeOperations: Math.max(0, current.activeOperations - 1),
      lastDurationMs: durationMs,
      averageDurationMs: Math.round(
        (current.averageDurationMs * count + durationMs) / (count + 1),
      ),
      lastActivityAt: new Date(),
      lastOperation: operationName,
      details: {
        ...(current.details ?? {}),
        completedOperations: count + 1,
        successfulOperations: successTotal + (success ? 1 : 0),
        failedOperations: failedTotal + (success ? 0 : 1),
      },
    });
    // Ordinary operations never establish or restore module health. Only an
    // explicit health probe may report HEALTHY.
    if (!success && !expectedFailure) {
      this.reportModuleHealth(module, 'DEGRADED', {
        source: 'operation',
        message: `${operationName} failed.`,
      });
    }
  }

  async trackCron<T>(
    definition: SystemMonitorCronDefinition,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const now = new Date();
    const existing = this.cronStates.get(definition.key);
    const state: CronRuntimeState = {
      key: definition.key,
      module: this.normalizeModule(definition.module),
      name: definition.name,
      expression: definition.expression,
      timeZone: definition.timeZone,
      enabled: definition.enabled ?? true,
      status: 'RUNNING',
      lastStartedAt: now,
      lastSuccessfulAt: existing?.lastSuccessfulAt,
      lastFailedAt: existing?.lastFailedAt,
      lastDurationMs: existing?.lastDurationMs,
      consecutiveFailures: existing?.consecutiveFailures ?? 0,
      lastError: undefined,
    };
    this.cronStates.set(definition.key, state);
    this.reportActivity({
      module: state.module,
      source: 'cron',
      operation: definition.name,
      status: 'STARTED',
      message: `${definition.name} started`,
      occurredAt: now,
      referenceKey: definition.key,
    });
    try {
      const result = await operation();
      const completedAt = new Date();
      state.status = 'SUCCESS';
      state.lastSuccessfulAt = completedAt;
      state.lastDurationMs = completedAt.getTime() - now.getTime();
      state.consecutiveFailures = 0;
      state.lastError = undefined;
      this.cronStates.set(definition.key, state);
      // Cron completion is recorded as activity; only a health probe may clear a failure.
      this.reportActivity({
        module: state.module,
        source: 'cron',
        operation: definition.name,
        status: 'SUCCESS',
        message: `${definition.name} completed successfully`,
        occurredAt: completedAt,
        durationMs: state.lastDurationMs,
        referenceKey: definition.key,
      });
      return result;
    } catch (error) {
      const failedAt = new Date();
      const message = this.getErrorMessage(error);
      state.status = 'FAILED';
      state.lastFailedAt = failedAt;
      state.lastDurationMs = failedAt.getTime() - now.getTime();
      state.consecutiveFailures += 1;
      state.lastError = message;
      this.cronStates.set(definition.key, state);
      this.reportError({
        module: state.module,
        source: 'cron',
        operation: definition.name,
        message,
        occurredAt: failedAt,
        stack: this.getErrorStack(error),
        referenceKey: definition.key,
      });
      this.reportActivity({
        module: state.module,
        source: 'cron',
        operation: definition.name,
        status: 'FAILED',
        message: `${definition.name} failed`,
        occurredAt: failedAt,
        durationMs: state.lastDurationMs,
        referenceKey: definition.key,
      });
      this.reportModuleHealth(state.module, 'DEGRADED', {
        source: 'cron',
        message: `${definition.name} failed: ${message}`,
      });
      throw error;
    }
  }

  reportError(error: SystemMonitorError): void {
    this.recentErrors.unshift({
      ...error,
      message: this.safeTelemetryText(error.message, 1000),
      stack: error.stack
        ? this.safeTelemetryText(error.stack, 4000)
        : undefined,
    });
    if (this.recentErrors.length > this.MAX_ERRORS)
      this.recentErrors.length = this.MAX_ERRORS;
    const safeError = this.recentErrors[0];
    this.adminGateway.publishModuleEvent('system-monitor', 'system:error', {
      module: safeError.module,
      source: safeError.source,
      operation: safeError.operation,
      message: safeError.message,
      occurredAt: safeError.occurredAt.toISOString(),
      referenceKey: safeError.referenceKey,
    });
    const currentModuleStatus = this.moduleHealth.get(
      this.normalizeModule(safeError.module),
    )?.status;
    // An error event must not downgrade an already-confirmed FAILED state to
    // DEGRADED. The next explicit health probe is responsible for recovery.
    if (currentModuleStatus !== 'FAILED') {
      this.adminGateway.setModuleOperationalStatus(
        safeError.module,
        'DEGRADED',
        safeError.message,
        { source: safeError.source, operation: safeError.operation },
      );
    }
  }
  reportActivity(activity: SystemMonitorActivity): void {
    this.addActivity(activity);
    if (
      activity.status === 'FAILED' ||
      activity.status === 'STARTED' ||
      (activity.status === 'SUCCESS' &&
        (TELEMETRY_MODULES.has(activity.module) ||
          DEEP_MODULES.has(activity.module)))
    ) {
      this.adminGateway.publishModuleEvent(activity.module, 'system:activity', {
        module: activity.module,
        source: activity.source,
        operation: activity.operation,
        status: activity.status,
        message: this.safeTelemetryText(activity.message, 500),
        occurredAt: activity.occurredAt.toISOString(),
        durationMs: activity.durationMs,
        referenceKey: activity.referenceKey,
      });
    }
  }

  getDashboard(): unknown {
    const crons = this.getCrons();
    const modules = this.getModules();
    const coverage = this.getCoverage();
    const failedCrons = crons.filter((cron) => cron.status === 'FAILED').length;
    const failedModules = modules.filter((module) => module.status === 'FAILED').length;
    const degradedModules = modules.filter((module) => module.status === 'DEGRADED').length;
    const unknownModules = modules.filter((module) => module.status === 'UNKNOWN').length;
    const criticalModules = modules.filter((module) => module.critical);
    const criticalFailed = criticalModules.filter((module) => module.status === 'FAILED').length;
    const criticalDegraded = criticalModules.filter((module) => module.status === 'DEGRADED').length;
    const criticalUnknown = criticalModules.filter((module) => module.status === 'UNKNOWN').length;
    const criticalDependencyFailures = coverage.criticalDependencyIssues.filter(
      (issue: { status: ModuleHealthStatus }) => issue.status === 'FAILED',
    ).length;
    const criticalDependencyIssues = coverage.criticalDependencyIssues.length;
    const criticalGraphIssues = coverage.moduleGraphIssues.filter(
      (issue: { critical: boolean }) => issue.critical,
    ).length;
    const criticalMissingModules = modules.filter(
      (module) => module.critical && !this.discoveredModules.has(module.module),
    ).length;
    const readinessStatus = criticalFailed > 0 || criticalDependencyFailures > 0
      ? 'FAILED'
      : criticalDegraded > 0 || criticalUnknown > 0 || criticalDependencyIssues > 0
        || criticalGraphIssues > 0 || criticalMissingModules > 0
        ? 'DEGRADED'
        : 'ONLINE';
    const readinessMessage = readinessStatus === 'FAILED'
      ? 'One or more critical modules or their required dependencies have failed.'
      : readinessStatus === 'DEGRADED'
        ? 'One or more critical modules, dependencies or module-import contracts are degraded or unverified.'
        : 'All critical modules and their required dependencies are healthy.';
    const memory = process.memoryUsage();
    return {
      system: {
        // Readiness includes critical module and dependency state. Unknown is
        // unverified, not healthy; it degrades readiness but does not imply failure.
        status: readinessStatus,
        readiness: {
          status: readinessStatus,
          message: readinessMessage,
          criticalModules: criticalModules.length,
          criticalFailed,
          criticalDegraded,
          criticalUnknown,
          criticalDependencyIssues,
          criticalModuleGraphIssues: criticalGraphIssues,
          criticalModulesMissingFromNest: criticalMissingModules,
        },
        startedAt: this.startedAt,
        uptimeSeconds: Math.floor(process.uptime()),
        currentTime: new Date(),
        pid: process.pid,
        nodeVersion: process.version,
        memory: {
          rssBytes: memory.rss,
          heapTotalBytes: memory.heapTotal,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external,
          arrayBuffersBytes: memory.arrayBuffers,
        },
        telemetry: this.moduleHealth.get('application')?.details ?? {},
      },
      summary: {
        totalCrons: crons.length,
        runningCrons: crons.filter((cron) => cron.status === 'RUNNING').length,
        failedCrons,
        recentErrors: this.recentErrors.length,
        modules: modules.length,
        failedModules,
        degradedModules,
        unknownModules,
        staleModules: modules.filter((module) => module.healthIsStale).length,
        criticalModulesUnhealthy: criticalDegraded + criticalFailed,
        criticalModulesUnverified: criticalUnknown,
        criticalDependencyIssues,
        criticalModuleGraphIssues: criticalGraphIssues,
        modulesMissingFromNest: coverage.summary.modulesMissingFromNest,
        unclassifiedDiscoveredModules: coverage.summary.unclassifiedDiscoveredModules,
      },
      coverage,
      modules,
      crons,
      recentActivity: [...this.recentActivity],
      recentErrors: [...this.recentErrors],
    };
  }

  getModules(options?: {
    status?: string;
    level?: ModuleMonitoringLevel;
    critical?: boolean;
  }): ModuleHealthView[] {
    let modules = [...this.moduleHealth.values()]
      .sort(
        (a, b) =>
          Number(b.critical) - Number(a.critical) ||
          a.module.localeCompare(b.module),
      )
      .map((module) => this.enrichModuleHealth(module));
    if (options?.status)
      modules = modules.filter((module) => module.status === options.status);
    if (options?.level)
      modules = modules.filter((module) => module.monitoringLevel === options.level);
    if (typeof options?.critical === 'boolean')
      modules = modules.filter((module) => module.critical === options.critical);
    return modules;
  }

  getModuleHealth(moduleName: string): ModuleHealthView | null {
    const module = this.moduleHealth.get(this.normalizeModule(moduleName));
    return module ? this.enrichModuleHealth(module) : null;
  }

  /** Coverage, import-contract drift and dependency readiness from the discovered Nest graph. */
  getCoverage() {
    const definitions = SYSTEM_MONITOR_MODULE_REGISTRY;
    const knownModules = new Set(definitions.map((definition) => definition.module));
    const moduleRows = definitions.map((definition) => {
      const current = this.moduleHealth.get(definition.module);
      const enriched = current ? this.enrichModuleHealth(current) : undefined;
      const status: ModuleHealthStatus = enriched?.status ?? 'UNKNOWN';
      const actualModuleImports = [...(this.discoveredModuleImports.get(definition.module) ?? new Set<string>())].sort();
      const declaredModuleImports = [...definition.moduleImports].sort();
      const missingModuleImports = declaredModuleImports.filter((item) => !actualModuleImports.includes(item));
      const unexpectedModuleImports = actualModuleImports.filter((item) => !declaredModuleImports.includes(item));
      return {
        module: definition.module,
        category: definition.category,
        description: definition.description,
        critical: definition.critical,
        monitoringLevel: definition.monitoringLevel,
        probeMode: definition.probeMode,
        healthFreshnessMs: definition.healthFreshnessMs,
        externalProbeMode: definition.externalProbeMode,
        externalDependencies: [...definition.externalDependencies],
        moduleImports: [...definition.moduleImports],
        dataDependencies: [...definition.dataDependencies],
        runtimeDependencies: [...definition.runtimeDependencies],
        dependsOn: [...definition.dependsOn],
        actualModuleImports,
        missingModuleImports,
        unexpectedModuleImports,
        moduleImportDrift: missingModuleImports.length > 0 || unexpectedModuleImports.length > 0,
        status,
        observedStatus: enriched?.observedStatus ?? 'UNKNOWN',
        healthIsStale: enriched?.healthIsStale ?? false,
        healthAgeMs: enriched?.healthAgeMs,
        discovered: this.discoveredModules.has(definition.module) || definition.module === 'database',
        dependencies: definition.dependsOn.map((dependency) => {
          const dependencyHealth = this.moduleHealth.get(dependency);
          const dependencyView = dependencyHealth
            ? this.enrichModuleHealth(dependencyHealth)
            : undefined;
          return {
            module: dependency,
            status: dependencyView?.status ?? 'UNKNOWN' as ModuleHealthStatus,
            critical: getSystemMonitorModuleDefinition(dependency)?.critical ?? false,
            kind: definition.moduleImports.includes(dependency)
              ? 'module-import' as const
              : definition.dataDependencies.includes(dependency)
                ? 'data' as const
                : 'runtime' as const,
          };
        }),
      };
    });

    const critical = moduleRows.filter((item) => item.critical);
    const dependencyIssues = critical.flatMap((item) =>
      item.dependencies
        .filter((dependency) => dependency.status !== 'HEALTHY')
        .map((dependency) => ({ parentModule: item.module, ...dependency })),
    );
    const statusCount = (status: ModuleHealthStatus) => critical.filter((item) => item.status === status).length;
    const probeModes = {
      periodic: moduleRows.filter((item) => item.probeMode === 'PERIODIC').length,
      workerLifecycle: moduleRows.filter((item) => item.probeMode === 'WORKER_LIFECYCLE').length,
      lifecycle: moduleRows.filter((item) => item.probeMode === 'LIFECYCLE').length,
      onDemand: moduleRows.filter((item) => item.probeMode === 'ON_DEMAND').length,
      requestObserved: moduleRows.filter((item) => item.probeMode === 'REQUEST_OBSERVED').length,
    };
    const missingModules = moduleRows.filter((item) => !item.discovered).map((item) => item.module);
    const criticalWithoutLocalProbe = critical
      .filter((item) => item.probeMode === 'REQUEST_OBSERVED')
      .map((item) => item.module);
    const criticalOnDemandOnly = critical
      .filter((item) => item.probeMode === 'ON_DEMAND')
      .map((item) => item.module);
    const moduleGraphIssues = moduleRows
      .filter((item) => item.discovered && item.module !== 'application' && item.module !== 'database' && item.moduleImportDrift)
      .map((item) => ({
        module: item.module,
        critical: item.critical,
        expectedImports: item.moduleImports,
        actualImports: item.actualModuleImports,
        missingImports: item.missingModuleImports,
        unexpectedImports: item.unexpectedModuleImports,
      }));
    const unclassifiedDiscoveredModules = [...this.discoveredModules]
      .filter((module) => !knownModules.has(module))
      .sort();
    const staleModules = moduleRows.filter((item) => item.healthIsStale).map((item) => item.module);

    return {
      checkedAt: new Date(),
      expectedModules: moduleRows.length,
      discoveredModules: moduleRows.filter((item) => item.discovered).length,
      missingModules,
      unclassifiedDiscoveredModules,
      moduleGraphIssues,
      staleModules,
      summary: {
        criticalModules: critical.length,
        criticalHealthy: statusCount('HEALTHY'),
        criticalDegraded: statusCount('DEGRADED'),
        criticalFailed: statusCount('FAILED'),
        criticalUnknown: statusCount('UNKNOWN'),
        criticalDependencyIssues: dependencyIssues.length,
        modulesMissingFromNest: missingModules.length,
        unclassifiedDiscoveredModules: unclassifiedDiscoveredModules.length,
        modulesWithImportDrift: moduleGraphIssues.length,
        staleModules: staleModules.length,
        criticalWithoutLocalProbe,
        criticalOnDemandOnly,
        probeModes,
      },
      criticalDependencyIssues: dependencyIssues,
      modules: moduleRows,
    };
  }

  getCrons(options?: {
    module?: string;
    status?: string;
  }): SystemMonitorCronView[] {
    let result: SystemMonitorCronView[] = [];
    const jobs = this.schedulerRegistry.getCronJobs();
    const discovered = new Map<string, SystemMonitorCronView>();
    for (const [key, job] of jobs.entries()) {
      const runtime = this.cronStates.get(key);
      const callbackRunning = Boolean(job.isCallbackRunning);
      const active = Boolean(job.isActive);
      discovered.set(key, {
        key,
        module: runtime?.module ?? 'unknown',
        name: runtime?.name ?? key,
        expression: runtime?.expression,
        timeZone: runtime?.timeZone,
        enabled: runtime?.enabled ?? active,
        status:
          runtime?.status ??
          (callbackRunning ? 'RUNNING' : active ? 'IDLE' : 'REGISTERED'),
        lastStartedAt: runtime?.lastStartedAt,
        lastSuccessfulAt: runtime?.lastSuccessfulAt,
        lastFailedAt: runtime?.lastFailedAt,
        lastDurationMs: runtime?.lastDurationMs,
        consecutiveFailures: runtime?.consecutiveFailures ?? 0,
        lastError: runtime?.lastError,
        scheduler: {
          active,
          callbackRunning,
          lastRunAt: this.getLastRunAt(job),
          nextRunAt: this.getNextRunAt(job),
        },
      });
    }
    for (const [key, runtime] of this.cronStates.entries()) {
      if (!discovered.has(key))
        discovered.set(key, {
          ...runtime,
          scheduler: { active: false, callbackRunning: false },
        });
    }
    result = [...discovered.values()];
    if (options?.module)
      result = result.filter(
        (cron) => cron.module === this.normalizeModule(options.module!),
      );
    if (options?.status)
      result = result.filter((cron) => cron.status === options.status);
    return result;
  }

  getCron(key: string): SystemMonitorCronView | null {
    return this.getCrons().find((cron) => cron.key === key.trim()) ?? null;
  }
  getErrors(options?: {
    module?: string;
    limit?: number;
  }): SystemMonitorError[] {
    let items = [...this.recentErrors];
    if (options?.module)
      items = items.filter(
        (item) => item.module === this.normalizeModule(options.module!),
      );
    return items.slice(0, this.normalizeLimit(options?.limit));
  }
  getActivity(options?: {
    module?: string;
    status?: string;
    limit?: number;
  }): SystemMonitorActivity[] {
    let items = [...this.recentActivity];
    if (options?.module)
      items = items.filter(
        (item) => item.module === this.normalizeModule(options.module!),
      );
    if (options?.status)
      items = items.filter((item) => item.status === options.status);
    return items.slice(0, this.normalizeLimit(options?.limit));
  }

  private addActivity(activity: SystemMonitorActivity) {
    this.recentActivity.unshift({
      ...activity,
      message: this.safeTelemetryText(activity.message, 500),
    });
    if (this.recentActivity.length > this.MAX_ACTIVITY)
      this.recentActivity.length = this.MAX_ACTIVITY;
  }
  private asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  }
  private toMonitorDate(value?: Date | string): Date | undefined {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    if (typeof value === 'string') {
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed : undefined;
    }
    return undefined;
  }
  private safeTelemetryText(value: string, maxLength: number): string {
    return String(value ?? '')
      .replace(
        /(password|token|secret|authorization|cookie|api[_-]?key)(\s*[:=]\s*|\s+)[^\s&;,]+/gi,
        '$1=[redacted]',
      )
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
      .slice(0, maxLength);
  }
  private normalizeModule(value: string): string {
    return normalizeSystemMonitorModuleKey(value);
  }

  private enrichModuleHealth(module: ModuleHealthView): ModuleHealthView {
    const definition = getSystemMonitorModuleDefinition(module.module);
    if (!definition) {
      return {
        ...module,
        observedStatus: module.status,
        healthIsStale: false,
        healthAgeMs: Math.max(0, Date.now() - module.checkedAt.getTime()),
        moduleImports: [],
        dataDependencies: [],
        runtimeDependencies: [],
        actualModuleImports: [],
        missingModuleImports: [],
        unexpectedModuleImports: [],
      };
    }

    const now = Date.now();
    const healthAgeMs = Math.max(0, now - module.checkedAt.getTime());
    const healthIsStale = Number.isFinite(definition.healthFreshnessMs)
      && healthAgeMs > Number(definition.healthFreshnessMs);
    // A stale HEALTHY probe cannot continue to certify readiness. A prior
    // FAILED/DEGRADED result remains visible until a newer explicit success.
    const status = healthIsStale && module.status === 'HEALTHY'
      ? 'UNKNOWN'
      : module.status;
    const dependencies = definition.dependsOn.map((dependency) => {
      const health = this.moduleHealth.get(dependency);
      const effectiveStatus = health
        ? this.getEffectiveModuleStatus(dependency, health)
        : 'UNKNOWN';
      return {
        module: dependency,
        status: effectiveStatus,
        critical: getSystemMonitorModuleDefinition(dependency)?.critical ?? false,
        kind: definition.moduleImports.includes(dependency)
          ? 'module-import' as const
          : definition.dataDependencies.includes(dependency)
            ? 'data' as const
            : 'runtime' as const,
      };
    });
    const dependencyIssues = dependencies.filter((dependency) => dependency.status !== 'HEALTHY');
    const dependencyStatuses = dependencies.map((dependency) => dependency.status);
    const dependencyStatus: ModuleHealthStatus =
      dependencyStatuses.includes('FAILED') ? 'FAILED'
        : dependencyStatuses.includes('DEGRADED') ? 'DEGRADED'
          : dependencyStatuses.includes('UNKNOWN') ? 'UNKNOWN'
            : 'HEALTHY';
    const actualModuleImports = [...(this.discoveredModuleImports.get(module.module) ?? new Set<string>())].sort();
    const declaredModuleImports = [...definition.moduleImports].sort();
    const missingModuleImports = declaredModuleImports.filter((item) => !actualModuleImports.includes(item));
    const unexpectedModuleImports = actualModuleImports.filter((item) => !declaredModuleImports.includes(item));

    return {
      ...module,
      status,
      observedStatus: module.status,
      healthIsStale,
      healthAgeMs,
      healthFreshnessMs: definition.healthFreshnessMs,
      externalProbeMode: definition.externalProbeMode,
      message: healthIsStale && module.status === 'HEALTHY'
        ? 'The last successful periodic health probe is stale; current operational health is unverified.'
        : module.message,
      category: definition.category,
      description: definition.description,
      probeMode: definition.probeMode,
      moduleImports: [...definition.moduleImports],
      dataDependencies: [...definition.dataDependencies],
      runtimeDependencies: [...definition.runtimeDependencies],
      actualModuleImports,
      missingModuleImports,
      unexpectedModuleImports,
      dependencies,
      externalDependencies: [...definition.externalDependencies],
      dependencyStatus,
      dependencyIssues,
    };
  }

  private getEffectiveModuleStatus(
    moduleName: string,
    health: ModuleHealthView,
  ): ModuleHealthStatus {
    const definition = getSystemMonitorModuleDefinition(moduleName);
    if (!definition?.healthFreshnessMs || health.status !== 'HEALTHY') return health.status;
    return Date.now() - health.checkedAt.getTime() > definition.healthFreshnessMs
      ? 'UNKNOWN'
      : health.status;
  }

  private trimModules() {
    if (this.moduleHealth.size <= this.MAX_MODULES) return;
    for (const [key] of this.moduleHealth) {
      if (key === 'application' || key === 'database') continue;
      this.moduleHealth.delete(key);
      if (this.moduleHealth.size <= this.MAX_MODULES) break;
    }
  }
  private safeDetails(details: Record<string, unknown>) {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details).slice(0, 30)) {
      if (
        /(token|secret|password|authorization|cookie|email|phone|payload|body)/i.test(
          key,
        )
      )
        continue;
      if (['string', 'number', 'boolean'].includes(typeof value))
        safe[key.slice(0, 50)] =
          typeof value === 'string'
            ? this.safeTelemetryText(value, 200)
            : value;
    }
    return safe;
  }
  private getLastRunAt(job: { lastDate: () => Date | null }): Date | undefined {
    try {
      return job.lastDate() ?? undefined;
    } catch {
      return undefined;
    }
  }
  private getNextRunAt(job: { nextDate: () => unknown }): Date | undefined {
    try {
      const value: any = job.nextDate();
      if (!value) return undefined;
      if (value instanceof Date) return value;
      if (typeof value.toDate === 'function') return value.toDate();
      const parsed = new Date(String(value));
      return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    } catch {
      return undefined;
    }
  }
  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
  private getErrorStack(error: unknown): string | undefined {
    return error instanceof Error ? error.stack : undefined;
  }
  private normalizeLimit(value?: number): number {
    return Number.isFinite(value)
      ? Math.min(Math.max(Math.floor(value as number), 1), 100)
      : 50;
  }
}

