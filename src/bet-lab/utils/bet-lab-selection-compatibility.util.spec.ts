import { findBetLabSelectionCompatibilityError } from './bet-lab-selection-compatibility.util';

const pick = (marketCode: string, selectionCode: string, line?: number) => ({
  fixture: {
    eventId: 'event-1',
    homeTeamName: 'Home FC',
    awayTeamName: 'Away FC',
  },
  market: { code: marketCode, fullName: marketCode },
  selection: { code: selectionCode, fullName: selectionCode, ...(line !== undefined ? { line } : {}) },
}) as any;

describe('Bet Lab selection compatibility', () => {
  it('accepts a compatible result and goals combination', () => {
    expect(
      findBetLabSelectionCompatibilityError([
        pick('MATCH_RESULT', 'HOME_WIN'),
        pick('TOTAL_GOALS_OVER_UNDER', 'OVER_1_5', 1.5),
      ]),
    ).toBeNull();
  });

  it('rejects duplicate market selections on the same fixture', () => {
    const error = findBetLabSelectionCompatibilityError([
      pick('MATCH_RESULT', 'HOME_WIN'),
      pick('MATCH_RESULT', 'DRAW'),
    ]);
    expect(error).toMatch(/Only one selection is allowed/i);
  });

  it('rejects contradictory score outcomes', () => {
    const error = findBetLabSelectionCompatibilityError([
      pick('MATCH_RESULT', 'HOME_WIN'),
      pick('TOTAL_GOALS_OVER_UNDER', 'UNDER_0_5', 0.5),
    ]);
    expect(error).toMatch(/contradict/i);
  });

  it('rejects Home-or-Away combined with a match-result selection', () => {
    const error = findBetLabSelectionCompatibilityError([
      pick('MATCH_RESULT', 'HOME_WIN'),
      pick('DOUBLE_CHANCE', 'HOME_OR_AWAY'),
    ]);
    expect(error).toMatch(/cannot be combined/i);
  });
});
