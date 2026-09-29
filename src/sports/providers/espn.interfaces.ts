// ============================================================
// ESPN API RESPONSE
// ============================================================

export interface EspnApiResponse<T = unknown> {
  count?: number;

  pageIndex?: number;

  pageSize?: number;

  pageCount?: number;

  items?: EspnReferenceItem[];

  leagues?: EspnLeague[];

  events?: EspnEvent[];

  season?: EspnSeason;

  day?: EspnDay;

  [key: string]: unknown;
}

// ============================================================
// ESPN FIXTURE PAYLOAD
// ============================================================

/**
 * Complete ESPN match/fixture object persisted inside
 * sports_espn_fixtures.payload.
 */
export interface EspnFixturePayload extends EspnEvent {
  status?: EspnCompetitionStatus;

  venue?: EspnVenue;

  summary?: EspnMatchSummary;

  [key: string]: unknown;
}

// ============================================================
// ESPN MATCH SUMMARY
// ============================================================

/**
 * Full detailed ESPN match Summary response persisted inside
 * sports_espn_fixtures.payload.summary.
 */
export interface EspnMatchSummary {
  boxscore?: EspnBoxscore;

  format?: EspnMatchFormat;

  gameInfo?: EspnGameInfo;

  lastFiveGames?: EspnLastFiveGameTeam[];

  leaders?: EspnMatchLeaderTeam[];

  broadcasts?: EspnBroadcast[];

  pickcenter?: EspnPickCenter[];

  odds?: EspnOdds[];

  hasOdds?: boolean;

  rosters?: EspnMatchRosterTeam[];

  news?: EspnMatchNews;

  seasonseries?: EspnSeasonSeries[];

  videos?: EspnVideo[];

  header?: EspnMatchHeader;

  keyEvents?: EspnKeyEvent[];

  commentary?: EspnCommentaryItem[];

  wallclockAvailable?: boolean;

  meta?: EspnMatchMeta;

  standings?: EspnSummaryStandings;

  [key: string]: unknown;
}

// ============================================================
// ESPN REFERENCE
// ============================================================

export interface EspnReferenceItem {
  $ref?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN LEAGUE
// ============================================================

export interface EspnLeague {
  id?: string;

  uid?: string;

  name?: string;

  abbreviation?: string;

  shortName?: string;

  displayName?: string;

  slug?: string;

  country?: {
    id?: string;

    name?: string;

    abbreviation?: string;

    slug?: string;

    [key: string]: unknown;
  };

  type?: {
    id?: string;

    name?: string;

    abbreviation?: string;

    slug?: string;

    [key: string]: unknown;
  };

  season?: EspnSeason;

  seasons?: EspnSeason[];

  logos?: EspnLogo[];

  links?: EspnLink[];

  $ref?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN SEASON
// ============================================================

export interface EspnSeason {
  year?: number;

  displayName?: string;

  startDate?: string;

  endDate?: string;

  slug?: string;

  type?: EspnSeasonType;

  [key: string]: unknown;
}

// ============================================================
// ESPN SEASON TYPE
// ============================================================

export interface EspnSeasonType {
  id?: string;

  type?: string;

  name?: string;

  abbreviation?: string;

  startDate?: string;

  endDate?: string;

  slug?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN DAY
// ============================================================

export interface EspnDay {
  date?: string;

  number?: number;

  [key: string]: unknown;
}

// ============================================================
// ESPN LOGO
// ============================================================

export interface EspnLogo {
  href?: string;

  width?: number;

  height?: number;

  alt?: string;

  rel?: string[];

  lastUpdated?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN IMAGE
// ============================================================

export interface EspnImage {
  href?: string;

  width?: number;

  height?: number;

  alt?: string;

  rel?: string[];

  source?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN LINK
// ============================================================

export interface EspnLink {
  href?: string;

  text?: string;

  shortText?: string;

  rel?: string[];

  isExternal?: boolean;

  isPremium?: boolean;

  isAffiliate?: boolean;

  [key: string]: unknown;
}

// ============================================================
// ESPN EVENT
// ============================================================

export interface EspnEvent {
  id: string;

  uid?: string;

  date?: string;

