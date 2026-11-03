/**
 * Curated club competitions that receive ELITE, HIGH, or REGIONAL priority.
 * Unlisted ESPN competitions remain SELECTIVE.
 */
export enum PriorityClubCompetition {
  // Major continental club competitions
  UEFA_CHAMPIONS_LEAGUE = 'uefa.champions',
  UEFA_EUROPA_LEAGUE = 'uefa.europa',
  UEFA_CONFERENCE_LEAGUE = 'uefa.europa.conf',
  UEFA_CHAMPIONS_LEAGUE_QUALIFYING = 'uefa.champions_qual',
  UEFA_EUROPA_LEAGUE_QUALIFYING = 'uefa.europa_qual',
  UEFA_CONFERENCE_LEAGUE_QUALIFYING = 'uefa.europa.conf_qual',
  CAF_CHAMPIONS_LEAGUE = 'caf.champions',
  CAF_CONFEDERATION_CUP = 'caf.confed',
  COPA_LIBERTADORES = 'conmebol.libertadores',
  COPA_SUDAMERICANA = 'conmebol.sudamericana',
  CONCACAF_CHAMPIONS_CUP = 'concacaf.champions',
  AFC_CHAMPIONS_LEAGUE_ELITE = 'afc.champions',
  AFC_CHAMPIONS_LEAGUE_TWO = 'afc.cup',

  // Major domestic cups with substantial betting interest
  ENGLISH_FA_CUP = 'eng.fa',
  ENGLISH_LEAGUE_CUP = 'eng.league_cup',
  SPANISH_COPA_DEL_REY = 'esp.copa_del_rey',
  ITALIAN_COPPA_ITALIA = 'ita.coppa_italia',
  GERMAN_DFB_POKAL = 'ger.dfb_pokal',
  FRENCH_COUPE_DE_FRANCE = 'fra.coupe_de_france',
  BRAZIL_COPA_DO_BRAZIL = 'bra.copa_do_brazil',
  ARGENTINA_COPA = 'arg.copa',
  CONCACAF_LEAGUES_CUP = 'concacaf.leagues.cup',
  CONMEBOL_RECOPA = 'conmebol.recopa',
  UEFA_SUPER_CUP = 'uefa.super_cup',

  // Global club tournaments
  FIFA_CLUB_WORLD_CUP = 'fifa.cwc',
  FIFA_INTERCONTINENTAL_CUP = 'fifa.intercontinental_cup',
}

