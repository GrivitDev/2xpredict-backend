export interface FootballDataCompetitionConfig {
  code: string;
  name: string;
  espnLeagueSlug: string;
}

export const FOOTBALL_DATA_COVERAGE: FootballDataCompetitionConfig[] = [
  {
    code: 'PL',
    name: 'Premier League',
    espnLeagueSlug: 'eng.1',
  },
  {
    code: 'ELC',
    name: 'Championship',
    espnLeagueSlug: 'eng.2',
  },
  {
    code: 'PD',
    name: 'La Liga',
    espnLeagueSlug: 'esp.1',
  },
  {
    code: 'SA',
    name: 'Serie A',
    espnLeagueSlug: 'ita.1',
  },
  {
    code: 'BL1',
    name: 'Bundesliga',
    espnLeagueSlug: 'ger.1',
  },
  {
    code: 'FL1',
    name: 'Ligue 1',
    espnLeagueSlug: 'fra.1',
  },
  {
    code: 'DED',
    name: 'Eredivisie',
    espnLeagueSlug: 'ned.1',
  },
  {
    code: 'PPL',
    name: 'Primeira Liga',
    espnLeagueSlug: 'por.1',
  },
  {
    code: 'BSA',
    name: 'Brazil Serie A',
    espnLeagueSlug: 'bra.1',
  },
  {
    code: 'CL',
    name: 'UEFA Champions League',
    espnLeagueSlug: 'uefa.champions',
  },
  {
    code: 'WC',
    name: 'FIFA World Cup',
    espnLeagueSlug: 'fifa.world',
  },
  {
    code: 'EC',
    name: 'UEFA European Championship',
    espnLeagueSlug: 'uefa.euro',
  },
];

export const FOOTBALL_DATA_CODES = new Set(
  FOOTBALL_DATA_COVERAGE.map((competition) => competition.code),
);

export function getFootballDataCompetitionByEspnLeagueSlug(
  espnLeagueSlug: string,
): FootballDataCompetitionConfig | undefined {
  const normalizedSlug = espnLeagueSlug.trim().toLowerCase();

  return FOOTBALL_DATA_COVERAGE.find(
    (competition) =>
      competition.espnLeagueSlug.toLowerCase() === normalizedSlug,
  );
}

export function hasFootballDataCoverage(espnLeagueSlug: string): boolean {
  return (
    getFootballDataCompetitionByEspnLeagueSlug(espnLeagueSlug) !== undefined
  );
}

