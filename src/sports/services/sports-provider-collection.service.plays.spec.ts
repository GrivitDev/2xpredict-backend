import { SportsProviderCollectionService } from './sports-provider-collection.service';

describe('SportsProviderCollectionService Plays no-data handling', () => {
  const input = {
    fixtureId: 'fixture-1',
    leagueId: 'esp.copa_del_rey',
    eventId: 'event-1',
    competitionId: 'event-1',
  };

  it('returns a no-data result when Core and Summary both complete without timeline events', async () => {
    const espn = {
      getMatchPlays: jest.fn().mockResolvedValue({
        items: [],
        pageCount: 1,
        totalCount: 0,
        endpoint: '/plays',
        rawResponse: { count: 0, items: [] },
      }),
      getMatchSummary: jest.fn().mockResolvedValue({
        plays: [],
        keyEvents: [],
        commentary: [],
      }),
    };
    const normalizer = {
      normalizeMatchTimeline: jest.fn().mockReturnValue([]),
      normalizeSummaryTimeline: jest.fn().mockReturnValue([]),
    };
    const service = new SportsProviderCollectionService(espn as any, normalizer as any);

    const result = await service.collectMatchPlays(input);

    expect(result.items).toEqual([]);
    expect(result.noDataReason).toContain('no usable timeline events');
    expect(result.receivedCount).toBe(0);
  });

  it('preserves a Core transport error when Summary also has no timeline', async () => {
    const coreError = new Error('ESPN request timed out');
    const espn = {
      getMatchPlays: jest.fn().mockRejectedValue(coreError),
      getMatchSummary: jest.fn().mockResolvedValue({ plays: [], keyEvents: [] }),
    };
    const normalizer = {
      normalizeMatchTimeline: jest.fn().mockReturnValue([]),
      normalizeSummaryTimeline: jest.fn().mockReturnValue([]),
    };
    const service = new SportsProviderCollectionService(espn as any, normalizer as any);

    await expect(service.collectMatchPlays(input)).rejects.toBe(coreError);
  });
});
