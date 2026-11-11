/** Durable queue contracts for the ESPN bootstrap and event-timed collector. */
export enum SportsQueueJobType {
  BOOTSTRAP_START = 'BOOTSTRAP_START',
  BOOTSTRAP_PHASE_GATE = 'BOOTSTRAP_PHASE_GATE',
  SEASON_DISCOVERY_PHASE_GATE = 'SEASON_DISCOVERY_PHASE_GATE',
  LEAGUE_CATALOGUE_REFRESH = 'LEAGUE_CATALOGUE_REFRESH',
  LEAGUE_DETAIL_REFRESH = 'LEAGUE_DETAIL_REFRESH',
  SEASON_CATALOGUE_REFRESH = 'SEASON_CATALOGUE_REFRESH',
  TEAM_CATALOGUE_REFRESH = 'TEAM_CATALOGUE_REFRESH',
  TEAM_DETAIL_REFRESH = 'TEAM_DETAIL_REFRESH',
  FIXTURE_SEASON_BOOTSTRAP = 'FIXTURE_SEASON_BOOTSTRAP',
  FIXTURE_SEASON_VALIDATION_GATE = 'FIXTURE_SEASON_VALIDATION_GATE',
  FIXTURE_DAILY_VALIDATION = 'FIXTURE_DAILY_VALIDATION',
  FIXTURE_DAILY_REFRESH = 'FIXTURE_DAILY_REFRESH',
  MATCH_ODDS_REFRESH = 'MATCH_ODDS_REFRESH',
  LIVE_SCOREBOARD_REFRESH = 'LIVE_SCOREBOARD_REFRESH',
  MATCH_SUMMARY_COLLECTION = 'MATCH_SUMMARY_COLLECTION',
  /** Bounded keyset scan that fills missing retained historical ESPN summaries. */
  MATCH_SUMMARY_BACKFILL = 'MATCH_SUMMARY_BACKFILL',
  MATCH_PLAYS_COLLECTION = 'MATCH_PLAYS_COLLECTION',
  YOUTUBE_HIGHLIGHT = 'YOUTUBE_HIGHLIGHT',
  SOCCER_NEWS_REFRESH = 'SOCCER_NEWS_REFRESH',
  /** Internal collection and projection jobs share this durable queue contract. */
  SOURCE_FACTS_CHANGED = 'SOURCE_FACTS_CHANGED',
  LEAGUE_NEWS_REFRESH = 'LEAGUE_NEWS_REFRESH',
  DERIVED_DATA_RECALCULATION = 'DERIVED_DATA_RECALCULATION',
  SPORTS_RETENTION_CLEANUP = 'SPORTS_RETENTION_CLEANUP',
  /** Isolated consumer lane owned by Odds, not by the Sports job processor. */
  ODDS_PRICING_RECALCULATION = 'ODDS_PRICING_RECALCULATION',
  /** Prediction-owned consumer lane, released only after Grivit finishes repricing. */
  PREDICTION_ENGINE_RECALCULATION = 'PREDICTION_ENGINE_RECALCULATION',
}

export enum SportsQueueJobStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  QUARANTINED = 'QUARANTINED',
}

export enum SportsQueueLane {
  NORMAL = 'NORMAL',
  BACKGROUND_RETRY = 'BACKGROUND_RETRY',
  QUARANTINE = 'QUARANTINE',
}

export type SportsBootstrapPhase =
  | 'LEAGUE_DETAILS'
  | 'SEASON_CATALOGUES'
  | 'TEAM_CATALOGUES'
  | 'TEAM_DETAILS'
  | 'MONTHLY_FIXTURE_BOOTSTRAP'
  | 'DAILY_FIXTURE_VALIDATION';

export type SportsQueueRepeatUntil = 'NEVER' | 'DATA_COMPLETE';

export interface SportsQueueScope {
  competitionId?: string;
  leagueId?: string;
  seasonId?: string;
  seasonYear?: number;
  teamId?: string;
  /** Exact ESPN Core API reference supplied by the season team catalogue. */
  teamReference?: string;
  fixtureId?: string;
  espnEventId?: string;
  calendarDate?: string;
  /** Initial bootstrap identity; regular recurring jobs omit this field. */
  bootstrapRunId?: string;
  bootstrapPhase?: SportsBootstrapPhase;
  /** Fixture refresh milestones include 48H/18H; odds milestones are ODDS_48H, ODDS_24H, ODDS_18H. */
  milestone?: string;
  /** The kickoff timestamp used when the job was scheduled. */
  expectedKickoffAt?: string;
  /** True while daily fixture validation belongs to a just-discovered season bootstrap. */
  seasonBootstrap?: boolean;
  /** Fixed validation horizon for a season whose ESPN endDate is absent. */
  seasonEndDate?: string;
  /** Bounded staged attempt number for a fixture highlight search. */
  youtubeAttempt?: number;
  /** Bounded retry attempt for a completed fixture Summary that did not normalize. */
  summaryAttempt?: number;
  /** Stable identity for one resumable historical Summary backfill run. */
  backfillRunId?: string;
  /** Distinguishes a backfill collection from an older completed post-match job. */
  summaryBackfillRunId?: string;
  /** Keyset cursor: last fixture kickoff consumed by the backfill. */
  backfillCursorKickoffAt?: string;
  /** Keyset cursor: fixture ID tie-breaker for equal kickoff timestamps. */
  backfillCursorFixtureId?: string;
  /** Coalescing identity for derived projection refreshes. */
  projectionWindow?: string;
  /** Coalescing identity for league-news collection windows. */
  newsWindow?: string;
  /** Completed timestamp used to invalidate stale post-match jobs. */
  expectedCompletedAt?: string;
  /** Source category and fingerprint that triggered a derived refresh. */
  sourceKind?: 'FIXTURE' | 'TIMELINE';
  sourceFingerprint?: string;
  /** Latest persisted Grivit price timestamp used to coalesce prediction triggers. */
  predictionSourceUpdatedAt?: string;
  /** Fixture set associated with a league-news request. */
  fixtureIds?: string[];
}

export interface SportsQueueRecurrence {
  intervalMs: number;
  repeatUntil: SportsQueueRepeatUntil;
}

export interface SportsQueueJob {
  jobKey: string;
  type: SportsQueueJobType;
  scope: SportsQueueScope;
  priority: number;
  status: SportsQueueJobStatus;
  lane: SportsQueueLane;
  scheduledFor: Date;
  recurrence?: SportsQueueRecurrence;
  attempts: number;
  maxAttempts: number;
  retryCount: number;
  lastAttemptAt?: Date;
  nextAttemptAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  lastError?: string;
  ownerId?: string;
  heartbeatAt?: Date;
  leaseExpiresAt?: Date;
  triggerEventId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SportsQueueEnqueueRequest {
  type: SportsQueueJobType;
  scope: SportsQueueScope;
  priority: number;
  scheduledFor?: Date;
  recurrence?: SportsQueueRecurrence;
  triggerEventId?: string;
}

