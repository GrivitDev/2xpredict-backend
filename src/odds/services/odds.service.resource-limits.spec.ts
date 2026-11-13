import { OddsService } from './odds.service';

describe('OddsService database resource limits', () => {
  it('writes market price rows in sequential batches of at most 100 operations', async () => {
    const bulkWrite = jest.fn().mockResolvedValue({ acknowledged: true });
    const service = new OddsService(
      { bulkWrite } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const documents = Array.from({ length: 205 }, (_, index) => ({
      eventId: 'fixture-1',
      marketId: `market-${index}`,
      selectionKey: 'HOME',
      decimalOdds: 2,
      predictionReady: true,
      $unset: { provider: true },
    }));

    await (service as any).writePriceDocuments(documents);

    expect(bulkWrite).toHaveBeenCalledTimes(3);
    expect(bulkWrite.mock.calls.map(([operations]) => operations.length)).toEqual([
      100,
      100,
      5,
    ]);
    expect(bulkWrite.mock.calls.every(([, options]) => options.ordered === false)).toBe(true);
  });

  it('stops when a price batch fails so the durable job can retry the complete snapshot', async () => {
    const failure = new Error('temporary MongoDB write failure');
    const bulkWrite = jest
      .fn()
      .mockResolvedValueOnce({ acknowledged: true })
      .mockRejectedValueOnce(failure);
    const service = new OddsService(
      { bulkWrite } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const documents = Array.from({ length: 205 }, (_, index) => ({
      eventId: 'fixture-1',
      marketId: `market-${index}`,
      selectionKey: 'HOME',
      decimalOdds: 2,
      predictionReady: true,
      $unset: {},
    }));

    await expect((service as any).writePriceDocuments(documents)).rejects.toBe(failure);
    expect(bulkWrite).toHaveBeenCalledTimes(2);
  });
});
