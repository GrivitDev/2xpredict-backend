import { CollectionFrequency } from '../enums/collection-frequency.enum';
import { CompetitionPriority } from '../enums/competition-priority.enum';
import { CompetitionRegion } from '../enums/competition-region.enum';
import { CompetitionType } from '../enums/competition-type.enum';
import { PriorityLeague } from '../enums/priority-league.enum';
import { PriorityClubCompetition } from '../enums/priority-club-competition.enum';
import { PriorityInternationalCompetition } from '../enums/priority-international-competition.enum';
import { SupportedCompetitionConfig } from '../interfaces/supported-competition-config.interface';
import { FOOTBALL_DATA_COVERAGE } from './football-data-coverage.config';

// ============================================================
// FOOTBALL-DATA MAPPINGS
// ============================================================

const FOOTBALL_DATA_CODES: Record<string, string> = Object.fromEntries(
  FOOTBALL_DATA_COVERAGE.map((coverage) => [
    coverage.espnLeagueSlug,
    coverage.code,
  ]),
);

// ============================================================
// THE ODDS API MAPPINGS
// ============================================================

/**
 * The Odds API uses its own sport-key namespace. These are only explicit,
 * known mappings; ESPN competition IDs must not be used as Odds API keys.
 */
const ODDS_API_SPORT_KEYS: Record<string, string> = {
  // Domestic leagues
  'eng.1': 'soccer_epl',
  'eng.2': 'soccer_efl_champ',
  'esp.1': 'soccer_spain_la_liga',
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

  // UEFA club competitions
  'uefa.champions': 'soccer_uefa_champs_league',
  'uefa.europa': 'soccer_uefa_europa_league',
  'uefa.europa.conf': 'soccer_uefa_europa_conference_league',

  // South American club competitions
  'conmebol.libertadores': 'soccer_conmebol_copa_libertadores',
  'conmebol.sudamericana': 'soccer_conmebol_copa_sudamericana',

  // International competitions
  'fifa.world': 'soccer_fifa_world_cup',
  'caf.nations': 'soccer_africa_cup_of_nations',
  'uefa.euro': 'soccer_uefa_european_championship',
  'uefa.euroq': 'soccer_uefa_euro_qualification',
  'uefa.nations': 'soccer_uefa_nations_league',
  'conmebol.america': 'soccer_conmebol_copa_america',
  'concacaf.gold': 'soccer_concacaf_gold_cup',
};

/**
 * Some configured competitions do not have a corresponding Odds API sport key.
 * They remain valid ESPN priority competitions, but no Odds API request is
 * enabled for them unless a real mapping is added separately.
 */

// ============================================================
// COMPETITION DISPLAY NAMES
// ============================================================

