import {
  areBetLabOddsSnapshotsIdentical,
  BET_LAB_PRICING_SNAPSHOT_VERSION,
  createBetLabOddsSnapshotFingerprint,
  createBetLabTicketPricingSnapshotFingerprint,
} from './bet-lab-pricing-snapshot.util';

const quote = () => ({
  fixture: {
    eventId: 'fixture-1',
    fixtureDate: new Date('2026-11-12T16:00:00.000Z'),
    live: false,
    completed: false,
    status: 'SCHEDULED',
    homeTeamId: 'team-home',
    awayTeamId: 'team-away',
  },
  market: { code: 'TOTAL_GOALS_OVER_UNDER' },
  selection: {
    code: 'OVER_2_5',
    line: 2.5,
    settlementKey: 'OVER_2_5',
  },
  decimalOdds: 1.91,
  oddsSource: 'ESTIMATED',
  priceType: 'ESTIMATED',
  bookmaker: null,
  providerUpdatedAt: null,
  oddsTimestampBasis: 'MODEL_GENERATED',
  oddsCapturedAt: new Date('2026-11-11T10:00:00.000Z'),
  oddsRecordUpdatedAt: new Date('2026-11-11T10:00:01.000Z'),
  oddsFreshUntil: new Date('2026-11-11T12:00:00.000Z'),
  fairOdds: 1.82,
  fairOddsBasis: 'MODEL',
  marketFairOdds: 1.82,
  impliedProbability: 1 / 1.91,
  fairProbability: 0.55,
  valuePercent: 4.5,
  dataQuality: 0.78,
  sampleSize: 24,
  calculationVersion: 'GRIVIT-4.1.0',
  sourceRevision: 12,
  fixtureSourceRevision: 8,
  sourceDataUpdatedAt: new Date('2026-11-11T09:59:00.000Z'),
  provider: null,
  isFresh: true,
  oddsBasis: 'HISTORICAL_ONLY',
  oddsCalculationMethod: 'HISTORICAL_GOALS_MODEL',
});

describe('Bet Lab immutable pricing snapshots', () => {
  it('creates a deterministic SHA-256 quote fingerprint', () => {
    const first = quote();
    const second = quote();
    expect(createBetLabOddsSnapshotFingerprint(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(areBetLabOddsSnapshotsIdentical(first, second)).toBe(true);
  });

  it.each([
    ['decimal odds', { decimalOdds: 1.92 }],
    ['fair probability', { fairProbability: 0.56 }],
    ['price basis', { oddsBasis: 'BOOKMAKER_PLUS_HISTORY' }],
    ['calculation method', { oddsCalculationMethod: 'DIFFERENT_MODEL' }],
    ['Odds source revision', { sourceRevision: 13 }],
    ['Sports fixture revision', { fixtureSourceRevision: 9 }],
    ['source data timestamp', { sourceDataUpdatedAt: new Date('2026-11-11T10:01:00.000Z') }],
    ['Odds row update timestamp', { oddsRecordUpdatedAt: new Date('2026-11-11T10:00:02.000Z') }],
    ['line', { selection: { code: 'OVER_3_5', line: 3.5, settlementKey: 'OVER_3_5' } }],
    ['fixture kickoff', { fixture: { ...quote().fixture, fixtureDate: new Date('2026-11-12T17:00:00.000Z') } }],
    ['freshness state', { isFresh: false }],
  ] as Array<[string, Partial<ReturnType<typeof quote>>]>)('rejects a changed %s snapshot', (_label, override) => {
    const original = quote();
    const current = { ...original, ...override };
    expect(areBetLabOddsSnapshotsIdentical(original, current)).toBe(false);
  });

  it('commits the ordered ticket legs, accepted odds and correlation adjustment in one fingerprint', () => {
    const fingerprint = createBetLabOddsSnapshotFingerprint(quote());
    const base = {
      ticketType: 'ACCUMULATOR',
      combinedOdds: 2.31,
      legs: [{ oddsSnapshotFingerprint: fingerprint, fixturePricingGroup: 'MATCH', fixturePricingAdjustment: 0.91 }],
    };
    expect(createBetLabTicketPricingSnapshotFingerprint(base)).toMatch(/^[a-f0-9]{64}$/);
    expect(createBetLabTicketPricingSnapshotFingerprint(base)).toBe(createBetLabTicketPricingSnapshotFingerprint(base));
    expect(createBetLabTicketPricingSnapshotFingerprint({ ...base, combinedOdds: 2.32 })).not.toBe(createBetLabTicketPricingSnapshotFingerprint(base));
    expect(BET_LAB_PRICING_SNAPSHOT_VERSION).toBe('BET-LAB-ODDS-SNAPSHOT-V1');
  });
});
