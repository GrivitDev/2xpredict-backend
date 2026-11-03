export interface FootballDataCompetitionListResponse {
  count?: number;

  competitions?: FootballDataCompetition[];

  filters?: Record<string, unknown>;

  [key: string]: unknown;
}

export interface FootballDataMatchListResponse {
  count?: number;

  matches?: FootballDataMatch[];

  filters?: Record<string, unknown>;

  resultSet?: {
    count?: number;

    competitions?: string;

    first?: string;

    last?: string;

    played?: number;

    wins?: number;

    draws?: number;

    losses?: number;

    goalsFor?: number;

    goalsAgainst?: number;
  };

  [key: string]: unknown;
}

export interface FootballDataStandingsResponse {
  filters?: Record<string, unknown>;

  competition?: FootballDataCompetition;

  season?: FootballDataSeason | null;

  standings?: FootballDataStandingTable[];

  [key: string]: unknown;
}

export interface FootballDataTeamListResponse {
  count?: number;

  teams?: FootballDataTeam[];

  filters?: Record<string, unknown>;

  competition?: FootballDataCompetition;

  season?: FootballDataSeason | null;

  [key: string]: unknown;
}

export interface FootballDataCompetition {
  id: number;

  name: string;

  code: string | null;

  type: string;

  emblem?: string | null;

  plan?: string | null;

  currentSeason?: FootballDataSeason | null;

  area?: FootballDataArea | null;

  [key: string]: unknown;
}

export interface FootballDataSeason {
  id: number;

  startDate: string;

  endDate: string;

  currentMatchday?: number | null;

  winner?: FootballDataTeam | null;

  [key: string]: unknown;
}

export interface FootballDataArea {
  id: number;

  name: string;

  code?: string | null;

  flag?: string | null;

  [key: string]: unknown;
}

export interface FootballDataMatch {
  id: number;

  utcDate: string;

  status: string;

  minute?: string | null;

  injuryTime?: number | null;

  attendance?: number | null;

  competition: {
    id: number;

    name: string;

    code: string | null;

    type: string;

    emblem?: string | null;

    [key: string]: unknown;
  };

  season?: FootballDataSeason | null;

  homeTeam: FootballDataTeam;

  awayTeam: FootballDataTeam;

  score: FootballDataScore;

  referees?: FootballDataReferee[];

  [key: string]: unknown;
}

export interface FootballDataScore {
  winner?: string | null;

  duration?: string | null;

  fullTime?: FootballDataScoreTime;

  halfTime?: FootballDataScoreTime;

  extraTime?: FootballDataScoreTime;

  penalties?: FootballDataScoreTime;

  [key: string]: unknown;
}

export interface FootballDataScoreTime {
  home?: number | null;

  away?: number | null;
}

export interface FootballDataTeam {
  id: number;

  name: string;

  shortName?: string | null;

  tla?: string | null;

  crest?: string | null;

  address?: string | null;

  website?: string | null;

  founded?: number | null;

  clubColors?: string | null;

  venue?: string | null;

  runningCompetitions?: FootballDataCompetition[];

  [key: string]: unknown;
}

export interface FootballDataStandingTable {
  stage?: string | null;

  type?: string | null;

  group?: string | null;

  table: FootballDataStandingRow[];

  [key: string]: unknown;
}

export interface FootballDataStandingRow {
  position: number;

  team: FootballDataTeam;

  playedGames: number;

  form?: string | null;

  won: number;

  draw: number;

  lost: number;

  points: number;

  goalsFor: number;

  goalsAgainst: number;

  goalDifference: number;

  [key: string]: unknown;
}

export interface FootballDataReferee {
  id?: number;

  name?: string;

  type?: string;

  nationality?: string;
}

