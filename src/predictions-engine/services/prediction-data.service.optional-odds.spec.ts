import { PredictionDataService } from './prediction-data.service';

describe('PredictionDataService optional Odds enrichment', () => {
  it('continues loading prediction context when the Odds read fails', async () => {
    const kickoffAt = new Date(Date.now() + 3 * 60 * 60_000);
    const fixture: any = {
      id: 'fixture-optional-odds',
      competitionId: 'league-optional-odds',
      seasonId: 'season-1',
      kickoffAt,
      updatedAt: new Date(),
      createdAt: new Date(),
      status: { state: 'SCHEDULED', isFinal: false },
      competitors: [
        { teamId: 'home-1', homeAway: 'HOME', score: null, statistics: [] },
        { teamId: 'away-1', homeAway: 'AWAY', score: null, statistics: [] },
      ],
      periodScores: [],
      source: { collectedAt: new Date(), providerUpdatedAt: new Date() },
    };
    const match: any = {
      fixture,
      competition: { name: 'Test League', region: 'EUROPE' },
      season: { id: 'season-1', year: 2026 },
      homeTeam: { id: 'home-1', name: 'Home' },
      awayTeam: { id: 'away-1', name: 'Away' },
    };
    const sportsRead: any = {
      getFixture: jest.fn().mockResolvedValue(fixture),
      getMatch: jest.fn().mockResolvedValue(match),
      getTeamData: jest.fn().mockResolvedValue(null),
      getTeamHomeAwayRecord: jest.fn().mockResolvedValue(null),
      getTeamScoringRecord: jest.fn().mockResolvedValue(null),
      getCompetitionScoringTotals: jest.fn().mockResolvedValue(null),
      getTeamStatisticsAggregate: jest.fn().mockResolvedValue(null),
      getStandings: jest.fn().mockResolvedValue([]),
      getHeadToHead: jest.fn().mockResolvedValue({ matches: [] }),
      getFixtures: jest.fn().mockResolvedValue({ items: [] }),
      getCompetition: jest.fn().mockResolvedValue({ name: 'Test League', region: 'EUROPE' }),
    };
    const oddsService: any = {
      getFixturePrices: jest.fn().mockRejectedValue(new Error('Odds database unavailable')),
    };
    const sportsRevisions: any = {
      getCurrentRevision: jest.fn().mockResolvedValue(0),
      getCurrentRevisions: jest.fn(async (_entity: string, ids: string[]) =>
        new Map(ids.map((id) => [id, 0])),
      ),
    };
    const service = new PredictionDataService(sportsRead, oddsService, sportsRevisions);
    const logger = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    const context = await service.loadForPrediction(fixture.id);

    expect(context.fixture.eventId).toBe(fixture.id);
    expect(context.storedOdds).toEqual([]);
    expect(logger).toHaveBeenCalled();
  });
});
