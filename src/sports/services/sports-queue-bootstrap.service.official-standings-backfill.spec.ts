import { SportsQueueBootstrapService } from './sports-queue-bootstrap.service';
import { SportsQueueJobType } from '../interfaces/sports-queue.interface';

function modelQuery(rows: unknown[]) {
  const q: any = {};
  q.sort = jest.fn(() => q);
  q.select = jest.fn(() => q);
  q.lean = jest.fn(() => q);
  q.exec = jest.fn().mockResolvedValue(rows);
  return q;
}

describe('SportsQueueBootstrapService official standings backfill seeding', () => {
  it('queues one idempotent local backfill per active current competition-season', async () => {
    const seasons = modelQuery([]);
    const competitions = modelQuery([
      { id: 'competition-1', currentSeasonId: 'season-1' },
      { id: 'competition-2', currentSeasonId: 'season-2' },
      { id: 'competition-3' },
    ]);
    const queue = { enqueueIfMissing: jest.fn().mockResolvedValue({ created: true }) };
    const service = Object.create(SportsQueueBootstrapService.prototype) as any;
    service.seasonModel = { find: jest.fn(() => seasons) };
    service.competitionModel = { find: jest.fn(() => competitions) };
    service.queue = queue;
    service.bootstrapModel = {
      findOne: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({ runId: 'bootstrap-1' }),
      })),
    };
    service.logger = { log: jest.fn() };
    service.ensureHistoricalDerivedBaseline = jest.fn().mockResolvedValue(undefined);

    await service.ensureRecurringDiscovery();

    const jobs = queue.enqueueIfMissing.mock.calls
      .map((call: any[]) => call[0])
      .filter((job: any) => job.type === SportsQueueJobType.OFFICIAL_STANDINGS_BACKFILL);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job: any) => job.scope)).toEqual(expect.arrayContaining([
      expect.objectContaining({ competitionId: 'competition-1', seasonId: 'season-1' }),
      expect.objectContaining({ competitionId: 'competition-2', seasonId: 'season-2' }),
    ]));
  });
});
