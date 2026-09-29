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
 * The Odds API uses its own sport-key namespace.
 *
 * These values are intentionally NOT derived from ESPN league IDs.
 *
 * Only competitions with a currently documented Odds API sport key
 * are mapped here.
 *
 * Source:
 * The Odds API current sports catalogue.
 */
const ODDS_API_SPORT_KEYS: Record<string, string> = {
  // ----------------------------------------------------------
  // DOMESTIC LEAGUES
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // UEFA CLUB COMPETITIONS
  // ----------------------------------------------------------

  'uefa.champions': 'soccer_uefa_champs_league',

  'uefa.europa': 'soccer_uefa_europa_league',

  'uefa.europa.conf': 'soccer_uefa_europa_conference_league',

  // ----------------------------------------------------------
  // SOUTH AMERICAN CLUB COMPETITIONS
  // ----------------------------------------------------------

  'conmebol.libertadores': 'soccer_conmebol_copa_libertadores',

  'conmebol.sudamericana': 'soccer_conmebol_copa_sudamericana',

  // ----------------------------------------------------------
  // INTERNATIONAL COMPETITIONS
  // ----------------------------------------------------------

  'fifa.world': 'soccer_fifa_world_cup',

  'caf.nations': 'soccer_africa_cup_of_nations',

  'uefa.euro': 'soccer_uefa_european_championship',

  'uefa.euroq': 'soccer_uefa_euro_qualification',

  'uefa.nations': 'soccer_uefa_nations_league',

  'conmebol.america': 'soccer_conmebol_copa_america',

  'concacaf.gold': 'soccer_concacaf_gold_cup',
};

/**
 * Some priority competitions in our catalogue currently do not
 * have a corresponding Odds API sport key in the provider's
 * published sports catalogue.
 *
 * Those competitions intentionally remain:
 *
 *   oddsEnabled = false
 *
 * rather than making an invalid Odds API request.
 *
 * Examples currently without a direct mapping here include:
 *
 * - Nigeria Premier Football League
 * - South African Premiership
 * - CAF Champions League
 * - CAF Confederation Cup
 * - CONCACAF Champions Cup
 * - FIFA World Cup Qualifiers (generic ESPN competition)
 * - AFCON Qualifiers
 * - CONCACAF Nations League
 * - AFC Asian Cup
 */

// ============================================================
// PRIORITY COMPETITION DISPLAY NAMES
// ============================================================

const DISPLAY_NAMES: Record<string, string> = {
  'eng.1': 'Premier League',
  'eng.2': 'Championship',
  'esp.1': 'La Liga',
  'ita.1': 'Serie A',
  'ger.1': 'Bundesliga',
  'fra.1': 'Ligue 1',
  'ned.1': 'Eredivisie',
  'por.1': 'Primeira Liga',
  'sco.1': 'Scottish Premiership',
  'bel.1': 'Belgian Pro League',
  'tur.1': 'Turkish Super Lig',
  'nga.1': 'Nigeria Premier Football League',
  'rsa.1': 'South African Premiership',
  'bra.1': 'Brazilian Serie A',
  'arg.1': 'Argentine Liga Profesional',
  'mex.1': 'Liga MX',
  'usa.1': 'MLS',
  'ksa.1': 'Saudi Pro League',

  'uefa.champions': 'UEFA Champions League',
  'uefa.europa': 'UEFA Europa League',
  'uefa.europa.conf': 'UEFA Conference League',
  'caf.champions': 'CAF Champions League',
  'caf.confed': 'CAF Confederation Cup',
  'conmebol.libertadores': 'Copa Libertadores',
  'conmebol.sudamericana': 'Copa Sudamericana',
  'concacaf.champions': 'CONCACAF Champions Cup',

  'fifa.world': 'FIFA World Cup',
  'fifa.worldq': 'FIFA World Cup Qualifiers',
  'caf.nations': 'Africa Cup of Nations',
  'caf.nations_qual': 'Africa Cup of Nations Qualifiers',
  'uefa.euro': 'UEFA European Championship',
  'uefa.euroq': 'UEFA European Championship Qualifiers',
  'uefa.nations': 'UEFA Nations League',
  'conmebol.america': 'Copa America',
  'concacaf.gold': 'CONCACAF Gold Cup',
  'concacaf.nations.league': 'CONCACAF Nations League',
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

  return code
    ? {
        footballDataCode: code,
      }
    : {};
}

function getOddsApiMapping(espnLeagueSlug: string): {
  oddsApiSportKey?: string;
} {
  const sportKey = ODDS_API_SPORT_KEYS[espnLeagueSlug];

  return sportKey
    ? {
        oddsApiSportKey: sportKey,
      }
    : {};
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

  /*
   * Odds are only enabled when there is an actual Odds API
   * sport key available, unless the caller explicitly overrides
   * oddsEnabled.
   */
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

      ...(oddsApiSportKey
        ? {
            oddsApiSportKey,
          }
        : {}),

      /**
       * ESPN is now the canonical competition provider.
       */
      espnLeagueSlug,
    },

    seasonal: options?.seasonal ?? false,

    gender: options?.gender ?? 'MEN',

    notes: options?.notes,
  };
}

// ============================================================
// PRIORITY LEAGUES
// ============================================================

