import { SettlementOutcome } from '../enums/settlement-outcome.enum';

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
  /** True when ESPN indicates the fixture continued beyond regulation or went to a shootout. */
  afterExtraTime?: boolean;
  /** False when a regulation-time score cannot be separated safely from extra time. */
  regulationScoreAvailable?: boolean;
  homeGoals?: number;
  awayGoals?: number;
  halfTimeHomeGoals?: number;
  halfTimeAwayGoals?: number;
  secondHalfHomeGoals?: number;
  secondHalfAwayGoals?: number;
  periodScoresAvailable: boolean;
  goalEventsComplete: boolean;
  eventDetailsAvailable: boolean;
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
  sourceSummaryCollectedAt?: Date;
  /** Critical integrity conflicts prevent every market from being settled. */
  settlementBlockers: string[];
  /** Non-blocking notes showing when mirrored fixture fields were stale. */
  sourceDiagnostics: string[];
  /** Conflicting values are keyed by canonical side/statistic, e.g. home:corners. */
  conflictingStats: string[];
  scoreSource?: string;
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
  counts: SettlementTargetCounts;
  unresolvedReasons: string[];
}


