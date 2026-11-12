import { BackgroundWorkLimiterService } from './background-work-limiter.service';

describe('BackgroundWorkLimiterService', () => {
  let limiter: BackgroundWorkLimiterService;

  beforeEach(() => {
    jest.useFakeTimers();
    limiter = new BackgroundWorkLimiterService();
  });

  afterEach(() => {
    limiter.onModuleDestroy();
    jest.useRealTimers();
  });

  it('never grants more than twelve simultaneous permits', async () => {
    const releases = await Promise.all(
      Array.from({ length: 12 }, (_, index) => limiter.acquire(`lane-${index}`)),
    );

    let thirteenthGranted = false;
    const thirteenth = limiter.acquire('lane-13').then((release) => {
      thirteenthGranted = true;
      return release;
    });

    expect(limiter.getStatus().activeJobs).toBe(12);
    expect(limiter.getStatus().waitingJobs).toBe(1);
    expect(thirteenthGranted).toBe(false);

    releases[0]();
    const releaseThirteenth = await thirteenth;
    expect(thirteenthGranted).toBe(true);
    expect(limiter.getStatus().activeJobs).toBe(12);

    releaseThirteenth();
    for (const release of releases.slice(1)) release();
    expect(limiter.getStatus().activeJobs).toBe(0);
  });

  it('allows only one active permit per lane and spaces starts by one second', async () => {
    const firstRelease = await limiter.acquire('sports:fixtures');
    let secondGranted = false;
    const secondPermit = limiter.acquire('sports:fixtures').then((release) => {
      secondGranted = true;
      return release;
    });

    await Promise.resolve();
    expect(secondGranted).toBe(false);
    expect(limiter.getStatus().activeJobs).toBe(1);

    firstRelease();
    await Promise.resolve();
    expect(secondGranted).toBe(false);

    jest.advanceTimersByTime(999);
    await Promise.resolve();
    expect(secondGranted).toBe(false);

    jest.advanceTimersByTime(1);
    const secondRelease = await secondPermit;
    expect(secondGranted).toBe(true);
    secondRelease();
    expect(limiter.getStatus().activeJobs).toBe(0);
  });
});
