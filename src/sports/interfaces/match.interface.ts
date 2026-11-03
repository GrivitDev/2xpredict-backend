export interface SportsMatchTeam {
  id: number | string;

  name: string;

  shortName?: string | null;

  logo?: string | null;
}

export interface SportsMatchScore {
  home: number | null;

  away: number | null;
}

export interface SportsMatch {
  id: number | string;

  competitionId: string;

  competitionName: string;

  season?: number | string | null;

  utcDate: string | Date;

  status: string;

  homeTeam: SportsMatchTeam;

  awayTeam: SportsMatchTeam;

  score?: SportsMatchScore | null;

  venue?: string | null;
}

