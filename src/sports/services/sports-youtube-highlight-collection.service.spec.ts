import { SportsYoutubeHighlightCollectionService } from './sports-youtube-highlight-collection.service';
import { SportsQueueJobType } from '../interfaces/sports-queue.interface';

describe('SportsYoutubeHighlightCollectionService reliability', () => {
  afterEach(() => jest.useRealTimers());

  it('does not query MongoDB when the YouTube API key is not active', async () => {
    const service = Object.create(
      SportsYoutubeHighlightCollectionService.prototype,
    ) as any;
    service.youtube = { isEnabled: jest.fn().mockReturnValue(false) };
    service.fixtureModel = { aggregate: jest.fn() };

    await expect(service.reconcileRecentCompletedFixtures()).resolves.toEqual({
      scanned: 0,
      scheduled: 0,
    });
    expect(service.fixtureModel.aggregate).not.toHaveBeenCalled();
  });

  it('reconciles eligible recent completed fixtures and retryable highlight records', async () => {
    const rows = [
      {
        id: 'fixture-1',
        competitionId: 'competition-1',
        kickoffAt: new Date('2026-11-16T10:00:00.000Z'),
        status: { state: 'COMPLETED', isFinal: true },
      },
      {
        id: 'fixture-2',
        competitionId: 'competition-2',
        kickoffAt: new Date('2026-11-16T11:00:00.000Z'),
        status: { state: 'COMPLETED', isFinal: true },
      },
    ];
    const aggregateQuery = { exec: jest.fn().mockResolvedValue(rows) };
    const service = Object.create(
      SportsYoutubeHighlightCollectionService.prototype,
    ) as any;
    service.youtube = { isEnabled: jest.fn().mockReturnValue(true) };
    service.fixtureModel = { aggregate: jest.fn().mockReturnValue(aggregateQuery) };
    service.ensureFirstAttempt = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    service.logger = { log: jest.fn() };

    await expect(service.reconcileRecentCompletedFixtures(25)).resolves.toEqual({
      scanned: 2,
      scheduled: 1,
    });
    expect(service.fixtureModel.aggregate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          $match: expect.objectContaining({
            kickoffAt: expect.objectContaining({ $gte: expect.any(Date), $lte: expect.any(Date) }),
          }),
        }),
        expect.objectContaining({
          $lookup: expect.objectContaining({ from: 'sports_youtube_highlights' }),
        }),
      ]),
    );
    expect(service.ensureFirstAttempt).toHaveBeenNthCalledWith(1, rows[0]);
    expect(service.ensureFirstAttempt).toHaveBeenNthCalledWith(2, rows[1]);
  });


  it('reopens a previous quota-terminal row without charging an attempt again', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-16T10:00:00.000Z'));
    const fixture = {
      id: 'fixture-1',
      competitionId: 'competition-1',
      kickoffAt: new Date('2026-11-16T08:00:00.000Z'),
      status: { state: 'COMPLETED', isFinal: true },
    };
    const query = (value: unknown) => ({
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(value),
    });
    const updateOne = jest.fn(() => ({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    }));
    const service = Object.create(
      SportsYoutubeHighlightCollectionService.prototype,
    ) as any;
    service.youtube = { isEnabled: jest.fn().mockReturnValue(true) };
    service.competitionModel = {
      findOne: jest.fn(() => query({ slug: 'eng.1' })),
    };
    service.highlightModel = {
      findOne: jest.fn(() => query({
        status: 'FAILED',
        retryCount: 1,
        homeTeam: 'Arsenal',
        awayTeam: 'Chelsea',
        error: 'YouTube daily search quota is exhausted.',
      })),
      updateOne,
    };
    service.queue = { hasActiveFixtureJob: jest.fn().mockResolvedValue(false) };
    service.enqueueAttempt = jest.fn().mockResolvedValue(true);

    await expect(service.ensureFirstAttempt(fixture)).resolves.toBe(true);
    expect(updateOne).toHaveBeenCalledWith(
      { fixtureId: 'fixture-1', status: 'FAILED' },
      {
        $set: {
          status: 'RETRY',
          retryCount: 0,
          error: 'Resuming a previously quota-paused highlight search.',
          nextRetryAt: null,
        },
      },
    );
    expect(service.enqueueAttempt).toHaveBeenCalledWith(fixture, 'eng.1', 1);
  });

  it('reopens a legacy missing-team-name failure and reuses the same attempt', async () => {
    const fixture = {
      id: 'fixture-recover-team-data',
      competitionId: 'competition-1',
      kickoffAt: new Date('2026-11-16T08:00:00.000Z'),
      status: { state: 'COMPLETED', isFinal: true },
    };
    const query = (value: unknown) => ({
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(value),
    });
    const updateOne = jest.fn(() => ({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    }));
    const service = Object.create(
      SportsYoutubeHighlightCollectionService.prototype,
    ) as any;
    service.youtube = { isEnabled: jest.fn().mockReturnValue(true) };
    service.competitionModel = {
      findOne: jest.fn(() => query({ slug: 'eng.1' })),
    };
    service.highlightModel = {
      findOne: jest.fn(() => query({
        status: 'FAILED',
        retryCount: 0,
        homeTeam: 'Unknown home team (team:home-1)',
        awayTeam: 'Chelsea',
        error: 'YouTube highlight skipped because normalized name data is unavailable for home team team:home-1.',
      })),
      updateOne,
    };
    service.queue = { hasActiveFixtureJob: jest.fn().mockResolvedValue(false) };
    service.enqueueAttempt = jest.fn().mockResolvedValue(true);

    await expect(service.ensureFirstAttempt(fixture)).resolves.toBe(true);
    expect(updateOne).toHaveBeenCalledWith(
      { fixtureId: 'fixture-recover-team-data', status: 'FAILED' },
      {
        $set: {
          status: 'RETRY',
          retryCount: 0,
          error: 'Retrying a previously deferred highlight after team metadata recovery.',
          nextRetryAt: null,
        },
      },
    );
    expect(service.enqueueAttempt).toHaveBeenCalledWith(
      fixture,
      'eng.1',
      1,
    );
  });

  it('defers the same search stage until Nigeria midnight without consuming an attempt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-16T10:00:00.000Z'));

    const fixture = {
      id: 'fixture-1',
      espnEventId: 'espn-1',
      competitionId: 'competition-1',
      kickoffAt: new Date('2026-11-16T08:00:00.000Z'),
      completedAt: new Date('2026-11-16T09:55:00.000Z'),
      status: { state: 'COMPLETED', isFinal: true },
      competitors: [
        { teamId: 'home-1', homeAway: 'HOME' },
        { teamId: 'away-1', homeAway: 'AWAY' },
      ],
    };
    const query = (value: unknown) => ({
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(value),
    });
    const updateOne = jest.fn(() => ({ exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }) }));
    const findOneAndUpdate = jest.fn(() => ({
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue({}),
    }));
    const enqueue = jest.fn().mockResolvedValue({ created: true, jobKey: 'deferred-job' });
    const service = Object.create(
      SportsYoutubeHighlightCollectionService.prototype,
    ) as any;

    service.youtube = {
      isEnabled: jest.fn().mockReturnValue(true),
      findHighlight: jest.fn(),
    };
    service.quota = { getRemainingDailyRequests: jest.fn().mockResolvedValue(0) };
    service.queue = {
      hasActiveFixtureJob: jest.fn().mockResolvedValue(false),
      enqueue,
    };
    service.fixtureModel = { findOne: jest.fn(() => query(fixture)) };
    service.competitionModel = {
      findOne: jest.fn(() => query({ slug: 'eng.1' })),
    };
    service.teamModel = {
      findOne: jest
        .fn()
        .mockImplementationOnce(() => query({ displayName: 'Arsenal' }))
        .mockImplementationOnce(() => query({ displayName: 'Chelsea' })),
    };
    service.highlightModel = {
      updateOne,
      findOne: jest.fn(() => query({ status: 'PENDING', retryCount: 0 })),
      findOneAndUpdate,
    };
    service.logger = { log: jest.fn(), warn: jest.fn() };

    await expect(
      service.processAttempt('fixture-1', 1, 'current-job'),
    ).resolves.toBe('QUOTA_EXHAUSTED');

    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(service.youtube.findHighlight).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SportsQueueJobType.YOUTUBE_HIGHLIGHT,
        scope: expect.objectContaining({ fixtureId: 'fixture-1', youtubeAttempt: 1 }),
        scheduledFor: new Date('2026-11-16T23:00:00.000Z'),
      }),
    );
    expect(service.queue.hasActiveFixtureJob).toHaveBeenCalledWith(
      SportsQueueJobType.YOUTUBE_HIGHLIGHT,
      'fixture-1',
      1,
      'current-job',
    );
  });
});


