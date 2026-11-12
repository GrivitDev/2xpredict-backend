import {
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';

export const BACKGROUND_WORK_LIMITS = {
  maximumConcurrentJobs: 12,
  minimumLaneStartIntervalMs: 1_000,
} as const;

type ReleasePermit = () => void;

interface WaitingPermit {
  lane: string;
  resolve: (release: ReleasePermit) => void;
  reject: (error: Error) => void;
}

/**
 * Process-wide limiter shared by Sports, Odds, Predictions and Settlement.
 *
 * - At most twelve background operations may hold a permit at once.
 * - A lane can hold only one permit at a time.
 * - Consecutive starts in the same lane are at least one second apart.
 * - Waiting lanes are considered in FIFO order, while a cooling-down lane does
 *   not block other lanes that are eligible to run.
 *
 * The limiter controls background work in this Node process. Queue leases and
 * durable queue state remain responsible for cross-process ownership.
 */
@Injectable()
export class BackgroundWorkLimiterService implements OnModuleDestroy {
  private readonly waiting: WaitingPermit[] = [];
  private readonly activeLanes = new Set<string>();
  private readonly nextStartAtByLane = new Map<string, number>();
  private activeJobs = 0;
  private dispatchTimer?: ReturnType<typeof setTimeout>;
  private shuttingDown = false;

  acquire(lane: string): Promise<ReleasePermit> {
    const normalizedLane = String(lane ?? '').trim();
    if (!normalizedLane) {
      return Promise.reject(new Error('A background-work lane name is required.'));
    }
    if (this.shuttingDown) {
      return Promise.reject(new Error('Background-work limiter is shutting down.'));
    }

    return new Promise<ReleasePermit>((resolve, reject) => {
      this.waiting.push({ lane: normalizedLane, resolve, reject });
      this.dispatch();
    });
  }

  getStatus(): {
    activeJobs: number;
    maximumConcurrentJobs: number;
    waitingJobs: number;
    activeLanes: string[];
    minimumLaneStartIntervalMs: number;
  } {
    return {
      activeJobs: this.activeJobs,
      maximumConcurrentJobs: BACKGROUND_WORK_LIMITS.maximumConcurrentJobs,
      waitingJobs: this.waiting.length,
      activeLanes: [...this.activeLanes],
      minimumLaneStartIntervalMs: BACKGROUND_WORK_LIMITS.minimumLaneStartIntervalMs,
    };
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
    this.dispatchTimer = undefined;

    const error = new Error('Background-work limiter shut down before a permit was granted.');
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
  }

  private dispatch(): void {
    if (this.shuttingDown) return;
    if (this.dispatchTimer) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = undefined;
    }

    while (this.activeJobs < BACKGROUND_WORK_LIMITS.maximumConcurrentJobs) {
      const now = Date.now();
      const eligibleIndex = this.waiting.findIndex((waiter) => {
        if (this.activeLanes.has(waiter.lane)) return false;
        return (this.nextStartAtByLane.get(waiter.lane) ?? 0) <= now;
      });
      if (eligibleIndex < 0) break;

      const [waiter] = this.waiting.splice(eligibleIndex, 1);
      this.activeJobs += 1;
      this.activeLanes.add(waiter.lane);
      this.nextStartAtByLane.set(
        waiter.lane,
        now + BACKGROUND_WORK_LIMITS.minimumLaneStartIntervalMs,
      );

      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.activeJobs = Math.max(0, this.activeJobs - 1);
        this.activeLanes.delete(waiter.lane);
        this.dispatch();
      });
    }

    if (
      this.activeJobs >= BACKGROUND_WORK_LIMITS.maximumConcurrentJobs ||
      this.waiting.length === 0
    ) return;

    const now = Date.now();
    let earliestEligibleStart = Number.POSITIVE_INFINITY;
    for (const waiter of this.waiting) {
      if (this.activeLanes.has(waiter.lane)) continue;
      earliestEligibleStart = Math.min(
        earliestEligibleStart,
        this.nextStartAtByLane.get(waiter.lane) ?? now,
      );
    }

    // If every waiting request belongs to an already-active lane, its release
    // will call dispatch again. No polling timer is needed in that case.
    if (!Number.isFinite(earliestEligibleStart)) return;

    const delayMs = Math.max(1, earliestEligibleStart - now);
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = undefined;
      this.dispatch();
    }, delayMs);
    (this.dispatchTimer as unknown as { unref?: () => void }).unref?.();
  }
}