  name?: string;

  shortName?: string;

  timeValid?: boolean;

  season?: EspnSeason;

  seasonType?: EspnSeasonType;

  competitions?: EspnCompetition[];

  links?: EspnLink[];

  league?: EspnLeague;

  [key: string]: unknown;
}

// ============================================================
// ESPN COMPETITION
// ============================================================

export interface EspnCompetition {
  id: string;

  uid?: string;

  date?: string;

  startDate?: string;

  attendance?: number;

  timeValid?: boolean;

  recent?: boolean;

  status?: EspnCompetitionStatus;

  venue?: EspnVenue;

  format?: EspnFormat;

  notes?: EspnNote[];

  broadcasts?: EspnBroadcast[];

  competitors?: EspnCompetitor[];

  details?: EspnEventDetail[];

  leaders?: EspnLeader[];

  odds?: EspnOdds[];

  links?: EspnLink[];

  [key: string]: unknown;
}

// ============================================================
// ESPN COMPETITION STATUS
// ============================================================

export interface EspnCompetitionStatus {
  clock?: number;

  displayClock?: string;

  period?: number;

  type?: EspnStatusType;

  [key: string]: unknown;
}

// ============================================================
// ESPN STATUS TYPE
// ============================================================

export interface EspnStatusType {
  id?: string;

  name?: string;

  state?: string;

  completed?: boolean;

  description?: string;

  detail?: string;

  shortDetail?: string;

  abbreviation?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN VENUE
// ============================================================

export interface EspnVenue {
  id?: string;

  fullName?: string;

  shortName?: string;

  address?: {
    city?: string;

    state?: string;

    country?: string;

    countryCode?: string;

    zipCode?: string;

    [key: string]: unknown;
  };

  capacity?: number;

  indoor?: boolean;

  grass?: boolean;

  images?: EspnImage[];

  [key: string]: unknown;
}

// ============================================================
// ESPN FORMAT
// ============================================================

export interface EspnFormat {
  regulation?:
    | number
    | {
        periods?: number;

        displayName?: string;

        slug?: string;

        clock?: number;

        [key: string]: unknown;
      };

  overtime?: boolean;

  periods?: number;

  displayName?: string;

  slug?: string;

  clock?: number;

  [key: string]: unknown;
}

// ============================================================
// ESPN MATCH FORMAT
// ============================================================

export interface EspnMatchFormat {
  regulation?: {
    periods?: number;

    displayName?: string;

    slug?: string;

    clock?: number;

    [key: string]: unknown;
  };

  overtime?: boolean;

  [key: string]: unknown;
}

// ============================================================
// ESPN BROADCAST
// ============================================================

export interface EspnBroadcast {
  id?: string;

  market?: string;

  names?: string[];

  type?: {
    id?: string;

    shortName?: string;

    [key: string]: unknown;
  };

  media?: {
    callLetters?: string;

    name?: string;

    shortName?: string;

    [key: string]: unknown;
  };

  language?: string;

  region?: string;

  national?: boolean;

  [key: string]: unknown;
}

// ============================================================
// ESPN NOTE
// ============================================================

export interface EspnNote {
  headline?: string;

  type?: string;

  text?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN COMPETITOR
// ============================================================

export interface EspnCompetitor {
  id?: string;

  uid?: string;

  type?: string;

  order?: number;

  homeAway?: 'home' | 'away';

  winner?: boolean;

  form?: string;

  score?: string | number;

  records?: EspnTeamRecord[];

  team?: EspnTeam;

  statistics?: EspnTeamMatchStatistic[];

  [key: string]: unknown;
}

// ============================================================
// ESPN TEAM
// ============================================================

export interface EspnTeam {
  id?: string;

  uid?: string;

  slug?: string;

  abbreviation?: string;

  displayName?: string;

  shortDisplayName?: string;

  name?: string;

  nickname?: string;

  location?: string;

  color?: string;

  alternateColor?: string;

  logo?: string;

  logos?: EspnLogo[];

  isActive?: boolean;

  venue?: EspnTeamVenue;

  links?: EspnLink[];

  record?: EspnTeamRecord[];

  groups?: unknown[];

