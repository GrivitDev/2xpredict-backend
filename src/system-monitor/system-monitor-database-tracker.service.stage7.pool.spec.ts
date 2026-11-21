import { EventEmitter } from 'events';
import type { Connection } from 'mongoose';
import { SystemMonitorDatabaseTrackerService } from './system-monitor-database-tracker.service';

describe('SystemMonitorDatabaseTrackerService MongoDB pool telemetry', () => {
  let client: EventEmitter;
  let service: SystemMonitorDatabaseTrackerService;
  let systemMonitor: { reportModuleHealth: jest.Mock; reportError: jest.Mock };

  beforeEach(() => {
    client = new EventEmitter();
    systemMonitor = {
      reportModuleHealth: jest.fn(),
      reportError: jest.fn(),
    };
    const connection = {
      getClient: jest.fn().mockReturnValue(client),
      name: '2xpredict-test',
    } as unknown as Connection;

    service = new SystemMonitorDatabaseTrackerService(
      connection,
      systemMonitor as any,
    );
    service.onApplicationBootstrap();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('records checkout wait, failures, pool lifecycle and observed in-use connections without exposing host addresses', () => {
    const address = 'mongodb.internal.example:27017';
    client.emit('connectionPoolCreated', {
      address,
      time: new Date(),
      options: {
        maxPoolSize: 40,
        minPoolSize: 0,
        maxConnecting: 2,
        maxIdleTimeMS: 30_000,
        waitQueueTimeoutMS: 5_000,
      },
    });
    client.emit('connectionPoolReady', { address, time: new Date() });
    client.emit('connectionCreated', { address, connectionId: 7, time: new Date() });
    client.emit('connectionReady', { address, connectionId: 7, durationMS: 18, time: new Date() });

    client.emit('connectionCheckOutStarted', { address, time: new Date() });
    client.emit('connectionCheckedOut', {
      address,
      connectionId: 7,
      durationMS: 12,
      time: new Date(),
    });
    expect(service.getPoolMetrics().pools[0].connectionEvents.inUseObserved).toBe(1);
    client.emit('connectionCheckedIn', { address, connectionId: 7, time: new Date() });

    client.emit('connectionCheckOutStarted', { address, time: new Date() });
    client.emit('connectionCheckOutFailed', {
      address,
      reason: 'timeout',
      durationMS: 125,
      time: new Date(),
    });
    client.emit('connectionPoolCleared', { address, time: new Date() });
    client.emit('connectionClosed', { address, connectionId: 7, reason: 'poolClosed', time: new Date() });
    client.emit('connectionPoolClosed', { address, time: new Date() });

    const result = service.getPoolMetrics();
    expect(result.monitoringActive).toBe(true);
    expect(result.trackedPools).toBe(1);
    expect(result.totals).toMatchObject({
      checkoutStarted: 2,
      checkoutSucceeded: 1,
      checkoutFailed: 1,
      inUseObserved: 0,
    });
    expect(result.pools[0]).toMatchObject({
      poolId: 'pool-1',
      state: 'CLOSED',
      options: {
        maxPoolSize: 40,
        minPoolSize: 0,
        maxConnecting: 2,
        maxIdleTimeMS: 30_000,
        waitQueueTimeoutMS: 5_000,
      },
      poolEvents: { created: 1, ready: 1, cleared: 1, closed: 1 },
      connectionEvents: { created: 1, ready: 1, closed: 1, checkedOutObserved: 1, checkedInObserved: 1, inUseObserved: 0 },
      checkout: {
        started: 2,
        succeeded: 1,
        failed: 1,
        failureReasons: { timeout: 1 },
        sampleWindowSize: 2,
        averageRecentWaitMs: 69,
        p50WaitMs: 12,
        p95WaitMs: 125,
      },
      observedUtilizationPercent: 0,
    });
    expect(JSON.stringify(result)).not.toContain(address);
  });

  it('returns an empty, safe result before pool events are observed', () => {
    const result = service.getPoolMetrics();
    expect(result.monitoringActive).toBe(true);
    expect(result.trackedPools).toBe(0);
    expect(result.pools).toEqual([]);
    expect(result.totals).toEqual({
      checkoutStarted: 0,
      checkoutSucceeded: 0,
      checkoutFailed: 0,
      inUseObserved: 0,
    });
  });

  it('removes pool event listeners when the service is destroyed', () => {
    expect(client.listenerCount('connectionPoolCreated')).toBe(1);
    expect(client.listenerCount('connectionCheckedOut')).toBe(1);
    service.onModuleDestroy();
    expect(client.listenerCount('connectionPoolCreated')).toBe(0);
    expect(client.listenerCount('connectionCheckedOut')).toBe(0);
  });
});
