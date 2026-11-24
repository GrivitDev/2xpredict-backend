import { OddsPricingEngineService } from './odds-pricing-engine.service';

const makeContext = (overrides: Record<string, unknown> = {}) => ({
  match: {
    fixture: {
      id: 'fixture-baseline',
      competitionId: 'competition-new-season',
      competitors: [
        { teamId: 'team:home', homeAway: 'HOME' },
        { teamId: 'team:away', homeAway: 'AWAY' },
      ],
    },
    homeTeam: { displayName: 'Home FC' },
    awayTeam: { displayName: 'Away FC' },
  },
  homeScoring: null,
  awayScoring: null,
  homeAwayRecord: null,
  awayAwayRecord: null,
  competitionScoring: null,
  homeStatistics: null,
  awayStatistics: null,
  homeTeamData: null,
  awayTeamData: null,
  headToHead: null,
  readiness: {
    fixtureEligible: true,
    scoreMatrix: { ready: false },
    periodMatrix: { ready: false },
    teamStatistics: {},
    eventMarkets: {
      redCard: { ready: false },
      penaltyAwarded: { ready: false },
      ownGoal: { ready: false },
    },
  },
  ...overrides,
} as any);

describe('OddsPricingEngineService mandatory progressive Match Result baseline', () => {
  const engine = new OddsPricingEngineService();

  it('always prices all three 1X2 outcomes from priors when no historical information exists', () => {
    const prices = engine.calculate(makeContext());
    const resultPrices = prices.filter((price) => price.marketId === 'MATCH_RESULT');

    expect(resultPrices).toHaveLength(3);
    expect(resultPrices.map((price) => price.selectionKey).sort()).toEqual([
      'AWAY_WIN',
      'DRAW',
      'HOME_WIN',
    ]);
    expect(resultPrices.every((price) => price.predictionReady)).toBe(true);
    expect(resultPrices.every((price) => price.oddsBasis === 'PRIOR_ONLY')).toBe(true);
    expect(resultPrices.every((price) => price.sampleSize === 0)).toBe(true);
    expect(resultPrices.every((price) => price.dataQuality < 0.62)).toBe(true);
    expect(resultPrices.reduce((sum, price) => sum + price.fairProbability, 0)).toBeCloseTo(1, 5);
    expect(resultPrices.every((price) => price.fairOdds > 1)).toBe(true);
  });

  it('uses a single available completed team sample without waiting for the historical minimum', () => {
    const prices = engine.calculate(makeContext({
      homeScoring: {
        fixturesPlayed: 1,
        averageGoalsFor: 3,
        averageGoalsAgainst: 0,
      },
    }));
    const resultPrices = prices.filter((price) => price.marketId === 'MATCH_RESULT');

    expect(resultPrices).toHaveLength(3);
    expect(resultPrices.every((price) => price.predictionReady)).toBe(true);
    expect(resultPrices.every((price) => price.oddsBasis === 'HISTORICAL_ONLY')).toBe(true);
  });

  it('prices a valid home/away fixture even before normalized team IDs are attached', () => {
    const context = makeContext({
      match: {
        fixture: {
          id: 'fixture-with-pending-team-mapping',
          competitionId: 'competition-1',
          competitors: [
            { homeAway: 'HOME' },
            { homeAway: 'AWAY' },
          ],
        },
      },
    });

    const resultPrices = engine.calculate(context).filter((price) => price.marketId === 'MATCH_RESULT');

    expect(resultPrices).toHaveLength(3);
    expect(resultPrices.every((price) => price.oddsBasis === 'PRIOR_ONLY')).toBe(true);
  });

  it('still refuses invalid or ineligible fixtures rather than inventing team identities', () => {
    const noAwayTeam = makeContext({
      match: {
        fixture: {
          id: 'fixture-invalid',
          competitionId: 'competition-1',
          competitors: [{ teamId: 'team:home', homeAway: 'HOME' }],
        },
      },
    });
    expect(engine.calculate(noAwayTeam)).toHaveLength(0);

    const ineligible = makeContext({
      readiness: { fixtureEligible: false },
    });
    expect(engine.calculate(ineligible)).toHaveLength(0);
  });
});