  form?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN TEAM VENUE
// ============================================================

export interface EspnTeamVenue {
  id?: string;

  fullName?: string;

  address?: {
    city?: string;

    state?: string;

    country?: string;

    [key: string]: unknown;
  };

  capacity?: number;

  indoor?: boolean;

  grass?: boolean;

  images?: EspnImage[];

  [key: string]: unknown;
}

// ============================================================
// ESPN TEAM RECORD
// ============================================================

export interface EspnTeamRecord {
  id?: string;

  name?: string;

  abbreviation?: string;

  type?: string;

  summary?: string;

  displayValue?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN TEAM MATCH STATISTICS
// ============================================================

export interface EspnTeamMatchStatistic {
  name?: string;

  displayName?: string;

  shortDisplayName?: string;

  description?: string;

  abbreviation?: string;

  value?: number | string;

  displayValue?: string;

  rank?: number;

  [key: string]: unknown;
}

// ============================================================
// ESPN MATCH DETAIL
// ============================================================

export interface EspnMatchDetail {
  id?: string;

  type?: string;

  text?: string;

  abbreviation?: string;

  clock?: EspnClock;

  team?: EspnTeam;

  athlete?: EspnAthlete;

  participants?: EspnAthlete[];

  scoreValue?: number;

  shootingPlayer?: EspnAthlete;

  assist?: EspnAthlete;

  [key: string]: unknown;
}

// ============================================================
// ESPN CLOCK
// ============================================================

export interface EspnClock {
  value?: number;

  displayValue?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN ATHLETE
// ============================================================

export interface EspnAthlete {
  id?: string;

  uid?: string;

  guid?: string;

  displayName?: string;

  shortName?: string;

  fullName?: string;

  firstName?: string;

  lastName?: string;

  jersey?: string;

  position?: {
    id?: string;

    name?: string;

    abbreviation?: string;

    [key: string]: unknown;
  };

  team?: EspnTeam;

  links?: EspnLink[];

  status?: {
    id?: string;

    name?: string;

    type?: string;

    abbreviation?: string;

    [key: string]: unknown;
  };

  [key: string]: unknown;
}

// ============================================================
// ESPN EVENT DETAIL
// ============================================================

export interface EspnEventDetail {
  id?: string;

  text?: string;

  type?: string;

  team?: EspnTeam;

  athlete?: EspnAthlete;

  clock?: EspnClock;

  scoringPlay?: boolean;

  redCard?: boolean;

  yellowCard?: boolean;

  penaltyKick?: boolean;

  ownGoal?: boolean;

  participants?: EspnAthlete[];

  [key: string]: unknown;
}

// ============================================================
// ESPN STANDINGS RESPONSE
// ============================================================

export interface EspnStandingsResponse {
  uid?: string;

  name?: string;

  abbreviation?: string;

  season?: EspnSeason;

  seasonType?: EspnSeasonType;

  fullViewLink?: EspnLink;

  children?: EspnStandingsGroup[];

  standings?: EspnStandingsContainer;

  [key: string]: unknown;
}

// ============================================================
// ESPN STANDINGS GROUP
// ============================================================

export interface EspnStandingsGroup {
  id?: string;

  uid?: string;

  name?: string;

  abbreviation?: string;

  standings?: EspnStandingsContainer;

  children?: EspnStandingsGroup[];

  [key: string]: unknown;
}

// ============================================================
// ESPN STANDINGS CONTAINER
// ============================================================

export interface EspnStandingsContainer {
  entries?: EspnStandingEntry[];

  [key: string]: unknown;
}

// ============================================================
// ESPN STANDING ENTRY
// ============================================================

export interface EspnStandingEntry {
  team?: EspnTeam;

  note?: {
    color?: string;

    description?: string;

    rank?: number;

    [key: string]: unknown;
  };

  stats?: EspnStandingStatistic[];

  statistics?: EspnStandingStatistic[];

  [key: string]: unknown;
}

// ============================================================
// ESPN STANDING STATISTIC
// ============================================================

export interface EspnStandingStatistic {
  name?: string;

  displayName?: string;

  shortDisplayName?: string;

  description?: string;

  abbreviation?: string;

  type?: string;

