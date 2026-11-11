import { SportsReadinessService } from './sports-readiness.service';

const makeRecentData = (teamId: string, periodCount = 4) => ({
  team: { id: teamId },
  form: [{
    teamId,
    competitionId: 'competition-1',
    seasonId: 'season-1',
    results: Array.from({ length: 5 }, (_, index) => ({
      fixtureId: `${teamId}-form-${index}`,
      kickoffAt: new Date(Date.UTC(2026, 9, 20 - index)),
      result: 'W' as const,
      goalsFor: 2,
      goalsAgainst: 1,
      homeAway: 'HOME' as const,
    })),
  }],
  recentFixtures: Array.from({ length: periodCount }, (_, index) => ({
    id: `${teamId}-period-${index}`,
    competitors: [{ teamId, score: 2 }],
    periodScores: [{ teamId, period: 1, score: 1 }],
  })),
});

const statisticRows = (shotsSample = 8) => [
  { key: 'wonCorners', average: 5.2, sampleSize: 8 },
  { key: 'totalShots', average: 12.4, sampleSize: shotsSample },
  { key: 'shotsOnTarget', average: 4.1, sampleSize: 8 },
  { key: 'yellowCards', average: 1.8, sampleSize: 8 },
  { key: 'redCards', average: 0.2, sampleSize: 8 },
  { key: 'foulsCommitted', average: 11.1, sampleSize: 8 },
  { key: 'offsides', average: 1.4, sampleSize: 8 },
];

const makeReadService = (overrides: Record<string, unknown> = {}) => {
  const scoring = (played = 10) => ({
    fixturesPlayed: played,
    averageGoalsFor: 1.6,
    averageGoalsAgainst: 1.1,
    computedAt: new Date('2026-11-10T10:00:00.000Z'),
    metrics: {
      eventMetrics: {
        matchesWithTimeline: 8,
        firstGoalRate: 0.5,
        lastGoalRate: 0.4,
      },
    },
  });
  const homeAway = () => ({
    home: { played: 6, goalsFor: 10, goalsAgainst: 5 },
    away: { played: 6, goalsFor: 8, goalsAgainst: 6 },
    computedAt: new Date('2026-11-10T10:00:00.000Z'),
  });
  const read: Record<string, jest.Mock> = {
    getMatch: jest.fn().mockResolvedValue({
      fixture: {
        id: 'fixture-1',
        competitionId: 'competition-1',
        seasonId: 'season-1',
        status: { state: 'SCHEDULED' },
        competitors: [
          { teamId: 'team-home', homeAway: 'HOME' },
          { teamId: 'team-away', homeAway: 'AWAY' },
        ],
      },
    }),
    getTeamScoringRecord: jest.fn(async (_teamId: string) => scoring()),
    getTeamHomeAwayRecord: jest.fn(async () => homeAway()),
    getCompetitionScoringTotals: jest.fn().mockResolvedValue({
      fixturesPlayed: 12,
      computedAt: new Date('2026-11-10T10:00:00.000Z'),
      eventMetrics: {
        timelineCoverageMatches: 8,
        redCardMatches: 0,
        penaltyAwardedMatches: 1,
        ownGoalMatches: 0,
      },
    }),
    getTeamStatisticsAggregate: jest.fn(async (teamId: string) => ({
      fixturesWithStatistics: 8,
      computedAt: new Date('2026-11-10T10:00:00.000Z'),
      statistics: statisticRows(teamId === 'team-home' ? 8 : 8),
    })),
    getTeamData: jest.fn(async (teamId: string) => makeRecentData(teamId)),
    getHeadToHead: jest.fn().mockResolvedValue({
      matches: [{}, {}, {}],
      computedAt: new Date('2026-11-10T10:00:00.000Z'),
    }),
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'function') read[key] = value as jest.Mock;
    else read[key] = jest.fn().mockResolvedValue(value);
  }
  return read;
};