const DISPLAY_NAMES: Record<string, string> = {
  // Domestic leagues
  'eng.1': 'Premier League',
  'eng.2': 'Championship',
  'eng.3': 'English League One',
  'eng.4': 'English League Two',
  'eng.5': 'English National League',
  'esp.1': 'La Liga',
  'esp.2': 'La Liga 2',
  'ita.1': 'Serie A',
  'ita.2': 'Serie B',
  'ger.1': 'Bundesliga',
  'ger.2': '2. Bundesliga',
  'fra.1': 'Ligue 1',
  'fra.2': 'Ligue 2',
  'ned.1': 'Eredivisie',
  'ned.2': 'Eerste Divisie',
  'por.1': 'Primeira Liga',
  'sco.1': 'Scottish Premiership',
  'sco.2': 'Scottish Championship',
  'bel.1': 'Belgian Pro League',
  'tur.1': 'Turkish Super Lig',
  'gre.1': 'Greek Super League',
  'aut.1': 'Austrian Bundesliga',
  'den.1': 'Danish Superliga',
  'nor.1': 'Norwegian Eliteserien',
  'swe.1': 'Swedish Allsvenskan',
  'irl.1': 'Irish Premier Division',
  'rus.1': 'Russian Premier League',
  'nga.1': 'Nigeria Premier Football League',
  'rsa.1': 'South African Premiership',
  'rsa.2': 'South African First Division',
  'gha.1': 'Ghanaian Premier League',
  'ken.1': 'Kenyan Premier League',
  'uga.1': 'Ugandan Premier League',
  'bra.1': 'Brazilian Serie A',
  'bra.2': 'Brazilian Serie B',
  'bra.3': 'Brazilian Serie C',
  'arg.1': 'Argentine Liga Profesional',
  'chi.1': 'Chilean Primera División',
  'col.1': 'Colombian Primera A',
  'ecu.1': 'Ecuadorian LigaPro',
  'uru.1': 'Uruguayan Primera División',
  'par.1': 'Paraguayan Primera División',
  'per.1': 'Peruvian Liga 1',
  'bol.1': 'Bolivian Liga Profesional',
  'ven.1': 'Venezuelan Primera División',
  'mex.1': 'Liga MX',
  'mex.2': 'Liga de Expansión MX',
  'usa.1': 'MLS',
  'usa.usl.1': 'USL Championship',
  'usa.usl.l1': 'USL League One',
  'gua.1': 'Guatemalan Liga Nacional',
  'ksa.1': 'Saudi Pro League',
  'jpn.1': 'Japanese J.League',
  'chn.1': 'Chinese Super League',
  'ind.1': 'Indian Super League',
  'tha.1': 'Thai League 1',
  'mys.1': 'Malaysian Super League',
  'idn.1': 'Indonesian Super League',
  'sgp.1': 'Singaporean Premier League',
  'aus.1': 'Australian A-League Men',

  // Club competitions
  'uefa.champions': 'UEFA Champions League',
  'uefa.europa': 'UEFA Europa League',
  'uefa.europa.conf': 'UEFA Conference League',
  'uefa.super_cup': 'UEFA Super Cup',
  'uefa.champions_qual': 'UEFA Champions League Qualifying',
  'uefa.europa_qual': 'UEFA Europa League Qualifying',
  'uefa.europa.conf_qual': 'UEFA Conference League Qualifying',
  'caf.champions': 'CAF Champions League',
  'caf.confed': 'CAF Confederation Cup',
  'conmebol.libertadores': 'Copa Libertadores',
  'conmebol.sudamericana': 'Copa Sudamericana',
  'conmebol.recopa': 'Recopa Sudamericana',
  'concacaf.champions': 'CONCACAF Champions Cup',
  'concacaf.leagues.cup': 'Leagues Cup',
  'afc.champions': 'AFC Champions League Elite',
  'afc.cup': 'AFC Champions League Two',
  'eng.fa': 'FA Cup',
  'eng.league_cup': 'EFL Cup',
  'esp.copa_del_rey': 'Copa del Rey',
  'ita.coppa_italia': 'Coppa Italia',
  'ger.dfb_pokal': 'DFB-Pokal',
  'fra.coupe_de_france': 'Coupe de France',
  'bra.copa_do_brazil': 'Copa do Brasil',
  'arg.copa': 'Copa Argentina',
  'fifa.cwc': 'FIFA Club World Cup',
  'fifa.intercontinental_cup': 'FIFA Intercontinental Cup',

  // International competitions
  'fifa.world': 'FIFA World Cup',
  'fifa.worldq': 'FIFA World Cup Qualifiers',
  'fifa.worldq.uefa': 'World Cup Qualifiers - UEFA',
  'fifa.worldq.caf': 'World Cup Qualifiers - CAF',
  'fifa.worldq.afc': 'World Cup Qualifiers - AFC',
  'fifa.worldq.concacaf': 'World Cup Qualifiers - CONCACAF',
  'fifa.worldq.conmebol': 'World Cup Qualifiers - CONMEBOL',
  'fifa.wwc': "FIFA Women's World Cup",
  'fifa.olympics': "Men's Olympic Soccer Tournament",
  'caf.nations': 'Africa Cup of Nations',
  'caf.nations_qual': 'Africa Cup of Nations Qualifiers',
  'uefa.euro': 'UEFA European Championship',
  'uefa.euroq': 'UEFA European Championship Qualifiers',
  'uefa.nations': 'UEFA Nations League',
  'uefa.weuro': "UEFA Women's European Championship",
  'conmebol.america': 'Copa America',
  'concacaf.gold': 'CONCACAF Gold Cup',
  'concacaf.nations.league': 'CONCACAF Nations League',
  'concacaf.w.gold': 'CONCACAF W Gold Cup',
  'afc.asian.cup': 'AFC Asian Cup',
};

