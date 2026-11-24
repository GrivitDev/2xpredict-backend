import { SportsPersistenceService } from './sports-persistence.service';

describe('SportsPersistenceService team catalogue reconciliation', () => {
  const query = (value: unknown) => ({
    exec: jest.fn().mockResolvedValue(value),
  });

  it('compares canonical team IDs and never deletes historical team documents', async () => {
    const updateMany = jest.fn(() =>
      query({ acknowledged: true, matchedCount: 4, modifiedCount: 2 }),
    );
    const deleteMany = jest.fn();
    const service = Object.create(
      SportsPersistenceService.prototype,
    ) as any;

    service.teamModel = { updateMany, deleteMany };

    await expect(
      service.reconcileTeamsForLeague(' ARG.2 ', ['21540', 'team:18794', '21540']),
    ).resolves.toBe(2);

    expect(updateMany).toHaveBeenCalledWith(
      {
        leagueIds: 'arg.2',
        id: { $nin: ['team:21540', 'team:18794'] },
      },
      { $pull: { leagueIds: 'arg.2' } },
    );
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('does not modify memberships when the catalogue response is empty', async () => {
    const updateMany = jest.fn();
    const deleteMany = jest.fn();
    const service = Object.create(
      SportsPersistenceService.prototype,
    ) as any;

    service.teamModel = { updateMany, deleteMany };

    await expect(
      service.reconcileTeamsForLeague('arg.2', []),
    ).resolves.toBe(0);

    expect(updateMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });
  it('adds missing league membership idempotently without modifying other team fields', async () => {
    const updateMany = jest.fn(() =>
      query({ acknowledged: true, matchedCount: 2, modifiedCount: 2 }),
    );
    const service = Object.create(
      SportsPersistenceService.prototype,
    ) as any;
    service.teamModel = { updateMany };

    await expect(
      service.ensureTeamLeagueMembership(['114', 'team:124', '114'], ' ITA.1 '),
    ).resolves.toBe(2);

    expect(updateMany).toHaveBeenCalledWith(
      {
        id: { $in: ['team:114', 'team:124'] },
        leagueIds: { $ne: 'ita.1' },
      },
      { $addToSet: { leagueIds: 'ita.1' } },
    );
  });

});

