import { PriorityClubCompetition } from './priority-club-competition.enum';
import { PriorityInternationalCompetition } from './priority-international-competition.enum';
import { PriorityLeague } from './priority-league.enum';
import { YOUTUBE_CONFIG } from '../config/youtube.config';

/**
 * YouTube channels used for fixture highlight collection.
 *
 * A value may be either a YouTube channel ID (UC...) or a YouTube handle
 * (@channel). Handles are resolved to channel IDs by YoutubeService and then
 * used in the YouTube Data API search request.
 *
 * The registry is deliberately data-only. It never decides whether a video is
 * a valid highlight; YoutubeService must still validate the match, title, and
 * publication window before a result is saved.
 */
export enum OfficialYoutubeChannel {
  // Competition and league channels with stable, known channel IDs.
  PREMIER_LEAGUE = 'UCG5qGWdu8nIRZqJ_GgDwQ-w',
  EFL = 'UCCmo_NIuQR5eU4AvBa6sEQQ',
  LA_LIGA = 'UCTv-XvfzLX3i4IGWAm4sbmA',
  SERIE_A = 'UCBJeMCIeLQos7wacox4hmLQ',
  BUNDESLIGA = 'UC6UL29enLNe4mqwTfAyeNuw',
  LIGUE_1 = 'UC58LMAlfwtGRNR6Xpd4DlSA',
  EREDIVISIE = 'UCxyoiD-bwrmapdivXCFvmaw',
  SCOTTISH_PREMIERSHIP_SPFL = 'UCakRszbIjjGYtFrDPeg5Ieg',
  BELGIAN_PRO_LEAGUE = 'UCZYeLruZnUvYvO6QRTiy88Q',
  LIGA_MX = 'UCq8BPLXtFeiSFOvmJrknWGg',
  MLS = 'UCSZbXT5TLLW_i-5W8FZpFsg',
  SAUDI_PRO_LEAGUE = 'UCqXAWrjSgLb0EPa_icPt-pw',
  FIFA = 'UCpcTrCXblq78GZrTUTLWeBw',
  UEFA = 'UCyGa1YEx9ST66rYrJTGIKOw',
  AFC_ASIAN_CUP = 'UCXTRFt1vLvZpahQtiKJjLaQ',
  NPFL_CENTER = 'UCKTdgZGovXp1D2pdu-G7taQ',
  BRAZILIAN_FOOTBALL_CONFEDERATION = 'UCdQuDaRww5NkKpQQ1BJBWww',
  GREEK_SUPER_LEAGUE = 'UCxpjixPAcuyPU2tYwc47U6Q',
  AUSTRIAN_BUNDESLIGA = 'UC87n-RtXJeQJUUZt2gH_qsw',
  LEAGUE_OF_IRELAND = 'UCCb0qGaI_NAl7SGPx5xXQdg',
  PERU_LIGA1_MAX = 'UCGVHVLD7Nzw0zdIwbVhE3vw',
  GHANA_FOOTBALL_ASSOCIATION = '@GhanaFootballAssociation',
  URUGUAY_FOOTBALL_ASSOCIATION = '@aufoficial',
  VENEZUELA_LIGA_FUTVE = '@ligafutve',
  USL = '@USL',
  NORWEGIAN_ELITESERIEN = '@Eliteserien',
  RUSSIAN_PREMIER_LEAGUE = '@premierliga',

  // Additional official competition channels resolved through YouTube handles.
  PORTUGAL_LIGA = '@LigaPortugal',
  INDIAN_SUPER_LEAGUE = '@IndianSuperLeague',
  J_LEAGUE = '@JLEAGUEInternational',
  AUSTRALIAN_A_LEAGUE = '@aleague',
  CONCACAF = '@Concacaf',
  CONMEBOL = '@CONMEBOL',
  CAF = '@CAF_TV',
  SOUTH_AFRICA_PSL = '@PSL_TV',
  ARGENTINA_FOOTBALL_ASSOCIATION = '@afaoficial',

  // Official club channels. These handles are resolved lazily and cached.
  ARSENAL = '@arsenal',
  ASTON_VILLA = '@avfcofficial',
  BOURNEMOUTH = '@AFCBournemouth',
  BRENTFORD = '@BrentfordFC',
  BRIGHTON = '@officialbhafc',
  BURNLEY = '@burnleyofficial',
  CHELSEA = '@chelseafc',
  CRYSTAL_PALACE = '@OfficialCPFC',
  EVERTON = '@Everton',
  FULHAM = '@fulhamfc',
  IPSWICH_TOWN = '@IpswichTown',
  LEEDS_UNITED = '@LeedsUnited',
  LIVERPOOL = '@LiverpoolFC',
  MANCHESTER_CITY = '@mancity',
  MANCHESTER_UNITED = '@manutd',
  MIDDLESBROUGH = '@MiddlesbroughFC',
  NEWCASTLE_UNITED = '@NUFC',
  NOTTINGHAM_FOREST = '@NottinghamForestFC',
  SOUTHAMPTON = '@SouthamptonFC',
  SUNDERLAND = '@SunderlandAFC',
  TOTTENHAM_HOTSPUR = '@TottenhamHotspur',
  WEST_HAM_UNITED = '@westhamunited',
  WOLVES = '@OfficialWolvesVideo',
  WREXHAM = '@WxmAFCofficial',
  CARDIFF_CITY = '@CardiffCityFC',
  HULL_CITY = '@hullcityofficial',
  PORT_VALE = '@OfficialPVFC',
  SALFORD_CITY = '@SalfordCityFootballClub',

