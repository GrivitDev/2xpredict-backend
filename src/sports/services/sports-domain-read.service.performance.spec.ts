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
  id: 'fixture:match-1',
  espnEventId: 'match-1',
  competitionId: 'competition:eng.1',
  seasonId: 'season:2026',
  kickoffAt: new Date('2026-11-21T15:00:00.000Z'),
  competitors: [
    { teamId: 'team:home', homeAway: 'HOME' },
    { teamId: 'team:away', homeAway: 'AWAY' },
  ],
};

const competition = { id: 'competition:eng.1', name: 'Premier League' };
const season = { id: 'season:2026', year: 2026 };
const homeTeam = { id: 'team:home', name: 'Home FC' };
const awayTeam = { id: 'team:away', name: 'Away FC' };

function createContextModels(service: any) {
  const competitionQuery = createQuery([competition]);
  const seasonQuery = createQuery([season]);
  const teamQuery = createQuery([homeTeam, awayTeam]);

  service.competitionModel = {
    find: jest.fn().mockReturnValue(competitionQuery),
  };
  service.seasonModel = {
    find: jest.fn().mockReturnValue(seasonQuery),
  };
  service.teamModel = {
    find: jest.fn().mockReturnValue(teamQuery),
  };

  return { competitionQuery, seasonQuery, teamQuery };
}

describe('SportsDomainReadService performance-safe match reads', () => {
  it('builds match details from the already-loaded fixture without reading it again', async () => {
    const service = Object.create(
      SportsDomainReadService.prototype,
    ) as any;
    const { competitionQuery, seasonQuery, teamQuery } =
      createContextModels(service);

    service.getFixture = jest.fn().mockResolvedValue(fixture);
    service.getMatchTimeline = jest
      .fn()
      .mockResolvedValue([{ id: 'timeline-1', fixtureId: fixture.id }]);
    service.getMatchOdds = jest
      .fn()
      .mockResolvedValue({ id: 'odds-1', fixtureId: fixture.id });
    service.fixtureModel = { find: jest.fn() };

    const matchFacts = { fixtureId: fixture.id, revision: 2 };
    const matchSummary = {
      fixtureId: fixture.id,
      payloadHash: 'summary-hash',
      revision: 2,
    };
    const matchFactsQuery = createQuery(matchFacts);
    const matchSummaryQuery = createQuery(matchSummary);
    service.matchFactsModel = {
      findOne: jest.fn().mockReturnValue(matchFactsQuery),
    };
    service.matchSummaryModel = {
      findOne: jest.fn().mockReturnValue(matchSummaryQuery),
    };

    const result = await service.getMatch('match-1');

    expect(service.getFixture).toHaveBeenCalledTimes(1);
    expect(service.getFixture).toHaveBeenCalledWith('match-1');
    expect(service.fixtureModel.find).not.toHaveBeenCalled();

    expect(service.competitionModel.find).toHaveBeenCalledWith({
      id: { $in: [fixture.competitionId] },
    });
    expect(service.seasonModel.find).toHaveBeenCalledWith({
      id: { $in: [fixture.seasonId] },
    });
    expect(service.teamModel.find).toHaveBeenCalledWith({
      id: { $in: ['team:home', 'team:away'] },
    });

    expect(result).toMatchObject({
      fixture,
      competition,
      season,
      homeTeam,
      awayTeam,
      timeline: [{ id: 'timeline-1', fixtureId: fixture.id }],
      latestOdds: { id: 'odds-1', fixtureId: fixture.id },
      matchFacts,
      matchSummary,
    });

    expect(competitionQuery.exec).toHaveBeenCalledTimes(1);
    expect(seasonQuery.exec).toHaveBeenCalledTimes(1);
    expect(teamQuery.exec).toHaveBeenCalledTimes(1);
    expect(matchFactsQuery.select).toHaveBeenCalledWith('-_id -__v');
    expect(matchSummaryQuery.select).toHaveBeenCalledWith({
      _id: 0,
      __v: 0,
      rawPayload: 0,
    });
  });

  it('deduplicates and normalizes fixture identifiers before a batch context read', async () => {
    const service = Object.create(
      SportsDomainReadService.prototype,
    ) as any;
    createContextModels(service);
    const fixtureQuery = createQuery([fixture]);
    service.fixtureModel = {
      find: jest.fn().mockReturnValue(fixtureQuery),
    };

    const result = await service.getFixtureContexts([
      ' fixture:match-1 ',
      'fixture:match-1',
      '',
      '   ',
    ]);

    expect(service.fixtureModel.find).toHaveBeenCalledTimes(1);
    expect(service.fixtureModel.find).toHaveBeenCalledWith({
      $or: [
        { id: { $in: ['fixture:match-1'] } },
        { espnEventId: { $in: ['fixture:match-1'] } },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fixture,
      competition,
      season,
      homeTeam,
      awayTeam,
    });
  });

  it('does not query MongoDB when a fixture-context request has no usable IDs', async () => {
    const service = Object.create(
      SportsDomainReadService.prototype,
    ) as any;
    service.fixtureModel = { find: jest.fn() };

    await expect(
      service.getFixtureContexts(['', '  ', '   ']),
    ).resolves.toEqual([]);

    expect(service.fixtureModel.find).not.toHaveBeenCalled();
  });

  it('returns null without loading match sections when the fixture does not exist', async () => {
    const service = Object.create(
      SportsDomainReadService.prototype,
    ) as any;
    service.getFixture = jest.fn().mockResolvedValue(null);
    service.getMatchTimeline = jest.fn();
    service.getMatchOdds = jest.fn();
    service.matchFactsModel = { findOne: jest.fn() };
    service.matchSummaryModel = { findOne: jest.fn() };

    await expect(service.getMatch('missing-fixture')).resolves.toBeNull();

    expect(service.getMatchTimeline).not.toHaveBeenCalled();
    expect(service.getMatchOdds).not.toHaveBeenCalled();
    expect(service.matchFactsModel.findOne).not.toHaveBeenCalled();
    expect(service.matchSummaryModel.findOne).not.toHaveBeenCalled();
  });
});
