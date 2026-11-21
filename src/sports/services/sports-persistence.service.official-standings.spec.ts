import type { SportsOfficialStandingsSnapshot } from '../interfaces/sports-match-facts.interface';
import { SportsPersistenceService } from './sports-persistence.service';

const snapshot = (overrides: Partial<SportsOfficialStandingsSnapshot> = {}): SportsOfficialStandingsSnapshot => ({
  id: 'official-standings:competition-1:season-1',
  competitionId: 'competition-1',
  seasonId: 'season-1',
  provider: 'ESPN',
  endpoint: '/leagues/eng.1/summary?event=fixture-1',
  sourcePayloadHash: 'payload-new',
  sourceRevision: 2,
  sourceCollectedAt: new Date('2026-11-19T12:00:00.000Z'),
  header: 'League Standings',
  groups: [{
    id: 'overall',
    name: 'Overall',
    entries: [{
      teamId: 'team:1', espnTeamId: '1', teamName: 'Team One', position: 1, stats: [],
    }, {
      teamId: 'team:2', espnTeamId: '2', teamName: 'Team Two', position: 2, stats: [],
    }],
  }],
  entryCount: 2,
  isComplete: true,
  diagnostics: [],
  ...overrides,
});

function createService(updateOneImpl: (...args: any[]) => any, current: any = null) {
  const model = {
    updateOne: jest.fn((...args: any[]) => ({ exec: () => updateOneImpl(...args) })),
    findOne: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(current),
    })),
  };
  const service = Object.create(SportsPersistenceService.prototype) as any;
  service.officialStandingsModel = model;
  return { service: service as SportsPersistenceService, model };
}

describe('SportsPersistenceService official standings persistence', () => {
  it('records an incomplete attempt without replacing the standings groups', async () => {
    const { service, model } = createService(async () => ({ acknowledged: true }));
    const result = await service.saveOfficialStandings(snapshot({
      isComplete: false,
      diagnostics: ['STANDINGS_GROUP_WITHOUT_ENTRIES:2'],
    }));

    expect(result).toEqual({ saved: false, reason: 'INCOMPLETE' });
    const update = model.updateOne.mock.calls[0][1];
    expect(update.$set).toHaveProperty('lastAttempt.status', 'INCOMPLETE');
    expect(update.$set).not.toHaveProperty('groups');
    expect(update.$setOnInsert.groups).toEqual([]);
  });

  it('stores a complete snapshot using an atomic newer-than condition', async () => {
    const { service, model } = createService(async () => ({ matchedCount: 1, modifiedCount: 1 }));
    const result = await service.saveOfficialStandings(snapshot());

    expect(result).toEqual({ saved: true, reason: 'SAVED' });
    const filter = model.updateOne.mock.calls[0][0];
    expect(filter.$or).toEqual(expect.arrayContaining([
      { sourceCollectedAt: { $lt: new Date('2026-11-19T12:00:00.000Z') } },
      { sourceCollectedAt: { $exists: false } },
      { sourceCollectedAt: null },
    ]));
    expect(model.updateOne.mock.calls[0][1].$set).toMatchObject({
      status: 'AVAILABLE',
      isComplete: true,
      entryCount: 2,
      groups: expect.any(Array),
    });
  });

  it('does not overwrite a newer snapshot when an older write races in', async () => {
    const current = {
      sourceCollectedAt: new Date('2026-11-19T13:00:00.000Z'),
      sourcePayloadHash: 'payload-current',
    };
    const { service, model } = createService(async (...args: any[]) => {
      if (model.updateOne.mock.calls.length === 1) {
        const error: any = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }
      return { acknowledged: true };
    }, current);

    const result = await service.saveOfficialStandings(snapshot());

    expect(result).toEqual({ saved: false, reason: 'STALE' });
    expect(model.updateOne).toHaveBeenCalledTimes(2);
    expect(model.updateOne.mock.calls[1][1].$set).toHaveProperty('lastAttempt.status', 'STALE');
    expect(model.updateOne.mock.calls[1][1].$set).not.toHaveProperty('groups');
  });
});
