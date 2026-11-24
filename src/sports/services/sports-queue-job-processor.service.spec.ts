import { SportsQueueJobProcessorService } from './sports-queue-job-processor.service';
import { SportsQueueJobType } from '../interfaces/sports-queue.interface';
import { SPORTS_COLLECTION_SCHEDULE } from '../config/sports-collection-schedule.config';

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

describe('SportsQueueJobProcessorService post-match lifecycle', () => {
  const competition = {
    id: 'competition-1',
    slug: 'eng.1',
    name: 'Premier League',
  } as any;

  const completedFixture = (completedAt?: Date) => ({
    ...fixture(
      'fixture-1',
      'competition-1',
      'team-home',
      new Date('2026-11-10T10:00:00.000Z'),
      'COMPLETED',
    ),
    espnEventId: 'espn-1',
    seasonId: 'season-1',
    seasonYear: 2026,
    ...(completedAt ? { completedAt } : {}),
  }) as any;

  it('anchors post-match Summary freshness to completedAt', async () => {
    const completedAt = new Date('2026-11-10T11:52:00.000Z');
    const match = completedFixture(completedAt);
    const shouldCollectFixtureSummary = jest.fn().mockResolvedValue(true);
    const enqueueIfMissing = jest.fn().mockResolvedValue({ created: true });
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    service.collection = { shouldCollectFixtureSummary };
    service.queue = { enqueueIfMissing };

    await service.enqueueSummary(match, competition, 'scoreboard-refresh');

    expect(shouldCollectFixtureSummary).toHaveBeenCalledWith(
      'espn-1',
      24 * 60 * 60_000,
      5 * 60_000,
      completedAt,
    );
    expect(enqueueIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'MATCH_SUMMARY_COLLECTION',
        scope: expect.objectContaining({
          fixtureId: 'fixture-1',
          expectedCompletedAt: completedAt.toISOString(),
        }),
      }),
    );
  });

  it('forces one post-match Summary collection when completedAt is absent', async () => {
    const match = completedFixture();
    const shouldCollectFixtureSummary = jest.fn().mockResolvedValue(true);
    const enqueueIfMissing = jest.fn().mockResolvedValue({ created: true });
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    service.collection = { shouldCollectFixtureSummary };
    service.queue = { enqueueIfMissing };

    await service.enqueueSummary(match, competition, 'scoreboard-refresh');

    expect(shouldCollectFixtureSummary).toHaveBeenCalledWith(
      'espn-1',
      0,
      5 * 60_000,
      undefined,
    );
    const request = enqueueIfMissing.mock.calls[0][0];
    expect(request.scope).not.toHaveProperty('expectedCompletedAt');
  });

  it('schedules an after-match date refresh when a final fixture has no completedAt', async () => {
    const match = completedFixture();
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    service.collection = {
      getCompetition: jest.fn().mockResolvedValue(competition),
      getFixturesForCompetitionDate: jest.fn().mockResolvedValue([match]),
    };
    service.queue = {
      enqueueIfMissing: jest.fn().mockResolvedValue({ created: true }),
    };
    service.youtubeHighlights = {
      ensureFirstAttempt: jest.fn().mockResolvedValue(undefined),
    };
    service.dateKey = jest.fn().mockReturnValue('2026-11-10');
    service.enqueueSummary = jest.fn().mockResolvedValue(undefined);
    service.enqueuePlays = jest.fn().mockResolvedValue(undefined);
    service.enqueueLeagueNews = jest.fn().mockResolvedValue(undefined);
    service.enqueueMilestone = jest.fn().mockResolvedValue(undefined);
    service.logger = { warn: jest.fn(), debug: jest.fn(), log: jest.fn() };

    await service.scheduleFixtureJobs([match], 'completed-fixture-refresh', true);

    expect(service.enqueueMilestone).toHaveBeenCalledWith(
      'FIXTURE_DAILY_REFRESH',
      expect.objectContaining({
        expectedKickoffAt: match.kickoffAt.toISOString(),
      }),
      'AFTER_MATCH',
      match.kickoffAt.getTime() + 5 * 60_000,
      85,
      expect.stringContaining(':after-match:'),
    );
    const scope = service.enqueueMilestone.mock.calls[0][1];
    expect(scope).not.toHaveProperty('expectedCompletedAt');
  });

  it('accepts a final after-match refresh without expectedCompletedAt', async () => {
    const match = completedFixture();
    const collectDailyFixtures = jest.fn().mockResolvedValue({
      items: [match],
      rejected: [],
      receivedCount: 1,
    });
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    service.collection = {
      getSeason: jest.fn().mockResolvedValue({ isCurrent: true }),
      getFixturesForCompetitionDate: jest.fn().mockResolvedValue([match]),
      collectDailyFixtures,
    };
    service.scheduleFixtureJobs = jest.fn().mockResolvedValue(undefined);

    await service.processDailyScoreboard(
      {
        leagueId: 'eng.1',
        competitionId: 'competition-1',
        seasonId: 'season-1',
        seasonYear: 2026,
        calendarDate: '2026-11-10',
        milestone: 'AFTER_MATCH',
        expectedKickoffAt: match.kickoffAt.toISOString(),
      },
      false,
    );

    expect(collectDailyFixtures).toHaveBeenCalledTimes(1);
    expect(service.scheduleFixtureJobs).toHaveBeenCalledWith(
      [match],
      'daily:2026-11-10',
      true,
      undefined,
    );
  });

  it('rejects a stale after-match refresh when its expected completion time changed', async () => {
    const match = completedFixture(new Date('2026-11-10T11:30:00.000Z'));
    const collectDailyFixtures = jest.fn();
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    service.collection = {
      getSeason: jest.fn().mockResolvedValue({ isCurrent: true }),
      getFixturesForCompetitionDate: jest.fn().mockResolvedValue([match]),
      collectDailyFixtures,
    };
    service.scheduleFixtureJobs = jest.fn();

    await service.processDailyScoreboard(
      {
        leagueId: 'eng.1',
        competitionId: 'competition-1',
        seasonId: 'season-1',
        seasonYear: 2026,
        calendarDate: '2026-11-10',
        milestone: 'AFTER_MATCH',
        expectedKickoffAt: match.kickoffAt.toISOString(),
        expectedCompletedAt: '2026-11-10T11:00:00.000Z',
      },
      false,
    );

    expect(collectDailyFixtures).not.toHaveBeenCalled();
    expect(service.scheduleFixtureJobs).not.toHaveBeenCalled();
  });

  it('does not skip a post-match Summary because of pre-match fallback freshness', async () => {
    const completedAt = new Date('2026-11-10T11:52:00.000Z');
    const match = completedFixture(completedAt);
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    service.collection = {
      getFixture: jest.fn().mockResolvedValue(match),
      getCompetition: jest.fn().mockResolvedValue(competition),
      isFixtureSummaryFallbackFresh: jest.fn().mockResolvedValue(false),
      collectFixtureSummary: jest.fn().mockResolvedValue(match),
    };
    service.logger = { debug: jest.fn(), warn: jest.fn(), log: jest.fn() };

    await service.processMatchSummary({ fixtureId: 'fixture-1' });

    expect(service.collection.isFixtureSummaryFallbackFresh).toHaveBeenCalledWith(
      'espn-1',
      24 * 60 * 60_000,
      completedAt,
    );
    expect(service.collection.collectFixtureSummary).toHaveBeenCalledTimes(1);
  });

  it('does not trust legacy Summary freshness when completedAt is unavailable', async () => {
    const match = completedFixture();
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    service.collection = {
      getFixture: jest.fn().mockResolvedValue(match),
      getCompetition: jest.fn().mockResolvedValue(competition),
      isFixtureSummaryFallbackFresh: jest.fn().mockResolvedValue(true),
      collectFixtureSummary: jest.fn().mockResolvedValue(match),
    };
    service.logger = { debug: jest.fn(), warn: jest.fn(), log: jest.fn() };

    await service.processMatchSummary({ fixtureId: 'fixture-1' });

    expect(service.collection.isFixtureSummaryFallbackFresh).not.toHaveBeenCalled();
    expect(service.collection.collectFixtureSummary).toHaveBeenCalledTimes(1);
  });
});



