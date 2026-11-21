import { Injectable } from '@nestjs/common';

export interface HttpRequestTelemetryDetails {
  databaseOperations?: number;
  databaseCompletedOperations?: number;
  databasePendingOperations?: number;
  databaseDurationMs?: number;
  slowDatabaseOperations?: number;
  databaseFailures?: number;
  responseBytes?: number | null;
  responseSizeSource?: 'measured' | 'content-length' | 'unknown';
  aborted?: boolean;
}

interface RequestPerformanceMetric {
  module: string;
  operation: string;
  totalRequests: number;
  failures: number;
  slowRequests: number;
  abortedResponses: number;
  averageDurationMs: number;
  lastDurationMs: number;
  lastAt: Date;
  samples: number[];
  totalDatabaseOperations: number;
  totalDatabaseCompletedOperations: number;
  totalDatabasePendingOperations: number;
  totalDatabaseDurationMs: number;
  slowDatabaseOperations: number;
  databaseFailures: number;
  databaseOperationSamples: number[];
  databaseDurationSamples: number[];
  totalResponseBytes: number;
  knownResponseSizes: number;
  measuredResponseSizes: number;
  contentLengthResponseSizes: number;
  unknownResponseSizes: number;
  responseByteSamples: number[];
}

const SLOW_HTTP_REQUEST_MS = 1_000;
const MAX_TRACKED_OPERATIONS = 250;
const MAX_SAMPLES_PER_OPERATION = 200;

/**
 * Bounded, in-memory request latency telemetry.
 *
 * Only module and controller/handler names are retained. Request URLs,
 * query strings, headers, bodies, user identifiers and response payloads
 * are deliberately not captured.
 */
@Injectable()
export class SystemMonitorPerformanceService {
  private readonly metrics = new Map<string, RequestPerformanceMetric>();

  recordHttpRequest(
    moduleName: string,
    operation: string,
    statusCode: number,
    durationMs: number,
    details: HttpRequestTelemetryDetails = {},
  ): void {
    const safeModule = String(moduleName || 'unknown').slice(0, 80);
    const safeOperation = String(operation || 'HTTP handler').slice(0, 160);
    const safeDuration = Number.isFinite(durationMs)
      ? Math.max(0, durationMs)
      : 0;
    const safeStatus = Number.isFinite(statusCode) ? statusCode : 500;
    const key = `${safeModule}\u0000${safeOperation}`;
    const now = new Date();

    let metric = this.metrics.get(key);

    if (!metric) {
      this.evictOldestOperationIfNeeded();
      metric = {
        module: safeModule,
        operation: safeOperation,
        totalRequests: 0,
        failures: 0,
        slowRequests: 0,
        abortedResponses: 0,
        averageDurationMs: 0,
        lastDurationMs: 0,
        lastAt: now,
        samples: [],
        totalDatabaseOperations: 0,
        totalDatabaseCompletedOperations: 0,
        totalDatabasePendingOperations: 0,
        totalDatabaseDurationMs: 0,
        slowDatabaseOperations: 0,
        databaseFailures: 0,
        databaseOperationSamples: [],
        databaseDurationSamples: [],
        totalResponseBytes: 0,
        knownResponseSizes: 0,
        measuredResponseSizes: 0,
        contentLengthResponseSizes: 0,
        unknownResponseSizes: 0,
        responseByteSamples: [],
      };
      this.metrics.set(key, metric);
    }

    const previousCount = metric.totalRequests;
    metric.totalRequests += 1;
    metric.failures += safeStatus >= 500 ? 1 : 0;
    metric.slowRequests += safeDuration >= SLOW_HTTP_REQUEST_MS ? 1 : 0;
    metric.abortedResponses += details.aborted ? 1 : 0;
    metric.averageDurationMs = Math.round(
      (metric.averageDurationMs * previousCount + safeDuration) /
        metric.totalRequests,
    );
    metric.lastDurationMs = Math.round(safeDuration);
    metric.lastAt = now;
    this.pushSample(metric.samples, safeDuration);

    const databaseOperations = this.safeNonNegativeInteger(
      details.databaseOperations,
    );
    const databaseCompletedOperations = this.safeNonNegativeInteger(
      details.databaseCompletedOperations,
    );
    const databasePendingOperations = this.safeNonNegativeInteger(
      details.databasePendingOperations,
    );
    const databaseDurationMs = this.safeNonNegativeNumber(
      details.databaseDurationMs,
    );

    metric.totalDatabaseOperations += databaseOperations;
    metric.totalDatabaseCompletedOperations += databaseCompletedOperations;
    metric.totalDatabasePendingOperations += databasePendingOperations;
    metric.totalDatabaseDurationMs += databaseDurationMs;
    metric.slowDatabaseOperations += this.safeNonNegativeInteger(
      details.slowDatabaseOperations,
    );
    metric.databaseFailures += this.safeNonNegativeInteger(
      details.databaseFailures,
    );
    this.pushSample(metric.databaseOperationSamples, databaseOperations);
    this.pushSample(metric.databaseDurationSamples, databaseDurationMs);

    if (Number.isFinite(details.responseBytes) && (details.responseBytes as number) >= 0) {
      const responseBytes = Math.round(details.responseBytes as number);
      metric.totalResponseBytes += responseBytes;
      metric.knownResponseSizes += 1;
      if (details.responseSizeSource === 'measured') {
        metric.measuredResponseSizes += 1;
      } else if (details.responseSizeSource === 'content-length') {
        metric.contentLengthResponseSizes += 1;
      }
      this.pushSample(metric.responseByteSamples, responseBytes);
    } else {
      metric.unknownResponseSizes += 1;
    }
  }

