import { FootballMatchFactsService } from './football-match-facts.service';

const makeMatch = (homeScore = 0, awayScore = 0) => ({
  fixture: {
    id: 'fixture-1',
    espnEventId: 'espn-1',
    competitionId: 'competition-1',
    seasonId: 'season-1',
    seasonYear: 2026,
    kickoffAt: new Date('2026-11-09T18:00:00.000Z'),
    status: { state: 'COMPLETED', isFinal: true, period: 2 },
    competitors: [
      {
        teamId: 'team-home',
        homeAway: 'HOME',
        score: homeScore,
        statistics: [{ key: 'shots', name: 'Shots', value: '10' }],
      },
      {
        teamId: 'team-away',
        homeAway: 'AWAY',
        score: awayScore,
        statistics: [{ key: 'shots', name: 'Shots', value: '8' }],
      },
    ],
    periodScores: [],
    source: {
      provider: 'ESPN',
      endpoint: '/scoreboard',
      collectedAt: new Date('2026-11-09T20:00:00.000Z'),
    },
    createdAt: new Date('2026-11-09T18:00:00.000Z'),
    updatedAt: new Date('2026-11-09T20:00:00.000Z'),
  },
  competition: { id: 'competition-1', slug: 'eng.1', name: 'Premier League' },
  season: null,
  homeTeam: { id: 'team-home', name: 'Home FC', displayName: 'Home FC' },
  awayTeam: { id: 'team-away', name: 'Away FC', displayName: 'Away FC' },
  timeline: [],
  latestOdds: null,
}) as any;

describe('FootballMatchFactsService timeline evidence', () => {
  const service = new FootballMatchFactsService();

  it('does not treat a 0-0 score and empty timeline as complete goal evidence without Plays coverage', () => {
    const match = makeMatch(0, 0);
    match.matchFacts = { summaryEvents: [{ eventId: 'summary-goal', type: 'goal', athleteIds: [], sourceCoverage: 'PARTIAL' }] };
    const facts = service.extract(match);

    expect(facts.goalEventsComplete).toBe(false);
    expect(facts.timelineCoverageComplete).toBe(false);
    expect(facts.sourceDiagnostics).toContain('MATCH_PLAYS_COVERAGE_NOT_CONFIRMED');
  });

  it('allows an empty 0-0 timeline to count as complete only after Core Plays coverage succeeds', () => {
    const facts = service.extract(makeMatch(0, 0), {
      timelineCoverageComplete: true,
    });

    expect(facts.goalEventsComplete).toBe(true);
    expect(facts.timelineCoverageComplete).toBe(true);
    expect(facts.sourceDiagnostics).not.toContain('MATCH_PLAYS_COVERAGE_NOT_CONFIRMED');
  });


  it('uses authoritative final Summary scores ahead of an older scoreboard score', () => {
    const match = makeMatch(1, 0);
    match.matchFacts = {
      revision: 3,
      sourcePayloadHash: 'summary-hash-3',
      normalizationVersion: '1.1.0',
      sourceCollectedAt: new Date('2026-11-09T20:10:00.000Z'),
      matchResult: {
        homeTeamId: 'team-home', awayTeamId: 'team-away',
        homeScore: 0, awayScore: 1, isFinal: true, available: true,
        scoreSource: 'ESPN_SUMMARY',
      },
      periodScores: [], teamStatistics: [], playerAppearances: [], summaryEvents: [],
      sectionStatus: { matchResult: 'COMPLETE' },
    };

    const facts = service.extract(match);
    expect(facts).toMatchObject({ homeGoals: 0, awayGoals: 1, scoreSource: 'ESPN_SUMMARY' });
    expect(facts.summaryFactsRevision).toBe(3);
    expect(facts.summaryFactsSourcePayloadHash).toBe('summary-hash-3');
  });

  it('does not let fixture-fallback Summary scores override the normalized scoreboard score', () => {
    const match = makeMatch(1, 0);
    match.matchFacts = {
      matchResult: {
        homeScore: 0, awayScore: 1, isFinal: true, available: true,
        scoreSource: 'FIXTURE_FALLBACK',
      },
      periodScores: [], teamStatistics: [], playerAppearances: [], summaryEvents: [],
    };

    const facts = service.extract(match);
    expect(facts).toMatchObject({ homeGoals: 1, awayGoals: 0, scoreSource: 'SPORTS_NORMALIZED_FIXTURE' });
  });

  it('uses Summary team statistics as the latest per-team snapshot', () => {
    const match = makeMatch(1, 0);
    match.matchFacts = {
      sourceCollectedAt: new Date('2026-11-09T20:10:00.000Z'),
      teamStatistics: [
        { teamId: 'team-home', statistics: [
          { canonicalKey: 'shots', providerKey: 'totalShots', providerLabel: 'Shots', value: 21, unit: 'COUNT' },
          { canonicalKey: 'corners', providerKey: 'wonCorners', providerLabel: 'Corner Kicks', value: 7, unit: 'COUNT' },
        ] },
        { teamId: 'team-away', statistics: [
          { canonicalKey: 'shots', providerKey: 'totalShots', providerLabel: 'Shots', value: 12, unit: 'COUNT' },
        ] },
      ],
      playerAppearances: [], summaryEvents: [], periodScores: [],
    };

    const facts = service.extract(match);
    expect(facts.homeStats).toMatchObject({ shots: 21, corners: 7 });
    expect(facts.awayStats).toMatchObject({ shots: 12 });
    expect(facts.homeStatisticsSource).toBe('ESPN_SUMMARY');
    expect(facts.awayStatisticsSource).toBe('ESPN_SUMMARY');
    expect(facts.homeStatisticsCollectedAt).toEqual(new Date('2026-11-09T20:10:00.000Z'));
  });

  it('imports player box-score statistics while keeping Summary key events out of the goal timeline', () => {
    const match = makeMatch(1, 0);
    match.matchFacts = {
      sourceCollectedAt: new Date('2026-11-09T20:10:00.000Z'),
      playerAppearances: [{
        playerId: 'athlete:player-1', name: 'Player One', shortName: 'P. One',
        appearances: 1, appearanceBasis: 'PROVIDER_STATISTIC',
        statistics: [
          { canonicalKey: 'assists', providerKey: 'goalAssists', value: 1, unit: 'COUNT' },
          { canonicalKey: 'shotsontarget', providerKey: 'shotsOnTarget', value: 2, unit: 'COUNT' },
        ],
      }],
      summaryEvents: [{ eventId: 'summary-goal', type: 'goal', athleteIds: ['player-1'], sourceCoverage: 'PARTIAL' }],
      teamStatistics: [], periodScores: [],
    };

    const facts = service.extract(match);
    expect(facts.playerNames['athlete:player-1']).toBe('Player One');
    expect(facts.playerStats['athlete:player-1']).toMatchObject({ assists: 1, shotsontarget: 2, appearances: 1 });
    expect(facts.goals).toHaveLength(0);
    expect(facts.goalEventsComplete).toBe(false);
    expect(facts.sourceDiagnostics).toContain('SUMMARY_KEY_EVENTS_ARE_PARTIAL_NOT_PLAY_COVERAGE');
  });

  it('does not treat a 1-0 score as complete when the confirmed timeline has no goal event', () => {
    const facts = service.extract(makeMatch(1, 0), {
      timelineCoverageComplete: true,
    });

    expect(facts.goalEventsComplete).toBe(false);
    expect(facts.sourceDiagnostics).toContain(
      'GOAL_TIMELINE_DOES_NOT_FULLY_RECONCILE_WITH_REGULATION_SCORE',
    );
  });
});