// ============================================================
// HELPERS
// ============================================================

function createId(espnLeagueSlug: string): string {
  return espnLeagueSlug.trim().toLowerCase();
}

function toDisplayName(espnLeagueSlug: string): string {
  return (
    DISPLAY_NAMES[espnLeagueSlug] ??
    espnLeagueSlug
      .split('.')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  );
}

function getFootballDataMapping(espnLeagueSlug: string): {
  footballDataCode?: string;
} {
  const code = FOOTBALL_DATA_CODES[espnLeagueSlug];
  return code ? { footballDataCode: code } : {};
}

function getOddsApiMapping(espnLeagueSlug: string): {
  oddsApiSportKey?: string;
} {
  const sportKey = ODDS_API_SPORT_KEYS[espnLeagueSlug];
  return sportKey ? { oddsApiSportKey: sportKey } : {};
}

function buildCompetition(
  espnLeagueSlug: string,
  type: CompetitionType,
  region: CompetitionRegion,
  priority: CompetitionPriority,
  options?: {
    predictionEnabled?: boolean;
    oddsEnabled?: boolean;
    seasonal?: boolean;
    gender?: 'MEN' | 'WOMEN';
    notes?: string;
    oddsApiSportKey?: string;
  },
): SupportedCompetitionConfig {
  const oddsApiMapping = getOddsApiMapping(espnLeagueSlug);
  const oddsApiSportKey =
    options?.oddsApiSportKey ?? oddsApiMapping.oddsApiSportKey;
  const oddsEnabled = options?.oddsEnabled ?? Boolean(oddsApiSportKey);

  return {
    id: createId(espnLeagueSlug),
    name: toDisplayName(espnLeagueSlug),
    type,
    region,
    priority,
    enabled: true,
    predictionEnabled: options?.predictionEnabled ?? true,
    oddsEnabled,
    collectionFrequency: CollectionFrequency.DAILY,
    providers: {
      ...getFootballDataMapping(espnLeagueSlug),
      ...(oddsApiSportKey ? { oddsApiSportKey } : {}),
      espnLeagueSlug,
    },
    seasonal: options?.seasonal ?? false,
    gender: options?.gender ?? 'MEN',
    notes: options?.notes,
  };
}

// ============================================================
// PRIORITY TIERS: DOMESTIC LEAGUES
// ============================================================

/** The highest-priority domestic betting markets and global competitions. */
const ELITE_LEAGUES = new Set<PriorityLeague>([
  PriorityLeague.PREMIER_LEAGUE,
  PriorityLeague.LA_LIGA,
  PriorityLeague.SERIE_A,
  PriorityLeague.BUNDESLIGA,
  PriorityLeague.LIGUE_1,
]);

/**
 * Strong betting-market coverage plus major leagues important to the platform's
 * audience. All remaining entries in PriorityLeague are REGIONAL by default.
 */
