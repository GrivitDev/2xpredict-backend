import { OddsCenterController } from './odds-center.controller';

describe('OddsCenterController batch reference reads', () => {
  it('loads competitions and teams through two batch reads rather than per-record reads', async () => {
    const fixture = {
      id: 'fixture-1',
      kickoffAt: new Date('2026-11-25T18:00:00.000Z'),
      status: { state: 'SCHEDULED' },
      competitionId: 'competition-1',
      competitors: [
        { teamId: 'team-home', homeAway: 'HOME' },
        { teamId: 'team-away', homeAway: 'AWAY' },
      ],
    };

    const sportsRead = {
      getFixtures: jest.fn().mockResolvedValue({ items: [fixture], nextCursor: undefined }),
      getCompetitionsByIdentifiers: jest.fn().mockResolvedValue([
        { id: 'competition-1', displayName: 'Test League', region: 'EUROPE' },
      ]),
      getTeamsByIdentifiers: jest.fn().mockResolvedValue([
        { id: 'team-home', displayName: 'Home FC' },
        { id: 'team-away', displayName: 'Away FC' },
      ]),
      // The old N+1 methods must no longer be called by this endpoint.
      getCompetition: jest.fn(),
      getTeam: jest.fn(),
    };
    const oddsService = {
      getPricesForFixtures: jest.fn().mockResolvedValue([]),
    };
    const oddsMonitor = { getOverview: jest.fn() };
    const controller = new OddsCenterController(
      sportsRead as any,
      oddsService as any,
      oddsMonitor as any,
    );

    const result = await controller.getOddsCenter(
      '2026-11-24T00:00:00.000Z',
      '2026-11-30T00:00:00.000Z',
    );

    expect(sportsRead.getCompetitionsByIdentifiers).toHaveBeenCalledTimes(1);
    expect(sportsRead.getCompetitionsByIdentifiers).toHaveBeenCalledWith([
      'competition-1',
    ]);
    expect(sportsRead.getTeamsByIdentifiers).toHaveBeenCalledTimes(1);
    expect(sportsRead.getTeamsByIdentifiers).toHaveBeenCalledWith([
      'team-home',
      'team-away',
    ]);
    expect(sportsRead.getCompetition).not.toHaveBeenCalled();
    expect(sportsRead.getTeam).not.toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      competitionName: 'Test League',
      homeTeam: 'Home FC',
      awayTeam: 'Away FC',
    });
  });

  it('does not request reference documents when the fixture page is empty', async () => {
    const sportsRead = {
      getFixtures: jest.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
      getCompetitionsByIdentifiers: jest.fn().mockResolvedValue([]),
      getTeamsByIdentifiers: jest.fn().mockResolvedValue([]),
    };
    const oddsService = {
      getPricesForFixtures: jest.fn().mockResolvedValue([]),
    };
    const controller = new OddsCenterController(
      sportsRead as any,
      oddsService as any,
      {} as any,
    );

    const result = await controller.getOddsCenter(
      '2026-11-24T00:00:00.000Z',
      '2026-11-30T00:00:00.000Z',
    );

    expect(oddsService.getPricesForFixtures).toHaveBeenCalledWith([]);
    expect(sportsRead.getCompetitionsByIdentifiers).toHaveBeenCalledWith([]);
    expect(sportsRead.getTeamsByIdentifiers).toHaveBeenCalledWith([]);
    expect(result.items).toEqual([]);
  });
});
