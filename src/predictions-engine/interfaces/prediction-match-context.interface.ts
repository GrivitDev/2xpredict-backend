import type {
  SportsFixtureRecord,
  SportsMatchTimelineEventRecord,
  SportsTeamRecord,
} from '../../sports/interfaces/sports-domain.interface';
import type {
  SportsHeadToHeadRecord,
  SportsTeamFormRecord,
  SportsTeamHomeAwayRecord,
  SportsTeamScoringRecord,
  SportsCompetitionScoringTotalsRecord,
  SportsTeamStatisticsAggregateRecord,
} from '../../sports/interfaces/sports-derived-data.interface';

export interface PredictionFixtureCore {
  eventId: string;
  leagueId: string;
  seasonId?: string;
  season: number;
  fixtureDate: Date;
  /** Exact season-duration-plus-three-months expiry maintained by Sports. */
  retentionExpiresAt?: Date | null;
  live: boolean;
  completed: boolean;
  status?: string;
  statusDetail?: string;
  statusShortDetail?: string;
  statusState?: SportsFixtureRecord['status']['state'];
  period?: number;
  clock?: string;
  displayClock?: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore?: number;
  awayScore?: number;
  neutralSite?: boolean;
  periodScores: SportsFixtureRecord['periodScores'];
  collectedAt: Date;
  sourceUpdatedAt: Date;
  /** Retained for persisted prediction schema compatibility; now means Sports source freshness. */
  summaryCollectedAt?: Date | string | null;
  /** Provider-independent normalized fixture facts, not a raw provider payload. */
  payload: Record<string, any>;
}

export interface PredictionTeamCore {
  id: string;
  name: string;
  abbreviation?: string;
  logo?: string;
  country?: string;
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
  predictionReady: boolean;
  priceType: 'PROVIDER' | 'ESTIMATED';
  provider?: OddsProvider | null;
  bookmaker?: string | null;
  providerUpdatedAt?: Date | null;
  fairOdds?: number | null;
  oddsBasis?: OddsBasis | null;
  oddsCalculationMethod?: string | null;
  updatedAt: Date | null;
  isFresh: boolean;
  dataQuality?: number;
  sampleSize?: number;
}

export interface PredictionStatisticAggregate {
  key: string;
  name: string;
  category?: string;
  unit?: string;
  sampleSize: number;
  average: number;
  /** Sample variance derived from actual completed-fixture observations. */
  variance?: number | null;
  minimum?: number | null;
  maximum?: number | null;
}

/** A standings row normalized from Sports' per-team projection records. */
export interface PredictionStandingEntry {
  teamId: string;
  position?: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
}

/** Prediction-facing standings snapshot; Sports remains the source of every row. */
export interface PredictionStandingsSnapshot {
  competitionId: string;
  seasonId: string;
  entries: PredictionStandingEntry[];
  computedAt: Date | null;
}

/** Current match statistics are read from normalized Sports fixture competitors. */
export interface PredictionCurrentMatchStatistics {
  fixtureId: string;
  teamId: string;
  homeAway: 'HOME' | 'AWAY';
  statistics: Array<Record<string, unknown>>;
  sourceCollectedAt: Date | null;
  sourceUpdatedAt: Date | null;
}

export interface PredictionMatchContext {
  fixture: PredictionFixtureCore;
  /** Monotonic Sports source revision for the normalized fixture facts used by this run. */
  fixtureSourceRevision: number;
  /** Compatibility shell for older internal consumers. This is normalized Sports context, never an ESPN Summary payload. */
  summary: Record<string, any>;
  summaryAvailable: boolean;
  standings?: PredictionStandingsSnapshot | null;
  standingsFetchedAt?: Date | null;
  storedOdds?: StoredFixtureOdds[];
  homeTeam: PredictionTeamCore;
  awayTeam: PredictionTeamCore;
  historicalFixtures: PredictionFixtureCore[];
  leagueFixtures: PredictionFixtureCore[];
  homeForm?: SportsTeamFormRecord | null;
  awayForm?: SportsTeamFormRecord | null;
  homeAwayRecords: {
    home?: SportsTeamHomeAwayRecord | null;
    away?: SportsTeamHomeAwayRecord | null;
  };
  scoringRecords: {
    home?: SportsTeamScoringRecord | null;
    away?: SportsTeamScoringRecord | null;
  };
  competitionScoring?: SportsCompetitionScoringTotalsRecord | null;
  teamStatisticsAggregates: {
    home?: SportsTeamStatisticsAggregateRecord | null;
    away?: SportsTeamStatisticsAggregateRecord | null;
  };
  headToHead?: SportsHeadToHeadRecord | null;
  currentMatchStatistics: PredictionCurrentMatchStatistics[];
  currentTimeline: SportsMatchTimelineEventRecord[];
  /** Current normalized Sports match identity; no separate lineup or roster is assumed. */
  sportsMatch?: {
    homeTeam?: SportsTeamRecord | null;
    awayTeam?: SportsTeamRecord | null;
  } | null;
  loadedAt: Date;
  sourceUpdatedAt: Date;
  sportsDataAgeHours: number | null;
  hasOdds: boolean;
  hasPickCenter: boolean;
  hasHeadToHead: boolean;
  hasLastFive: boolean;
  hasStandings: boolean;
  /** True only when Sports supplies validated per-appearance player evidence. */
  hasPlayerAppearanceEvidence: boolean;
}

export interface ExpectedGoalsModel {
  home: number;
  away: number;
  leagueHomeAverage: number;
  leagueAwayAverage: number;
  homeSamples: number;
  awaySamples: number;
  leagueSamples: number;
  /** Team-specific first-half goal shares derived from Sports period-score observations. */
  homeFirstHalfGoalShare: number;
  awayFirstHalfGoalShare: number;
  observedPeriodSplit: boolean;
  homePeriodSplitSamples: number;
  awayPeriodSplitSamples: number;
  calculationMethod: string;
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
  home: number;
  draw: number;
  away: number;
  decimalOdds: { home: number; draw: number; away: number };
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

