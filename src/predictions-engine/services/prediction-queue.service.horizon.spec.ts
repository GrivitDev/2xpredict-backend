import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { PredictionQueueService } from './prediction-queue.service';
import { PredictionQueueStatus } from '../enums/prediction-queue-status.enum';

describe('PredictionQueueService seven-day horizon', () => {
  const fixedNow = new Date('2026-11-19T12:00:00.000Z');
  const horizonEnd = new Date(
    fixedNow.getTime() + PREDICTION_ENGINE_CONFIG.queue.forwardWindowHours * 60 * 60_000,
  );

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(fixedNow);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('limits fixture reconciliation reads to the next seven days', async () => {
    const sportsRead = {
      getFixtures: jest.fn().mockResolvedValue({ items: [], nextCursor: undefined }),
    };
    const monitor = { recordQueueSync: jest.fn().mockResolvedValue(undefined) };
    const service = Object.create(PredictionQueueService.prototype) as any;
    service.sportsRead = sportsRead;
    service.monitor = monitor;
    service.logger = { log: jest.fn() };

    await service.syncUpcomingFixtures();

    expect(sportsRead.getFixtures).toHaveBeenCalledTimes(1);
    expect(sportsRead.getFixtures).toHaveBeenCalledWith({
      from: fixedNow,
      to: horizonEnd,
      limit: 100,
      sortOrder: 'ASC',
      retainedOnly: true,
    });
    expect(monitor.recordQueueSync).toHaveBeenCalledTimes(1);
  });

  it('does not let a source-change trigger refresh a fixture beyond seven days', async () => {
    const sportsRead = {
      getFixture: jest.fn().mockResolvedValue({
        id: 'fixture-outside-window',
        kickoffAt: new Date(horizonEnd.getTime() + 1),
        status: { state: 'SCHEDULED', isFinal: false },
      }),
    };
    const service = Object.create(PredictionQueueService.prototype) as any;
    service.sportsRead = sportsRead;

    await expect(
      service.requestFixtureRefresh('fixture-outside-window', 'source-event-1'),
    ).resolves.toBe('SKIPPED');
  });

  it('does not claim persisted prediction jobs until their kickoff enters the horizon', async () => {
    const query = {
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(null),
    };
    const queueModel = {
      findOneAndUpdate: jest.fn().mockReturnValue(query),
    };
    const service = Object.create(PredictionQueueService.prototype) as any;
    service.queueModel = queueModel;
    service.monitor = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    service.logger = { warn: jest.fn() };

    await service.claimNext();

    const filter = queueModel.findOneAndUpdate.mock.calls[0][0];
    expect(filter.fixtureDate).toEqual({ $gt: fixedNow, $lte: horizonEnd });
    expect(filter.status.$in).toEqual([
      PredictionQueueStatus.PENDING,
      PredictionQueueStatus.RETRY,
    ]);
  });
});

describe('PredictionQueueService event-first completed prediction recovery', () => {
  const fixedNow = new Date('2026-11-19T12:00:00.000Z');
  const kickoffAt = new Date(fixedNow.getTime() + 2 * 60 * 60_000);
  const sourceUpdatedAt = new Date(fixedNow.getTime() - 60 * 60_000);
  const oddsUpdatedAt = new Date(fixedNow.getTime() - 30 * 60_000);

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(fixedNow);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createCompletedFixtureService(completedAgeMs: number) {
    const fixture = {
      id: 'fixture-1',
      competitionId: 'league-1',
      kickoffAt,
      updatedAt: sourceUpdatedAt,
      status: { state: 'SCHEDULED', isFinal: false },
      competitors: [
        { homeAway: 'HOME', score: null },
        { homeAway: 'AWAY', score: null },
      ],
    };
    const existing = {
      eventId: 'fixture-1',
      leagueId: 'league-1',
      fixtureDate: kickoffAt,
      priority: 100,
      status: PredictionQueueStatus.COMPLETED,
      lastProcessedSummaryAt: sourceUpdatedAt,
      summaryCollectedAt: sourceUpdatedAt,
      fixtureSourceRevision: 0,
      lastProcessedFixtureSourceRevision: 0,
      modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
      lastProcessedOddsAt: oddsUpdatedAt,
      oddsUpdatedAt,
      lastProcessedScoreSnapshot: 'NA|NA|SCHEDULED||',
      scoreSnapshot: 'NA|NA|SCHEDULED||',
      completedAt: new Date(fixedNow.getTime() - completedAgeMs),
      refreshCount: 1,
      attempts: 0,
    };
    const findQuery = {
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([existing]),
    };
    const queueModel = {
      find: jest.fn().mockReturnValue(findQuery),
      bulkWrite: jest.fn().mockResolvedValue({ acknowledged: true }),
    };
    const service = Object.create(PredictionQueueService.prototype) as any;
    service.sportsRead = {
      getCompetition: jest.fn().mockResolvedValue(null),
    };
    service.oddsService = {
      getPredictionReadinessForEvents: jest.fn().mockResolvedValue(
        new Map([['fixture-1', { ready: true, latestOddsUpdatedAt: oddsUpdatedAt }]]),
      ),
    };
    service.sportsRevisions = {
      getCurrentRevisions: jest.fn().mockResolvedValue(new Map([['fixture-1', 0]])),
    };
    service.queueModel = queueModel;
    return { service, queueModel, fixture, existing };
  }

  it('does not periodically recalculate a completed fixture before 72 hours when inputs are unchanged', async () => {
    const { service, queueModel, fixture } = createCompletedFixtureService(24 * 60 * 60_000);

    const result = await service.syncFixtureBatch([fixture], fixedNow, false);

    expect(result.refreshed).toBe(0);
    expect(queueModel.bulkWrite).not.toHaveBeenCalled();
  });

  it('retains a 72-hour recovery refresh for a completed fixture when no source change was detected', async () => {
    const { service, queueModel, fixture } = createCompletedFixtureService(73 * 60 * 60_000);

    const result = await service.syncFixtureBatch([fixture], fixedNow, false);

    expect(result.refreshed).toBe(1);
    expect(queueModel.bulkWrite).toHaveBeenCalledTimes(1);
    const operation = queueModel.bulkWrite.mock.calls[0][0][0].updateOne;
    expect(operation.update.$set.status).toBe(PredictionQueueStatus.PENDING);
    expect(operation.update.$set.reason).toBe('PERIODIC_REFRESH');
  });

  it('still immediately refreshes a completed fixture when its source timestamp changes', async () => {
    const { service, queueModel, fixture } = createCompletedFixtureService(24 * 60 * 60_000);
    fixture.updatedAt = new Date(sourceUpdatedAt.getTime() + 1_000);

    const result = await service.syncFixtureBatch([fixture], fixedNow, false);

    expect(result.refreshed).toBe(1);
    expect(queueModel.bulkWrite).toHaveBeenCalledTimes(1);
    const operation = queueModel.bulkWrite.mock.calls[0][0][0].updateOne;
    expect(operation.update.$set.reason).toBe('SPORTS_FIXTURE_UPDATED');
  });
});

