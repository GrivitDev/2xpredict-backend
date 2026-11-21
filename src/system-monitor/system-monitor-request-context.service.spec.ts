import { SystemMonitorRequestContextService } from './system-monitor-request-context.service';

describe('SystemMonitorRequestContextService', () => {
  let service: SystemMonitorRequestContextService;

  beforeEach(() => {
    service = new SystemMonitorRequestContextService();
  });

  it('keeps database counters isolated to the active async request context', async () => {
    const context = {
      module: 'sports',
      operation: 'GET SportsController.getMatch',
      databaseOperations: 0,
      databaseCompletedOperations: 0,
      databaseDurationMs: 0,
      slowDatabaseOperations: 0,
      databaseFailures: 0,
    };

    await service.run(context, async () => {
      service.recordDatabaseOperationStarted();
      await Promise.resolve();
      const captured = service.getCurrent();
      service.recordDatabaseOperationCompleted(captured, 525, false, 500);
    });

    expect(context).toEqual({
      module: 'sports',
      operation: 'GET SportsController.getMatch',
      databaseOperations: 1,
      databaseCompletedOperations: 1,
      databaseDurationMs: 525,
      slowDatabaseOperations: 1,
      databaseFailures: 0,
    });
    expect(service.getCurrent()).toBeUndefined();
  });

  it('does not create request metrics outside an HTTP request context', () => {
    expect(service.recordDatabaseOperationStarted()).toBeUndefined();
    expect(() =>
      service.recordDatabaseOperationCompleted(undefined, 25, false, 500),
    ).not.toThrow();
  });
});
