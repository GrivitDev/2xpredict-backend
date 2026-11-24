import { EspnV2Normalizer } from './espn-v2.normalizer';

describe('EspnV2Normalizer team identity recovery', () => {
  const normalizer = new EspnV2Normalizer();

  it('normalizes nested team detail fields, country strings and available logo variants', () => {
    const normalized = normalizer.normalizeTeam(
      {
        team: {
          id: '21540',
          displayName: 'Manchester City',
          shortDisplayName: 'Man City',
          abbreviation: 'MCI',
          logos: [
            {
              href: 'https://example.test/man-city.png',
              rel: ['full', 'default'],
            },
          ],
          country: 'England',
          location: 'Manchester',
        },
      },
      'ENG.1',
      new Date('2026-11-24T10:00:00.000Z'),
    );

    expect(normalized).toMatchObject({
      id: 'team:21540',
      espnId: '21540',
      leagueIds: ['eng.1'],
      name: 'Manchester City',
      displayName: 'Manchester City',
      shortName: 'Man City',
      abbreviation: 'MCI',
      logo: 'https://example.test/man-city.png',
      country: 'England',
      location: 'Manchester',
    });
  });

  it('recovers canonical team records from retained fixture competitor snapshots', () => {
    const collectedAt = new Date('2026-11-24T10:00:00.000Z');
    const teams = normalizer.normalizeTeamsFromFixtures(
      [
        {
          espnEventId: '401900001',
          source: {
            provider: 'ESPN',
            endpoint: '/scoreboard?dates=20261124',
            collectedAt,
            providerId: '401900001',
          },
          competitors: [
            {
              teamId: 'team:21540',
              espnCompetitorId: '21540',
              homeAway: 'HOME',
              rawPayload: {
                id: '21540:home',
                homeAway: 'home',
                team: {
                  id: '21540',
                  displayName: 'Manchester City',
                  shortDisplayName: 'Man City',
                  abbreviation: 'MCI',
                  logos: [
                    { href: 'https://example.test/man-city.png', rel: ['default'] },
                  ],
                  country: { name: 'England' },
                  location: 'Manchester',
                },
              },
            },
            {
              teamId: 'team:359',
              espnCompetitorId: '359',
              homeAway: 'AWAY',
              rawPayload: {
                homeAway: 'away',
                teamId: 'team:359',
                teamName: 'Arsenal',
                teamShortName: 'Arsenal',
                teamLogo: 'https://example.test/arsenal.png',
                teamCountry: 'England',
              },
            },
          ],
        },
      ],
      'eng.1',
    );

    expect(teams).toHaveLength(2);
    expect(teams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'team:21540',
          name: 'Manchester City',
          logo: 'https://example.test/man-city.png',
          country: 'England',
        }),
        expect.objectContaining({
          id: 'team:359',
          espnId: '359',
          name: 'Arsenal',
          logo: 'https://example.test/arsenal.png',
          country: 'England',
        }),
      ]),
    );
  });

  it('combines inline competitor identity fields with a nested team reference', () => {
    const teams = normalizer.normalizeTeamsFromFixtures(
      [
        {
          espnEventId: '401900004',
          source: {
            provider: 'ESPN',
            endpoint: '/scoreboard',
            collectedAt: new Date(),
          },
          competitors: [
            {
              teamId: 'team:40',
              homeAway: 'HOME',
              rawPayload: {
                team: { $ref: 'https://sports.core.api.espn.com/v2/teams/40' },
                teamDisplayName: 'Real Madrid',
                teamShortName: 'Real Madrid',
                teamLogo: 'https://example.test/real-madrid.png',
                teamCountry: 'Spain',
              },
            },
            {
              teamId: 'team:41',
              homeAway: 'AWAY',
              rawPayload: { team: { id: '41' } },
            },
          ],
        },
      ],
      'esp.1',
      new Date(),
      ['40'],
    );

    expect(teams).toEqual([
      expect.objectContaining({
        id: 'team:40',
        name: 'Real Madrid',
        logo: 'https://example.test/real-madrid.png',
        country: 'Spain',
      }),
    ]);
  });

  it('limits fixture recovery to the requested canonical team IDs', () => {
    const teams = normalizer.normalizeTeamsFromFixtures(
      [
        {
          espnEventId: '401900002',
          source: {
            provider: 'ESPN',
            endpoint: '/scoreboard',
            collectedAt: new Date(),
          },
          competitors: [
            {
              teamId: 'team:10',
              homeAway: 'HOME',
              rawPayload: {
                team: { id: '10', displayName: 'Team Ten', logo: 'ten.png' },
              },
            },
            {
              teamId: 'team:20',
              homeAway: 'AWAY',
              rawPayload: {
                team: { id: '20', displayName: 'Team Twenty', logo: 'twenty.png' },
              },
            },
          ],
        },
      ],
      'eng.1',
      new Date(),
      ['team:20'],
    );

    expect(teams.map((team) => team.id)).toEqual(['team:20']);
  });

  it('does not invent a team record from a fixture competitor with no usable name', () => {
    const teams = normalizer.normalizeTeamsFromFixtures(
      [
        {
          espnEventId: '401900003',
          source: {
            provider: 'ESPN',
            endpoint: '/scoreboard',
            collectedAt: new Date(),
          },
          competitors: [
            {
              teamId: 'team:30',
              homeAway: 'HOME',
              rawPayload: {
                team: { $ref: 'https://sports.core.api.espn.com/v2/teams/30' },
              },
            },
            {
              teamId: 'team:31',
              homeAway: 'AWAY',
              rawPayload: {
                team: { $ref: 'https://sports.core.api.espn.com/v2/teams/31' },
              },
            },
          ],
        },
      ],
      'eng.1',
    );

    expect(teams).toEqual([]);
  });
});