  REAL_MADRID = '@realmadrid',
  BARCELONA = '@FCBarcelona',
  ATLETICO_MADRID = '@atleticodemadrid',
  ATHLETIC_CLUB = '@AthleticClubTV',
  REAL_SOCIEDAD = '@realsociedadtv',
  SEVILLA = '@sevillafc',
  VILLARREAL = '@villarrealcf',
  REAL_BETIS = '@RealBetis',
  GIRONA = '@GironaFC',
  VALENCIA = '@valenciacf',
  CELTA_VIGO = '@rccelta',
  LEVANTE = '@LevanteUD',
  GETAFE = '@GetafeCFmedia',
  OSASUNA = '@caosasunatv',
  ESPANYOL = '@rcdespanyol',
  REAL_OVIEDO = '@realoviedo',
  DEPORTIVO_ALAVES = '@deportivoalaves1921',
  RAYO_VALLECANO = '@rayovallecanotv',
  ELCHE = '@ElcheCF',
  ALMERIA = '@udalmeria2001',
  MALLORCA = '@OficialRCDMallorca',

  BAYERN_MUNICH = '@fcbayern',
  BORUSSIA_DORTMUND = '@BVB',
  BAYER_LEVERKUSEN = '@bayerleverkusen',
  RB_LEIPZIG = '@RBLeipzig',
  HOFFENHEIM = '@TSGHoffenheim1899',
  WERDER_BREMEN = '@WerderBremen',
  AUGSBURG = '@fcaugsburg',
  BORUSSIA_MONCHENGLADBACH = '@BorussiaMönchengladbach',
  RB_SALZBURG = '@fcrbs',

  JUVENTUS = '@Juventus',
  AC_MILAN = '@ACMilan',
  INTER_MILAN = '@inter',
  NAPOLI = '@sscnapoli',
  AS_ROMA = '@asroma',
  ATALANTA = '@AtalantaBC',
  FIORENTINA = '@FiorentinaOfficial',
  COMO = '@comofootball',
  PISA = '@PisaSportingClub',
  LECCE = '@uslecceofficial',

  PARIS_SAINT_GERMAIN = '@PSG',
  OLYMPIQUE_MARSEILLE = '@om_officiel',
  AS_MONACO = '@asmonaco',
  LENS = '@rclens',

  BENFICA = '@slbenfica',
  SPORTING_CP = '@SportingCP',
  PORTO = '@FCPorto',
  AJAX = '@AFCAjax',
  PSV_EINDHOVEN = '@psv',
  CLUB_BRUGGE = '@clubbrugge',
  CELTIC = '@CelticFC',
  RANGERS = '@rangersfc',
  BESIKTAS = '@Besiktas',
  FENERBAHCE = '@fenerbahce',
  GALATASARAY = '@Galatasaray',
  OLYMPIACOS = '@olympiacosfc',
  COPENHAGEN = '@FCKobenhavn',
  BODO_GLIMT = '@fkbodglimt7528',
  MIDTJYLLAND = '@fcmidtjylland',
  QARABAG = '@QarabagFK',

  AL_NASSR = '@Nassr',
  AL_HILAL = '@alhilal',
  AL_ITTIHAD = '@ittihadclub',
  AL_AHLI_SAUDI = '@ALAHLI_FC',
  AL_TAAWOUN = '@ALTawenFC',

  INTER_MIAMI = '@intermiamicf',
  ORLANDO_CITY = '@OrlandoCitySC',
  CORINTHIANS = '@corinthians',
  RIVER_PLATE = '@riverplate',
  SANTOS = '@santosfc',
  FLAMENGO = '@flamengo',
  BOCA_JUNIORS = 'UCoATs_f0FZliTQdDOE95gvQ',
  LAFC = '@LAFC',
  NEW_YORK_CITY_FC = '@NewYorkCityFC',
  KAIZER_CHIEFS = '@kaizerchiefsfc',
  MAMELODI_SUNDOWNS = 'UCYgR0z_r45jGNWYXKtY-fSQ',
  KERALA_BLASTERS = '@keralablasters',

  // Four general fallback channels, tried after fixture-specific sources.
  SPORTY_TV = '@sportytvafrica',
  DAZN = 'UCurvRE5fGcdUgCYWgh-BDsg',
  BEIN_SPORTS = 'UCJUCcJUeh0Cz2xyKwkw5Q1w',
  FOX_SOCCER = 'UCooTLkxcpnTNx6vfOovfBFA',
}

/**
 * Four broad football-video fallback channels. Search still validates both
 * teams, highlight-related title evidence, and the fixture publication window.
 */