  value?: number | string;

  displayValue?: string;

  rank?: number;

  summary?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN SUMMARY STANDINGS
// ============================================================

export interface EspnSummaryStandings {
  fullViewLink?:
    | EspnLink
    | {
        text?: string;

        href?: string;

        [key: string]: unknown;
      };

  header?: string;

  groups?: EspnSummaryStandingsGroup[];

  [key: string]: unknown;
}

export interface EspnSummaryStandingsGroup {
  standings?: {
    entries?: EspnSummaryStandingEntry[];

    [key: string]: unknown;
  };

  header?: string;

  href?: string;

  [key: string]: unknown;
}

export interface EspnSummaryStandingEntry {
  team?: string;

  link?: string;

  id?: string;

  uid?: string;

  stats?: EspnStandingStatistic[];

  logo?: EspnLogo[];

  [key: string]: unknown;
}

// ============================================================
// ESPN ODDS
// ============================================================

export interface EspnOdds {
  provider?: EspnOddsProvider;

  details?: string;

  overUnder?: number;

  spread?: number;

  moneyline?: EspnMoneyline;

  homeTeamOdds?: EspnTeamOdds;

  awayTeamOdds?: EspnTeamOdds;

  [key: string]: unknown;
}

// ============================================================
// ESPN ODDS PROVIDER
// ============================================================

export interface EspnOddsProvider {
  id?: string;

  name?: string;

  priority?: number;

  logo?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN MONEYLINE
// ============================================================

export interface EspnMoneyline {
  home?: number;

  away?: number;

  draw?: number;

  [key: string]: unknown;
}

// ============================================================
// ESPN TEAM ODDS
// ============================================================

export interface EspnTeamOdds {
  team?: EspnTeam;

  favorite?: boolean;

  underdog?: boolean;

  moneyLine?: number;

  spread?: number;

  spreadOdds?: number;

  total?: number;

  totalOdds?: number;

  [key: string]: unknown;
}

// ============================================================
// ESPN LEADERS
// ============================================================

export interface EspnLeader {
  name?: string;

  displayName?: string;

  shortDisplayName?: string;

  abbreviation?: string;

  leaders?: EspnLeaderItem[];

  team?: EspnTeam;

  [key: string]: unknown;
}

// ============================================================
// ESPN LEADER ITEM
// ============================================================

export interface EspnLeaderItem {
  athlete?: EspnAthlete;

  team?: EspnTeam;

  value?: number;

  displayValue?: string;

  statistics?: EspnTeamMatchStatistic[];

  mainStat?: string;

  summary?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN MATCH LEADERS
// ============================================================

export interface EspnMatchLeaderTeam {
  team?: EspnTeam;

  leaders?: EspnMatchLeaderGroup[];

  [key: string]: unknown;
}

export interface EspnMatchLeaderGroup {
  name?: string;

  displayName?: string;

  shortDisplayName?: string;

  abbreviation?: string;

  leaders?: EspnMatchLeaderItem[];

  [key: string]: unknown;
}

export interface EspnMatchLeaderItem {
  displayValue?: string;

  athlete?: EspnAthlete;

  statistics?: EspnTeamMatchStatistic[];

  mainStat?: string;

  summary?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN BOXSCORE
// ============================================================

export interface EspnBoxscore {
  teams?: EspnBoxscoreTeam[];

  players?: EspnBoxscorePlayerTeam[];

  [key: string]: unknown;
}

export interface EspnBoxscoreTeam {
  homeAway?: 'home' | 'away';

  team?: EspnTeam;

  displayOrder?: number;

  statistics?: EspnTeamMatchStatistic[];

  [key: string]: unknown;
}

export interface EspnBoxscorePlayerTeam {
  team?: EspnTeam;

  statistics?: EspnPlayerBoxscoreGroup[];

  [key: string]: unknown;
}

export interface EspnPlayerBoxscoreGroup {
  name?: string;

  displayName?: string;

  keys?: string[];

  athletes?: EspnPlayerBoxscoreEntry[];

  [key: string]: unknown;
}

export interface EspnPlayerBoxscoreEntry {
  athlete?: EspnAthlete;

