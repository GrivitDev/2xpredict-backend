import { SportsPersistenceService } from './sports-persistence.service';

function createQuery<T>(rows: T[]) {
  const query = {
    select: jest.fn().mockReturnThis(),
    session: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(rows),
  };
  return query;
}

function createService(existingRows: any[]) {
  const session = {
    withTransaction: jest.fn(async (work: () => Promise<void>) => work()),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
  const query = createQuery(existingRows);
  const bulkWrite = jest.fn().mockResolvedValue({
    upsertedCount: 0,
    modifiedCount: 1,
  });
  const enqueueChanged = jest.fn().mockResolvedValue(false);
  const service = Object.create(SportsPersistenceService.prototype) as any;

  Object.assign(service, {
    teamModel: {
      db: { startSession: jest.fn().mockResolvedValue(session) },
      find: jest.fn().mockReturnValue(query),
      bulkWrite,
    },
    changeEvents: {
      enqueueChanged,
      notifyWorker: jest.fn(),
    },
  });

  return { service, session, query, bulkWrite, enqueueChanged };
}

const source = (collectedAt: string, endpoint: string) => ({
  provider: 'ESPN' as const,
  providerId: '114',
  endpoint,
  collectedAt: new Date(collectedAt),
});

describe('SportsPersistenceService team snapshot merge protection', () => {
  it('fills missing identity fields from an older fixture snapshot without replacing newer team details', async () => {
    const previous = {
      id: 'team:114',
      espnId: '114',
      leagueIds: ['ita.1'],
      name: 'Napoli FC',
      displayName: 'SSC Napoli',
      logo: undefined,
      country: 'Italy',
      location: 'Naples',
      source: source('2026-11-21T10:00:00.000Z', '/leagues/ita.1/teams/114'),
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    const incoming = {
      id: 'team:114',
      espnId: '114',
      leagueIds: ['ita.2'],
      name: 'Napoli',
      displayName: 'Napoli',
      logo: 'https://example.test/napoli.png',
      country: undefined,
      location: 'Napoli',
      source: source('2026-11-20T10:00:00.000Z', '/scoreboard#team:114'),
      createdAt: new Date('2026-11-20T10:00:00.000Z'),
      rawPayload: { displayName: 'Napoli' },
    };
    const h = createService([previous]);

    await h.service.saveTeams([incoming]);

    const operation = h.bulkWrite.mock.calls[0][0][0].updateOne.update;
    expect(operation.$set).toMatchObject({
      id: 'team:114',
      name: 'Napoli FC',
      displayName: 'SSC Napoli',
      logo: 'https://example.test/napoli.png',
      country: 'Italy',
      location: 'Naples',
      source: previous.source,
    });
    expect(operation.$addToSet.leagueIds.$each).toEqual(['ita.1', 'ita.2']);
    expect(operation.$setOnInsert.createdAt).toEqual(previous.createdAt);
  });

  it('accepts newer populated fields but never clears a previously known logo or country', async () => {
    const previous = {
      id: 'team:114',
      espnId: '114',
      leagueIds: ['ita.1'],
      name: 'Napoli',
      displayName: 'Napoli',
      logo: 'https://example.test/napoli-old.png',
      country: 'Italy',
      source: source('2026-11-20T10:00:00.000Z', '/leagues/ita.1/teams/114'),
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    const incoming = {
      id: 'team:114',
      espnId: '114',
      leagueIds: ['ita.1'],
      name: 'SSC Napoli',
      displayName: 'SSC Napoli',
      logo: '',
      country: undefined,
      source: source('2026-11-24T10:00:00.000Z', '/scoreboard#team:114'),
      createdAt: new Date('2026-11-24T10:00:00.000Z'),
    };
    const h = createService([previous]);

    await h.service.saveTeams([incoming]);

    const operation = h.bulkWrite.mock.calls[0][0][0].updateOne.update;
    expect(operation.$set).toMatchObject({
      name: 'SSC Napoli',
      displayName: 'SSC Napoli',
      logo: 'https://example.test/napoli-old.png',
      country: 'Italy',
      source: incoming.source,
    });
  });
  it('repairs an incorrect espnId when the canonical team ID is correct', async () => {
    const previous = {
      id: 'team:114',
      espnId: '999',
      leagueIds: ['ita.1'],
      name: 'Napoli',
      displayName: 'Napoli',
      logo: 'https://example.test/napoli.png',
      country: 'Italy',
      source: source('2026-11-24T10:00:00.000Z', '/team-details'),
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    const incoming = {
      id: 'team:114',
      espnId: '114',
      leagueIds: ['ita.1'],
      name: 'Napoli',
      displayName: 'Napoli',
      logo: 'https://example.test/napoli.png',
      country: 'Italy',
      source: source('2026-11-23T10:00:00.000Z', '/scoreboard#team:114'),
      createdAt: new Date('2026-11-23T10:00:00.000Z'),
    };
    const h = createService([previous]);

    await h.service.saveTeams([incoming]);

    const operation = h.bulkWrite.mock.calls[0][0][0].updateOne.update;
    expect(operation.$set).toMatchObject({ id: 'team:114', espnId: '114' });
  });

  it('rejects an ESPN ID that is already owned by a different canonical team', async () => {
    const previous = {
      id: 'team:999',
      espnId: '114',
      leagueIds: ['ita.1'],
      name: 'Conflicting Team',
      source: source('2026-11-24T10:00:00.000Z', '/team-details'),
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    const incoming = {
      id: 'team:114',
      espnId: '114',
      leagueIds: ['ita.1'],
      name: 'Napoli',
      source: source('2026-11-24T10:00:00.000Z', '/scoreboard#team:114'),
      createdAt: new Date('2026-11-24T10:00:00.000Z'),
    };
    const h = createService([previous]);

    await expect(h.service.saveTeams([incoming])).rejects.toThrow(
      /ESPN ID 114 is already assigned to team:999/i,
    );
    expect(h.bulkWrite).not.toHaveBeenCalled();
  });

  it('skips the Mongo bulkWrite when a repeated scoreboard snapshot has no identity changes', async () => {
    const previous = {
      id: 'team:114',
      espnId: '114',
      leagueIds: ['ita.1'],
      name: 'Napoli',
      displayName: 'Napoli',
      logo: 'https://example.test/napoli.png',
      country: 'Italy',
      source: source('2026-11-20T10:00:00.000Z', '/team-details'),
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    const incoming = {
      ...previous,
      source: source('2026-11-24T10:00:00.000Z', '/scoreboard#team:114'),
      updatedAt: new Date('2026-11-24T10:00:00.000Z'),
    };
    const h = createService([previous]);

    await expect(h.service.saveTeams([incoming])).resolves.toBe(0);

    expect(h.bulkWrite).not.toHaveBeenCalled();
    expect(h.enqueueChanged).not.toHaveBeenCalled();
  });


  it('replaces an invalid stored logo with a valid fixture logo even when the snapshot is older', async () => {
    const previous = {
      id: 'team:114',
      espnId: '114',
      leagueIds: ['ita.1'],
      name: 'Napoli',
      logo: 'not-a-valid-logo-url',
      country: 'Italy',
      source: source('2026-11-24T10:00:00.000Z', '/team-details'),
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    const incoming = {
      id: 'team:114',
      espnId: '114',
      leagueIds: ['ita.1'],
      name: 'Napoli',
      logo: 'https://example.test/napoli-valid.png',
      country: 'Italy',
      source: source('2026-11-23T10:00:00.000Z', '/scoreboard#team:114'),
      createdAt: new Date('2026-11-23T00:00:00.000Z'),
    };
    const h = createService([previous]);

    await h.service.saveTeams([incoming]);

    const update = h.bulkWrite.mock.calls[0][0][0].updateOne.update;
    expect(update.$set.logo).toBe('https://example.test/napoli-valid.png');
    expect(update.$unset).toBeUndefined();
  });

  it('removes a malformed stored logo when no valid replacement is available', async () => {
    const previous = {
      id: 'team:114',
      espnId: '114',
      leagueIds: ['ita.1'],
      name: 'Napoli',
      logo: 'not-a-valid-logo-url',
      country: 'Italy',
      source: source('2026-11-24T10:00:00.000Z', '/team-details'),
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    const incoming = {
      id: 'team:114',
      espnId: '114',
      leagueIds: ['ita.1'],
      name: 'Napoli',
      country: 'Italy',
      source: source('2026-11-23T10:00:00.000Z', '/scoreboard#team:114'),
      createdAt: new Date('2026-11-23T00:00:00.000Z'),
    };
    const h = createService([previous]);

    await h.service.saveTeams([incoming]);

    const update = h.bulkWrite.mock.calls[0][0][0].updateOne.update;
    expect(update.$set).not.toHaveProperty('logo');
    expect(update.$unset).toEqual({ logo: 1 });
  });

});

