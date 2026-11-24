import { ExpectedGoalsService } from './expected-goals.service';

const kickoff = new Date('2026-12-01T12:00:00.000Z');
const previousKickoff = new Date('2026-11-20T12:00:00.000Z');

const makeContext = (overrides: Record<string, unknown> = {}) => ({
  fixture: {
    eventId: 'fixture-stage-1',
    fixtureDate: kickoff,
    homeTeamId: 'team-home',
    awayTeamId: 'team-away',
    neutralSite: false,
  },
  leagueFixtures: [],
  historicalFixtures: [],
  homeAwayRecords: { home: null, away: null },
  scoringRecords: { home: null, away: null },
  competitionScoring: null,
  homeForm: null,
  awayForm: null,
  headToHead: null,
  standings: null,
  ...overrides,
}) as any;

describe('ExpectedGoalsService baseline coverage', () => {
  const service = new ExpectedGoalsService();

  it('returns a valid prior-only goal baseline when no historical information exists', () => {
    const result = service.estimate(makeContext());

    expect(result.evidenceLevel).toBe('PRIOR_ONLY');
    expect(result.independentEvidenceAvailable).toBe(false);
    expect(Number.isFinite(result.home)).toBe(true);
    expect(Number.isFinite(result.away)).toBe(true);
    expect(result.home).toBeGreaterThan(0);
    expect(result.away).toBeGreaterThan(0);
    expect(result.home).toBeLessThanOrEqual(4.25);
    expect(result.away).toBeLessThanOrEqual(4.25);
    expect(result.calculationMethod).toContain('Prior-only baseline');
  });

  it('uses a single completed team match as sparse evidence instead of discarding it', () => {
    const result = service.estimate(makeContext({
      historicalFixtures: [{
        eventId: 'previous-fixture-1',
        fixtureDate: previousKickoff,
        completed: true,
        homeTeamId: 'team-home',
        awayTeamId: 'other-team',
        homeScore: 3,
        awayScore: 0,
        periodScores: [],
      }],
    }));

    expect(result.homeSamples).toBe(1);
    expect(result.homeRecentFormSamples).toBe(1);
    expect(result.evidenceLevel).toBe('LIMITED');
    expect(result.evidence.some((item) => item.includes('sparse team'))).toBe(true);
  });

  it('uses a competition scoring projection from its first completed fixture', () => {
    const baseline = service.estimate(makeContext());
    const projected = service.estimate(makeContext({
      competitionScoring: {
        fixturesPlayed: 1,
        homeGoals: 3,
        awayGoals: 0,
      },
    }));

    expect(projected.leagueSamples).toBe(1);
    expect(projected.evidenceLevel).toBe('LIMITED');
    expect(projected.leagueHomeAverage).not.toBe(baseline.leagueHomeAverage);
    expect(projected.leagueAwayAverage).not.toBe(baseline.leagueAwayAverage);
  });

  it('progresses to DEVELOPING when both teams and the competition have early samples', () => {
    const results = [1, 2].map((index) => ({
      eventId: `previous-${index}`,
      fixtureDate: new Date(previousKickoff.getTime() - index * 86_400_000),
      completed: true,
      homeTeamId: 'team-home',
      awayTeamId: 'team-away',
      homeScore: 2,
      awayScore: 1,
      periodScores: [],
    }));
    const result = service.estimate(makeContext({
      historicalFixtures: results,
      competitionScoring: { fixturesPlayed: 6, homeGoals: 10, awayGoals: 7 },
    }));

    expect(result.evidenceLevel).toBe('DEVELOPING');
    expect(result.homeSamples).toBeGreaterThanOrEqual(2);
    expect(result.awaySamples).toBeGreaterThanOrEqual(2);
  });
});
