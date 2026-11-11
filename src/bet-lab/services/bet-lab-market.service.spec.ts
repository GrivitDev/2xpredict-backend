import { BetLabMarketService } from './bet-lab-market.service';

describe('BetLabMarketService fixture pagination', () => {
  const from = '2026-11-11T00:00:00.000Z';
  const to = '2026-11-20T23:59:59.999Z';
  let sportsRead: {
    countFixtures: jest.Mock;
    getFixtures: jest.Mock;
    getFixtureContexts: jest.Mock;
  };
  let oddsRead: { getPricesForFixtures: jest.Mock };
  let service: BetLabMarketService;

  beforeEach(() => {
    sportsRead = {
      countFixtures: jest.fn().mockResolvedValue(47),
      getFixtures: jest.fn()
        .mockResolvedValueOnce({ items: [], nextCursor: 'cursor-page-2' })
        .mockResolvedValueOnce({ items: [], nextCursor: undefined }),
      getFixtureContexts: jest.fn().mockResolvedValue([]),
    };
    oddsRead = {
      getPricesForFixtures: jest.fn().mockResolvedValue([]),
    };
    service = new BetLabMarketService(sportsRead as never, oddsRead as never);
  });

  it('uses the Sports fixture count and preserves cursor pagination filters', async () => {
    const result = await service.listFixtures({ from, to, leagueId: ' league-1 ', page: 2, limit: 10 });

    expect(sportsRead.countFixtures).toHaveBeenCalledTimes(1);
    expect(sportsRead.countFixtures).toHaveBeenCalledWith({
      from: new Date(from),
      to: new Date(to),
      state: 'SCHEDULED',
      competitionId: 'league-1',
      teamId: undefined,
    });

    expect(sportsRead.getFixtures).toHaveBeenCalledTimes(2);
    expect(sportsRead.getFixtures).toHaveBeenNthCalledWith(1, {
      from: new Date(from),
      to: new Date(to),
      state: 'SCHEDULED',
      competitionId: 'league-1',
      teamId: undefined,
      limit: 10,
      cursor: undefined,
    });
    expect(sportsRead.getFixtures).toHaveBeenNthCalledWith(2, {
      from: new Date(from),
      to: new Date(to),
      state: 'SCHEDULED',
      competitionId: 'league-1',
      teamId: undefined,
      limit: 10,
      cursor: 'cursor-page-2',
    });

    expect(result.pagination).toEqual({ page: 2, limit: 10, total: 47, pages: 5 });
  });

  it('reports zero pages when Sports has no matching fixtures', async () => {
    sportsRead.countFixtures.mockResolvedValueOnce(0);
    sportsRead.getFixtures.mockReset().mockResolvedValue({ items: [], nextCursor: undefined });

    const result = await service.listFixtures({ from, to, page: 1, limit: 20 });

    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 0, pages: 0 });
  });
});
