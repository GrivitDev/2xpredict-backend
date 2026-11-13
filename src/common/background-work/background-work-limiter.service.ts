import { Injectable, OnModuleDestroy } from '@nestjs/common';

/**
 * Capacity is intentionally conservative for the 2-vCPU production instance.
 * Queue workers remain single-job-per-lane; this is the process-wide ceiling.
 */
export const BACKGROUND_WORK_LIMITS = {
  maximumConcurrentJobs: 6,
  minimumLaneStartIntervalMs: 1_000,
  priorityAgingIntervalMs: 15_000,
  maximumPriorityAgingBoost: 80,
} as const;

export const BACKGROUND_WORK_PRIORITY = {
  CRITICAL: 100,
  HIGH: 90,
  NORMAL: 60,
  LOW: 20,
} as const;

type ReleasePermit = () => void;

interface WaitingPermit {
  lane: string;
  priority: number;
  enqueuedAt: number;
  sequence: number;
  resolve: (release: ReleasePermit) => void;
  reject: (error: Error) => void;
}

/**
 * Process-wide limiter shared by Sports, Odds, Predictions, Settlement and
 * Bet Lab. High-value live, pricing, prediction and settlement work gets first
 * access to capacity. Background maintenance is aged while waiting so it
 * continues to make progress instead of being permanently starved.
 *
 * - At most six background operations hold a permit at once.
 * - A lane holds at most one permit at a time.
 * - Consecutive starts in one lane are at least one second apart.
 * - Eligible waiters are scheduled by priority, then FIFO; age increases
 *   non-critical priority by five points every fifteen seconds, up to 99.
 * - Queue leases remain responsible for cross-process job ownership.
 */
@Injectable()
export class BackgroundWorkLimiterService implements OnModuleDestroy {
  private readonly waiting: WaitingPermit[] = [];
  private readonly activeLanes = new Set<string>();
  private readonly nextStartAtByLane = new Map<string, number>();
  private activeJobs = 0;
  private nextSequence = 0;
  private dispatchTimer?: ReturnType<typeof setTimeout>;
  private shuttingDown = false;

  acquire(lane: string, requestedPriority?: number): Promise<ReleasePermit> {
    const normalizedLane = String(lane ?? '').trim();
    if (!normalizedLane) {
      return Promise.reject(new Error('A background-work lane name is required.'));
    }
    if (this.shuttingDown) {
      return Promise.reject(new Error('Background-work limiter is shutting down.'));
    }

    const priority = Number.isFinite(requestedPriority)
      ? Math.max(0, Math.min(100, Math.floor(Number(requestedPriority))))
      : this.getLanePriority(normalizedLane);

    return new Promise<ReleasePermit>((resolve, reject) => {
      this.waiting.push({
        lane: normalizedLane,
        priority,
        enqueuedAt: Date.now(),
        sequence: this.nextSequence++,
        resolve,
        reject,
      });
      this.dispatch();
    });
  }