export const GENERAL_YOUTUBE_HIGHLIGHT_FALLBACKS: readonly OfficialYoutubeChannel[] =
  [
    OfficialYoutubeChannel.SPORTY_TV,
    OfficialYoutubeChannel.DAZN,
    OfficialYoutubeChannel.BEIN_SPORTS,
    OfficialYoutubeChannel.FOX_SOCCER,
  ];

/**
 * Competition channel registry. Entries may be one or more official league,
 * association, or competition channels. Unverified competitions intentionally
 * fall through to team channels, the four general sources, and unrestricted
 * YouTube search instead of using a guessed channel.
 */
const CHANNELS_BY_COMPETITION: Readonly<
  Partial<Record<string, readonly OfficialYoutubeChannel[]>>
> = {
  // Domestic leagues and divisions.
  [PriorityLeague.PREMIER_LEAGUE]: [OfficialYoutubeChannel.PREMIER_LEAGUE],
  [PriorityLeague.CHAMPIONSHIP]: [OfficialYoutubeChannel.EFL],
  [PriorityLeague.ENGLISH_LEAGUE_ONE]: [OfficialYoutubeChannel.EFL],
  [PriorityLeague.ENGLISH_LEAGUE_TWO]: [OfficialYoutubeChannel.EFL],
  [PriorityLeague.LA_LIGA]: [OfficialYoutubeChannel.LA_LIGA],
  [PriorityLeague.SPANISH_SEGUNDA]: [OfficialYoutubeChannel.LA_LIGA],
  [PriorityLeague.SERIE_A]: [OfficialYoutubeChannel.SERIE_A],
  [PriorityLeague.ITALIAN_SERIE_B]: [OfficialYoutubeChannel.SERIE_A],
  [PriorityLeague.BUNDESLIGA]: [OfficialYoutubeChannel.BUNDESLIGA],
  [PriorityLeague.GERMAN_BUNDESLIGA_2]: [OfficialYoutubeChannel.BUNDESLIGA],
  [PriorityLeague.LIGUE_1]: [OfficialYoutubeChannel.LIGUE_1],
  [PriorityLeague.FRENCH_LIGUE_2]: [OfficialYoutubeChannel.LIGUE_1],
  [PriorityLeague.EREDIVISIE]: [OfficialYoutubeChannel.EREDIVISIE],
  [PriorityLeague.DUTCH_EERSTE_DIVISIE]: [OfficialYoutubeChannel.EREDIVISIE],
  [PriorityLeague.PRIMEIRA_LIGA]: [OfficialYoutubeChannel.PORTUGAL_LIGA],
  [PriorityLeague.SCOTTISH_PREMIERSHIP]: [
    OfficialYoutubeChannel.SCOTTISH_PREMIERSHIP_SPFL,
  ],
  [PriorityLeague.SCOTTISH_CHAMPIONSHIP]: [
    OfficialYoutubeChannel.SCOTTISH_PREMIERSHIP_SPFL,
  ],
  [PriorityLeague.BELGIAN_PRO_LEAGUE]: [
    OfficialYoutubeChannel.BELGIAN_PRO_LEAGUE,
  ],
  [PriorityLeague.TURKISH_SUPER_LIG]: [],
  [PriorityLeague.BRAZIL_SERIE_A]: [
    OfficialYoutubeChannel.BRAZILIAN_FOOTBALL_CONFEDERATION,
  ],
  [PriorityLeague.BRAZIL_SERIE_B]: [
    OfficialYoutubeChannel.BRAZILIAN_FOOTBALL_CONFEDERATION,
  ],
  [PriorityLeague.BRAZIL_SERIE_C]: [
    OfficialYoutubeChannel.BRAZILIAN_FOOTBALL_CONFEDERATION,
  ],
  [PriorityLeague.ARGENTINA_PRIMERA]: [
    OfficialYoutubeChannel.ARGENTINA_FOOTBALL_ASSOCIATION,
  ],
  [PriorityLeague.LIGA_MX]: [OfficialYoutubeChannel.LIGA_MX],
  [PriorityLeague.MEXICAN_EXPANSION_MX]: [OfficialYoutubeChannel.LIGA_MX],
  [PriorityLeague.MLS]: [OfficialYoutubeChannel.MLS],
  [PriorityLeague.SAUDI_PRO_LEAGUE]: [OfficialYoutubeChannel.SAUDI_PRO_LEAGUE],
  [PriorityLeague.NPFL]: [OfficialYoutubeChannel.NPFL_CENTER],
  [PriorityLeague.INDIAN_SUPER_LEAGUE]: [
    OfficialYoutubeChannel.INDIAN_SUPER_LEAGUE,
  ],
  [PriorityLeague.JAPANESE_J_LEAGUE]: [OfficialYoutubeChannel.J_LEAGUE],
  [PriorityLeague.AUSTRALIAN_A_LEAGUE]: [
    OfficialYoutubeChannel.AUSTRALIAN_A_LEAGUE,
  ],
  [PriorityLeague.SOUTH_AFRICA_PREMIER_DIVISION]: [
    OfficialYoutubeChannel.SOUTH_AFRICA_PSL,
  ],
  [PriorityLeague.SOUTH_AFRICA_FIRST_DIVISION]: [
    OfficialYoutubeChannel.SOUTH_AFRICA_PSL,
  ],
  [PriorityLeague.GHANAIAN_PREMIER_LEAGUE]: [
    OfficialYoutubeChannel.GHANA_FOOTBALL_ASSOCIATION,
  ],
  [PriorityLeague.ENGLISH_NATIONAL_LEAGUE]: [OfficialYoutubeChannel.DAZN],
  [PriorityLeague.GREEK_SUPER_LEAGUE]: [
    OfficialYoutubeChannel.GREEK_SUPER_LEAGUE,
  ],
  [PriorityLeague.AUSTRIAN_BUNDESLIGA]: [
    OfficialYoutubeChannel.AUSTRIAN_BUNDESLIGA,
  ],
  [PriorityLeague.IRISH_PREMIER_DIVISION]: [
    OfficialYoutubeChannel.LEAGUE_OF_IRELAND,
  ],
  [PriorityLeague.COLOMBIAN_PRIMERA_A]: [],
  [PriorityLeague.CHILEAN_PRIMERA_DIVISION]: [],
  [PriorityLeague.ECUADOR_LIGAPRO]: [],
  [PriorityLeague.URUGUAYAN_PRIMERA_DIVISION]: [
    OfficialYoutubeChannel.URUGUAY_FOOTBALL_ASSOCIATION,
  ],
  [PriorityLeague.PARAGUAYAN_PRIMERA_DIVISION]: [
    OfficialYoutubeChannel.CONMEBOL,
  ],
  [PriorityLeague.PERUVIAN_LIGA_1]: [OfficialYoutubeChannel.PERU_LIGA1_MAX],
  [PriorityLeague.BOLIVIAN_LIGA_PROFESIONAL]: [OfficialYoutubeChannel.CONMEBOL],
  [PriorityLeague.VENEZUELAN_PRIMERA_DIVISION]: [
    OfficialYoutubeChannel.VENEZUELA_LIGA_FUTVE,
  ],
  [PriorityLeague.USL_CHAMPIONSHIP]: [OfficialYoutubeChannel.USL],
  [PriorityLeague.USL_LEAGUE_ONE]: [OfficialYoutubeChannel.USL],
  [PriorityLeague.GUATEMALAN_LIGA_NACIONAL]: [],
  [PriorityLeague.CHINESE_SUPER_LEAGUE]: [],
  [PriorityLeague.THAI_LEAGUE_1]: [],
  [PriorityLeague.MALAYSIAN_SUPER_LEAGUE]: [],
  [PriorityLeague.INDONESIAN_SUPER_LEAGUE]: [],
  [PriorityLeague.SINGAPOREAN_PREMIER_LEAGUE]: [],
  [PriorityLeague.KENYAN_PREMIER_LEAGUE]: [],
  [PriorityLeague.UGANDAN_PREMIER_LEAGUE]: [],
  [PriorityLeague.DANISH_SUPERLIGA]: [],
  [PriorityLeague.NORWEGIAN_ELITESERIEN]: [
    OfficialYoutubeChannel.NORWEGIAN_ELITESERIEN,
  ],
  [PriorityLeague.SWEDISH_ALLSVENSKAN]: [],
  [PriorityLeague.RUSSIAN_PREMIER_LEAGUE]: [
    OfficialYoutubeChannel.RUSSIAN_PREMIER_LEAGUE,
  ],

  // Shared league/federation channels for domestic cups.
  [PriorityClubCompetition.ENGLISH_FA_CUP]: [
    OfficialYoutubeChannel.PREMIER_LEAGUE,
  ],
  [PriorityClubCompetition.ENGLISH_LEAGUE_CUP]: [OfficialYoutubeChannel.EFL],
  [PriorityClubCompetition.SPANISH_COPA_DEL_REY]: [
    OfficialYoutubeChannel.LA_LIGA,
  ],
  [PriorityClubCompetition.ITALIAN_COPPA_ITALIA]: [
    OfficialYoutubeChannel.SERIE_A,
  ],
  [PriorityClubCompetition.GERMAN_DFB_POKAL]: [
    OfficialYoutubeChannel.BUNDESLIGA,
  ],
  [PriorityClubCompetition.FRENCH_COUPE_DE_FRANCE]: [
    OfficialYoutubeChannel.LIGUE_1,
  ],
  [PriorityClubCompetition.BRAZIL_COPA_DO_BRAZIL]: [
    OfficialYoutubeChannel.BRAZILIAN_FOOTBALL_CONFEDERATION,
  ],
  [PriorityClubCompetition.ARGENTINA_COPA]: [
    OfficialYoutubeChannel.ARGENTINA_FOOTBALL_ASSOCIATION,
  ],
  [PriorityClubCompetition.CONCACAF_LEAGUES_CUP]: [OfficialYoutubeChannel.MLS],
  [PriorityClubCompetition.CONMEBOL_RECOPA]: [OfficialYoutubeChannel.CONMEBOL],
  [PriorityClubCompetition.UEFA_SUPER_CUP]: [OfficialYoutubeChannel.UEFA],

  // Continental and global club competitions.
  [PriorityClubCompetition.UEFA_CHAMPIONS_LEAGUE]: [
    OfficialYoutubeChannel.UEFA,
  ],
  [PriorityClubCompetition.UEFA_EUROPA_LEAGUE]: [OfficialYoutubeChannel.UEFA],
  [PriorityClubCompetition.UEFA_CONFERENCE_LEAGUE]: [
    OfficialYoutubeChannel.UEFA,
  ],
  [PriorityClubCompetition.UEFA_CHAMPIONS_LEAGUE_QUALIFYING]: [
    OfficialYoutubeChannel.UEFA,
  ],
  [PriorityClubCompetition.UEFA_EUROPA_LEAGUE_QUALIFYING]: [
    OfficialYoutubeChannel.UEFA,
  ],
  [PriorityClubCompetition.UEFA_CONFERENCE_LEAGUE_QUALIFYING]: [
    OfficialYoutubeChannel.UEFA,
  ],
  [PriorityClubCompetition.CAF_CHAMPIONS_LEAGUE]: [OfficialYoutubeChannel.CAF],
  [PriorityClubCompetition.CAF_CONFEDERATION_CUP]: [OfficialYoutubeChannel.CAF],
  [PriorityClubCompetition.COPA_LIBERTADORES]: [
    OfficialYoutubeChannel.CONMEBOL,
  ],
  [PriorityClubCompetition.COPA_SUDAMERICANA]: [
    OfficialYoutubeChannel.CONMEBOL,
  ],
  [PriorityClubCompetition.CONCACAF_CHAMPIONS_CUP]: [
    OfficialYoutubeChannel.CONCACAF,
  ],
  [PriorityClubCompetition.AFC_CHAMPIONS_LEAGUE_ELITE]: [
    OfficialYoutubeChannel.AFC_ASIAN_CUP,
  ],
  [PriorityClubCompetition.AFC_CHAMPIONS_LEAGUE_TWO]: [
    OfficialYoutubeChannel.AFC_ASIAN_CUP,
  ],
  [PriorityClubCompetition.FIFA_CLUB_WORLD_CUP]: [OfficialYoutubeChannel.FIFA],
  [PriorityClubCompetition.FIFA_INTERCONTINENTAL_CUP]: [
    OfficialYoutubeChannel.FIFA,
  ],

  // International competitions.
  [PriorityInternationalCompetition.FIFA_WORLD_CUP]: [
    OfficialYoutubeChannel.FIFA,
  ],
  [PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS]: [
    OfficialYoutubeChannel.FIFA,
  ],
  [PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS_UEFA]: [
    OfficialYoutubeChannel.FIFA,
  ],
  [PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS_CAF]: [
    OfficialYoutubeChannel.FIFA,
    OfficialYoutubeChannel.CAF,
  ],
  [PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS_AFC]: [
    OfficialYoutubeChannel.FIFA,
    OfficialYoutubeChannel.AFC_ASIAN_CUP,
  ],
  [PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS_CONCACAF]: [
    OfficialYoutubeChannel.FIFA,
    OfficialYoutubeChannel.CONCACAF,
  ],
  [PriorityInternationalCompetition.FIFA_WORLD_CUP_QUALIFIERS_CONMEBOL]: [
    OfficialYoutubeChannel.FIFA,
    OfficialYoutubeChannel.CONMEBOL,
  ],
  [PriorityInternationalCompetition.AFCON]: [OfficialYoutubeChannel.CAF],
  [PriorityInternationalCompetition.AFCON_QUALIFIERS]: [
    OfficialYoutubeChannel.CAF,
  ],
  [PriorityInternationalCompetition.UEFA_EURO]: [OfficialYoutubeChannel.UEFA],
  [PriorityInternationalCompetition.UEFA_EURO_QUALIFIERS]: [
    OfficialYoutubeChannel.UEFA,
  ],
  [PriorityInternationalCompetition.UEFA_NATIONS_LEAGUE]: [
    OfficialYoutubeChannel.UEFA,
  ],
  [PriorityInternationalCompetition.COPA_AMERICA]: [
    OfficialYoutubeChannel.CONMEBOL,
  ],
  [PriorityInternationalCompetition.CONCACAF_GOLD_CUP]: [
    OfficialYoutubeChannel.CONCACAF,
  ],
  [PriorityInternationalCompetition.CONCACAF_NATIONS_LEAGUE]: [
    OfficialYoutubeChannel.CONCACAF,
  ],
  [PriorityInternationalCompetition.AFC_ASIAN_CUP]: [
    OfficialYoutubeChannel.AFC_ASIAN_CUP,
  ],
  [PriorityInternationalCompetition.FIFA_WOMENS_WORLD_CUP]: [
    OfficialYoutubeChannel.FIFA,
  ],
  [PriorityInternationalCompetition.UEFA_WOMENS_EURO]: [
    OfficialYoutubeChannel.UEFA,
  ],
  [PriorityInternationalCompetition.CONCACAF_WOMENS_GOLD_CUP]: [
    OfficialYoutubeChannel.CONCACAF,
  ],
  [PriorityInternationalCompetition.MENS_OLYMPIC_SOCCER]: [
    OfficialYoutubeChannel.FIFA,
  ],
};

