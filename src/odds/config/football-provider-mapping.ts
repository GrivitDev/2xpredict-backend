/**
 * Explicit provider mapping between ESPN's canonical competition slug and each
 * odds provider's independent identifier namespace. Unknown IDs are deliberately
 * left unmapped; an ESPN slug must never be sent to another provider as though
 * it were that provider's ID.
 */
export interface FootballProviderMapping {
  espnLeagueSlug: string;
  displayName: string;
  oddsApiSportKey?: string;
  aliases?: string[];
}

export const FOOTBALL_PROVIDER_MAPPINGS: readonly FootballProviderMapping[] = [
  {
    espnLeagueSlug: 'eng.1',
    displayName: 'Premier League',
    oddsApiSportKey: 'soccer_epl',
  },
  {
    espnLeagueSlug: 'eng.2',
    displayName: 'Championship',
    oddsApiSportKey: 'soccer_efl_champ',
  },
  { espnLeagueSlug: 'eng.3', displayName: 'English League One' },
  { espnLeagueSlug: 'eng.4', displayName: 'English League Two' },
  {
    espnLeagueSlug: 'esp.1',
    displayName: 'La Liga',
    oddsApiSportKey: 'soccer_spain_la_liga',
    aliases: ['Primera Division'],
  },
  { espnLeagueSlug: 'esp.2', displayName: 'La Liga 2' },
  {
    espnLeagueSlug: 'ita.1',
    displayName: 'Serie A',
    oddsApiSportKey: 'soccer_italy_serie_a',
  },
  { espnLeagueSlug: 'ita.2', displayName: 'Serie B' },
  {
    espnLeagueSlug: 'ger.1',
    displayName: 'Bundesliga',
    oddsApiSportKey: 'soccer_germany_bundesliga',
  },
  { espnLeagueSlug: 'ger.2', displayName: '2. Bundesliga' },
  {
    espnLeagueSlug: 'fra.1',
    displayName: 'Ligue 1',
    oddsApiSportKey: 'soccer_france_ligue_one',
  },
  { espnLeagueSlug: 'fra.2', displayName: 'Ligue 2' },
  {
    espnLeagueSlug: 'ned.1',
    displayName: 'Eredivisie',
    oddsApiSportKey: 'soccer_netherlands_eredivisie',
  },
  { espnLeagueSlug: 'ned.2', displayName: 'Eerste Divisie' },
  {
    espnLeagueSlug: 'por.1',
    displayName: 'Primeira Liga',
    oddsApiSportKey: 'soccer_portugal_primeira_liga',
  },
  {
    espnLeagueSlug: 'sco.1',
    displayName: 'Scottish Premiership',
    oddsApiSportKey: 'soccer_spl',
  },
  {
    espnLeagueSlug: 'bel.1',
    displayName: 'Belgian Pro League',
    oddsApiSportKey: 'soccer_belgium_first_div',
  },
  {
    espnLeagueSlug: 'tur.1',
    displayName: 'Turkish Super Lig',
    oddsApiSportKey: 'soccer_turkey_super_league',
  },
  {
    espnLeagueSlug: 'bra.1',
    displayName: 'Brazil Serie A',
    oddsApiSportKey: 'soccer_brazil_campeonato',
  },
  {
    espnLeagueSlug: 'arg.1',
    displayName: 'Argentine Liga Profesional',
    oddsApiSportKey: 'soccer_argentina_primera_division',
  },
  {
    espnLeagueSlug: 'mex.1',
    displayName: 'Liga MX',
    oddsApiSportKey: 'soccer_mexico_ligamx',
  },
  {
    espnLeagueSlug: 'usa.1',
    displayName: 'MLS',
    oddsApiSportKey: 'soccer_usa_mls',
  },
  {
    espnLeagueSlug: 'ksa.1',
    displayName: 'Saudi Pro League',
    oddsApiSportKey: 'soccer_saudi_arabia_pro_league',
  },
  {
    espnLeagueSlug: 'uefa.champions',
    displayName: 'UEFA Champions League',
    oddsApiSportKey: 'soccer_uefa_champs_league',
  },
  {
    espnLeagueSlug: 'uefa.europa',
    displayName: 'UEFA Europa League',
    oddsApiSportKey: 'soccer_uefa_europa_league',
  },
  {
    espnLeagueSlug: 'uefa.europa.conf',
    displayName: 'UEFA Conference League',
    oddsApiSportKey: 'soccer_uefa_europa_conference_league',
  },
  {
    espnLeagueSlug: 'conmebol.libertadores',
    displayName: 'Copa Libertadores',
    oddsApiSportKey: 'soccer_conmebol_copa_libertadores',
  },
  {
    espnLeagueSlug: 'conmebol.sudamericana',
    displayName: 'Copa Sudamericana',
    oddsApiSportKey: 'soccer_conmebol_copa_sudamericana',
  },
  {
    espnLeagueSlug: 'fifa.world',
    displayName: 'FIFA World Cup',
    oddsApiSportKey: 'soccer_fifa_world_cup',
  },
  {
    espnLeagueSlug: 'uefa.euro',
    displayName: 'UEFA European Championship',
    oddsApiSportKey: 'soccer_uefa_european_championship',
  },
  {
    espnLeagueSlug: 'caf.nations',
    displayName: 'Africa Cup of Nations',
    oddsApiSportKey: 'soccer_africa_cup_of_nations',
  },
  {
    espnLeagueSlug: 'uefa.euroq',
    displayName: 'UEFA European Championship Qualifiers',
    oddsApiSportKey: 'soccer_uefa_euro_qualification',
  },
  {
    espnLeagueSlug: 'uefa.nations',
    displayName: 'UEFA Nations League',
    oddsApiSportKey: 'soccer_uefa_nations_league',
  },
  {
    espnLeagueSlug: 'conmebol.america',
    displayName: 'Copa America',
    oddsApiSportKey: 'soccer_conmebol_copa_america',
  },
  {
    espnLeagueSlug: 'concacaf.gold',
    displayName: 'CONCACAF Gold Cup',
    oddsApiSportKey: 'soccer_concacaf_gold_cup',
  },
];

const mappingBySlug = new Map<string, FootballProviderMapping>();
for (const mapping of FOOTBALL_PROVIDER_MAPPINGS) {
  mappingBySlug.set(normalizeEspnLeagueSlug(mapping.espnLeagueSlug), mapping);
  for (const alias of mapping.aliases ?? []) {
    mappingBySlug.set(normalizeEspnLeagueSlug(alias), mapping);
  }
}

/** Normalize harmless formatting differences only; do not guess provider IDs. */
export function normalizeEspnLeagueSlug(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

export function getFootballProviderMapping(
  value: unknown,
): FootballProviderMapping | undefined {
  return mappingBySlug.get(normalizeEspnLeagueSlug(value));
}

export function getOddsApiSportKey(value: unknown): string | undefined {
  return getFootballProviderMapping(value)?.oddsApiSportKey;
}
