import type { SportsFixtureRecord } from './sports-domain.interface';

export type SportsMatchFactSectionStatus =
  | 'COMPLETE'
  | 'PARTIAL'
  | 'AVAILABLE'
  | 'NOT_PROVIDED'
  | 'INVALID';

export type SportsMatchFactUnit =
  | 'COUNT'
  | 'PERCENT'
  | 'RATIO'
  | 'MINUTES'
  | 'UNKNOWN';

export interface SportsNormalizedStatistic {
  canonicalKey: string | null;
  providerKey: string;
  providerLabel?: string;
  value: number | null;
  displayValue?: string;
  unit: SportsMatchFactUnit;
}

export interface SportsNormalizedTeamStatistics {
  teamId: string;
  espnTeamId: string;
  side: 'HOME' | 'AWAY' | 'UNKNOWN';
  statistics: SportsNormalizedStatistic[];
}

export interface SportsNormalizedPlayerAppearance {
  playerId: string;
  espnPlayerId: string;
  teamId?: string;
  name?: string;
  shortName?: string;
  jersey?: string;
  position?: string;
  positionId?: string;
  starter?: boolean;
  subbedIn?: boolean;
  subbedOut?: boolean;
  active?: boolean;
  appearances: number | null;
  appearanceBasis: 'PROVIDER_STATISTIC' | 'LINEUP_PARTICIPATION' | 'UNKNOWN';
  statistics: SportsNormalizedStatistic[];
}

export interface SportsNormalizedPeriodScore {
  teamId: string;
  period: number;
  score: number;
}

export interface SportsMatchResultFacts {
  homeTeamId?: string;
  awayTeamId?: string;
  homeScore: number | null;
  awayScore: number | null;
  isFinal: boolean;
  available: boolean;
  /** Distinguishes authoritative Summary scores from fallback values copied from the scoreboard fixture. */
  scoreSource: 'ESPN_SUMMARY' | 'MIXED' | 'FIXTURE_FALLBACK' | 'UNAVAILABLE';
}

export interface SportsMatchFactSectionStatuses {
  matchResult: SportsMatchFactSectionStatus;
  periodScores: SportsMatchFactSectionStatus;
  teamStatistics: SportsMatchFactSectionStatus;
  playerAppearances: SportsMatchFactSectionStatus;
  playerStatistics: SportsMatchFactSectionStatus;
  leaders: SportsMatchFactSectionStatus;
  summaryEvents: SportsMatchFactSectionStatus;
}

export interface SportsMatchFactLeader {
  categoryKey?: string;
  categoryName?: string;
  athleteId?: string;
  teamId?: string;
  name?: string;
  value: number | null;
  displayValue?: string;
  rank?: number;
}

/** Summary key events are deliberately marked partial; they are not Core Plays coverage. */
export interface SportsMatchSummaryEvent {
  eventId?: string;
  type?: string;
  description?: string;
  clock?: string;
  period?: number;
  teamId?: string;
  athleteIds: string[];
  homeScore?: number;
  awayScore?: number;
  sourceCoverage: 'PARTIAL';
}

export interface SportsMatchFactsWrite {
  fixtureId: string;
  espnEventId: string;
  competitionId: string;
  seasonId?: string;
  seasonYear?: number;
  provider: 'ESPN';
  endpoint: string;
  sourcePayloadHash: string;
  sourceRevision: number;
  sourceCollectedAt: Date;
  normalizationVersion: string;
  normalizationHash: string;
  normalizedAt: Date;
  matchResult: SportsMatchResultFacts;
  periodScores: SportsNormalizedPeriodScore[];
  teamStatistics: SportsNormalizedTeamStatistics[];
  playerAppearances: SportsNormalizedPlayerAppearance[];
  leaders: SportsMatchFactLeader[];
  summaryEvents: SportsMatchSummaryEvent[];
  sectionStatus: SportsMatchFactSectionStatuses;
  diagnostics: string[];
}

export interface SportsMatchFactsRecord extends SportsMatchFactsWrite {
  revision: number;
}

export interface SportsMatchFactsNormalizationInput {
  fixtureId: string;
  espnEventId: string;
  competitionId: string;
  seasonId?: string;
  seasonYear?: number;
  endpoint: string;
  sourcePayloadHash: string;
  sourceRevision: number;
  sourceCollectedAt: Date;
  rawPayload: Record<string, unknown>;
  fixture?: SportsFixtureRecord | null;
}