/** Team-name aliases mapped to known club-operated YouTube channels. */
const TEAM_CHANNELS_BY_NAME: Readonly<Record<string, OfficialYoutubeChannel>> =
  {
    arsenal: OfficialYoutubeChannel.ARSENAL,
    'arsenal fc': OfficialYoutubeChannel.ARSENAL,
    'aston villa': OfficialYoutubeChannel.ASTON_VILLA,
    'afc bournemouth': OfficialYoutubeChannel.BOURNEMOUTH,
    bournemouth: OfficialYoutubeChannel.BOURNEMOUTH,
    brentford: OfficialYoutubeChannel.BRENTFORD,
    brighton: OfficialYoutubeChannel.BRIGHTON,
    'brighton and hove albion': OfficialYoutubeChannel.BRIGHTON,
    burnley: OfficialYoutubeChannel.BURNLEY,
    chelsea: OfficialYoutubeChannel.CHELSEA,
    'crystal palace': OfficialYoutubeChannel.CRYSTAL_PALACE,
    everton: OfficialYoutubeChannel.EVERTON,
    fulham: OfficialYoutubeChannel.FULHAM,
    'ipswich town': OfficialYoutubeChannel.IPSWICH_TOWN,
    'leeds united': OfficialYoutubeChannel.LEEDS_UNITED,
    leeds: OfficialYoutubeChannel.LEEDS_UNITED,
    liverpool: OfficialYoutubeChannel.LIVERPOOL,
    'manchester city': OfficialYoutubeChannel.MANCHESTER_CITY,
    'man city': OfficialYoutubeChannel.MANCHESTER_CITY,
    'manchester united': OfficialYoutubeChannel.MANCHESTER_UNITED,
    'man utd': OfficialYoutubeChannel.MANCHESTER_UNITED,
    'man united': OfficialYoutubeChannel.MANCHESTER_UNITED,
    'middlesbrough fc': OfficialYoutubeChannel.MIDDLESBROUGH,
    middlesbrough: OfficialYoutubeChannel.MIDDLESBROUGH,
    'newcastle united': OfficialYoutubeChannel.NEWCASTLE_UNITED,
    newcastle: OfficialYoutubeChannel.NEWCASTLE_UNITED,
    'nottingham forest': OfficialYoutubeChannel.NOTTINGHAM_FOREST,
    southampton: OfficialYoutubeChannel.SOUTHAMPTON,
    sunderland: OfficialYoutubeChannel.SUNDERLAND,
    'tottenham hotspur': OfficialYoutubeChannel.TOTTENHAM_HOTSPUR,
    tottenham: OfficialYoutubeChannel.TOTTENHAM_HOTSPUR,
    spurs: OfficialYoutubeChannel.TOTTENHAM_HOTSPUR,
    'west ham united': OfficialYoutubeChannel.WEST_HAM_UNITED,
    'west ham': OfficialYoutubeChannel.WEST_HAM_UNITED,
    wolves: OfficialYoutubeChannel.WOLVES,
    'wolverhampton wanderers': OfficialYoutubeChannel.WOLVES,
    wrexham: OfficialYoutubeChannel.WREXHAM,
    'cardiff city': OfficialYoutubeChannel.CARDIFF_CITY,
    'hull city': OfficialYoutubeChannel.HULL_CITY,
    'port vale': OfficialYoutubeChannel.PORT_VALE,
    'salford city': OfficialYoutubeChannel.SALFORD_CITY,

    'real madrid': OfficialYoutubeChannel.REAL_MADRID,
    'real madrid cf': OfficialYoutubeChannel.REAL_MADRID,
    barcelona: OfficialYoutubeChannel.BARCELONA,
    'fc barcelona': OfficialYoutubeChannel.BARCELONA,
    'atletico madrid': OfficialYoutubeChannel.ATLETICO_MADRID,
    'atletico de madrid': OfficialYoutubeChannel.ATLETICO_MADRID,
    'athletic club': OfficialYoutubeChannel.ATHLETIC_CLUB,
    'athletic bilbao': OfficialYoutubeChannel.ATHLETIC_CLUB,
    'real sociedad': OfficialYoutubeChannel.REAL_SOCIEDAD,
    sevilla: OfficialYoutubeChannel.SEVILLA,
    'sevilla fc': OfficialYoutubeChannel.SEVILLA,
    villarreal: OfficialYoutubeChannel.VILLARREAL,
    'real betis': OfficialYoutubeChannel.REAL_BETIS,
    'girona fc': OfficialYoutubeChannel.GIRONA,
    girona: OfficialYoutubeChannel.GIRONA,
    'valencia cf': OfficialYoutubeChannel.VALENCIA,
    valencia: OfficialYoutubeChannel.VALENCIA,
    'celta vigo': OfficialYoutubeChannel.CELTA_VIGO,
    'celta de vigo': OfficialYoutubeChannel.CELTA_VIGO,
    levante: OfficialYoutubeChannel.LEVANTE,
    getafe: OfficialYoutubeChannel.GETAFE,
    osasuna: OfficialYoutubeChannel.OSASUNA,
    espanyol: OfficialYoutubeChannel.ESPANYOL,
    'real oviedo': OfficialYoutubeChannel.REAL_OVIEDO,
    'deportivo alaves': OfficialYoutubeChannel.DEPORTIVO_ALAVES,
    'rayo vallecano': OfficialYoutubeChannel.RAYO_VALLECANO,
    elche: OfficialYoutubeChannel.ELCHE,
    almeria: OfficialYoutubeChannel.ALMERIA,
    mallorca: OfficialYoutubeChannel.MALLORCA,

    'bayern munich': OfficialYoutubeChannel.BAYERN_MUNICH,
    'bayern munchen': OfficialYoutubeChannel.BAYERN_MUNICH,
    bayern: OfficialYoutubeChannel.BAYERN_MUNICH,
    'borussia dortmund': OfficialYoutubeChannel.BORUSSIA_DORTMUND,
    dortmund: OfficialYoutubeChannel.BORUSSIA_DORTMUND,
    'bayer leverkusen': OfficialYoutubeChannel.BAYER_LEVERKUSEN,
    'rb leipzig': OfficialYoutubeChannel.RB_LEIPZIG,
    hoffenheim: OfficialYoutubeChannel.HOFFENHEIM,
    'werder bremen': OfficialYoutubeChannel.WERDER_BREMEN,
    augsburg: OfficialYoutubeChannel.AUGSBURG,
    'borussia monchengladbach': OfficialYoutubeChannel.BORUSSIA_MONCHENGLADBACH,
    'rb salzburg': OfficialYoutubeChannel.RB_SALZBURG,

    juventus: OfficialYoutubeChannel.JUVENTUS,
    'ac milan': OfficialYoutubeChannel.AC_MILAN,
    milan: OfficialYoutubeChannel.AC_MILAN,
    inter: OfficialYoutubeChannel.INTER_MILAN,
    'inter milan': OfficialYoutubeChannel.INTER_MILAN,
    napoli: OfficialYoutubeChannel.NAPOLI,
    roma: OfficialYoutubeChannel.AS_ROMA,
    'as roma': OfficialYoutubeChannel.AS_ROMA,
    atalanta: OfficialYoutubeChannel.ATALANTA,
    fiorentina: OfficialYoutubeChannel.FIORENTINA,
    como: OfficialYoutubeChannel.COMO,
    pisa: OfficialYoutubeChannel.PISA,
    lecce: OfficialYoutubeChannel.LECCE,

    psg: OfficialYoutubeChannel.PARIS_SAINT_GERMAIN,
    'paris saint germain': OfficialYoutubeChannel.PARIS_SAINT_GERMAIN,
    'paris saint-germain': OfficialYoutubeChannel.PARIS_SAINT_GERMAIN,
    marseille: OfficialYoutubeChannel.OLYMPIQUE_MARSEILLE,
    'olympique marseille': OfficialYoutubeChannel.OLYMPIQUE_MARSEILLE,
    monaco: OfficialYoutubeChannel.AS_MONACO,
    'as monaco': OfficialYoutubeChannel.AS_MONACO,
    lens: OfficialYoutubeChannel.LENS,

    benfica: OfficialYoutubeChannel.BENFICA,
    'sporting cp': OfficialYoutubeChannel.SPORTING_CP,
    'sporting lisbon': OfficialYoutubeChannel.SPORTING_CP,
    porto: OfficialYoutubeChannel.PORTO,
    ajax: OfficialYoutubeChannel.AJAX,
    'psv eindhoven': OfficialYoutubeChannel.PSV_EINDHOVEN,
    psv: OfficialYoutubeChannel.PSV_EINDHOVEN,
    'club brugge': OfficialYoutubeChannel.CLUB_BRUGGE,
    celtic: OfficialYoutubeChannel.CELTIC,
    rangers: OfficialYoutubeChannel.RANGERS,
    besiktas: OfficialYoutubeChannel.BESIKTAS,
    fenerbahce: OfficialYoutubeChannel.FENERBAHCE,
    galatasaray: OfficialYoutubeChannel.GALATASARAY,
    olympiacos: OfficialYoutubeChannel.OLYMPIACOS,
    copenhagen: OfficialYoutubeChannel.COPENHAGEN,
    'fc copenhagen': OfficialYoutubeChannel.COPENHAGEN,
    'bodo glimt': OfficialYoutubeChannel.BODO_GLIMT,
    midtjylland: OfficialYoutubeChannel.MIDTJYLLAND,
    qarabag: OfficialYoutubeChannel.QARABAG,

    'al nassr': OfficialYoutubeChannel.AL_NASSR,
    'al-nassr': OfficialYoutubeChannel.AL_NASSR,
    'al hilal': OfficialYoutubeChannel.AL_HILAL,
    'al-hilal': OfficialYoutubeChannel.AL_HILAL,
    'al ittihad': OfficialYoutubeChannel.AL_ITTIHAD,
    'al-ittihad': OfficialYoutubeChannel.AL_ITTIHAD,
    'al ahli': OfficialYoutubeChannel.AL_AHLI_SAUDI,
    'al-ahli': OfficialYoutubeChannel.AL_AHLI_SAUDI,
    'al taawoun': OfficialYoutubeChannel.AL_TAAWOUN,
    'al-taawoun': OfficialYoutubeChannel.AL_TAAWOUN,

    'inter miami': OfficialYoutubeChannel.INTER_MIAMI,
    'orlando city': OfficialYoutubeChannel.ORLANDO_CITY,
    corinthians: OfficialYoutubeChannel.CORINTHIANS,
    'river plate': OfficialYoutubeChannel.RIVER_PLATE,
    santos: OfficialYoutubeChannel.SANTOS,
    flamengo: OfficialYoutubeChannel.FLAMENGO,
    'boca juniors': OfficialYoutubeChannel.BOCA_JUNIORS,
    'boca juniors fc': OfficialYoutubeChannel.BOCA_JUNIORS,
    lafc: OfficialYoutubeChannel.LAFC,
    'los angeles fc': OfficialYoutubeChannel.LAFC,
    'new york city fc': OfficialYoutubeChannel.NEW_YORK_CITY_FC,
    nycfc: OfficialYoutubeChannel.NEW_YORK_CITY_FC,
    'kaizer chiefs': OfficialYoutubeChannel.KAIZER_CHIEFS,
    'mamelodi sundowns': OfficialYoutubeChannel.MAMELODI_SUNDOWNS,
    'kerala blasters': OfficialYoutubeChannel.KERALA_BLASTERS,
  };

