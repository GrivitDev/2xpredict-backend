import { SportsDomainReadService } from './sports-domain-read.service';

const now = new Date('2026-11-24T20:00:00.000Z');

function createQuery<T>(value: T) {
  return {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value),
  };
}

const fixture = {
  id: 'fixture:401900001',
  espnEventId: '401900001',
  competitionId: 'competition:ita.1',
  kickoffAt: new Date('2026-11-24T18:00:00.000Z'),
  competitors: [
    {
      teamId: 'team:114',
      homeAway: 'HOME',
      teamIdentity: {
        id: 'team:114',
        espnId: '114',
        name: 'Napoli',
        displayName: 'SSC Napoli',
        shortName: 'Napoli',
        abbreviation: 'NAP',
        logo: 'https://example.test/napoli.png',
        country: 'Italy',
        location: 'Naples',
        slug: 'napoli',
        primaryColor: '123456',
        alternateColor: 'ffffff',
      },
    },
    {
      teamId: 'team:124',
      homeAway: 'AWAY',
      teamIdentity: {
        id: 'team:124',
        espnId: '124',
        name: 'Borussia Dortmund',
        logo: 'https://example.test/dortmund.png',
      },
    },
  ],
};

describe('SportsDomainReadService fixture team identity projection', () => {
  it('returns persisted compact team identities and excludes raw competitor payloads', async () => {
    const query = createQuery(fixture);
    const service = Object.create(SportsDomainReadService.prototype) as any;
    service.fixtureModel = { findOne: jest.fn().mockReturnValue(query) };

    const result = await service.getFixture('401900001');

    expect(query.select).toHaveBeenCalledWith('-_id -rawPayload -competitors.rawPayload');
    expect(result?.competitors[0]).toMatchObject({
      teamId: 'team:114',
      teamIdentity: {
        id: 'team:114',
        espnId: '114',
        name: 'Napoli',
        displayName: 'SSC Napoli',
        shortName: 'Napoli',
        abbreviation: 'NAP',
        logo: 'https://example.test/napoli.png',
        country: 'Italy',
        location: 'Naples',
      },
    });
    expect(result?.competitors[1].teamIdentity).toMatchObject({
      id: 'team:124',
      espnId: '124',
      name: 'Borussia Dortmund',
      logo: 'https://example.test/dortmund.png',
    });
    expect(JSON.stringify(result)).not.toContain('rawPayload');
  });

  it('returns the same compact identity contract from batch and paginated fixture reads', async () => {
    const batchQuery = createQuery([fixture]);
    const listQuery = createQuery([fixture]);
    const service = Object.create(SportsDomainReadService.prototype) as any;
    service.fixtureModel = {
      find: jest.fn()
        .mockReturnValueOnce(batchQuery)
        .mockReturnValueOnce(listQuery),
    };

    const batch = await service.getFixturesByIdentifiers(['401900001']);
    const page = await service.getFixtures({ limit: 10 });

    expect(batch[0].competitors[0].teamIdentity.name).toBe('Napoli');
    expect(page.items[0].competitors[1].teamIdentity.name).toBe('Borussia Dortmund');
    expect(batchQuery.select).toHaveBeenCalledWith('-_id -rawPayload -competitors.rawPayload');
    expect(listQuery.select).toHaveBeenCalledWith('-_id -rawPayload -competitors.rawPayload');
  });

  it('keeps fixtures usable when no compact team snapshot is available', async () => {
    const noIdentityFixture = {
      ...fixture,
      competitors: [
        { teamId: 'team:1', homeAway: 'HOME' },
        { teamId: 'team:2', homeAway: 'AWAY' },
      ],
    };
    const query = createQuery(noIdentityFixture);
    const service = Object.create(SportsDomainReadService.prototype) as any;
    service.fixtureModel = { findOne: jest.fn().mockReturnValue(query) };

    const result = await service.getFixture('401900001');

    expect(result?.competitors[0]).toMatchObject({ teamId: 'team:1', homeAway: 'HOME' });
    expect(result?.competitors[0]).not.toHaveProperty('rawPayload');
  });

  it('returns fixture team snapshots as home/away team fallbacks when central records are missing', async () => {
    const emptyQuery = () => createQuery([]);
    const service = Object.create(SportsDomainReadService.prototype) as any;
    service.competitionModel = { find: jest.fn().mockReturnValue(emptyQuery()) };
    service.seasonModel = { find: jest.fn().mockReturnValue(emptyQuery()) };
    service.teamModel = { find: jest.fn().mockReturnValue(emptyQuery()) };

    const contexts = await service['buildFixtureContexts']([fixture]);

    expect(contexts[0].homeTeam).toMatchObject({
      id: 'team:114',
      espnId: '114',
      name: 'Napoli',
      displayName: 'SSC Napoli',
      abbreviation: 'NAP',
      logo: 'https://example.test/napoli.png',
      country: 'Italy',
      identitySource: 'FIXTURE_SNAPSHOT',
    });
    expect(contexts[0].awayTeam).toMatchObject({
      id: 'team:124',
      name: 'Borussia Dortmund',
      logo: 'https://example.test/dortmund.png',
      identitySource: 'FIXTURE_SNAPSHOT',
    });
  });

  it('fills missing canonical team fields from the fixture snapshot without replacing stored values', async () => {
    const emptyQuery = () => createQuery([]);
    const storedHomeTeam = {
      id: 'team:114',
      espnId: '114',
      leagueIds: ['ita.1'],
      name: 'Napoli FC',
      logo: '',
      country: undefined,
      source: {
        provider: 'ESPN',
        endpoint: '/team-details',
        providerId: '114',
        collectedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    };
    const service = Object.create(SportsDomainReadService.prototype) as any;
    service.competitionModel = { find: jest.fn().mockReturnValue(emptyQuery()) };
    service.seasonModel = { find: jest.fn().mockReturnValue(emptyQuery()) };
    service.teamModel = {
      find: jest.fn().mockReturnValue(createQuery([storedHomeTeam])),
    };

    const contexts = await service['buildFixtureContexts']([{
      ...fixture,
      competitors: fixture.competitors,
      source: {
        provider: 'ESPN',
        endpoint: '/scoreboard',
        collectedAt: now,
      },
    }]);

    expect(contexts[0].homeTeam).toMatchObject({
      id: 'team:114',
      name: 'Napoli FC',
      logo: 'https://example.test/napoli.png',
      country: 'Italy',
      identitySource: 'TEAM_CATALOGUE_WITH_FIXTURE_FALLBACK',
    });
  });


  it('rejects a mismatched central identity and replaces an invalid stored logo with the fixture logo', async () => {
    const emptyQuery = () => createQuery([]);
    const corruptStoredTeam = {
      id: 'team:114',
      espnId: '999',
      leagueIds: ['ita.1'],
      name: 'Wrong Club Name',
      logo: 'not-a-valid-url',
      country: 'Wrong Country',
      source: {
        provider: 'ESPN',
        endpoint: '/team-details',
        providerId: '999',
        collectedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    };
    const service = Object.create(SportsDomainReadService.prototype) as any;
    service.competitionModel = {
      find: jest.fn().mockReturnValue(createQuery([{ id: 'competition:ita.1', slug: 'ita.1' }])),
    };
    service.seasonModel = { find: jest.fn().mockReturnValue(emptyQuery()) };
    service.teamModel = {
      find: jest.fn().mockReturnValue(createQuery([corruptStoredTeam])),
    };

    const contexts = await service['buildFixtureContexts']([fixture]);

    expect(contexts[0].homeTeam).toMatchObject({
      id: 'team:114',
      espnId: '114',
      name: 'Napoli',
      logo: 'https://example.test/napoli.png',
      country: 'Italy',
      identitySource: 'FIXTURE_SNAPSHOT',
    });
    expect(contexts[0].homeTeam).not.toHaveProperty('name', 'Wrong Club Name');
    expect(contexts[0].homeTeam?.missingFields).not.toContain('logo');
  });

});

