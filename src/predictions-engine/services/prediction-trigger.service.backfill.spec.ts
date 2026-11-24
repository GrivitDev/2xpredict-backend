import { PredictionTriggerService } from './prediction-trigger.service';

describe('PredictionTriggerService upcoming coverage backfill', () => {
  it('schedules Odds inventory and independently reconciles the prediction queue', async () => {
    const queue = {
      syncUpcomingFixtures: jest.fn().mockResolvedValue({
        scannedFixtures: 12,
        eligibleFixtures: 12,
        enqueued: 8,
        refreshed: 4,
        missingSummary: 0,
        oddsNotReady: 12,
      }),
    };
    const oddsWorker = {
      requestInventoryBackfill: jest.fn().mockReturnValue({
        accepted: true,
        status: 'QUEUED',
        lookaheadHours: 168,
      }),
    };
    const monitor = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    const service = new PredictionTriggerService(
      {} as any,
      queue as any,
      {} as any,
      monitor as any,
      oddsWorker as any,
    );

    const result = await service.backfillUpcomingFixtures();

    expect(oddsWorker.requestInventoryBackfill).toHaveBeenCalledTimes(1);
    expect(queue.syncUpcomingFixtures).toHaveBeenCalledWith(false);
    expect(result).toMatchObject({
      accepted: true,
      oddsAccepted: true,
      processing: 'BACKGROUND_DURABLE_WORKERS',
      predictions: { scannedFixtures: 12, enqueued: 8, refreshed: 4 },
    });
    expect(monitor.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ADMIN_ACTION',
      level: 'INFO',
    }));
  });
});
