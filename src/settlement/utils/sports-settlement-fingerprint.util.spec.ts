import { createSettlementSourceFingerprint } from './sports-settlement-fingerprint.util';

const makeMatch = () => ({
  fixture: {
    id: 'fixture-100',
    competitionId: 'league-1',
    seasonId: 'season-1',
    kickoffAt: new Date('2026-11-07T15:00:00.000Z'),
    status: { state: 'COMPLETED', isFinal: true },
    competitors: [
      {
        teamId: 'home',
        homeAway: 'HOME',
        score: 2,
        statistics: [
          { key: 'shots', value: 10 },
          { key: 'shotsOnTarget', value: 5 },
        ],
      },
      {
        teamId: 'away',
        homeAway: 'AWAY',
        score: 1,
        statistics: [{ key: 'shots', value: 8 }],
      },
    ],
    periodScores: [
      { teamId: 'home', period: 1, score: 1 },
      { teamId: 'away', period: 1, score: 0 },
    ],
    source: {
      provider: 'ESPN',
      endpoint: 'summary',
      providerId: 'fixture-100',
      collectedAt: new Date('2026-11-07T18:00:00.000Z'),
    },
  },
  timeline: [
    {
      id: 'goal-1',
      sequence: 1,
      period: 1,
      type: 'GOAL',
      teamId: 'home',
      homeScore: 1,
      awayScore: 0,
      source: { provider: 'ESPN', endpoint: 'plays' },
    },
  ],
});

describe('createSettlementSourceFingerprint', () => {
  it('creates a deterministic SHA-256 fingerprint', () => {
    const fingerprint = createSettlementSourceFingerprint(makeMatch());
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(createSettlementSourceFingerprint(makeMatch())).toBe(fingerprint);
  });

  it('does not change when unordered embedded statistics are reordered', () => {
    const first = makeMatch();
    const second = makeMatch();
    second.fixture.competitors[0].statistics.reverse();
    expect(createSettlementSourceFingerprint(second)).toBe(
      createSettlementSourceFingerprint(first),
    );
  });

  it('changes when authoritative scores or timeline facts change', () => {
    const original = makeMatch();
    const scoreChanged = makeMatch();
    scoreChanged.fixture.competitors[0].score = 3;
    const timelineChanged = makeMatch();
    timelineChanged.timeline[0].homeScore = 2;

    expect(createSettlementSourceFingerprint(scoreChanged)).not.toBe(
      createSettlementSourceFingerprint(original),
    );
    expect(createSettlementSourceFingerprint(timelineChanged)).not.toBe(
      createSettlementSourceFingerprint(original),
    );
  });

  it('changes when normalized Summary facts or their revision changes', () => {
    const first = makeMatch() as any;
    const second = makeMatch() as any;
    first.matchFacts = { sourcePayloadHash: 'summary-a', normalizationHash: 'facts-a', revision: 1 };
    second.matchFacts = { sourcePayloadHash: 'summary-b', normalizationHash: 'facts-b', revision: 2 };
    expect(createSettlementSourceFingerprint(first)).not.toBe(createSettlementSourceFingerprint(second));
  });

  it('intentionally excludes odds-only changes', () => {
    const first = makeMatch() as any;
    const second = makeMatch() as any;
    first.odds = { market: 'MATCH_RESULT', home: 2.1 };
    second.odds = { market: 'MATCH_RESULT', home: 1.8 };
    expect(createSettlementSourceFingerprint(first)).toBe(
      createSettlementSourceFingerprint(second),
    );
  });
});

