import { SportsDerivedProjectionService } from './sports-derived-projection.service';
import type { SportsFixtureRecord } from '../interfaces/sports-domain.interface';
import type { SportsMatchFactsRecord } from '../interfaces/sports-match-facts.interface';

describe('SportsDerivedProjectionService — historical projections', () => {
  const createService = (models: Record<string, unknown>[] = []) => {
    const dependencies = (models.length ? models : Array.from({ length: 13 }, () => ({}))) as unknown as ConstructorParameters<typeof SportsDerivedProjectionService>;
    return new SportsDerivedProjectionService(...dependencies);
  };

  const completedFixture = (
    id: string,
    index: number,
    seasonId = 'season-old',
  ): SportsFixtureRecord => ({
    id,
    espnEventId: `event-${id}`,
    competitionId: 'competition-1',
    seasonId,
    seasonYear: seasonId === 'season-old' ? 2024 : 2025,
    kickoffAt: new Date(Date.UTC(2025, 0, 1 + index)),
    status: { state: 'COMPLETED', isFinal: true },
    competitors: [
      {
        teamId: 'team:alpha',
        espnCompetitorId: 'alpha',
        homeAway: 'HOME',
        score: index % 3 === 0 ? 2 : 1,
      },
      {
        teamId: 'team:beta',
        espnCompetitorId: 'beta',
        homeAway: 'AWAY',
        score: index % 3 === 0 ? 0 : 1,
      },
    ],
    periodScores: [],
    source: {
      provider: 'ESPN',
      endpoint: '/summary',
      collectedAt: new Date(Date.UTC(2025, 0, 1 + index)),
    },
    createdAt: new Date(Date.UTC(2025, 0, 1 + index)),
    updatedAt: new Date(Date.UTC(2025, 0, 1 + index)),
  });

  it('builds Last 5, Last 10 and up to 40 recent facts across season boundaries', () => {
    const service = createService();
    const matches = Array.from({ length: 45 }, (_, index) => {
      const fixture = completedFixture(
        `fixture-${index}`,
        index,
        index < 20 ? 'season-old' : 'season-current',
      );
      return {
        fixture,
        home: fixture.competitors[0],
        away: fixture.competitors[1],
        homeGoals: Number(fixture.competitors[0].score),
        awayGoals: Number(fixture.competitors[1].score),
      };
    });

    const forms = (service as any).calculateTeamForms(
      matches,
      new Date('2026-11-11T00:00:00.000Z'),
      'competition-1',
      'season-current',
      new Set(['team:alpha', 'team:beta', 'team:newcomer']),
    );
    const alpha = forms.find((row: any) => row.teamId === 'team:alpha');
    const newcomer = forms.find((row: any) => row.teamId === 'team:newcomer');

    expect(alpha.metrics.last5.played).toBe(5);
    expect(alpha.metrics.last10.played).toBe(10);
    expect(alpha.metrics.recentMatchFacts).toHaveLength(40);
    expect(alpha.metrics.recentMatchFacts[0].fixtureId).toBe('fixture-44');
    expect(alpha.metrics.recentMatchFacts[39].fixtureId).toBe('fixture-5');
    expect(newcomer).toBeDefined();
    expect(newcomer.metrics.last5.played).toBe(0);
    expect(newcomer.metrics.recentMatchFacts).toHaveLength(0);
  });

  it('uses verified normalized Summary scores ahead of stale fixture scores', () => {
    const service = createService();
    const fixture = completedFixture('fixture-score', 0);
    fixture.competitors[0].score = 2;
    fixture.competitors[1].score = 1;
    const facts = {
      matchResult: {
        homeTeamId: 'team:alpha',
        awayTeamId: 'team:beta',
        homeScore: 0,
        awayScore: 3,
        isFinal: true,
        available: true,
      },
    } as SportsMatchFactsRecord;

    const match = (service as any).toCompletedMatch(fixture, facts);
    expect(match.homeGoals).toBe(0);
    expect(match.awayGoals).toBe(3);
  });

  it('reads normalized team statistics when fixture statistics are absent', () => {
    const service = createService();
    const fixture = completedFixture('fixture-stats', 0);
    const match = {
      fixture,
      home: fixture.competitors[0],
      away: fixture.competitors[1],
      homeGoals: 1,
      awayGoals: 0,
    };
    const facts = {
      teamStatistics: [
        {
          teamId: 'team:alpha',
          espnTeamId: 'alpha',
          side: 'HOME',
          statistics: [
            {
              canonicalKey: 'shots',
              providerKey: 'totalShots',
              providerLabel: 'Shots',
              value: 12,
              displayValue: '12',
              unit: 'COUNT',
            },
          ],
        },
      ],
    } as SportsMatchFactsRecord;

    const stats = (service as any).getMatchTeamStatistics(
      match,
      'team:alpha',
      [],
      facts,
    );
    expect(stats).toHaveLength(1);
    expect(stats[0].key).toBe('shots');
    expect(stats[0].value).toBe(12);
  });

  it('merges Summary team statistics without double-counting scoreboard aliases', () => {
    const service = createService();
    const fixture = completedFixture('fixture-merged-stats', 0);
    const match = {
      fixture,
      home: fixture.competitors[0],
      away: fixture.competitors[1],
      homeGoals: 1,
      awayGoals: 0,
    };
    const facts = {
      teamStatistics: [
        {
          teamId: 'team:alpha',
          espnTeamId: 'alpha',
          side: 'HOME',
          statistics: [
            {
              canonicalKey: 'shots',
              providerKey: 'totalShots',
              value: 12,
              unit: 'COUNT',
            },
            {
              canonicalKey: 'corners',
              providerKey: 'wonCorners',
              value: 4,
              unit: 'COUNT',
            },
          ],
        },
      ],
    } as SportsMatchFactsRecord;

    const stats = (service as any).getMatchTeamStatistics(
      match,
      'team:alpha',
      [
        { name: 'totalShots', displayValue: '12' },
        { name: 'foulsCommitted', displayValue: '9' },
      ],
      facts,
    );

    expect(stats).toHaveLength(3);
    expect(stats.filter((row: any) => row.name === 'shots')).toHaveLength(1);
    expect(stats.some((row: any) => row.name === 'corners')).toBe(true);
    expect(stats.some((row: any) => row.name === 'foulsCommitted')).toBe(true);
  });

  it('uses normalized Summary player appearances and statistics', () => {
    const service = createService();
    const fixture = completedFixture('fixture-player', 0);
    const match = {
      fixture,
      home: fixture.competitors[0],
      away: fixture.competitors[1],
      homeGoals: 1,
      awayGoals: 0,
    };
    const facts = {
      playerAppearances: [
        {
          playerId: 'athlete:123',
          espnPlayerId: '123',
          teamId: 'team:alpha',
          name: 'Example Player',
          appearances: 1,
          appearanceBasis: 'PROVIDER_STATISTIC',
          statistics: [
            {
              canonicalKey: 'goals',
              providerKey: 'totalGoals',
              value: 1,
              unit: 'COUNT',
            },
          ],
        },
      ],
    } as SportsMatchFactsRecord;

    const roster = (service as any).extractSummaryRosterRows(match, facts);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({
      playerId: 'athlete:123',
      name: 'Example Player',
      appearances: 1,
      metrics: { goals: 1 },
    });
  });

  it('does not delete previous-season projections when compatibility pruning is called', async () => {
    const models = Array.from({ length: 13 }, () => ({
      deleteMany: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ deletedCount: 0 }) }),
    }));
    const service = createService(models);

    await service.prunePreviousSeasons('competition-1', 'season-current');

    for (const model of models) {
      expect(model.deleteMany).not.toHaveBeenCalled();
    }
  });
});
