import { SportsProviderCollectionService } from './sports-provider-collection.service';

describe('SportsProviderCollectionService date-scoped live scoreboard', () => {
  it('uses the requested calendar date instead of the unfiltered live endpoint', async () => {
    const espn = {
      getDailyScoreboard: jest.fn().mockResolvedValue({ events: [] }),
      getDateScopedLiveScoreboard: jest.fn().mockResolvedValue({ events: [] }),
      getLiveScoreboard: jest.fn().mockResolvedValue({ events: [] }),
    };
    const normalizer = {
      normalizeFixture: jest.fn(),
    };
    const service = new SportsProviderCollectionService(
      espn as any,
      normalizer as any,
    );

    const result = await service.collectLiveScoreboard(
      'eng.1',
      { competitionId: 'competition-1', seasonId: 'season-1', seasonYear: 2026 },
      '2026-11-20',
    );

    expect(espn.getDateScopedLiveScoreboard).toHaveBeenCalledWith(
      'eng.1',
      '2026-11-20',
    );
    expect(espn.getLiveScoreboard).not.toHaveBeenCalled();
    expect(result.endpoint).toBe('/scoreboard?dates=20261120');
  });

  it('rejects a malformed date instead of silently switching to the current live scoreboard', async () => {
    const espn = {
      getDailyScoreboard: jest.fn(),
      getDateScopedLiveScoreboard: jest.fn(),
      getLiveScoreboard: jest.fn(),
    };
    const service = new SportsProviderCollectionService(
      espn as any,
      {} as any,
    );

    await expect(
      service.collectLiveScoreboard(
        'eng.1',
        { competitionId: 'competition-1' },
        '20-11-2026',
      ),
    ).rejects.toThrow('Invalid live scoreboard date');
    expect(espn.getDailyScoreboard).not.toHaveBeenCalled();
    expect(espn.getDateScopedLiveScoreboard).not.toHaveBeenCalled();
    expect(espn.getLiveScoreboard).not.toHaveBeenCalled();
  });

  it('retains the legacy unfiltered endpoint only when no date is supplied', async () => {
    const espn = {
      getDailyScoreboard: jest.fn(),
      getDateScopedLiveScoreboard: jest.fn(),
      getLiveScoreboard: jest.fn().mockResolvedValue({ events: [] }),
    };
    const service = new SportsProviderCollectionService(
      espn as any,
      {} as any,
    );

    const result = await service.collectLiveScoreboard(
      'eng.1',
      { competitionId: 'competition-1' },
    );

    expect(espn.getLiveScoreboard).toHaveBeenCalledTimes(1);
    expect(espn.getDailyScoreboard).not.toHaveBeenCalled();
    expect(result.endpoint).toBe('/scoreboard');
  });
});
