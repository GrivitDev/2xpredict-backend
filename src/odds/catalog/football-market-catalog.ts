/**
 * Canonical football market catalogue.
 *
 * This catalogue is the shared contract for Odds, Predictions, Bet Lab and
 * Settlement. Market IDs and selection keys are durable identifiers; labels
 * may change, but IDs must not. Markets are only priced when the Odds pricing
 * engine can obtain the factual Sports inputs required by that market.
 */
export type CanonicalPeriod = 'FULL_TIME' | 'FIRST_HALF' | 'SECOND_HALF';
export type CanonicalSelectionMode = 'STATIC' | 'OVER_UNDER' | 'ASIAN_HANDICAP' | 'EUROPEAN_HANDICAP';
export type CanonicalMarketFamily = 'RESULT' | 'GOALS' | 'PERIOD' | 'HANDICAP' | 'STATISTICS' | 'PLAYER' | 'EVENTS';
export type CanonicalModel = 'SCORE_MATRIX' | 'PERIOD_MATRIX' | 'COUNT_MODEL' | 'PLAYER_EVENT_MODEL';
export type CanonicalPriceType = 'PROVIDER' | 'ESTIMATED';

export const ODDS_MAX_LOW_COUNT_LINE = 7.5;
export const PREDICTION_MAX_OVER_UNDER_LINE = 7.5;

export interface CanonicalSelectionDefinition {
  key: string;
  jsonVariable: string;
  fullName: string;
  abbreviation: string;
  settlementKey: string;
  homeGoals?: number;
  awayGoals?: number;
  /** Optional line carried by composite static markets. */
  line?: number;
  handicap?: number;
  side?: 'OVER' | 'UNDER' | 'HOME' | 'AWAY';
}

export interface CanonicalMarketDefinition {
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
  statisticKey?: 'corners' | 'shots' | 'shotsOnTarget' | 'cards' | 'yellowCards' | 'redCards' | 'fouls' | 'offsides';
  minimumSampleSize?: number;
  requiredData?: string[];
  notes?: string;
  /** False means definition is available to the catalogue but intentionally not priceable yet. */
  pricingEnabled?: boolean;
}

export interface CanonicalExpandedSelection extends CanonicalSelectionDefinition {
  line?: number;
  handicap?: number;
  side?: 'HOME' | 'AWAY' | 'OVER' | 'UNDER';
}

const pick = (key: string, fullName: string, abbreviation = key, jsonVariable = key.charAt(0).toLowerCase() + key.slice(1), settlementKey = key): CanonicalSelectionDefinition => ({
  key, jsonVariable, fullName, abbreviation, settlementKey,
});
const resultSelections = (): CanonicalSelectionDefinition[] => [
  pick('HOME_WIN', 'Home Win', '1', 'homeWin'),
  pick('DRAW', 'Draw', 'X', 'draw'),
  pick('AWAY_WIN', 'Away Win', '2', 'awayWin'),
];
const yesNo = (): CanonicalSelectionDefinition[] => [pick('YES', 'Yes', 'YES', 'yes'), pick('NO', 'No', 'NO', 'no')];
const staticMarket = (values: Omit<CanonicalMarketDefinition, 'selectionMode'> & { selections: CanonicalSelectionDefinition[] }): CanonicalMarketDefinition => ({ ...values, selectionMode: 'STATIC' });
const overUnderMarket = (values: Omit<CanonicalMarketDefinition, 'selectionMode' | 'selections'>): CanonicalMarketDefinition => ({ ...values, selectionMode: 'OVER_UNDER', selections: [] });

const scoreSelections = (max: number): CanonicalSelectionDefinition[] => {
  const rows: CanonicalSelectionDefinition[] = [];
  for (let home = 0; home <= max; home += 1) {
    for (let away = 0; away <= max; away += 1) {
      rows.push({
        key: `SCORE_${home}_${away}`,
        jsonVariable: `score${home}${away}`,
        fullName: `${home}-${away}`,
        abbreviation: `${home}:${away}`,
        settlementKey: `SCORE_${home}_${away}`,
        homeGoals: home,
        awayGoals: away,
      });
    }
  }
  rows.push(
    pick('ANY_OTHER_HOME', 'Any Other Home Win', 'Other 1'),
    pick('ANY_OTHER_DRAW', 'Any Other Draw', 'Other X'),
    pick('ANY_OTHER_AWAY', 'Any Other Away Win', 'Other 2'),
  );
  return rows;
};

const EXACT_TOTAL_GOALS = [0, 1, 2, 3, 4, 5].map((goals) => pick(`GOALS_${goals}`, `${goals} Goals`, String(goals)));
EXACT_TOTAL_GOALS.push(pick('GOALS_6_PLUS', '6 or More Goals', '6+'));

const bttsResultSelections = (): CanonicalSelectionDefinition[] =>
  (['HOME', 'DRAW', 'AWAY'] as const).flatMap((result) =>
    (['YES', 'NO'] as const).map((answer) => ({
      key: `${result}_${answer}`,
      jsonVariable: `${result.toLowerCase()}${answer === 'YES' ? 'BttsYes' : 'BttsNo'}`,
      fullName: `${result === 'HOME' ? 'Home Win' : result === 'AWAY' ? 'Away Win' : 'Draw'} & BTTS ${answer}`,
      abbreviation: `${result}_${answer}`,
      settlementKey: `${result}_${answer}`,
    })),
  );

const bttsTotalSelections = (): CanonicalSelectionDefinition[] =>
  ([0.5, 1.5, 2.5, 3.5, 4.5] as const).flatMap((line) =>
    (['YES', 'NO'] as const).flatMap((btts) =>
      (['OVER', 'UNDER'] as const).map((side) => ({
        key: `${btts}_${side}_${canonicalLineSlug(line)}`,
        jsonVariable: `${btts.toLowerCase()}${side === 'OVER' ? 'Over' : 'Under'}${String(line).replace('.', '')}`,
        fullName: `BTTS ${btts} & ${side} ${line} Goals`,
        abbreviation: `${btts} / ${side} ${line}`,
        settlementKey: `${btts}_${side}_${canonicalLineSlug(line)}`,
        line,
        side,
      })),
    ),
  );

const europeanHandicapSelections = (lines: number[]): CanonicalSelectionDefinition[] =>
  lines.flatMap((handicap) => {
    const slug = canonicalLineSlug(handicap);
    const lineLabel = handicap > 0 ? `+${handicap}` : String(handicap);
    return (['HOME_WIN', 'DRAW', 'AWAY_WIN'] as const).map((result) => ({
      key: `${result}_${slug}`,
      jsonVariable: `${result.toLowerCase()}Handicap${slug.toLowerCase()}`,
      fullName: `${result === 'HOME_WIN' ? 'Home' : result === 'AWAY_WIN' ? 'Away' : 'Draw'} (${lineLabel})`,
      abbreviation: `${result === 'HOME_WIN' ? '1' : result === 'AWAY_WIN' ? '2' : 'X'} ${lineLabel}`,
      settlementKey: `${result}_${slug}`,
      line: handicap,
      handicap,
    }));
  });

