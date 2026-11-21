import { SportsPersistenceService } from './sports-persistence.service';

function createQuery(rows: Array<Record<string, unknown>>) {
  const query = {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(rows),
  };
  return query;
}

describe('SportsPersistenceService completed-fixture pagination', () => {
  it('uses bounded deterministic keyset pages and returns a continuation cursor', async () => {
    const firstKickoff = new Date('2026-11-12T18:00:00.000Z');
    const secondKickoff = new Date('2026-11-11T18:00:00.000Z');
    const firstQuery = createQuery([
      { id: 'fixture-3', kickoffAt: firstKickoff },
      { id: 'fixture-2', kickoffAt: secondKickoff },
    ]);
    const secondQuery = createQuery([
      { id: 'fixture-1', kickoffAt: new Date('2026-11-10T18:00:00.000Z') },
    ]);
    const fixtureModel = {
      find: jest.fn()
        .mockReturnValueOnce(firstQuery)
        .mockReturnValueOnce(secondQuery),
    };
    const service = Object.create(SportsPersistenceService.prototype) as any;
    service.fixtureModel = fixtureModel;

    const firstPage = await service.getCompletedFixturesPage({
      competitionId: 'competition-1',
      seasonId: 'season-1',
      limit: 1,
    });

    expect(firstPage.items.map((item: any) => item.id)).toEqual(['fixture-3']);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(firstQuery.sort).toHaveBeenCalledWith({ kickoffAt: -1, id: -1 });
    expect(firstQuery.limit).toHaveBeenCalledWith(2);
    expect(firstQuery.select).toHaveBeenCalledWith({
      _id: 0,
      id: 1,
      competitionId: 1,
      seasonId: 1,
      kickoffAt: 1,
      completedAt: 1,
      status: 1,
      espnEventId: 1,
    });
    expect(fixtureModel.find.mock.calls[0][0].$and).toEqual(expect.arrayContaining([
      { competitionId: 'competition-1' },
      { seasonId: 'season-1' },
    ]));

    const secondPage = await service.getCompletedFixturesPage({
      competitionId: 'competition-1',
      seasonId: 'season-1',
      limit: 1,
      cursor: firstPage.nextCursor,
    });

    expect(secondPage.items.map((item: any) => item.id)).toEqual(['fixture-1']);
    expect(secondPage.nextCursor).toBeUndefined();
    const secondFilter = fixtureModel.find.mock.calls[1][0];
    const cursorCondition = secondFilter.$and[4].$or;
    expect(cursorCondition).toEqual([
      { kickoffAt: { $lt: firstKickoff } },
      { kickoffAt: firstKickoff, id: { $lt: 'fixture-3' } },
    ]);
  });

  it('clamps requested page sizes to the supported maximum', async () => {
    const query = createQuery([]);
    const service = Object.create(SportsPersistenceService.prototype) as any;
    service.fixtureModel = { find: jest.fn().mockReturnValue(query) };

    await service.getCompletedFixturesPage({ limit: 10_000 });

    expect(query.limit).toHaveBeenCalledWith(251);
  });

  it('rejects invalid continuation cursors instead of silently restarting a scan', async () => {
    const service = Object.create(SportsPersistenceService.prototype) as any;
    service.fixtureModel = { find: jest.fn() };

    await expect(service.getCompletedFixturesPage({ cursor: 'not-a-valid-cursor' }))
      .rejects.toThrow('Invalid completed-fixture cursor.');
    expect(service.fixtureModel.find).not.toHaveBeenCalled();
  });

  it('loads extended statistics and Summary fields only when projection repair requests them', async () => {
    const query = createQuery([]);
    const service = Object.create(SportsPersistenceService.prototype) as any;
    service.fixtureModel = { find: jest.fn().mockReturnValue(query) };

    await service.getCompletedFixturesPage({
      competitionId: 'competition-1',
      seasonId: 'season-1',
      includeProjectionData: true,
    });

    expect(query.select).toHaveBeenCalledWith('-_id');
  });
});


describe('SportsPersistenceService fixture score regression protection', () => {
  const service = Object.create(SportsPersistenceService.prototype) as any;

  it('preserves an already-known final score when ESPN omits scores on a later final refresh', () => {
    const completedAt = new Date('2026-11-18T20:00:00.000Z');
    const previous = {
      status: { state: 'COMPLETED', isFinal: true },
      completedAt,
      competitors: [
        { teamId: 'home-1', homeAway: 'HOME', score: 2, winner: true },
        { teamId: 'away-1', homeAway: 'AWAY', score: 1, winner: false },
      ],
      periodScores: [
        { teamId: 'home-1', period: 1, score: 1 },
        { teamId: 'away-1', period: 1, score: 0 },
        { teamId: 'home-1', period: 2, score: 1 },
        { teamId: 'away-1', period: 2, score: 1 },
      ],
    };
    const incoming = {
      status: { state: 'COMPLETED', isFinal: true },
      competitors: [
        { teamId: 'home-1', homeAway: 'HOME', score: null },
        { teamId: 'away-1', homeAway: 'AWAY', score: null },
      ],
      periodScores: [],
    };

    const result = service.preventFixtureRegression(incoming, previous);

    expect(result.competitors.map((item: any) => item.score)).toEqual([2, 1]);
    expect(result.periodScores).toEqual(previous.periodScores);
    expect(result.completedAt).toEqual(completedAt);
  });

  it('preserves only the missing team score while accepting a corrected score from ESPN', () => {
    const previous = {
      status: { state: 'COMPLETED', isFinal: true },
      competitors: [
        { teamId: 'home-1', homeAway: 'HOME', score: 2, winner: true },
        { teamId: 'away-1', homeAway: 'AWAY', score: 1, winner: false },
      ],
      periodScores: [],
    };
    const incoming = {
      status: { state: 'COMPLETED', isFinal: true },
      competitors: [
        { teamId: 'home-1', homeAway: 'HOME', score: 3, winner: true },
        { teamId: 'away-1', homeAway: 'AWAY', score: null },
      ],
      periodScores: [],
    };

    const result = service.preventFixtureRegression(incoming, previous);

    expect(result.competitors.map((item: any) => item.score)).toEqual([3, 1]);
  });

  it('does not regress a previously live fixture to SCHEDULED when its kickoff is unchanged', () => {
    const kickoffAt = new Date('2026-11-18T18:00:00.000Z');
    const previous = {
      kickoffAt,
      status: { state: 'LIVE', isFinal: false },
      competitors: [
        { teamId: 'home-1', homeAway: 'HOME', score: 1 },
        { teamId: 'away-1', homeAway: 'AWAY', score: 0 },
      ],
      periodScores: [],
    };
    const incoming = {
      kickoffAt: new Date(kickoffAt.getTime()),
      status: { state: 'SCHEDULED', isFinal: false },
      competitors: [
        { teamId: 'home-1', homeAway: 'HOME', score: null },
        { teamId: 'away-1', homeAway: 'AWAY', score: null },
      ],
      periodScores: [],
    };

    const result = service.preventFixtureRegression(incoming, previous);

    expect(result.status).toEqual(previous.status);
    expect(result.competitors.map((item: any) => item.score)).toEqual([1, 0]);
  });

});

