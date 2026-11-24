import { SportsFixtureTeamIntegrityService } from './sports-fixture-team-integrity.service';
import { SportsQueueJobType } from '../interfaces/sports-queue.interface';

const now = new Date('2026-11-24T20:00:00.000Z');

const fixture = (teamIds = ['team:114', 'team:124']) =>
  ({
    id: 'fixture:401900001',
    espnEventId: '401900001',
    source: {
      provider: 'ESPN',
      endpoint: '/leagues/ita.1/scoreboard',
      collectedAt: now,
    },
    competitors: [
      { teamId: teamIds[0], homeAway: 'HOME' },
      { teamId: teamIds[1], homeAway: 'AWAY' },
    ],
  }) as any;

const team = (id: string, changes: Record<string, unknown> = {}) =>
  ({
    id,
    espnId: id.replace(/^team:/, ''),
    leagueIds: ['ita.1'],
    name: id === 'team:114' ? 'Napoli' : 'Borussia Dortmund',
    displayName: id === 'team:114' ? 'SSC Napoli' : 'Borussia Dortmund',
    shortName: id === 'team:114' ? 'Napoli' : 'Dortmund',
    abbreviation: id === 'team:114' ? 'NAP' : 'BVB',
    slug: id === 'team:114' ? 'napoli' : 'borussia-dortmund',
    logo: `https://example.test/${id}.png`,
    country: id === 'team:114' ? 'Italy' : 'Germany',
    location: id === 'team:114' ? 'Naples' : 'Dortmund',
    primaryColor: '123456',
    alternateColor: 'ffffff',
    source: {
      provider: 'ESPN',
      endpoint: '/team-details',
      providerId: id.replace(/^team:/, ''),
      collectedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    ...changes,
  }) as any;

const createHarness = (storedRows: any[] = []) => {
  const provider = {
    normalizeTeamsFromFixtures: jest.fn().mockReturnValue([
      team('team:114'),
      team('team:124'),
    ]),
  };
  const persistence = {
    saveTeams: jest.fn().mockResolvedValue(2),
    ensureTeamLeagueMembership: jest.fn().mockResolvedValue(0),
    getTeamsByIdentifiers: jest.fn().mockResolvedValue(storedRows),
  };
  const queue = {
    getRecentTeamDetailJobTeamIds: jest.fn().mockResolvedValue(new Set()),
    enqueueIfMissing: jest.fn().mockResolvedValue({ created: true }),
  };
  const service = new SportsFixtureTeamIntegrityService(
    provider as any,
    persistence as any,
    queue as any,
  );
  return { service, provider, persistence, queue };
};

describe('SportsFixtureTeamIntegrityService', () => {
  it('creates missing team records, then verifies both canonical records were stored', async () => {
    const h = createHarness();
    h.persistence.getTeamsByIdentifiers
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([team('team:114'), team('team:124')]);

    const result = await h.service.ensureFixtureTeams('ITA.1', [
      fixture(),
      { ...fixture(), id: 'fixture:401900002', espnEventId: '401900002' },
    ]);

    expect(h.provider.normalizeTeamsFromFixtures).toHaveBeenCalledWith(
      expect.any(Array),
      'ita.1',
    );
    expect(h.persistence.saveTeams).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'team:114' }),
      expect.objectContaining({ id: 'team:124' }),
    ]);
    expect(h.persistence.getTeamsByIdentifiers).toHaveBeenNthCalledWith(1, [
      'team:114',
      'team:124',
    ]);
    expect(h.persistence.getTeamsByIdentifiers).toHaveBeenNthCalledWith(2, [
      'team:114',
      'team:124',
    ]);
    expect(result).toMatchObject({
      fixturesChecked: 2,
      uniqueTeamsChecked: 2,
      teamSnapshotsExtracted: 2,
      teamRecordsWritten: 2,
      teamLeagueMembershipsAdded: 0,
      missingTeamRecordIds: [],
      identityMismatchTeamIds: [],
      incompleteTeamFields: {},
      detailRefreshJobsQueued: [],
    });
    expect(h.queue.enqueueIfMissing).not.toHaveBeenCalled();
  });

  it('uses a read-only fast path when both records are already complete and current', async () => {
    const h = createHarness([team('team:114'), team('team:124')]);

    const result = await h.service.ensureFixtureTeams('ita.1', [fixture()]);

    expect(result.missingTeamRecordIds).toEqual([]);
    expect(result.incompleteTeamFields).toEqual({});
    expect(h.persistence.getTeamsByIdentifiers).toHaveBeenCalledTimes(1);
    expect(h.persistence.saveTeams).not.toHaveBeenCalled();
    expect(h.persistence.ensureTeamLeagueMembership).not.toHaveBeenCalled();
    expect(h.queue.enqueueIfMissing).not.toHaveBeenCalled();
  });

  it('reports missing metadata and queues a detail refresh when the fixture snapshot cannot supply it', async () => {
    const incomplete = team('team:114', {
      logo: undefined,
      country: undefined,
      location: undefined,
      primaryColor: undefined,
      alternateColor: undefined,
    });
    const h = createHarness([incomplete, team('team:124')]);
    h.provider.normalizeTeamsFromFixtures.mockReturnValue([
      team('team:114', {
        logo: undefined,
        country: undefined,
        location: undefined,
        primaryColor: undefined,
        alternateColor: undefined,
      }),
      team('team:124'),
    ]);

    const result = await h.service.ensureFixtureTeams('ita.1', [fixture()]);

    expect(result.incompleteTeamFields['team:114']).toEqual(
      expect.arrayContaining([
        'logo',
        'country',
        'location',
        'primaryColor',
        'alternateColor',
      ]),
    );
    expect(h.queue.enqueueIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SportsQueueJobType.TEAM_DETAIL_REFRESH,
        scope: expect.objectContaining({
          leagueId: 'ita.1',
          teamId: '114',
          sourceFingerprint: expect.stringContaining(
            'fixture-team-integrity:ita.1:114:',
          ),
        }),
        recurrence: {
          intervalMs: expect.any(Number),
          repeatUntil: 'NEVER',
        },
      }),
    );
    expect(result.detailRefreshJobsQueued).toContain('114');
    expect(h.persistence.saveTeams).not.toHaveBeenCalled();
  });

  it('does not create another ESPN detail job during the existing cooldown', async () => {
    const h = createHarness([
      team('team:114', { name: '', logo: '' }),
      team('team:124'),
    ]);
    h.provider.normalizeTeamsFromFixtures.mockReturnValue([
      team('team:114', { name: '', logo: '' }),
      team('team:124'),
    ]);
    h.queue.getRecentTeamDetailJobTeamIds.mockResolvedValue(
      new Set(['114']),
    );

    const result = await h.service.ensureFixtureTeams('ita.1', [fixture()]);

    expect(h.queue.enqueueIfMissing).not.toHaveBeenCalled();
    expect(result.detailRefreshJobsSkippedByCooldown).toEqual(['114']);
  });

  it('rejects normalized snapshots whose IDs do not belong to the fixture', async () => {
    const h = createHarness();
    h.provider.normalizeTeamsFromFixtures.mockReturnValue([
      team('team:999'),
    ]);

    const result = await h.service.ensureFixtureTeams('ita.1', [fixture()]);

    expect(h.persistence.saveTeams).not.toHaveBeenCalled();
    expect(result.teamSnapshotsExtracted).toBe(0);
    expect(result.missingTeamRecordIds).toEqual(['team:114', 'team:124']);
    expect(result.detailRefreshJobsQueued).toEqual(['114', '124']);
  });

  it('does not query or persist anything when league or fixture inputs are empty', async () => {
    const h = createHarness();

    await expect(h.service.ensureFixtureTeams('', [fixture()])).resolves.toMatchObject({
      fixturesChecked: 1,
      uniqueTeamsChecked: 2,
    });
    await expect(h.service.ensureFixtureTeams('ita.1', [])).resolves.toMatchObject({
      fixturesChecked: 0,
      uniqueTeamsChecked: 0,
    });

    expect(h.provider.normalizeTeamsFromFixtures).not.toHaveBeenCalled();
    expect(h.persistence.saveTeams).not.toHaveBeenCalled();
    expect(h.persistence.getTeamsByIdentifiers).not.toHaveBeenCalled();
  });

  it('repairs a stale espnId on a correctly keyed canonical team record', async () => {
    const stale = team('team:114', { espnId: '999' });
    const h = createHarness([stale, team('team:124')]);
    h.persistence.getTeamsByIdentifiers
      .mockResolvedValueOnce([stale, team('team:124')])
      .mockResolvedValueOnce([team('team:114'), team('team:124')]);

    const result = await h.service.ensureFixtureTeams('ita.1', [fixture()]);

    expect(h.persistence.saveTeams).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'team:114', espnId: '114' })]),
    );
    expect(result.identityMismatchTeamIds).toEqual([]);
    expect(result.missingTeamRecordIds).toEqual([]);
  });

  it('detects an ESPN ID owned by a different canonical document and avoids a duplicate-key write', async () => {
    const h = createHarness([
      team('team:999', { espnId: '114' }),
      team('team:124'),
    ]);

    const result = await h.service.ensureFixtureTeams('ita.1', [fixture()]);

    expect(result.identityMismatchTeamIds).toContain('team:114');
    expect(result.missingTeamRecordIds).toContain('team:114');
    expect(h.persistence.saveTeams).not.toHaveBeenCalled();
    expect(h.queue.enqueueIfMissing).not.toHaveBeenCalled();
  });

  it('repairs missing league membership locally without scheduling an ESPN request', async () => {
    const h = createHarness([
      team('team:114', { leagueIds: [] }),
      team('team:124', { leagueIds: [] }),
    ]);
    h.provider.normalizeTeamsFromFixtures.mockReturnValue([]);
    h.persistence.ensureTeamLeagueMembership.mockResolvedValue(2);
    h.persistence.getTeamsByIdentifiers
      .mockResolvedValueOnce([
        team('team:114', { leagueIds: [] }),
        team('team:124', { leagueIds: [] }),
      ])
      .mockResolvedValueOnce([team('team:114'), team('team:124')]);

    const result = await h.service.ensureFixtureTeams('ita.1', [fixture()]);

    expect(h.persistence.ensureTeamLeagueMembership).toHaveBeenCalledWith(
      ['team:114', 'team:124'],
      'ita.1',
    );
    expect(result.teamLeagueMembershipsAdded).toBe(2);
    expect(h.queue.enqueueIfMissing).not.toHaveBeenCalled();
  });

  it('replaces an invalid stored logo from a valid fixture snapshot without waiting for a provider request', async () => {
    const invalidStored = team('team:114', { logo: 'not-a-valid-url' });
    const validSnapshot = team('team:114', {
      logo: 'https://example.test/recovered-napoli.png',
    });
    const h = createHarness([invalidStored, team('team:124')]);
    h.provider.normalizeTeamsFromFixtures.mockReturnValue([
      validSnapshot,
      team('team:124'),
    ]);
    h.persistence.getTeamsByIdentifiers
      .mockResolvedValueOnce([invalidStored, team('team:124')])
      .mockResolvedValueOnce([
        team('team:114', { logo: 'https://example.test/recovered-napoli.png' }),
        team('team:124'),
      ]);

    const result = await h.service.ensureFixtureTeams('ita.1', [fixture()]);

    expect(h.persistence.saveTeams).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'team:114',
        logo: 'https://example.test/recovered-napoli.png',
      }),
    ]);
    expect(result.incompleteTeamFields['team:114']).toBeUndefined();
    expect(result.detailRefreshJobsQueued).toEqual([]);
  });

});
