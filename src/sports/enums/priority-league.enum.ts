/**
 * Curated domestic leagues that receive ELITE, HIGH, or REGIONAL priority.
 *
 * The priority configuration assigns the tier. ESPN competitions that are not
 * listed here (or in the club/international priority enums) remain SELECTIVE.
 */
export enum PriorityLeague {
  // Global betting markets
  PREMIER_LEAGUE = 'eng.1',
  LA_LIGA = 'esp.1',
  SERIE_A = 'ita.1',
  BUNDESLIGA = 'ger.1',
  LIGUE_1 = 'fra.1',

  // Strong betting markets and widely followed leagues
  CHAMPIONSHIP = 'eng.2',
  ENGLISH_LEAGUE_ONE = 'eng.3',
  ENGLISH_LEAGUE_TWO = 'eng.4',
  SPANISH_SEGUNDA = 'esp.2',
  GERMAN_BUNDESLIGA_2 = 'ger.2',
  ITALIAN_SERIE_B = 'ita.2',
  FRENCH_LIGUE_2 = 'fra.2',
  EREDIVISIE = 'ned.1',
  DUTCH_EERSTE_DIVISIE = 'ned.2',
  PRIMEIRA_LIGA = 'por.1',
  SCOTTISH_PREMIERSHIP = 'sco.1',
  BELGIAN_PRO_LEAGUE = 'bel.1',
  TURKISH_SUPER_LIG = 'tur.1',
  BRAZIL_SERIE_A = 'bra.1',
  BRAZIL_SERIE_B = 'bra.2',
  ARGENTINA_PRIMERA = 'arg.1',
  LIGA_MX = 'mex.1',
  MLS = 'usa.1',
  SAUDI_PRO_LEAGUE = 'ksa.1',

  // Nigeria and African domestic coverage
  NPFL = 'nga.1',
  SOUTH_AFRICA_PREMIER_DIVISION = 'rsa.1',
  GHANAIAN_PREMIER_LEAGUE = 'gha.1',
  KENYAN_PREMIER_LEAGUE = 'ken.1',
  UGANDAN_PREMIER_LEAGUE = 'uga.1',
  SOUTH_AFRICA_FIRST_DIVISION = 'rsa.2',

  // Additional European leagues
  ENGLISH_NATIONAL_LEAGUE = 'eng.5',
  SCOTTISH_CHAMPIONSHIP = 'sco.2',
  GREEK_SUPER_LEAGUE = 'gre.1',
  AUSTRIAN_BUNDESLIGA = 'aut.1',
  DANISH_SUPERLIGA = 'den.1',
  NORWEGIAN_ELITESERIEN = 'nor.1',
  SWEDISH_ALLSVENSKAN = 'swe.1',
  IRISH_PREMIER_DIVISION = 'irl.1',
  RUSSIAN_PREMIER_LEAGUE = 'rus.1',

  // Additional South American leagues
  COLOMBIAN_PRIMERA_A = 'col.1',
  CHILEAN_PRIMERA_DIVISION = 'chi.1',
  ECUADOR_LIGAPRO = 'ecu.1',
  URUGUAYAN_PRIMERA_DIVISION = 'uru.1',
  PARAGUAYAN_PRIMERA_DIVISION = 'par.1',
  PERUVIAN_LIGA_1 = 'per.1',
  BOLIVIAN_LIGA_PROFESIONAL = 'bol.1',
  VENEZUELAN_PRIMERA_DIVISION = 'ven.1',
  BRAZIL_SERIE_C = 'bra.3',

  // Additional North American leagues
  MEXICAN_EXPANSION_MX = 'mex.2',
  USL_CHAMPIONSHIP = 'usa.usl.1',
  USL_LEAGUE_ONE = 'usa.usl.l1',
  GUATEMALAN_LIGA_NACIONAL = 'gua.1',

  // Asia and Oceania
  JAPANESE_J_LEAGUE = 'jpn.1',
  CHINESE_SUPER_LEAGUE = 'chn.1',
  INDIAN_SUPER_LEAGUE = 'ind.1',
  THAI_LEAGUE_1 = 'tha.1',
  MALAYSIAN_SUPER_LEAGUE = 'mys.1',
  INDONESIAN_SUPER_LEAGUE = 'idn.1',
  SINGAPOREAN_PREMIER_LEAGUE = 'sgp.1',
  AUSTRALIAN_A_LEAGUE = 'aus.1',
}
