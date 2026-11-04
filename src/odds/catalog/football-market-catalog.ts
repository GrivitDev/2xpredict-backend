export type CanonicalPeriod = 'FULL_TIME' | 'FIRST_HALF';
export type CanonicalSelectionMode = 'STATIC' | 'OVER_UNDER' | 'ASIAN_HANDICAP';
export type CanonicalMarketFamily =
  | 'RESULT'
  | 'GOALS'
  | 'PERIOD'
  | 'HANDICAP'
  | 'STATISTICS';
export type CanonicalModel = 'SCORE_MATRIX' | 'PERIOD_MATRIX' | 'COUNT_MODEL';
export type CanonicalPriceType = 'PROVIDER' | 'ESTIMATED';

/** Legacy/global reference ceiling; individual markets now use explicit ranges. */
export const ODDS_MAX_LOW_COUNT_LINE = 7.5;
export const PREDICTION_MAX_OVER_UNDER_LINE = 7.5;

/** Market-specific maximum O/U lines supported by the probability and settlement models. */
export const MARKET_LINE_CEILINGS: Readonly<Record<string, number>> =
  Object.freeze({
    TOTAL_GOALS_OVER_UNDER: 7.5,
    HOME_TEAM_GOALS_OVER_UNDER: 5.5,
    AWAY_TEAM_GOALS_OVER_UNDER: 5.5,
    FIRST_HALF_TOTAL_GOALS: 3.5,
    TOTAL_CARDS_OVER_UNDER: 6.5,
    TOTAL_OFFSIDES_OVER_UNDER: 6.5,
  });

export interface CanonicalSelectionDefinition {
  key: string;
  jsonVariable: string;
  fullName: string;
  abbreviation: string;
  settlementKey: string;
}

export interface CanonicalMarketDefinition {
  /** Stable ID shared by pricing, prediction, Bet Lab and settlement. */
  id: string;
  predictionMarketKey: string;
  betLabMarketCode: string;
  jsonVariable: string;
  fullName: string;
  abbreviation: string;
  family: CanonicalMarketFamily;
  model: CanonicalModel;
  selectionMode: CanonicalSelectionMode;
  period: CanonicalPeriod;
  selections: CanonicalSelectionDefinition[];
  lines?: number[];
  statisticKey?:
    | 'corners'
    | 'shots'
    | 'shotsOnTarget'
    | 'cards'
    | 'fouls'
    | 'offsides';
  notes?: string;
}

export interface CanonicalExpandedSelection extends CanonicalSelectionDefinition {
  line?: number;
  handicap?: number;
  side?: 'HOME' | 'AWAY';
}

const pick = (
  key: string,
  jsonVariable: string,
  fullName: string,
  abbreviation: string,
  settlementKey = key,
): CanonicalSelectionDefinition => ({
  key,
  jsonVariable,
  fullName,
  abbreviation,
  settlementKey,
});

const resultSelections = (): CanonicalSelectionDefinition[] => [
  pick('HOME_WIN', 'homeWin', 'Home Win', '1'),
  pick('DRAW', 'draw', 'Draw', 'X'),
  pick('AWAY_WIN', 'awayWin', 'Away Win', '2'),
];

const overUnderMarket = (
  values: Pick<
    CanonicalMarketDefinition,
    | 'id'
    | 'predictionMarketKey'
    | 'betLabMarketCode'
    | 'jsonVariable'
    | 'fullName'
    | 'abbreviation'
    | 'family'
    | 'model'
    | 'period'
    | 'lines'
    | 'statisticKey'
    | 'notes'
  >,
): CanonicalMarketDefinition => ({
  ...values,
  selectionMode: 'OVER_UNDER',
  selections: [],
});

