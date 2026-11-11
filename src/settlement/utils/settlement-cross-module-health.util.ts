import {
  SettlementCrossModuleHealth,
  SettlementMonitorAlert,
  SettlementMonitorHealthStatus,
} from '../interfaces/settlement-monitor.interface';

interface ModuleHealthLike {
  status?: unknown;
  checkedAt?: unknown;
}

export type ModuleHealthLookup = (moduleName: string) => unknown;

const MONITORED_MODULES = [
  { key: 'sports', displayName: 'Sports', outputKey: 'sports' },
  { key: 'odds', displayName: 'Odds', outputKey: 'odds' },
  {
    key: 'predictions-engine',
    displayName: 'Predictions Engine',
    outputKey: 'predictionsEngine',
  },
  { key: 'bet-lab', displayName: 'BetLab', outputKey: 'betLab' },
] as const;

function normalizeStatus(value: unknown): string {
  const status = String(value ?? 'UNKNOWN').trim().toUpperCase();

  // Module monitors have historically used slightly different vocabularies.
  // Normalize those aliases here without changing each module's own dashboard
  // contract or business behavior.
  switch (status) {
    case 'HEALTHY':
    case 'OK':
    case 'READY':
    case 'OPERATIONAL':
      return 'HEALTHY';
    case 'DEGRADED':
    case 'WARN':
    case 'WARNING':
    case 'PARTIAL':
      return 'DEGRADED';
    case 'CRITICAL':
    case 'FAILED':
    case 'FAIL':
    case 'ERROR':
      return 'CRITICAL';
    case 'UNKNOWN':
    case '':
    default:
      return 'UNKNOWN';
  }
}

function normalizeCheckedAt(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function readSnapshot(value: unknown): { status: string; checkedAt?: string } {
  const snapshot =
    value && typeof value === 'object'
      ? (value as ModuleHealthLike)
      : undefined;
  return {
    status: normalizeStatus(snapshot?.status),
    checkedAt: normalizeCheckedAt(snapshot?.checkedAt),
  };
}

/**
 * Builds a read-only view of the upstream module health snapshots. It does not
 * change any worker state or settlement decision. UNKNOWN is retained as an
 * explicit state instead of being treated as healthy.
 */
export function collectSettlementCrossModuleHealth(
  getModuleHealth: ModuleHealthLookup,
): SettlementCrossModuleHealth {
  const modules = {
    sports: readSnapshot(getModuleHealth('sports')),
    odds: readSnapshot(getModuleHealth('odds')),
    predictionsEngine: readSnapshot(getModuleHealth('predictions-engine')),
    betLab: readSnapshot(getModuleHealth('bet-lab')),
  };

  const statuses = Object.values(modules).map((module) => module.status);
  const hasCritical = statuses.includes('CRITICAL');
  const hasDegraded = statuses.includes('DEGRADED');
  const allHealthy = statuses.every((status) => status === 'HEALTHY');
  const status: SettlementMonitorHealthStatus = hasCritical
    ? 'CRITICAL'
    : hasDegraded
      ? 'DEGRADED'
      : allHealthy
        ? 'HEALTHY'
        : 'UNKNOWN';

  const alerts: SettlementMonitorAlert[] = [];
  for (const module of MONITORED_MODULES) {
    const snapshot = modules[module.outputKey];
    if (snapshot.status === 'CRITICAL') {
      alerts.push({
        code: `${module.key.replace(/-/g, '_').toUpperCase()}_MODULE_CRITICAL`,
        severity: 'CRITICAL',
        message: `${module.displayName} module is reporting critical health.`,
        details: {
          module: module.key,
          status: snapshot.status,
          checkedAt: snapshot.checkedAt,
        },
      });
    } else if (snapshot.status === 'DEGRADED') {
      alerts.push({
        code: `${module.key.replace(/-/g, '_').toUpperCase()}_MODULE_DEGRADED`,
        severity: 'WARNING',
        message: `${module.displayName} module is reporting degraded health.`,
        details: {
          module: module.key,
          status: snapshot.status,
          checkedAt: snapshot.checkedAt,
        },
      });
    }
  }

  return { status, modules, alerts };
}

