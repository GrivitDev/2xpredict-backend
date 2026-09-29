// src/sports/interfaces/espn-queue.interface.ts

export enum EspnQueueJobType {
  /**
   * Refresh the canonical ESPN fixture collection for
   * an active competition and its configured date window.
   */
  FIXTURE_REFRESH = 'FIXTURE_REFRESH',

  /**
   * Collect the detailed ESPN Summary for one fixture.
   *
   * Summary is the canonical detailed match-data payload
   * persisted inside sports_espn_fixtures.payload.summary.
   */
  SUMMARY_REFRESH = 'SUMMARY_REFRESH',

  /**
   * Search for and persist a YouTube highlight for one
   * completed ESPN fixture.
   *
   * Only ELITE, HIGH and REGIONAL competitions are eligible.
   * SELECTIVE competitions are never queued.
   */
  YOUTUBE_HIGHLIGHT = 'YOUTUBE_HIGHLIGHT',
}

export enum EspnQueueStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export interface EspnQueueJob {
  jobKey: string;

  /**
   * ESPN league identifier.
   *
   * This is the canonical stored ESPN leagueId.
   */
  leagueId: string;

  /**
   * Queue job type.
   */
  type: EspnQueueJobType;

  /**
   * ESPN season year.
   */
  season?: number;

  /**
   * ESPN event ID.
   *
   * Required for SUMMARY_REFRESH and YOUTUBE_HIGHLIGHT.
   */
  eventId?: string;

  /**
   * Internal competition identifier.
   */
  competitionId?: string;

  /**
   * Event that triggered a fixture refresh.
   *
   * For example, a newly completed match can trigger a
   * fresh fixture refresh for its league.
   */
  triggerEventId?: string;

  /**
   * Queue priority.
   *
   * 1 = ELITE
   * 2 = HIGH
   * 3 = REGIONAL
   * 4 = SELECTIVE
   */
  priority: number;

  status: EspnQueueStatus;

  attempts: number;

  maxAttempts: number;

  scheduledFor: Date;

  nextAttemptAt?: Date;

  startedAt?: Date;

  completedAt?: Date;

  failedAt?: Date;

  lastError?: string;
}