describe('SportsReadinessService', () => {
  it('marks supported score, period, statistic and timeline inputs ready at the configured thresholds', async () => {
    const service = new SportsReadinessService(makeReadService() as any);
    const result = await service.getFixtureReadiness('fixture-1');

    expect(result).not.toBeNull();
    expect(result?.scoreMatrix.ready).toBe(true);
    expect(result?.periodMatrix.ready).toBe(true);
    expect(result?.teamStatistics.corners.ready).toBe(true);
    expect(result?.teamStatistics.shots.ready).toBe(true);
    expect(result?.teamStatistics.redCards.minimumSampleSize).toBe(8);
    expect(result?.timeline.ready).toBe(true);
    expect(result?.eventMarkets.redCard.ready).toBe(true);
    expect(result?.eventMarkets.redCard.eventMatches).toBe(0);
    expect(result?.playerMarkets.state).toBe('UNSUPPORTED');
  });

  it('keeps statistic readiness independent when one statistic lacks enough samples', async () => {
    const read = makeReadService();
    read.getTeamStatisticsAggregate = jest.fn(async (teamId: string) => ({
      fixturesWithStatistics: 8,
      statistics: statisticRows(teamId === 'team-home' ? 3 : 8),
    }));
    const service = new SportsReadinessService(read as any);
    const result = await service.getFixtureReadiness('fixture-1');

    expect(result?.teamStatistics.corners.ready).toBe(true);
    expect(result?.teamStatistics.shots.ready).toBe(false);
    expect(result?.teamStatistics.shots.state).toBe('INSUFFICIENT');
  });

  it('requires observed first-half splits from both teams for period markets', async () => {
    const read = makeReadService();
    read.getTeamData = jest.fn(async (teamId: string) =>
      makeRecentData(teamId, teamId === 'team-away' ? 2 : 4),
    );
    const service = new SportsReadinessService(read as any);
    const result = await service.getFixtureReadiness('fixture-1');

    expect(result?.scoreMatrix.ready).toBe(true);
    expect(result?.periodMatrix.ready).toBe(false);
    expect(result?.periodMatrix.awayPeriodObservations).toBe(2);
  });

  it('requires both minimum Plays sample size and minimum timeline coverage', async () => {
    const read = makeReadService();
    read.getCompetitionScoringTotals = jest.fn().mockResolvedValue({
      fixturesPlayed: 20,
      eventMetrics: {
        timelineCoverageMatches: 7,
        redCardMatches: 0,
        penaltyAwardedMatches: 0,
        ownGoalMatches: 0,
      },
    });
    const service = new SportsReadinessService(read as any);
    const result = await service.getFixtureReadiness('fixture-1');

    expect(result?.timeline.ready).toBe(false);
    expect(result?.timeline.coverageRate).toBe(0.35);
    expect(result?.eventMarkets.redCard.ready).toBe(false);
  });

  it('preserves unknown timeline coverage as null and treats it as insufficient', () => {
    const service = new SportsReadinessService(makeReadService() as any);
    const result = (service as any).measure({
      sampleSize: 8,
      minimumSampleSize: 8,
      quality: 0.9,
      minimumQuality: 0.62,
      coverageRate: null,
      minimumCoverageRate: 0.65,
      hasData: true,
      reasonWhenMissing: 'coverage missing',
      reasonWhenInsufficient: 'coverage insufficient',
      eligible: true,
    });

    expect(result.coverageRate).toBeNull();
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('coverage insufficient');
  });

  it('returns null when the requested fixture is not in Sports', async () => {
    const read = makeReadService({ getMatch: jest.fn().mockResolvedValue(null) });
    const service = new SportsReadinessService(read as any);

    await expect(service.getFixtureReadiness('missing-fixture')).resolves.toBeNull();
  });
});

// The Odds worker already loads these normalized records to price a fixture.
// Supplying them to readiness avoids duplicating the same database reads.
describe('SportsReadinessService shared pricing context', () => {
  it('evaluates a preloaded context without issuing duplicate Sports reads', async () => {
    const read = makeReadService();
    const service = new SportsReadinessService(read as any);
    const match = await read.getMatch('fixture-1');
    const sourceContext = {
      match,
      homeScoring: await read.getTeamScoringRecord('team-home', 'competition-1', 'season-1', 'HOME'),
      awayScoring: await read.getTeamScoringRecord('team-away', 'competition-1', 'season-1', 'AWAY'),
      homeAway: await read.getTeamHomeAwayRecord('team-home', 'competition-1', 'season-1'),
      awayAway: await read.getTeamHomeAwayRecord('team-away', 'competition-1', 'season-1'),
      competitionScoring: await read.getCompetitionScoringTotals('competition-1', 'season-1'),
      homeStatistics: await read.getTeamStatisticsAggregate('team-home', 'competition-1', 'season-1', 'HOME'),
      awayStatistics: await read.getTeamStatisticsAggregate('team-away', 'competition-1', 'season-1', 'AWAY'),
      homeTeamData: await read.getTeamData('team-home', 40, 'competition-1', 'season-1'),
      awayTeamData: await read.getTeamData('team-away', 40, 'competition-1', 'season-1'),
      headToHead: await read.getHeadToHead('team-home', 'team-away', 'competition-1'),
    };

    for (const mock of Object.values(read)) mock.mockClear();

    const result = await service.getFixtureReadiness('fixture-1', sourceContext as any);

    expect(result?.scoreMatrix.ready).toBe(true);
    expect(result?.teamStatistics.corners.ready).toBe(true);
    for (const mock of Object.values(read)) expect(mock).not.toHaveBeenCalled();
  });
});
