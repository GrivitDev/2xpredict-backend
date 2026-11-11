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