export const FOOTBALL_MARKET_CATALOG: CanonicalMarketDefinition[] = [
  // Core outcome markets (original stable IDs retained).
  staticMarket({ id: 'MATCH_RESULT', predictionMarketKey: 'MATCH_RESULT', betLabMarketCode: 'MATCH_RESULT', jsonVariable: 'matchResult', fullName: 'Match Result', abbreviation: '1X2', family: 'RESULT', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: resultSelections(), requiredData: ['TEAM_SCORING', 'COMPETITION_SCORING'], minimumSampleSize: 5 }),
  staticMarket({ id: 'DOUBLE_CHANCE', predictionMarketKey: 'DOUBLE_CHANCE', betLabMarketCode: 'DOUBLE_CHANCE', jsonVariable: 'doubleChance', fullName: 'Double Chance', abbreviation: 'DC', family: 'RESULT', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: [pick('HOME_OR_DRAW', 'Home or Draw', '1X', 'homeOrDraw'), pick('DRAW_OR_AWAY', 'Draw or Away', 'X2', 'drawOrAway'), pick('HOME_OR_AWAY', 'Home or Away', '12', 'homeOrAway')], requiredData: ['TEAM_SCORING', 'COMPETITION_SCORING'], minimumSampleSize: 5 }),
  staticMarket({ id: 'DRAW_NO_BET', predictionMarketKey: 'DRAW_NO_BET', betLabMarketCode: 'DRAW_NO_BET', jsonVariable: 'drawNoBet', fullName: 'Draw No Bet', abbreviation: 'DNB', family: 'RESULT', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: [pick('HOME_DNB', 'Home Draw No Bet', '1 DNB', 'homeDrawNoBet'), pick('AWAY_DNB', 'Away Draw No Bet', '2 DNB', 'awayDrawNoBet')], requiredData: ['TEAM_SCORING', 'COMPETITION_SCORING'], minimumSampleSize: 5, notes: 'A draw is a push; fair odds are conditional on a decisive result.' }),
  overUnderMarket({ id: 'TOTAL_GOALS_OVER_UNDER', predictionMarketKey: 'GOALS_OVER_UNDER', betLabMarketCode: 'TOTAL_GOALS_OVER_UNDER', jsonVariable: 'goalsOverUnder', fullName: 'Total Goals Over/Under', abbreviation: 'Goals O/U', family: 'GOALS', model: 'SCORE_MATRIX', period: 'FULL_TIME', lines: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5], requiredData: ['TEAM_SCORING', 'COMPETITION_SCORING'], minimumSampleSize: 5 }),
  overUnderMarket({ id: 'HOME_TEAM_GOALS_OVER_UNDER', predictionMarketKey: 'HOME_TEAM_GOALS_OVER_UNDER', betLabMarketCode: 'HOME_TEAM_GOALS_OVER_UNDER', jsonVariable: 'homeTeamGoalsOverUnder', fullName: 'Home Team Goals Over/Under', abbreviation: 'Home Goals O/U', family: 'GOALS', model: 'SCORE_MATRIX', period: 'FULL_TIME', lines: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5], requiredData: ['HOME_ATTACK', 'AWAY_DEFENCE'], minimumSampleSize: 5 }),
  overUnderMarket({ id: 'AWAY_TEAM_GOALS_OVER_UNDER', predictionMarketKey: 'AWAY_TEAM_GOALS_OVER_UNDER', betLabMarketCode: 'AWAY_TEAM_GOALS_OVER_UNDER', jsonVariable: 'awayTeamGoalsOverUnder', fullName: 'Away Team Goals Over/Under', abbreviation: 'Away Goals O/U', family: 'GOALS', model: 'SCORE_MATRIX', period: 'FULL_TIME', lines: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5], requiredData: ['AWAY_ATTACK', 'HOME_DEFENCE'], minimumSampleSize: 5 }),
  { id: 'ASIAN_HANDICAP', predictionMarketKey: 'ASIAN_HANDICAP', betLabMarketCode: 'ASIAN_HANDICAP', jsonVariable: 'asianHandicap', fullName: 'Asian Handicap', abbreviation: 'AH', family: 'HANDICAP', model: 'SCORE_MATRIX', selectionMode: 'ASIAN_HANDICAP', period: 'FULL_TIME', lines: [-2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5], selections: [], requiredData: ['TEAM_SCORING', 'COMPETITION_SCORING'], minimumSampleSize: 5, notes: 'Quarter lines remain disabled until the shared selection and settlement contract explicitly supports split handicaps.' },
  staticMarket({ id: 'BOTH_TEAMS_TO_SCORE', predictionMarketKey: 'BOTH_TEAMS_TO_SCORE', betLabMarketCode: 'BOTH_TEAMS_TO_SCORE', jsonVariable: 'bothTeamsToScore', fullName: 'Both Teams to Score', abbreviation: 'BTTS', family: 'GOALS', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: yesNo(), requiredData: ['TEAM_SCORING'], minimumSampleSize: 5 }),
  overUnderMarket({ id: 'FIRST_HALF_TOTAL_GOALS', predictionMarketKey: 'FIRST_HALF_GOALS_OVER_UNDER', betLabMarketCode: 'FIRST_HALF_TOTAL_GOALS', jsonVariable: 'firstHalfGoalsOverUnder', fullName: 'First-Half Goals Over/Under', abbreviation: '1H Goals O/U', family: 'PERIOD', model: 'PERIOD_MATRIX', period: 'FIRST_HALF', lines: [0.5, 1.5, 2.5, 3.5], requiredData: ['TEAM_SCORING', 'PERIOD_SPLIT'], minimumSampleSize: 5 }),
  staticMarket({ id: 'HALF_TIME_RESULT', predictionMarketKey: 'HALF_TIME_RESULT', betLabMarketCode: 'HALF_TIME_RESULT', jsonVariable: 'halfTimeResult', fullName: 'Half-Time Result', abbreviation: 'HT 1X2', family: 'PERIOD', model: 'PERIOD_MATRIX', period: 'FIRST_HALF', selections: resultSelections(), requiredData: ['TEAM_SCORING', 'PERIOD_SPLIT'], minimumSampleSize: 5 }),
  overUnderMarket({ id: 'TOTAL_CORNERS_OVER_UNDER', predictionMarketKey: 'TOTAL_CORNERS_OVER_UNDER', betLabMarketCode: 'TOTAL_CORNERS_OVER_UNDER', jsonVariable: 'totalCornersOverUnder', fullName: 'Total Corners Over/Under', abbreviation: 'Corners O/U', family: 'STATISTICS', model: 'COUNT_MODEL', period: 'FULL_TIME', lines: [6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5], statisticKey: 'corners', requiredData: ['TEAM_STATISTICS'], minimumSampleSize: 5 }),
  overUnderMarket({ id: 'TOTAL_SHOTS_OVER_UNDER', predictionMarketKey: 'TOTAL_SHOTS_OVER_UNDER', betLabMarketCode: 'TOTAL_SHOTS_OVER_UNDER', jsonVariable: 'totalShotsOverUnder', fullName: 'Total Shots Over/Under', abbreviation: 'Shots O/U', family: 'STATISTICS', model: 'COUNT_MODEL', period: 'FULL_TIME', lines: [15.5, 17.5, 19.5, 21.5, 23.5, 25.5, 27.5], statisticKey: 'shots', requiredData: ['TEAM_STATISTICS'], minimumSampleSize: 5 }),
  overUnderMarket({ id: 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER', predictionMarketKey: 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER', betLabMarketCode: 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER', jsonVariable: 'totalShotsOnTargetOverUnder', fullName: 'Total Shots on Target Over/Under', abbreviation: 'Shots on Target O/U', family: 'STATISTICS', model: 'COUNT_MODEL', period: 'FULL_TIME', lines: [5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5], statisticKey: 'shotsOnTarget', requiredData: ['TEAM_STATISTICS'], minimumSampleSize: 5 }),
  overUnderMarket({ id: 'TOTAL_CARDS_OVER_UNDER', predictionMarketKey: 'TOTAL_CARDS_OVER_UNDER', betLabMarketCode: 'TOTAL_CARDS_OVER_UNDER', jsonVariable: 'totalCardsOverUnder', fullName: 'Total Cards Over/Under', abbreviation: 'Cards O/U', family: 'STATISTICS', model: 'COUNT_MODEL', period: 'FULL_TIME', lines: [1.5, 2.5, 3.5, 4.5, 5.5, 6.5], statisticKey: 'cards', requiredData: ['TEAM_STATISTICS'], minimumSampleSize: 5, notes: 'Yellow and red cards are each counted once, matching the current Settlement convention.' }),
  overUnderMarket({ id: 'TOTAL_FOULS_OVER_UNDER', predictionMarketKey: 'TOTAL_FOULS_OVER_UNDER', betLabMarketCode: 'TOTAL_FOULS_OVER_UNDER', jsonVariable: 'totalFoulsOverUnder', fullName: 'Total Fouls Over/Under', abbreviation: 'Fouls O/U', family: 'STATISTICS', model: 'COUNT_MODEL', period: 'FULL_TIME', lines: [17.5, 19.5, 21.5, 23.5], statisticKey: 'fouls', requiredData: ['TEAM_STATISTICS'], minimumSampleSize: 5 }),
  overUnderMarket({ id: 'TOTAL_OFFSIDES_OVER_UNDER', predictionMarketKey: 'TOTAL_OFFSIDES_OVER_UNDER', betLabMarketCode: 'TOTAL_OFFSIDES_OVER_UNDER', jsonVariable: 'totalOffsidesOverUnder', fullName: 'Total Offsides Over/Under', abbreviation: 'Offsides O/U', family: 'STATISTICS', model: 'COUNT_MODEL', period: 'FULL_TIME', lines: [1.5, 2.5, 3.5, 4.5, 5.5, 6.5], statisticKey: 'offsides', requiredData: ['TEAM_STATISTICS'], minimumSampleSize: 5 }),

  // Additional catalogue markets whose outcomes are supported by the current Settlement contract.
  overUnderMarket({ id: 'ASIAN_TOTAL_GOALS', predictionMarketKey: 'ASIAN_TOTAL_GOALS', betLabMarketCode: 'ASIAN_TOTAL_GOALS', jsonVariable: 'asianTotalGoals', fullName: 'Asian Total Goals', abbreviation: 'Asian Goals', family: 'GOALS', model: 'SCORE_MATRIX', period: 'FULL_TIME', lines: [1, 2, 3, 4], requiredData: ['TEAM_SCORING', 'COMPETITION_SCORING'], minimumSampleSize: 5, notes: 'Fair probability is conditional on a non-push; integer-line push probability is excluded.' }),
  staticMarket({ id: 'BOTH_TEAMS_TO_SCORE_AND_RESULT', predictionMarketKey: 'BOTH_TEAMS_TO_SCORE_AND_RESULT', betLabMarketCode: 'BTTS_AND_MATCH_RESULT', jsonVariable: 'bttsAndMatchResult', fullName: 'Both Teams to Score & Match Result', abbreviation: 'BTTS & Result', family: 'GOALS', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: bttsResultSelections(), requiredData: ['TEAM_SCORING'], minimumSampleSize: 5 }),
  staticMarket({ id: 'BOTH_TEAMS_TO_SCORE_AND_TOTAL_GOALS', predictionMarketKey: 'BOTH_TEAMS_TO_SCORE_AND_TOTAL_GOALS', betLabMarketCode: 'BTTS_AND_TOTAL_GOALS', jsonVariable: 'bttsAndTotalGoals', fullName: 'Both Teams to Score & Total Goals', abbreviation: 'BTTS & Goals', family: 'GOALS', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: bttsTotalSelections(), requiredData: ['TEAM_SCORING'], minimumSampleSize: 5 }),
  { id: 'EUROPEAN_HANDICAP', predictionMarketKey: 'EUROPEAN_HANDICAP', betLabMarketCode: 'EUROPEAN_HANDICAP', jsonVariable: 'europeanHandicap', fullName: 'European Handicap', abbreviation: 'EH', family: 'HANDICAP', model: 'SCORE_MATRIX', selectionMode: 'EUROPEAN_HANDICAP', period: 'FULL_TIME', lines: [-2, -1, 1, 2], selections: europeanHandicapSelections([-2, -1, 1, 2]), requiredData: ['TEAM_SCORING', 'COMPETITION_SCORING'], minimumSampleSize: 5, notes: 'Three-way handicap result; no quarter-line split settlement.' },
  staticMarket({ id: 'HALF_TIME_CORRECT_SCORE', predictionMarketKey: 'HALF_TIME_CORRECT_SCORE', betLabMarketCode: 'HALF_TIME_CORRECT_SCORE', jsonVariable: 'halfTimeCorrectScore', fullName: 'Half-Time Correct Score', abbreviation: 'HT CS', family: 'PERIOD', model: 'PERIOD_MATRIX', period: 'FIRST_HALF', selections: scoreSelections(3), requiredData: ['TEAM_SCORING', 'PERIOD_SPLIT'], minimumSampleSize: 5 }),
  staticMarket({ id: 'FIRST_HALF_DOUBLE_CHANCE', predictionMarketKey: 'FIRST_HALF_DOUBLE_CHANCE', betLabMarketCode: 'HALF_TIME_DOUBLE_CHANCE', jsonVariable: 'halfTimeDoubleChance', fullName: 'Half-Time Double Chance', abbreviation: 'HT DC', family: 'PERIOD', model: 'PERIOD_MATRIX', period: 'FIRST_HALF', selections: [pick('HOME_OR_DRAW', 'Home or Draw', '1X', 'homeOrDraw'), pick('DRAW_OR_AWAY', 'Draw or Away', 'X2', 'drawOrAway'), pick('HOME_OR_AWAY', 'Home or Away', '12', 'homeOrAway')], requiredData: ['TEAM_SCORING', 'PERIOD_SPLIT'], minimumSampleSize: 5 }),

  // Score-derived markets: all supported by the existing score-based settlement contract.
  staticMarket({ id: 'HOME_TEAM_TO_SCORE', predictionMarketKey: 'HOME_TEAM_TO_SCORE', betLabMarketCode: 'HOME_TEAM_TO_SCORE', jsonVariable: 'homeTeamToScore', fullName: 'Home Team to Score', abbreviation: 'Home Goal', family: 'GOALS', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: yesNo(), requiredData: ['TEAM_SCORING'], minimumSampleSize: 5 }),
  staticMarket({ id: 'AWAY_TEAM_TO_SCORE', predictionMarketKey: 'AWAY_TEAM_TO_SCORE', betLabMarketCode: 'AWAY_TEAM_TO_SCORE', jsonVariable: 'awayTeamToScore', fullName: 'Away Team to Score', abbreviation: 'Away Goal', family: 'GOALS', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: yesNo(), requiredData: ['TEAM_SCORING'], minimumSampleSize: 5 }),
  staticMarket({ id: 'HOME_TEAM_CLEAN_SHEET', predictionMarketKey: 'HOME_TEAM_CLEAN_SHEET', betLabMarketCode: 'HOME_TEAM_CLEAN_SHEET', jsonVariable: 'homeTeamCleanSheet', fullName: 'Home Team Clean Sheet', abbreviation: 'Home CS', family: 'GOALS', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: yesNo(), requiredData: ['TEAM_SCORING'], minimumSampleSize: 5 }),
  staticMarket({ id: 'AWAY_TEAM_CLEAN_SHEET', predictionMarketKey: 'AWAY_TEAM_CLEAN_SHEET', betLabMarketCode: 'AWAY_TEAM_CLEAN_SHEET', jsonVariable: 'awayTeamCleanSheet', fullName: 'Away Team Clean Sheet', abbreviation: 'Away CS', family: 'GOALS', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: yesNo(), requiredData: ['TEAM_SCORING'], minimumSampleSize: 5 }),
  staticMarket({ id: 'HOME_TEAM_TO_WIN_TO_NIL', predictionMarketKey: 'HOME_TEAM_TO_WIN_TO_NIL', betLabMarketCode: 'HOME_TEAM_TO_WIN_TO_NIL', jsonVariable: 'homeWinToNil', fullName: 'Home Team to Win to Nil', abbreviation: 'Home WTN', family: 'GOALS', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: yesNo(), requiredData: ['TEAM_SCORING'], minimumSampleSize: 5 }),
  staticMarket({ id: 'AWAY_TEAM_TO_WIN_TO_NIL', predictionMarketKey: 'AWAY_TEAM_TO_WIN_TO_NIL', betLabMarketCode: 'AWAY_TEAM_TO_WIN_TO_NIL', jsonVariable: 'awayWinToNil', fullName: 'Away Team to Win to Nil', abbreviation: 'Away WTN', family: 'GOALS', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: yesNo(), requiredData: ['TEAM_SCORING'], minimumSampleSize: 5 }),
  staticMarket({ id: 'TOTAL_GOALS_ODD_EVEN', predictionMarketKey: 'ODD_EVEN_TOTAL_GOALS', betLabMarketCode: 'TOTAL_GOALS_ODD_EVEN', jsonVariable: 'totalGoalsOddEven', fullName: 'Total Goals Odd/Even', abbreviation: 'Goals O/E', family: 'GOALS', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: [pick('ODD', 'Odd'), pick('EVEN', 'Even')], requiredData: ['TEAM_SCORING'], minimumSampleSize: 5 }),
  staticMarket({ id: 'EXACT_TOTAL_GOALS', predictionMarketKey: 'EXACT_TOTAL_GOALS', betLabMarketCode: 'EXACT_TOTAL_GOALS', jsonVariable: 'exactTotalGoals', fullName: 'Exact Total Goals', abbreviation: 'Exact Goals', family: 'GOALS', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: EXACT_TOTAL_GOALS, requiredData: ['TEAM_SCORING'], minimumSampleSize: 5 }),
  staticMarket({ id: 'TOTAL_GOALS_RANGE', predictionMarketKey: 'TOTAL_GOALS_RANGE', betLabMarketCode: 'TOTAL_GOALS_RANGE', jsonVariable: 'totalGoalsRange', fullName: 'Total Goals Range', abbreviation: 'Goals Range', family: 'GOALS', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: [pick('GOALS_0_1', '0-1 Goals'), pick('GOALS_2_3', '2-3 Goals'), pick('GOALS_4_5', '4-5 Goals'), pick('GOALS_6_PLUS', '6+ Goals')], requiredData: ['TEAM_SCORING'], minimumSampleSize: 5 }),
  staticMarket({ id: 'CORRECT_SCORE', predictionMarketKey: 'CORRECT_SCORE', betLabMarketCode: 'CORRECT_SCORE', jsonVariable: 'correctScore', fullName: 'Correct Score', abbreviation: 'CS', family: 'GOALS', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: scoreSelections(5), requiredData: ['TEAM_SCORING'], minimumSampleSize: 5 }),
  staticMarket({ id: 'WINNING_MARGIN', predictionMarketKey: 'WIN_MARGIN', betLabMarketCode: 'WINNING_MARGIN', jsonVariable: 'winningMargin', fullName: 'Winning Margin', abbreviation: 'Win Margin', family: 'RESULT', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: [pick('HOME_BY_1', 'Home by 1'), pick('HOME_BY_2', 'Home by 2'), pick('HOME_BY_3_PLUS', 'Home by 3+'), pick('DRAW', 'Draw'), pick('AWAY_BY_1', 'Away by 1'), pick('AWAY_BY_2', 'Away by 2'), pick('AWAY_BY_3_PLUS', 'Away by 3+')], requiredData: ['TEAM_SCORING'], minimumSampleSize: 5 }),
  staticMarket({ id: 'TEAM_TO_SCORE_FIRST', predictionMarketKey: 'TEAM_TO_SCORE_FIRST', betLabMarketCode: 'FIRST_TEAM_TO_SCORE', jsonVariable: 'firstTeamToScore', fullName: 'First Team to Score', abbreviation: 'First Goal', family: 'EVENTS', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: [pick('HOME', 'Home Team'), pick('AWAY', 'Away Team'), pick('NO_GOAL', 'No Goal')], requiredData: ['TEAM_SCORING'], minimumSampleSize: 5, notes: 'Model prices are time-hazard estimates, not observed event quotations.' }),
  staticMarket({ id: 'TEAM_TO_SCORE_LAST', predictionMarketKey: 'TEAM_TO_SCORE_LAST', betLabMarketCode: 'LAST_TEAM_TO_SCORE', jsonVariable: 'lastTeamToScore', fullName: 'Last Team to Score', abbreviation: 'Last Goal', family: 'EVENTS', model: 'SCORE_MATRIX', period: 'FULL_TIME', selections: [pick('HOME', 'Home Team'), pick('AWAY', 'Away Team'), pick('NO_GOAL', 'No Goal')], requiredData: ['TEAM_SCORING'], minimumSampleSize: 5, notes: 'Model prices are time-hazard estimates, not observed event quotations.' }),

  // Period-specific markets use the full-time Sports model split into first/second-half goal rates.
  overUnderMarket({ id: 'SECOND_HALF_TOTAL_GOALS', predictionMarketKey: 'SECOND_HALF_GOALS_OVER_UNDER', betLabMarketCode: 'SECOND_HALF_TOTAL_GOALS', jsonVariable: 'secondHalfGoalsOverUnder', fullName: 'Second-Half Goals Over/Under', abbreviation: '2H Goals O/U', family: 'PERIOD', model: 'PERIOD_MATRIX', period: 'SECOND_HALF', lines: [0.5, 1.5, 2.5, 3.5], requiredData: ['TEAM_SCORING', 'PERIOD_SPLIT'], minimumSampleSize: 5 }),
  staticMarket({ id: 'SECOND_HALF_RESULT', predictionMarketKey: 'SECOND_HALF_RESULT', betLabMarketCode: 'SECOND_HALF_RESULT', jsonVariable: 'secondHalfResult', fullName: 'Second-Half Result', abbreviation: '2H 1X2', family: 'PERIOD', model: 'PERIOD_MATRIX', period: 'SECOND_HALF', selections: resultSelections(), requiredData: ['TEAM_SCORING', 'PERIOD_SPLIT'], minimumSampleSize: 5 }),
  staticMarket({ id: 'HALF_TIME_FULL_TIME', predictionMarketKey: 'HALF_TIME_FULL_TIME', betLabMarketCode: 'HALF_TIME_FULL_TIME', jsonVariable: 'halfTimeFullTime', fullName: 'Half-Time / Full-Time', abbreviation: 'HT/FT', family: 'PERIOD', model: 'PERIOD_MATRIX', period: 'FULL_TIME', selections: ['HOME','DRAW','AWAY'].flatMap((ht) => ['HOME','DRAW','AWAY'].map((ft) => pick(`${ht}_${ft}`, `${ht === 'HOME' ? '1' : ht === 'DRAW' ? 'X' : '2'} / ${ft === 'HOME' ? '1' : ft === 'DRAW' ? 'X' : '2'}`, `${ht[0]} / ${ft[0]}`))), requiredData: ['TEAM_SCORING', 'PERIOD_SPLIT'], minimumSampleSize: 5 }),
  staticMarket({ id: 'HALF_TIME_GOALS_ODD_EVEN', predictionMarketKey: 'HALF_TIME_GOALS_ODD_EVEN', betLabMarketCode: 'HALF_TIME_GOALS_ODD_EVEN', jsonVariable: 'halfTimeGoalsOddEven', fullName: 'Half-Time Goals Odd/Even', abbreviation: 'HT O/E', family: 'PERIOD', model: 'PERIOD_MATRIX', period: 'FIRST_HALF', selections: [pick('ODD', 'Odd'), pick('EVEN', 'Even')], requiredData: ['TEAM_SCORING', 'PERIOD_SPLIT'], minimumSampleSize: 5 }),
  staticMarket({ id: 'GOAL_IN_BOTH_HALVES', predictionMarketKey: 'GOAL_IN_BOTH_HALVES', betLabMarketCode: 'GOAL_IN_BOTH_HALVES', jsonVariable: 'goalInBothHalves', fullName: 'Goal in Both Halves', abbreviation: 'Goal Both Halves', family: 'PERIOD', model: 'PERIOD_MATRIX', period: 'FULL_TIME', selections: yesNo(), requiredData: ['TEAM_SCORING', 'PERIOD_SPLIT'], minimumSampleSize: 5 }),
  staticMarket({ id: 'HOME_TEAM_TO_SCORE_IN_BOTH_HALVES', predictionMarketKey: 'HOME_TEAM_TO_SCORE_IN_BOTH_HALVES', betLabMarketCode: 'HOME_TEAM_TO_SCORE_IN_BOTH_HALVES', jsonVariable: 'homeTeamToScoreBothHalves', fullName: 'Home Team to Score in Both Halves', abbreviation: 'Home Both Halves', family: 'PERIOD', model: 'PERIOD_MATRIX', period: 'FULL_TIME', selections: yesNo(), requiredData: ['TEAM_SCORING', 'PERIOD_SPLIT'], minimumSampleSize: 5 }),
  staticMarket({ id: 'AWAY_TEAM_TO_SCORE_IN_BOTH_HALVES', predictionMarketKey: 'AWAY_TEAM_TO_SCORE_IN_BOTH_HALVES', betLabMarketCode: 'AWAY_TEAM_TO_SCORE_IN_BOTH_HALVES', jsonVariable: 'awayTeamToScoreBothHalves', fullName: 'Away Team to Score in Both Halves', abbreviation: 'Away Both Halves', family: 'PERIOD', model: 'PERIOD_MATRIX', period: 'FULL_TIME', selections: yesNo(), requiredData: ['TEAM_SCORING', 'PERIOD_SPLIT'], minimumSampleSize: 5 }),
  staticMarket({ id: 'BOTH_TEAMS_TO_SCORE_FIRST_HALF', predictionMarketKey: 'BOTH_TEAMS_TO_SCORE_FIRST_HALF', betLabMarketCode: 'BOTH_TEAMS_TO_SCORE_FIRST_HALF', jsonVariable: 'bothTeamsToScoreFirstHalf', fullName: 'Both Teams to Score - First Half', abbreviation: '1H BTTS', family: 'PERIOD', model: 'PERIOD_MATRIX', period: 'FIRST_HALF', selections: yesNo(), requiredData: ['TEAM_SCORING', 'PERIOD_SPLIT'], minimumSampleSize: 5 }),
  staticMarket({ id: 'BOTH_TEAMS_TO_SCORE_SECOND_HALF', predictionMarketKey: 'BOTH_TEAMS_TO_SCORE_SECOND_HALF', betLabMarketCode: 'BOTH_TEAMS_TO_SCORE_SECOND_HALF', jsonVariable: 'bothTeamsToScoreSecondHalf', fullName: 'Both Teams to Score - Second Half', abbreviation: '2H BTTS', family: 'PERIOD', model: 'PERIOD_MATRIX', period: 'SECOND_HALF', selections: yesNo(), requiredData: ['TEAM_SCORING', 'PERIOD_SPLIT'], minimumSampleSize: 5 }),
  staticMarket({ id: 'MOST_GOALS_HALF', predictionMarketKey: 'MOST_GOALS_HALF', betLabMarketCode: 'HIGHEST_SCORING_HALF', jsonVariable: 'highestScoringHalf', fullName: 'Highest Scoring Half', abbreviation: 'Most Goals Half', family: 'PERIOD', model: 'PERIOD_MATRIX', period: 'FULL_TIME', selections: [pick('FIRST_HALF', 'First Half'), pick('SECOND_HALF', 'Second Half'), pick('EQUAL', 'Tie')], requiredData: ['TEAM_SCORING', 'PERIOD_SPLIT'], minimumSampleSize: 5 }),

  // Expanded statistical markets; only priced when both team aggregates meet data thresholds.
  overUnderMarket({ id: 'HOME_TEAM_CORNERS_OVER_UNDER', predictionMarketKey: 'HOME_TEAM_CORNERS_OVER_UNDER', betLabMarketCode: 'HOME_TEAM_CORNERS_OVER_UNDER', jsonVariable: 'homeTeamCornersOverUnder', fullName: 'Home Team Corners Over/Under', abbreviation: 'Home Corners O/U', family: 'STATISTICS', model: 'COUNT_MODEL', period: 'FULL_TIME', lines: [2.5, 3.5, 4.5, 5.5, 6.5, 7.5], statisticKey: 'corners', requiredData: ['TEAM_STATISTICS'], minimumSampleSize: 5 }),
  overUnderMarket({ id: 'AWAY_TEAM_CORNERS_OVER_UNDER', predictionMarketKey: 'AWAY_TEAM_CORNERS_OVER_UNDER', betLabMarketCode: 'AWAY_TEAM_CORNERS_OVER_UNDER', jsonVariable: 'awayTeamCornersOverUnder', fullName: 'Away Team Corners Over/Under', abbreviation: 'Away Corners O/U', family: 'STATISTICS', model: 'COUNT_MODEL', period: 'FULL_TIME', lines: [2.5, 3.5, 4.5, 5.5, 6.5, 7.5], statisticKey: 'corners', requiredData: ['TEAM_STATISTICS'], minimumSampleSize: 5 }),
  staticMarket({ id: 'TOTAL_CORNERS_ODD_EVEN', predictionMarketKey: 'TOTAL_CORNERS_ODD_EVEN', betLabMarketCode: 'TOTAL_CORNERS_ODD_EVEN', jsonVariable: 'totalCornersOddEven', fullName: 'Total Corners Odd/Even', abbreviation: 'Corners O/E', family: 'STATISTICS', model: 'COUNT_MODEL', period: 'FULL_TIME', selections: [pick('ODD', 'Odd'), pick('EVEN', 'Even')], statisticKey: 'corners', requiredData: ['TEAM_STATISTICS'], minimumSampleSize: 5 }),
  staticMarket({ id: 'CORNER_MATCH_RESULT', predictionMarketKey: 'CORNER_MATCH_RESULT', betLabMarketCode: 'CORNER_RESULT', jsonVariable: 'cornerMatchResult', fullName: 'Most Corners', abbreviation: 'Corners 1X2', family: 'STATISTICS', model: 'COUNT_MODEL', period: 'FULL_TIME', selections: resultSelections(), statisticKey: 'corners', requiredData: ['TEAM_STATISTICS'], minimumSampleSize: 5 }),
  overUnderMarket({ id: 'TOTAL_YELLOW_CARDS_OVER_UNDER', predictionMarketKey: 'TOTAL_YELLOW_CARDS_OVER_UNDER', betLabMarketCode: 'TOTAL_YELLOW_CARDS_OVER_UNDER', jsonVariable: 'totalYellowCardsOverUnder', fullName: 'Total Yellow Cards Over/Under', abbreviation: 'Yellow Cards O/U', family: 'STATISTICS', model: 'COUNT_MODEL', period: 'FULL_TIME', lines: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5], statisticKey: 'yellowCards', requiredData: ['TEAM_STATISTICS'], minimumSampleSize: 5 }),
  overUnderMarket({ id: 'TOTAL_RED_CARDS_OVER_UNDER', predictionMarketKey: 'TOTAL_RED_CARDS_OVER_UNDER', betLabMarketCode: 'TOTAL_RED_CARDS_OVER_UNDER', jsonVariable: 'totalRedCardsOverUnder', fullName: 'Total Red Cards Over/Under', abbreviation: 'Red Cards O/U', family: 'STATISTICS', model: 'COUNT_MODEL', period: 'FULL_TIME', lines: [0.5, 1.5, 2.5], statisticKey: 'redCards', requiredData: ['TEAM_STATISTICS'], minimumSampleSize: 8 }),
  overUnderMarket({ id: 'HOME_TEAM_CARDS_OVER_UNDER', predictionMarketKey: 'HOME_TEAM_CARDS_OVER_UNDER', betLabMarketCode: 'HOME_TEAM_CARDS_OVER_UNDER', jsonVariable: 'homeTeamCardsOverUnder', fullName: 'Home Team Cards Over/Under', abbreviation: 'Home Cards O/U', family: 'STATISTICS', model: 'COUNT_MODEL', period: 'FULL_TIME', lines: [0.5, 1.5, 2.5, 3.5, 4.5], statisticKey: 'cards', requiredData: ['TEAM_STATISTICS'], minimumSampleSize: 5 }),
  overUnderMarket({ id: 'AWAY_TEAM_CARDS_OVER_UNDER', predictionMarketKey: 'AWAY_TEAM_CARDS_OVER_UNDER', betLabMarketCode: 'AWAY_TEAM_CARDS_OVER_UNDER', jsonVariable: 'awayTeamCardsOverUnder', fullName: 'Away Team Cards Over/Under', abbreviation: 'Away Cards O/U', family: 'STATISTICS', model: 'COUNT_MODEL', period: 'FULL_TIME', lines: [0.5, 1.5, 2.5, 3.5, 4.5], statisticKey: 'cards', requiredData: ['TEAM_STATISTICS'], minimumSampleSize: 5 }),
  overUnderMarket({ id: 'HOME_SHOTS_ON_TARGET_OVER_UNDER', predictionMarketKey: 'HOME_SHOTS_ON_TARGET_OVER_UNDER', betLabMarketCode: 'HOME_SHOTS_ON_TARGET_OVER_UNDER', jsonVariable: 'homeShotsOnTargetOverUnder', fullName: 'Home Shots on Target Over/Under', abbreviation: 'Home SOT O/U', family: 'STATISTICS', model: 'COUNT_MODEL', period: 'FULL_TIME', lines: [1.5, 2.5, 3.5, 4.5, 5.5], statisticKey: 'shotsOnTarget', requiredData: ['TEAM_STATISTICS'], minimumSampleSize: 5 }),
  overUnderMarket({ id: 'AWAY_SHOTS_ON_TARGET_OVER_UNDER', predictionMarketKey: 'AWAY_SHOTS_ON_TARGET_OVER_UNDER', betLabMarketCode: 'AWAY_SHOTS_ON_TARGET_OVER_UNDER', jsonVariable: 'awayShotsOnTargetOverUnder', fullName: 'Away Shots on Target Over/Under', abbreviation: 'Away SOT O/U', family: 'STATISTICS', model: 'COUNT_MODEL', period: 'FULL_TIME', lines: [1.5, 2.5, 3.5, 4.5, 5.5], statisticKey: 'shotsOnTarget', requiredData: ['TEAM_STATISTICS'], minimumSampleSize: 5 }),
  staticMarket({ id: 'TOTAL_CARDS_ODD_EVEN', predictionMarketKey: 'TOTAL_CARDS_ODD_EVEN', betLabMarketCode: 'TOTAL_CARDS_ODD_EVEN', jsonVariable: 'totalCardsOddEven', fullName: 'Total Cards Odd/Even', abbreviation: 'Cards O/E', family: 'STATISTICS', model: 'COUNT_MODEL', period: 'FULL_TIME', selections: [pick('ODD', 'Odd'), pick('EVEN', 'Even')], statisticKey: 'cards', requiredData: ['TEAM_STATISTICS'], minimumSampleSize: 5 }),
  staticMarket({ id: 'RED_CARD', predictionMarketKey: 'RED_CARD', betLabMarketCode: 'RED_CARD', jsonVariable: 'redCard', fullName: 'Red Card in Match', abbreviation: 'Red Card', family: 'EVENTS', model: 'COUNT_MODEL', period: 'FULL_TIME', selections: yesNo(), statisticKey: 'redCards', requiredData: ['MATCH_TIMELINE', 'TIMELINE_COVERAGE'], minimumSampleSize: 8, notes: 'Priced only from normalized red-card events when Sports Plays timeline coverage meets the configured sample and coverage thresholds.' }),
  staticMarket({ id: 'PENALTY_AWARDED', predictionMarketKey: 'PENALTY_AWARDED', betLabMarketCode: 'PENALTY_AWARDED', jsonVariable: 'penaltyAwarded', fullName: 'Penalty Awarded', abbreviation: 'Penalty', family: 'EVENTS', model: 'COUNT_MODEL', period: 'FULL_TIME', selections: yesNo(), requiredData: ['MATCH_TIMELINE', 'TIMELINE_COVERAGE'], minimumSampleSize: 8, pricingEnabled: true, notes: 'Priced only from normalized penalty events when Sports Plays timeline coverage meets the configured sample and coverage thresholds.' }),
  staticMarket({ id: 'OWN_GOAL_SCORED', predictionMarketKey: 'OWN_GOAL_SCORED', betLabMarketCode: 'OWN_GOAL_SCORED', jsonVariable: 'ownGoalScored', fullName: 'Own Goal in Match', abbreviation: 'Own Goal', family: 'EVENTS', model: 'COUNT_MODEL', period: 'FULL_TIME', selections: yesNo(), requiredData: ['MATCH_TIMELINE', 'TIMELINE_COVERAGE'], minimumSampleSize: 8, pricingEnabled: true, notes: 'Priced only from explicit normalized own-goal events when Sports Plays timeline coverage meets the configured sample and coverage thresholds.' }),

  // Player markets remain registered but disabled until Sports exposes a reliable pre-match player availability/lineup source and the required per-player event/statistic denominators.
  staticMarket({ id: 'PLAYER_ANYTIME_GOALSCORER', predictionMarketKey: 'PLAYER_ANYTIME_GOALSCORER', betLabMarketCode: 'PLAYER_TO_SCORE_ANYTIME', jsonVariable: 'playerAnytimeGoalscorer', fullName: 'Player to Score Anytime', abbreviation: 'Anytime Scorer', family: 'PLAYER', model: 'PLAYER_EVENT_MODEL', period: 'FULL_TIME', selections: [], requiredData: ['CONFIRMED_LINEUP', 'PLAYER_APPEARANCES', 'PLAYER_GOALS_PER_90'], minimumSampleSize: 8, pricingEnabled: false, notes: 'Not priced without confirmed pre-match player availability and a sufficiently sampled appearance/minute denominator.' }),
  staticMarket({ id: 'PLAYER_FIRST_GOALSCORER', predictionMarketKey: 'PLAYER_FIRST_GOALSCORER', betLabMarketCode: 'PLAYER_FIRST_GOALSCORER', jsonVariable: 'playerFirstGoalscorer', fullName: 'Player First Goalscorer', abbreviation: 'First Scorer', family: 'PLAYER', model: 'PLAYER_EVENT_MODEL', period: 'FULL_TIME', selections: [], requiredData: ['CONFIRMED_LINEUP', 'PLAYER_APPEARANCES', 'PLAYER_GOALS_PER_90', 'GOAL_ORDER_HISTORY'], minimumSampleSize: 8, pricingEnabled: false }),
  staticMarket({ id: 'PLAYER_LAST_GOALSCORER', predictionMarketKey: 'PLAYER_LAST_GOALSCORER', betLabMarketCode: 'PLAYER_LAST_GOALSCORER', jsonVariable: 'playerLastGoalscorer', fullName: 'Player Last Goalscorer', abbreviation: 'Last Scorer', family: 'PLAYER', model: 'PLAYER_EVENT_MODEL', period: 'FULL_TIME', selections: [], requiredData: ['CONFIRMED_LINEUP', 'PLAYER_APPEARANCES', 'PLAYER_GOALS_PER_90', 'GOAL_ORDER_HISTORY'], minimumSampleSize: 8, pricingEnabled: false }),
  staticMarket({ id: 'PLAYER_TO_BE_BOOKED', predictionMarketKey: 'PLAYER_TO_BE_BOOKED', betLabMarketCode: 'PLAYER_TO_BE_BOOKED', jsonVariable: 'playerToBeBooked', fullName: 'Player to Be Booked', abbreviation: 'Player Card', family: 'PLAYER', model: 'PLAYER_EVENT_MODEL', period: 'FULL_TIME', selections: [], requiredData: ['CONFIRMED_LINEUP', 'PLAYER_APPEARANCES', 'PLAYER_CARDS_PER_90'], minimumSampleSize: 8, pricingEnabled: false }),
  staticMarket({ id: 'PLAYER_TO_BE_SENT_OFF', predictionMarketKey: 'PLAYER_TO_BE_SENT_OFF', betLabMarketCode: 'PLAYER_TO_BE_SENT_OFF', jsonVariable: 'playerToBeSentOff', fullName: 'Player to Be Sent Off', abbreviation: 'Player Red Card', family: 'PLAYER', model: 'PLAYER_EVENT_MODEL', period: 'FULL_TIME', selections: [], requiredData: ['CONFIRMED_LINEUP', 'PLAYER_APPEARANCES', 'PLAYER_RED_CARDS_PER_90'], minimumSampleSize: 10, pricingEnabled: false }),
  staticMarket({ id: 'PLAYER_TO_RECORD_ASSIST', predictionMarketKey: 'PLAYER_TO_ASSIST', betLabMarketCode: 'PLAYER_TO_RECORD_ASSIST', jsonVariable: 'playerToRecordAssist', fullName: 'Player to Record an Assist', abbreviation: 'Player Assist', family: 'PLAYER', model: 'PLAYER_EVENT_MODEL', period: 'FULL_TIME', selections: [], requiredData: ['CONFIRMED_LINEUP', 'PLAYER_APPEARANCES', 'PLAYER_ASSISTS_PER_90'], minimumSampleSize: 8, pricingEnabled: false }),
  overUnderMarket({ id: 'PLAYER_SHOTS_OVER_UNDER', predictionMarketKey: 'PLAYER_SHOTS_OVER_UNDER', betLabMarketCode: 'PLAYER_SHOTS_OVER_UNDER', jsonVariable: 'playerShotsOverUnder', fullName: 'Player Shots Over/Under', abbreviation: 'Player Shots', family: 'PLAYER', model: 'PLAYER_EVENT_MODEL', period: 'FULL_TIME', lines: [0.5, 1.5, 2.5, 3.5], statisticKey: 'shots', requiredData: ['CONFIRMED_LINEUP', 'PLAYER_APPEARANCES', 'PLAYER_SHOTS_PER_90'], minimumSampleSize: 8, pricingEnabled: false, notes: 'Sports does not yet expose per-player shots per appearance/minute denominators.' }),
  overUnderMarket({ id: 'PLAYER_SHOTS_ON_TARGET_OVER_UNDER', predictionMarketKey: 'PLAYER_SHOTS_ON_TARGET_OVER_UNDER', betLabMarketCode: 'PLAYER_SHOTS_ON_TARGET_OVER_UNDER', jsonVariable: 'playerShotsOnTargetOverUnder', fullName: 'Player Shots on Target Over/Under', abbreviation: 'Player SOT', family: 'PLAYER', model: 'PLAYER_EVENT_MODEL', period: 'FULL_TIME', lines: [0.5, 1.5, 2.5], statisticKey: 'shotsOnTarget', requiredData: ['CONFIRMED_LINEUP', 'PLAYER_APPEARANCES', 'PLAYER_SHOTS_ON_TARGET_PER_90'], minimumSampleSize: 8, pricingEnabled: false, notes: 'Sports does not yet expose per-player shots on target per appearance/minute denominators.' }),
];