/** The supported catalogue. Expand it only when the data and settlement rules support the market. */
export const FOOTBALL_MARKET_CATALOG: CanonicalMarketDefinition[] = [
  {
    id: 'MATCH_RESULT',
    predictionMarketKey: 'MATCH_RESULT',
    betLabMarketCode: 'MATCH_RESULT',
    jsonVariable: 'matchResult',
    fullName: 'Match Result',
    abbreviation: '1X2',
    family: 'RESULT',
    model: 'SCORE_MATRIX',
    selectionMode: 'STATIC',
    period: 'FULL_TIME',
    selections: resultSelections(),
  },
  {
    id: 'DOUBLE_CHANCE',
    predictionMarketKey: 'DOUBLE_CHANCE',
    betLabMarketCode: 'DOUBLE_CHANCE',
    jsonVariable: 'doubleChance',
    fullName: 'Double Chance',
    abbreviation: 'DC',
    family: 'RESULT',
    model: 'SCORE_MATRIX',
    selectionMode: 'STATIC',
    period: 'FULL_TIME',
    selections: [
      pick('HOME_OR_DRAW', 'homeOrDraw', 'Home or Draw', '1X'),
      pick('DRAW_OR_AWAY', 'drawOrAway', 'Draw or Away', 'X2'),
      pick('HOME_OR_AWAY', 'homeOrAway', 'Home or Away', '12'),
    ],
  },
  {
    id: 'DRAW_NO_BET',
    predictionMarketKey: 'DRAW_NO_BET',
    betLabMarketCode: 'DRAW_NO_BET',
    jsonVariable: 'drawNoBet',
    fullName: 'Draw No Bet',
    abbreviation: 'DNB',
    family: 'RESULT',
    model: 'SCORE_MATRIX',
    selectionMode: 'STATIC',
    period: 'FULL_TIME',
    notes:
      'A draw is a push; probabilities and fair prices are conditional on a decisive result.',
    selections: [
      pick('HOME_DNB', 'homeDrawNoBet', 'Home Draw No Bet', '1 DNB'),
      pick('AWAY_DNB', 'awayDrawNoBet', 'Away Draw No Bet', '2 DNB'),
    ],
  },
  overUnderMarket({
    id: 'TOTAL_GOALS_OVER_UNDER',
    predictionMarketKey: 'GOALS_OVER_UNDER',
    betLabMarketCode: 'TOTAL_GOALS_OVER_UNDER',
    jsonVariable: 'goalsOverUnder',
    fullName: 'Total Goals Over/Under',
    abbreviation: 'Goals O/U',
    family: 'GOALS',
    model: 'SCORE_MATRIX',
    period: 'FULL_TIME',
    lines: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5],
  }),
  overUnderMarket({
    id: 'HOME_TEAM_GOALS_OVER_UNDER',
    predictionMarketKey: 'HOME_TEAM_GOALS_OVER_UNDER',
    betLabMarketCode: 'HOME_TEAM_GOALS_OVER_UNDER',
    jsonVariable: 'homeTeamGoalsOverUnder',
    fullName: 'Home Team Goals Over/Under',
    abbreviation: 'Home Goals O/U',
    family: 'GOALS',
    model: 'SCORE_MATRIX',
    period: 'FULL_TIME',
    lines: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5],
    notes: 'The line applies to home-team goals.',
  }),
  overUnderMarket({
    id: 'AWAY_TEAM_GOALS_OVER_UNDER',
    predictionMarketKey: 'AWAY_TEAM_GOALS_OVER_UNDER',
    betLabMarketCode: 'AWAY_TEAM_GOALS_OVER_UNDER',
    jsonVariable: 'awayTeamGoalsOverUnder',
    fullName: 'Away Team Goals Over/Under',
    abbreviation: 'Away Goals O/U',
    family: 'GOALS',
    model: 'SCORE_MATRIX',
    period: 'FULL_TIME',
    lines: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5],
    notes: 'The line applies to away-team goals.',
  }),
  {
    id: 'ASIAN_HANDICAP',
    predictionMarketKey: 'ASIAN_HANDICAP',
    betLabMarketCode: 'ASIAN_HANDICAP',
    jsonVariable: 'asianHandicap',
    fullName: 'Asian Handicap',
    abbreviation: 'AH',
    family: 'HANDICAP',
    model: 'SCORE_MATRIX',
    selectionMode: 'ASIAN_HANDICAP',
    period: 'FULL_TIME',
    lines: [-2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5],
    selections: [],
    notes:
      'Quarter lines are excluded in this catalogue to keep settlement simple and consistent.',
  },
  {
    id: 'BOTH_TEAMS_TO_SCORE',
    predictionMarketKey: 'BOTH_TEAMS_TO_SCORE',
    betLabMarketCode: 'BOTH_TEAMS_TO_SCORE',
    jsonVariable: 'bothTeamsToScore',
    fullName: 'Both Teams to Score',
    abbreviation: 'BTTS',
    family: 'GOALS',
    model: 'SCORE_MATRIX',
    selectionMode: 'STATIC',
    period: 'FULL_TIME',
    selections: [pick('YES', 'yes', 'Yes', 'GG'), pick('NO', 'no', 'No', 'NG')],
  },
  overUnderMarket({
    id: 'FIRST_HALF_TOTAL_GOALS',
    predictionMarketKey: 'FIRST_HALF_GOALS_OVER_UNDER',
    betLabMarketCode: 'FIRST_HALF_TOTAL_GOALS',
    jsonVariable: 'firstHalfGoalsOverUnder',
    fullName: 'First-Half Goals Over/Under',
    abbreviation: '1H Goals O/U',
    family: 'PERIOD',
    model: 'PERIOD_MATRIX',
    period: 'FIRST_HALF',
    lines: [0.5, 1.5, 2.5, 3.5],
  }),
  {
    id: 'HALF_TIME_RESULT',
    predictionMarketKey: 'HALF_TIME_RESULT',
    betLabMarketCode: 'HALF_TIME_RESULT',
    jsonVariable: 'halfTimeResult',
    fullName: 'First-Half Result',
    abbreviation: 'HT 1X2',
    family: 'PERIOD',
    model: 'PERIOD_MATRIX',
    selectionMode: 'STATIC',
    period: 'FIRST_HALF',
    selections: resultSelections(),
  },
  overUnderMarket({
    id: 'TOTAL_CORNERS_OVER_UNDER',
    predictionMarketKey: 'TOTAL_CORNERS_OVER_UNDER',
    betLabMarketCode: 'TOTAL_CORNERS_OVER_UNDER',
    jsonVariable: 'totalCornersOverUnder',
    fullName: 'Total Corners Over/Under',
    abbreviation: 'Corners O/U',
    family: 'STATISTICS',
    model: 'COUNT_MODEL',
    period: 'FULL_TIME',
    lines: [6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5],
    statisticKey: 'corners',
  }),
  overUnderMarket({
    id: 'TOTAL_SHOTS_OVER_UNDER',
    predictionMarketKey: 'TOTAL_SHOTS_OVER_UNDER',
    betLabMarketCode: 'TOTAL_SHOTS_OVER_UNDER',
    jsonVariable: 'totalShotsOverUnder',
    fullName: 'Total Shots Over/Under',
    abbreviation: 'Shots O/U',
    family: 'STATISTICS',
    model: 'COUNT_MODEL',
    period: 'FULL_TIME',
    lines: [15.5, 17.5, 19.5, 21.5, 23.5, 25.5, 27.5],
    statisticKey: 'shots',
  }),
  overUnderMarket({
    id: 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER',
    predictionMarketKey: 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER',
    betLabMarketCode: 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER',
    jsonVariable: 'totalShotsOnTargetOverUnder',
    fullName: 'Total Shots on Target Over/Under',
    abbreviation: 'Shots on Target O/U',
    family: 'STATISTICS',
    model: 'COUNT_MODEL',
    period: 'FULL_TIME',
    lines: [5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5],
    statisticKey: 'shotsOnTarget',
  }),
  overUnderMarket({
    id: 'TOTAL_CARDS_OVER_UNDER',
    predictionMarketKey: 'TOTAL_CARDS_OVER_UNDER',
    betLabMarketCode: 'TOTAL_CARDS_OVER_UNDER',
    jsonVariable: 'totalCardsOverUnder',
    fullName: 'Total Cards Over/Under',
    abbreviation: 'Cards O/U',
    family: 'STATISTICS',
    model: 'COUNT_MODEL',
    period: 'FULL_TIME',
    lines: [1.5, 2.5, 3.5, 4.5, 5.5, 6.5],
    statisticKey: 'cards',
    notes:
      'The internal settlement convention counts yellow and red cards as one each.',
  }),
  overUnderMarket({
    id: 'TOTAL_FOULS_OVER_UNDER',
    predictionMarketKey: 'TOTAL_FOULS_OVER_UNDER',
    betLabMarketCode: 'TOTAL_FOULS_OVER_UNDER',
    jsonVariable: 'totalFoulsOverUnder',
    fullName: 'Total Fouls Over/Under',
    abbreviation: 'Fouls O/U',
    family: 'STATISTICS',
    model: 'COUNT_MODEL',
    period: 'FULL_TIME',
    lines: [17.5, 19.5, 21.5, 23.5],
    statisticKey: 'fouls',
  }),
  overUnderMarket({
    id: 'TOTAL_OFFSIDES_OVER_UNDER',
    predictionMarketKey: 'TOTAL_OFFSIDES_OVER_UNDER',
    betLabMarketCode: 'TOTAL_OFFSIDES_OVER_UNDER',
    jsonVariable: 'totalOffsidesOverUnder',
    fullName: 'Total Offsides Over/Under',
    abbreviation: 'Offsides O/U',
    family: 'STATISTICS',
    model: 'COUNT_MODEL',
    period: 'FULL_TIME',
    lines: [1.5, 2.5, 3.5, 4.5, 5.5, 6.5],
    statisticKey: 'offsides',
  }),
];

