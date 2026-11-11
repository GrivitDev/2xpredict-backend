import { SportsDomainCollectionService } from './sports-domain-collection.service';

describe('SportsDomainCollectionService odds checkpoints', () => {
  const kickoffAt = new Date(Date.now() + 48 * 60 * 60_000);
  let service: SportsDomainCollectionService;
  let state: {
    markStarted: jest.Mock;
    markNoData: jest.Mock;
    markSucceeded: jest.Mock;
    markFailed: jest.Mock;
  };
  let persistence: {
    getTeamById: jest.Mock;
    getCompetitionById: jest.Mock;
    saveOddsSnapshot: jest.Mock;
  };
  let oddsCollection: { collectFixtureOdds: jest.Mock };

  const fixture = {
    id: 'fixture-1',
    competitionId: 'competition-1',
    espnEventId: 'event-1',
    espnCompetitionId: 'event-1',
    kickoffAt,
    status: { state: 'SCHEDULED', isFinal: false },
    competitors: [
      { homeAway: 'HOME', teamId: 'home-1' },
      { homeAway: 'AWAY', teamId: 'away-1' },
    ],
  } as any;

  beforeEach(() => {
    state = {
      markStarted: jest.fn().mockResolvedValue(undefined),
      markNoData: jest.fn().mockResolvedValue(undefined),
      markSucceeded: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    persistence = {
      getTeamById: jest.fn(async (id: string) => ({ id, name: id })),
      getCompetitionById: jest.fn().mockResolvedValue({ id: 'competition-1', slug: 'uefa.nations' }),
      saveOddsSnapshot: jest.fn().mockResolvedValue(undefined),
    };
    oddsCollection = {
      collectFixtureOdds: jest.fn(),
    };

    service = new SportsDomainCollectionService(
      {} as any,
      persistence as any,
      state as any,
      oddsCollection as any,
    );
  });

  it('records a completed no-odds checkpoint without throwing or retrying the queue job', async () => {
    oddsCollection.collectFixtureOdds.mockResolvedValue({
      snapshot: null,
      provider: null,
      fallbackUsed: false,
      reason: 'ESPN /odds returned no usable markets; Summary pickcenter was empty.',
    });

    const result = await service.collectMatchOdds(fixture);

    expect(result.snapshot).toBeNull();
    expect(result.reason).toContain('Summary pickcenter was empty');
    expect(state.markNoData).toHaveBeenCalledTimes(1);
    expect(state.markFailed).not.toHaveBeenCalled();
    expect(persistence.saveOddsSnapshot).not.toHaveBeenCalled();
  });

  it('still marks actual provider/transport exceptions as failures', async () => {
    const providerError = Object.assign(new Error('ESPN request timed out'), {
      retryable: true,
    });
    oddsCollection.collectFixtureOdds.mockRejectedValue(providerError);

    await expect(service.collectMatchOdds(fixture)).rejects.toBe(providerError);

    expect(state.markFailed).toHaveBeenCalledTimes(1);
    expect(state.markNoData).not.toHaveBeenCalled();
  });
});
