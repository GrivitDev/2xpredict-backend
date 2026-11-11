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
