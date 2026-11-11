import { SETTLEMENT_CONFIG } from '../config/settlement.config';
import { SettlementWorkerService } from './settlement-worker.service';

describe('SettlementWorkerService target reconciliation', () => {
  const createWorker = (queue: Record<string, any>) => {
    const monitor = {
      reportModuleHealth: jest.fn(),
      reportError: jest.fn(),
    };
    const gateway = { setModuleOperationalStatus: jest.fn(), publishModuleEvent: jest.fn() };
    const worker = new SettlementWorkerService(
      queue as any,
      {} as any,
      {} as any,
      monitor as any,
      gateway as any,
    );
    (worker as any).initialized = true;
    jest.spyOn(worker as any, 'wake').mockImplementation(() => undefined);
    return { worker, monitor };
  };

  it('runs recurring reconciliation only after startup has initialized the worker', async () => {
    const queue = {
      reconcileExistingUnsettledTargets: jest.fn().mockResolvedValue({
        candidateEventIds: 3,
        queued: 2,
        skipped: 1,
        failed: 0,
        skippedReasons: {},
      }),
    };
    const { worker } = createWorker(queue);
    await (worker as any).reconcileUnsettledTargets();
    expect(queue.reconcileExistingUnsettledTargets).toHaveBeenCalledTimes(1);
    expect(worker.getRuntimeStatus().targetReconciliationQueued).toBe(2);
  });

  it('does not start reconciliation before the worker is initialized', async () => {
    const queue = { reconcileExistingUnsettledTargets: jest.fn() };
    const { worker } = createWorker(queue);
    (worker as any).initialized = false;
    await (worker as any).reconcileUnsettledTargets();
    expect(queue.reconcileExistingUnsettledTargets).not.toHaveBeenCalled();
  });

  it('records reconciliation failures without crashing the worker', async () => {
    const queue = {
      reconcileExistingUnsettledTargets: jest.fn().mockRejectedValue(new Error('database unavailable')),
    };
    const { worker, monitor } = createWorker(queue);
    await expect((worker as any).reconcileUnsettledTargets()).resolves.toBeUndefined();
    expect(worker.getRuntimeStatus().lastTargetReconciliationError).toContain('database unavailable');
    expect(monitor.reportModuleHealth).toHaveBeenCalledWith(
      'settlement',
      'DEGRADED',
      expect.objectContaining({ source: 'target-reconciliation' }),
    );
  });

  it('uses a bounded five-minute target reconciliation interval', () => {
    expect(SETTLEMENT_CONFIG.queue.targetReconciliationIntervalMs).toBe(5 * 60_000);
  });
});
