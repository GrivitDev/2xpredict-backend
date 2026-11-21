import { SystemMonitorHttpDeliveryService } from './system-monitor-http-delivery.service';

describe('SystemMonitorHttpDeliveryService', () => {
  let service: SystemMonitorHttpDeliveryService;

  beforeEach(() => {
    service = new SystemMonitorHttpDeliveryService();
  });

  it('aggregates response latency, size, and content encoding without storing payloads', () => {
    service.recordResponse({
      module: 'sports',
      operation: 'GET SportsController.getFixtures',
      statusCode: 200,
      durationMs: 120,
      responseBytes: 2_000,
      contentEncoding: 'gzip',
    });
    service.recordResponse({
      module: 'sports',
      operation: 'GET SportsController.getFixtures',
      statusCode: 500,
      durationMs: 1_200,
      responseBytes: 4_000,
    });

    const result = service.getMetrics() as any;
    const [operation] = result.operations;

    expect(operation.totalResponses).toBe(2);
    expect(operation.failures).toBe(1);
    expect(operation.slowResponses).toBe(1);
    expect(operation.p50DurationMs).toBe(120);
    expect(operation.p95DurationMs).toBe(1_200);
    expect(operation.averageResponseBytes).toBe(3_000);
    expect(operation.maxResponseBytes).toBe(4_000);
    expect(operation.contentEncodings.gzip).toBe(1);
    expect(operation.contentEncodings.identity).toBe(1);
  });

  it('tracks unknown lengths and aborted responses separately', () => {
    service.recordResponse({
      module: 'sports',
      operation: 'GET SportsController.getMatch',
      statusCode: 200,
      durationMs: 25,
      aborted: true,
    });

    const result = service.getMetrics() as any;
    const [operation] = result.operations;

    expect(operation.abortedResponses).toBe(1);
    expect(operation.knownSizeResponses).toBe(0);
    expect(operation.unknownSizeResponses).toBe(1);
    expect(operation.averageResponseBytes).toBeNull();
  });

  it('retains a bounded latency sample window', () => {
    for (let index = 0; index < 250; index += 1) {
      service.recordResponse({
        module: 'sports',
        operation: 'GET SportsController.getFixtures',
        statusCode: 200,
        durationMs: index,
      });
    }

    const result = service.getMetrics() as any;
    expect(result.operations[0].totalResponses).toBe(250);
    expect(result.operations[0].sampleWindowResponses).toBe(200);
    expect(result.maxSamplesPerOperation).toBe(200);
  });
});
