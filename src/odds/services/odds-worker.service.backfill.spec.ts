import { OddsWorkerService } from './odds-worker.service';

describe('OddsWorkerService inventory backfill request', () => {
  const makeService = () => {
    const service = Object.create(OddsWorkerService.prototype) as any;
    service.stopping = false;
    service.busy = false;
    service.inventoryBackfillRequested = false;
    service.inventoryBackfillInProgress = false;
    service.lastInventoryBackfillRequestedAt = undefined;
    jest.spyOn(service, 'runSafely').mockResolvedValue(undefined);
    return service;
  };

  it('schedules a fresh bounded inventory pass when the worker is idle', () => {
    const service = makeService();

    const result = service.requestInventoryBackfill();

    expect(result.accepted).toBe(true);
    expect(result.status).toBe('QUEUED');
    expect(result.lookaheadHours).toBeGreaterThan(0);
    expect(service.inventoryBackfillRequested).toBe(true);
    expect(service.lastInventoryBackfillRequestedAt).toBeInstanceOf(Date);
    expect(service.runSafely).toHaveBeenCalledTimes(1);
  });

  it('leaves an active worker page alone and lets the next cycle consume the request', () => {
    const service = makeService();
    service.busy = true;

    const result = service.requestInventoryBackfill();

    expect(result.accepted).toBe(true);
    expect(result.status).toBe('QUEUED');
    expect(service.inventoryBackfillRequested).toBe(true);
    expect(service.runSafely).not.toHaveBeenCalled();
  });

  it('does not enqueue duplicate backfills while one is pending or running', () => {
    const service = makeService();
    service.inventoryBackfillRequested = true;

    const pending = service.requestInventoryBackfill();
    expect(pending).toMatchObject({ accepted: false, status: 'ALREADY_PENDING' });

    service.inventoryBackfillRequested = false;
    service.inventoryBackfillInProgress = true;
    const running = service.requestInventoryBackfill();
    expect(running).toMatchObject({ accepted: false, status: 'ALREADY_PENDING' });
    expect(service.runSafely).not.toHaveBeenCalled();
  });

  it('rejects a request when the worker is stopping', () => {
    const service = makeService();
    service.stopping = true;

    const result = service.requestInventoryBackfill();

    expect(result).toMatchObject({ accepted: false, status: 'DISABLED' });
    expect(service.runSafely).not.toHaveBeenCalled();
  });
});
