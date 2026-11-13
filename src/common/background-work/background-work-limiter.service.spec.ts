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

  it('never grants more than six simultaneous permits', async () => {
    const releases = await Promise.all(
      Array.from({ length: 6 }, (_, index) => limiter.acquire(`lane-${index}`)),
    );

    let seventhGranted = false;
    const seventh = limiter.acquire('lane-7').then((release) => {
      seventhGranted = true;
      return release;
    });

    expect(limiter.getStatus().activeJobs).toBe(6);
    expect(limiter.getStatus().maximumConcurrentJobs).toBe(6);
    expect(limiter.getStatus().waitingJobs).toBe(1);
    expect(seventhGranted).toBe(false);

    releases[0]();
    const releaseSeventh = await seventh;
    expect(seventhGranted).toBe(true);
    expect(limiter.getStatus().activeJobs).toBe(6);

    releaseSeventh();
    for (const release of releases.slice(1)) release();
    expect(limiter.getStatus().activeJobs).toBe(0);
  });

  it('allows only one active permit per lane and spaces starts by one second', async () => {
    const firstRelease = await limiter.acquire('sports:fixture_daily_refresh');
    let secondGranted = false;
    const secondPermit = limiter.acquire('sports:fixture_daily_refresh').then((release) => {
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

  it('grants critical settlement work before an older maintenance waiter', async () => {
    const occupied = await Promise.all(
      Array.from({ length: 6 }, (_, index) => limiter.acquire(`occupied-${index}`)),
    );

    let maintenanceGranted = false;
    const maintenance = limiter.acquire('odds:retention').then((release) => {
      maintenanceGranted = true;
      return release;
    });
    const settlement = limiter.acquire('settlement:queue');

    occupied[0]();
    const releaseSettlement = await settlement;
    expect(maintenanceGranted).toBe(false);
    expect(limiter.getStatus().waitingJobs).toBe(1);

    releaseSettlement();
    occupied.slice(1).forEach((release) => release());
    const releaseMaintenance = await maintenance;
    releaseMaintenance();
  });

  it('keeps critical work ahead even when maintenance has waited for a long time', async () => {
    const occupied = await Promise.all(
      Array.from({ length: 6 }, (_, index) => limiter.acquire(`occupied-${index}`)),
    );

    let maintenanceGranted = false;
    const maintenance = limiter.acquire('odds:retention').then((release) => {
      maintenanceGranted = true;
      return release;
    });
    jest.advanceTimersByTime(10 * 60_000);
    const settlement = limiter.acquire('settlement:queue');

    occupied[0]();
    const releaseSettlement = await settlement;
    expect(maintenanceGranted).toBe(false);

    releaseSettlement();
    occupied.slice(1).forEach((release) => release());
    const releaseMaintenance = await maintenance;
    releaseMaintenance();
  });

  it('ages normal work so it can overtake newer normal-priority work', async () => {
    const occupied = await Promise.all(
      Array.from({ length: 6 }, (_, index) => limiter.acquire(`occupied-${index}`)),
    );

    let agedGranted = false;
    const agedMaintenance = limiter.acquire('odds:retention').then((release) => {
      agedGranted = true;
      return release;
    });
    jest.advanceTimersByTime(4 * 60_000);
    const newerNormal = limiter.acquire('predictions:queue-sync');

    occupied[0]();
    const releaseAged = await agedMaintenance;
    expect(agedGranted).toBe(true);
    expect(limiter.getStatus().waitingJobs).toBe(1);

    releaseAged();
    const releaseNormal = await newerNormal;
    releaseNormal();
    occupied.slice(1).forEach((release) => release());
  });

  it('reports waiting work by priority class', async () => {
    const occupied = await Promise.all(
      Array.from({ length: 6 }, (_, index) => limiter.acquire(`occupied-${index}`)),
    );
    const waiters = [
      limiter.acquire('settlement:queue'),
      limiter.acquire('odds:pricing-queue'),
      limiter.acquire('predictions:queue-sync'),
      limiter.acquire('bet-lab:retention'),
    ];

    expect(limiter.getStatus().waitingByPriority).toEqual({
      critical: 1,
      high: 1,
      normal: 1,
      low: 1,
    });

    // Prevent unresolved promises from leaking between fake-timer test runs.
    occupied.forEach((release) => release());
    const granted = await Promise.all(waiters);
    granted.forEach((release) => release());
  });
});
