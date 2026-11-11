import { OddsService } from './odds.service';

describe('OddsService source hashing', () => {
  const service = Object.create(OddsService.prototype) as any;

  const makeContext = (checkedAt: Date, cornersReady = true) => ({
    match: {
      fixture: {
        id: 'fixture-1',
        competitionId: 'competition-1',
        kickoffAt: new Date('2026-11-20T18:00:00.000Z'),
        status: { state: 'SCHEDULED', isFinal: false },
        competitors: [
          { teamId: 'team:home', homeAway: 'HOME', score: null },
          { teamId: 'team:away', homeAway: 'AWAY', score: null },
        ],
        periodScores: [],
        source: { collectedAt: new Date('2026-11-11T10:00:00.000Z') },
      },
      latestOdds: null,
    },
    homeScoring: null,
    awayScoring: null,
    homeAwayRecord: null,
    awayAwayRecord: null,
    competitionScoring: null,
    homeStatistics: null,
    awayStatistics: null,
    homeTeamData: null,
    awayTeamData: null,
    headToHead: null,
    readiness: {
      fixtureId: 'fixture-1',
      competitionId: 'competition-1',
      checkedAt,
      fixtureEligible: true,
      scoreMatrix: { ready: true, sampleSize: 8, quality: 0.8 },
      periodMatrix: { ready: false, sampleSize: 8, quality: 0.4 },
      goalOrderMarkets: { ready: true, sampleSize: 8, quality: 0.8 },
      teamStatistics: {
        corners: { ready: cornersReady, sampleSize: 8, quality: 0.8 },
      },
      timeline: { ready: false, sampleSize: 0, quality: null, coverageRate: null },
      eventMarkets: {
        redCard: { ready: false },
        penaltyAwarded: { ready: false },
        ownGoal: { ready: false },
      },
      playerMarkets: { pricingSupported: false },
      sourceComputedAt: {
        homeScoring: null,
        awayScoring: null,
        homeAway: null,
        awayAway: null,
        competitionScoring: null,
        homeStatistics: null,
        awayStatistics: null,
        headToHead: null,
      },
    },
  });

  it('does not change when only the readiness check timestamp changes', () => {
    const first = service.createSourceHash(
      makeContext(new Date('2026-11-11T10:01:00.000Z')),
      4,
      7,
    );
    const second = service.createSourceHash(
      makeContext(new Date('2026-11-11T10:02:00.000Z')),
      4,
      7,
    );

    expect(first).toBe(second);
  });

  it('changes when a market readiness decision changes', () => {
    const ready = service.createSourceHash(
      makeContext(new Date('2026-11-11T10:01:00.000Z'), true),
      4,
      7,
    );
    const insufficient = service.createSourceHash(
      makeContext(new Date('2026-11-11T10:01:00.000Z'), false),
      4,
      7,
    );

    expect(ready).not.toBe(insufficient);
  });
});
