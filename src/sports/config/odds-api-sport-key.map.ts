/** Explicit The Odds API keys. ESPN league IDs are never sent as sport keys. */
export const ODDS_API_SPORT_KEYS: Readonly<Record<string, string>> = {
  'eng.1': 'soccer_epl',
  'eng.2': 'soccer_efl_champ',
  'esp.1': 'soccer_spain_la_liga',
  'esp.copa_del_rey': 'soccer_spain_copa_del_rey',
  'ita.1': 'soccer_italy_serie_a',
  'ger.1': 'soccer_germany_bundesliga',
  'fra.1': 'soccer_france_ligue_one',
  'ned.1': 'soccer_netherlands_eredivisie',
  'por.1': 'soccer_portugal_primeira_liga',
  'sco.1': 'soccer_spl',
  'bel.1': 'soccer_belgium_first_div',
  'tur.1': 'soccer_turkey_super_league',
  'bra.1': 'soccer_brazil_campeonato',
  'arg.1': 'soccer_argentina_primera_division',
  'mex.1': 'soccer_mexico_ligamx',
  'usa.1': 'soccer_usa_mls',
  'ksa.1': 'soccer_saudi_arabia_pro_league',
  'uefa.champions': 'soccer_uefa_champs_league',
  'uefa.wchampions': 'soccer_uefa_champs_league_women',
  'uefa.europa': 'soccer_uefa_europa_league',
  'uefa.europa.conf': 'soccer_uefa_europa_conference_league',
  'conmebol.libertadores': 'soccer_conmebol_copa_libertadores',
  'conmebol.sudamericana': 'soccer_conmebol_copa_sudamericana',
  'fifa.world': 'soccer_fifa_world_cup',
  'caf.nations': 'soccer_africa_cup_of_nations',
  'uefa.euro': 'soccer_uefa_european_championship',
  'uefa.euroq': 'soccer_uefa_euro_qualification',
  'uefa.nations': 'soccer_uefa_nations_league',
  'conmebol.america': 'soccer_conmebol_copa_america',
  'concacaf.gold': 'soccer_concacaf_gold_cup',
};

export function getOddsApiSportKey(espnLeagueId: string): string | undefined {
  return ODDS_API_SPORT_KEYS[espnLeagueId.trim().toLowerCase()];
}
