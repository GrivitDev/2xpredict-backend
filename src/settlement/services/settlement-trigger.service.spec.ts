import { SettlementTriggerService } from './settlement-trigger.service';

describe('SettlementTriggerService', () => {
  const createService = (queue: Record<string, any>) =>
    new SettlementTriggerService(queue as any);

  it('deduplicates target event IDs before enqueueing', async () => {
    const queue = {
      enqueueForSportsFixtureChange: jest.fn().mockResolvedValue({ enqueued: true }),
    };
    const service = createService(queue);

    await service.onTargetsCreated(
      [' event-1 ', 'event-1', 'event-2', ''],
      'PREDICTION_CREATED',
    );

    expect(queue.enqueueForSportsFixtureChange).toHaveBeenCalledTimes(2);
    expect(queue.enqueueForSportsFixtureChange).toHaveBeenNthCalledWith(
      1,
      'event-1',
      undefined,
      'PREDICTION_CREATED',
    );
  });

  it('surfaces a committed-target queue handoff failure to the caller', async () => {
    const queue = {
      enqueueForSportsFixtureChange: jest.fn().mockRejectedValue(new Error('Mongo unavailable')),
    };
    const service = createService(queue);

    await expect(
      service.onTargetsCreated(['event-1'], 'BET_LAB_TICKET_CREATED'),
    ).rejects.toThrow('Settlement enqueue failed');
  });

  it('surfaces Sports outbox enqueue failures so the durable outbox can retry', async () => {
    const queue = {
      enqueueForSportsFixtureChange: jest.fn().mockRejectedValue(new Error('temporary write failure')),
    };
    const service = createService(queue);

    await expect(
      service.onSportsDataChanged(['event-1'], 'MATCH_TIMELINE' as any),
    ).rejects.toThrow('Settlement enqueue failed');
  });

  it('delegates startup catch-up to the queue reconciliation service', async () => {
    const result = { candidateEventIds: 4, queued: 3, skipped: 1, failed: 0, skippedReasons: {} };
    const queue = {
      reconcileExistingUnsettledTargets: jest.fn().mockResolvedValue(result),
    };
    const service = createService(queue);
    await expect(service.onSportsBootstrapCompleted()).resolves.toEqual(result);
    expect(queue.reconcileExistingUnsettledTargets).toHaveBeenCalledTimes(1);
  });
});