// Freeze the canonical catalogue and its nested selection/line arrays at runtime.
// Downstream modules may derive read-only views, but cannot extend or mutate the
// active market set after application startup.
for (const market of FOOTBALL_MARKET_CATALOG) {
  for (const selection of market.selections) Object.freeze(selection);
  Object.freeze(market.selections);
  if (market.lines) Object.freeze(market.lines);
  Object.freeze(market);
}
Object.freeze(FOOTBALL_MARKET_CATALOG);

function createReadonlyMap<K, V>(
  entries: Iterable<readonly [K, V]>,
): ReadonlyMap<K, V> {
  const source = new Map<K, V>(entries);
  const view: ReadonlyMap<K, V> = Object.freeze({
    get size() {
      return source.size;
    },
    get(key: K) {
      return source.get(key);
    },
    has(key: K) {
      return source.has(key);
    },
    entries() {
      return source.entries();
    },
    keys() {
      return source.keys();
    },
    values() {
      return source.values();
    },
    forEach(
      callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
      thisArg?: unknown,
    ) {
      source.forEach((value, key) => {
        void callback.call(thisArg, value, key, view);
      });
    },
    [Symbol.iterator](): MapIterator<[K, V]> {
      return source.entries();
    },
  });
  return view;
}

export const FOOTBALL_MARKET_BY_ID: ReadonlyMap<
  string,
  CanonicalMarketDefinition
