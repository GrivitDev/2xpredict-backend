import type { BetLabMarketQuote } from '../interfaces/bet-lab-market.interface';

type SelectionOutcome = 'WIN' | 'PUSH' | 'LOSE';
type CompatibilitySelection = Pick<BetLabMarketQuote, 'fixture' | 'market' | 'selection'>;

const SCORE_MARKETS = new Set<string>([
  'MATCH_RESULT', 'DOUBLE_CHANCE', 'DRAW_NO_BET', 'TOTAL_GOALS_OVER_UNDER',
  'HOME_TEAM_GOALS_OVER_UNDER', 'AWAY_TEAM_GOALS_OVER_UNDER', 'ASIAN_HANDICAP',
  'BOTH_TEAMS_TO_SCORE', 'FIRST_HALF_TOTAL_GOALS', 'HALF_TIME_RESULT',
]);

const STAT_MARKETS = new Set<string>([
  'TOTAL_CORNERS_OVER_UNDER', 'TOTAL_SHOTS_OVER_UNDER',
  'TOTAL_SHOTS_ON_TARGET_OVER_UNDER', 'TOTAL_CARDS_OVER_UNDER',
  'TOTAL_FOULS_OVER_UNDER', 'TOTAL_OFFSIDES_OVER_UNDER',
]);

const EPSILON = 1e-8;
const SCORE_SEARCH_CEILING = 12;
const STAT_SEARCH_CEILING = 60;

/** Mirrors the frontend's active-catalogue compatibility checks. */
export function findBetLabSelectionCompatibilityError(
  selections: readonly CompatibilitySelection[],
): string | null {
  const byFixture = new Map<string, CompatibilitySelection[]>();
  const marketByFixture = new Map<string, Set<string>>();
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

    const usedMarkets = marketByFixture.get(eventId) ?? new Set<string>();
    if (usedMarkets.has(marketCode)) {
      return `Only one selection is allowed from ${item.market.fullName} for the same match. Remove the current selection before choosing another.`;
    }
    usedMarkets.add(marketCode);
    marketByFixture.set(eventId, usedMarkets);

    const group = byFixture.get(eventId) ?? [];
    group.push(item);
    byFixture.set(eventId, group);
  }

  for (const fixtureSelections of byFixture.values()) {
    const first = fixtureSelections[0];
    const matchResult = fixtureSelections.find((item) => String(item.market.code).toUpperCase() === 'MATCH_RESULT');
    const doubleChance = fixtureSelections.find((item) => String(item.market.code).toUpperCase() === 'DOUBLE_CHANCE');

    if (
      matchResult && doubleChance &&
      String(doubleChance.selection.code).toUpperCase() === 'HOME_OR_AWAY'
    ) {
      return `Home-or-Away (12) cannot be combined with a full-time match-result selection for ${first.fixture.homeTeamName} vs ${first.fixture.awayTeamName}.`;
    }

    const scoreSelections = fixtureSelections.filter((item) =>
      SCORE_MARKETS.has(String(item.market.code).toUpperCase()),
    );
    if (scoreSelections.length && !hasPossibleScoreline(scoreSelections)) {
      return `The selections for ${first.fixture.homeTeamName} vs ${first.fixture.awayTeamName} contradict each other.`;
    }

    const shotSelections = fixtureSelections.filter((item) =>
      ['TOTAL_SHOTS_OVER_UNDER', 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER'].includes(String(item.market.code).toUpperCase()),
    );
    if (shotSelections.length && !hasPossibleShotCounts(shotSelections)) {
      return `The selected shots and shots-on-target outcomes for ${first.fixture.homeTeamName} vs ${first.fixture.awayTeamName} contradict each other.`;
    }
    if (
      scoreSelections.length &&
      shotSelections.length &&
      !hasPossibleSharedScoreAndShotOutcomes(scoreSelections, shotSelections)
    ) {
      return `The selected goals cannot be supported by the shots-on-target outcome for ${first.fixture.homeTeamName} vs ${first.fixture.awayTeamName}.`;
    }

    for (const item of fixtureSelections) {
      const marketCode = String(item.market.code).toUpperCase();
      if (STAT_MARKETS.has(marketCode) && !isValidOverUnderSelection(String(item.selection.code))) {
        return `Invalid ${item.market.fullName} selection for ${first.fixture.homeTeamName} vs ${first.fixture.awayTeamName}.`;
      }
    }
  }

  return null;
}

