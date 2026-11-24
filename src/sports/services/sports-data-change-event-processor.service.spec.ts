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


describe('SportsDataChangeEventProcessorService independent prediction fan-out', () => {
  it('attempts both Odds and Prediction handoffs even when one consumer queue fails', async () => {
    const service = Object.create(SportsDataChangeEventProcessorService.prototype) as any;
    service.enqueueAffectedOddsPricing = jest.fn().mockRejectedValue(new Error('Odds queue unavailable'));
    service.enqueueAffectedPredictionRecalculations = jest.fn().mockResolvedValue(undefined);

    await expect(service.dispatch({
      eventId: 'source-event-independent-1',
      entity: 'TEAM',
      entityId: 'team-1',
      revision: 4,
      changedAt: new Date(),
      fixtureIds: [],
      teamIds: ['team-1'],
      competitionIds: [],
      seasonIds: [],
    } as any)).rejects.toThrow('Odds queue unavailable');

    expect(service.enqueueAffectedOddsPricing).toHaveBeenCalledTimes(1);
    expect(service.enqueueAffectedPredictionRecalculations).toHaveBeenCalledTimes(1);
  });

  it('queues a revision-qualified prediction trigger for an eligible fixture', async () => {
    const fixture = {
      id: 'fixture-upcoming-1',
      kickoffAt: new Date(Date.now() + 24 * 60 * 60_000),
      status: { state: 'SCHEDULED', isFinal: false },
      competitors: [
        { homeAway: 'HOME', teamId: 'team-home' },
        { homeAway: 'AWAY', teamId: 'team-away' },
      ],
    };
    const fixtureModel = {
      find: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([fixture]),
      })),
    };
    const queue = {
      enqueueIfMissing: jest.fn().mockResolvedValue({ created: true }),
    };
    const service = Object.create(SportsDataChangeEventProcessorService.prototype) as any;
    service.fixtureModel = fixtureModel;
    service.queue = queue;
    service.logger = { debug: jest.fn(), log: jest.fn() };
    service.predictionEnqueueConcurrency = 2;

    await service.enqueuePredictionRecalculationsForIds(
      ['fixture-upcoming-1'],
      {
        eventId: 'source-event-team-update-5',
        entity: 'TEAM',
        entityId: 'team-home',
        revision: 5,
        changedAt: new Date(),
      } as any,
    );

    const trigger = queue.enqueueIfMissing.mock.calls[0][0];
    expect(trigger.type).toBe('PREDICTION_ENGINE_RECALCULATION');
    expect(trigger.scope.fixtureId).toBe('fixture-upcoming-1');
    expect(trigger.scope.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(trigger.triggerEventId).toBe(
      'prediction:source:source-event-team-update-5:fixture-upcoming-1',
    );
  });
});