> = createReadonlyMap(
  FOOTBALL_MARKET_CATALOG.map((market) => [market.id, market] as const),
);
export const FOOTBALL_MARKET_BY_PREDICTION_KEY: ReadonlyMap<
  string,
  CanonicalMarketDefinition
> = createReadonlyMap(
  FOOTBALL_MARKET_CATALOG.map(
    (market) => [market.predictionMarketKey, market] as const,
  ),
);
export const FOOTBALL_MARKET_BY_BET_LAB_CODE: ReadonlyMap<
  string,
  CanonicalMarketDefinition
> = createReadonlyMap(
  FOOTBALL_MARKET_CATALOG.map(
    (market) => [market.betLabMarketCode, market] as const,
  ),
);

export function canonicalLineSlug(value: number): string {
  return String(value).replace('-', 'MINUS_').replace('.', '_');
}

export function expandCanonicalSelections(
  market: CanonicalMarketDefinition,
  homeTeamName = 'Home Team',
  awayTeamName = 'Away Team',
): CanonicalExpandedSelection[] {
  if (market.selectionMode === 'STATIC') {
    return market.selections.map((selection) => {
      let fullName = selection.fullName;
      if (selection.key === 'HOME_WIN') fullName = `${homeTeamName} to Win`;
      if (selection.key === 'AWAY_WIN') fullName = `${awayTeamName} to Win`;
      if (selection.key === 'HOME_OR_DRAW')
        fullName = `${homeTeamName} or Draw`;
      if (selection.key === 'DRAW_OR_AWAY')
        fullName = `Draw or ${awayTeamName}`;
      if (selection.key === 'HOME_OR_AWAY')
        fullName = `${homeTeamName} or ${awayTeamName}`;
      if (selection.key === 'HOME_DNB')
        fullName = `${homeTeamName} Draw No Bet`;
      if (selection.key === 'AWAY_DNB')
        fullName = `${awayTeamName} Draw No Bet`;
      return { ...selection, fullName };
    });
  }

  if (market.selectionMode === 'OVER_UNDER') {
    return (market.lines ?? []).flatMap((line) => [
      {
        key: `OVER_${canonicalLineSlug(line)}`,
        jsonVariable: `over${String(line).replace('.', '')}`,
        fullName: `Over ${line}`,
        abbreviation: `O ${line}`,
        settlementKey: `OVER_${canonicalLineSlug(line)}`,
        line,
      },
      {
        key: `UNDER_${canonicalLineSlug(line)}`,
        jsonVariable: `under${String(line).replace('.', '')}`,
        fullName: `Under ${line}`,
        abbreviation: `U ${line}`,
        settlementKey: `UNDER_${canonicalLineSlug(line)}`,
        line,
      },
    ]);
  }

  return (market.lines ?? []).flatMap((handicap) => {
    const slug = canonicalLineSlug(handicap);
    const label = handicap > 0 ? `+${handicap}` : String(handicap);
    return [
      {
        key: `HOME_${slug}`,
        jsonVariable: `homeHandicap${String(handicap).replace('-', 'Minus').replace('.', '')}`,
        fullName: `${homeTeamName} (${label})`,
        abbreviation: `1 ${label}`,
        settlementKey: `HOME_${slug}`,
        line: handicap,
        handicap,
        side: 'HOME' as const,
      },
      {
        key: `AWAY_${slug}`,
        jsonVariable: `awayHandicap${String(handicap).replace('-', 'Minus').replace('.', '')}`,
        fullName: `${awayTeamName} (${label})`,
        abbreviation: `2 ${label}`,
        settlementKey: `AWAY_${slug}`,
        line: handicap,
        handicap,
        side: 'AWAY' as const,
      },
    ];
  });
}

