import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { monitorEventLoopDelay, IntervalHistogram } from 'node:perf_hooks';
import { SystemMonitorService } from './system-monitor.service';

const SAMPLE_INTERVAL_MS = 5 * 60_000;

/**
 * Low-overhead in-process telemetry. Samples CPU, event-loop delay and memory
 * into the in-memory SystemMonitorService; it never writes one document per sample.
 */
@Injectable()
export class SystemMonitorRuntimeService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SystemMonitorRuntimeService.name);
  private histogram?: IntervalHistogram;
  private timer?: ReturnType<typeof setInterval>;
  private previousCpuUsage = process.cpuUsage();
  private previousSampleAt = Date.now();

  constructor(private readonly monitor: SystemMonitorService) {}

  onApplicationBootstrap(): void {
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
    this.previousCpuUsage = process.cpuUsage();
    this.previousSampleAt = Date.now();
    this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.histogram?.disable();
  }

  private sample(): void {
    try {
      const now = Date.now();
      const elapsedMs = Math.max(1, now - this.previousSampleAt);
      const cpu = process.cpuUsage(this.previousCpuUsage);
      this.previousCpuUsage = process.cpuUsage();
      this.previousSampleAt = now;

      const cpuCount = Math.max(1, cpus().length);
      const processCpuPercent = Math.min(100, Math.max(0, ((cpu.user + cpu.system) / (elapsedMs * 1000 * cpuCount)) * 100));
      const memory = process.memoryUsage();
      const totalMemoryBytes = totalmem();
      const freeMemoryBytes = freemem();
      const eventLoopP95Ms = this.histogram ? this.histogram.percentile(95) / 1_000_000 : 0;
      const eventLoopMaxMs = this.histogram ? this.histogram.max / 1_000_000 : 0;
      const metrics: Record<string, number> = {
        processCpuPercent: this.round(processCpuPercent),
        eventLoopP95Ms: this.round(eventLoopP95Ms),
        eventLoopMaxMs: this.round(eventLoopMaxMs),
        processRssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        systemMemoryTotalBytes: totalMemoryBytes,
        systemMemoryFreeBytes: freeMemoryBytes,
        systemMemoryUsedPercent: totalMemoryBytes > 0 ? this.round(((totalMemoryBytes - freeMemoryBytes) / totalMemoryBytes) * 100) : 0,
      };
      if (process.platform !== 'win32') {
        const [load1, load5, load15] = loadavg();
        metrics.loadAverage1m = this.round(load1);
        metrics.loadAverage5m = this.round(load5);
        metrics.loadAverage15m = this.round(load15);
      }
      this.monitor.reportRuntimeMetrics(metrics);
      this.histogram?.reset();
    } catch (error) {
      this.logger.warn(`Runtime telemetry sample failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private round(value: number): number {
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
  }
}