const HIGH_LEAGUES = new Set<PriorityLeague>([
  PriorityLeague.CHAMPIONSHIP,
  PriorityLeague.ENGLISH_LEAGUE_ONE,
  PriorityLeague.ENGLISH_LEAGUE_TWO,
  PriorityLeague.SPANISH_SEGUNDA,
  PriorityLeague.GERMAN_BUNDESLIGA_2,
  PriorityLeague.ITALIAN_SERIE_B,
  PriorityLeague.FRENCH_LIGUE_2,
  PriorityLeague.EREDIVISIE,
  PriorityLeague.PRIMEIRA_LIGA,
  PriorityLeague.SCOTTISH_PREMIERSHIP,
  PriorityLeague.BELGIAN_PRO_LEAGUE,
  PriorityLeague.TURKISH_SUPER_LIG,
  PriorityLeague.NPFL,
  PriorityLeague.SOUTH_AFRICA_PREMIER_DIVISION,
  PriorityLeague.BRAZIL_SERIE_A,
  PriorityLeague.BRAZIL_SERIE_B,
  PriorityLeague.ARGENTINA_PRIMERA,
  PriorityLeague.LIGA_MX,
  PriorityLeague.MLS,
  PriorityLeague.SAUDI_PRO_LEAGUE,
]);

const LEAGUE_REGIONS: Partial<Record<PriorityLeague, CompetitionRegion>> = {
  [PriorityLeague.NPFL]: CompetitionRegion.NIGERIA,
  [PriorityLeague.SOUTH_AFRICA_PREMIER_DIVISION]: CompetitionRegion.AFRICA,
  [PriorityLeague.GHANAIAN_PREMIER_LEAGUE]: CompetitionRegion.AFRICA,
  [PriorityLeague.KENYAN_PREMIER_LEAGUE]: CompetitionRegion.AFRICA,
  [PriorityLeague.UGANDAN_PREMIER_LEAGUE]: CompetitionRegion.AFRICA,
  [PriorityLeague.SOUTH_AFRICA_FIRST_DIVISION]: CompetitionRegion.AFRICA,

  [PriorityLeague.BRAZIL_SERIE_A]: CompetitionRegion.SOUTH_AMERICA,
  [PriorityLeague.BRAZIL_SERIE_B]: CompetitionRegion.SOUTH_AMERICA,
  [PriorityLeague.BRAZIL_SERIE_C]: CompetitionRegion.SOUTH_AMERICA,
  [PriorityLeague.ARGENTINA_PRIMERA]: CompetitionRegion.SOUTH_AMERICA,
  [PriorityLeague.COLOMBIAN_PRIMERA_A]: CompetitionRegion.SOUTH_AMERICA,
  [PriorityLeague.CHILEAN_PRIMERA_DIVISION]: CompetitionRegion.SOUTH_AMERICA,
  [PriorityLeague.ECUADOR_LIGAPRO]: CompetitionRegion.SOUTH_AMERICA,
  [PriorityLeague.URUGUAYAN_PRIMERA_DIVISION]: CompetitionRegion.SOUTH_AMERICA,
  [PriorityLeague.PARAGUAYAN_PRIMERA_DIVISION]: CompetitionRegion.SOUTH_AMERICA,
  [PriorityLeague.PERUVIAN_LIGA_1]: CompetitionRegion.SOUTH_AMERICA,
  [PriorityLeague.BOLIVIAN_LIGA_PROFESIONAL]: CompetitionRegion.SOUTH_AMERICA,
  [PriorityLeague.VENEZUELAN_PRIMERA_DIVISION]: CompetitionRegion.SOUTH_AMERICA,

  [PriorityLeague.LIGA_MX]: CompetitionRegion.NORTH_AMERICA,
  [PriorityLeague.MEXICAN_EXPANSION_MX]: CompetitionRegion.NORTH_AMERICA,
  [PriorityLeague.MLS]: CompetitionRegion.NORTH_AMERICA,
  [PriorityLeague.USL_CHAMPIONSHIP]: CompetitionRegion.NORTH_AMERICA,
  [PriorityLeague.USL_LEAGUE_ONE]: CompetitionRegion.NORTH_AMERICA,
  [PriorityLeague.GUATEMALAN_LIGA_NACIONAL]: CompetitionRegion.NORTH_AMERICA,

  [PriorityLeague.SAUDI_PRO_LEAGUE]: CompetitionRegion.ASIA,
  [PriorityLeague.JAPANESE_J_LEAGUE]: CompetitionRegion.ASIA,
  [PriorityLeague.CHINESE_SUPER_LEAGUE]: CompetitionRegion.ASIA,
  [PriorityLeague.INDIAN_SUPER_LEAGUE]: CompetitionRegion.ASIA,
  [PriorityLeague.THAI_LEAGUE_1]: CompetitionRegion.ASIA,
  [PriorityLeague.MALAYSIAN_SUPER_LEAGUE]: CompetitionRegion.ASIA,
  [PriorityLeague.INDONESIAN_SUPER_LEAGUE]: CompetitionRegion.ASIA,
  [PriorityLeague.SINGAPOREAN_PREMIER_LEAGUE]: CompetitionRegion.ASIA,

  [PriorityLeague.AUSTRALIAN_A_LEAGUE]: CompetitionRegion.OCEANIA,
};

