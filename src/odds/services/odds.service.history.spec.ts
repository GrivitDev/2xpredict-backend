import { OddsService } from './odds.service';

describe('OddsService calculation history', () => {
  const makeQuery = (value: unknown) => ({
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value),
  });

  it('archives a prior quote before a changed quote is written', async () => {
    const prior = {
      _id: 'odds-row-1',
      eventId: 'fixture-1',
      marketId: 'MATCH_RESULT',
      selectionKey: 'HOME_WIN',
      priceType: 'ESTIMATED',
      pricingSource: 'GRIVIT_MODEL',
      decimalOdds: 2.1,
      fairOdds: 2.2,
      fairProbability: 0.4545,
      sourceDataHash: 'old-source-hash',
      calculationVersion: '2XP-ODDS-4.2.0',
      fixtureSourceRevision: 3,
      sourceRevision: 7,
      updatedAt: new Date('2026-11-20T10:00:00.000Z'),
    };
    const oddsModel = { find: jest.fn(() => makeQuery([prior])) };
    const historyModel = { bulkWrite: jest.fn().mockResolvedValue({}) };
    const service = Object.create(OddsService.prototype) as any;
    service.oddsModel = oddsModel;
    service.oddsHistoryModel = historyModel;

    await service.archiveSupersededPriceRows('fixture-1', [{
      ...prior,
      decimalOdds: 2.0,
      sourceDataHash: 'new-source-hash',
      fixtureSourceRevision: 4,
    }]);

    expect(historyModel.bulkWrite).toHaveBeenCalledTimes(1);
    const operations = historyModel.bulkWrite.mock.calls[0][0];
    expect(operations).toHaveLength(1);
    expect(operations[0].updateOne.filter.snapshotId).toMatch(/^[a-f0-9]{64}$/);
    expect(operations[0].updateOne.update.$setOnInsert).toEqual(expect.objectContaining({
      eventId: 'fixture-1',
      marketId: 'MATCH_RESULT',
      selectionKey: 'HOME_WIN',
      snapshot: prior,
    }));
    expect(operations[0].updateOne.upsert).toBe(true);
  });

  it('does not archive a quote when source generation and price values are unchanged', async () => {
    const prior = {
      _id: 'odds-row-2',
      eventId: 'fixture-1',
      marketId: 'MATCH_RESULT',
      selectionKey: 'DRAW',
      priceType: 'ESTIMATED',
      pricingSource: 'GRIVIT_MODEL',
      decimalOdds: 3.1,
      fairOdds: 3.2,
      fairProbability: 0.3125,
      sourceDataHash: 'same-source-hash',
      calculationVersion: '2XP-ODDS-4.2.0',
      fixtureSourceRevision: 3,
      sourceRevision: 7,
      updatedAt: new Date('2026-11-20T10:00:00.000Z'),
    };
    const oddsModel = { find: jest.fn(() => makeQuery([prior])) };
    const historyModel = { bulkWrite: jest.fn() };
    const service = Object.create(OddsService.prototype) as any;
    service.oddsModel = oddsModel;
    service.oddsHistoryModel = historyModel;

    await service.archiveSupersededPriceRows('fixture-1', [{ ...prior }]);

    expect(historyModel.bulkWrite).not.toHaveBeenCalled();
  });

  it('retains previous prices when the fixture temporarily lacks a participant', async () => {
    const service = Object.create(OddsService.prototype) as any;
    service.logger = { warn: jest.fn() };
    service.sportsRevisions = {
      getCurrentRevision: jest.fn().mockResolvedValue(4),
    };
    service.sportsRead = {
      getMatch: jest.fn().mockResolvedValue({
        fixture: {
          id: 'fixture-1',
          status: { state: 'SCHEDULED' },
          competitors: [{ homeAway: 'HOME', teamId: 'team-home' }],
        },
      }),
    };
    const updateMany = jest.fn(() => ({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 3 }),
    }));
    const deleteMany = jest.fn(() => ({
      exec: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    }));
    service.oddsModel = { updateMany, deleteMany };

    const result = await service.refreshFixture('fixture-1');

    expect(result).toBe(0);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'fixture-1',
        pricingSource: 'GRIVIT_MODEL',
      }),
      {
        $set: expect.objectContaining({
          pricingStatus: 'STALE',
          predictionReady: false,
          staleReason: 'FIXTURE_TEAMS_UNAVAILABLE',
          staleAt: expect.any(Date),
        }),
      },
    );
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('archives prices before deleting them when a fixture becomes ineligible', async () => {
    const prior = {
      _id: 'odds-row-3',
      eventId: 'fixture-1',
      marketId: 'MATCH_RESULT',
      selectionKey: 'AWAY_WIN',
      decimalOdds: 3.8,
      updatedAt: new Date('2026-11-20T10:00:00.000Z'),
    };
    const calls: string[] = [];
    const oddsModel = {
      find: jest.fn(() => makeQuery([prior])),
      deleteMany: jest.fn(() => ({ exec: jest.fn(async () => { calls.push('delete'); return { deletedCount: 1 }; }) })),
    };
    const historyModel = {
      bulkWrite: jest.fn(async () => { calls.push('archive'); return {}; }),
    };
    const service = Object.create(OddsService.prototype) as any;
    service.oddsModel = oddsModel;
    service.oddsHistoryModel = historyModel;

    await service.removeFixturePrices('fixture-1', 3);

    expect(calls).toEqual(['archive', 'delete']);
  });
});