import { SportsDerivedProjectionService } from './sports-derived-projection.service';

function makeQuery<T>(value: T) {
  const query: any = {};
  query.sort = jest.fn(() => query);
  query.select = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = jest.fn().mockResolvedValue(value);
  return query;
}

function createService(official: unknown, fallback: unknown[] = []) {
  const officialQuery = makeQuery(official);
  const fallbackQuery = makeQuery(fallback);
  const service = Object.create(SportsDerivedProjectionService.prototype) as any;
  service.officialStandingsModel = {
    findOne: jest.fn(() => officialQuery),
  };
  service.standingsModel = {
    find: jest.fn(() => fallbackQuery),
  };
  return { service: service as SportsDerivedProjectionService, officialQuery, fallbackQuery };
}

const validSnapshot = (overrides: Record<string, unknown> = {}) => ({
  provider: 'ESPN',
  status: 'AVAILABLE',
  isComplete: true,
  entryCount: 3,
  header: 'Competition Standings',
  sourceCollectedAt: new Date('2026-11-19T12:00:00.000Z'),
  groups: [
    {
      id: 'group-a',
      name: 'Group A',
      entries: [
        {
          teamId: 'team:1',
          teamName: 'Team One',
          position: 1,
          stats: [
            { name: 'gamesPlayed', value: 8, displayValue: '8' },
            { name: 'wins', value: 6, displayValue: '6' },
            { name: 'ties', value: 1, displayValue: '1' },
            { name: 'losses', value: 1, displayValue: '1' },
            { name: 'pointDifferential', value: 12, displayValue: '+12' },
            { name: 'points', value: 19, displayValue: '19' },
            { name: 'rank', value: 1, displayValue: '1' },
          ],
        },
        {
          teamId: 'team:2',
          teamName: 'Team Two',
          position: 2,
          stats: [{ name: 'gamesPlayed', value: 8 }, { name: 'points', value: 15 }],
        },
      ],
    },
    {
      id: 'group-b',
      name: 'Group B',
      entries: [
        {
          teamId: 'team:3',
          teamName: 'Team Three',
          position: 1,
          stats: [{ name: 'gamesPlayed', value: 5 }, { name: 'points', value: 13 }],
        },
      ],
    },
  ],
  ...overrides,
});

describe('SportsDerivedProjectionService official standings read', () => {
  it('prefers complete official ESPN standings and preserves group boundaries in the legacy row array', async () => {
    const fallback = [{ teamId: 'team:fallback', position: 1, metrics: { points: 99 } }];
    const { service, officialQuery, fallbackQuery } = createService(validSnapshot(), fallback);

    const rows = await service.getStandings('competition-1', 'season-1');

    expect(rows).toHaveLength(3);
    expect(rows.map((row: any) => row.teamId)).toEqual(['team:1', 'team:2', 'team:3']);
    expect(rows.map((row: any) => row.groupId)).toEqual(['group-a', 'group-a', 'group-b']);
    expect(rows[0]).toMatchObject({
      source: 'ESPN_OFFICIAL',
      teamName: 'Team One',
      position: 1,
      played: 8,
      won: 6,
      drawn: 1,
      lost: 1,
      goalDifference: 12,
      points: 19,
      metrics: { points: 19, goalDifference: 12 },
    });
    expect(officialQuery.select).toHaveBeenCalledWith(
      'provider status isComplete entryCount groups header sourceCollectedAt lastSuccessfulAt',
    );
    expect(fallbackQuery.exec).not.toHaveBeenCalled();
  });

  it('falls back to calculated standings when the official snapshot is incomplete', async () => {
    const fallback = [{ teamId: 'team:calculated', position: 1, metrics: { points: 6 } }];
    const incomplete = validSnapshot({ isComplete: false });
    const { service, fallbackQuery } = createService(incomplete, fallback);

    await expect(service.getStandings('competition-1', 'season-1')).resolves.toEqual(fallback);
    expect(fallbackQuery.exec).toHaveBeenCalledTimes(1);
  });

  it('falls back when official group entries do not match the persisted entry count', async () => {
    const fallback = [{ teamId: 'team:calculated', position: 1 }];
    const inconsistent = validSnapshot({ entryCount: 4 });
    const { service, fallbackQuery } = createService(inconsistent, fallback);

    await expect(service.getStandings('competition-1', 'season-1')).resolves.toEqual(fallback);
    expect(fallbackQuery.exec).toHaveBeenCalledTimes(1);
  });

  it('uses calculated standings when there is no official snapshot', async () => {
    const fallback = [{ teamId: 'team:calculated', position: 1 }];
    const { service, fallbackQuery } = createService(null, fallback);

    await expect(service.getStandings('competition-1', 'season-1')).resolves.toEqual(fallback);
    expect(fallbackQuery.exec).toHaveBeenCalledTimes(1);
  });
});