const PRIORITY_LEAGUES: SupportedCompetitionConfig[] = Object.values(
  PriorityLeague,
).map((league) => {
  const priority = ELITE_LEAGUES.has(league)
    ? CompetitionPriority.ELITE
    : HIGH_LEAGUES.has(league)
      ? CompetitionPriority.HIGH
      : CompetitionPriority.REGIONAL;

  return buildCompetition(
    league,
    CompetitionType.LEAGUE,
    LEAGUE_REGIONS[league] ?? CompetitionRegion.EUROPE,
    priority,
  );
});

// ============================================================
// PRIORITY TIERS: CLUB COMPETITIONS
// ============================================================

const ELITE_CLUB_COMPETITIONS = new Set<PriorityClubCompetition>([
  PriorityClubCompetition.UEFA_CHAMPIONS_LEAGUE,
  PriorityClubCompetition.COPA_LIBERTADORES,
  PriorityClubCompetition.FIFA_CLUB_WORLD_CUP,
]);

const HIGH_CLUB_COMPETITIONS = new Set<PriorityClubCompetition>([
  PriorityClubCompetition.UEFA_EUROPA_LEAGUE,
  PriorityClubCompetition.UEFA_CONFERENCE_LEAGUE,
  PriorityClubCompetition.UEFA_CHAMPIONS_LEAGUE_QUALIFYING,
  PriorityClubCompetition.UEFA_EUROPA_LEAGUE_QUALIFYING,
  PriorityClubCompetition.UEFA_CONFERENCE_LEAGUE_QUALIFYING,
  PriorityClubCompetition.CAF_CHAMPIONS_LEAGUE,
  PriorityClubCompetition.CAF_CONFEDERATION_CUP,
  PriorityClubCompetition.COPA_SUDAMERICANA,
  PriorityClubCompetition.CONCACAF_CHAMPIONS_CUP,
  PriorityClubCompetition.AFC_CHAMPIONS_LEAGUE_ELITE,
  PriorityClubCompetition.ENGLISH_FA_CUP,
  PriorityClubCompetition.ENGLISH_LEAGUE_CUP,
  PriorityClubCompetition.SPANISH_COPA_DEL_REY,
  PriorityClubCompetition.ITALIAN_COPPA_ITALIA,
  PriorityClubCompetition.GERMAN_DFB_POKAL,
  PriorityClubCompetition.FRENCH_COUPE_DE_FRANCE,
  PriorityClubCompetition.BRAZIL_COPA_DO_BRAZIL,
  PriorityClubCompetition.CONCACAF_LEAGUES_CUP,
  PriorityClubCompetition.UEFA_SUPER_CUP,
]);

const CLUB_COMPETITION_REGIONS: Record<
  PriorityClubCompetition,
  CompetitionRegion