describe('SportsYoutubeHighlightCollectionService incomplete fixture team data', () => {
  afterEach(() => jest.useRealTimers());

  const query = (value: unknown) => ({
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value),
  });

  const completedFixture = {
    id: 'fixture-missing-team-name',
    espnEventId: 'espn-fixture-missing-team-name',
    competitionId: 'competition-1',
    kickoffAt: new Date('2026-11-16T08:00:00.000Z'),
    completedAt: new Date('2026-11-16T10:00:00.000Z'),
    status: { state: 'COMPLETED', isFinal: true },
    competitors: [
      { teamId: 'home-1', homeAway: 'HOME' },
      { teamId: 'away-1', homeAway: 'AWAY' },
    ],
  };

  it('uses team names retained in the fixture payload when team documents are missing', async () => {
    const fixture = {
      ...completedFixture,
      competitors: [
        {
          teamId: 'team:home-1',
          homeAway: 'HOME',
          rawPayload: { team: { displayName: 'Arsenal' } },
        },
        {
          teamId: 'team:away-1',
          homeAway: 'AWAY',
          rawPayload: { team: { displayName: 'Chelsea' } },
        },
      ],
    };
    const updateOne = jest.fn(() => ({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    }));
    const query = (value: unknown) => ({
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(value),
    });
    const findOneAndUpdate = jest.fn(() => ({
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue({ retryCount: 1 }),
    }));
    const findHighlight = jest.fn().mockResolvedValue({
      videoId: 'video-1',
      videoUrl: 'https://www.youtube.com/watch?v=video-1',
      title: 'Match highlights',
      channelTitle: 'Sports',
    });
    const service = Object.create(
      SportsYoutubeHighlightCollectionService.prototype,
    ) as any;
    service.youtube = {
      isEnabled: jest.fn().mockReturnValue(true),
      findHighlight,
    };
    service.quota = { getRemainingDailyRequests: jest.fn().mockResolvedValue(10) };
    service.queue = { hasActiveFixtureJob: jest.fn().mockResolvedValue(false) };
    service.fixtureModel = { findOne: jest.fn(() => query(fixture)) };
    service.competitionModel = {
      findOne: jest.fn(() => query({ slug: 'eng.1' })),
    };
    service.teamModel = { findOne: jest.fn(() => query(null)) };
    service.highlightModel = {
      updateOne,
      findOne: jest.fn(() => query({ status: 'PENDING', retryCount: 0 })),
      findOneAndUpdate,
    };
    service.logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    await expect(
      service.processAttempt('fixture-missing-team-name', 1),
    ).resolves.toBe('FOUND');

    expect(findHighlight).toHaveBeenCalled();
    expect(findHighlight.mock.calls[0][0]).toBe('Arsenal');
    expect(findHighlight.mock.calls[0][1]).toBe('Chelsea');
    expect(findHighlight.mock.calls[0][2]).toEqual(expect.any(Date));
  });

  it('defers missing normalized team names without consuming a YouTube attempt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-16T10:00:00.000Z'));
    const updateOne = jest.fn(() => ({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    }));
    const findHighlight = jest.fn();
    const service = Object.create(
      SportsYoutubeHighlightCollectionService.prototype,
    ) as any;

    service.youtube = {
      isEnabled: jest.fn().mockReturnValue(true),
      findHighlight,
    };
    service.fixtureModel = {
      findOne: jest.fn(() => query(completedFixture)),
    };
    service.competitionModel = {
      findOne: jest.fn(() => query({ slug: 'eng.1' })),
    };
    service.teamModel = {
      findOne: jest
        .fn()
        .mockImplementationOnce(() => query(null))
        .mockImplementationOnce(() => query({ displayName: '   ', name: 'Chelsea' })),
    };
    service.highlightModel = {
      updateOne,
      findOne: jest.fn(() => query(null)),
    };
    service.logger = { debug: jest.fn() };

    await expect(service.processAttempt('fixture-missing-team-name', 1)).resolves.toBe('SKIPPED');

    expect(updateOne).toHaveBeenCalledWith(
      { fixtureId: 'fixture-missing-team-name' },
      expect.objectContaining({
        $set: expect.objectContaining({
          fixtureId: 'fixture-missing-team-name',
          competitionId: 'competition-1',
          status: 'RETRY',
          error: expect.stringContaining('normalized name data is unavailable'),
          nextRetryAt: new Date('2026-11-16T10:15:00.000Z'),
        }),
        $setOnInsert: {
          homeTeam: 'Unknown home team (home-1)',
          awayTeam: 'Chelsea',
          retryCount: 0,
        },
      }),
      { upsert: true, setDefaultsOnInsert: true },
    );
    expect(findHighlight).not.toHaveBeenCalled();
    expect(service.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Deferring YouTube highlight for fixture fixture-missing-team-name'),
    );
  });

  it('defers retryably when either home or away competitor is missing', async () => {
    const fixture = {
      ...completedFixture,
      competitors: [{ teamId: 'home-1', homeAway: 'HOME' }],
    };
    const updateOne = jest.fn(() => ({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    }));
    const service = Object.create(
      SportsYoutubeHighlightCollectionService.prototype,
    ) as any;

    service.youtube = { isEnabled: jest.fn().mockReturnValue(true) };
    service.fixtureModel = { findOne: jest.fn(() => query(fixture)) };
    service.competitionModel = {
      findOne: jest.fn(() => query({ slug: 'eng.1' })),
    };
    service.highlightModel = {
      updateOne,
      findOne: jest.fn(() => query(null)),
    };
    service.logger = { debug: jest.fn() };

    await expect(service.processAttempt('fixture-missing-team-name', 1)).resolves.toBe('SKIPPED');

    expect(updateOne).toHaveBeenCalledWith(
      { fixtureId: 'fixture-missing-team-name' },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'RETRY',
          error: expect.stringContaining('team metadata is incomplete'),
        }),
      }),
      { upsert: true, setDefaultsOnInsert: true },
    );
  });
});

