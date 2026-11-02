export interface PredictionFixtureCore {
  eventId: string;
  leagueId: string;
  season: number;
  fixtureDate: Date;
  live: boolean;
  completed: boolean;
  status?: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore?: number;
  awayScore?: number;
  collectedAt: Date;
  summaryCollectedAt?: Date | string | null;
  payload: Record<string, any>;
}

export interface PredictionTeamCore {
  id: string;
  name: string;
  abbreviation?: string;
  logo?: string;
}

export type OddsBasis =
  | 'BOOKMAKER_ONLY'
  | 'BOOKMAKER_PLUS_HISTORY'
  | 'HISTORICAL_ONLY'
  | 'PRIOR_ONLY';
export type OddsProvider = 'THE_ODDS_API' | 'ESPN';

export interface StoredFixtureOdds {
  marketId: string;
  selectionKey: string;
  line?: number;
  decimalOdds: number;
  /** Explicit endorsement from the Odds module for this exact selection/line. */
  predictionReady: boolean;
  priceType: 'PROVIDER' | 'ESTIMATED';
  provider?: OddsProvider | null;
  bookmaker?: string | null;
  providerUpdatedAt?: Date | null;
  fairOdds?: number | null;
  oddsBasis?: OddsBasis | null;
  oddsCalculationMethod?: string | null;
  updatedAt: Date | null;
}

import type { EspnStandingsPayload } from '../../sports/providers/espn.interfaces';

export interface PredictionMatchContext {
  fixture: PredictionFixtureCore;
  summary: Record<string, any>;
  /** Whether the current fixture contains a usable ESPN Summary payload. */
  summaryAvailable: boolean;
  /** Complete ESPN standings response from sports_espn_standings.payload. */
  standingsPayload?: EspnStandingsPayload | null;
  standingsFetchedAt?: Date | null;
  storedOdds?: StoredFixtureOdds[];
  homeTeam: PredictionTeamCore;
  awayTeam: PredictionTeamCore;
  historicalFixtures: PredictionFixtureCore[];
  leagueFixtures: PredictionFixtureCore[];
  loadedAt: Date;
  hasOdds: boolean;
  hasPickCenter: boolean;
  hasHeadToHead: boolean;
  hasLastFive: boolean;
  hasStandings: boolean;
  hasRosters: boolean;
  summaryAgeHours: number | null;
}

export interface ExpectedGoalsModel {
  home: number;
  away: number;
  leagueHomeAverage: number;
  leagueAwayAverage: number;
  homeSamples: number;
  awaySamples: number;
  leagueSamples: number;
  calculationMethod: string;
  /** Whether a score-based model has at least one independent, usable statistical evidence source. Provider odds alone never satisfy this gate. */
  independentEvidenceAvailable: boolean;
  evidenceLevel: 'STRONG' | 'PARTIAL' | 'INSUFFICIENT';
  historicalHeadToHeadMatches: number;
  homeRecentFormSamples: number;
  awayRecentFormSamples: number;
  standingsStrengthAvailable: boolean;
  evidence: string[];
}

export interface MatrixScoreProbability {
  homeGoals: number;
  awayGoals: number;
  probability: number;
}

export interface MarketOddsBaseline {
  /** Normalized implied probability for each 1X2 outcome. */
  home: number;
  draw: number;
  away: number;
  /** Original bookmaker prices in decimal format. */
  decimalOdds: {
    home: number;
    draw: number;
    away: number;
  };
  source: string;
  normalized: boolean;
}

export interface PredictionModelInput {
  context: PredictionMatchContext;
  expectedGoals: ExpectedGoalsModel;
  scoreMatrix: number[][];
  firstHalfMatrix: number[][];
  secondHalfMatrix: number[][];
  marketOdds: MarketOddsBaseline | null;
  modelVersion: string;
}