  stats?: EspnTeamMatchStatistic[];

  [key: string]: unknown;
}

// ============================================================
// ESPN GAME INFO
// ============================================================

export interface EspnGameInfo {
  venue?: EspnVenue;

  attendance?: number;

  officials?: EspnOfficial[];

  [key: string]: unknown;
}

export interface EspnOfficial {
  fullName?: string;

  displayName?: string;

  order?: number;

  [key: string]: unknown;
}

// ============================================================
// ESPN LAST FIVE GAMES
// ============================================================

export interface EspnLastFiveGameTeam {
  team?: EspnTeam;

  events?: EspnLastFiveGameEvent[];

  [key: string]: unknown;
}

export interface EspnLastFiveGameEvent {
  id?: string;

  uid?: string;

  summary?: string;

  atVs?: string;

  gameDate?: string;

  score?: string;

  homeTeamId?: string;

  awayTeamId?: string;

  homeTeamScore?: string | number;

  awayTeamScore?: string | number;

  aggregateScore?: string;

  shootoutScore?: string;

  gameResult?: string;

  advance?: boolean;

  advanceType?: string;

  matchNote?: string;

  competitionName?: string;

  roundName?: string;

  leagueName?: string;

  leagueAbbreviation?: string;

  opponent?: EspnTeam;

  [key: string]: unknown;
}

// ============================================================
// ESPN MATCH ROSTERS
// ============================================================

export interface EspnMatchRosterTeam {
  homeAway?: 'home' | 'away';

  winner?: boolean;

  team?: EspnTeam;

  roster?: EspnMatchRosterPlayer[];

  uniform?: EspnRosterUniform;

  formation?: string;

  [key: string]: unknown;
}

export interface EspnMatchRosterPlayer {
  active?: boolean;

  starter?: boolean;

  jersey?: string;

  athlete?: EspnAthlete;

  subbedIn?: boolean;

  subbedOut?: boolean;

  formationPlace?: string;

  media?: Record<string, unknown>;

  stats?: EspnPlayerMatchStatistic[];

  [key: string]: unknown;
}

export interface EspnRosterUniform {
  type?: string;

  color?: string;

  number?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN PLAYER MATCH STATISTICS
// ============================================================

export interface EspnPlayerMatchStatistic {
  name?: string;

  displayName?: string;

  shortDisplayName?: string;

  description?: string;

  abbreviation?: string;

  value?: number | string;

  displayValue?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN SEASON SERIES / H2H SNAPSHOT
// ============================================================

export interface EspnSeasonSeries {
  type?: string;

  title?: string;

  summary?: string;

  completed?: boolean;

  totalCompetitions?: number;

  seriesLabel?: string;

  seriesScore?: string;

  shortSummary?: string;

  events?: EspnSeasonSeriesEvent[];

  [key: string]: unknown;
}

export interface EspnSeasonSeriesEvent {
  id?: string;

  uid?: string;

  date?: string;

  timeValid?: boolean;

  status?: EspnCompetitionStatus;

  neutralSite?: boolean;

  competitors?: EspnSeasonSeriesCompetitor[];

  links?: EspnLink[];

  competitionName?: string;

  roundName?: string;

  [key: string]: unknown;
}

export interface EspnSeasonSeriesCompetitor {
  id?: string;

  uid?: string;

  order?: number;

  homeAway?: 'home' | 'away';

  winner?: boolean;

  team?: EspnTeam;

  score?: string | number;

  [key: string]: unknown;
}

// ============================================================
// ESPN KEY EVENTS
// ============================================================

export interface EspnKeyEvent extends EspnEventDetail {
  sequence?: number;

  period?: number;

  shortText?: string;

  clock?: EspnClock;

  wallclock?: string;

  source?: string;

  shootout?: boolean;

  penaltyKick?: boolean;

  ownGoal?: boolean;

  goalPosition?: EspnFieldPosition;

  fieldPosition?: EspnFieldPosition;

  participants?: EspnEventParticipant[];

  [key: string]: unknown;
}

export interface EspnEventParticipant {
  athlete?: EspnAthlete;

  [key: string]: unknown;
}

export interface EspnFieldPosition {
  x?: number;

