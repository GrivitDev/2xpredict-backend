import { SportsQueueService } from './sports-queue.service';
import { SportsQueueJobType, SportsQueueJobStatus } from '../interfaces/sports-queue.interface';

describe('SportsQueueService fixture-job coalescing', () => {
  it('reuses an already pending or processing fixture pricing job', async () => {
    const query = {
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue({ jobKey: 'existing-job' }),
    };
    const findOne = jest.fn(() => query);
    const updateOne = jest.fn();
    const service = new SportsQueueService({ findOne, updateOne } as any);

    const result = await service.enqueueIfNoActiveFixtureJob({
      type: SportsQueueJobType.ODDS_PRICING_RECALCULATION,
      scope: { fixtureId: 'fixture-1' },
      priority: 65,
      scheduledFor: new Date('2026-11-10T12:00:00.000Z'),
      triggerEventId: 'source-event-1',
    });

    expect(result).toEqual({ created: false, jobKey: 'existing-job' });
    expect(findOne).toHaveBeenCalledWith({
      type: SportsQueueJobType.ODDS_PRICING_RECALCULATION,
      'scope.fixtureId': 'fixture-1',
      status: { $in: [SportsQueueJobStatus.PENDING, SportsQueueJobStatus.PROCESSING] },
    });
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('requires a fixtureId when coalescing fixture-scoped work', async () => {
    const service = new SportsQueueService({} as any);
    await expect(service.enqueueIfNoActiveFixtureJob({
      type: SportsQueueJobType.ODDS_PRICING_RECALCULATION,
      scope: {},
    })).rejects.toThrow('a fixtureId is required');
  });
});


describe('SportsQueueService durable enqueue identity', () => {
  const makeQuery = (value: unknown) => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value),
  });

  it('uses a stable dedupe key and an atomic upsert after the legacy lookup', async () => {
    const legacyQuery = makeQuery(null);
    const existingQuery = makeQuery({ jobKey: 'stable-job' });
    const findOne = jest.fn()
      .mockReturnValueOnce(legacyQuery)
      .mockReturnValueOnce(existingQuery);
    const updateQuery = { exec: jest.fn().mockResolvedValue({ upsertedCount: 0 }) };
    const updateOne = jest.fn().mockReturnValue(updateQuery);
    const service = new SportsQueueService({ findOne, updateOne } as any);

    const request = {
      type: SportsQueueJobType.LIVE_SCOREBOARD_REFRESH,
      scope: {
        competitionId: 'competition:test',
        calendarDate: '2026-11-16',
      },
      priority: 100,
      scheduledFor: new Date('2026-11-16T10:00:00.000Z'),
      recurrence: { intervalMs: 120_000, repeatUntil: 'DATA_COMPLETE' as const },
      triggerEventId: 'live-scoreboard:competition:test:2026-11-16',
    };

    const result = await service.enqueueIfMissing(request);

    expect(result).toEqual({ created: false, jobKey: 'stable-job' });
    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = updateOne.mock.calls[0];
    expect(filter.dedupeKey).toMatch(/^sports-job:/);
    expect(update.$setOnInsert.dedupeKey).toBe(filter.dedupeKey);
    expect(options).toEqual({ upsert: true, setDefaultsOnInsert: true });
  });

  it('returns the existing job when a concurrent atomic upsert loses the unique-key race', async () => {
    const legacyQuery = makeQuery(null);
    const existingQuery = makeQuery({ jobKey: 'winner-job' });
    const findOne = jest.fn()
      .mockReturnValueOnce(legacyQuery)
      .mockReturnValueOnce(existingQuery);
    const duplicateKey = Object.assign(new Error('duplicate key'), { code: 11000 });
    const updateOne = jest.fn().mockReturnValue({
      exec: jest.fn().mockRejectedValue(duplicateKey),
    });
    const service = new SportsQueueService({ findOne, updateOne } as any);

    const result = await service.enqueueIfMissing({
      type: SportsQueueJobType.LIVE_SCOREBOARD_REFRESH,
      scope: { competitionId: 'competition:test', calendarDate: '2026-11-16' },
      triggerEventId: 'live-scoreboard:competition:test:2026-11-16',
    });

    expect(result).toEqual({ created: false, jobKey: 'winner-job' });
  });
});

describe('SportsQueueService recurring lease recovery', () => {
  it('preserves nextRunAt so a retried worker reuses the reserved successor timestamp', async () => {
    const expiredQuery = {
      select: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([{ jobKey: 'recurring-job', retryCount: 0 }]),
    };
    const updateQuery = {
      exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const updateOne = jest.fn().mockReturnValue(updateQuery);
    const service = new SportsQueueService({
      find: jest.fn().mockReturnValue(expiredQuery),
      updateOne,
    } as any);

    await expect(service.recoverExpiredProcessing()).resolves.toBe(1);

    const update = updateOne.mock.calls[0][1];
    expect(update.$unset).not.toHaveProperty('nextRunAt');
  });
});
