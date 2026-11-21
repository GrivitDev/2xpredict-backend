import { SystemMonitorPerformanceService } from './system-monitor-performance.service';

describe('SystemMonitorPerformanceService', () => {
  let service: SystemMonitorPerformanceService;

  beforeEach(() => {
    service = new SystemMonitorPerformanceService();
  });

  it('aggregates request database counts, database time and response sizes', () => {
    service.recordHttpRequest('sports', 'GET SportsController.getMatch', 200, 250, {
      databaseOperations: 4,
      databaseCompletedOperations: 4,
      databasePendingOperations: 0,
      databaseDurationMs: 80,
      slowDatabaseOperations: 0,
      databaseFailures: 0,
      responseBytes: 12_000,
      responseSizeSource: 'measured',
    });

    service.recordHttpRequest('sports', 'GET SportsController.getMatch', 200, 500, {
      databaseOperations: 6,
      databaseCompletedOperations: 5,
      databasePendingOperations: 1,
      databaseDurationMs: 330,
      slowDatabaseOperations: 1,
      databaseFailures: 1,
      responseBytes: null,
      responseSizeSource: 'unknown',
      aborted: true,
    });

    const result = service.getRequestMetrics() as any;
    const operation = result.operations[0];

    expect(operation.totalRequests).toBe(2);
    expect(operation.abortedResponses).toBe(1);
    expect(operation.database).toEqual(
      expect.objectContaining({
        totalOperations: 10,
        completedOperations: 9,
        pendingOperationsAtResponse: 1,
        averageOperationsPerRequest: 5,
        totalDurationMs: 410,
        averageDurationMsPerRequest: 205,
        slowOperations: 1,
        failures: 1,
      }),
    );
    expect(operation.response).toEqual(
      expect.objectContaining({
        knownSizeResponses: 1,
        measuredResponses: 1,
        contentLengthResponses: 0,
        unknownSizeResponses: 1,
        averageBytes: 12_000,
        totalMeasuredBytes: 12_000,
      }),
    );
  });

  it('retains the existing request latency percentile fields', () => {
    service.recordHttpRequest('predictions', 'GET PredictionsController.list', 200, 120);
    service.recordHttpRequest('predictions', 'GET PredictionsController.list', 200, 300);

    const result = service.getRequestMetrics() as any;
    const operation = result.operations[0];

    expect(operation).toEqual(
      expect.objectContaining({
        p50DurationMs: 120,
        p95DurationMs: 300,
        p99DurationMs: 300,
        sampleWindowRequests: 2,
      }),
    );
  });
});
