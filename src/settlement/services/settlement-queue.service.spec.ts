import { SettlementQueueService } from './settlement-queue.service';
import { SettlementJobStatus } from '../enums/settlement-job-status.enum';
import { createSettlementSourceFingerprint } from '../utils/sports-settlement-fingerprint.util';

function query(value: unknown) {
  const chain: Record<string, any> = {
    exec: jest.fn().mockResolvedValue(value),
  };
  for (const method of ['sort', 'select', 'lean']) {
    chain[method] = jest.fn(() => chain);
  }
  return chain;
}

function makeMatch() {
  return {
    fixture: {
      id: 'fixture-1',
      competitionId: 'league-1',
      status: { state: 'LIVE', isFinal: false },
      competitors: [],
      periodScores: [],
      source: { collectedAt: new Date('2026-11-11T10:00:00.000Z') },
    },
    timeline: [],
  } as any;
}

function createService(options?: {
  match?: any;
  predictionTarget?: boolean;
  betLabTarget?: boolean;
  activeJob?: any;
  updateOneResult?: unknown;
  findOneAndUpdateResults?: unknown[];
  updateManyResults?: unknown[];
}) {
  const jobModel = {
    findOne: jest.fn(() => query(options?.activeJob ?? null)),
    findOneAndUpdate: jest.fn((..._args: unknown[]) =>
      query(options?.findOneAndUpdateResults?.shift() ?? null),
    ),
    updateOne: jest.fn(() => query(options?.updateOneResult ?? { modifiedCount: 1 })),
    updateMany: jest.fn(() => query(options?.updateManyResults?.shift() ?? { modifiedCount: 0 })),
    exists: jest.fn(() => query(true)),
  };
  const predictionModel = {
    exists: jest.fn(() => query(options?.predictionTarget ?? false)),
  };
  const betLabModel = {
    exists: jest.fn(() => query(options?.betLabTarget ?? false)),
  };
  const sportsRead = {
    getMatch: jest.fn().mockResolvedValue(options?.match ?? makeMatch()),
  };
  const service = new SettlementQueueService(
    jobModel as any,
    predictionModel as any,
    betLabModel as any,
    sportsRead as any,
  );
  return { service, jobModel, predictionModel, betLabModel, sportsRead };
}

