import type {
  SportsCompetitionRecord,
  SportsFixtureRecord,
  SportsMatchOddsSnapshotRecord,
  SportsMatchTimelineEventRecord,
  SportsSeasonRecord,
  SportsTeamRecord,
} from './sports-domain.interface';
import type { SportsTeamFormRecord } from './sports-derived-data.interface';
import type { SportsMatchFactsRecord } from './sports-match-facts.interface';

export interface SportsFixtureQuery {
  competitionId?: string;
  seasonId?: string;
  teamId?: string;
  state?: SportsFixtureRecord['status']['state'];
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
  /** Fixture pagination order; ASC is used by prediction backfills to prioritize near kickoffs. */
  sortOrder?: 'ASC' | 'DESC';
  /** Restrict fixture reads to records whose Sports retention deadline has not passed. */
  retainedOnly?: boolean;
}

export interface SportsFixtureReadResult {
  items: SportsFixtureRecord[];
  nextCursor?: string;
  total?: number;
}

export interface SportsFixtureContextReadModel {
  fixture: SportsFixtureRecord;
  competition: SportsCompetitionRecord | null;
  season: SportsSeasonRecord | null;
  homeTeam: SportsTeamRecord | null;
  awayTeam: SportsTeamRecord | null;
}

export interface SportsMatchSummaryMetadata {
  fixtureId: string;
  espnEventId: string;
  payloadHash: string;
  revision: number;
  endpoint: string;
  firstCollectedAt?: Date;
  lastCollectedAt?: Date;
}

export interface SportsMatchReadModel extends SportsFixtureContextReadModel {
  timeline: SportsMatchTimelineEventRecord[];
  latestOdds: SportsMatchOddsSnapshotRecord | null;
  /** Latest normalized ESPN Summary facts; Summary key events remain partial and are never Plays coverage. */
  matchFacts?: SportsMatchFactsRecord | null;
  /** Lightweight raw-Summary metadata used to detect stale/missing normalization without loading the raw payload. */
  matchSummary?: SportsMatchSummaryMetadata | null;
}

/**
 * Team facts exposed for market modelling. This is a read-only view assembled
 * from normalized Sports fixtures and stored form projections; it does not
 * issue provider requests or calculate football statistics in the consumer.
 */
export interface SportsTeamReadModel {
  team: SportsTeamRecord | null;
  form: SportsTeamFormRecord[];
  recentFixtures: SportsFixtureRecord[];
}

export interface SportsCompetitionListQuery {
  activeOnly?: boolean;
  region?: SportsCompetitionRecord['region'];
  type?: SportsCompetitionRecord['type'];
  search?: string;
  limit?: number;
}

export interface SportsTeamListQuery {
  leagueId?: string;
  country?: string;
  search?: string;
  limit?: number;
}


