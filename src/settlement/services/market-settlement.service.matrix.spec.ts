import { SettlementOutcome } from '../enums/settlement-outcome.enum';
import type { SettlementEventFacts } from '../interfaces/settlement-context.interface';
import { MarketSettlementService } from './market-settlement.service';

const freshDate = (): Date => new Date();

const makeFacts = (
  overrides: Partial<SettlementEventFacts> = {},
): SettlementEventFacts => ({
  eventId: 'fixture-1',
  leagueId: 'competition-1',
  homeTeamId: 'team-home',
  awayTeamId: 'team-away',
  homeTeamName: 'Home FC',
  awayTeamName: 'Away FC',
  isFinished: true,
  fixtureState: 'COMPLETED',
  firstHalfComplete: true,
  secondHalfComplete: true,
  currentPeriod: 2,
  homeGoals: 1,
  awayGoals: 0,
  halfTimeHomeGoals: 1,
  halfTimeAwayGoals: 0,
  secondHalfHomeGoals: 0,
  secondHalfAwayGoals: 0,
  periodScoresAvailable: true,
  regulationScoreAvailable: true,
  goalEventsComplete: true,
  eventDetailsAvailable: true,
  timelineCoverageComplete: true,
  homeStats: {
    shots: 10,
    shotsOnTarget: 4,
    corners: 5,
    yellowCards: 2,
    redCards: 0,
    fouls: 11,
    offsides: 1,
  },
  awayStats: {
    shots: 8,
    shotsOnTarget: 3,
    corners: 4,
    yellowCards: 1,
    redCards: 0,
    fouls: 9,
    offsides: 2,
  },
  playerStats: {},
  playerNames: {},
  goals: [
    {
      eventKey: 'goal-1',
      teamId: 'team-home',
      creditedTeamId: 'team-home',
      playerIds: ['player-123'],
      minute: 12,
      order: 0,
      ownGoal: false,
      penalty: false,
    },
  ],
  cards: [
    { playerIds: ['player-home-1'], teamId: 'team-home', red: false, yellow: true, minute: 30 },
    { playerIds: ['player-home-2'], teamId: 'team-home', red: false, yellow: true, minute: 60 },
    { playerIds: ['player-away-1'], teamId: 'team-away', red: false, yellow: true, minute: 70 },
  ],
  penaltiesAwarded: 0,
  ownGoals: 0,
  redCards: 0,
  yellowCards: 3,
  homeStatisticsCollectedAt: freshDate(),
  awayStatisticsCollectedAt: freshDate(),
  settlementBlockers: [],
  sourceDiagnostics: [],
  conflictingStats: [],
  scoreSource: 'SPORTS_FIXTURE',
  sourceFingerprint: 'source-1',
  ...overrides,
});

describe('MarketSettlementService settlement matrix', () => {
  const service = new MarketSettlementService();

  it.each([
    ['MATCH_RESULT', { key: 'HOME_WIN' }, SettlementOutcome.WON],
    ['MATCH_RESULT', { key: 'AWAY_WIN' }, SettlementOutcome.LOST],
    ['BOTH_TEAMS_TO_SCORE', { key: 'NO' }, SettlementOutcome.WON],
    ['BOTH_TEAMS_TO_SCORE', { key: 'YES' }, SettlementOutcome.LOST],
    [
      'TOTAL_GOALS_OVER_UNDER',
      { key: 'OVER', line: 0.5 },
      SettlementOutcome.WON,
    ],
    [
      'ASIAN_TOTAL_GOALS',
      { key: 'OVER', line: 1 },
      SettlementOutcome.PUSH,
    ],
    ['HALF_TIME_RESULT', { key: 'HOME_WIN' }, SettlementOutcome.WON],
    [
      'TOTAL_CORNERS_OVER_UNDER',
      { key: 'OVER', line: 8.5 },
      SettlementOutcome.WON,
    ],
    [
      'TOTAL_CARDS_OVER_UNDER',
      { key: 'OVER', line: 2.5 },
      SettlementOutcome.WON,
    ],
    [
      'TOTAL_SHOTS_OVER_UNDER',
      { key: 'UNDER', line: 19.5 },
      SettlementOutcome.WON,
    ],
  ])(
    'settles %s using its canonical market and selection contract',
    (market, selection, expected) => {
      const result = service.settle(
        market as string,
        selection as { key: string; line?: number },
        makeFacts(),
      );

      expect(result.outcome).toBe(expected);
      expect(result.method).not.toBe('INSUFFICIENT_EVIDENCE');
    },
  );

  it('returns a push for Draw No Bet when the authoritative score is a draw', () => {
    const result = service.settle(
      'DRAW_NO_BET',
      { key: 'HOME_DNB' },
      makeFacts({ homeGoals: 0, awayGoals: 0 }),
    );

    expect(result.outcome).toBe(SettlementOutcome.PUSH);
  });

  it('keeps a period market unresolved when the required period score is absent', () => {
    const result = service.settle(
      'HALF_TIME_RESULT',
      { key: 'HOME_WIN' },
      makeFacts({
        halfTimeHomeGoals: undefined,
        halfTimeAwayGoals: undefined,
        periodScoresAvailable: false,
      }),
    );

    expect(result.outcome).toBe(SettlementOutcome.UNRESOLVED);
    expect(result.reason).toContain('required score for this match period is unavailable');
  });

  it('keeps a statistics market unresolved when Sports confirms extra time but not regulation-only totals', () => {
    const result = service.settle(
      'TOTAL_CORNERS_OVER_UNDER',
      { key: 'OVER', line: 8.5 },
      makeFacts({ afterExtraTime: true }),
    );

    expect(result.outcome).toBe(SettlementOutcome.UNRESOLVED);
    expect(result.reason).toContain('extra time');
  });

  it('does not infer a corner total from stale team statistics', () => {
    const result = service.settle(
      'TOTAL_CORNERS_OVER_UNDER',
      { key: 'OVER', line: 8.5 },
      makeFacts({
        homeStatisticsCollectedAt: new Date(Date.now() - 60 * 60_000),
      }),
    );

    expect(result.outcome).toBe(SettlementOutcome.UNRESOLVED);
    expect(result.reason).toContain('Fresh normalized Sports corner totals');
  });

  it('does not infer a corner total from conflicting normalized snapshots', () => {
    const result = service.settle(
      'TOTAL_CORNERS_OVER_UNDER',
      { key: 'OVER', line: 8.5 },
      makeFacts({ conflictingStats: ['home:corners'] }),
    );

    expect(result.outcome).toBe(SettlementOutcome.UNRESOLVED);
    expect(result.reason).toContain('Conflicting normalized Sports match data');
  });

  it('rejects a line that is not listed in the canonical market catalogue', () => {
    const result = service.settle(
      'TOTAL_GOALS_OVER_UNDER',
      { key: 'OVER', line: 1.25 },
      makeFacts(),
    );

    expect(result.outcome).toBe(SettlementOutcome.UNRESOLVED);
    expect(result.reason).toContain('not supported by the Odds catalogue');
  });

  it('keeps a market outside the canonical catalogue unresolved', () => {
    const result = service.settle(
      'MADE_UP_MARKET',
      { key: 'YES' },
      makeFacts(),
    );

    expect(result.outcome).toBe(SettlementOutcome.UNRESOLVED);
    expect(result.reason).toContain("not present in the Odds module's canonical football market catalogue");
  });
});
