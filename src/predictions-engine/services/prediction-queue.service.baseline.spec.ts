import { PredictionQueueStatus } from '../enums/prediction-queue-status.enum';
import { PredictionQueueService } from './prediction-queue.service';

describe('PredictionQueueService independent baseline scheduling', () => {
  it('queues an eligible fixture even when the Odds readiness lookup fails', async () => {
    const eventId = 'fixture-early-season-without-odds';
    const kickoffAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    const fixture = {
      id: eventId,
      competitionId: 'league-new-season',
      kickoffAt,
      updatedAt: new Date(),
      status: { state: 'SCHEDULED', isFinal: false },
      competitors: [
        { teamId: 'home-team', homeAway: 'HOME', score: null },
        { teamId: 'away-team', homeAway: 'AWAY', score: null },
      ],
    };
    const query = {
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    const queueModel = {
      find: jest.fn().mockReturnValue(query),
      bulkWrite: jest.fn().mockResolvedValue({ acknowledged: true }),
    };
    const sportsRead = {
      getFixtures: jest.fn().mockResolvedValue({ items: [fixture] }),
      getCompetition: jest.fn().mockResolvedValue(null),
    };
    const sportsRevisions = {
      getCurrentRevisions: jest.fn().mockResolvedValue(new Map([[eventId, 1]])),
    };
    const oddsService = {
      getPredictionReadinessForEvents: jest.fn().mockRejectedValue(new Error('Odds service unavailable')),
    };
    const monitor = { recordQueueSync: jest.fn().mockResolvedValue(undefined) };
    const service = new PredictionQueueService(
      sportsRead as any,
      sportsRevisions as any,
      queueModel as any,
      monitor as any,
      oddsService as any,
    );

    const result = await service.syncUpcomingFixtures();

    expect(result.eligibleFixtures).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(result.oddsNotReady).toBe(1);
    expect(queueModel.bulkWrite).toHaveBeenCalledTimes(1);
    const operation = queueModel.bulkWrite.mock.calls[0][0][0];
    expect(operation.updateOne.update.$set.status).toBe(PredictionQueueStatus.PENDING);
    expect(operation.updateOne.update.$set.reason).toBe('INITIAL');
    expect(operation.updateOne.upsert).toBe(true);
  });
});

describe('PredictionQueueService source-trigger recalculation', () => {
  it('persists a force-recalculation marker when a Sports source trigger is consumed', async () => {
    const eventId = 'fixture-trigger-refresh';
    const fixture = {
      id: eventId,
      competitionId: 'league-1',
      kickoffAt: new Date(Date.now() + 24 * 60 * 60_000),
      updatedAt: new Date(),
      status: { state: 'SCHEDULED', isFinal: false },
      competitors: [
        { teamId: 'home-team', homeAway: 'HOME', score: null },
        { teamId: 'away-team', homeAway: 'AWAY', score: null },
      ],
    };
    const queueModel = {
      findOne: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(null),
      })),
      updateOne: jest.fn(() => ({
        exec: jest.fn().mockResolvedValue({ matchedCount: 0, upsertedCount: 1 }),
      })),
    };
    const sportsRead = {
      getFixture: jest.fn().mockResolvedValue(fixture),
      getCompetition: jest.fn().mockResolvedValue(null),
    };
    const sportsRevisions = {
      getCurrentRevisions: jest.fn().mockResolvedValue(new Map([[eventId, 2]])),
    };
    const oddsService = {
      getPredictionReadinessForEvents: jest.fn().mockResolvedValue(new Map()),
    };
    const monitor = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    const service = new PredictionQueueService(
      sportsRead as any,
      sportsRevisions as any,
      queueModel as any,
      monitor as any,
      oddsService as any,
    );

    const result = await service.requestFixtureRefresh(eventId, 'prediction:source:event-1');

    expect(result).toBe('QUEUED');
    expect(queueModel.updateOne.mock.calls[0][1].$set.forceRecalculation).toBe(true);
    expect(queueModel.updateOne.mock.calls[0][1].$set.sourceRevisionFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
