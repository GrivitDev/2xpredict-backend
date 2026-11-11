import { SettlementOutcome } from '../enums/settlement-outcome.enum';

export type SettlementPhase = 'IN_PLAY' | 'HALF_TIME' | 'FULL_TIME';

export interface SettlementSelectionInput {
  key?: string;
  code?: string;
  jsonVariable?: string;
  fullName?: string;
  abbreviation?: string;
  line?: number;
  handicap?: number;
  homeGoals?: number;
  awayGoals?: number;
  subjectId?: string;
  subjectName?: string;
  subjectTeamId?: string;
  settlementKey?: string;
}

export interface SettlementEvaluation {
  outcome: SettlementOutcome;
  method: string;
  reason?: string;
  evidence?: Record<string, unknown>;
  /** Identifies when the outcome became demonstrably final for this market. */
  phase?: SettlementPhase;
}

export interface SettlementEventFacts {
  eventId: string;
  leagueId: string;
  fixtureDate?: Date;
  homeTeamId: string;
  awayTeamId: string;
  homeTeamName: string;
  awayTeamName: string;
  isFinished: boolean;
  fixtureState?: string;
  fixtureStatus?: string;
  firstHalfComplete: boolean;
  secondHalfComplete: boolean;
  currentPeriod?: number;
  currentMinute?: number;
  /** True when Sports reports that the fixture proceeded beyond regulation. */
  afterExtraTime?: boolean;
  /** False when regulation time cannot be separated safely from extra time. */
  regulationScoreAvailable?: boolean;
  homeGoals?: number;
  awayGoals?: number;
  halfTimeHomeGoals?: number;
  halfTimeAwayGoals?: number;
  secondHalfHomeGoals?: number;
  secondHalfAwayGoals?: number;
  periodScoresAvailable: boolean;
  /** True only when the regulation goal timeline reconciles and Sports confirms complete Core Plays coverage. */
  goalEventsComplete: boolean;
  eventDetailsAvailable: boolean;
  /** True only after Sports confirms a successful complete Core Plays collection. */
  timelineCoverageComplete?: boolean;
  homeStats: Record<string, number>;
  awayStats: Record<string, number>;
  playerStats: Record<string, Record<string, number>>;
  playerNames: Record<string, string>;
  goals: Array<{
    eventKey: string;
    teamId?: string;
    creditedTeamId?: string;
    playerIds: string[];
    minute?: number;
    order: number;
    ownGoal: boolean;
    penalty: boolean;
  }>;
  cards: Array<{
    playerIds: string[];
    teamId?: string;
    red: boolean;
    yellow: boolean;
    minute?: number;
  }>;
  penaltiesAwarded?: number;
  ownGoals?: number;
  redCards?: number;
  yellowCards?: number;
  /** Kept for persisted settlement_runs/jobs written by earlier versions. */
  sourceSummaryCollectedAt?: Date;
  sourceDataCollectedAt?: Date;
  fixtureSourceCollectedAt?: Date;
  timelineCollectedAt?: Date;
  statisticsCollectedAt?: Date;
  homeStatisticsCollectedAt?: Date;
  awayStatisticsCollectedAt?: Date;
  settlementBlockers: string[];
  sourceDiagnostics: string[];
  conflictingStats: string[];
  scoreSource?: string;
  summaryFactsRevision?: number;
  summaryFactsSourcePayloadHash?: string;
  summaryFactsCollectedAt?: Date;
  summaryFactsNormalizationVersion?: string;
  summaryFactsSectionStatus?: Record<string, string>;
  homeStatisticsSource?: 'ESPN_SUMMARY' | 'SPORTS_NORMALIZED_FIXTURE' | 'UNAVAILABLE';
  awayStatisticsSource?: 'ESPN_SUMMARY' | 'SPORTS_NORMALIZED_FIXTURE' | 'UNAVAILABLE';
  sourceFingerprint: string;
}

export interface SettlementTargetCounts {
  predictionMarketsFound: number;
  predictionSelectionsSettled: number;
  predictionSelectionsSkipped: number;
  predictionSelectionsUnresolved: number;
  betLabTicketsFound: number;
  betLabLegsSettled: number;
  betLabTicketsFinalized: number;
  betLabLegsUnresolved: number;
}

export interface SettlementProcessResult {
  eventId: string;
  sourceFingerprint: string;
  partial: boolean;
  skipped?: boolean;
  phase?: SettlementPhase;
  counts: SettlementTargetCounts;
  unresolvedReasons: string[];
}

