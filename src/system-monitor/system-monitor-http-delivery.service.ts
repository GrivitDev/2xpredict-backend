import { Injectable } from '@nestjs/common';

const MAX_TRACKED_OPERATIONS = 100;
const MAX_SAMPLES_PER_OPERATION = 200;
const SLOW_HTTP_DELIVERY_MS = 1_000;

type ContentEncoding = 'identity' | 'gzip' | 'br' | 'deflate' | 'zstd' | 'other';

interface HttpDeliveryMetric {
  module: string;
  operation: string;
  totalResponses: number;
  failures: number;
  slowResponses: number;
  abortedResponses: number;
  averageDurationMs: number;
  lastDurationMs: number;
  durationSamples: number[];
  knownSizeResponses: number;
  unknownSizeResponses: number;
  totalResponseBytes: number;
  maxResponseBytes: number;
  contentEncodings: Record<ContentEncoding, number>;
  lastStatusCode: number;
  lastAt: Date;
}

export interface HttpDeliveryRecord {
  module: string;
  operation: string;
  statusCode: number;
  durationMs: number;
  responseBytes?: number;
  contentEncoding?: string;
  aborted?: boolean;
}

/**
 * Bounded, process-local HTTP delivery telemetry.
 * It stores route labels and numeric measurements only; never payloads, URLs,
 * query strings, headers, cookies, or user identifiers.
 */
@Injectable()
export class SystemMonitorHttpDeliveryService {
  private readonly metrics = new Map<string, HttpDeliveryMetric>();

  recordResponse(record: HttpDeliveryRecord): void {
    const module = this.safeLabel(record.module, 'unknown', 80);
    const operation = this.safeLabel(record.operation, 'unknown', 160);
    const key = `${module}:${operation}`;
    let metric = this.metrics.get(key);

    if (!metric) {
      this.evictOldestOperationIfNeeded();
      metric = {
        module,
        operation,
        totalResponses: 0,
        failures: 0,
        slowResponses: 0,
        abortedResponses: 0,
        averageDurationMs: 0,
        lastDurationMs: 0,
        durationSamples: [],
        knownSizeResponses: 0,
        unknownSizeResponses: 0,
        totalResponseBytes: 0,
        maxResponseBytes: 0,
        contentEncodings: {
          identity: 0,
          gzip: 0,
          br: 0,
          deflate: 0,
          zstd: 0,
          other: 0,
        },
        lastStatusCode: 0,
        lastAt: new Date(),
      };
      this.metrics.set(key, metric);
    }

    const durationMs = Number.isFinite(record.durationMs)
      ? Math.max(0, record.durationMs)
      : 0;
    const responseBytes = Number.isSafeInteger(record.responseBytes) &&
      (record.responseBytes as number) >= 0
      ? record.responseBytes as number
      : undefined;

    metric.totalResponses += 1;
    metric.failures += record.statusCode >= 500 ? 1 : 0;
    metric.slowResponses += durationMs >= SLOW_HTTP_DELIVERY_MS ? 1 : 0;
    metric.abortedResponses += record.aborted ? 1 : 0;
    metric.averageDurationMs =
      metric.averageDurationMs +
      (durationMs - metric.averageDurationMs) / metric.totalResponses;
    metric.lastDurationMs = Math.round(durationMs * 100) / 100;
    metric.lastStatusCode = Number.isFinite(record.statusCode)
      ? Math.trunc(record.statusCode)
      : 0;
    metric.lastAt = new Date();
    metric.durationSamples.push(durationMs);

    if (metric.durationSamples.length > MAX_SAMPLES_PER_OPERATION) {
      metric.durationSamples.shift();
    }

    if (responseBytes === undefined) {
      metric.unknownSizeResponses += 1;
    } else {
      metric.knownSizeResponses += 1;
      metric.totalResponseBytes += responseBytes;
      metric.maxResponseBytes = Math.max(metric.maxResponseBytes, responseBytes);
    }

    const encoding = this.normalizeEncoding(record.contentEncoding);
    metric.contentEncodings[encoding] += 1;
  }

  getMetrics(limit?: number) {
    const safeLimit = Number.isFinite(limit)
      ? Math.min(Math.max(Math.floor(limit as number), 1), 100)
      : 50;

    const operations = [...this.metrics.values()]
      .map((metric) => {
        const sortedDurations = [...metric.durationSamples].sort((a, b) => a - b);
        return {
          module: metric.module,
          operation: metric.operation,
          totalResponses: metric.totalResponses,
          failures: metric.failures,
          slowResponses: metric.slowResponses,
          abortedResponses: metric.abortedResponses,
          averageDurationMs: Math.round(metric.averageDurationMs * 100) / 100,
          lastDurationMs: metric.lastDurationMs,
          p50DurationMs: this.percentile(sortedDurations, 0.5),
          p95DurationMs: this.percentile(sortedDurations, 0.95),
          p99DurationMs: this.percentile(sortedDurations, 0.99),
          sampleWindowResponses: sortedDurations.length,
          knownSizeResponses: metric.knownSizeResponses,
          unknownSizeResponses: metric.unknownSizeResponses,
          averageResponseBytes: metric.knownSizeResponses > 0
            ? Math.round(metric.totalResponseBytes / metric.knownSizeResponses)
            : null,
          maxResponseBytes: metric.maxResponseBytes,
          contentEncodings: { ...metric.contentEncodings },
          lastStatusCode: metric.lastStatusCode,
          lastAt: metric.lastAt,
        };
      })
      .sort(
        (a, b) =>
          b.p95DurationMs - a.p95DurationMs ||
          b.totalResponses - a.totalResponses,
      );

    return {
      generatedAt: new Date(),
      slowThresholdMs: SLOW_HTTP_DELIVERY_MS,
      maxTrackedOperations: MAX_TRACKED_OPERATIONS,
      maxSamplesPerOperation: MAX_SAMPLES_PER_OPERATION,
      trackedOperations: this.metrics.size,
      operations: operations.slice(0, safeLimit),
      note: 'Duration ends when the Node HTTP response finishes. Response bytes are reported only when Content-Length is available at the Nest/Node boundary.',
    };
  }

  private percentile(sortedSamples: number[], percentile: number): number {
    if (sortedSamples.length === 0) return 0;
    const index = Math.max(0, Math.ceil(percentile * sortedSamples.length) - 1);
    return Math.round(sortedSamples[index] * 100) / 100;
  }

  private normalizeEncoding(value?: string): ContentEncoding {
    const encoding = value?.trim().toLowerCase();
    if (!encoding) return 'identity';
    if (encoding.includes('gzip')) return 'gzip';
    if (encoding.includes('br')) return 'br';
    if (encoding.includes('deflate')) return 'deflate';
    if (encoding.includes('zstd')) return 'zstd';
    if (encoding === 'identity') return 'identity';
    return 'other';
  }

  private safeLabel(value: string, fallback: string, maxLength: number): string {
    const normalized = String(value ?? '')
      .replace(/[^a-zA-Z0-9_.:/ -]/g, '')
      .trim()
      .slice(0, maxLength);
    return normalized || fallback;
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