function hasPossibleScoreline(selections: readonly CompatibilitySelection[]): boolean {
  for (let home = 0; home <= SCORE_SEARCH_CEILING; home += 1) {
    for (let away = 0; away <= SCORE_SEARCH_CEILING; away += 1) {
      for (let halfHome = 0; halfHome <= home; halfHome += 1) {
        for (let halfAway = 0; halfAway <= away; halfAway += 1) {
          let hasWin = false;
          let possible = true;
          for (const item of selections) {
            const outcome = evaluateScoreSelection(item, home, away, halfHome, halfAway);
            if (outcome === 'LOSE') { possible = false; break; }
            if (outcome === 'WIN') hasWin = true;
          }
          if (possible && hasWin) return true;
        }
      }
    }
  }
  return false;
}

function evaluateScoreSelection(
  item: CompatibilitySelection,
  home: number,
  away: number,
  halfHome: number,
  halfAway: number,
): SelectionOutcome {
  const market = String(item.market.code).toUpperCase();
  const code = String(item.selection.code).toUpperCase();
  const line = selectionLineOf(item, code);

  switch (market) {
    case 'MATCH_RESULT':
      return resultOutcome(home, away, code);
    case 'HALF_TIME_RESULT':
      return resultOutcome(halfHome, halfAway, code);
    case 'DOUBLE_CHANCE': {
      const accepted = doubleChanceOutcomes(code);
      return accepted?.has(matchResult(home, away)) ? 'WIN' : 'LOSE';
    }
    case 'DRAW_NO_BET':
      if (home === away) return 'PUSH';
      if (code === 'HOME_DNB') return home > away ? 'WIN' : 'LOSE';
      if (code === 'AWAY_DNB') return away > home ? 'WIN' : 'LOSE';
      return 'LOSE';
    case 'BOTH_TEAMS_TO_SCORE': {
      const bothScored = home > 0 && away > 0;
      if (code === 'YES') return bothScored ? 'WIN' : 'LOSE';
      if (code === 'NO') return bothScored ? 'LOSE' : 'WIN';
      return 'LOSE';
    }
    case 'TOTAL_GOALS_OVER_UNDER':
      return overUnderOutcome(code, line, home + away);
    case 'HOME_TEAM_GOALS_OVER_UNDER':
      return overUnderOutcome(code, line, home);
    case 'AWAY_TEAM_GOALS_OVER_UNDER':
      return overUnderOutcome(code, line, away);
    case 'FIRST_HALF_TOTAL_GOALS':
      return overUnderOutcome(code, line, halfHome + halfAway);
    case 'ASIAN_HANDICAP':
      if (line === null || !Number.isFinite(line)) return 'LOSE';
      if (code.startsWith('HOME_')) return compareWithPush(home + line, away);
      if (code.startsWith('AWAY_')) return compareWithPush(away + line, home);
      return 'LOSE';
    default:
      return 'LOSE';
  }
}

