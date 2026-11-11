import { SettlementOutcome } from '../enums/settlement-outcome.enum';
import type { SettlementEventFacts } from '../interfaces/settlement-context.interface';
import { MarketSettlementService } from './market-settlement.service';

const makeFacts = (overrides: Partial<SettlementEventFacts> = {}): SettlementEventFacts => ({
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
  homeGoals: 1,
  awayGoals: 0,
  periodScoresAvailable: false,
  goalEventsComplete: false,
  eventDetailsAvailable: false,
  timelineCoverageComplete: false,
  homeStats: { shots: 10 },
  awayStats: { shots: 8 },
  playerStats: {},
  playerNames: {},
  goals: [],
  cards: [],
  settlementBlockers: [],
  sourceDiagnostics: [],
  conflictingStats: [],
  homeStatisticsCollectedAt: new Date(),
  awayStatisticsCollectedAt: new Date(),
  sourceFingerprint: 'source-1',
  ...overrides,
});

describe('MarketSettlementService authoritative evidence requirements', () => {
  const service = new MarketSettlementService();
  const selection = { key: 'OVER', line: 15.5 };

  it('keeps a full-time statistics market unresolved when either team snapshot is stale', () => {
    const staleFacts = makeFacts({
      homeStatisticsCollectedAt: new Date(Date.now() - 60 * 60_000),
    });

    const result = service.settle('TOTAL_SHOTS_OVER_UNDER', selection, staleFacts);

    expect(result.outcome).toBe(SettlementOutcome.UNRESOLVED);
    expect(result.method).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('keeps a statistics market unresolved when relevant normalized values conflict', () => {
    const conflictingFacts = makeFacts({
      conflictingStats: ['home:shots'],
    });

    const result = service.settle('TOTAL_SHOTS_OVER_UNDER', selection, conflictingFacts);

    expect(result.outcome).toBe(SettlementOutcome.UNRESOLVED);
    expect(result.reason).toContain('Conflicting normalized Sports match data');
  });

  it('settles from fresh, conflict-free normalized statistics', () => {
    const validFacts = makeFacts();

    const result = service.settle('TOTAL_SHOTS_OVER_UNDER', selection, validFacts);

    expect(result.outcome).toBe(SettlementOutcome.WON);
    expect(result.method).toBe('TOTAL_SHOTS_OVER_UNDER_BOX_SCORE');
  });

  it('blocks all market grading when authoritative fixture facts contain a conflict', () => {
    const blockedFacts = makeFacts({
      settlementBlockers: ['Sports period scores do not reconcile with the official final fixture score.'],
    });

    const result = service.settle('TOTAL_SHOTS_OVER_UNDER', selection, blockedFacts);

    expect(result.outcome).toBe(SettlementOutcome.UNRESOLVED);
    expect(result.evidence?.blockers).toEqual(blockedFacts.settlementBlockers);
  });
});
