import { FOOTBALL_MARKET_CATALOG } from '../catalog/football-market-catalog';
import { OddsPricingEngineService } from './odds-pricing-engine.service';

const makeReadiness = (overrides: Record<string, unknown> = {}) => ({
  fixtureId: 'fixture-1',
  competitionId: 'competition-1',
  checkedAt: new Date(),
  fixtureEligible: true,
  scoreMatrix: { ready: false },
  periodMatrix: { ready: false },
  goalOrderMarkets: { ready: false },
  teamStatistics: {
    corners: { ready: true },
    shots: { ready: false },
    shotsOnTarget: { ready: false },
    cards: { ready: false },
    yellowCards: { ready: false },
    redCards: { ready: false },
    fouls: { ready: false },
    offsides: { ready: false },
  },
  timeline: { ready: false },
  eventMarkets: {
    redCard: { ready: false },
    penaltyAwarded: { ready: false },
    ownGoal: { ready: false },
  },
  playerMarkets: { pricingSupported: false },
  sourceComputedAt: {},
  ...overrides,
}) as any;

const makeStatAggregate = () => ({
  fixturesWithStatistics: 10,
  statistics: [
    { key: 'wonCorners', name: 'Corners', average: 5.1, sampleSize: 10 },
    { key: 'totalShots', name: 'Shots', average: 12.2, sampleSize: 10 },
    { key: 'shotsOnTarget', name: 'Shots on Target', average: 4.4, sampleSize: 10 },
    { key: 'yellowCards', name: 'Yellow Cards', average: 1.8, sampleSize: 10 },
    { key: 'redCards', name: 'Red Cards', average: 0.1, sampleSize: 10 },
    { key: 'foulsCommitted', name: 'Fouls', average: 11.5, sampleSize: 10 },
    { key: 'offsides', name: 'Offsides', average: 1.7, sampleSize: 10 },
  ],
});

describe('OddsPricingEngineService Sports readiness integration', () => {
  const engine = new OddsPricingEngineService();

  it('prices only statistics whose individual Sports readiness is approved', () => {
    const context = {
      match: {
        fixture: {
          id: 'fixture-1',
          competitionId: 'competition-1',
          competitors: [
            { teamId: 'team:home', homeAway: 'HOME' },
            { teamId: 'team:away', homeAway: 'AWAY' },
          ],
        },
      },
      homeScoring: null,
      awayScoring: null,
      homeAwayRecord: null,
      awayAwayRecord: null,
      competitionScoring: { fixturesPlayed: 12, eventMetrics: { timelineCoverageMatches: 0 } },
      homeStatistics: makeStatAggregate(),
      awayStatistics: makeStatAggregate(),
      homeTeamData: null,
      awayTeamData: null,
      headToHead: null,
      readiness: makeReadiness(),
    } as any;

    const prices = engine.calculate(context);
    const marketIds = [...new Set(prices.map((price) => price.marketId))];

    expect(marketIds.length).toBeGreaterThan(0);
    expect(marketIds.every((marketId) => marketId.includes('CORNER'))).toBe(true);
    expect(marketIds).not.toContain('TOTAL_SHOTS_OVER_UNDER');
    expect(marketIds).not.toContain('RED_CARD');
  });

  it('does not price period markets without observed period readiness', () => {
    const readiness = makeReadiness({
      scoreMatrix: { ready: true },
      periodMatrix: { ready: false },
    });
    const isMarketReady = (engine as any).isMarketReady.bind(engine);
    const fullTime = FOOTBALL_MARKET_CATALOG.find((market) => market.id === 'MATCH_RESULT')!;
    const firstHalf = FOOTBALL_MARKET_CATALOG.find((market) => market.id === 'FIRST_HALF_TOTAL_GOALS')!;

    expect(isMarketReady(fullTime, readiness)).toBe(true);
    expect(isMarketReady(firstHalf, readiness)).toBe(false);
  });

  it('uses separate readiness decisions for each timeline event market', () => {
    const readiness = makeReadiness({
      eventMarkets: {
        redCard: { ready: true },
        penaltyAwarded: { ready: false },
        ownGoal: { ready: false },
      },
    });
    const isMarketReady = (engine as any).isMarketReady.bind(engine);

    expect(isMarketReady(FOOTBALL_MARKET_CATALOG.find((market) => market.id === 'RED_CARD')!, readiness)).toBe(true);
    expect(isMarketReady(FOOTBALL_MARKET_CATALOG.find((market) => market.id === 'PENALTY_AWARDED')!, readiness)).toBe(false);
    expect(isMarketReady(FOOTBALL_MARKET_CATALOG.find((market) => market.id === 'OWN_GOAL_SCORED')!, readiness)).toBe(false);
  });
});
