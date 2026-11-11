import { SportsOddsCollectionService } from './sports-odds-collection.service';

describe('SportsOddsCollectionService provider fallback chain', () => {
  let service: SportsOddsCollectionService;
  let espn: {
    getMatchOdds: jest.Mock;
    getMatchSummary: jest.Mock;
  };
  let oddsApi: {
    getEventOdds: jest.Mock;
    getSportOdds: jest.Mock;
  };
  let normalizer: {
    normalizeEspnOdds: jest.Mock;
    normalizeEspnSummaryOdds: jest.Mock;
    normalizeOddsApiEvent: jest.Mock;
  };

  const input = {
    fixtureId: 'fixture-1',
    homeTeam: 'Türkiye',
    awayTeam: 'Belgium',
    kickoffAt: new Date('2026-11-12T17:00:00.000Z'),
    espnLeagueId: 'uefa.nations',
    espnEventId: 'event-1',
    espnCompetitionId: 'event-1',
  };

  beforeEach(() => {
    espn = {
      getMatchOdds: jest.fn().mockResolvedValue({ items: [] }),
      getMatchSummary: jest.fn().mockResolvedValue({ pickcenter: [] }),
    };
    oddsApi = {
      getEventOdds: jest.fn(),
      getSportOdds: jest.fn().mockResolvedValue({ items: [] }),
    };
    normalizer = {
      normalizeEspnOdds: jest.fn().mockReturnValue(null),
      normalizeEspnSummaryOdds: jest.fn().mockReturnValue(null),
      normalizeOddsApiEvent: jest.fn().mockReturnValue(null),
    };

    service = new SportsOddsCollectionService(
      espn as any,
      oddsApi as any,
      normalizer as any,
    );
  });

  it('treats successful empty ESPN responses as no-data, not as an exception', async () => {
    const result = await service.collectFixtureOdds(input);

    expect(espn.getMatchOdds).toHaveBeenCalledTimes(1);
    expect(espn.getMatchSummary).toHaveBeenCalledTimes(1);
    expect(oddsApi.getSportOdds).not.toHaveBeenCalled();
    expect(result.snapshot).toBeNull();
    expect(result.reason).toContain('ESPN /odds returned no usable bookmaker markets/prices');
    expect(result.reason).toContain('ESPN Summary pickcenter contained no usable bookmaker markets/prices');
    expect(result.reason).toContain('no Odds API sport-key mapping exists');
  });

  it('returns immediately when the Core odds endpoint normalizes successfully', async () => {
    const snapshot = { fixtureId: 'fixture-1', provider: 'ESPN' };
    normalizer.normalizeEspnOdds.mockReturnValue(snapshot);

    const result = await service.collectFixtureOdds(input);

    expect(result.snapshot).toBe(snapshot);
    expect(result.provider).toBe('ESPN');
    expect(result.fallbackUsed).toBe(false);
    expect(espn.getMatchSummary).not.toHaveBeenCalled();
    expect(oddsApi.getSportOdds).not.toHaveBeenCalled();
  });

  it('preserves a real ESPN transport failure when the Summary fallback has no prices', async () => {
    const transportError = Object.assign(new Error('ESPN request timed out'), {
      retryable: true,
    });
    espn.getMatchOdds.mockRejectedValue(transportError);

    await expect(service.collectFixtureOdds(input)).rejects.toBe(transportError);
    expect(espn.getMatchSummary).toHaveBeenCalledTimes(1);
  });

  it('uses the configured Odds API sport listing after both ESPN sources have no prices', async () => {
    const result = await service.collectFixtureOdds({
      ...input,
      oddsApiSportKey: 'soccer_uefa_nations_league',
    });

    expect(oddsApi.getSportOdds).toHaveBeenCalledWith(
      'soccer_uefa_nations_league',
      { regions: undefined, markets: undefined },
    );
    expect(result.snapshot).toBeNull();
    expect(result.reason).toContain('Odds API sport listing contained no exact matching event');
  });
});