  getStatus(): {
    activeJobs: number;
    maximumConcurrentJobs: number;
    waitingJobs: number;
    activeLanes: string[];
    waitingByPriority: { critical: number; high: number; normal: number; low: number };
    minimumLaneStartIntervalMs: number;
  } {
    const waitingByPriority = { critical: 0, high: 0, normal: 0, low: 0 };
    for (const waiter of this.waiting) {
      if (waiter.priority >= 95) waitingByPriority.critical += 1;
      else if (waiter.priority >= 75) waitingByPriority.high += 1;
      else if (waiter.priority >= 40) waitingByPriority.normal += 1;
      else waitingByPriority.low += 1;
    }

    return {
      activeJobs: this.activeJobs,
      maximumConcurrentJobs: BACKGROUND_WORK_LIMITS.maximumConcurrentJobs,
      waitingJobs: this.waiting.length,
      activeLanes: [...this.activeLanes],
      waitingByPriority,
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
      let eligibleIndex = -1;
      let highestPriority = Number.NEGATIVE_INFINITY;
      let earliestSequence = Number.POSITIVE_INFINITY;

      for (let index = 0; index < this.waiting.length; index += 1) {
        const waiter = this.waiting[index];
        if (this.activeLanes.has(waiter.lane)) continue;
        if ((this.nextStartAtByLane.get(waiter.lane) ?? 0) > now) continue;

        const effectivePriority = this.getEffectivePriority(waiter, now);
        if (
          effectivePriority > highestPriority ||
          (effectivePriority === highestPriority && waiter.sequence < earliestSequence)
        ) {
          eligibleIndex = index;
          highestPriority = effectivePriority;
          earliestSequence = waiter.sequence;
        }
      }

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

    // If all waiters belong to active lanes, their release calls dispatch again.
    if (!Number.isFinite(earliestEligibleStart)) return;

    const delayMs = Math.max(1, earliestEligibleStart - now);
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = undefined;
      this.dispatch();
    }, delayMs);
    (this.dispatchTimer as unknown as { unref?: () => void }).unref?.();
  }

  private getEffectivePriority(waiter: WaitingPermit, now: number): number {
    // Keep explicitly critical work (priority 100) strictly ahead of all aged work.
    if (waiter.priority >= BACKGROUND_WORK_PRIORITY.CRITICAL) return BACKGROUND_WORK_PRIORITY.CRITICAL;
    const ageIntervals = Math.floor(
      Math.max(0, now - waiter.enqueuedAt) /
        BACKGROUND_WORK_LIMITS.priorityAgingIntervalMs,
    );
    const boost = Math.min(
      BACKGROUND_WORK_LIMITS.maximumPriorityAgingBoost,
      ageIntervals * 5,
    );
    return Math.min(99, waiter.priority + boost);
  }

  /** Default lane policy; callers may pass an explicit override to acquire(). */
  private getLanePriority(lane: string): number {
    const normalized = lane.trim().toLowerCase();

    if (normalized === 'settlement:queue') return BACKGROUND_WORK_PRIORITY.CRITICAL;
    if (normalized === 'sports:live_scoreboard_refresh') return BACKGROUND_WORK_PRIORITY.CRITICAL;

    if (
      normalized === 'settlement:startup-recovery' ||
      normalized === 'settlement:lease-recovery' ||
      normalized === 'sports:lease-recovery'
    ) return 98;

    if (normalized === 'odds:pricing-queue') return BACKGROUND_WORK_PRIORITY.HIGH;
    if (normalized === 'predictions:queue') return 88;
    if (normalized === 'sports:match_summary_collection') return 88;
    if (normalized === 'sports:match_odds_refresh') return 88;
    if (normalized === 'sports:fixture_daily_refresh') return 85;
    if (normalized === 'sports:fixture_daily_validation') return 82;
    if (normalized === 'sports:match_plays_collection') return 78;
    if (normalized === 'sports:source-outbox') return 78;
    if (normalized === 'sports:source_facts_changed') return 78;
    if (normalized === 'settlement:target-reconciliation') return 72;

    if (normalized === 'odds:inventory') return 65;
    if (normalized === 'predictions:queue-sync') return 60;
    if (normalized === 'sports:fixture_season_bootstrap') return 58;
    if (normalized === 'sports:bootstrap_start') return 55;
    if (normalized === 'sports:bootstrap_phase_gate') return 52;
    if (normalized === 'sports:season_discovery_phase_gate') return 50;

    if (normalized === 'predictions:product-pipeline') return 35;
    if (normalized === 'predictions:calibration') return 25;
    if (normalized === 'odds:retention' || normalized === 'bet-lab:retention') return 10;

    if (normalized.startsWith('sports:')) {
      const jobType = normalized.slice('sports:'.length);
      if (jobType === 'derived_data_recalculation') return 20;
      if (jobType === 'match_summary_backfill') return 22;
      if (jobType === 'sports_retention_cleanup') return 10;
      if (jobType === 'youtube_highlight') return 25;
      if (jobType === 'soccer_news_refresh' || jobType === 'league_news_refresh') return 32;
      if (
        jobType === 'league_catalogue_refresh' ||
        jobType === 'league_detail_refresh' ||
        jobType === 'season_catalogue_refresh' ||
        jobType === 'team_catalogue_refresh' ||
        jobType === 'team_detail_refresh'
      ) return 38;
    }

    return BACKGROUND_WORK_PRIORITY.NORMAL;
  }
}
