import { SportsDomainReadService } from './sports-domain-read.service';

function createQuery<T>(value: T) {
  const query = {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value),
  };
  return query;
}

const fixture = {
  id: 'fixture:stage3',
  espnEventId: 'stage3',
  competitionId: 'competition:eng.1',
  seasonId: 'season:2026',
  kickoffAt: new Date('2026-11-22T15:00:00.000Z'),
  status: { state: 'COMPLETED', isFinal: true },
  competitors: [
    { teamId: 'team:home', homeAway: 'HOME' },
    { teamId: 'team:away', homeAway: 'AWAY' },
  ],
};

describe('SportsDomainReadService stage 3 read performance', () => {
  it('excludes raw provider payloads from fixture list reads', async () => {
    const query = createQuery([fixture]);
    const service = Object.create(SportsDomainReadService.prototype) as any;
    service.fixtureModel = { find: jest.fn().mockReturnValue(query) };

    await service.getFixtures({ limit: 10 });

    expect(query.select).toHaveBeenCalledWith(
      '-_id -rawPayload -competitors.rawPayload',
    );
  });

  it('excludes raw provider payloads from single and batch fixture reads', async () => {
    const singleQuery = createQuery(fixture);
    const batchQuery = createQuery([fixture]);
    const service = Object.create(SportsDomainReadService.prototype) as any;
    service.fixtureModel = {
      findOne: jest.fn().mockReturnValue(singleQuery),
      find: jest.fn().mockReturnValue(batchQuery),
    };

    await service.getFixture('stage3');
    await service.getFixturesByIdentifiers(['stage3']);

    expect(singleQuery.select).toHaveBeenCalledWith(
      '-_id -rawPayload -competitors.rawPayload',
    );
    expect(batchQuery.select).toHaveBeenCalledWith(
      '-_id -rawPayload -competitors.rawPayload',
    );
  });

  it('excludes raw payloads from timeline and odds detail reads', async () => {
    const timelineQuery = createQuery([]);
    const latestOddsQuery = createQuery(null);
    const oddsHistoryQuery = createQuery([]);
    const service = Object.create(SportsDomainReadService.prototype) as any;
    service.timelineModel = { find: jest.fn().mockReturnValue(timelineQuery) };
    service.oddsModel = {
      findOne: jest.fn().mockReturnValue(latestOddsQuery),
      find: jest.fn().mockReturnValue(oddsHistoryQuery),
    };

    await service.getMatchTimeline('fixture:stage3');
    await service.getMatchOdds('fixture:stage3');
    await service.getMatchOddsHistory('fixture:stage3', 10);

    expect(timelineQuery.select).toHaveBeenCalledWith('-_id -rawPayload');
    expect(latestOddsQuery.select).toHaveBeenCalledWith('-_id -rawPayload');
    expect(oddsHistoryQuery.select).toHaveBeenCalledWith('-_id -rawPayload');
  });

  it('starts competition, season, and team context reads concurrently', async () => {
    let resolveCompetitions!: (value: any[]) => void;
    let resolveSeasons!: (value: any[]) => void;
    let resolveTeams!: (value: any[]) => void;
    const competitionQuery = createQuery(
      new Promise<any[]>((resolve) => { resolveCompetitions = resolve; }),
    );
    const seasonQuery = createQuery(
      new Promise<any[]>((resolve) => { resolveSeasons = resolve; }),
    );
    const teamQuery = createQuery(
      new Promise<any[]>((resolve) => { resolveTeams = resolve; }),
    );
    const service = Object.create(SportsDomainReadService.prototype) as any;
    service.competitionModel = {
      find: jest.fn().mockReturnValue(competitionQuery),
    };
    service.seasonModel = { find: jest.fn().mockReturnValue(seasonQuery) };
    service.teamModel = { find: jest.fn().mockReturnValue(teamQuery) };

    const resultPromise = service['buildFixtureContexts']([fixture]);

    // A sequential second wave would not have started the team query yet.
    expect(service.competitionModel.find).toHaveBeenCalledTimes(1);
    expect(service.seasonModel.find).toHaveBeenCalledTimes(1);
    expect(service.teamModel.find).toHaveBeenCalledTimes(1);

    resolveCompetitions([{ id: 'competition:eng.1', name: 'Premier League' }]);
    resolveSeasons([{ id: 'season:2026', year: 2026 }]);
    resolveTeams([
      { id: 'team:home', name: 'Home FC' },
      { id: 'team:away', name: 'Away FC' },
    ]);
    const result = await resultPromise;

    expect(competitionQuery.exec).toHaveBeenCalledTimes(1);
    expect(seasonQuery.exec).toHaveBeenCalledTimes(1);
    expect(teamQuery.exec).toHaveBeenCalledTimes(1);
    expect(result[0]).toMatchObject({
      fixture,
      competition: { id: 'competition:eng.1' },
      season: { id: 'season:2026' },
      homeTeam: { id: 'team:home' },
      awayTeam: { id: 'team:away' },
    });
  });

  it('starts completed fixture and team-form reads together after resolving the team', async () => {
    const service = Object.create(SportsDomainReadService.prototype) as any;
    const team = { id: 'team:home', name: 'Home FC' };
    const recentFixture = {
      ...fixture,
      id: 'fixture:history',
      status: { state: 'COMPLETED', isFinal: true },
    };
    let resolveFixtures!: (value: any) => void;
    let resolveForms!: (value: any[]) => void;
    const fixturesPromise = new Promise((resolve) => {
      resolveFixtures = resolve;
    });
    const formsPromise = new Promise<any[]>((resolve) => {
      resolveForms = resolve;
    });

    service.getTeam = jest.fn().mockResolvedValue(team);
    service.getFixtures = jest.fn().mockReturnValue(fixturesPromise);
    service.derived = {
      getTeamFormsForTeam: jest.fn().mockReturnValue(formsPromise),
    };

    const resultPromise = service.getTeamData('team:home', 40, 'competition:eng.1');
    await Promise.resolve();

    expect(service.getFixtures).toHaveBeenCalledWith({
      teamId: 'team:home',
      state: 'COMPLETED',
      retainedOnly: true,
      limit: 40,
    });
    expect(service.derived.getTeamFormsForTeam).toHaveBeenCalledWith(
      'team:home',
      'competition:eng.1',
    );

    resolveFixtures({ items: [recentFixture] });
    resolveForms([]);
    await expect(resultPromise).resolves.toMatchObject({
      team,
      recentFixtures: [recentFixture],
      form: [],
    });
  });
});
