import { EventEmitter } from 'node:events';
import { SystemMonitorDatabaseTrackerService } from './system-monitor-database-tracker.service';
import { SystemMonitorRequestContextService } from './system-monitor-request-context.service';

describe('SystemMonitorDatabaseTrackerService performance telemetry', () => {
  let client: EventEmitter & { options?: { maxPoolSize?: number } };
  let service: SystemMonitorDatabaseTrackerService;
  let requestContext: SystemMonitorRequestContextService;
  let systemMonitor: { reportModuleHealth: jest.Mock; reportError: jest.Mock };

  beforeEach(() => {
    client = new EventEmitter() as EventEmitter & {
      options?: { maxPoolSize?: number };
    };
    client.options = { maxPoolSize: 8 };
    requestContext = new SystemMonitorRequestContextService();
    systemMonitor = {
      reportModuleHealth: jest.fn(),
      reportError: jest.fn(),
    };

    const connection = {
      getClient: jest.fn(() => client),
      readyState: 1,
      name: '2xpredict',
    };

    service = new SystemMonitorDatabaseTrackerService(
      connection as any,
      systemMonitor as any,
      requestContext,
    );
    service.onApplicationBootstrap();
  });

  afterEach(() => service.onModuleDestroy());

  it('attributes MongoDB command events to the active HTTP request', () => {
    const context = {
      module: 'sports',
      operation: 'GET SportsController.getMatch',
      databaseOperations: 0,
      databaseCompletedOperations: 0,
      databaseDurationMs: 0,
      slowDatabaseOperations: 0,
      databaseFailures: 0,
    };

    requestContext.run(context, () => {
      client.emit('commandStarted', {
        requestId: 11,
        commandName: 'find',
        databaseName: '2xpredict',
        command: { find: 'sports_fixtures' },
      });
    });

    client.emit('commandSucceeded', { requestId: 11, duration: 32 });

    expect(context).toEqual(
      expect.objectContaining({
        databaseOperations: 1,
        databaseCompletedOperations: 1,
        databaseDurationMs: 32,
        slowDatabaseOperations: 0,
        databaseFailures: 0,
      }),
    );
  });

  it('reports pool checkout pressure and configured pool capacity', () => {
    client.emit('connectionPoolCreated', { address: 'mongo-a:27017' });
    client.emit('connectionPoolReady', { address: 'mongo-a:27017' });
    client.emit('connectionCreated', { address: 'mongo-a:27017', connectionId: 1 });
    client.emit('connectionReady', { address: 'mongo-a:27017', connectionId: 1 });
    client.emit('connectionCheckOutStarted', { address: 'mongo-a:27017' });
    client.emit('connectionCheckedOut', { address: 'mongo-a:27017', connectionId: 1 });

    const checkedOut = service.getConnectionPoolMetrics() as any;
    expect(checkedOut.configuredMaxPoolSize).toBe(8);
    expect(checkedOut.totals.checkedOut).toBe(1);
    expect(checkedOut.totals.waiting).toBe(0);
    expect(checkedOut.pools[0].connectionsReady).toBe(1);

    client.emit('connectionCheckedIn', { address: 'mongo-a:27017', connectionId: 1 });
    client.emit('connectionCheckOutStarted', { address: 'mongo-a:27017' });

    const waiting = service.getConnectionPoolMetrics() as any;
    expect(waiting.totals.checkedOut).toBe(0);
    expect(waiting.totals.waiting).toBe(1);
    expect(waiting.totals.maxObservedWaiters).toBe(1);
  });
});
