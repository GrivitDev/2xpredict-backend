import { BetLabMarketCategory } from '../enums/bet-lab-market-category.enum';
import { BetLabMarketCode } from '../enums/bet-lab-market-code.enum';
import { FOOTBALL_MARKET_CATALOG as CANONICAL_MARKETS, canonicalLineSlug, expandCanonicalSelections } from '../../odds/catalog/football-market-catalog';
import type { CanonicalMarketDefinition, CanonicalPeriod, CanonicalSelectionMode } from '../../odds/catalog/football-market-catalog';

export type BetLabPeriod = CanonicalPeriod;
export type BetLabSelectionMode = CanonicalSelectionMode;

export interface BetLabSelectionDefinition {
  code: string;
  jsonVariable: string;
  fullName: string;
  abbreviation: string;
  settlementKey: string;
  line?: number;
  handicap?: number;
  homeGoals?: number;
  awayGoals?: number;
  subjectId?: string;
  subjectName?: string;
  subjectAbbreviation?: string;
  subjectTeamId?: string;
}

export interface BetLabMarketDefinition {
  code: BetLabMarketCode;
  jsonVariable: string;
  fullName: string;
  abbreviation: string;
  category: BetLabMarketCategory;
  period: BetLabPeriod;
  selectionMode: BetLabSelectionMode;
  selections: BetLabSelectionDefinition[];
  lines?: number[];
  notes?: string;
  pricingEnabled?: boolean;
}

export interface BetLabMarketExpansionContext {
  homeTeamName: string;
  awayTeamName: string;
  players?: Array<{
    id: string;
    name: string;
    abbreviation: string;
    teamId?: string;
  }>;
}

function categoryFor(market: CanonicalMarketDefinition): BetLabMarketCategory {
  if (market.id.includes('CORNERS')) return BetLabMarketCategory.CORNERS;
  if (market.id.includes('CARD')) return BetLabMarketCategory.CARDS;
  if (market.family === 'PLAYER') return BetLabMarketCategory.PLAYER;

  switch (market.family) {
    case 'RESULT':
      return BetLabMarketCategory.MATCH_RESULT;
    case 'GOALS':
      return BetLabMarketCategory.GOALS;
    case 'PERIOD':
      return BetLabMarketCategory.HALF_TIME;
    case 'HANDICAP':
      return BetLabMarketCategory.HANDICAP;
    case 'EVENTS':
      return BetLabMarketCategory.SPECIALS;
    case 'STATISTICS':
    default:
      return BetLabMarketCategory.STATISTICS;
  }
}

export const BET_LAB_MARKET_CATALOG: BetLabMarketDefinition[] =
  CANONICAL_MARKETS.map((market) => ({
    code: market.betLabMarketCode as BetLabMarketCode,
    jsonVariable: market.jsonVariable,
    fullName: market.fullName,
    abbreviation: market.abbreviation,
    category: categoryFor(market),
    period: market.period,
    selectionMode: market.selectionMode,
    selections: market.selections.map((selection) => ({
      ...selection,
      code: selection.key,
    })),
    lines: market.lines ? [...market.lines] : undefined,
    notes: market.notes,
    pricingEnabled: market.pricingEnabled !== false,
  }));

// BetLab exposes a derived read-only catalogue; it cannot add or mutate markets.
for (const market of BET_LAB_MARKET_CATALOG) {
  for (const selection of market.selections) Object.freeze(selection);
  Object.freeze(market.selections);
  if (market.lines) Object.freeze(market.lines);
  Object.freeze(market);
}
Object.freeze(BET_LAB_MARKET_CATALOG);

function createReadonlyMap<K, V>(
  entries: Iterable<readonly [K, V]>,
): ReadonlyMap<K, V> {
  const source = new Map<K, V>(entries);
  const view: ReadonlyMap<K, V> = {
    get size() {
      return source.size;
    },
    get(key: K) {
      return source.get(key);
    },
    has(key: K) {
      return source.has(key);
    },
    entries(): MapIterator<[K, V]> {
      return source.entries();
    },
    keys(): MapIterator<K> {
      return source.keys();
    },
    values(): MapIterator<V> {
      return source.values();
    },
    forEach(callback, thisArg) {
      source.forEach((value, key) => {
        callback.call(thisArg, value, key, view);
      });
    },
    [Symbol.iterator](): MapIterator<[K, V]> {
      return source[Symbol.iterator]();
    },
  };
  return Object.freeze(view);
}

export const BET_LAB_MARKET_BY_CODE: ReadonlyMap<
  BetLabMarketCode,
  BetLabMarketDefinition
> = createReadonlyMap(
  BET_LAB_MARKET_CATALOG.map((market) => [market.code, market] as const),
);

/** Active API market allow-list derived exclusively from the Odds catalogue. */
export const BET_LAB_ACTIVE_MARKET_CODES: readonly string[] = Object.freeze(
  BET_LAB_MARKET_CATALOG.filter((market) => market.pricingEnabled !== false).map((market) => String(market.code)),
);

export function formatLine(line: number): string {
  const normalized = Math.round(line * 100) / 100;
  return String(normalized);
}

export function lineSlug(line: number): string {
  return canonicalLineSlug(line);
}

export function overUnderSelectionCode(
  side: 'OVER' | 'UNDER',
  line: number,
): string {
  return `${side}_${lineSlug(line)}`;
}

export function handicapSelectionCode(
  side: 'HOME' | 'AWAY',
  line: number,
): string {
  return `${side}_${lineSlug(line)}`;
}

export function expandMarketSelections(
  market: BetLabMarketDefinition,
  context: BetLabMarketExpansionContext,
): BetLabSelectionDefinition[] {
  const definition = CANONICAL_MARKETS.find(
    (item) => String(item.betLabMarketCode) === String(market.code),
  );
  if (!definition) return [];
  return expandCanonicalSelections(
    definition,
    context.homeTeamName,
    context.awayTeamName,
  ).map((selection) => ({
    code: selection.key,
    jsonVariable: selection.jsonVariable,
    fullName: selection.fullName,
    abbreviation: selection.abbreviation,
    settlementKey: selection.settlementKey,
    ...(selection.line !== undefined ? { line: selection.line } : {}),
    ...(selection.handicap !== undefined
      ? { handicap: selection.handicap }
      : {}),
  }));
}

export function assertBetLabCatalogValid(): void {
  const seenMarkets = new Set<string>();
  for (const market of BET_LAB_MARKET_CATALOG) {
    if (seenMarkets.has(market.code))
      throw new Error(`Duplicate Bet Lab market code: ${market.code}`);
    seenMarkets.add(market.code);
    const selectionKeys = new Set<string>();
    for (const selection of expandMarketSelections(market, {
      homeTeamName: 'Home',
      awayTeamName: 'Away',
    })) {
      if (!selection.code.trim() || !selection.settlementKey.trim()) {
        throw new Error(`Market ${market.code} has an incomplete selection.`);
      }
      if (selectionKeys.has(selection.code))
        throw new Error(
          `Duplicate selection ${selection.code} in ${market.code}`,
        );
      selectionKeys.add(selection.code);
    }
  }
  if (BET_LAB_MARKET_CATALOG.length !== CANONICAL_MARKETS.length) {
    throw new Error(
      `Bet Lab market catalogue is out of sync with the canonical Odds catalogue (${BET_LAB_MARKET_CATALOG.length}/${CANONICAL_MARKETS.length}).`,
    );
  }
}

assertBetLabCatalogValid();

