import { OddsService } from './odds.service';
import { ODDS_CONFIG } from '../config/odds.config';

describe('OddsService mandatory baseline Grivit pricing', () => {
  it('persists all three prior-only 1X2 prices when team IDs, season history and readiness are unavailable', async () => {
    const fixtureId = 'fixture-without-team-history';
    const fixtureRevision = 0;
    const fixture = {
      id: fixtureId,
      competitionId: 'new-competition',
      kickoffAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      updatedAt: new Date('2026-11-24T07:00:00.000Z'),
      source: {
        collectedAt: new Date('2026-11-24T07:00:00.000Z'),
        providerUpdatedAt: new Date('2026-11-24T07:00:00.000Z'),
      },
      status: { state: 'SCHEDULED', isFinal: false },
      retentionExpiresAt: null,
      periodScores: [],
      competitors: [
        { homeAway: 'HOME', teamId: undefined, score: null },
        { homeAway: 'AWAY', teamId: undefined, score: null },
      ],
    };
    const match = {
      fixture,
      homeTeam: { displayName: 'Home FC' },
      awayTeam: { displayName: 'Away FC' },
      latestOdds: null,
    };

    const modelPrices = [
      { marketId: 'MATCH_RESULT', selectionKey: 'HOME_WIN', fairProbability: 0.45, fairOdds: 2.2222, dataQuality: 0.05, sampleSize: 0, calculationMethod: 'PRIOR_ONLY_SCORE_MATRIX', predictionReady: true, oddsBasis: 'PRIOR_ONLY' },
      { marketId: 'MATCH_RESULT', selectionKey: 'DRAW', fairProbability: 0.30, fairOdds: 3.3333, dataQuality: 0.05, sampleSize: 0, calculationMethod: 'PRIOR_ONLY_SCORE_MATRIX', predictionReady: true, oddsBasis: 'PRIOR_ONLY' },
      { marketId: 'MATCH_RESULT', selectionKey: 'AWAY_WIN', fairProbability: 0.25, fairOdds: 4, dataQuality: 0.05, sampleSize: 0, calculationMethod: 'PRIOR_ONLY_SCORE_MATRIX', predictionReady: true, oddsBasis: 'PRIOR_ONLY' },
    ];

    const service = Object.create(OddsService.prototype) as any;
    const countQuery = {
      exec: jest.fn().mockResolvedValue(0),
    };
    const persistedBatches: any[][] = [];

    service.oddsModel = {
      countDocuments: jest.fn().mockReturnValue(countQuery),
      find: jest.fn(() => ({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      })),
    };
    service.sportsRead = {
      getMatch: jest.fn().mockResolvedValue(match),
      getTeamData: jest.fn().mockResolvedValue(null),
      getHeadToHead: jest.fn().mockResolvedValue(null),
    };
    service.sportsRevisions = {
      getCurrentRevision: jest.fn().mockResolvedValue(fixtureRevision),
    };
    service.sportsReadiness = {
      getFixtureReadiness: jest.fn().mockResolvedValue(null),
    };
    service.pricingEngine = {
      calculate: jest.fn().mockReturnValue(modelPrices),
    };
    service.assertFixtureSourceRevisionUnchanged = jest.fn().mockResolvedValue(undefined);
    service.writePriceDocuments = jest.fn(async (documents: any[]) => {
      persistedBatches.push(documents);
    });

    const persistedCount = await service.refreshFixture(fixtureId);

    expect(persistedCount).toBe(3);
    expect(service.pricingEngine.calculate).toHaveBeenCalledTimes(1);
    expect(service.sportsReadiness.getFixtureReadiness).toHaveBeenCalledTimes(1);
    expect(service.writePriceDocuments).toHaveBeenCalledTimes(1);

    const saved = persistedBatches.flat();
    expect(saved).toHaveLength(3);
    expect(saved.map((row) => row.selectionKey).sort()).toEqual([
      'AWAY_WIN',
      'DRAW',
      'HOME_WIN',
    ]);
    expect(saved.every((row) =>
      row.marketId === 'MATCH_RESULT'
      && row.bookmaker === 'Grivit'
      && row.pricingSource === 'GRIVIT_MODEL'
      && row.priceType === 'ESTIMATED'
      && row.predictionReady === true
      && row.oddsBasis === 'PRIOR_ONLY'
      && row.fairOddsBasis === 'PRIOR'
      && row.sampleSize === 0
      && row.dataQuality === 0.05
      && row.fixtureSourceRevision === fixtureRevision
      && row.calculationVersion === ODDS_CONFIG.modelVersion
      && typeof row.sourceDataHash === 'string'
      && row.sourceDataHash.length > 0,
    )).toBe(true);

    const impliedTotal = saved.reduce((sum, row) => sum + 1 / row.decimalOdds, 0);
    expect(impliedTotal).toBeGreaterThan(1);
    expect(saved.every((row) => row.decimalOdds < row.fairOdds)).toBe(true);
    expect(saved.every((row) => Number.isFinite(row.decimalOdds) && row.decimalOdds >= 1.01)).toBe(true);
  });
});