describe('SportsQueueJobProcessorService YouTube highlight reconciliation', () => {
  it('dispatches the recurring reconciliation job to the YouTube collector', async () => {
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    service.youtubeHighlights = {
      reconcileRecentCompletedFixtures: jest.fn().mockResolvedValue({
        scanned: 2,
        scheduled: 1,
      }),
    };

    await service.process({
      type: SportsQueueJobType.YOUTUBE_HIGHLIGHT_RECONCILIATION,
      scope: {},
    });

    expect(
      service.youtubeHighlights.reconcileRecentCompletedFixtures,
    ).toHaveBeenCalledWith(SPORTS_COLLECTION_SCHEDULE.youtubeHighlights.batchSize);
  });
});



describe('SportsQueueJobProcessorService Grivit pricing horizon', () => {
  it('bounds cross-competition fixture reads to the seven-day pricing horizon', async () => {
    const now = new Date('2026-11-11T11:00:00.000Z');
    const sportsRead = {
      getFixtures: jest.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
    };
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    service.sportsRead = sportsRead;

    await service.getUpcomingCrossCompetitionFixtures(['team-a'], 'league-1', now);

    expect(sportsRead.getFixtures).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-a',
      from: now,
      to: new Date(now.getTime() + 7 * 24 * 60 * 60_000),
      sortOrder: 'ASC',
      retainedOnly: true,
    }));
  });
});