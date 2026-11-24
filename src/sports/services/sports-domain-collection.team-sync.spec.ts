import { SportsDomainCollectionService } from './sports-domain-collection.service';

describe('SportsDomainCollectionService scoreboard team synchronization', () => {
  it('rebuilds canonical team snapshots from the newly collected fixture batch and persists them', async () => {
    const fixtures = [
      {
        id: 'fixture:401874850',
        espnEventId: '401874850',
        competitors: [
          { teamId: 'team:114', homeAway: 'HOME', rawPayload: { team: { id: '114', displayName: 'Napoli' } } },
          { teamId: 'team:105', homeAway: 'AWAY', rawPayload: { team: { id: '105', displayName: 'Atalanta' } } },
        ],
      },
    ] as any;
    const snapshots = [
      { id: 'team:114', espnId: '114', name: 'Napoli' },
      { id: 'team:105', espnId: '105', name: 'Atalanta' },
    ];
    const provider = {
      normalizeTeamsFromFixtures: jest.fn().mockReturnValue(snapshots),
    };
    const persistence = {
      saveTeams: jest.fn().mockResolvedValue(2),
    };
    const service = new SportsDomainCollectionService(
      provider as any,
      persistence as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      (service as any).syncTeamsFromFixtureSnapshots(' ENG.1 ', fixtures),
    ).resolves.toBe(2);

    expect(provider.normalizeTeamsFromFixtures).toHaveBeenCalledWith(
      fixtures,
      'eng.1',
    );
    expect(persistence.saveTeams).toHaveBeenCalledWith(snapshots);
  });

  it('does not query or write team data when the scoreboard batch is empty', async () => {
    const provider = {
      normalizeTeamsFromFixtures: jest.fn(),
    };
    const persistence = {
      saveTeams: jest.fn(),
    };
    const service = new SportsDomainCollectionService(
      provider as any,
      persistence as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      (service as any).syncTeamsFromFixtureSnapshots('eng.1', []),
    ).resolves.toBe(0);

    expect(provider.normalizeTeamsFromFixtures).not.toHaveBeenCalled();
    expect(persistence.saveTeams).not.toHaveBeenCalled();
  });


  it('delegates every persisted fixture batch to the dedicated integrity service when registered', async () => {
    const fixtures = [
      {
        id: 'fixture:401900001',
        espnEventId: '401900001',
        competitors: [
          { teamId: 'team:114', homeAway: 'HOME' },
          { teamId: 'team:124', homeAway: 'AWAY' },
        ],
      },
    ] as any;
    const teamIntegrity = {
      ensureFixtureTeams: jest.fn().mockResolvedValue({
        fixturesChecked: 1,
        uniqueTeamsChecked: 2,
        teamRecordsWritten: 2,
      }),
    };
    const service = new SportsDomainCollectionService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      teamIntegrity as any,
    );

    await (service as any).ensureFixtureTeamIntegrity('ita.1', fixtures);

    expect(teamIntegrity.ensureFixtureTeams).toHaveBeenCalledWith(
      'ita.1',
      fixtures,
    );
  });

});


