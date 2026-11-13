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



describe('SportsQueueJobProcessorService resilient global bootstrap gates', () => {
  const makeService = () => {
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    const updateOne = jest.fn(() => ({ exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }) }));
    service.bootstrapModel = { updateOne };
    service.logger = { warn: jest.fn(), log: jest.fn() };
    service.getBootstrapState = jest.fn().mockResolvedValue({
      status: 'RUNNING',
      currentPhase: 'MONTHLY_FIXTURE_BOOTSTRAP',
    });
    service.queue = {
      getBootstrapPhaseProgress: jest.fn(),
      getBootstrapPhaseFailures: jest.fn(),
    };
    service.enqueuePhaseGate = jest.fn().mockResolvedValue(undefined);
    service.enqueuePhaseJobs = jest.fn().mockResolvedValue(undefined);
    return { service, updateOne };
  };

  it('records isolated terminal failures and advances instead of failing the global run', async () => {
    const { service, updateOne } = makeService();
    service.queue.getBootstrapPhaseProgress.mockResolvedValue({
      total: 3,
      completed: 2,
      pending: 0,
      processing: 0,
      failed: 0,
      quarantined: 1,
      isComplete: false,
      isSettled: true,
      hasTerminalFailure: true,
    });
    service.queue.getBootstrapPhaseFailures.mockResolvedValue([
      {
        jobKey: 'failed-season-job',
        type: 'FIXTURE_SEASON_BOOTSTRAP',
        status: 'QUARANTINED',
        scope: {
          leagueId: 'fifa.wwcq.ply',
          competitionId: 'competition:fifa.wwcq.ply',
          seasonId: 'season:competition:fifa.wwcq.ply:2026',
        },
        lastError: 'Invalid season date range',
        failedAt: new Date('2026-11-13T08:54:18.000Z'),
      },
    ]);

    await service.processBootstrapPhaseGate({
      bootstrapRunId: 'bootstrap-1',
      bootstrapPhase: 'MONTHLY_FIXTURE_BOOTSTRAP',
    });

    expect(updateOne).toHaveBeenCalledWith(
      { key: 'espn-soccer-v2', runId: 'bootstrap-1' },
      expect.objectContaining({
        $addToSet: {
          phaseFailures: {
            $each: [expect.objectContaining({
              key: 'MONTHLY_FIXTURE_BOOTSTRAP:failed-season-job',
              leagueId: 'fifa.wwcq.ply',
              lastError: 'Invalid season date range',
            })],
          },
        },
      }),
    );
    expect(service.enqueuePhaseJobs).toHaveBeenCalledWith(
      'bootstrap-1',
      'DAILY_FIXTURE_VALIDATION',
    );
    expect(service.enqueuePhaseGate).toHaveBeenCalledWith(
      'bootstrap-1',
      'DAILY_FIXTURE_VALIDATION',
    );
    expect(updateOne).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('marks invalid season date ranges as permanent queue errors', () => {
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    expect(() => service.seasonDateRange({
      id: 'season:bad-range',
      startDate: new Date('2026-10-01T00:00:00.000Z'),
      endDate: new Date('2026-03-01T00:00:00.000Z'),
    })).toThrow(expect.objectContaining({ retryable: false }));
  });

  it('keeps polling while any job in the phase is pending or processing', async () => {
    const { service, updateOne } = makeService();
    service.queue.getBootstrapPhaseProgress.mockResolvedValue({
      total: 3,
      completed: 1,
      pending: 1,
      processing: 1,
      failed: 0,
      quarantined: 0,
      isComplete: false,
      isSettled: false,
      hasTerminalFailure: false,
    });

    await service.processBootstrapPhaseGate({
      bootstrapRunId: 'bootstrap-1',
      bootstrapPhase: 'MONTHLY_FIXTURE_BOOTSTRAP',
    });

    expect(service.enqueuePhaseGate).toHaveBeenCalledWith(
      'bootstrap-1',
      'MONTHLY_FIXTURE_BOOTSTRAP',
    );
    expect(service.enqueuePhaseJobs).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });
});
