import { SettlementJobStatus } from '../enums/settlement-job-status.enum';
import { SettlementEventLevel } from '../enums/settlement-event-level.enum';

export interface SettlementJobQuery {
  status?: SettlementJobStatus;
  eventId?: string;
  page?: number;
  limit?: number;
}

export interface SettlementRunQuery {
  eventId?: string;
  page?: number;
  limit?: number;
}

export interface SettlementEventQuery {
  level?: SettlementEventLevel;
  eventId?: string;
  action?: string;
  limit?: number;
}

export type SettlementMonitorHealthStatus = 'HEALTHY' | 'DEGRADED' | 'CRITICAL' | 'UNKNOWN';
export type SettlementMonitorAlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface SettlementMonitorAlert {
  code: string;
  severity: SettlementMonitorAlertSeverity;
  message: string;
  count?: number;
  details?: Record<string, unknown>;
}

export interface SettlementWorkerRuntimeStatus {
  initialized: boolean;
  busy: boolean;
  wakeRequested: boolean;
  activeJob?: {
    jobKey: string;
    eventId: string;
    leagueId: string;
    startedAt: string;
    durationMs: number;
    attempt: number;
  };
  startedAt?: string;
  lastStartupSuccessAt?: string;
  lastStartupError?: string;
  startupAttempts: number;
  drainCycles: number;
  drainFailures: number;
  jobsClaimed: number;
  jobsCompleted: number;
  jobsPartial: number;
  jobsSkipped: number;
  jobsFailed: number;
  jobsRetried: number;
  jobsTerminalFailed: number;
  lastDrainStartedAt?: string;
  lastDrainCompletedAt?: string;
  lastDrainErrorAt?: string;
  lastJobAt?: string;
  lastJobStatus?: 'COMPLETED' | 'PARTIAL' | 'SKIPPED' | 'RETRY' | 'FAILED';
  lastJobKey?: string;
  lastJobEventId?: string;
  lastJobDurationMs?: number;
  lastJobError?: string;
  workerId: string;
}

export interface SettlementMonitorHealth {
  status: SettlementMonitorHealthStatus;
  checkedAt: string;
  worker: SettlementWorkerRuntimeStatus;
  queue: {
    dueQueuedJobs: number;
    staleProcessingJobs: number;
    failedJobs: number;
    partialJobs: number;
    oldestDueQueuedAt?: string;
    oldestDueQueuedAgeMs?: number;
  };
  outcomes: {
    unsettledPredictionSelections: number;
    openBetLabLegs: number;
  };
  alerts: SettlementMonitorAlert[];
}