const PRIORITY_LEAGUES: SupportedCompetitionConfig[] = [
  ...Object.values(PriorityLeague).map((league) => {
    const eliteLeagues = new Set<string>([
      PriorityLeague.PREMIER_LEAGUE,
      PriorityLeague.LA_LIGA,
      PriorityLeague.SERIE_A,
      PriorityLeague.BUNDESLIGA,
      PriorityLeague.LIGUE_1,
    ]);

    const highLeagues = new Set<string>([
      PriorityLeague.CHAMPIONSHIP,
      PriorityLeague.EREDIVISIE,
      PriorityLeague.PRIMEIRA_LIGA,
      PriorityLeague.SCOTTISH_PREMIERSHIP,
      PriorityLeague.BELGIAN_PRO_LEAGUE,
      PriorityLeague.TURKISH_SUPER_LIG,
      PriorityLeague.NPFL,
      PriorityLeague.SOUTH_AFRICA_PREMIER_DIVISION,
      PriorityLeague.BRAZIL_SERIE_A,
      PriorityLeague.ARGENTINA_PRIMERA,
      PriorityLeague.LIGA_MX,
      PriorityLeague.MLS,
      PriorityLeague.SAUDI_PRO_LEAGUE,
    ]);

    const region =
      league === PriorityLeague.NPFL
        ? CompetitionRegion.NIGERIA
        : league === PriorityLeague.SOUTH_AFRICA_PREMIER_DIVISION
          ? CompetitionRegion.AFRICA
          : league === PriorityLeague.BRAZIL_SERIE_A ||
              league === PriorityLeague.ARGENTINA_PRIMERA
            ? CompetitionRegion.SOUTH_AMERICA
            : league === PriorityLeague.LIGA_MX || league === PriorityLeague.MLS
              ? CompetitionRegion.NORTH_AMERICA
              : league === PriorityLeague.SAUDI_PRO_LEAGUE
                ? CompetitionRegion.ASIA
                : CompetitionRegion.EUROPE;

    const priority = eliteLeagues.has(league)
      ? CompetitionPriority.ELITE
      : highLeagues.has(league)
        ? CompetitionPriority.HIGH
        : CompetitionPriority.REGIONAL;

    return buildCompetition(league, CompetitionType.LEAGUE, region, priority);
  }),
];

// ============================================================
// PRIORITY CLUB COMPETITIONS
// ============================================================

const PRIORITY_CLUB_COMPETITIONS: SupportedCompetitionConfig[] = Object.values(
  PriorityClubCompetition,
).map((competition) => {
  const african =
    competition === PriorityClubCompetition.CAF_CHAMPIONS_LEAGUE ||
    competition === PriorityClubCompetition.CAF_CONFEDERATION_CUP;

  const southAmerican =
    competition === PriorityClubCompetition.COPA_LIBERTADORES ||
    competition === PriorityClubCompetition.COPA_SUDAMERICANA;

  const northAmerican =
    competition === PriorityClubCompetition.CONCACAF_CHAMPIONS_CUP;

  const elite =
    competition === PriorityClubCompetition.UEFA_CHAMPIONS_LEAGUE ||
    competition === PriorityClubCompetition.CAF_CHAMPIONS_LEAGUE ||
    competition === PriorityClubCompetition.COPA_LIBERTADORES;

  return buildCompetition(
    competition,
    CompetitionType.CLUB_COMPETITION,
    african
      ? CompetitionRegion.AFRICA
      : southAmerican
        ? CompetitionRegion.SOUTH_AMERICA
        : northAmerican
          ? CompetitionRegion.NORTH_AMERICA
          : CompetitionRegion.EUROPE,
    elite ? CompetitionPriority.ELITE : CompetitionPriority.HIGH,
    {
      seasonal: true,
    },
  );
});

// ============================================================
// PRIORITY INTERNATIONAL COMPETITIONS
// ============================================================

const PRIORITY_INTERNATIONAL_COMPETITIONS: SupportedCompetitionConfig[] =
  Object.values(PriorityInternationalCompetition).map((competition) => {
    const african =
      competition === PriorityInternationalCompetition.AFCON ||
      competition === PriorityInternationalCompetition.AFCON_QUALIFIERS;

    const southAmerican =
      competition === PriorityInternationalCompetition.COPA_AMERICA;

    const northAmerican =
      competition === PriorityInternationalCompetition.CONCACAF_GOLD_CUP ||
      competition === PriorityInternationalCompetition.CONCACAF_NATIONS_LEAGUE;

    const asian =
      competition === PriorityInternationalCompetition.AFC_ASIAN_CUP;

    const elite =
      competition === PriorityInternationalCompetition.FIFA_WORLD_CUP ||
      competition ===
        PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS ||
      competition === PriorityInternationalCompetition.AFCON;

    return buildCompetition(
      competition,
      CompetitionType.INTERNATIONAL,
      african
        ? CompetitionRegion.AFRICA
        : southAmerican
          ? CompetitionRegion.SOUTH_AMERICA
          : northAmerican
            ? CompetitionRegion.NORTH_AMERICA
            : asian
              ? CompetitionRegion.ASIA
              : CompetitionRegion.WORLD,
      elite ? CompetitionPriority.ELITE : CompetitionPriority.HIGH,
      {
        seasonal: true,
      },
    );
  });

// ============================================================
// PRIORITY COMPETITIONS
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

// ============================================================
// PRIORITY VALIDATION
// ============================================================

export function validatePriorityCompetitions(): void {
  const expectedPriorityCompetitionCount = 37;

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