function normalizeCompetitionId(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeTeamName(value?: string): string | undefined {
  const normalized = value
    ?.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(fc|cf|afc|sc|ac|fk|club)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || undefined;
}

function getTeamChannel(teamName?: string): OfficialYoutubeChannel | undefined {
  const normalized = normalizeTeamName(teamName);
  if (!normalized) return undefined;

  // Try the normalized name first, then common abbreviations that survive
  // ESPN's differing display-name formats.
  return (
    TEAM_CHANNELS_BY_NAME[normalized] ??
    TEAM_CHANNELS_BY_NAME[
      normalized.replace(/\bman utd\b/g, 'manchester united')
    ] ??
    TEAM_CHANNELS_BY_NAME[
      normalized.replace(/\bman city\b/g, 'manchester city')
    ]
  );
}

/**
 * Returns the ordered, per-fixture search plan:
 * competition channel(s) → home/away club channel(s) → four fallbacks → broad search.
 * Duplicate channels are removed and the plan is capped by the configured request limit.
 */
export function getYoutubeHighlightSearchPlan(
  competitionId?: string,
  homeTeam?: string,
  awayTeam?: string,
): readonly (OfficialYoutubeChannel | null)[] {
  const normalizedCompetitionId = normalizeCompetitionId(competitionId);
  const competitionChannels = normalizedCompetitionId
    ? (CHANNELS_BY_COMPETITION[normalizedCompetitionId] ?? [])
    : [];
  const teamChannels = [
    getTeamChannel(homeTeam),
    getTeamChannel(awayTeam),
  ].filter((channel): channel is OfficialYoutubeChannel => Boolean(channel));
  const fallbacks = GENERAL_YOUTUBE_HIGHLIGHT_FALLBACKS.slice(
    0,
    YOUTUBE_CONFIG.searchWorkflow.maximumFallbackChannels,
  );

  const configuredChannels = [
    ...competitionChannels,
    ...teamChannels,
    ...fallbacks,
  ];
  const seen = new Set<OfficialYoutubeChannel>();
  const uniqueChannels = configuredChannels.filter((channel) => {
    if (seen.has(channel)) return false;
    seen.add(channel);
    return true;
  });

  const maximumConfiguredChannels = Math.max(
    0,
    YOUTUBE_CONFIG.searchWorkflow.maximumRequestsPerFixture - 1,
  );
  return [...uniqueChannels.slice(0, maximumConfiguredChannels), null];
}

/**
 * Returns configured, unique channel references for a fixture without adding
 * the unrestricted-search stage. Some entries are handles until resolved by
 * YoutubeService; direct IDs are returned unchanged.
 */
export function getYoutubeHighlightChannelIds(
  competitionId?: string,
  homeTeam?: string,
  awayTeam?: string,
): readonly OfficialYoutubeChannel[] {
  return getYoutubeHighlightSearchPlan(
    competitionId,
    homeTeam,
    awayTeam,
  ).filter((channel): channel is OfficialYoutubeChannel => channel !== null);
}

