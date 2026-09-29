import { Injectable } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

export type SystemMonitorCronStatus =
  'REGISTERED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'IDLE';

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

interface CronRuntimeState {
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
}

@Injectable()
export class SystemMonitorService {
  private readonly startedAt = new Date();

  private readonly cronStates = new Map<string, CronRuntimeState>();

  private readonly recentErrors: SystemMonitorError[] = [];

  private readonly recentActivity: SystemMonitorActivity[] = [];

  private readonly MAX_ERRORS = 100;

  private readonly MAX_ACTIVITY = 200;

  constructor(private readonly schedulerRegistry: SchedulerRegistry) {}

  // ============================================================
  // CRON TRACKING
  // ============================================================

  async trackCron<T>(
    definition: SystemMonitorCronDefinition,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const now = new Date();

    const existing = this.cronStates.get(definition.key);

    const state: CronRuntimeState = {
      key: definition.key,

      module: definition.module,

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

    this.addActivity({
      module: definition.module,

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

      const durationMs = completedAt.getTime() - now.getTime();

      state.status = 'SUCCESS';

      state.lastSuccessfulAt = completedAt;

      state.lastDurationMs = durationMs;

      state.consecutiveFailures = 0;

      state.lastError = undefined;

      this.cronStates.set(definition.key, state);

      this.addActivity({
        module: definition.module,

        source: 'cron',

        operation: definition.name,

        status: 'SUCCESS',

        message: `${definition.name} completed successfully`,

        occurredAt: completedAt,

        durationMs,

        referenceKey: definition.key,
      });

      return result;
    } catch (error) {
      const failedAt = new Date();

      const durationMs = failedAt.getTime() - now.getTime();

      const message = this.getErrorMessage(error);

      state.status = 'FAILED';

      state.lastFailedAt = failedAt;

      state.lastDurationMs = durationMs;

      state.consecutiveFailures += 1;

      state.lastError = message;

      this.cronStates.set(definition.key, state);

      this.reportError({
        module: definition.module,

        source: 'cron',

        operation: definition.name,

        message,

        occurredAt: failedAt,

        stack: this.getErrorStack(error),

        referenceKey: definition.key,
      });

      this.addActivity({
        module: definition.module,

        source: 'cron',

        operation: definition.name,

        status: 'FAILED',

        message: `${definition.name} failed`,

        occurredAt: failedAt,

        durationMs,

        referenceKey: definition.key,
      });

      throw error;
    }
  }

  // ============================================================
  // ERROR REPORTING
  // ============================================================

  reportError(error: SystemMonitorError): void {
    this.recentErrors.unshift(error);

    if (this.recentErrors.length > this.MAX_ERRORS) {
      this.recentErrors.length = this.MAX_ERRORS;
    }
  }

  // ============================================================
  // ACTIVITY REPORTING
  // ============================================================

  reportActivity(activity: SystemMonitorActivity): void {
    this.addActivity(activity);
  }

  // ============================================================
  // DASHBOARD
  // ============================================================

  getDashboard(): unknown {
    const crons = this.getCrons();

    const runningCrons = crons.filter(
      (cron) => cron.status === 'RUNNING',
    ).length;

    const failedCrons = crons.filter((cron) => cron.status === 'FAILED').length;

    return {
      system: {
        status: 'ONLINE',

        startedAt: this.startedAt,

        uptimeSeconds: Math.floor(process.uptime()),

        currentTime: new Date(),
      },

      summary: {
        totalCrons: crons.length,

        runningCrons,

        failedCrons,

        recentErrors: this.recentErrors.length,
      },

      crons,

      recentActivity: [...this.recentActivity],

      recentErrors: [...this.recentErrors],
    };
  }

  // ============================================================
  // CRONS
  // ============================================================

  getCrons(options?: {
    module?: string;
    status?: string;
  }): SystemMonitorCronView[] {
    const jobs = this.schedulerRegistry.getCronJobs();

    const discovered = new Map<string, SystemMonitorCronView>();

    for (const [key, job] of jobs.entries()) {
      const runtime = this.cronStates.get(key);

      /*
       * These are getters in the installed cron package.
       */
      const isCallbackRunning = Boolean(job.isCallbackRunning);

      const isActive = Boolean(job.isActive);

      const status: SystemMonitorCronStatus =
        runtime?.status ??
        (isCallbackRunning ? 'RUNNING' : isActive ? 'IDLE' : 'REGISTERED');

      const cron: SystemMonitorCronView = {
        key,

        module: runtime?.module ?? 'unknown',

        name: runtime?.name ?? key,

        expression: runtime?.expression,

        timeZone: runtime?.timeZone,

        enabled: runtime?.enabled ?? isActive,

        status,

        lastStartedAt: runtime?.lastStartedAt,

        lastSuccessfulAt: runtime?.lastSuccessfulAt,

        lastFailedAt: runtime?.lastFailedAt,

        lastDurationMs: runtime?.lastDurationMs,

        consecutiveFailures: runtime?.consecutiveFailures ?? 0,

        lastError: runtime?.lastError,

        scheduler: {
          active: isActive,

          callbackRunning: isCallbackRunning,

          lastRunAt: this.getLastRunAt(job),

          nextRunAt: this.getNextRunAt(job),
        },
      };

      discovered.set(key, cron);
    }

    /*
     * Include monitor states even if the scheduler no longer
     * has the job registered.
     */
    for (const [key, runtime] of this.cronStates.entries()) {
      if (discovered.has(key)) {
        continue;
      }

      discovered.set(key, {
        key: runtime.key,

        module: runtime.module,

        name: runtime.name,

        expression: runtime.expression,

        timeZone: runtime.timeZone,

        enabled: runtime.enabled,

        status: runtime.status,

        lastStartedAt: runtime.lastStartedAt,

        lastSuccessfulAt: runtime.lastSuccessfulAt,

        lastFailedAt: runtime.lastFailedAt,

        lastDurationMs: runtime.lastDurationMs,

        consecutiveFailures: runtime.consecutiveFailures,

        lastError: runtime.lastError,

        scheduler: {
          active: false,

          callbackRunning: false,

          lastRunAt: undefined,

          nextRunAt: undefined,
        },
      });
    }

    let result = [...discovered.values()];

    if (options?.module) {
      result = result.filter((cron) => cron.module === options.module);
    }

    if (options?.status) {
      result = result.filter((cron) => cron.status === options.status);
    }

    return result;
  }

  getCron(key: string): SystemMonitorCronView | null {
    const normalizedKey = key.trim();

    return this.getCrons().find((cron) => cron.key === normalizedKey) ?? null;
  }

  // ============================================================
  // ERRORS
  // ============================================================

  getErrors(options?: {
    module?: string;
    limit?: number;
  }): SystemMonitorError[] {
    let errors = [...this.recentErrors];

    if (options?.module) {
      errors = errors.filter((error) => error.module === options.module);
    }

    const limit = this.normalizeLimit(options?.limit);

    return errors.slice(0, limit);
  }

  // ============================================================
  // ACTIVITY
  // ============================================================

  getActivity(options?: {
    module?: string;
    status?: string;
    limit?: number;
  }): SystemMonitorActivity[] {
    let activity = [...this.recentActivity];

    if (options?.module) {
      activity = activity.filter((item) => item.module === options.module);
    }

    if (options?.status) {
      activity = activity.filter((item) => item.status === options.status);
    }

    const limit = this.normalizeLimit(options?.limit);

    return activity.slice(0, limit);
  }

  // ============================================================
  // INTERNAL ACTIVITY
  // ============================================================

  private addActivity(activity: SystemMonitorActivity): void {
    this.recentActivity.unshift(activity);

    if (this.recentActivity.length > this.MAX_ACTIVITY) {
      this.recentActivity.length = this.MAX_ACTIVITY;
    }
  }

  // ============================================================
  // SCHEDULER HELPERS
  // ============================================================

  private getLastRunAt(job: { lastDate: () => Date | null }): Date | undefined {
    try {
      return job.lastDate() ?? undefined;
    } catch {
      return undefined;
    }
  }

  private getNextRunAt(job: { nextDate: () => unknown }): Date | undefined {
    try {
      const next = job.nextDate();

      return this.toDate(next);
    } catch {
      return undefined;
    }
  }

  private toDate(value: unknown): Date | undefined {
    if (!value) {
      return undefined;
    }

    if (value instanceof Date) {
      return value;
    }

    if (
      typeof value === 'object' &&
      value !== null &&
      'toJSDate' in value &&
      typeof (
        value as {
          toJSDate?: unknown;
        }
      ).toJSDate === 'function'
    ) {
      return (
        value as {
          toJSDate: () => Date;
        }
      ).toJSDate();
    }

    return undefined;
  }

  // ============================================================
  // ERROR HELPERS
  // ============================================================

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private getErrorStack(error: unknown): string | undefined {
    if (error instanceof Error) {
      return error.stack;
    }

    return undefined;
  }

  private normalizeLimit(value?: number): number {
    if (!Number.isFinite(value)) {
      return 50;
    }

    return Math.min(Math.max(Math.floor(value as number), 1), 200);
  }
}
