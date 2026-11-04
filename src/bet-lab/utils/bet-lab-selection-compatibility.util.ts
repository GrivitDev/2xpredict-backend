import type { BetLabMarketQuote } from '../interfaces/bet-lab-market.interface';

type SelectionOutcome = 'WIN' | 'PUSH' | 'LOSE';
type CompatibilitySelection = Pick<
  BetLabMarketQuote,
  'fixture' | 'market' | 'selection'
>;

const SCORE_MARKETS = new Set<string>([
  'MATCH_RESULT',
  'DOUBLE_CHANCE',
  'DRAW_NO_BET',
  'TOTAL_GOALS_OVER_UNDER',
  'HOME_TEAM_GOALS_OVER_UNDER',
  'AWAY_TEAM_GOALS_OVER_UNDER',
  'ASIAN_HANDICAP',
  'BOTH_TEAMS_TO_SCORE',
  'FIRST_HALF_TOTAL_GOALS',
  'HALF_TIME_RESULT',
]);

const STAT_MARKETS = new Set<string>([
  'TOTAL_CORNERS_OVER_UNDER',
  'TOTAL_SHOTS_OVER_UNDER',
  'TOTAL_SHOTS_ON_TARGET_OVER_UNDER',
  'TOTAL_CARDS_OVER_UNDER',
  'TOTAL_FOULS_OVER_UNDER',
  'TOTAL_OFFSIDES_OVER_UNDER',
]);

const SCORE_SEARCH_CEILING = 8;
const STAT_SEARCH_CEILING = 40;
const EPSILON = 1e-8;

/**
 * Validates a Bet Lab accumulator by checking whether every selection attached
 * to each fixture can avoid losing together. A push is neutral, as it is in a
 * normal accumulator. At least one selection must win in the shared outcome.
 *
 * Score and goal markets are evaluated against possible full-time and
 * half-time scorelines. Count/statistic markets are evaluated against a shared
 * possible count for their own statistic. Different statistics (for example,
 * corners and fouls) remain independent and can coexist.
 *
 * Returns a user-facing error when a duplicate or contradictory selection is
 * found; returns null when the requested ticket is compatible.
 */
export function findBetLabSelectionCompatibilityError(
  selections: readonly CompatibilitySelection[],
): string | null {
  const byFixture = new Map<string, CompatibilitySelection[]>();
  const seen = new Set<string>();

  for (const item of selections) {
    const eventId = String(item.fixture.eventId);
    const marketCode = String(item.market.code).toUpperCase();
    const selectionCode = String(item.selection.code).toUpperCase();
    const identity = `${eventId}::${marketCode}::${selectionCode}`;

    if (seen.has(identity)) {
      return `The selection "${item.selection.fullName}" has been added more than once.`;
    }
    seen.add(identity);

    const group = byFixture.get(eventId) ?? [];
    group.push(item);
    byFixture.set(eventId, group);
  }

  for (const fixtureSelections of byFixture.values()) {
    const first = fixtureSelections[0];
    const scoreSelections = fixtureSelections.filter((item) =>
      SCORE_MARKETS.has(String(item.market.code).toUpperCase()),
    );

    if (
      scoreSelections.length > 0 &&
      !hasPossibleScoreline(scoreSelections)
    ) {
      return `The selections for ${first.fixture.homeTeamName} vs ${first.fixture.awayTeamName} contradict each other.`;
    }

    const shotSelections = fixtureSelections.filter((item) =>
      ['TOTAL_SHOTS_OVER_UNDER', 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER'].includes(
        String(item.market.code).toUpperCase(),
      ),
    );
    if (shotSelections.length > 0 && !hasPossibleShotCounts(shotSelections)) {
      return `The selected shots and shots-on-target outcomes for ${first.fixture.homeTeamName} vs ${first.fixture.awayTeamName} contradict each other.`;
    }

    const statisticsByMarket = new Map<string, CompatibilitySelection[]>();
    for (const item of fixtureSelections) {
      const marketCode = String(item.market.code).toUpperCase();
      if (
        !STAT_MARKETS.has(marketCode) ||
        marketCode === 'TOTAL_SHOTS_OVER_UNDER' ||
        marketCode === 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER'
      ) continue;
      const group = statisticsByMarket.get(marketCode) ?? [];
      group.push(item);
      statisticsByMarket.set(marketCode, group);
    }

    for (const statisticSelections of statisticsByMarket.values()) {
      if (!hasPossibleStatisticCount(statisticSelections)) {
        return `The selected ${statisticSelections[0].market.fullName} outcomes for ${first.fixture.homeTeamName} vs ${first.fixture.awayTeamName} contradict each other.`;
      }
    }
  }

  return null;
}

