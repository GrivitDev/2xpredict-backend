import { OddsService } from './odds.service';
import { ODDS_CONFIG } from '../config/odds.config';

describe('OddsService prediction readiness lookups', () => {
  it('uses one bounded Odds query per 100 event IDs', async () => {
    const eventIds = Array.from({ length: 101 }, (_, index) => `event-${index + 1}`);
    const readyEventId = eventIds[0];
    const currentTime = new Date();

    const validGrivitRow = {
      eventId: readyEventId,
      marketId: 'FT_1X2',
      selectionKey: 'HOME',
      decimalOdds: 2.1,
      predictionReady: true,
      calculationVersion: ODDS_CONFIG.modelVersion,
      priceType: 'ESTIMATED',
      bookmaker: 'Grivit',
      pricingSource: 'GRIVIT_MODEL',
      dataQuality: 0.8,
      sampleSize: ODDS_CONFIG.minimumHistoricalSampleSize,
      sourceDataHash: 'source-hash',
      fixtureSourceRevision: 7,
      fairOdds: 2.2,
      fairProbability: 0.45,
      externalBookmakerCount: 1,
      updatedAt: currentTime,
    };

    const oddsModel = {
      find: jest.fn((filter: Record<string, any>) => {
        const requestedIds = filter.eventId.$in as string[];
        const rows = requestedIds.includes(readyEventId)
          ? [validGrivitRow]
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
      readySelections: 1,
      marketCount: 1,
    }));
    expect(readiness.size).toBe(101);
    expect(readiness.get(eventIds[1])).toEqual(expect.objectContaining({
      ready: false,
      reason: 'No market currently has sufficient Sports historical data for a Grivit price.',
    }));
  });
});
