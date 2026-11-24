import { OddsWorkerService } from './odds-worker.service';

const makeFixture = (overrides: Record<string, unknown> = {}) => ({
  id: 'fixture-upcoming',
  kickoffAt: new Date(Date.now() + 24 * 60 * 60_000),
  status: { state: 'SCHEDULED', isFinal: false },
  ...overrides,
});

describe('OddsWorkerService pricing output retries', () => {
  const makeService = () => {
    const service = Object.create(OddsWorkerService.prototype) as any;
    service.stopping = false;
    service.queueJobsCompleted = 0;
    service.queueJobsFailed = 0;
    service.lastQueueError = undefined;
    service.logger = { warn: jest.fn(), debug: jest.fn(), log: jest.fn(), error: jest.fn() };
    service.oddsService = { refreshFixture: jest.fn() };
    service.sportsRead = { getFixture: jest.fn() };
    service.queue = {
      markHeartbeat: jest.fn().mockResolvedValue(true),
      markCompleted: jest.fn().mockResolvedValue(true),
      markFailed: jest.fn().mockResolvedValue('RETRY'),
    };
    service.enqueuePredictionRecalculationForFixture = jest.fn().mockResolvedValue(undefined);
    return service;
  };

  it('does not treat a zero-row result as successful pricing for an eligible fixture', async () => {
    const service = makeService();
    const fixture = makeFixture();
    service.oddsService.refreshFixture.mockResolvedValue(0);

    const outcome = await service.refreshFixtureWithOutcome(fixture);

    expect(outcome).toEqual({ status: 'NO_PRICE', priceCount: 0 });
  });

  it('acknowledges zero rows for a genuinely non-priceable fixture', async () => {
    const service = makeService();
    const fixture = makeFixture({ status: { state: 'CANCELLED', isFinal: false } });
    service.oddsService.refreshFixture.mockResolvedValue(0);

    const outcome = await service.refreshFixtureWithOutcome(fixture);

    expect(outcome).toEqual({ status: 'UNPRICEABLE', priceCount: 0 });
  });

  it('accepts positive persisted price counts', async () => {
    const service = makeService();
    const fixture = makeFixture();
    service.oddsService.refreshFixture.mockResolvedValue(3);

    const outcome = await service.refreshFixtureWithOutcome(fixture);

    expect(outcome).toEqual({ status: 'PRICED', priceCount: 3 });
  });

  it('sends eligible zero-price queue jobs to the durable retry path', async () => {
    const service = makeService();
    const fixture = makeFixture();
    service.sportsRead.getFixture.mockResolvedValue(fixture);
    service.oddsService.refreshFixture.mockResolvedValue(0);
    const job = {
      jobKey: 'odds-job-1',
      scope: { fixtureId: fixture.id },
      attempts: 1,
      retryCount: 0,
      maxAttempts: 20,
    };

    await service.processQueuedJob(job, 'odds-worker-1');

    expect(service.queue.markFailed).toHaveBeenCalledTimes(1);
    const failure = service.queue.markFailed.mock.calls[0][2] as Error & { retryable?: boolean };
    expect(failure.message).toContain('produced no price rows');
    expect(failure.retryable).toBe(true);
    expect(service.queue.markCompleted).not.toHaveBeenCalled();
    expect(service.enqueuePredictionRecalculationForFixture).not.toHaveBeenCalled();
  });

  it('completes a zero-price queue job for a cancelled fixture without retrying it', async () => {
    const service = makeService();
    const fixture = makeFixture({ status: { state: 'CANCELLED', isFinal: false } });
    service.sportsRead.getFixture.mockResolvedValue(fixture);
    service.oddsService.refreshFixture.mockResolvedValue(0);
    const job = {
      jobKey: 'odds-job-cancelled',
      scope: { fixtureId: fixture.id },
      attempts: 1,
      retryCount: 0,
      maxAttempts: 20,
    };

    await service.processQueuedJob(job, 'odds-worker-1');

    expect(service.queue.markCompleted).toHaveBeenCalledWith(job.jobKey, 'odds-worker-1');
    expect(service.queue.markFailed).not.toHaveBeenCalled();
    expect(service.enqueuePredictionRecalculationForFixture).not.toHaveBeenCalled();
  });
});