> = {
  [PriorityClubCompetition.UEFA_CHAMPIONS_LEAGUE]: CompetitionRegion.EUROPE,
  [PriorityClubCompetition.UEFA_EUROPA_LEAGUE]: CompetitionRegion.EUROPE,
  [PriorityClubCompetition.UEFA_CONFERENCE_LEAGUE]: CompetitionRegion.EUROPE,
  [PriorityClubCompetition.UEFA_CHAMPIONS_LEAGUE_QUALIFYING]:
    CompetitionRegion.EUROPE,
  [PriorityClubCompetition.UEFA_EUROPA_LEAGUE_QUALIFYING]:
    CompetitionRegion.EUROPE,
  [PriorityClubCompetition.UEFA_CONFERENCE_LEAGUE_QUALIFYING]:
    CompetitionRegion.EUROPE,
  [PriorityClubCompetition.UEFA_SUPER_CUP]: CompetitionRegion.EUROPE,

  [PriorityClubCompetition.CAF_CHAMPIONS_LEAGUE]: CompetitionRegion.AFRICA,
  [PriorityClubCompetition.CAF_CONFEDERATION_CUP]: CompetitionRegion.AFRICA,

  [PriorityClubCompetition.COPA_LIBERTADORES]: CompetitionRegion.SOUTH_AMERICA,
  [PriorityClubCompetition.COPA_SUDAMERICANA]: CompetitionRegion.SOUTH_AMERICA,
  [PriorityClubCompetition.CONMEBOL_RECOPA]: CompetitionRegion.SOUTH_AMERICA,
  [PriorityClubCompetition.BRAZIL_COPA_DO_BRAZIL]:
    CompetitionRegion.SOUTH_AMERICA,
  [PriorityClubCompetition.ARGENTINA_COPA]: CompetitionRegion.SOUTH_AMERICA,

  [PriorityClubCompetition.CONCACAF_CHAMPIONS_CUP]:
    CompetitionRegion.NORTH_AMERICA,
  [PriorityClubCompetition.CONCACAF_LEAGUES_CUP]:
    CompetitionRegion.NORTH_AMERICA,

  [PriorityClubCompetition.AFC_CHAMPIONS_LEAGUE_ELITE]: CompetitionRegion.ASIA,
  [PriorityClubCompetition.AFC_CHAMPIONS_LEAGUE_TWO]: CompetitionRegion.ASIA,

  [PriorityClubCompetition.ENGLISH_FA_CUP]: CompetitionRegion.EUROPE,
  [PriorityClubCompetition.ENGLISH_LEAGUE_CUP]: CompetitionRegion.EUROPE,
  [PriorityClubCompetition.SPANISH_COPA_DEL_REY]: CompetitionRegion.EUROPE,
  [PriorityClubCompetition.ITALIAN_COPPA_ITALIA]: CompetitionRegion.EUROPE,
  [PriorityClubCompetition.GERMAN_DFB_POKAL]: CompetitionRegion.EUROPE,
  [PriorityClubCompetition.FRENCH_COUPE_DE_FRANCE]: CompetitionRegion.EUROPE,

  [PriorityClubCompetition.FIFA_CLUB_WORLD_CUP]: CompetitionRegion.WORLD,
  [PriorityClubCompetition.FIFA_INTERCONTINENTAL_CUP]: CompetitionRegion.WORLD,
};

const PRIORITY_CLUB_COMPETITIONS: SupportedCompetitionConfig[] = Object.values(
  PriorityClubCompetition,
).map((competition) => {
  const priority = ELITE_CLUB_COMPETITIONS.has(competition)
    ? CompetitionPriority.ELITE
    : HIGH_CLUB_COMPETITIONS.has(competition)
      ? CompetitionPriority.HIGH
      : CompetitionPriority.REGIONAL;

  return buildCompetition(
    competition,
    CompetitionType.CLUB_COMPETITION,
    CLUB_COMPETITION_REGIONS[competition],
    priority,
    { seasonal: true },
  );
});

// ============================================================
// PRIORITY TIERS: INTERNATIONAL COMPETITIONS
// ============================================================

