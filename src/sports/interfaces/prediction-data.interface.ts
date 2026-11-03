import type { ActiveCompetitionStatus } from './active-competition.interface';
import type { EspnTeamDocument } from '../schemas/espn/espn-team.schema';

export interface SportsPredictionFixture {
  eventId: string;

  leagueId: string;

  season: number;

  fixtureDate: Date;

  live: boolean;

  completed?: boolean;

  homeTeamId: string;

  awayTeamId: string;

  collectedAt: Date;
}

export interface SportsPredictionSummary {
  /** Bookmaker prices from ESPN PickCenter; never model probabilities. */
  pickcenter?: unknown;
  /** ESPN-provided bookmaker odds records. */
  odds?: unknown;
  /** H2H season-series events. */
  seasonseries?: unknown;
  /** Historical form grouped by team. */
  lastFiveGames?: unknown;
}

export interface SportsPredictionCompetition {
  competitionId: string;

  name: string;

  status: ActiveCompetitionStatus;

  season?: number;

  espnPayload?: Record<string, unknown>;
}

export interface SportsPredictionData {
  ready: boolean;

  reason: string | null;

  reasons: string[];

  /**
   * Only the fixture fields required by prediction calculation.
   *
   * The complete ESPN fixture document is intentionally not loaded here.
   */
  fixture: SportsPredictionFixture;

  /**
   * Only selected odds and historical-context sections are returned. ESPN
   * predictor and win-probability sections are never loaded into the contract.
   */
  summary: SportsPredictionSummary | null;

  /** Full, untouched ESPN standings response from sports_espn_standings.payload. */
  standingsPayload: Record<string, unknown> | null;

  /** Timestamp of the stored full standings response, when available. */
  standingsFetchedAt: Date | null;

  competition: SportsPredictionCompetition | null;

  homeTeam: Pick<
    EspnTeamDocument,
    | 'teamId'
    | 'leagueId'
    | 'name'
    | 'displayName'
    | 'shortDisplayName'
    | 'logo'
    | 'collectedAt'
  > | null;

  awayTeam: Pick<
    EspnTeamDocument,
    | 'teamId'
    | 'leagueId'
    | 'name'
    | 'displayName'
    | 'shortDisplayName'
    | 'logo'
    | 'collectedAt'
  > | null;

  fixtureCollectedAt: Date;

  summaryCollectedAt: unknown;
}

export interface SportsSettlementData {
  fixture: import('../schemas/espn/espn-fixture.schema').EspnFixtureDocument;

  summary: Record<string, unknown> | null;

  summaryCollectedAt: unknown;
}

