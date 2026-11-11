/** Normalized ESPN facts persisted by the Sports Module. */
export type SportsDataProvider = 'ESPN' | 'ODDS_API';

export type SportsCompetitionType = 'LEAGUE' | 'CLUB_COMPETITION' | 'INTERNATIONAL';
export type SportsCompetitionRegion =
  | 'NIGERIA' | 'AFRICA' | 'EUROPE' | 'SOUTH_AMERICA'
  | 'NORTH_AMERICA' | 'ASIA' | 'OCEANIA' | 'WORLD';

export interface SportsSourceMetadata {
  provider: SportsDataProvider;
  providerId?: string;
  endpoint: string;
  collectedAt: Date;
  providerUpdatedAt?: Date;
}

export interface SportsCompetitionRecord {
  id: string;
  espnId: string;
  slug: string;
  name: string;
  displayName?: string;
  abbreviation?: string;
  type: SportsCompetitionType;
  region: SportsCompetitionRegion;
  country?: string;
  logo?: string;
  isActive: boolean;
  currentSeasonId?: string;
  currentSeasonYear?: number;
  currentSeasonStartDate?: Date;
  currentSeasonEndDate?: Date;
  rawPayload?: Record<string, unknown>;
  source: SportsSourceMetadata;
  createdAt: Date;
  updatedAt: Date;
}

export interface SportsSeasonRecord {
  id: string;
  espnId: string;
  competitionId: string;
  year: number;
  displayName?: string;
  shortDisplayName?: string;
  startDate?: Date;
  endDate?: Date;
  isCurrent: boolean;
  rawPayload?: Record<string, unknown>;
  source: SportsSourceMetadata;
  createdAt: Date;
  updatedAt: Date;
}

export interface SportsTeamRecord {
  id: string;
  espnId: string;
  leagueIds: string[];
  name: string;
  displayName?: string;
  shortName?: string;
  abbreviation?: string;
  slug?: string;
  logo?: string;
  country?: string;
  location?: string;
  primaryColor?: string;
  alternateColor?: string;
  rawPayload?: Record<string, unknown>;
  source: SportsSourceMetadata;
  createdAt: Date;
  updatedAt: Date;
}

export type SportsFixtureState =
  | 'SCHEDULED' | 'LIVE' | 'HALFTIME' | 'EXTRA_TIME' | 'PENALTIES'
  | 'COMPLETED' | 'POSTPONED' | 'CANCELLED' | 'ABANDONED' | 'UNKNOWN';

export interface SportsFixtureStatus {
  state: SportsFixtureState;
  providerState?: string;
  name?: string;
  description?: string;
  shortDescription?: string;
  period?: number;
  clock?: string;
  displayClock?: string;
  isFinal: boolean;
}

export interface SportsFixtureCompetitor {
  teamId: string;
  espnCompetitorId?: string;
  homeAway: 'HOME' | 'AWAY';
  score?: number | null;
  winner?: boolean;
  form?: string;
  records?: Array<Record<string, unknown>>;
  statistics?: Array<Record<string, unknown>>;
  leaders?: Array<Record<string, unknown>>;
  rawPayload?: Record<string, unknown>;
}

export interface SportsTimelineAthleteInvolvement {
  athleteId?: string;
  name?: string;
  shortName?: string;
  jersey?: string;
  teamId?: string;
  position?: string;
  positionId?: string;
  statisticsRef?: string;
  order?: number;
  role?: string;
}

export interface SportsFixturePeriodScore {
  teamId: string;
  period: number;
  score: number;
}

export interface SportsFixtureRecord {
  id: string;
  espnEventId: string;
  espnCompetitionId?: string;
  competitionId: string;
  seasonId?: string;
  seasonYear?: number;
  name?: string;
  shortName?: string;
  kickoffAt: Date;
  status: SportsFixtureStatus;
  competitors: [SportsFixtureCompetitor, SportsFixtureCompetitor];
  periodScores: SportsFixturePeriodScore[];
  venueId?: string;
  attendance?: number;
  neutralSite?: boolean;
  completedAt?: Date;
  /** Expiration is calculated from the fixture month + its season length + the configured grace period. */
  retentionExpiresAt?: Date;
  /** Season duration plus three grace months, used to recompute expiry if kickoff moves. */
  retentionDurationMonths?: number;
  rawPayload?: Record<string, unknown>;
  source: SportsSourceMetadata;
  createdAt: Date;
  updatedAt: Date;
}

export interface SportsTimelineScore { home: number; away: number; }

export interface SportsMatchTimelineEventRecord {
  id: string;
  espnPlayId?: string;
  fixtureId: string;
  sequence: number;
  period?: number;
  clock?: string;
  clockSeconds?: number;
  addedClock?: string;
  type: string;
  typeId?: string;
  typeKey?: string;
  description?: string;
  teamId?: string;
  athleteId?: string;
  relatedAthleteId?: string;
  involvedAthletes?: SportsTimelineAthleteInvolvement[];
  scoreAfter?: SportsTimelineScore;
  homeScore?: number;
  awayScore?: number;
  scoreValue?: number;
  scoringPlay?: boolean;
  shootingPlay?: boolean;
  priority?: boolean;
  valid?: boolean;
  substitution?: boolean;
  redCard?: boolean;
  yellowCard?: boolean;
  penaltyKick?: boolean;
  ownGoal?: boolean;
  shootout?: boolean;
  hasVideoTagging?: boolean;
  sourceId?: string;
  sourceDescription?: string;
  statYardage?: number;
  coordinateX?: number;
  coordinateY?: number;
  fieldPositionX?: number;
  fieldPositionY?: number;
  fieldPosition2X?: number;
  fieldPosition2Y?: number;
  periodDisplayValue?: string;
  wallclock?: string;
  shortText?: string;
  modifiedAt?: Date;
  modifiedDate?: Date;
  probabilityRef?: string;
  rawPayload?: Record<string, unknown>;
  source: SportsSourceMetadata;
  createdAt: Date;
  updatedAt: Date;
}

export interface SportsOddsOutcome {
  selection: string;
  price: number;
  point?: number | null;
  isSuspended?: boolean;
}

export interface SportsOddsMarket {
  marketId?: string;
  marketKey: string;
  marketName: string;
  outcomes: SportsOddsOutcome[];
  providerUpdatedAt?: Date;
}

export interface SportsOddsBookmaker {
  bookmakerId?: string;
  bookmakerName: string;
  priority?: number;
  markets: SportsOddsMarket[];
}

export interface SportsMatchOddsSnapshotRecord {
  id: string;
  fixtureId: string;
  provider: 'ESPN' | 'ESPN_SUMMARY' | 'ODDS_API';
  isFallback: boolean;
  collectedAt: Date;
  bookmakers: SportsOddsBookmaker[];
  rawPayload?: Record<string, unknown>;
  source: SportsSourceMetadata;
  createdAt: Date;
}

