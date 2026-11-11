import { SettlementMonitorService } from './settlement-monitor.service';

function query(value: unknown) {
  const chain: Record<string, any> = {
    exec: jest.fn().mockResolvedValue(value),
  };
  for (const method of ['sort', 'limit', 'select', 'lean', 'skip']) {
    chain[method] = jest.fn(() => chain);
  }
  return chain;
}

function model(overrides: Record<string, unknown> = {}) {
  return {
    aggregate: jest.fn(() => query([])),
    find: jest.fn(() => query([])),
    findOne: jest.fn(() => query(null)),
    countDocuments: jest.fn(() => query(0)),
    ...overrides,
  };
}

function workerStatus(overrides: Record<string, unknown> = {}) {
  return {
    initialized: true,
    busy: false,
    wakeRequested: false,
    startupAttempts: 1,
    drainCycles: 0,
    drainFailures: 0,
    jobsClaimed: 0,
    jobsCompleted: 0,
    jobsPartial: 0,
    jobsSkipped: 0,
    jobsFailed: 0,
    jobsRetried: 0,
    jobsTerminalFailed: 0,
    workerId: 'settlement-worker-test',
    ...overrides,
  };
}

function createService(options?: {
  moduleStatuses?: Record<string, string>;
  worker?: Record<string, unknown>;
  dueJobCount?: number;
  oldestDueAt?: Date | null;
}) {
  const countValues = [options?.dueJobCount ?? 0, 0, 0];
  const jobModel = model({
    countDocuments: jest.fn(() => query(countValues.shift() ?? 0)),
    findOne: jest.fn(() => query(
      options?.oldestDueAt ? { nextRunAt: options.oldestDueAt } : null,
    )),
  });
  const runModel = model();
  const eventModel = model();
  const predictionModel = model({ countDocuments: jest.fn(() => query(0)) });
  const ticketModel = model();
  const worker = { getRuntimeStatus: jest.fn(() => workerStatus(options?.worker)) };
  const systemMonitor = {
    registerModule: jest.fn(),
    getModuleHealth: jest.fn((moduleName: string) => {
      const status = options?.moduleStatuses?.[moduleName];
      return status ? { status, checkedAt: new Date('2026-11-10T10:00:00.000Z') } : undefined;
    }),
    reportMonitorSnapshot: jest.fn(),
  };

  const service = new SettlementMonitorService(
    jobModel as any,
    runModel as any,
    eventModel as any,
    predictionModel as any,
    ticketModel as any,
    worker as any,
    systemMonitor as any,
  );

  return { service, systemMonitor, jobModel };
}

describe('SettlementMonitorService cross-module integration', () => {
  it('exposes Sports, Odds, Predictions Engine and BetLab health in the settlement overview', async () => {
    const { service, systemMonitor } = createService({
      moduleStatuses: {
        sports: 'HEALTHY',
        odds: 'HEALTHY',
        'predictions-engine': 'HEALTHY',
        'bet-lab': 'OK',
      },
    });

    const result = await service.getOverview();

    expect(result.health.crossModule.status).toBe('HEALTHY');
    expect(result.health.crossModule.modules).toEqual({
      sports: { status: 'HEALTHY', checkedAt: '2026-11-10T10:00:00.000Z' },
      odds: { status: 'HEALTHY', checkedAt: '2026-11-10T10:00:00.000Z' },
      predictionsEngine: { status: 'HEALTHY', checkedAt: '2026-11-10T10:00:00.000Z' },
      betLab: { status: 'HEALTHY', checkedAt: '2026-11-10T10:00:00.000Z' },
    });
    expect(systemMonitor.getModuleHealth).toHaveBeenCalledTimes(4);
  });

  it('keeps upstream pipeline degradation visible without rewriting settlement worker health', async () => {
    const { service } = createService({
      moduleStatuses: {
        sports: 'HEALTHY',
        odds: 'DEGRADED',
        'predictions-engine': 'HEALTHY',
        'bet-lab': 'HEALTHY',
      },
    });

    const result = await service.getOverview();

    expect(result.health.status).toBe('HEALTHY');
    expect(result.health.crossModule.status).toBe('DEGRADED');
    expect(result.health.crossModule.alerts[0]).toMatchObject({
      code: 'ODDS_MODULE_DEGRADED',
      severity: 'WARNING',
    });
  });

  it('flags due queue backlog even when the worker is busy', async () => {
    const oldestDueAt = new Date(Date.now() - 6 * 60_000);
    const { service } = createService({
      dueJobCount: 4,
      oldestDueAt,
      worker: { busy: true },
      moduleStatuses: {
        sports: 'HEALTHY',
        odds: 'HEALTHY',
        'predictions-engine': 'HEALTHY',
        'bet-lab': 'HEALTHY',
      },
    });

    const result = await service.getOverview();

    expect(result.health.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'DUE_QUEUE_BACKLOG',
          details: expect.objectContaining({ workerBusy: true }),
        }),
      ]),
    );
  });
});