function hasPossibleSharedScoreAndShotOutcomes(
  scoreSelections: readonly CompatibilitySelection[],
  shotSelections: readonly CompatibilitySelection[],
): boolean {
  const scoreCanPass = new Array<boolean>(SCORE_SEARCH_CEILING * 2 + 1).fill(false);
  const scoreCanWin = new Array<boolean>(SCORE_SEARCH_CEILING * 2 + 1).fill(false);

  for (let home = 0; home <= SCORE_SEARCH_CEILING; home += 1) {
    for (let away = 0; away <= SCORE_SEARCH_CEILING; away += 1) {
      for (let halfHome = 0; halfHome <= home; halfHome += 1) {
        for (let halfAway = 0; halfAway <= away; halfAway += 1) {
          let hasWin = false;
          let hasLoss = false;
          for (const item of scoreSelections) {
            const outcome = evaluateScoreSelection(item, home, away, halfHome, halfAway);
            if (outcome === 'LOSE') { hasLoss = true; break; }
            if (outcome === 'WIN') hasWin = true;
          }
          if (!hasLoss) {
            const totalGoals = home + away;
            scoreCanPass[totalGoals] = true;
            if (hasWin) scoreCanWin[totalGoals] = true;
          }
        }
      }
    }
  }

  const shotCanPass = new Array<boolean>(STAT_SEARCH_CEILING + 1).fill(false);
  const shotCanWin = new Array<boolean>(STAT_SEARCH_CEILING + 1).fill(false);
  for (let totalShots = 0; totalShots <= STAT_SEARCH_CEILING; totalShots += 1) {
    for (let onTarget = 0; onTarget <= totalShots; onTarget += 1) {
      let hasWin = false;
      let hasLoss = false;
      for (const item of shotSelections) {
        const isOnTarget = String(item.market.code).toUpperCase() === 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER';
        const value = isOnTarget ? onTarget : totalShots;
        const line = selectionLineOf(item, String(item.selection.code));
        const outcome = overUnderOutcome(String(item.selection.code).toUpperCase(), line, value);
        if (outcome === 'LOSE') { hasLoss = true; break; }
        if (outcome === 'WIN') hasWin = true;
      }
      if (!hasLoss) {
        shotCanPass[onTarget] = true;
        if (hasWin) shotCanWin[onTarget] = true;
      }
    }
  }

  // Goals are shots on target; shots on target cannot exceed total shots.
  for (let goals = 0; goals < scoreCanPass.length; goals += 1) {
    if (!scoreCanPass[goals]) continue;
    for (let onTarget = goals; onTarget < shotCanPass.length; onTarget += 1) {
      if (shotCanPass[onTarget] && (scoreCanWin[goals] || shotCanWin[onTarget])) return true;
    }
  }
  return false;
}

function hasPossibleShotCounts(selections: readonly CompatibilitySelection[]): boolean {
  for (let total = 0; total <= STAT_SEARCH_CEILING; total += 1) {
    for (let onTarget = 0; onTarget <= total; onTarget += 1) {
      let hasWin = false;
      let possible = true;
      for (const item of selections) {
        const value = String(item.market.code).toUpperCase() === 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER' ? onTarget : total;
        const outcome = overUnderOutcome(String(item.selection.code).toUpperCase(), selectionLineOf(item), value);
        if (outcome === 'LOSE') { possible = false; break; }
        if (outcome === 'WIN') hasWin = true;
      }
      if (possible && hasWin) return true;
    }
  }
  return false;
}

function selectionLineOf(item: CompatibilitySelection, code = String(item.selection.code)): number | null {
  const explicit = item.selection.line ?? item.selection.handicap;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
  return parseSelectionLine(code);
}

function parseSelectionLine(code: string): number | null {
  const match = code.toUpperCase().match(/(?:OVER|UNDER)_((?:MINUS_)?\d+_\d+)|^(?:HOME|AWAY)_(MINUS_\d+_\d+|\d+_\d+)$/);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return null;
  const negative = raw.startsWith('MINUS_');
  const parsed = Number(raw.replace(/^MINUS_/, '').replace('_', '.'));
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : null;
}

function isValidOverUnderSelection(code: string): boolean {
  return parseSelectionLine(code) !== null && /^(OVER|UNDER)_/i.test(code);
}

function overUnderOutcome(code: string, line: number | null, value: number): SelectionOutcome {
  if (line === null || !Number.isFinite(line)) return 'LOSE';
  if (code.startsWith('OVER_')) return compareWithPush(value, line);
  if (code.startsWith('UNDER_')) return compareWithPush(line, value);
  return 'LOSE';
}

function compareWithPush(left: number, right: number): SelectionOutcome {
  if (Math.abs(left - right) <= EPSILON) return 'PUSH';
  return left > right ? 'WIN' : 'LOSE';
}

function resultOutcome(home: number, away: number, code: string): SelectionOutcome {
  return matchResult(home, away) === code ? 'WIN' : 'LOSE';
}

function matchResult(home: number, away: number): 'HOME_WIN' | 'DRAW' | 'AWAY_WIN' {
  if (home > away) return 'HOME_WIN';
  if (home < away) return 'AWAY_WIN';
  return 'DRAW';
}

function doubleChanceOutcomes(code: string): Set<string> | null {
  if (code === 'HOME_OR_DRAW') return new Set(['HOME_WIN', 'DRAW']);
  if (code === 'DRAW_OR_AWAY') return new Set(['DRAW', 'AWAY_WIN']);
  if (code === 'HOME_OR_AWAY') return new Set(['HOME_WIN', 'AWAY_WIN']);
  return null;
}
