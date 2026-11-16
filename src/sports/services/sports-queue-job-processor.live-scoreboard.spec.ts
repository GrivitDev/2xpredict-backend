import { SportsQueueJobProcessorService } from './sports-queue-job-processor.service';
import { SportsQueueJobType } from '../interfaces/sports-queue.interface';

describe('SportsQueueJobProcessorService live scoreboard recurrence', () => {
  const makeJob = () => ({
    type: SportsQueueJobType.LIVE_SCOREBOARD_REFRESH,
    jobKey: 'live-scoreboard:competition-1:2026-11-15',
    scope: {
      competitionId: 'competition-1',
      calendarDate: '2026-11-15',
      expectedKickoffAt: '2026-11-15T10:00:00.000Z',
    },
    recurrence: { intervalMs: 2 * 60_000, repeatUntil: 'DATA_COMPLETE' },
    priority: 100,
    triggerEventId: 'live-scoreboard:competition-1:2026-11-15',
  });

  it('does not create a successor after every fixture reaches a provider-confirmed terminal state', async () => {
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    service.collection = {
      getLiveScoreboardMonitoringState: jest.fn().mockResolvedValue({ shouldContinue: false }),
    };
    service.queue = { getOrCreateSuccessorAt: jest.fn(), enqueue: jest.fn() };
    await service.scheduleNext(makeJob(), 'worker-1');
    expect(service.queue.getOrCreateSuccessorAt).not.toHaveBeenCalled();
    expect(service.queue.enqueue).not.toHaveBeenCalled();
  });

  it('persists a thirty-minute successor while final-status verification remains necessary', async () => {
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    service.collection = {
      getLiveScoreboardMonitoringState: jest.fn().mockResolvedValue({
        shouldContinue: true, intervalMs: 30 * 60_000,
      }),
    };
    service.queue = {
      getOrCreateSuccessorAt: jest.fn().mockResolvedValue(new Date('2026-11-16T10:30:00.000Z')),
      enqueue: jest.fn().mockResolvedValue(undefined),
    };
    await service.scheduleNext(makeJob(), 'worker-1');
    expect(service.queue.getOrCreateSuccessorAt).toHaveBeenCalledWith(
      'live-scoreboard:competition-1:2026-11-15', 'worker-1', 30 * 60_000,
    );
    expect(service.queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: SportsQueueJobType.LIVE_SCOREBOARD_REFRESH,
      recurrence: expect.objectContaining({ intervalMs: 30 * 60_000 }),
    }));
  });
});
