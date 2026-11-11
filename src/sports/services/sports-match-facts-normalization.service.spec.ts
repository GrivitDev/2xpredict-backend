import type { SportsFixtureRecord } from '../interfaces/sports-domain.interface';
import { SportsMatchFactsNormalizationService } from './sports-match-facts-normalization.service';

describe('SportsMatchFactsNormalizationService', () => {
  const fixture = {
    id: 'fixture:match-1',
    espnEventId: 'match-1',
    competitionId: 'competition:eng.1',
    kickoffAt: new Date('2026-11-01T15:00:00.000Z'),
    status: { state: 'COMPLETED', isFinal: true },
    competitors: [
      {
        teamId: 'team:361',
        espnCompetitorId: '361',
        homeAway: 'HOME',
        score: 1,
      },
      {
        teamId: 'team:368',
        espnCompetitorId: '368',
        homeAway: 'AWAY',
        score: 0,
      },
    ],
    periodScores: [],
  } as unknown as SportsFixtureRecord;

  const service = new SportsMatchFactsNormalizationService({
    saveMatchFacts: jest.fn(),
  } as never);

  const normalize = (rawPayload: Record<string, unknown>) => service.normalize({
    fixtureId: 'fixture:match-1',
    espnEventId: 'match-1',
    competitionId: 'competition:eng.1',
    seasonId: 'season:2026',
    seasonYear: 2026,
    endpoint: '/leagues/eng.1/summary?event=match-1',
    sourcePayloadHash: 'summary-hash',
    sourceRevision: 1,
    sourceCollectedAt: new Date('2026-11-01T17:00:00.000Z'),
    rawPayload,
    fixture,
  });

  it('uses the Summary score ahead of an older fixture score', () => {
    const facts = normalize({
      header: {
        competitions: [{
          status: { type: { completed: true } },
          competitors: [
            { homeAway: 'home', team: { id: '361' }, score: '2' },
            { homeAway: 'away', team: { id: '368' }, score: '1' },
          ],
        }],
      },
    });

    expect(facts.matchResult).toMatchObject({
      homeScore: 2,
      awayScore: 1,
      isFinal: true,
      available: true,
    });
    expect(facts.sectionStatus.matchResult).toBe('COMPLETE');
    expect(facts.matchResult.scoreSource).toBe('ESPN_SUMMARY');
  });


  it('marks fixture-copied scores as fallback rather than ESPN Summary evidence', () => {
    const facts = normalize({ header: { competitions: [{ status: { type: { completed: true } }, competitors: [] }] } });
    expect(facts.matchResult).toMatchObject({ homeScore: 1, awayScore: 0, available: true });
    expect(facts.matchResult.scoreSource).toBe('FIXTURE_FALLBACK');
  });

  it('normalizes team statistics and converts percentage ratios to 0–1', () => {
    const facts = normalize({
      header: {
        competitions: [{
          competitors: [
            { homeAway: 'home', team: { id: '361' }, score: '2' },
            { homeAway: 'away', team: { id: '368' }, score: '1' },
          ],
        }],
      },
      boxscore: {
        teams: [
          {
            team: { id: '361' },
            statistics: [
              { name: 'totalShots', displayValue: '17', value: 17 },
              { name: 'shotsOnTarget', displayValue: '6', value: 6 },
              { name: 'passPct', displayValue: '82%', value: 82 },
              { name: 'possessionPct', displayValue: '54.2', value: 54.2 },
            ],
          },
          {
            team: { id: '368' },
            statistics: [{ name: 'totalShots', displayValue: '9', value: 9 }],
          },
        ],
      },
    });

    const home = facts.teamStatistics.find((row) => row.side === 'HOME');
    expect(home?.statistics).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonicalKey: 'shots', value: 17, unit: 'COUNT' }),
      expect.objectContaining({ canonicalKey: 'shotsOnTarget', value: 6, unit: 'COUNT' }),
      expect.objectContaining({ canonicalKey: 'passAccuracy', value: 0.82, unit: 'RATIO' }),
      expect.objectContaining({ canonicalKey: 'possession', value: 54.2, unit: 'PERCENT' }),
    ]));
    expect(facts.sectionStatus.teamStatistics).toBe('COMPLETE');
  });

  it('normalizes player identities, appearance evidence and player statistics', () => {
    const facts = normalize({
      rosters: [
        {
          homeAway: 'home',
          team: { id: '361' },
          roster: [{
            starter: true,
            jersey: '9',
            athlete: { id: 'player-1', displayName: 'Example Player', shortName: 'E. Player' },
            stats: [
              { name: 'appearances', value: 1, displayValue: '1' },
              { name: 'totalGoals', value: 1, displayValue: '1' },
              { name: 'goalAssists', value: 0, displayValue: '0' },
            ],
          }],
        },
      ],
    });

    expect(facts.playerAppearances[0]).toMatchObject({
      playerId: 'athlete:player-1',
      teamId: 'team:361',
      name: 'Example Player',
      jersey: '9',
      appearances: 1,
      appearanceBasis: 'PROVIDER_STATISTIC',
    });
    expect(facts.playerAppearances[0].statistics).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonicalKey: 'goals', value: 1 }),
      expect.objectContaining({ canonicalKey: 'assists', value: 0 }),
    ]));
  });

  it('keeps Summary key events explicitly partial', () => {
    const facts = normalize({
      keyEvents: [{
        id: 'event-1',
        type: { id: '70', text: 'Goal', type: 'goal' },
        text: 'Scored from close range.',
        period: { number: 2 },
        clock: { value: 2903, displayValue: "49'" },
        team: { id: '361' },
        participants: [{ athlete: { id: 'player-1' } }],
      }],
    });

    expect(facts.summaryEvents[0]).toMatchObject({
      eventId: 'event-1',
      type: 'Goal',
      description: 'Scored from close range.',
      clock: "49'",
      period: 2,
      sourceCoverage: 'PARTIAL',
      teamId: 'team:361',
      athleteIds: ['athlete:player-1'],
    });
    expect(facts.sectionStatus.summaryEvents).toBe('PARTIAL');
  });

  it('normalizes ESPN team-scoped leaders and their nested category entries', () => {
    const facts = normalize({
      leaders: [{
        team: { id: '361' },
        leaders: [{
          name: 'totalShots',
          displayName: 'Total Shots',
          leaders: [{
            displayValue: '4',
            athlete: { id: 'player-1', displayName: 'Example Player' },
          }],
        }],
      }],
    });

    expect(facts.leaders[0]).toMatchObject({
      categoryKey: 'totalShots',
      categoryName: 'Total Shots',
      athleteId: 'athlete:player-1',
      teamId: 'team:361',
      name: 'Example Player',
      value: 4,
      displayValue: '4',
    });
  });

  it('does not invent missing team or player statistics as zero', () => {
    const facts = normalize({
      header: {
        competitions: [{
          competitors: [
            { homeAway: 'home', team: { id: '361' }, score: '0' },
            { homeAway: 'away', team: { id: '368' }, score: '0' },
          ],
        }],
      },
    });

    expect(facts.teamStatistics).toEqual([]);
    expect(facts.playerAppearances).toEqual([]);
    expect(facts.sectionStatus.teamStatistics).toBe('NOT_PROVIDED');
    expect(facts.sectionStatus.playerAppearances).toBe('NOT_PROVIDED');
  });
});