  getRequestMetrics(limit?: number) {
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(100, Math.floor(limit as number)))
      : 50;

    const operations = [...this.metrics.values()]
      .map((metric) => {
        const sortedSamples = this.sorted(metric.samples);
        const sortedDatabaseOperationSamples = this.sorted(
          metric.databaseOperationSamples,
        );
        const sortedDatabaseDurationSamples = this.sorted(
          metric.databaseDurationSamples,
        );
        const sortedResponseBytes = this.sorted(metric.responseByteSamples);

        return {
          module: metric.module,
          operation: metric.operation,
          totalRequests: metric.totalRequests,
          failures: metric.failures,
          slowRequests: metric.slowRequests,
          abortedResponses: metric.abortedResponses,
          averageDurationMs: metric.averageDurationMs,
          lastDurationMs: metric.lastDurationMs,
          p50DurationMs: this.percentile(sortedSamples, 0.5),
          p95DurationMs: this.percentile(sortedSamples, 0.95),
          p99DurationMs: this.percentile(sortedSamples, 0.99),
          sampleWindowRequests: sortedSamples.length,
          database: {
            totalOperations: metric.totalDatabaseOperations,
            completedOperations: metric.totalDatabaseCompletedOperations,
            pendingOperationsAtResponse: metric.totalDatabasePendingOperations,
            averageOperationsPerRequest:
              metric.totalRequests > 0
                ? this.round(metric.totalDatabaseOperations / metric.totalRequests)
                : 0,
            p95OperationsPerRequest: this.percentile(
              sortedDatabaseOperationSamples,
              0.95,
            ),
            totalDurationMs: Math.round(metric.totalDatabaseDurationMs),
            averageDurationMsPerRequest:
              metric.totalRequests > 0
                ? this.round(metric.totalDatabaseDurationMs / metric.totalRequests)
                : 0,
            p95DurationMsPerRequest: this.percentile(
              sortedDatabaseDurationSamples,
              0.95,
            ),
            slowOperations: metric.slowDatabaseOperations,
            failures: metric.databaseFailures,
          },
          response: {
            knownSizeResponses: metric.knownResponseSizes,
            measuredResponses: metric.measuredResponseSizes,
            contentLengthResponses: metric.contentLengthResponseSizes,
            unknownSizeResponses: metric.unknownResponseSizes,
            averageBytes:
              metric.knownResponseSizes > 0
                ? Math.round(metric.totalResponseBytes / metric.knownResponseSizes)
                : null,
            p95Bytes:
              sortedResponseBytes.length > 0
                ? this.percentile(sortedResponseBytes, 0.95)
                : null,
            totalMeasuredBytes: metric.totalResponseBytes,
          },
          lastAt: metric.lastAt,
        };
      })
      .sort(
        (a, b) =>
          b.p95DurationMs - a.p95DurationMs ||
          b.totalRequests - a.totalRequests,
      );

    return {
      generatedAt: new Date(),
      processUptimeSeconds: Math.floor(process.uptime()),
      slowThresholdMs: SLOW_HTTP_REQUEST_MS,
      maxSamplesPerOperation: MAX_SAMPLES_PER_OPERATION,
      trackedOperations: this.metrics.size,
      operations: operations.slice(0, safeLimit),
    };
  }

  private pushSample(samples: number[], value: number): void {
    samples.push(value);
    if (samples.length > MAX_SAMPLES_PER_OPERATION) samples.shift();
  }

  private sorted(samples: number[]): number[] {
    return [...samples].sort((a, b) => a - b);
  }

  private safeNonNegativeInteger(value?: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : 0;
  }

  private safeNonNegativeNumber(value?: number): number {
    return Number.isFinite(value) ? Math.max(0, value as number) : 0;
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private percentile(sortedSamples: number[], percentile: number): number {
    if (sortedSamples.length === 0) return 0;

    const index = Math.max(
      0,
      Math.ceil(percentile * sortedSamples.length) - 1,
    );

    return Math.round(sortedSamples[index]);
  }

  private evictOldestOperationIfNeeded(): void {
    if (this.metrics.size < MAX_TRACKED_OPERATIONS) return;

    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;

    for (const [key, metric] of this.metrics.entries()) {
      const timestamp = metric.lastAt.getTime();

      if (timestamp < oldestAt) {
        oldestAt = timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) this.metrics.delete(oldestKey);
  }
}