function hasPossibleScoreline(
  selections: readonly CompatibilitySelection[],
): boolean {
  for (let homeGoals = 0; homeGoals <= SCORE_SEARCH_CEILING; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= SCORE_SEARCH_CEILING; awayGoals += 1) {
      for (let halfTimeHomeGoals = 0; halfTimeHomeGoals <= homeGoals; halfTimeHomeGoals += 1) {
        for (let halfTimeAwayGoals = 0; halfTimeAwayGoals <= awayGoals; halfTimeAwayGoals += 1) {
          let hasWinningSelection = false;
          let allSelectionsCanCoexist = true;

          for (const item of selections) {
            const outcome = evaluateScoreSelection(
              item,
              homeGoals,
              awayGoals,
              halfTimeHomeGoals,
              halfTimeAwayGoals,
            );
            if (outcome === 'LOSE') {
              allSelectionsCanCoexist = false;
              break;
            }
            if (outcome === 'WIN') hasWinningSelection = true;
          }

          if (allSelectionsCanCoexist && hasWinningSelection) return true;
        }
      }
    }
  }

  return false;
}

function evaluateScoreSelection(
  item: CompatibilitySelection,
  homeGoals: number,
  awayGoals: number,
  halfTimeHomeGoals: number,
  halfTimeAwayGoals: number,
): SelectionOutcome {
  const marketCode = String(item.market.code).toUpperCase();
  const selectionCode = String(item.selection.code).toUpperCase();
  const line = Number(item.selection.line ?? item.selection.handicap);

  switch (marketCode) {
    case 'MATCH_RESULT':
      return resultOutcome(homeGoals, awayGoals, selectionCode);

    case 'HALF_TIME_RESULT':
      return resultOutcome(halfTimeHomeGoals, halfTimeAwayGoals, selectionCode);

    case 'DOUBLE_CHANCE': {
      const result = matchResult(homeGoals, awayGoals);
      const accepted = doubleChanceOutcomes(selectionCode);
      return accepted ? (accepted.has(result) ? 'WIN' : 'LOSE') : 'LOSE';
    }

    case 'DRAW_NO_BET': {
      if (homeGoals === awayGoals) return 'PUSH';
      if (selectionCode === 'HOME_DNB') return homeGoals > awayGoals ? 'WIN' : 'LOSE';
      if (selectionCode === 'AWAY_DNB') return awayGoals > homeGoals ? 'WIN' : 'LOSE';
      return 'LOSE';
    }

    case 'BOTH_TEAMS_TO_SCORE': {
      const bothScored = homeGoals > 0 && awayGoals > 0;
      if (selectionCode === 'YES') return bothScored ? 'WIN' : 'LOSE';
      if (selectionCode === 'NO') return bothScored ? 'LOSE' : 'WIN';
      return 'LOSE';
    }

    case 'TOTAL_GOALS_OVER_UNDER':
      return overUnderOutcome(selectionCode, line, homeGoals + awayGoals);

    case 'HOME_TEAM_GOALS_OVER_UNDER':
      return overUnderOutcome(selectionCode, line, homeGoals);

    case 'AWAY_TEAM_GOALS_OVER_UNDER':
      return overUnderOutcome(selectionCode, line, awayGoals);

    case 'FIRST_HALF_TOTAL_GOALS':
      return overUnderOutcome(
        selectionCode,
        line,
        halfTimeHomeGoals + halfTimeAwayGoals,
      );

    case 'ASIAN_HANDICAP': {
      if (!Number.isFinite(line)) return 'LOSE';
      if (selectionCode.startsWith('HOME_')) {
        return compareWithPush(homeGoals + line, awayGoals);
      }
      if (selectionCode.startsWith('AWAY_')) {
        return compareWithPush(awayGoals + line, homeGoals);
      }
      return 'LOSE';
    }

    default:
      return 'WIN';
  }
}