  y?: number;

  [key: string]: unknown;
}

// ============================================================
// ESPN COMMENTARY
// ============================================================

export interface EspnCommentaryItem {
  sequence?: number;

  time?: EspnClock;

  text?: string;

  play?: EspnCommentaryPlay;

  [key: string]: unknown;
}

export interface EspnCommentaryPlay {
  id?: string;

  type?: string;

  text?: string;

  shortText?: string;

  sequence?: number;

  clock?: EspnClock;

  period?: number;

  team?: EspnTeam;

  athlete?: EspnAthlete;

  participants?: EspnEventParticipant[];

  [key: string]: unknown;
}

// ============================================================
// ESPN MATCH META
// ============================================================

export interface EspnMatchMeta {
  gp_topic?: string;

  gameSwitcherEnabled?: boolean;

  picker_topic?: string;

  lastUpdatedAt?: string;

  firstPlayWallClock?: string;

  lastPlayWallClock?: string;

  gameState?: string;

  syncUrl?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN MATCH HEADER
// ============================================================

export interface EspnMatchHeader {
  id?: string;

  uid?: string;

  season?: EspnMatchHeaderSeason;

  timeValid?: boolean;

  competitions?: EspnMatchHeaderCompetition[];

  links?: EspnLink[];

  league?: EspnLeague;

  linksv4?: EspnLink[];

  [key: string]: unknown;
}

export interface EspnMatchHeaderSeason {
  year?: number;

  current?: boolean;

  type?: number | string;

  name?: string;

  [key: string]: unknown;
}

export interface EspnMatchHeaderCompetition {
  id?: string;

  uid?: string;

  date?: string;

  neutralSite?: boolean;

  conferenceCompetition?: boolean;

  boxscoreAvailable?: boolean;

  commentaryAvailable?: boolean;

  liveAvailable?: boolean;

  onWatchESPN?: boolean;

  recent?: boolean;

  wallclockAvailable?: boolean;

  boxscoreSource?: string;

  playByPlaySource?: string;

  competitors?: EspnMatchHeaderCompetitor[];

  notes?: EspnNote[];

  status?: EspnCompetitionStatus;

  broadcasts?: EspnBroadcast[];

  details?: EspnMatchHeaderDetail[];

  groups?: unknown[];

  isFinal?: boolean;

  isThirdPlace?: boolean;

  altGameNote?: string;

  boxscoreMinutes?: number;

  shotMapAvailable?: boolean;

  [key: string]: unknown;
}

export interface EspnMatchHeaderCompetitor {
  id?: string;

  uid?: string;

  order?: number;

  homeAway?: 'home' | 'away';

  winner?: boolean;

  advance?: boolean;

  team?: EspnTeam;

  score?: string | number;

  linescores?: EspnLineScore[];

  record?: EspnHeaderTeamRecord[];

  groups?: unknown[];

  possession?: boolean | number;

  [key: string]: unknown;
}

export interface EspnLineScore {
  value?: number;

  displayValue?: string;

  period?: number;

  [key: string]: unknown;
}

export interface EspnHeaderTeamRecord {
  name?: string;

  type?: string;

  summary?: string;

  displayValue?: string;

  [key: string]: unknown;
}

export interface EspnMatchHeaderDetail {
  clock?: EspnClock;

  scoringPlay?: boolean;

  team?: EspnTeam;

  participants?: EspnEventParticipant[];

  addedClock?: number;

  redCard?: boolean;

  penaltyKick?: boolean;

  ownGoal?: boolean;

  [key: string]: unknown;
}

// ============================================================
// ESPN VIDEOS
// ============================================================

export interface EspnVideo {
  id?: string;

  cerebroId?: string;

  source?: string;

  headline?: string;

  description?: string;

  lastModified?: string;

  originalPublishDate?: string;

  duration?: number;

  timeRestrictions?: EspnVideoTimeRestrictions;

  deviceRestrictions?: EspnVideoDeviceRestrictions;

  thumbnail?: string;

  links?: EspnVideoLinks;

  ad?: unknown;

  tracking?: EspnVideoTracking;

  [key: string]: unknown;
}

export interface EspnVideoTimeRestrictions {
  embargoDate?: string;

