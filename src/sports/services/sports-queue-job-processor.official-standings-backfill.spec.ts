import { SportsQueueJobType } from '../interfaces/sports-queue.interface';
import { SportsQueueJobProcessorService } from './sports-queue-job-processor.service';

describe('SportsQueueJobProcessorService official standings backfill', () => {
  const makeFixture = (id: string, kickoffAt: string) => ({
    id,
    kickoffAt: new Date(kickoffAt),
  });

  it('reprocesses only fixtures with retained Summary payloads and enqueues the next page', async () => {
    const fixtures = Array.from({ length: 20 }, (_, index) =>
      makeFixture(`fixture-${index}`, `2026-10-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`),
    );
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    service.collection = {
      getCompetition: jest.fn().mockResolvedValue({
        id: 'competition-1', isActive: true, currentSeasonId: 'season-1',
      }),
      getSeason: jest.fn().mockResolvedValue({
        id: 'season-1', competitionId: 'competition-1', isCurrent: true,
      }),
      getSummaryBackfillPage: jest.fn().mockResolvedValue(fixtures.map((fixture, index) => ({
        fixture,
        ...(index % 2 === 0 ? { summaryPayloadHash: `hash-${index}` } : {}),
        factsPayloadHash: `hash-${index}`,
      }))),
      normalizeStoredOfficialStandings: jest.fn().mockResolvedValue(true),
    };
    service.queue = { enqueueIfMissing: jest.fn().mockResolvedValue({ created: true }) };
    service.logger = { debug: jest.fn(), log: jest.fn() };

    await service.processOfficialStandingsBackfill({
      competitionId: 'competition-1', seasonId: 'season-1',
      backfillRunId: 'STAGE1E_OFFICIAL_STANDINGS_V1',
    });

    expect(service.collection.getSummaryBackfillPage).toHaveBeenCalledWith(
      expect.objectContaining({ competitionId: 'competition-1', seasonId: 'season-1', limit: 20 }),
    );
    expect(service.collection.normalizeStoredOfficialStandings).toHaveBeenCalledTimes(10);
    expect(service.queue.enqueueIfMissing).toHaveBeenCalledWith(expect.objectContaining({
      type: SportsQueueJobType.OFFICIAL_STANDINGS_BACKFILL,
      scope: expect.objectContaining({
        competitionId: 'competition-1', seasonId: 'season-1',
        backfillCursorFixtureId: 'fixture-19',
      }),
    }));
  });

  it('does not call ESPN or enqueue missing-summary collection jobs', async () => {
    const fixture = makeFixture('fixture-1', '2026-10-01T12:00:00.000Z');
    const service = Object.create(SportsQueueJobProcessorService.prototype) as any;
    service.collection = {
      getCompetition: jest.fn().mockResolvedValue({ id: 'competition-1', isActive: true, currentSeasonId: 'season-1' }),
      getSeason: jest.fn().mockResolvedValue({ id: 'season-1', competitionId: 'competition-1', isCurrent: true }),
      getSummaryBackfillPage: jest.fn().mockResolvedValue([{ fixture }]),
      normalizeStoredOfficialStandings: jest.fn(),
      collectFixtureSummary: jest.fn(),
    };
    service.queue = { enqueueIfMissing: jest.fn() };
    service.logger = { debug: jest.fn(), log: jest.fn() };

    await service.processOfficialStandingsBackfill({
      competitionId: 'competition-1', seasonId: 'season-1',
      backfillRunId: 'STAGE1E_OFFICIAL_STANDINGS_V1',
    });

    expect(service.collection.normalizeStoredOfficialStandings).not.toHaveBeenCalled();
    expect(service.collection.collectFixtureSummary).not.toHaveBeenCalled();
    expect(service.queue.enqueueIfMissing).not.toHaveBeenCalled();
  });
});