function hasPossibleShotCounts(
  selections: readonly CompatibilitySelection[],
): boolean {
  // Shots on target are a subset of total shots. Evaluate both markets against
  // one shared, physically possible pair of counts rather than independent totals.
  for (let totalShots = 0; totalShots <= STAT_SEARCH_CEILING; totalShots += 1) {
    for (let shotsOnTarget = 0; shotsOnTarget <= totalShots; shotsOnTarget += 1) {
      let hasWinningSelection = false;
      let allSelectionsCanCoexist = true;

      for (const item of selections) {
        const marketCode = String(item.market.code).toUpperCase();
        const value = marketCode === 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER'
          ? shotsOnTarget
          : totalShots;
        const outcome = overUnderOutcome(
          String(item.selection.code).toUpperCase(),
          Number(item.selection.line),
          value,
        );
        if (outcome === 'LOSE') {
          allSelectionsCanCoexist = false;
          break;
        }
        if (outcome === 'WIN') hasWinningSelection = true;
      }

      if (allSelectionsCanCoexist && hasWinningSelection) return true;
    }
  }

  return false;
}

function hasPossibleStatisticCount(
  selections: readonly CompatibilitySelection[],
): boolean {
  for (let count = 0; count <= STAT_SEARCH_CEILING; count += 1) {
    let hasWinningSelection = false;
    let allSelectionsCanCoexist = true;

    for (const item of selections) {
      const outcome = overUnderOutcome(
        String(item.selection.code).toUpperCase(),
        Number(item.selection.line),
        count,
      );
      if (outcome === 'LOSE') {
        allSelectionsCanCoexist = false;
        break;
      }
      if (outcome === 'WIN') hasWinningSelection = true;
    }

    if (allSelectionsCanCoexist && hasWinningSelection) return true;
  }

  return false;
}

function overUnderOutcome(
  selectionCode: string,
  line: number,
  value: number,
): SelectionOutcome {
  if (!Number.isFinite(line)) return 'LOSE';
  if (selectionCode.startsWith('OVER_')) return compareWithPush(value, line);
  if (selectionCode.startsWith('UNDER_')) return compareWithPush(line, value);
  return 'LOSE';
}

function compareWithPush(left: number, right: number): SelectionOutcome {
  if (Math.abs(left - right) <= EPSILON) return 'PUSH';
  return left > right ? 'WIN' : 'LOSE';
}

function resultOutcome(
  homeGoals: number,
  awayGoals: number,
  selectionCode: string,
): SelectionOutcome {
  return matchResult(homeGoals, awayGoals) === selectionCode ? 'WIN' : 'LOSE';
}

function matchResult(homeGoals: number, awayGoals: number): 'HOME_WIN' | 'DRAW' | 'AWAY_WIN' {
  if (homeGoals > awayGoals) return 'HOME_WIN';
  if (homeGoals < awayGoals) return 'AWAY_WIN';
  return 'DRAW';
}

function doubleChanceOutcomes(selectionCode: string): Set<string> | null {
  switch (selectionCode) {
    case 'HOME_OR_DRAW':
      return new Set(['HOME_WIN', 'DRAW']);
    case 'DRAW_OR_AWAY':
      return new Set(['DRAW', 'AWAY_WIN']);
    case 'HOME_OR_AWAY':
      return new Set(['HOME_WIN', 'AWAY_WIN']);
    default:
      return null;
  }
}
