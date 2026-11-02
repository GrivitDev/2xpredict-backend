import { Injectable } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OnModuleInit } from '@nestjs/common';
import { AdminGateway } from '../realtime/admin.gateway';

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
export interface ModuleHealthView {
  module: string;
  status: ModuleHealthStatus;
  monitoringLevel: ModuleMonitoringLevel;
  critical: boolean;
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

const DEEP_MODULES = new Set([
  'database',
  'payments',
  'payment-gateways',
  'subscriptions',
  'settlement',
  'predictions-engine',
  'sports',
  'bet-lab',
  'telegram',
  'customer-care',
]);
const TELEMETRY_MODULES = new Set([
  'payments',
  'payment-gateways',
  'subscriptions',
  'plan-config',
]);
const CRITICAL_MODULES = new Set([
  'database',
  'payments',
  'payment-gateways',
  'subscriptions',
  'settlement',
  'predictions-engine',
  'sports',
]);

@Injectable()
export class SystemMonitorService implements OnModuleInit {
  private readonly startedAt = new Date();
  private readonly cronStates = new Map<string, CronRuntimeState>();
  private readonly recentErrors: SystemMonitorError[] = [];
  private readonly recentActivity: SystemMonitorActivity[] = [];
  private readonly moduleHealth = new Map<string, ModuleHealthView>();
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
  }

  registerModule(
    moduleName: string,
    level?: ModuleMonitoringLevel,
    critical?: boolean,
  ): void {
    const key = this.normalizeModule(moduleName);
    if (!key) return;
    const current = this.moduleHealth.get(key);
    if (current) return;
    const now = new Date();
    this.moduleHealth.set(key, {
      module: key,
      status: 'UNKNOWN',
      monitoringLevel: level ?? (DEEP_MODULES.has(key) ? 'deep' : 'health'),
      critical: critical ?? CRITICAL_MODULES.has(key),
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
    this.adminGateway.setModuleOperationalStatus(
      safeError.module,
      'DEGRADED',
      safeError.message,
      { source: safeError.source, operation: safeError.operation },
    );
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
    const failedCrons = crons.filter((cron) => cron.status === 'FAILED').length;
    const failedModules = modules.filter(
      (module) => module.status === 'FAILED',
    ).length;
    const degradedModules = modules.filter(
      (module) => module.status === 'DEGRADED',
    ).length;
    const unknownModules = modules.filter(
      (module) => module.status === 'UNKNOWN',
    ).length;
    const criticalModulesUnverified = modules.filter(
      (module) => module.critical && module.status === 'UNKNOWN',
    ).length;
    const memory = process.memoryUsage();
    return {
      system: {
        // UNKNOWN means health has not been verified; only confirmed failures
        // should downgrade the overall system status.
        status:
          failedModules > 0 || degradedModules > 0 ? 'DEGRADED' : 'ONLINE',
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
        criticalModulesUnhealthy: modules.filter(
          (module) =>
            module.critical &&
            (module.status === 'FAILED' || module.status === 'DEGRADED'),
        ).length,
        criticalModulesUnverified,
      },
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
    let modules = [...this.moduleHealth.values()].sort(
      (a, b) =>
        Number(b.critical) - Number(a.critical) ||
        a.module.localeCompare(b.module),
    );
    if (options?.status)
      modules = modules.filter((m) => m.status === options.status);
    if (options?.level)
      modules = modules.filter((m) => m.monitoringLevel === options.level);
    if (typeof options?.critical === 'boolean')
      modules = modules.filter((m) => m.critical === options.critical);
    return modules;
  }

  getModuleHealth(moduleName: string): ModuleHealthView | null {
    return this.moduleHealth.get(this.normalizeModule(moduleName)) ?? null;
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
    return (
      String(value ?? 'unknown')
        .trim()
        .replace(/Module$/, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/_/g, '-')
        .toLowerCase() || 'unknown'
    );
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