describe('SettlementQueueService reliability', () => {
  it('rejects empty event IDs without reading Sports or writing a job', async () => {
    const { service, sportsRead, jobModel } = createService();

    const result = await service.enqueueForSportsFixtureChange('  ');

    expect(result).toEqual({ enqueued: false, reason: 'EMPTY_EVENT_ID' });
    expect(sportsRead.getMatch).not.toHaveBeenCalled();
    expect(jobModel.findOne).not.toHaveBeenCalled();
  });

  it('does not create settlement work when no unresolved Prediction or Bet Lab target exists', async () => {
    const { service, jobModel } = createService({
      predictionTarget: false,
      betLabTarget: false,
    });

    const result = await service.enqueueForSportsFixtureChange('fixture-1');

    expect(result).toEqual({ enqueued: false, reason: 'NO_UNSETTLED_TARGETS' });
    expect(jobModel.findOne).not.toHaveBeenCalled();
    expect(jobModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('coalesces an unchanged source while the matching fixture job is already processing', async () => {
    const match = makeMatch();
    const sourceFingerprint = createSettlementSourceFingerprint(match);
    const { service, jobModel } = createService({
      match,
      predictionTarget: true,
      activeJob: {
        _id: 'job-1',
        jobKey: `fixture-1:${sourceFingerprint}`,
        eventId: 'fixture-1',
        sourceFingerprint,
        status: SettlementJobStatus.PROCESSING,
        rerunRequested: false,
      },
    });

    const result = await service.enqueueForSportsFixtureChange('fixture-1');

    expect(result).toMatchObject({
      enqueued: false,
      alreadyExists: true,
      reason: 'ACTIVE_JOB_ALREADY_PROCESSING',
    });
    expect(jobModel.updateOne).not.toHaveBeenCalled();
  });

  it('requests one fenced rerun when Sports facts change during active processing', async () => {
    const match = makeMatch();
    const { service, jobModel } = createService({
      match,
      predictionTarget: true,
      activeJob: {
        _id: 'job-1',
        jobKey: 'fixture-1:old-source',
        eventId: 'fixture-1',
        sourceFingerprint: 'old-source',
        status: SettlementJobStatus.PROCESSING,
        rerunRequested: false,
      },
      updateOneResult: { modifiedCount: 1 },
    });

    const result = await service.enqueueForSportsFixtureChange('fixture-1');

    expect(result).toMatchObject({
      enqueued: true,
      alreadyExists: true,
      reason: 'RERUN_REQUESTED_FOR_NEW_SPORTS_SOURCE',
    });
    expect(jobModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'job-1',
        status: SettlementJobStatus.PROCESSING,
        rerunRequested: { $ne: true },
      }),
      { $set: { rerunRequested: true, rerunTriggerReason: 'SPORTS_DATA_CHANGED' } },
    );
  });

  it('claims a due job atomically and issues a distinct worker lease token', async () => {
    const claimedJob = {
      _id: 'job-1',
      jobKey: 'fixture-1:fingerprint',
      status: SettlementJobStatus.PROCESSING,
      lockedBy: 'worker-a',
      claimToken: 'lease-token',
    };
    const { service, jobModel } = createService({
      findOneAndUpdateResults: [claimedJob],
    });

    const result = await service.claimNextDueJob('worker-a');

    expect(result).toBe(claimedJob);
    expect(jobModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: { $in: [SettlementJobStatus.QUEUED, SettlementJobStatus.RETRY] },
        nextRunAt: { $lte: expect.any(Date) },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: SettlementJobStatus.PROCESSING,
          lockedBy: 'worker-a',
          claimToken: expect.any(String),
        }),
        $inc: { attempts: 1 },
      }),
      expect.objectContaining({
        returnDocument: 'after',
        sort: { priority: 1, nextRunAt: 1, createdAt: 1 },
      }),
    );
    expect(jobModel.findOneAndUpdate.mock.results[0].value.select).toHaveBeenCalledWith('+claimToken');
  });

  it('requires the exact worker and claim token before accepting lease ownership', async () => {
    const { service, jobModel } = createService();
    const job = {
      _id: 'job-1',
      jobKey: 'fixture-1:fingerprint',
      status: SettlementJobStatus.PROCESSING,
      lockedBy: 'worker-a',
      claimToken: 'lease-token',
    } as any;

    await expect(service.ownsProcessingLease(job)).resolves.toBe(true);
    expect(jobModel.exists).toHaveBeenCalledWith({
      _id: 'job-1',
      status: SettlementJobStatus.PROCESSING,
      lockedBy: 'worker-a',
      claimToken: 'lease-token',
    });
  });

  it('completes a job only through its active lease and clears the lease fields', async () => {
    const { service, jobModel } = createService({
      findOneAndUpdateResults: [null],
      updateOneResult: { modifiedCount: 1 },
    });
    const job = {
      _id: 'job-1',
      jobKey: 'fixture-1:fingerprint',
      status: SettlementJobStatus.PROCESSING,
      lockedBy: 'worker-a',
      claimToken: 'lease-token',
    } as any;

    await expect(service.complete(job, {
      partial: false,
      counts: { predictionSelectionsSettled: 1 },
      unresolvedReasons: [],
      durationMs: 25,
    })).resolves.toBe(false);

    expect(jobModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'job-1',
        status: SettlementJobStatus.PROCESSING,
        lockedBy: 'worker-a',
        claimToken: 'lease-token',
        rerunRequested: { $ne: true },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: SettlementJobStatus.COMPLETED }),
        $unset: expect.objectContaining({
          lockedAt: 1,
          lockedBy: 1,
          claimToken: 1,
        }),
      }),
    );
  });

  it('requeues a requested rerun instead of completing the old processing pass', async () => {
    const { service, jobModel } = createService({
      findOneAndUpdateResults: [{ jobKey: 'fixture-1:fingerprint', status: SettlementJobStatus.QUEUED }],
    });
    const job = {
      _id: 'job-1',
      jobKey: 'fixture-1:fingerprint',
      status: SettlementJobStatus.PROCESSING,
      lockedBy: 'worker-a',
      claimToken: 'lease-token',
    } as any;

    await expect(service.complete(job, {
      partial: false,
      counts: {},
      unresolvedReasons: [],
      durationMs: 10,
    })).resolves.toBe(true);

    expect(jobModel.updateOne).not.toHaveBeenCalled();
    expect(jobModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ rerunRequested: true }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: SettlementJobStatus.QUEUED,
          triggerReason: 'TARGET_CREATED_DURING_PROCESSING',
        }),
        $unset: expect.objectContaining({ claimToken: 1, rerunRequested: 1 }),
      }),
      { returnDocument: 'after' },
    );
  });

  it('recovers expired worker leases into retry and exhausted states independently', async () => {
    const { service, jobModel } = createService({
      updateManyResults: [
        { modifiedCount: 3 },
        { modifiedCount: 1 },
      ],
    });

    await expect(service.recoverExpiredProcessingJobs()).resolves.toEqual({
      recoveredForRetry: 3,
      exhausted: 1,
      total: 4,
    });

    expect(jobModel.updateMany).toHaveBeenCalledTimes(2);
    expect(jobModel.updateMany.mock.calls[0][0]).toMatchObject({
      status: SettlementJobStatus.PROCESSING,
      $expr: { $lt: expect.any(Array) },
    });
    expect(jobModel.updateMany.mock.calls[1][0]).toMatchObject({
      status: SettlementJobStatus.PROCESSING,
      $expr: { $gte: expect.any(Array) },
    });
    expect(jobModel.updateMany.mock.calls[0][1]).toMatchObject({
      $set: { status: SettlementJobStatus.RETRY },
      $unset: { claimToken: 1, lockedBy: 1, lockedAt: 1 },
    });
    expect(jobModel.updateMany.mock.calls[1][1]).toMatchObject({
      $set: { status: SettlementJobStatus.FAILED },
      $unset: { claimToken: 1, lockedBy: 1, lockedAt: 1 },
    });
  });
});
