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

  const normalizeOfficialStandings = (
    rawPayload: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ) => service.normalizeOfficialStandings({
    competitionId: 'competition:eng.1',
    seasonId: 'season:2026',
    endpoint: '/leagues/eng.1/summary?event=match-1',
    sourcePayloadHash: 'summary-hash',
    sourceRevision: 4,
    sourceCollectedAt: new Date('2026-11-01T17:00:00.000Z'),
    rawPayload,
    ...overrides,
  });

  it('extracts ESPN Summary standings with team ids, provider positions and display statistics', () => {
    const snapshot = normalizeOfficialStandings({
      standings: {
        header: 'English Premier League Standings',
        groups: [{
          standings: {
            entries: [{
              team: 'Arsenal',
              id: '359',
              link: 'https://www.espn.com/soccer/club/_/id/359/arsenal',
              stats: [
                { name: 'gamesPlayed', displayName: 'Games Played', abbreviation: 'GP', value: 9, displayValue: '9' },
                { name: 'points', displayName: 'Points', abbreviation: 'P', value: 24, displayValue: '24' },
                { name: 'rank', displayName: 'Rank', abbreviation: 'R', value: 1, displayValue: '1' },
                { name: 'overall', displayName: 'Overall', summary: '8-0-1', displayValue: '8-0-1' },
              ],
              logo: [{ href: 'https://a.espncdn.com/i/teamlogos/soccer/500/359.png' }],
            }, {
              team: 'Manchester City',
              id: '382',
              stats: [
                { name: 'gamesPlayed', value: 9, displayValue: '9' },
                { name: 'points', value: 21, displayValue: '21' },
                { name: 'rank', value: 2, displayValue: '2' },
              ],
            }],
          },
          header: 'English Premier League Standings',
          href: 'https://www.espn.com/soccer/table/_/league/eng.1',
        }],
      },
    });

    expect(snapshot).toMatchObject({
      id: 'official-standings:competition:eng.1:season:2026',
      competitionId: 'competition:eng.1',
      seasonId: 'season:2026',
      provider: 'ESPN',
      header: 'English Premier League Standings',
      entryCount: 2,
      isComplete: true,
      groups: [{
        id: 'group-1',
        header: 'English Premier League Standings',
        entries: [
          {
            teamId: 'team:359',
            espnTeamId: '359',
            teamName: 'Arsenal',
            position: 1,
            logoUrl: 'https://a.espncdn.com/i/teamlogos/soccer/500/359.png',
            stats: expect.arrayContaining([
              expect.objectContaining({ name: 'points', value: 24, displayValue: '24' }),
              expect.objectContaining({ name: 'overall', value: null, summary: '8-0-1' }),
            ]),
          },
          { teamId: 'team:382', teamName: 'Manchester City', position: 2 },
        ],
      }],
    });
  });

  it('preserves separate groups and their provider order', () => {
    const snapshot = normalizeOfficialStandings({
      standings: {
        header: 'Competition Standings',
        groups: [
          { id: 'east', name: 'East Group', standings: { entries: [
            { team: 'Club A', id: '101', stats: [{ name: 'rank', value: 1 }] },
            { team: 'Club B', id: '102', stats: [{ name: 'rank', value: 2 }] },
          ] } },
          { id: 'west', name: 'West Group', standings: { entries: [
            { team: 'Club C', id: '201', stats: [{ name: 'rank', value: 1 }] },
          ] } },
        ],
      },
    });

    expect(snapshot?.groups.map((group) => group.name)).toEqual(['East Group', 'West Group']);
    expect(snapshot?.groups.map((group) => group.entries.map((entry) => entry.teamId))).toEqual([
      ['team:101', 'team:102'],
      ['team:201'],
    ]);
    expect(snapshot?.isComplete).toBe(true);
  });

  it('marks malformed or empty standings groups incomplete instead of treating them as authoritative', () => {
    const snapshot = normalizeOfficialStandings({
      standings: {
        header: 'Incomplete Table',
        groups: [{ standings: { entries: [
          { team: 'Club A', id: '101', stats: [{ name: 'rank', value: 1 }] },
          { team: 'Unknown Team', stats: [] },
        ] } }, {
          id: 'empty-group',
          standings: { entries: [] },
        }],
      },
    });

    expect(snapshot?.entryCount).toBe(1);
    expect(snapshot?.isComplete).toBe(false);
    expect(snapshot?.diagnostics).toEqual(expect.arrayContaining([
      'STANDINGS_ENTRY_MISSING_TEAM_ID_OR_NAME:1:2',
      'STANDINGS_GROUP_WITHOUT_ENTRIES:2',
    ]));
  });

  it('returns null when an ESPN Summary does not provide standings', () => {
    expect(normalizeOfficialStandings({ header: {}, boxscore: {} })).toBeNull();
    expect(normalizeOfficialStandings({ standings: { groups: [] } })).toBeNull();
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

