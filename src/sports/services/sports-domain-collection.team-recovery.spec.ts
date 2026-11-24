import { SportsDomainCollectionService } from './sports-domain-collection.service';

describe('SportsDomainCollectionService team identity recovery', () => {
  it('fills missing fields without replacing richer team-detail data', async () => {
    const collectedAt = new Date('2026-11-24T09:00:00.000Z');
    const fixtureCollectedAt = new Date('2026-10-30T09:00:00.000Z');
    const existingSource = {
      provider: 'ESPN' as const,
      endpoint: '/leagues/eng.1/teams/21540',
      providerId: '21540',
      collectedAt,
    };
    const existingTeam = {
      id: 'team:21540',
      espnId: '21540',
      leagueIds: ['eng.1'],
      name: 'Current Manchester City',
      displayName: 'Current Manchester City',
      logo: 'https://example.test/current-logo.png',
      rawPayload: { displayName: 'Current Manchester City' },
      source: existingSource,
      createdAt: new Date('2025-08-01T00:00:00.000Z'),
      updatedAt: collectedAt,
    };
    const recoveredSnapshot = {
      id: 'team:21540',
      espnId: '21540',
      leagueIds: ['eng.1'],
      name: 'Older Manchester City',
      displayName: 'Older Manchester City',
      shortName: 'Man City',
      logo: 'https://example.test/older-logo.png',
      country: 'England',
      rawPayload: { displayName: 'Older Manchester City', country: 'England' },
      source: {
        provider: 'ESPN' as const,
        endpoint: '/scoreboard#team:21540',
        providerId: '21540',
        collectedAt: fixtureCollectedAt,
      },
      createdAt: fixtureCollectedAt,
      updatedAt: fixtureCollectedAt,
    };
    const provider = {
      normalizeTeamsFromFixtures: jest.fn().mockReturnValue([recoveredSnapshot]),
    };
    const persistence = {
      getCurrentSeasonFixtureTeamIdentitySources: jest.fn().mockResolvedValue([
        { espnEventId: '401900001' },
      ]),
      saveTeams: jest.fn().mockResolvedValue(1),
    };
    const service = new SportsDomainCollectionService(
      provider as any,
      persistence as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.recoverTeamSnapshotsFromFixtures(
        'eng.1',
        'competition:eng.1',
        'season:eng.1:2026',
        ['21540'],
        [existingTeam] as any,
      ),
    ).resolves.toBe(1);

    expect(
      persistence.getCurrentSeasonFixtureTeamIdentitySources,
    ).toHaveBeenCalledWith('competition:eng.1', 'season:eng.1:2026', ['21540']);
    expect(provider.normalizeTeamsFromFixtures).toHaveBeenCalledWith(
      [{ espnEventId: '401900001' }],
      'eng.1',
      ['21540'],
    );
    expect(persistence.saveTeams).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'team:21540',
        name: 'Current Manchester City',
        displayName: 'Current Manchester City',
        logo: 'https://example.test/current-logo.png',
        country: 'England',
        source: existingSource,
        rawPayload: {
          displayName: 'Current Manchester City',
          country: 'England',
        },
      }),
    ]);
  });

  it('does not persist a fixture snapshot when it cannot fill an incomplete identity field', async () => {
    const snapshot = {
      id: 'team:359',
      espnId: '359',
      leagueIds: ['eng.1'],
      name: 'Arsenal',
      source: {
        provider: 'ESPN' as const,
        endpoint: '/scoreboard#team:359',
        providerId: '359',
        collectedAt: new Date('2026-10-30T09:00:00.000Z'),
      },
      createdAt: new Date('2026-10-30T09:00:00.000Z'),
      updatedAt: new Date('2026-10-30T09:00:00.000Z'),
    };
    const provider = {
      normalizeTeamsFromFixtures: jest.fn().mockReturnValue([snapshot]),
    };
    const persistence = {
      getCurrentSeasonFixtureTeamIdentitySources: jest.fn().mockResolvedValue([
        { espnEventId: '401900002' },
      ]),
      saveTeams: jest.fn(),
    };
    const service = new SportsDomainCollectionService(
      provider as any,
      persistence as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const existingTeam = {
      id: 'team:359',
      espnId: '359',
      leagueIds: ['eng.1'],
      name: 'Arsenal',
      logo: undefined,
      country: undefined,
      source: {
        provider: 'ESPN',
        endpoint: '/leagues/eng.1/teams/359',
        providerId: '359',
        collectedAt: new Date('2026-11-20T09:00:00.000Z'),
      },
      createdAt: new Date('2025-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-11-20T09:00:00.000Z'),
    };

    await expect(
      service.recoverTeamSnapshotsFromFixtures(
        'eng.1',
        'competition:eng.1',
        'season:eng.1:2026',
        ['359'],
        [existingTeam] as any,
      ),
    ).resolves.toBe(0);
    expect(persistence.saveTeams).not.toHaveBeenCalled();
  });
});
