import { SportsDomainCollectionService } from './sports-domain-collection.service';

const HOUR = 60 * 60_000;

function createFixture(
  id: string,
  espnEventId: string,
  kickoffAt: Date,
  state: string = 'LIVE',
) {
  return {
    id,
    espnEventId,
    competitionId: 'competition-1',
    seasonId: 'season-1',
    seasonYear: 2026,
    kickoffAt,
    status: { state, isFinal: state === 'COMPLETED' },
    competitors: [
      { teamId: 'home-1', homeAway: 'HOME', score: null },
      { teamId: 'away-1', homeAway: 'AWAY', score: null },
    ],
    periodScores: [],
  } as any;
}

function setup(
  knownFixtures: any[],
  scoreboardItems: any[] = [],
  summaryState: any = null,
) {
  const state = {
    markStarted: jest.fn().mockResolvedValue(undefined),
    markSucceeded: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    getState: jest.fn().mockResolvedValue(summaryState),
  };
  const persistence = {
    getFixturesForCompetitionDate: jest.fn().mockResolvedValue(knownFixtures),
    getMatchSummaryByEventId: jest.fn().mockResolvedValue(null),
    saveFixtures: jest.fn().mockResolvedValue({ previousStates: {} }),
  };
  const provider = {
    collectLiveScoreboard: jest.fn().mockResolvedValue({
      items: scoreboardItems,
      receivedCount: scoreboardItems.length,
      rejected: [],
      endpoint: '/scoreboard?dates=20261121',
      rawResponse: { events: [] },
    }),
  };
  const service = Object.create(
    SportsDomainCollectionService.prototype,
  ) as any;
  service.provider = provider;
  service.persistence = persistence;
  service.state = state;
  service.logger = { warn: jest.fn() };
  return { service, state, persistence, provider };
}

describe('SportsDomainCollectionService date-scoped fixture recovery', () => {
  const now = new Date('2026-11-21T12:00:00.000Z');
  const scope = {
    competitionId: 'competition-1',
    seasonId: 'season-1',
    seasonYear: 2026,
  };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('passes the fixture calendar date to the provider and stores the date-scoped response', async () => {
    const { service, state, persistence, provider } = setup([]);

    const result = await service.collectLiveScoreboard(
      'eng.1',
      scope,
      '2026-11-21',
    );

    expect(provider.collectLiveScoreboard).toHaveBeenCalledWith(
      'eng.1',
      scope,
      '2026-11-21',
    );
    expect(persistence.getFixturesForCompetitionDate).toHaveBeenCalledWith(
      'competition-1',
      '2026-11-21',
    );
    expect(persistence.saveFixtures).toHaveBeenCalledWith([]);
    expect(state.markSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: '/scoreboard?dates=20261121',
      }),
      undefined,
      '/scoreboard?dates=20261121',
    );
    expect(result.items).toEqual([]);
  });

  it('uses a capped Summary fallback for an old fixture omitted from its date scoreboard', async () => {
    const oldFixture = createFixture(
      'fixture-old',
      'event-old',
      new Date(now.getTime() - 6 * HOUR),
      'LIVE',
    );
    const recoveredFixture = {
      ...oldFixture,
      status: { state: 'COMPLETED', isFinal: true },
      competitors: [
        { teamId: 'home-1', homeAway: 'HOME', score: 2 },
        { teamId: 'away-1', homeAway: 'AWAY', score: 1 },
      ],
    };
    const { service, persistence } = setup([oldFixture]);
    service.collectFixtureSummary = jest.fn().mockResolvedValue(recoveredFixture);

    const result = await service.collectLiveScoreboard(
      'eng.1',
      scope,
      '2026-11-21',
    );

    expect(service.collectFixtureSummary).toHaveBeenCalledTimes(1);
    expect(service.collectFixtureSummary).toHaveBeenCalledWith(
      'eng.1',
      'event-old',
      scope,
    );
    expect(persistence.saveFixtures).toHaveBeenCalledTimes(1);
    expect(persistence.saveFixtures).toHaveBeenCalledWith([]);
    expect(result.items).toEqual([recoveredFixture]);
  });

  it('does not repeatedly request Summary when the last attempt returned NO_DATA', async () => {
    const oldFixture = createFixture(
      'fixture-old',
      'event-old',
      new Date(now.getTime() - 8 * HOUR),
      'SCHEDULED',
    );
    const { service, state } = setup(
      [oldFixture],
      [],
      {
        status: 'NO_DATA',
        updatedAt: new Date(now.getTime() - 10 * 60_000),
      },
    );
    service.collectFixtureSummary = jest.fn();

    await service.collectLiveScoreboard('eng.1', scope, '2026-11-21');

    expect(state.getState).toHaveBeenCalledWith(
      'MATCH_SUMMARY_FALLBACK',
      'FIXTURE',
      'fixture:event-old',
    );
    expect(service.collectFixtureSummary).not.toHaveBeenCalled();
  });

  it('limits Summary recovery to two fixtures in one scoreboard pass', async () => {
    const oldFixtures = Array.from({ length: 5 }, (_, index) =>
      createFixture(
        `fixture-${index}`,
        `event-${index}`,
        new Date(now.getTime() - (8 + index) * HOUR),
        'LIVE',
      ),
    );
    const { service } = setup(oldFixtures);
    service.collectFixtureSummary = jest.fn().mockResolvedValue(null);

    await service.collectLiveScoreboard('eng.1', scope, '2026-11-21');

    expect(service.collectFixtureSummary).toHaveBeenCalledTimes(2);
  });

  it('does not fetch Summary for an old completed fixture that already has both scores', async () => {
    const completeFixture = {
      ...createFixture(
        'fixture-complete',
        'event-complete',
        new Date(now.getTime() - 8 * HOUR),
        'COMPLETED',
      ),
      competitors: [
        { teamId: 'home-1', homeAway: 'HOME', score: 2 },
        { teamId: 'away-1', homeAway: 'AWAY', score: 0 },
      ],
    };
    const { service, state } = setup([completeFixture]);
    service.collectFixtureSummary = jest.fn();

    await service.collectLiveScoreboard('eng.1', scope, '2026-11-21');

    expect(service.collectFixtureSummary).not.toHaveBeenCalled();
    expect(state.getState).not.toHaveBeenCalled();
  });

});