describe('SportsYoutubeHighlightCollectionService ranked scheduling', () => {
  afterEach(() => jest.useRealTimers());

  it('keeps an old completed fixture eligible and applies its league priority', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-19T10:00:00.000Z'));
    const enqueue = jest.fn().mockResolvedValue({ created: true, jobKey: 'youtube-job' });
    const updateOne = jest.fn(() => ({ exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }) }));
    const service = Object.create(
      SportsYoutubeHighlightCollectionService.prototype,
    ) as any;
    service.queue = {
      hasActiveFixtureJob: jest.fn().mockResolvedValue(false),
      enqueue,
    };
    service.highlightModel = { updateOne };

    const fixture = {
      id: 'fixture-old',
      competitionId: 'competition-1',
      seasonId: 'season-1',
      seasonYear: 2026,
      kickoffAt: new Date('2026-11-16T08:00:00.000Z'),
      completedAt: new Date('2026-11-16T10:00:00.000Z'),
    };

    await expect(service.enqueueAttempt(fixture, 'eng.1', 1)).resolves.toBe(true);

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SportsQueueJobType.YOUTUBE_HIGHLIGHT,
        priority: 40,
        scope: expect.objectContaining({
          fixtureId: 'fixture-old',
          leagueId: 'eng.1',
        }),
      }),
    );
  });

  it('assigns lower-ranked leagues a lower queue priority', async () => {
    const enqueue = jest.fn().mockResolvedValue({ created: true, jobKey: 'youtube-job' });
    const updateOne = jest.fn(() => ({ exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }) }));
    const service = Object.create(
      SportsYoutubeHighlightCollectionService.prototype,
    ) as any;
    service.queue = {
      hasActiveFixtureJob: jest.fn().mockResolvedValue(false),
      enqueue,
    };
    service.highlightModel = { updateOne };

    const fixture = {
      id: 'fixture-rank-four',
      competitionId: 'competition-4',
      kickoffAt: new Date('2026-11-18T08:00:00.000Z'),
      completedAt: new Date('2026-11-18T10:00:00.000Z'),
    };

    await service.enqueueAttempt(fixture, 'gre.1', 1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 10 }),
    );
  });
});
