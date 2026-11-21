import { OddsWorkerService } from './odds-worker.service';
import { ODDS_CONFIG } from '../config/odds.config';

describe('OddsWorkerService seven-day pricing horizon', () => {
  const makeService = () => {
    const service = Object.create(OddsWorkerService.prototype) as any;
    service.stopping = false;
    service.busy = false;
    service.cursor = undefined;
    service.inventorySweepStartedAt = undefined;
    service.inventoryWindowFrom = undefined;
    service.inventoryWindowTo = undefined;
    service.inventorySweepPages = 0;
    service.inventorySweepFixtures = 0;
    service.inventorySweepSucceeded = 0;
    service.inventorySweepFailed = 0;
    service.cyclesCompleted = 0;
    service.cyclesFailed = 0;
    service.consecutiveCycleFailures = 0;
    service.consecutivePartialFailureCycles = 0;
    service.lastCycleStartedAt = undefined;
    service.lastCycleCompletedAt = undefined;
    service.lastSuccessfulCycleAt = undefined;
    service.lastBatchSize = 0;
    service.lastRefreshedCount = 0;
    service.lastFailedCount = 0;
    service.backgroundWork = { acquire: jest.fn().mockResolvedValue(() => undefined) };
    service.sportsRead = { getFixtures: jest.fn().mockResolvedValue({ items: [], nextCursor: undefined }) };
    service.oddsService = { pruneExpiredPrices: jest.fn() };
    service.adminGateway = { setModuleOperationalStatus: jest.fn(), publishModuleEvent: jest.fn() };
    service.queue = {};
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    service.startedAt = new Date();
    return service;
  };

  it('keeps periodic inventory reconciliation on a two-minute fallback cadence', () => {
    expect(ODDS_CONFIG.workerIntervalMs).toBe(2 * 60_000);
  });

  it('scans only the next seven days and prioritizes the nearest kickoffs', async () => {
    const service = makeService();
    const before = Date.now();

    await service.runSafely();

    expect(service.sportsRead.getFixtures).toHaveBeenCalledTimes(1);
    const query = service.sportsRead.getFixtures.mock.calls[0][0];
    expect(query.from.getTime()).toBeGreaterThanOrEqual(before);
    expect(query.to.getTime() - query.from.getTime()).toBe(
      ODDS_CONFIG.pricingLookaheadHours * 60 * 60_000,
    );
    expect(query.sortOrder).toBe('ASC');
    expect(query.limit).toBe(ODDS_CONFIG.workerBatchSize);
    expect(service.getMonitorStatus().configuredScanScope).toBe('UPCOMING_NEXT_7_DAYS');
  });

  it('does not price or trigger predictions for fixtures outside the horizon', async () => {
    const service = makeService();
    const outside = {
      id: 'fixture-outside-window',
      kickoffAt: new Date(Date.now() + (ODDS_CONFIG.pricingLookaheadHours + 24) * 60 * 60_000),
      status: { state: 'SCHEDULED', isFinal: false },
    };

    expect(service.isWithinPricingWindow(outside)).toBe(false);
    expect(service.isUpcomingPredictionFixture(outside)).toBe(false);
  });

  it('keeps fixtures inside the horizon eligible', () => {
    const service = makeService();
    const inside = {
      id: 'fixture-inside-window',
      kickoffAt: new Date(Date.now() + 24 * 60 * 60_000),
      status: { state: 'SCHEDULED', isFinal: false },
    };

    expect(service.isWithinPricingWindow(inside)).toBe(true);
    expect(service.isUpcomingPredictionFixture(inside)).toBe(true);
  });

  it('still reprices cancelled fixtures inside the horizon to clear stale quotes', () => {
    const service = makeService();
    const cancelled = {
      id: 'fixture-cancelled',
      kickoffAt: new Date(Date.now() + 24 * 60 * 60_000),
      status: { state: 'CANCELLED', isFinal: false },
    };

    expect(service.isWithinPricingWindow(cancelled)).toBe(true);
    expect(service.isUpcomingPredictionFixture(cancelled)).toBe(false);
  });
});