describe('SportsDomainCollectionService fixture integrity integration', () => {
  const scope = {
    competitionId: 'competition:ita.1',
    seasonId: 'season:ita.1:2026',
    seasonYear: 2026,
  };
  const fixture = {
    id: 'fixture:401900001',
    espnEventId: '401900001',
    competitionId: scope.competitionId,
    seasonId: scope.seasonId,
    seasonYear: 2026,
    kickoffAt: new Date('2026-11-24T18:00:00.000Z'),
    status: { state: 'SCHEDULED', isFinal: false },
    competitors: [
      { teamId: 'team:114', homeAway: 'HOME' },
      { teamId: 'team:124', homeAway: 'AWAY' },
    ],
    source: {
      provider: 'ESPN' as const,
      endpoint: '/scoreboard',
      collectedAt: new Date('2026-11-24T17:00:00.000Z'),
    },
  } as any;

  function createService(overrides: Record<string, unknown> = {}) {
    const provider = {
      collectDailyFixtures: jest.fn().mockResolvedValue({
        items: [fixture], rejected: [], endpoint: '/scoreboard?dates=20261124', receivedCount: 1,
      }),
      collectMonthlyFixtures: jest.fn().mockResolvedValue({
        items: [fixture], rejected: [], endpoint: '/scoreboard?dates=202611', receivedCount: 1,
      }),
      collectLiveScoreboard: jest.fn().mockResolvedValue({
        items: [fixture], rejected: [], endpoint: '/scoreboard', receivedCount: 1,
      }),
      collectFixtureSummary: jest.fn().mockResolvedValue({
        fixture, rawResponse: { header: { id: '401900001' } }, endpoint: '/summary',
      }),
    };
    const persistence = {
      saveFixtures: jest.fn().mockResolvedValue({ persistedCount: 1, previousStates: {} }),
      getFixturesForCompetitionDate: jest.fn().mockResolvedValue([]),
      getFixtureById: jest.fn().mockResolvedValue(null),
      saveMatchSummary: jest.fn().mockResolvedValue({ payloadHash: 'hash-1', revision: 1 }),
    };
    const state = {
      markStarted: jest.fn().mockResolvedValue(undefined),
      markSucceeded: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      markNoData: jest.fn().mockResolvedValue(undefined),
    };
    const teamIntegrity = jest.fn().mockResolvedValue(undefined);
    const service = Object.create(SportsDomainCollectionService.prototype) as any;
    Object.assign(service, {
      provider,
      persistence,
      state,
      teamIntegrity: { ensureFixtureTeams: teamIntegrity },
      matchFactsNormalization: { normalizeAndPersist: jest.fn().mockResolvedValue(undefined) },
      normalizeAndPersistOfficialStandings: jest.fn().mockResolvedValue(undefined),
      logger: { debug: jest.fn(), warn: jest.fn(), log: jest.fn() },
      ...overrides,
    });
    service.ensureFixtureTeamIntegrity = teamIntegrity;
    return { service, provider, persistence, state, teamIntegrity };
  }

  function expectIntegrityBeforeSuccess(h: ReturnType<typeof createService>) {
    expect(h.persistence.saveFixtures.mock.invocationCallOrder[0]).toBeLessThan(
      h.teamIntegrity.mock.invocationCallOrder[0],
    );
    expect(h.teamIntegrity.mock.invocationCallOrder[0]).toBeLessThan(
      h.state.markSucceeded.mock.invocationCallOrder[0],
    );
  }

  it('runs the integrity service after daily fixture persistence and before collection success', async () => {
    const h = createService();
    await h.service.collectDailyFixtures('ita.1', '2026-11-24', scope);

    expect(h.teamIntegrity).toHaveBeenCalledWith('ita.1', [fixture]);
    expectIntegrityBeforeSuccess(h);
  });

  it('runs the integrity service after monthly fixture persistence and before collection success', async () => {
    const h = createService();
    await h.service.collectMonthlyFixtures('ita.1', '2026-11', scope);

    expect(h.teamIntegrity).toHaveBeenCalledWith('ita.1', [fixture]);
    expectIntegrityBeforeSuccess(h);
  });

  it('runs the integrity service for live scoreboard fixtures before collection success', async () => {
    const h = createService();
    await h.service.collectLiveScoreboard('ita.1', scope);

    expect(h.teamIntegrity).toHaveBeenCalledWith('ita.1', [fixture]);
    expectIntegrityBeforeSuccess(h);
  });

  it('runs the integrity service for a fixture recovered from Summary after persistence', async () => {
    const h = createService();
    await h.service.collectFixtureSummary('ita.1', '401900001', scope);

    expect(h.persistence.saveFixtures).toHaveBeenCalledWith([fixture]);
    expect(h.teamIntegrity).toHaveBeenCalledWith('ita.1', [fixture]);
    expect(h.persistence.saveFixtures.mock.invocationCallOrder[0]).toBeLessThan(
      h.teamIntegrity.mock.invocationCallOrder[0],
    );
    expect(h.teamIntegrity.mock.invocationCallOrder[0]).toBeLessThan(
      h.state.markSucceeded.mock.invocationCallOrder[0],
    );
  });

  it('does not mark a daily scoreboard successful when team integrity cannot complete', async () => {
    const h = createService();
    const error = new Error('Team integrity persistence failed');
    h.teamIntegrity.mockRejectedValue(error);

    await expect(
      h.service.collectDailyFixtures('ita.1', '2026-11-24', scope),
    ).rejects.toBe(error);

    expect(h.state.markSucceeded).not.toHaveBeenCalled();
    expect(h.state.markFailed).toHaveBeenCalledTimes(1);
  });
});
