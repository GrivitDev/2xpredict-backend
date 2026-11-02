import { BetLabMarketCategory } from '../enums/bet-lab-market-category.enum';
import { BetLabMarketCode } from '../enums/bet-lab-market-code.enum';
import {
  CanonicalMarketDefinition,
  FOOTBALL_MARKET_CATALOG as CANONICAL_MARKETS,
  canonicalLineSlug,
  expandCanonicalSelections,
} from '../../odds/catalog/football-market-catalog';

export type BetLabPeriod = 'FULL_TIME' | 'FIRST_HALF' | 'SECOND_HALF' | 'MATCH';
export type BetLabSelectionMode =
  | 'STATIC'
  | 'OVER_UNDER'
  | 'ASIAN_HANDICAP'
  | 'EUROPEAN_HANDICAP'
  | 'CORRECT_SCORE'
  | 'HALF_TIME_CORRECT_SCORE'
  | 'PLAYER_ANYTIME'
  | 'PLAYER_FIRST_SCORER'
  | 'PLAYER_BOOKING'
  | 'PLAYER_SENDING_OFF'
  | 'PLAYER_SHOTS'
  | 'PLAYER_SHOTS_ON_TARGET'
  | 'PLAYER_ASSIST';

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
}

export interface BetLabMarketExpansionContext {
  homeTeamName: string;
  awayTeamName: string;
  players?: Array<{ id: string; name: string; abbreviation: string; teamId?: string }>;
}

function categoryFor(market: CanonicalMarketDefinition): BetLabMarketCategory {
  if (market.id === 'TOTAL_CORNERS_OVER_UNDER') return BetLabMarketCategory.CORNERS;
  if (market.id === 'TOTAL_CARDS_OVER_UNDER') return BetLabMarketCategory.CARDS;
  switch (market.family) {
    case 'RESULT': return BetLabMarketCategory.MATCH_RESULT;
    case 'GOALS': return BetLabMarketCategory.GOALS;
    case 'PERIOD': return BetLabMarketCategory.HALF_TIME;
    case 'HANDICAP': return BetLabMarketCategory.HANDICAP;
    default: return BetLabMarketCategory.STATISTICS;
  }
}

export const BET_LAB_MARKET_CATALOG: BetLabMarketDefinition[] = CANONICAL_MARKETS.map((market) => ({
  code: market.betLabMarketCode as BetLabMarketCode,
  jsonVariable: market.jsonVariable,
  fullName: market.fullName,
  abbreviation: market.abbreviation,
  category: categoryFor(market),
  period: market.period,
  selectionMode: market.selectionMode,
  selections: market.selections.map((selection) => ({ ...selection, code: selection.key })),
  lines: market.lines ? [...market.lines] : undefined,
  notes: market.notes,
}));

export const BET_LAB_MARKET_BY_CODE = new Map<BetLabMarketCode, BetLabMarketDefinition>(
  BET_LAB_MARKET_CATALOG.map((market) => [market.code, market]),
);

export function formatLine(line: number): string {
  const normalized = Math.round(line * 100) / 100;
  return String(normalized);
}

export function lineSlug(line: number): string {
  return canonicalLineSlug(line);
}

export function overUnderSelectionCode(side: 'OVER' | 'UNDER', line: number): string {
  return `${side}_${lineSlug(line)}`;
}

export function handicapSelectionCode(side: 'HOME' | 'AWAY', line: number): string {
  return `${side}_${lineSlug(line)}`;
}

export function expandMarketSelections(
  market: BetLabMarketDefinition,
  context: BetLabMarketExpansionContext,
): BetLabSelectionDefinition[] {
  const definition = CANONICAL_MARKETS.find((item) => item.betLabMarketCode === market.code);
  if (!definition) return [];
  return expandCanonicalSelections(definition, context.homeTeamName, context.awayTeamName).map((selection) => ({
    code: selection.key,
    jsonVariable: selection.jsonVariable,
    fullName: selection.fullName,
    abbreviation: selection.abbreviation,
    settlementKey: selection.settlementKey,
    ...(selection.line !== undefined ? { line: selection.line } : {}),
    ...(selection.handicap !== undefined ? { handicap: selection.handicap } : {}),
  }));
}

export function assertBetLabCatalogValid(): void {
  const seenMarkets = new Set<string>();
  for (const market of BET_LAB_MARKET_CATALOG) {
    if (seenMarkets.has(market.code)) throw new Error(`Duplicate Bet Lab market code: ${market.code}`);
    seenMarkets.add(market.code);
    const selectionKeys = new Set<string>();
    for (const selection of expandMarketSelections(market, { homeTeamName: 'Home', awayTeamName: 'Away' })) {
      if (!selection.code.trim() || !selection.settlementKey.trim()) {
        throw new Error(`Market ${market.code} has an incomplete selection.`);
      }
      if (selectionKeys.has(selection.code)) throw new Error(`Duplicate selection ${selection.code} in ${market.code}`);
      selectionKeys.add(selection.code);
    }
  }
  if (BET_LAB_MARKET_CATALOG.length !== 16) {
    throw new Error(`Expected 16 Bet Lab market groups, found ${BET_LAB_MARKET_CATALOG.length}.`);
  }
}

assertBetLabCatalogValid();
