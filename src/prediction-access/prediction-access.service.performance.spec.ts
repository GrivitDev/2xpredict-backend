import { PredictionAccessService } from './prediction-access.service';
import { PredictionAccessPlan } from './enums/prediction-access-plan.enum';
import { PredictionStatus } from '../predictions-engine/enums/prediction-status.enum';
import { ENABLED_PREDICTION_MARKET_KEYS } from './config/prediction-access.config';

function createQuery<T>(rows: T[]) {
  return {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(rows),
  };
}

function createPick() {
  return {
    eventId: 'fixture-1',
    leagueId: 'league-1',
    fixtureDate: new Date('2026-11-25T18:00:00.000Z'),
    selectedMarkets: [
      {
        marketPredictionId: 'market-approved-1',
        selectionKey: 'HOME',
      },
    ],
  };
}

function createService(options?: {
  picks?: any[];
  rawMarkets?: any[];
  visibleMarket?: any | null;
}) {
  const rawMarkets = options?.rawMarkets ?? [
    {
      _id: 'market-approved-1',
      eventId: 'fixture-1',
      marketKey: ENABLED_PREDICTION_MARKET_KEYS[0],
      selections: [{ key: 'HOME', status: 'CALCULATED' }],
    },
  ];
  const query = createQuery(rawMarkets);
  const service = Object.create(
    PredictionAccessService.prototype,
  ) as any;

  Object.assign(service, {
    getAccessPlan: jest.fn().mockResolvedValue(PredictionAccessPlan.PREMIUM),
    pagination: jest.fn().mockReturnValue({ page: 1, pageSize: 10 }),
    validateActiveReadFilters: jest.fn(),
    getMarketAccessSummary: jest.fn().mockReturnValue({ mode: 'TEST' }),
    findPickCenterRecords: jest
      .fn()
      .mockResolvedValue(options?.picks ?? [createPick()]),
    enrichPickCenterRecords: jest
      .fn()
      .mockImplementation(async (records: any[]) => records),
    buildPickCenterLeagueAccessAllocation: jest.fn().mockReturnValue({}),
    canAccessActiveLeague: jest.fn().mockReturnValue(true),
    filterPickCenter: jest.fn().mockImplementation((pick: any) => ({
      selectedMarkets: pick.selectedMarkets,
    })),
    getDailyLeagueAccessSummary: jest.fn().mockReturnValue({}),
    applyDateRange: jest.fn(),
    filterActiveMarket: jest
      .fn()
      .mockReturnValue(options?.visibleMarket === undefined ? rawMarkets[0] : options.visibleMarket),
    marketPredictionModel: {
      find: jest.fn().mockReturnValue(query),
    },
  });

  return { service, query, rawMarkets };
}

describe('PredictionAccessService market-read performance contract', () => {
  it('narrows market retrieval to prediction IDs approved by Pick Center', async () => {
    const { service, query, rawMarkets } = createService();

    const result = await service.listMarkets({ page: 1, pageSize: 10 });

    expect(service.marketPredictionModel.find).toHaveBeenCalledTimes(1);
    expect(service.marketPredictionModel.find).toHaveBeenCalledWith({
      eventId: { $in: ['fixture-1'] },
      status: PredictionStatus.CALCULATED,
      _id: { $in: ['market-approved-1'] },
    });
    expect(query.sort).toHaveBeenCalledWith({ fixtureDate: 1, marketName: 1 });
    expect(query.limit).toHaveBeenCalledWith(100000);
    expect(query.lean).toHaveBeenCalledTimes(1);
    expect(query.exec).toHaveBeenCalledTimes(1);

    // Public response contract: preserve items, pagination, plan and access data.
    expect(result).toEqual({
      items: [rawMarkets[0]],
      pagination: { page: 1, pageSize: 10, total: 1, pages: 1 },
      accessPlan: PredictionAccessPlan.PREMIUM,
      marketAccess: { mode: 'TEST' },
      leagueAccess: {},
    });
  });

  it('keeps the explicit-market path broad enough to report locked markets', async () => {
    const requestedMarketKey = ENABLED_PREDICTION_MARKET_KEYS[0];
    const { service } = createService({ visibleMarket: null });

    const result = await service.listMarkets({
      eventId: 'fixture-1',
      marketKey: requestedMarketKey,
      page: 1,
      pageSize: 10,
    });

    const query = service.marketPredictionModel.find.mock.calls[0][0];
    expect(query).toEqual({
      eventId: 'fixture-1',
      status: PredictionStatus.CALCULATED,
      marketKey: requestedMarketKey,
    });
    expect(query).not.toHaveProperty('_id');
    expect(result).toEqual({
      items: [],
      pagination: { page: 1, pageSize: 10, total: 0, pages: 0 },
      accessPlan: PredictionAccessPlan.PREMIUM,
      marketAccess: { mode: 'TEST' },
      leagueAccess: {},
      requestedMarketLocked: true,
    });
  });

  it('does not query market predictions when no Pick Center fixture is accessible', async () => {
    const { service } = createService({ picks: [] });

    const result = await service.listMarkets({ page: 1, pageSize: 10 });

    expect(service.marketPredictionModel.find).not.toHaveBeenCalled();
    expect(result).toEqual({
      items: [],
      pagination: { page: 1, pageSize: 10, total: 0, pages: 0 },
      accessPlan: PredictionAccessPlan.PREMIUM,
      marketAccess: { mode: 'TEST' },
      leagueAccess: {},
    });
  });
});
