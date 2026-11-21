import { SportsDataChangeEventProcessorService } from './sports-data-change-event-processor.service';

describe('SportsDataChangeEventProcessorService historical projection invalidation', () => {
  it('queues the fixture season as well as the current competition season', async () => {
    const fixtureModel = {
      find: jest.fn(() => ({
        select: jest.fn(() => ({
          lean: jest.fn(() => ({
            exec: jest.fn().mockResolvedValue([{
              id: 'historical-fixture',
              competitionId: 'competition-1',
              seasonId: 'season-2024',
            }]),
          })),
        })),
      })),
    };
    const seasonModel = {
      find: jest.fn(() => ({
        select: jest.fn(() => ({
          lean: jest.fn(() => ({
            exec: jest.fn().mockResolvedValue([{
              competitionId: 'competition-1',
              id: 'season-2026',
            }]),
          })),
        })),
      })),
    };
    const queue = { enqueueIfMissing: jest.fn().mockResolvedValue({ created: true }) };
    const service = Object.create(SportsDataChangeEventProcessorService.prototype) as any;
    service.fixtureModel = fixtureModel;
    service.seasonModel = seasonModel;
    service.queue = queue;

    await service.enqueueAffectedSeasonProjections(['historical-fixture'], 'source-event-1');

    const scheduledScopes = queue.enqueueIfMissing.mock.calls.map((call: any[]) => call[0].scope);
    expect(scheduledScopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ competitionId: 'competition-1', seasonId: 'season-2024' }),
      expect.objectContaining({ competitionId: 'competition-1', seasonId: 'season-2026' }),
    ]));
  });
});



describe('SportsDataChangeEventProcessorService Grivit pricing horizon', () => {
  afterEach(() => jest.useRealTimers());

  it('filters known fixture IDs to upcoming fixtures within seven days', async () => {
    const now = new Date('2026-11-11T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    const fixtureModel = {
      find: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([{ id: 'fixture-inside-window' }]),
      })),
    };
    const queue = { enqueueIfNoActiveFixtureJob: jest.fn().mockResolvedValue({ created: true }) };
    const service = Object.create(SportsDataChangeEventProcessorService.prototype) as any;
    service.fixtureModel = fixtureModel;
    service.queue = queue;
    service.logger = { debug: jest.fn() };
    service.oddsEnqueueConcurrency = 2;

    await service.enqueueOddsPricingForIds(
      ['fixture-inside-window', 'fixture-outside-window'],
      { eventId: 'source-event-1', changedAt: now } as any,
    );

    const filter = fixtureModel.find.mock.calls[0][0];
    expect(filter.$or).toEqual([
      { id: { $in: ['fixture-inside-window', 'fixture-outside-window'] } },
      { espnEventId: { $in: ['fixture-inside-window', 'fixture-outside-window'] } },
    ]);
    expect(filter.kickoffAt.$gt).toEqual(now);
    expect(filter.kickoffAt.$lte.getTime() - now.getTime()).toBe(
      7 * 24 * 60 * 60_000,
    );
    expect(filter).not.toHaveProperty('status.state');
    expect(queue.enqueueIfNoActiveFixtureJob).toHaveBeenCalledTimes(1);
    expect(queue.enqueueIfNoActiveFixtureJob.mock.calls[0][0].scope.fixtureId)
      .toBe('fixture-inside-window');
  });
});
