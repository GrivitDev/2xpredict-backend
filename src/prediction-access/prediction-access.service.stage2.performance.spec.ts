import { PredictionAccessService } from './prediction-access.service';
import { PredictionAccessPlan } from './enums/prediction-access-plan.enum';

type MockQuery<T> = {
  sort: jest.Mock;
  limit: jest.Mock;
  lean: jest.Mock;
  exec: jest.Mock<Promise<T>, []>;
};

function query<T>(value: T): MockQuery<T> {
  const result: Partial<MockQuery<T>> = {};
  result.sort = jest.fn().mockReturnValue(result);
  result.limit = jest.fn().mockReturnValue(result);
  result.lean = jest.fn().mockReturnValue(result);
  result.exec = jest.fn().mockResolvedValue(value);
  return result as MockQuery<T>;
}

function createService(): any {
  return Object.create(PredictionAccessService.prototype) as any;
}

describe('PredictionAccessService Stage 2 read efficiency', () => {
  it('does not enrich Pick Center records used only for the daily league denominator', async () => {
    const filteredPick = {
      eventId: 'fixture-filtered',
      leagueId: 'league-filtered',
      fixtureDate: new Date('2026-11-25T12:00:00.000Z'),
      selectedMarkets: [],
    };
    const allocationPick = {
      eventId: 'fixture-other-league',
      leagueId: 'league-other',
      fixtureDate: new Date('2026-11-25T14:00:00.000Z'),
      selectedMarkets: [
        {
          marketKey: 'MATCH_RESULT',
          status: 'SELECTED',
          actualOutcome: 'PENDING',
        },
      ],
    };
    const allocation = {
      scope: 'PICK_CENTER',
      percentage: 60,
      totalByDate: new Map(),
      accessibleByDate: new Map(),
    };
    const marketRead = query<any[]>([]);
    const service = createService();

    service.getAccessPlan = jest
      .fn()
      .mockResolvedValue(PredictionAccessPlan.FREE);
    service.pagination = jest.fn().mockReturnValue({
      page: 1,
      pageSize: 25,
      total: 0,
      pages: 0,
    });
    service.validateActiveReadFilters = jest.fn();
    service.getMarketAccessSummary = jest.fn().mockReturnValue({ mode: 'test' });
    service.findPickCenterRecords = jest
      .fn()
      .mockImplementation((filters: Record<string, unknown>) =>
        Promise.resolve(filters.leagueId ? [filteredPick] : [allocationPick]),
      );
    service.enrichPickCenterRecords = jest
      .fn()
      .mockImplementation(async (records: any[]) => records);
    service.buildPickCenterLeagueAccessAllocation = jest
      .fn()
      .mockReturnValue(allocation);
    service.canAccessActiveLeague = jest.fn().mockReturnValue(true);
    service.filterPickCenter = jest
      .fn()
      .mockReturnValue({ selectedMarkets: [] });
    service.getDailyLeagueAccessSummary = jest.fn().mockReturnValue({});
    service.marketPredictionModel = {
      find: jest.fn().mockReturnValue(marketRead),
    };

    const result = await service.listMarkets(
      {
        leagueId: 'league-filtered',
        from: '2026-11-25',
        to: '2026-11-25',
      },
      null,
    );

    expect(service.findPickCenterRecords).toHaveBeenCalledTimes(2);
    expect(service.enrichPickCenterRecords).toHaveBeenCalledTimes(1);
    expect(service.enrichPickCenterRecords).toHaveBeenCalledWith([
      filteredPick,
    ]);
    expect(service.buildPickCenterLeagueAccessAllocation).toHaveBeenCalledWith(
      [allocationPick],
      PredictionAccessPlan.FREE,
    );
    expect(result).toMatchObject({
      items: [],
      pagination: { total: 0, pages: 0 },
      accessPlan: PredictionAccessPlan.FREE,
    });
  });

  it('pushes curated date windows into MongoDB and retains legacy selection-date records', async () => {
    const service = createService();
    const inRange = {
      _id: 'curated-current',
      status: 'PUBLISHED',
      fixtureDateFrom: new Date('2026-11-22T05:00:00.000Z'),
      selections: [],
    };
    const legacyInRange = {
      _id: 'curated-legacy',
      status: 'PUBLISHED',
      selections: [
        { fixtureDate: new Date('2026-11-22T08:00:00.000Z') },
      ],
    };
    const outOfRange = {
      _id: 'curated-outside',
      status: 'PUBLISHED',
      fixtureDateFrom: new Date('2026-11-23T05:00:00.000Z'),
      selections: [],
    };
    const curatedRead = query<any[]>([
      inRange,
      legacyInRange,
      outOfRange,
    ]);
    const curatedModel = {
      find: jest.fn().mockReturnValue(curatedRead),
    };
    service.curatedPredictionModel = curatedModel;

    const result = await service.getCuratedRecordsForInput({
      from: '2026-11-22',
      to: '2026-11-22',
    });

    const from = service.parseLagosDate('2026-11-22', false);
    const to = service.parseLagosDate('2026-11-22', true);
    const dateRange = { $gte: from, $lt: to };

    expect(curatedModel.find).toHaveBeenCalledWith({
      status: { $in: ['PUBLISHED', 'SETTLED'] },
      $or: [
        { fixtureDateFrom: dateRange },
        { 'selections.fixtureDate': dateRange },
      ],
    });
    expect(curatedRead.sort).toHaveBeenCalledWith({
      fixtureDateFrom: 1,
      createdAt: -1,
    });
    expect(result.map((record: any) => record._id)).toEqual([
      'curated-current',
      'curated-legacy',
    ]);
  });

  it('preserves the all-date curated query when no date range is supplied', async () => {
    const service = createService();
    const curatedRead = query<any[]>([]);
    const curatedModel = {
      find: jest.fn().mockReturnValue(curatedRead),
    };
    service.curatedPredictionModel = curatedModel;

    await service.getCuratedRecordsForInput({});

    expect(curatedModel.find).toHaveBeenCalledWith({
      status: { $in: ['PUBLISHED', 'SETTLED'] },
    });
  });
});
