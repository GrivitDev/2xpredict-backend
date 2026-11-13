import { SportsQueueJobProcessorService } from './sports-queue-job-processor.service';

const fixture = (id: string, competitionId: string, teamId: string, kickoffAt: Date, state = 'SCHEDULED') => ({
  id,
  competitionId,
  kickoffAt,
  status: { state, isFinal: state === 'COMPLETED' },
  competitors: [
    { teamId, homeAway: 'HOME' },
    { teamId: `opponent:${id}`, homeAway: 'AWAY' },
  ],
});

describe('SportsQueueJobProcessorService cross-competition repricing reads', () => {
  it('paginates team fixtures, excludes the source competition and unavailable matches, and deduplicates fixtures', async () => {
    const now = new Date('2026-11-11T11:00:00.000Z');
    const shared = fixture('cup-shared', 'cup-1', 'team-a', new Date(now.getTime() + 60_000));
    const nextPageFixture = fixture('cup-next', 'cup-2', 'team-a', new Date(now.getTime() + 120_000));
    const sameCompetition = fixture('league-same', 'league-1', 'team-a', new Date(now.getTime() + 180_000));
    const postponed = fixture('cup-postponed', 'cup-3', 'team-b', new Date(now.getTime() + 240_000), 'POSTPONED');
    const otherTeamFixture = fixture('cup-other-team', 'cup-4', 'team-b', new Date(now.getTime() + 300_000));

    const sportsRead = {
      getFixtures: jest.fn(async (query: { teamId: string; cursor?: string }) => {
        if (query.teamId === 'team-a' && !query.cursor) {
          return { items: [shared, sameCompetition], nextCursor: 'team-a-next' };
        }
        if (query.teamId === 'team-a' && query.cursor === 'team-a-next') {
          return { items: [nextPageFixture], nextCursor: undefined };
        }
        return { items: [shared, postponed, otherTeamFixture], nextCursor: undefined };
      }),
    };
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    service.sportsRead = sportsRead;

    const result = await service.getUpcomingCrossCompetitionFixtures(
      ['team-a', 'team-b'],
      'league-1',
      now,
    );

    expect(result.map((item: any) => item.id).sort()).toEqual(['cup-next', 'cup-other-team', 'cup-shared']);
    expect(sportsRead.getFixtures).toHaveBeenCalledTimes(3);
  });
});

describe('SportsQueueJobProcessorService completed-fixture recovery', () => {
  it('consumes every completed-fixture page sequentially without accumulating pages', async () => {
    const firstPage = {
      items: [fixture('fixture-3', 'competition-1', 'team-a', new Date('2026-11-03T00:00:00.000Z'), 'COMPLETED')],
      nextCursor: 'cursor-1',
    };
    const secondPage = {
      items: [fixture('fixture-2', 'competition-1', 'team-a', new Date('2026-11-02T00:00:00.000Z'), 'COMPLETED')],
      nextCursor: 'cursor-2',
    };
    const thirdPage = {
      items: [fixture('fixture-1', 'competition-1', 'team-a', new Date('2026-11-01T00:00:00.000Z'), 'COMPLETED')],
      nextCursor: undefined,
    };
    const pages = [firstPage, secondPage, thirdPage];
    const collection = {
      getCompletedFixturesPage: jest.fn(async () => pages.shift()!),
    };
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    service.collection = collection;

    const handled: string[] = [];
    const result = await service.forEachCompletedFixturePage(
      async (items: Array<{ id: string }>) => {
        handled.push(...items.map((item) => item.id));
      },
      { competitionId: 'competition-1', seasonId: 'season-1' },
    );

    expect(result).toBe(3);
    expect(handled).toEqual(['fixture-3', 'fixture-2', 'fixture-1']);
    expect(collection.getCompletedFixturesPage).toHaveBeenNthCalledWith(1, {
      competitionId: 'competition-1',
      seasonId: 'season-1',
      limit: 100,
    });
    expect(collection.getCompletedFixturesPage).toHaveBeenNthCalledWith(2, {
      competitionId: 'competition-1',
      seasonId: 'season-1',
      limit: 100,
      cursor: 'cursor-1',
    });
    expect(collection.getCompletedFixturesPage).toHaveBeenNthCalledWith(3, {
      competitionId: 'competition-1',
      seasonId: 'season-1',
      limit: 100,
      cursor: 'cursor-2',
    });
  });

  it('stops after an empty final page and reports zero processed fixtures', async () => {
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    service.collection = {
      getCompletedFixturesPage: jest.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
    };
    const handler = jest.fn();

    await expect(service.forEachCompletedFixturePage(handler)).resolves.toBe(0);
    expect(handler).not.toHaveBeenCalled();
    expect(service.collection.getCompletedFixturesPage).toHaveBeenCalledTimes(1);
  });
});