for (const market of FOOTBALL_MARKET_CATALOG) {
  for (const selection of market.selections) Object.freeze(selection);
  Object.freeze(market.selections);
  if (market.lines) Object.freeze(market.lines);
  if (market.requiredData) Object.freeze(market.requiredData);
  Object.freeze(market);
}
Object.freeze(FOOTBALL_MARKET_CATALOG);

function createReadonlyMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const source = new Map<K, V>(entries);
  const view: ReadonlyMap<K, V> = {
    get size() { return source.size; },
    get(key: K) { return source.get(key); },
    has(key: K) { return source.has(key); },
    entries() { return source.entries(); },
    keys() { return source.keys(); },
    values() { return source.values(); },
    forEach(callback, thisArg) { source.forEach((value, key) => callback.call(thisArg, value, key, view)); },
    [Symbol.iterator]() { return source[Symbol.iterator](); },
  };
  return Object.freeze(view);
}

export const FOOTBALL_MARKET_BY_ID = createReadonlyMap(FOOTBALL_MARKET_CATALOG.map((market) => [market.id, market] as const));
export const FOOTBALL_MARKET_BY_PREDICTION_KEY = createReadonlyMap(FOOTBALL_MARKET_CATALOG.map((market) => [market.predictionMarketKey, market] as const));
export const FOOTBALL_MARKET_BY_BET_LAB_CODE = createReadonlyMap(FOOTBALL_MARKET_CATALOG.map((market) => [market.betLabMarketCode, market] as const));

