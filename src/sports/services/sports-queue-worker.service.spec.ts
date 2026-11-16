import { SportsQueueJobType } from '../interfaces/sports-queue.interface';
import { SportsQueueWorkerService } from './sports-queue-worker.service';

describe('SportsQueueWorkerService global-gate routing', () => {
  let worker: SportsQueueWorkerService;
  let queue: {
    claimNext: jest.Mock;
    setWakeHandler: jest.Mock;
  };
  let backgroundWork: {
    acquire: jest.Mock;
    getStatus: jest.Mock;
  };
  let releasePermit: jest.Mock;

  beforeEach(() => {
    releasePermit = jest.fn();
    queue = {
      claimNext: jest.fn().mockResolvedValue(null),
      setWakeHandler: jest.fn(),
    };
    backgroundWork = {
      acquire: jest.fn().mockResolvedValue(releasePermit),
      getStatus: jest.fn().mockReturnValue({
        activeJobs: 0,
        maximumConcurrentJobs: 10,
        waitingJobs: 0,
        activeLanes: [],
        waitingByPriority: { critical: 0, high: 0, normal: 0, low: 0 },
        minimumLaneStartIntervalMs: 1_000,
      }),
    };

    worker = new SportsQueueWorkerService(
      queue as any,
      {} as any,
      {} as any,
      backgroundWork as any,
    );
  });

  afterEach(() => {
    worker.onModuleDestroy();
  });

  it.each([
    SportsQueueJobType.LIVE_SCOREBOARD_REFRESH,
    SportsQueueJobType.BOOTSTRAP_PHASE_GATE,
    SportsQueueJobType.SEASON_DISCOVERY_PHASE_GATE,
    SportsQueueJobType.FIXTURE_SEASON_VALIDATION_GATE,
  ])('bypasses the global gate for %s', async (type) => {
    await (worker as any).pumpLane(type);

    expect(backgroundWork.acquire).not.toHaveBeenCalled();
    expect(queue.claimNext).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      type,
    );
  });

  it('keeps historical Summary backfill behind the global gate', async () => {
    await (worker as any).pumpLane(
      SportsQueueJobType.MATCH_SUMMARY_BACKFILL,
    );

    expect(backgroundWork.acquire).toHaveBeenCalledWith(
      `sports:${SportsQueueJobType.MATCH_SUMMARY_BACKFILL}`,
    );
    expect(releasePermit).toHaveBeenCalledTimes(1);
  });

  it('keeps normal post-match Summary collection behind the global gate', async () => {
    await (worker as any).pumpLane(
      SportsQueueJobType.MATCH_SUMMARY_COLLECTION,
    );

    expect(backgroundWork.acquire).toHaveBeenCalledWith(
      `sports:${SportsQueueJobType.MATCH_SUMMARY_COLLECTION}`,
    );
    expect(releasePermit).toHaveBeenCalledTimes(1);
  });
});