const ELITE_INTERNATIONAL_COMPETITIONS =
  new Set<PriorityInternationalCompetition>([
    PriorityInternationalCompetition.FIFA_WORLD_CUP,
    PriorityInternationalCompetition.UEFA_EURO,
    PriorityInternationalCompetition.AFCON,
    PriorityInternationalCompetition.COPA_AMERICA,
  ]);

const WOMENS_INTERNATIONAL_COMPETITIONS =
  new Set<PriorityInternationalCompetition>([
    PriorityInternationalCompetition.FIFA_WOMENS_WORLD_CUP,
    PriorityInternationalCompetition.UEFA_WOMENS_EURO,
    PriorityInternationalCompetition.CONCACAF_WOMENS_GOLD_CUP,
  ]);

const HIGH_INTERNATIONAL_COMPETITIONS =
  new Set<PriorityInternationalCompetition>([
    PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS,
    PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS_UEFA,
    PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS_CAF,
    PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS_AFC,
    PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS_CONCACAF,
    PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS_CONMEBOL,
    PriorityInternationalCompetition.AFCON_QUALIFIERS,
    PriorityInternationalCompetition.UEFA_EURO_QUALIFIERS,
    PriorityInternationalCompetition.UEFA_NATIONS_LEAGUE,
    PriorityInternationalCompetition.CONCACAF_GOLD_CUP,
    PriorityInternationalCompetition.CONCACAF_NATIONS_LEAGUE,
    PriorityInternationalCompetition.AFC_ASIAN_CUP,
  ]);

const INTERNATIONAL_COMPETITION_REGIONS: Record<
  PriorityInternationalCompetition,
  CompetitionRegion
> = {
  [PriorityInternationalCompetition.FIFA_WORLD_CUP]: CompetitionRegion.WORLD,
  [PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS]:
    CompetitionRegion.WORLD,
  [PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS_UEFA]:
    CompetitionRegion.EUROPE,
  [PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS_CAF]:
    CompetitionRegion.AFRICA,
  [PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS_AFC]:
    CompetitionRegion.ASIA,
  [PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS_CONCACAF]:
    CompetitionRegion.NORTH_AMERICA,
  [PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS_CONMEBOL]:
    CompetitionRegion.SOUTH_AMERICA,
  [PriorityInternationalCompetition.FIFA_WOMENS_WORLD_CUP]:
    CompetitionRegion.WORLD,
  [PriorityInternationalCompetition.MENS_OLYMPIC_SOCCER]:
    CompetitionRegion.WORLD,

  [PriorityInternationalCompetition.AFCON]: CompetitionRegion.AFRICA,
  [PriorityInternationalCompetition.AFCON_QUALIFIERS]: CompetitionRegion.AFRICA,

  [PriorityInternationalCompetition.UEFA_EURO]: CompetitionRegion.EUROPE,
  [PriorityInternationalCompetition.UEFA_EURO_QUALIFIERS]:
    CompetitionRegion.EUROPE,
  [PriorityInternationalCompetition.UEFA_NATIONS_LEAGUE]:
    CompetitionRegion.EUROPE,
  [PriorityInternationalCompetition.UEFA_WOMENS_EURO]: CompetitionRegion.EUROPE,

  [PriorityInternationalCompetition.COPA_AMERICA]:
    CompetitionRegion.SOUTH_AMERICA,

  [PriorityInternationalCompetition.CONCACAF_GOLD_CUP]:
    CompetitionRegion.NORTH_AMERICA,
  [PriorityInternationalCompetition.CONCACAF_NATIONS_LEAGUE]:
    CompetitionRegion.NORTH_AMERICA,
  [PriorityInternationalCompetition.CONCACAF_WOMENS_GOLD_CUP]:
    CompetitionRegion.NORTH_AMERICA,

  [PriorityInternationalCompetition.AFC_ASIAN_CUP]: CompetitionRegion.ASIA,
};

