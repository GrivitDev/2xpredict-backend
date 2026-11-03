export interface OddsApiSport {
  key: string;

  group: string;

  title: string;

  description?: string;

  active: boolean;

  has_outrights: boolean;

  ends?: string;

  image?: string;

  [key: string]: unknown;
}

export interface OddsApiEventOdds {
  id: string;

  sport_key: string;

  sport_title?: string;

  commence_time: string;

  home_team: string;

  away_team: string;

  bookmakers: OddsApiBookmaker[];

  [key: string]: unknown;
}

export interface OddsApiBookmaker {
  key: string;

  title: string;

  last_update: string;

  markets: OddsApiMarket[];

  [key: string]: unknown;
}

export interface OddsApiMarket {
  key: string;

  last_update: string;

  outcomes: OddsApiOutcome[];

  [key: string]: unknown;
}

export interface OddsApiOutcome {
  name: string;

  price: number;

  point?: number;

  description?: string;

  [key: string]: unknown;
}