export function validateFootballMarketCatalog(): void {
  const marketIds = new Set<string>();
  for (const market of FOOTBALL_MARKET_CATALOG) {
    if (marketIds.has(market.id))
      throw new Error(`Duplicate canonical football market ID: ${market.id}`);
    marketIds.add(market.id);
    if (!market.fullName.trim() || !market.jsonVariable.trim())
      throw new Error(`Market ${market.id} has incomplete metadata.`);
    if (market.selectionMode === 'OVER_UNDER') {
      const ceiling = MARKET_LINE_CEILINGS[market.id];
      if (
        ceiling !== undefined &&
        market.lines?.some((line) => line > ceiling)
      ) {
        throw new Error(
          `Market ${market.id} exceeds its supported Over/Under line ceiling (${ceiling}).`,
        );
      }
      if (market.lines?.some((line) => !Number.isFinite(line) || line <= 0)) {
        throw new Error(
          `Market ${market.id} contains an invalid Over/Under line.`,
        );
      }
    }
    const selectionKeys = new Set<string>();
    for (const selection of expandCanonicalSelections(market)) {
      if (selectionKeys.has(selection.key))
        throw new Error(`Duplicate selection ${selection.key} in ${market.id}`);
      selectionKeys.add(selection.key);
    }
  }
  if (FOOTBALL_MARKET_CATALOG.length !== 16)
    throw new Error(
      `Expected 16 canonical football markets, found ${FOOTBALL_MARKET_CATALOG.length}.`,
    );
}

validateFootballMarketCatalog();