const PRIORITY_INTERNATIONAL_COMPETITIONS: SupportedCompetitionConfig[] =
  Object.values(PriorityInternationalCompetition).map((competition) => {
    const priority = ELITE_INTERNATIONAL_COMPETITIONS.has(competition)
      ? CompetitionPriority.ELITE
      : HIGH_INTERNATIONAL_COMPETITIONS.has(competition)
        ? CompetitionPriority.HIGH
        : CompetitionPriority.REGIONAL;

    return buildCompetition(
      competition,
      CompetitionType.INTERNATIONAL,
      INTERNATIONAL_COMPETITION_REGIONS[competition],
      priority,
      {
        seasonal: true,
        gender: WOMENS_INTERNATIONAL_COMPETITIONS.has(competition)
          ? 'WOMEN'
          : 'MEN',
      },
    );
  });

// ============================================================
// COMBINED PRIORITY LIST
// ============================================================

export const PRIORITY_COMPETITIONS: SupportedCompetitionConfig[] = [
  ...PRIORITY_LEAGUES,
  ...PRIORITY_CLUB_COMPETITIONS,
  ...PRIORITY_INTERNATIONAL_COMPETITIONS,
];

export const PRIORITY_COMPETITIONS_BY_ID = new Map(
  PRIORITY_COMPETITIONS.map((competition) => [competition.id, competition]),
);

export function getPriorityCompetition(
  espnLeagueSlug: string,
): SupportedCompetitionConfig | undefined {
  return PRIORITY_COMPETITIONS_BY_ID.get(espnLeagueSlug.trim().toLowerCase());
}

/**
 * Standings collection policy is intentionally separate from fixture and
 * prediction eligibility. A competition can be fully supported for fixtures,
 * odds and predictions without having a conventional league table.
 */
export type EspnStandingsPolicy = 'REQUIRED' | 'OPTIONAL' | 'NONE';

/** Competitions whose format does not publish a conventional standings table. */
const NO_STANDINGS_COMPETITIONS = new Set<string>([
  // Single-match / knockout domestic cups.
  'eng.fa',
  'eng.league_cup',
  'esp.copa_del_rey',
  'ita.coppa_italia',
  'ger.dfb_pokal',
  'fra.coupe_de_france',
  'bra.copa_do_brazil',
  'arg.copa',

  // Knockout-only continental competitions and qualifying rounds.
  'conmebol.recopa',
  'concacaf.champions',
  'uefa.champions_qual',
  'uefa.europa_qual',
  'uefa.europa.conf_qual',
  'uefa.super_cup',
  'fifa.intercontinental_cup',
]);

/**
 * Return the standings policy for an ESPN competition.
 *
 * Unknown competition IDs retain the previous behaviour (required), rather
 * than silently disabling collection for newly discovered ESPN competitions.
 */
export function getEspnStandingsPolicy(
  espnLeagueSlug: string,
): EspnStandingsPolicy {
  const id = espnLeagueSlug.trim().toLowerCase();
  if (NO_STANDINGS_COMPETITIONS.has(id)) return 'NONE';

  const competition = getPriorityCompetition(id);
  if (!competition) return 'REQUIRED';

  // Domestic league tables are expected. Cup, international and continental
  // formats can have season phases where ESPN has not published a table yet.
  return competition.type === CompetitionType.LEAGUE ? 'REQUIRED' : 'OPTIONAL';
}

// ============================================================
// PRIORITY VALIDATION
// ============================================================

export function validatePriorityCompetitions(): void {
  const expectedPriorityCompetitionCount = 106;

  if (PRIORITY_COMPETITIONS.length !== expectedPriorityCompetitionCount) {
    throw new Error(
      `Expected ${expectedPriorityCompetitionCount} priority competitions, found ${PRIORITY_COMPETITIONS.length}`,
    );
  }

  const ids = new Set<string>();

  for (const competition of PRIORITY_COMPETITIONS) {
    if (ids.has(competition.id)) {
      throw new Error(`Duplicate priority competition ID: ${competition.id}`);
    }
    ids.add(competition.id);
  }
}

validatePriorityCompetitions();