  expirationDate?: string;

  [key: string]: unknown;
}

export interface EspnVideoDeviceRestrictions {
  allowed?: string[];

  forbidden?: string[];

  [key: string]: unknown;
}

export interface EspnVideoLinks {
  api?: {
    artwork?: EspnLink;

    self?: EspnLink;

    [key: string]: unknown;
  };

  mobile?: Record<string, unknown>;

  progressiveDownload?: Record<string, unknown>;

  streaming?: Record<string, unknown>;

  source?: EspnVideoSourceLinks;

  sportscenter?: EspnLink;

  web?: EspnLink;

  [key: string]: unknown;
}

export interface EspnVideoSourceLinks {
  href?: string;

  hrefHd?: string;

  hls?: string;

  cmaf?: string;

  shield?: string;

  flash?: string;

  full?: string;

  hds?: string;

  mezzanine?: string;

  [key: string]: unknown;
}

export interface EspnVideoTracking {
  coverageType?: string;

  leagueName?: string;

  sportName?: string;

  trackingId?: string;

  trackingName?: string;

  [key: string]: unknown;
}

// ============================================================
// ESPN MATCH NEWS
// ============================================================

export interface EspnMatchNews {
  header?: string;

  link?: string;

  articles?: EspnNewsArticle[];

  /*
   * Some ESPN responses may wrap the same structure inside
   * a nested `news` property. Keep this tolerant for provider
   * response variations.
   */
  news?: {
    header?: string;

    link?: string;

    articles?: EspnNewsArticle[];

    [key: string]: unknown;
  };

  [key: string]: unknown;
}

// ============================================================
// ESPN PICK CENTER
// ============================================================

export interface EspnPickCenter {
  provider?: EspnOddsProvider;

  details?: string;

  overUnder?: number;

  spread?: number;

  moneyline?: EspnMoneyline;

  homeTeamOdds?: EspnTeamOdds;

  awayTeamOdds?: EspnTeamOdds;

  [key: string]: unknown;
}

// ============================================================
// ESPN NEWS RESPONSE
// ============================================================

export interface EspnNewsResponse {
  resultsCount?: number;

  resultsLimit?: number;

  resultsOffset?: number;

  headlines?: EspnNewsArticle[];

  [key: string]: unknown;
}

// ============================================================
// ESPN NEWS ARTICLE
// ============================================================

export interface EspnNewsArticle {
  id?: string;

  nowId?: string;

  contentKey?: string;

  dataSourceIdentifier?: string;

  type?: string;

  headline?: string;

  description?: string;

  published?: string;

  lastModified?: string;

  story?: string;

  source?: string;

  byline?: string;

  author?: string;

  premium?: boolean;

  video?: unknown;

  keywords?: string[];

  categories?: EspnNewsCategory[];

  images?: EspnNewsImage[];

  links?: {
    web?: {
      href?: string;

      text?: string;

      shortText?: string;

      rel?: string[];

      isExternal?: boolean;

      isPremium?: boolean;

      isAffiliate?: boolean;

      [key: string]: unknown;
    };

    api?: {
      self?: EspnLink;

      [key: string]: unknown;
    };

    mobile?: EspnLink;

    app?: EspnLink;

    sportscenter?: EspnLink;

    [key: string]: unknown;
  };

  [key: string]: unknown;
}

// ============================================================
// ESPN NEWS CATEGORY
// ============================================================

export interface EspnNewsCategory {
  id?: string;

  type?: string;

  leagueId?: string | number;

  league?: {
    id?: string | number;

    description?: string;

    abbreviation?: string;

    links?: EspnLink[];

    [key: string]: unknown;
  };

  teamId?: string | number;

  team?: EspnTeam;

  athleteId?: string | number;

  athlete?: EspnAthlete;

  [key: string]: unknown;
}

// ============================================================
// ESPN NEWS IMAGE
// ============================================================

export interface EspnNewsImage {
  id?: string;

  url?: string | string[];

  width?: number;

  height?: number;

  alt?: string;

  caption?: string;

  credit?: string;

  type?: string;

  rel?: string[];

  [key: string]: unknown;
}