export function canonicalLineSlug(value: number): string {
  return String(Math.round(value * 100) / 100).replace('-', 'MINUS_').replace('.', '_');
}

export function expandCanonicalSelections(market: CanonicalMarketDefinition, homeTeamName = 'Home Team', awayTeamName = 'Away Team'): CanonicalExpandedSelection[] {
  if (market.selectionMode === 'STATIC') {
    return market.selections.map((selection) => {
      let fullName = selection.fullName;
      if (selection.key === 'HOME_WIN') fullName = `${homeTeamName} to Win`;
      if (selection.key === 'AWAY_WIN') fullName = `${awayTeamName} to Win`;
      if (selection.key === 'HOME_OR_DRAW') fullName = `${homeTeamName} or Draw`;
      if (selection.key === 'DRAW_OR_AWAY') fullName = `Draw or ${awayTeamName}`;
      if (selection.key === 'HOME_OR_AWAY') fullName = `${homeTeamName} or ${awayTeamName}`;
      if (selection.key === 'HOME_DNB') fullName = `${homeTeamName} Draw No Bet`;
      if (selection.key === 'AWAY_DNB') fullName = `${awayTeamName} Draw No Bet`;
      return { ...selection, fullName };
    });
  }
  if (market.selectionMode === 'OVER_UNDER') {
    return (market.lines ?? []).flatMap((line) => [
      { key: `OVER_${canonicalLineSlug(line)}`, jsonVariable: `over${String(line).replace('.', '')}`, fullName: `Over ${line}`, abbreviation: `O ${line}`, settlementKey: `OVER_${canonicalLineSlug(line)}`, line },
      { key: `UNDER_${canonicalLineSlug(line)}`, jsonVariable: `under${String(line).replace('.', '')}`, fullName: `Under ${line}`, abbreviation: `U ${line}`, settlementKey: `UNDER_${canonicalLineSlug(line)}`, line },
    ]);
  }
  if (market.selectionMode === 'EUROPEAN_HANDICAP') {
    return (market.selections.length ? market.selections : europeanHandicapSelections(market.lines ?? [])).map((selection) => ({
      ...selection,
      ...(selection.line !== undefined ? { line: selection.line } : {}),
      ...(selection.handicap !== undefined ? { handicap: selection.handicap } : {}),
    }));
  }
  return (market.lines ?? []).flatMap((handicap) => {
    const slug = canonicalLineSlug(handicap);
    const label = handicap > 0 ? `+${handicap}` : String(handicap);
    return [
      { key: `HOME_${slug}`, jsonVariable: `homeHandicap${String(handicap).replace('-', 'Minus').replace('.', '')}`, fullName: `${homeTeamName} (${label})`, abbreviation: `1 ${label}`, settlementKey: `HOME_${slug}`, line: handicap, handicap, side: 'HOME' as const },
      { key: `AWAY_${slug}`, jsonVariable: `awayHandicap${String(handicap).replace('-', 'Minus').replace('.', '')}`, fullName: `${awayTeamName} (${label})`, abbreviation: `2 ${label}`, settlementKey: `AWAY_${slug}`, line: handicap, handicap, side: 'AWAY' as const },
    ];
  });
}

