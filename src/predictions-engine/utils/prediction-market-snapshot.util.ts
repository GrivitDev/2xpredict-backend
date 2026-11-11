import type { StoredFixtureOdds } from '../interfaces/prediction-match-context.interface';

export interface ExistingMarketSelectionSnapshot {
  key?: unknown;
  line?: unknown;
  status?: unknown;
  isFinalSelection?: unknown;
  recommendationEligible?: unknown;
  oddsPredictionReady?: unknown;
  priceType?: unknown;
  decimalOdds?: unknown;
  oddsUpdatedAt?: unknown;
  actualOutcome?: unknown;
}

export interface ExistingMarketPredictionSnapshot {
  status?: unknown;
  fixtureSourceRevision?: unknown;
  selections?: ExistingMarketSelectionSnapshot[];
}

function toTimestamp(value: unknown): number | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sameOptionalNumber(left: unknown, right: unknown): boolean {
  const leftMissing = left === undefined || left === null || left === '';
  const rightMissing = right === undefined || right === null || right === '';
  if (leftMissing || rightMissing) return leftMissing && rightMissing;
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.000001;
}

/**
 * A prior final selection may be retained only when it still belongs to the
 * current Sports revision and its exact Odds quote (including line, price and
 * update timestamp) is still present and prediction-ready. This prevents an
 * unavailable partial recalculation from erasing a sound current market, while
 * also preventing stale Sports/Odds snapshots from leaking into Pick Center.
 */
export function hasReusableFinalMarketSnapshot(
  existing: ExistingMarketPredictionSnapshot | undefined,
  marketId: string,
  fixtureSourceRevision: number,
  currentOdds: StoredFixtureOdds[] = [],
): boolean {
  if (!existing || existing.status !== 'CALCULATED') return false;
  const revision = Number(existing.fixtureSourceRevision);
  if (!Number.isSafeInteger(revision) || revision !== fixtureSourceRevision) return false;

  const finalSelections = (existing.selections ?? []).filter((selection) =>
    selection?.status === 'CALCULATED'
    && selection.isFinalSelection === true
    && selection.recommendationEligible === true
    && selection.oddsPredictionReady === true
    && (selection.priceType === 'PROVIDER' || selection.priceType === 'ESTIMATED')
    && (selection.actualOutcome === undefined || selection.actualOutcome === null),
  );
  if (finalSelections.length !== 1) return false;

  const selection = finalSelections[0];
  const selectionKey = String(selection.key ?? '').trim();
  const selectionOddsUpdatedAt = toTimestamp(selection.oddsUpdatedAt);
  const selectionOdds = Number(selection.decimalOdds);
  if (!selectionKey || selectionOddsUpdatedAt === null || !Number.isFinite(selectionOdds)) return false;

  return currentOdds.some((quote) => {
    if (quote.marketId !== marketId || quote.selectionKey !== selectionKey) return false;
    if (quote.predictionReady !== true || quote.isFresh !== true) return false;
    if (quote.priceType !== 'PROVIDER' && quote.priceType !== 'ESTIMATED') return false;
    if (!sameOptionalNumber(selection.line, quote.line)) return false;
    const quoteUpdatedAt = toTimestamp(quote.updatedAt);
    const quoteOdds = Number(quote.decimalOdds);
    return quoteUpdatedAt === selectionOddsUpdatedAt
      && Number.isFinite(quoteOdds)
      && Math.abs(quoteOdds - selectionOdds) < 0.000001;
  });
}
