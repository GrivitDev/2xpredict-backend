import { PredictionQueueStatus } from '../enums/prediction-queue-status.enum';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { PredictionQueueService } from './prediction-queue.service';

describe('PredictionQueueService MongoDB update operators', () => {
  const eventId = 'fixture-without-odds';
  const kickoffAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
  const sourceUpdatedAt = new Date();
  const waitingReason = 'Odds are not ready yet.';

  function createService(existingRows: Record<string, unknown>[] = []) {
    const fixture = {
      id: eventId,
      competitionId: 'league-1',
      kickoffAt,
      updatedAt: sourceUpdatedAt,
      status: { state: 'SCHEDULED', isFinal: false },
      competitors: [
        { homeAway: 'HOME', score: null },
        { homeAway: 'AWAY', score: null },
      ],
    };

    const query = {
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(existingRows),
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
      getCurrentRevisions: jest.fn().mockResolvedValue(new Map([[eventId, 0]])),
    };
    const oddsService = {
      getPredictionReadinessForEvents: jest.fn().mockResolvedValue(
        new Map([[eventId, { ready: false, reason: waitingReason }]]),
      ),
    };
    const monitor = { recordQueueSync: jest.fn().mockResolvedValue(undefined) };

    const service = new PredictionQueueService(
      sportsRead as any,
      sportsRevisions as any,
      queueModel as any,
      monitor as any,
      oddsService as any,
    );

    return { service, queueModel, fixture };
  }

  it('initializes attempts only with $setOnInsert for a new WAITING_FOR_ODDS row', async () => {
    const { service, queueModel } = createService();

    await service.syncUpcomingFixtures();

    expect(queueModel.bulkWrite).toHaveBeenCalledTimes(1);
    const operations = queueModel.bulkWrite.mock.calls[0][0];
    const update = operations[0].updateOne.update;

    expect(operations[0].updateOne.upsert).toBe(true);
    expect(update.$set.status).toBe(PredictionQueueStatus.WAITING_FOR_ODDS);
    expect(update.$set).not.toHaveProperty('attempts');
    expect(update.$setOnInsert).toEqual({ attempts: 0, refreshCount: 0 });
  });

  it('resets attempts with $set for an existing row and does not add $setOnInsert', async () => {
    const { service, queueModel } = createService([
      {
        eventId,
        status: PredictionQueueStatus.PENDING,
        attempts: 4,
      },
    ]);

    await service.syncUpcomingFixtures();

    expect(queueModel.bulkWrite).toHaveBeenCalledTimes(1);
    const operations = queueModel.bulkWrite.mock.calls[0][0];
    const update = operations[0].updateOne.update;

    expect(operations[0].updateOne.upsert).toBe(false);
    expect(update.$set.status).toBe(PredictionQueueStatus.WAITING_FOR_ODDS);
    expect(update.$set.attempts).toBe(0);
    expect(update).not.toHaveProperty('$setOnInsert');
  });
});
