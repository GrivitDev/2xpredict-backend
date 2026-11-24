import { OddsService } from './odds.service';
import { ODDS_CONFIG } from '../config/odds.config';

describe('OddsService stale price preservation', () => {
  it('marks old Grivit prices stale without deleting them when a pricing pass cannot reproduce markets', async () => {
    const updateMany = jest.fn((
      _filter: Record<string, any>,
      _update: Record<string, any>,
    ) => ({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 3 }),
    }));
    const service = new OddsService(
      { updateMany } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const modified = await (service as any).markFixturePricesStale(
      'fixture-1',
      12,
      'NO_MODELS_PRODUCED',
    );

    expect(modified).toBe(3);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'fixture-1',
        pricingSource: 'GRIVIT_MODEL',
      }),
      {
        $set: expect.objectContaining({
          pricingStatus: 'STALE',
          predictionReady: false,
          staleReason: 'NO_MODELS_PRODUCED',
          staleAt: expect.any(Date),
        }),
      },
    );
    const filter = updateMany.mock.calls[0][0] as Record<string, any>;
    expect(filter.$and[0]).toEqual({
      $or: [
        { fixtureSourceRevision: { $lte: 12 } },
        { fixtureSourceRevision: { $exists: false } },
        { fixtureSourceRevision: null },
      ],
    });
    expect(filter.$or).toEqual(expect.arrayContaining([
      { pricingStatus: { $ne: 'STALE' } },
      { predictionReady: true },
      { staleReason: { $ne: 'NO_MODELS_PRODUCED' } },
    ]));
  });

  it('does not expose explicitly stale rows as fresh, even when the fixture revision matches', () => {
    const service = new OddsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const snapshot = (service as any).attachFreshness({
      eventId: 'fixture-1',
      marketId: 'MATCH_RESULT',
      selectionKey: 'HOME',
      priceType: 'ESTIMATED',
      bookmaker: 'Grivit',
      pricingSource: 'GRIVIT_MODEL',
      calculationVersion: ODDS_CONFIG.modelVersion,
      sourceDataHash: 'hash',
      fixtureSourceRevision: 5,
      pricingStatus: 'STALE',
      predictionReady: false,
      updatedAt: new Date(),
    }, 5);

    expect(snapshot.isFresh).toBe(false);
    expect(snapshot.pricingStatus).toBe('STALE');
  });

  it('excludes explicitly stale rows from Odds readiness even when their source revision is current', async () => {
    const eventId = 'fixture-stale';
    const rows = [{
      eventId,
      marketId: 'MATCH_RESULT',
      selectionKey: 'HOME',
      decimalOdds: 2.1,
      predictionReady: false,
      pricingStatus: 'STALE',
      calculationVersion: ODDS_CONFIG.modelVersion,
      priceType: 'ESTIMATED',
      bookmaker: 'Grivit',
      pricingSource: 'GRIVIT_MODEL',
      dataQuality: 0.8,
      sampleSize: 9,
      sourceDataHash: 'old-hash',
      fixtureSourceRevision: 5,
      fairOdds: 2.2,
      fairProbability: 0.45,
      updatedAt: new Date(),
    }];
    const oddsModel = {
      find: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(rows),
      })),
    };
    const sportsRevisions = {
      getCurrentRevisions: jest.fn(async (_entity: string, ids: string[]) =>
        new Map(ids.map((id) => [id, 5])),
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
      expectedSelections: 1,
      staleSelections: 1,
      readySelections: 0,
    }));
  });
});
