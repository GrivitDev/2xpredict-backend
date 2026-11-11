import { createHash } from 'node:crypto';

/** Snapshot contract version persisted on each newly accepted Bet Lab ticket. */
export const BET_LAB_PRICING_SNAPSHOT_VERSION = 'BET-LAB-ODDS-SNAPSHOT-V1';

export interface BetLabOddsSnapshotLike {
  fixture?: {
    eventId?: unknown;
    fixtureDate?: unknown;
    live?: unknown;
    completed?: unknown;
    status?: unknown;
    statusDetail?: unknown;
    statusShortDetail?: unknown;
    homeTeamId?: unknown;
    awayTeamId?: unknown;
  };
  market?: { code?: unknown };
  selection?: {
    code?: unknown;
    line?: unknown;
    handicap?: unknown;
    settlementKey?: unknown;
    subjectId?: unknown;
    subjectTeamId?: unknown;
  };
  decimalOdds?: unknown;
  oddsSource?: unknown;
  priceType?: unknown;
  bookmaker?: unknown;
  providerUpdatedAt?: unknown;
  oddsTimestampBasis?: unknown;
  oddsCapturedAt?: unknown;
  oddsRecordUpdatedAt?: unknown;
  oddsFreshUntil?: unknown;
  fairOdds?: unknown;
  fairOddsBasis?: unknown;
  marketFairOdds?: unknown;
  impliedProbability?: unknown;
  fairProbability?: unknown;
  valuePercent?: unknown;
  dataQuality?: unknown;
  sampleSize?: unknown;
  calculationVersion?: unknown;
  sourceRevision?: unknown;
  fixtureSourceRevision?: unknown;
  sourceDataUpdatedAt?: unknown;
  provider?: unknown;
  isFresh?: unknown;
  oddsBasis?: unknown;
  oddsCalculationMethod?: unknown;
}

export interface BetLabTicketPricingSnapshotLeg {
  oddsSnapshotFingerprint: string;
  fixturePricingGroup?: string;
  fixturePricingAdjustment?: number;
}

function text(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return String(value).trim();
}

function number(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(8)) : null;
}

function timestamp(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(value as string | number);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Hashes the exact Odds-approved quote and the canonical selection identity.
 * The function is deliberately deterministic and does not calculate or infer
 * any price; it only fingerprints fields returned by the Odds read contract.
 */
export function createBetLabOddsSnapshotFingerprint(
  quote: BetLabOddsSnapshotLike,
): string {
  const fixture = quote.fixture ?? {};
  const market = quote.market ?? {};
  const selection = quote.selection ?? {};
  return digest({
    version: BET_LAB_PRICING_SNAPSHOT_VERSION,
    fixture: {
      eventId: text(fixture.eventId),
      fixtureDate: timestamp(fixture.fixtureDate),
      live: fixture.live === true,
      completed: fixture.completed === true,
      status: text(fixture.status),
      statusDetail: text(fixture.statusDetail),
      statusShortDetail: text(fixture.statusShortDetail),
      homeTeamId: text(fixture.homeTeamId),
      awayTeamId: text(fixture.awayTeamId),
    },
    market: { code: text(market.code) },
    selection: {
      code: text(selection.code),
      line: number(selection.line),
      handicap: number(selection.handicap),
      settlementKey: text(selection.settlementKey),
      subjectId: text(selection.subjectId),
      subjectTeamId: text(selection.subjectTeamId),
    },
    odds: {
      decimalOdds: number(quote.decimalOdds),
      oddsSource: text(quote.oddsSource),
      priceType: text(quote.priceType),
      bookmaker: text(quote.bookmaker),
      providerUpdatedAt: timestamp(quote.providerUpdatedAt),
      oddsTimestampBasis: text(quote.oddsTimestampBasis),
      oddsCapturedAt: timestamp(quote.oddsCapturedAt),
      oddsRecordUpdatedAt: timestamp(quote.oddsRecordUpdatedAt),
      oddsFreshUntil: timestamp(quote.oddsFreshUntil),
      fairOdds: number(quote.fairOdds),
      fairOddsBasis: text(quote.fairOddsBasis),
      marketFairOdds: number(quote.marketFairOdds),
      impliedProbability: number(quote.impliedProbability),
      fairProbability: number(quote.fairProbability),
      valuePercent: number(quote.valuePercent),
      dataQuality: number(quote.dataQuality),
      sampleSize: number(quote.sampleSize),
      calculationVersion: text(quote.calculationVersion),
      sourceRevision: number(quote.sourceRevision),
      fixtureSourceRevision: number(quote.fixtureSourceRevision),
      sourceDataUpdatedAt: timestamp(quote.sourceDataUpdatedAt),
      provider: text(quote.provider),
      isFresh: quote.isFresh === true,
      oddsBasis: text(quote.oddsBasis),
      oddsCalculationMethod: text(quote.oddsCalculationMethod),
    },
  });
}

export function areBetLabOddsSnapshotsIdentical(
  original: BetLabOddsSnapshotLike,
  current: BetLabOddsSnapshotLike,
): boolean {
  return createBetLabOddsSnapshotFingerprint(original)
    === createBetLabOddsSnapshotFingerprint(current);
}

/** Ticket-level commitment over the ordered accepted legs and their joint pricing adjustments. */
export function createBetLabTicketPricingSnapshotFingerprint(input: {
  ticketType: string;
  combinedOdds: number;
  legs: readonly BetLabTicketPricingSnapshotLeg[];
}): string {
  return digest({
    version: BET_LAB_PRICING_SNAPSHOT_VERSION,
    ticketType: text(input.ticketType),
    combinedOdds: number(input.combinedOdds),
    legs: input.legs.map((leg) => ({
      oddsSnapshotFingerprint: text(leg.oddsSnapshotFingerprint),
      fixturePricingGroup: text(leg.fixturePricingGroup),
      fixturePricingAdjustment: number(leg.fixturePricingAdjustment),
    })),
  });
}
