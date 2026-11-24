import { SportsDomainReadService } from './sports-domain-read.service';

function createQuery<T>(rows: T[] = []) {
  const query = {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(rows),
  };
  return query;
}

describe('SportsDomainReadService batch identifier reads', () => {
  it('loads fixtures by canonical ID or ESPN event ID in one query', async () => {
    const query = createQuery();
    const service = Object.create(
      SportsDomainReadService.prototype,
    ) as any;
    service.fixtureModel = { find: jest.fn().mockReturnValue(query) };

    await service.getFixturesByIdentifiers([
      'fixture-1',
      'fixture-1',
      ' espn-event-1 ',
      '',
    ]);

    expect(service.fixtureModel.find).toHaveBeenCalledTimes(1);
    expect(service.fixtureModel.find).toHaveBeenCalledWith({
      $or: [
        { id: { $in: ['fixture-1', 'espn-event-1'] } },
        { espnEventId: { $in: ['fixture-1', 'espn-event-1'] } },
      ],
    });
    expect(query.select).toHaveBeenCalledWith('-_id -rawPayload -competitors.rawPayload');
    expect(query.lean).toHaveBeenCalledTimes(1);
    expect(query.exec).toHaveBeenCalledTimes(1);
  });

  it('loads teams by canonical ID or ESPN ID in one query', async () => {
    const query = createQuery();
    const service = Object.create(
      SportsDomainReadService.prototype,
    ) as any;
    service.teamModel = { find: jest.fn().mockReturnValue(query) };

    await service.getTeamsByIdentifiers(['team:123', '456', 'team:123']);

    expect(service.teamModel.find).toHaveBeenCalledWith({
      $or: [
        { id: { $in: ['team:123', 'team:456'] } },
        { espnId: { $in: ['123', '456'] } },
      ],
    });
    expect(query.select).toHaveBeenCalledWith('-_id -rawPayload');
  });

  it('loads competitions by canonical ID or slug in one query', async () => {
    const query = createQuery();
    const service = Object.create(
      SportsDomainReadService.prototype,
    ) as any;
    service.competitionModel = { find: jest.fn().mockReturnValue(query) };

    await service.getCompetitionsByIdentifiers(['competition-1', 'league-slug']);

    expect(service.competitionModel.find).toHaveBeenCalledWith({
      $or: [
        { id: { $in: ['competition-1', 'league-slug'] } },
        { slug: { $in: ['competition-1', 'league-slug'] } },
      ],
    });
    expect(query.select).toHaveBeenCalledWith('-_id -rawPayload');
  });

  it('filters team records whose canonical ID and ESPN ID point to different teams', async () => {
    const rows = [
      { id: 'team:123', espnId: '123', name: 'Correct Team' },
      { id: 'team:456', espnId: '999', name: 'Corrupt Canonical Row' },
      { id: 'team:999', espnId: '456', name: 'Wrong Alias Owner' },
    ];
    const query = createQuery(rows as any);
    const service = Object.create(SportsDomainReadService.prototype) as any;
    service.teamModel = { find: jest.fn().mockReturnValue(query) };

    await expect(service.getTeamsByIdentifiers(['123', '456'])).resolves.toEqual([
      rows[0],
    ]);
  });

  it('does not query MongoDB when no identifiers are provided', async () => {
    const service = Object.create(
      SportsDomainReadService.prototype,
    ) as any;
    service.fixtureModel = { find: jest.fn() };
    service.teamModel = { find: jest.fn() };
    service.competitionModel = { find: jest.fn() };

    await expect(service.getFixturesByIdentifiers(['', '  '])).resolves.toEqual([]);
    await expect(service.getTeamsByIdentifiers([])).resolves.toEqual([]);
    await expect(service.getCompetitionsByIdentifiers([])).resolves.toEqual([]);

    expect(service.fixtureModel.find).not.toHaveBeenCalled();
    expect(service.teamModel.find).not.toHaveBeenCalled();
    expect(service.competitionModel.find).not.toHaveBeenCalled();
  });

  it('does not return a single canonical team whose stored ESPN ID is inconsistent', async () => {
    const query = createQuery([
      { id: 'team:123', espnId: '999', name: 'Incorrect Mapping' },
    ] as any);
    const service = Object.create(SportsDomainReadService.prototype) as any;
    service.teamModel = { findOne: jest.fn().mockReturnValue(query) };

    await expect(service.getTeam('123')).resolves.toBeNull();
    expect(service.teamModel.findOne).toHaveBeenCalledWith({ id: 'team:123' });
  });

});

