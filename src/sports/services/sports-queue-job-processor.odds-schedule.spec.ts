import { SportsQueueJobType } from '../interfaces/sports-queue.interface';
import { SportsQueueJobProcessorService } from './sports-queue-job-processor.service';

describe('SportsQueueJobProcessorService odds milestone scheduling', () => {
  const HOUR = 60 * 60_000;
  let service: SportsQueueJobProcessorService;
  let enqueueMilestone: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-10T12:00:00.000Z'));
    service = new SportsQueueJobProcessorService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    enqueueMilestone = jest
      .spyOn(service as any, 'enqueueMilestone')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('schedules only the 48h, 24h and 18h odds milestones when all are still ahead', async () => {
    const now = Date.now();
    const kickoffAt = now + 72 * HOUR;

    await (service as any).enqueueThresholdJobs(
      SportsQueueJobType.MATCH_ODDS_REFRESH,
      { fixtureId: 'fixture-1' },
      [
        { name: 'ODDS_48H', leadMs: 48 * HOUR, priority: 90 },
        { name: 'ODDS_24H', leadMs: 24 * HOUR, priority: 92 },
        { name: 'ODDS_18H', leadMs: 18 * HOUR, priority: 95 },
      ],
      kickoffAt,
      'odds-test',
      'ODDS_CATCHUP',
      false,
    );

    expect(enqueueMilestone.mock.calls.map((call) => call[2])).toEqual([
      'ODDS_48H',
      'ODDS_24H',
      'ODDS_18H',
    ]);
  });


  it.each(['ODDS_60H', 'ODDS_CATCHUP', undefined])(
    'does not dispatch retired or legacy odds jobs without an approved milestone (%s)',
    async (milestone) => {
      const getFixture = jest.fn();
      (service as any).collection = { getFixture };

      await (service as any).processMatchOdds({
        fixtureId: 'fixture-1',
        milestone,
      });

      expect(getFixture).not.toHaveBeenCalled();
    },
  );

  it('skips a missed checkpoint without creating an extra immediate odds catch-up job', async () => {
    const now = Date.now();
    const kickoffAt = now + 36 * HOUR;

    await (service as any).enqueueThresholdJobs(
      SportsQueueJobType.MATCH_ODDS_REFRESH,
      { fixtureId: 'fixture-1' },
      [
        { name: 'ODDS_48H', leadMs: 48 * HOUR, priority: 90 },
        { name: 'ODDS_24H', leadMs: 24 * HOUR, priority: 92 },
        { name: 'ODDS_18H', leadMs: 18 * HOUR, priority: 95 },
      ],
      kickoffAt,
      'odds-test',
      'ODDS_CATCHUP',
      false,
    );

    expect(enqueueMilestone.mock.calls.map((call) => call[2])).toEqual([
      'ODDS_24H',
      'ODDS_18H',
    ]);
  });
});
