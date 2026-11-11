import type {
  SportsFixtureRecord,
  SportsMatchOddsSnapshotRecord,
  SportsMatchTimelineEventRecord,
  SportsSeasonRecord,
  SportsTeamRecord,
} from './sports-domain.interface';

export interface ProviderJsonObject { [key: string]: unknown; }
export interface ProviderPagedResponse extends ProviderJsonObject {
  count?: number;
  pageIndex?: number;
  pageSize?: number;
  pageCount?: number;
  items?: unknown[];
}
export interface ProviderCollection<T> {
  items: T[];
  pageCount: number;
  totalCount?: number;
  endpoint: string;
  rawResponse?: ProviderJsonObject;
}
export interface FixtureCollectionResult {
  items: SportsFixtureRecord[];
  receivedCount: number;
  rejected: Array<{ eventId?: string; reason: string }>;
  endpoint: string;
  rawResponse: ProviderJsonObject;
  previousStates?: Record<string, { state: string; completedAt?: Date }>;
}
export interface DiscoverySeasonCollectionResult {
  items: SportsSeasonRecord[];
  endpoint: string;
  totalCount?: number;
  rawResponse?: ProviderJsonObject;
}
export interface TeamCatalogueResult {
  teamIds: string[];
  /** Original $ref pointers are retained so detail jobs call ESPN's exact resource URLs. */
  teamReferences: Record<string, string>;
  endpoint: string;
  totalCount?: number;
  rawResponse?: ProviderJsonObject;
}
export interface PlaysCollectionResult {
  items: SportsMatchTimelineEventRecord[];
  receivedCount: number;
  endpoint: string;
  fallbackUsed: boolean;
  rawResponse: ProviderJsonObject;
  /** A completed provider check that found no timeline data; not a transport failure. */
  noDataReason?: string;
}
export interface OddsCollectionResult {
  snapshot: SportsMatchOddsSnapshotRecord | null;
  endpoint: string;
  fallbackUsed: boolean;
  /** Explains a completed checkpoint that found no published prices. */
  reason?: string;
  rawResponse?: ProviderJsonObject;
}


/** Input contract for the ordered ESPN -> ESPN Summary -> Odds API odds collector. */
export interface MatchOddsCollectionInput {
  fixtureId: string;
  leagueId: string;
  competitionId: string;
  espnLeagueId: string;
  espnEventId: string;
  espnCompetitionId?: string;
  homeTeam: string;
  awayTeam: string;
  kickoffAt: Date;
  oddsApiSportKey?: string;
  oddsApiEventId?: string;
  regions?: string;
  markets?: string;
}

/** Result returned by one fixture odds collection pass. */
export interface MatchOddsCollectionResult {
  snapshot: import('./sports-domain.interface').SportsMatchOddsSnapshotRecord | null;
  provider: 'ESPN' | 'ESPN_SUMMARY' | 'ODDS_API' | null;
  fallbackUsed: boolean;
  reason?: string;
}

