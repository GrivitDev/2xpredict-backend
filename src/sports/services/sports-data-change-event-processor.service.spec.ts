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
