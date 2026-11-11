/** Contracts for factual projections calculated from normalized sports data. */

export type SportsSourceEntity =
  | 'COMPETITION'
  | 'SEASON'
  | 'TEAM'
  | 'VENUE'
  | 'ATHLETE'
  | 'FIXTURE'
  | 'MATCH_STATISTICS'
  | 'MATCH_LINEUP'
  | 'TEAM_ROSTER'
  | 'MATCH_TIMELINE'
  | 'MATCH_ODDS';

export type SportsDerivedProjection =
  | 'COMPETITION_STANDINGS'
  | 'TEAM_FORM'
  | 'TEAM_HOME_AWAY_RECORD'
  | 'TEAM_SCORING_RECORD'
  | 'HEAD_TO_HEAD'
  | 'COMPETITION_SCORING_TOTALS'
  | 'TEAM_STATISTICS_AGGREGATES'
  | 'PLAYER_EVENT_TOTALS';

export interface SportsDataChangedEvent {
  eventId: string;
  entity: SportsSourceEntity;
  entityId: string;
  competitionIds: string[];
  seasonIds: string[];
  teamIds: string[];
  athleteIds: string[];
  fixtureIds: string[];
  changedAt: Date;
  revision: number;
  sourceFingerprint?: string;
}

export interface SportsProjectionRecalculationRequest {
  projection: SportsDerivedProjection;
  competitionId?: string;
  seasonId?: string;
  teamId?: string;
  opponentTeamId?: string;
  athleteId?: string;
  fixtureId?: string;
  causedByEventId: string;
  sourceRevision: number;
}

export interface SportsTeamFormRecord {
  teamId: string;
  competitionId?: string;
  seasonId?: string;
  lastN: number;
  results: Array<{
    fixtureId: string;
    kickoffAt: Date;
    result: 'W' | 'D' | 'L';
    goalsFor: number;
    goalsAgainst: number;
    homeAway: 'HOME' | 'AWAY';
  }>;
  computedAt: Date;
  sourceRevision: number;
}

export interface SportsTeamHomeAwayRecord {
  teamId: string;
  competitionId: string;
  seasonId: string;
  home: { played: number; won: number; drawn: number; lost: number; goalsFor: number; goalsAgainst: number };
  away: { played: number; won: number; drawn: number; lost: number; goalsFor: number; goalsAgainst: number };
  last5Home?: { played: number; won: number; drawn: number; lost: number; goalsFor: number; goalsAgainst: number } | null;
  last10Home?: { played: number; won: number; drawn: number; lost: number; goalsFor: number; goalsAgainst: number } | null;
  last5Away?: { played: number; won: number; drawn: number; lost: number; goalsFor: number; goalsAgainst: number } | null;
  last10Away?: { played: number; won: number; drawn: number; lost: number; goalsFor: number; goalsAgainst: number } | null;
  metrics?: Record<string, unknown>;
  computedAt: Date;
  sourceRevision: number;
}

export interface SportsHeadToHeadRecord {
  teamAId: string;
  teamBId: string;
  competitionId?: string;
  matches: Array<{
    fixtureId: string;
    kickoffAt: Date;
    homeTeamId: string;
    awayTeamId: string;
    homeScore: number;
    awayScore: number;
    recencyRank?: number;
    recencyWeight?: number;
  }>;
  metrics?: Record<string, unknown>;
  computedAt: Date;
  sourceRevision: number;
}

/**
 * The collection worker must await projection recalculation after normalized
 * source writes. This keeps derived read data current without cron jobs.
 */
export interface SportsProjectionRecalculationResult {
  projection: SportsDerivedProjection;
  scopeKey: string;
  sourceRevision: number;
  completedAt: Date;
  affectedRecords: number;
}

export interface SportsCompetitionScoringTotalsRecord {
  id: string;
  competitionId: string;
  seasonId: string;
  fixturesPlayed: number;
  totalGoals: number;
  homeGoals: number;
  awayGoals: number;
  averageGoalsPerFixture: number;
  computedAt: Date;
  sourceRevision: number;
  bttsRate?: number | null;
  over15Rate?: number | null;
  over25Rate?: number | null;
  over35Rate?: number | null;
  under25Rate?: number | null;
  cleanSheetRate?: number | null;
  eventMetrics?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
}

export interface SportsPlayerEventTotalsRecord {
  id: string;
  athleteId: string;
  competitionId?: string;
  seasonId?: string;
  fixturesWithEvents: number;
  goals: number;
  assists: number;
  ownGoals: number;
  yellowCards: number;
  redCards: number;
  penaltiesScored: number;
  penaltiesMissed: number;
  computedAt: Date;
  sourceRevision: number;
}

export interface SportsNumericStatisticAggregateRecord {
  key: string;
  name: string;
  category?: string;
  unit?: string;
  sampleSize: number;
  total: number;
  average: number;
  /** Sample variance from observed per-fixture values (Bessel corrected). */
  variance?: number | null;
  /** Observed range; absent when the source did not provide enough samples. */
  minimum?: number | null;
  maximum?: number | null;
}

export interface SportsTeamStatisticsAggregateRecord {
  id: string;
  teamId: string;
  competitionId: string;
  seasonId: string;
  fixturesWithStatistics: number;
  statistics: SportsNumericStatisticAggregateRecord[];
  computedAt: Date;
  sourceRevision: number;
  scope?: 'SEASON' | 'HOME' | 'AWAY' | 'LAST5' | 'LAST10';
  scopeMetrics?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
}


export interface SportsTeamScoringRecord {
  id: string;
  teamId: string;
  competitionId: string;
  seasonId: string;
  fixturesPlayed: number;
  goalsFor: number;
  goalsAgainst: number;
  averageGoalsFor: number;
  averageGoalsAgainst: number;
  cleanSheets: number;
  failedToScore: number;
  computedAt: Date;
  sourceRevision: number;
  metrics?: Record<string, unknown>;
}




