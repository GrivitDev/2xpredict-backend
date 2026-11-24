import { OddsService } from './odds.service';
import { ODDS_CONFIG } from '../config/odds.config';

describe('OddsService prediction readiness lookups', () => {
  it('reports provisional PRIOR_ONLY rows as priced but not prediction-ready', async () => {
    const eventId = 'event-prior-only';
    const currentTime = new Date();
    const priorRows = ['HOME_WIN', 'DRAW', 'AWAY_WIN'].map((selectionKey) => ({
      eventId,
      marketId: 'MATCH_RESULT',
      selectionKey,
      decimalOdds: 2.1,
      predictionReady: false,
      calculationVersion: ODDS_CONFIG.modelVersion,
      priceType: 'ESTIMATED',
      bookmaker: 'Grivit',
      pricingSource: 'GRIVIT_MODEL',
      oddsBasis: 'PRIOR_ONLY',
      dataQuality: 0,
      sampleSize: 0,
      sourceDataHash: 'prior-source-hash',
      fixtureSourceRevision: 3,
      fairOdds: 2.205,
      fairProbability: 0.45,
      updatedAt: currentTime,
    }));
    const oddsModel = {
      find: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(priorRows),
      })),
    };
    const sportsRevisions = {
      getCurrentRevisions: jest.fn(async (_entity: string, ids: string[]) =>
        new Map(ids.map((id) => [id, 3])),
      ),
    };
    const service = new OddsService(
      oddsModel as any,
      {} as any,
      sportsRevisions as any,
      {} as any,
      {} as any,
    );

    const readiness = await service.getPredictionReadinessForEvents([eventId]);

    expect(readiness.get(eventId)).toEqual(expect.objectContaining({
      ready: false,
      expectedSelections: 3,
      pricedSelections: 3,
      readySelections: 0,
      priorOnlySelections: 3,
    }));
  });

  it('uses one bounded Odds query per 100 event IDs', async () => {
    const eventIds = Array.from({ length: 101 }, (_, index) => `event-${index + 1}`);
    const readyEventId = eventIds[0];
    const currentTime = new Date();

    const validGrivitRows = ['HOME_WIN', 'DRAW', 'AWAY_WIN'].map((selectionKey, index) => ({
      eventId: readyEventId,
      marketId: 'MATCH_RESULT',
      selectionKey,
      decimalOdds: [2.1, 3.2, 4.1][index],
      predictionReady: true,
      calculationVersion: ODDS_CONFIG.modelVersion,
      priceType: 'ESTIMATED',
      bookmaker: 'Grivit',
      pricingSource: 'GRIVIT_MODEL',
      oddsBasis: 'PRIOR_ONLY',
      dataQuality: 0.05,
      sampleSize: 0,
      sourceDataHash: 'source-hash',
      fixtureSourceRevision: 7,
      fairOdds: [2.2, 3.36, 4.3][index],
      fairProbability: [0.45, 0.29, 0.23][index],
      externalBookmakerCount: 1,
      updatedAt: currentTime,
    }));

    const oddsModel = {
      find: jest.fn((filter: Record<string, any>) => {
        const requestedIds = filter.eventId.$in as string[];
        const rows = requestedIds.includes(readyEventId)
          ? validGrivitRows
          : [];

        const query = {
          select: jest.fn().mockReturnThis(),
          lean: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue(rows),
        };
        return query;
      }),
    };

    const sportsRevisions = {
      getCurrentRevisions: jest.fn(async (_entity: string, ids: string[]) =>
        new Map(ids.map((id) => [id, 7])),
      ),
    };

    const service = new OddsService(
      oddsModel as any,
      {} as any,
      sportsRevisions as any,
      {} as any,
      {} as any,
    );

    const readiness = await service.getPredictionReadinessForEvents(eventIds);

    expect(oddsModel.find).toHaveBeenCalledTimes(2);
    expect(oddsModel.find.mock.calls.map(([filter]) => filter.eventId.$in.length))
      .toEqual([100, 1]);
    expect(sportsRevisions.getCurrentRevisions).toHaveBeenCalledTimes(2);
    expect(readiness.get(readyEventId)).toEqual(expect.objectContaining({
      ready: true,
      readySelections: 3,
      marketCount: 1,
    }));
    expect(readiness.size).toBe(101);
    expect(readiness.get(eventIds[1])).toEqual(expect.objectContaining({
      ready: false,
      expectedSelections: 0,
      pricedSelections: 0,
      reason: 'No Grivit prices are currently stored for this fixture; the baseline pricing worker will retry.',
    }));
  });
});
