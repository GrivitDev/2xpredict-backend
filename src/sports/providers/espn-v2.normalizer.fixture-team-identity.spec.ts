import { EspnV2Normalizer } from './espn-v2.normalizer';

describe('EspnV2Normalizer fixture competitor team identity', () => {
  const normalizer = new EspnV2Normalizer();

  it('extracts an allowlisted team identity from the ESPN competitor snapshot', () => {
    const competitor = (normalizer as any).normalizeCompetitor({
      id: 'competitor-114',
      homeAway: 'home',
      team: {
        id: '114',
        displayName: 'SSC Napoli',
        name: 'Napoli',
        shortDisplayName: 'Napoli',
        abbreviation: 'NAP',
        logos: [{ href: 'https://example.test/napoli.png' }],
        country: { name: 'Italy' },
        location: 'Naples',
        slug: 'napoli',
        color: '123456',
        alternateColor: 'ffffff',
        providerOnlyField: 'must-not-be-copied',
      },
      privateCompetitorField: 'must-not-be-copied',
    });

    expect(competitor).toMatchObject({
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
    });
    expect(competitor.teamIdentity).not.toHaveProperty('providerOnlyField');
    expect(competitor.teamIdentity).not.toHaveProperty('privateCompetitorField');
    // The source snapshot remains stored privately for controlled recovery workflows.
    expect(competitor.rawPayload).toHaveProperty('privateCompetitorField', 'must-not-be-copied');
  });

  it('also reads compact names and logo fields placed on the competitor rather than team object', () => {
    const competitor = (normalizer as any).normalizeCompetitor({
      id: 'competitor-124',
      homeAway: 'away',
      team: { id: '124' },
      teamName: 'Borussia Dortmund',
      teamShortName: 'Dortmund',
      teamAbbreviation: 'BVB',
      teamLogo: 'https://example.test/dortmund.png',
      teamCountryName: 'Germany',
      teamLocation: 'Dortmund',
    });

    expect(competitor.teamIdentity).toMatchObject({
      id: 'team:124',
      espnId: '124',
      name: 'Borussia Dortmund',
      shortName: 'Dortmund',
      abbreviation: 'BVB',
      logo: 'https://example.test/dortmund.png',
      country: 'Germany',
      location: 'Dortmund',
    });
  });

  it('does not create an empty fallback identity when ESPN only supplies a team ID', () => {
    const competitor = (normalizer as any).normalizeCompetitor({
      id: 'competitor-1',
      homeAway: 'home',
      team: { id: '1' },
    });

    expect(competitor.teamId).toBe('team:1');
    expect(competitor).not.toHaveProperty('teamIdentity');
  });

  it('rebuilds a canonical team record from the compact fixture identity when raw ESPN payload is unavailable', () => {
    const collectedAt = new Date('2026-11-24T18:00:00.000Z');
    const teams = normalizer.normalizeTeamsFromFixtures(
      [
        {
          espnEventId: '401900001',
          source: {
            provider: 'ESPN',
            endpoint: '/scoreboard?dates=20261124',
            collectedAt,
          },
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
          ],
        } as any,
      ],
      'ita.1',
    );

    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({
      id: 'team:114',
      espnId: '114',
      name: 'SSC Napoli',
      displayName: 'SSC Napoli',
      abbreviation: 'NAP',
      logo: 'https://example.test/napoli.png',
      country: 'Italy',
      location: 'Naples',
      slug: 'napoli',
      primaryColor: '123456',
      alternateColor: 'ffffff',
      leagueIds: ['ita.1'],
    });
  });

});