export function validateFootballMarketCatalog(): void {
  const ids = new Set<string>();
  const predictionKeys = new Set<string>();
  const betLabCodes = new Set<string>();
  for (const market of FOOTBALL_MARKET_CATALOG) {
    if (!market.id.trim() || !market.fullName.trim() || !market.jsonVariable.trim()) throw new Error('A canonical football market has incomplete metadata.');
    if (ids.has(market.id)) throw new Error(`Duplicate canonical market ID: ${market.id}`);
    ids.add(market.id);
    if (predictionKeys.has(market.predictionMarketKey)) throw new Error(`Duplicate prediction market key: ${market.predictionMarketKey}`);
    predictionKeys.add(market.predictionMarketKey);
    if (betLabCodes.has(market.betLabMarketCode)) throw new Error(`Duplicate Bet Lab market code: ${market.betLabMarketCode}`);
    betLabCodes.add(market.betLabMarketCode);
    if ((market.selectionMode === 'OVER_UNDER' || market.selectionMode === 'ASIAN_HANDICAP' || market.selectionMode === 'EUROPEAN_HANDICAP') && (!market.lines?.length || market.lines.some((line) => !Number.isFinite(line)))) throw new Error(`Market ${market.id} has invalid line configuration.`);
    const keys = new Set<string>();
    for (const selection of expandCanonicalSelections(market)) {
      if (!selection.key.trim() || !selection.settlementKey.trim()) throw new Error(`Market ${market.id} has an incomplete selection.`);
      if (keys.has(selection.key)) throw new Error(`Duplicate selection ${selection.key} in ${market.id}`);
      keys.add(selection.key);
    }
  }
}

validateFootballMarketCatalog();

