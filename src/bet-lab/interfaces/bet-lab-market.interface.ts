import { BetLabMarketCategory } from '../enums/bet-lab-market-category.enum';
import { BetLabMarketCode } from '../enums/bet-lab-market-code.enum';
import { BetLabOddsSource } from '../enums/bet-lab-odds-source.enum';
import type {
  BetLabOddsTimestampBasis,
  BetLabPriceType,
} from '../enums/bet-lab-odds-source.enum';
import { BetLabSelectionDefinition } from '../catalog/bet-lab-market-catalog';

export interface BetLabFixtureIdentity {
  eventId: string;
  leagueId: string;
  leagueName: string;
  fixtureDate: Date;
  live: boolean;
  completed: boolean;
  homeTeamId: string;
  homeTeamName: string;
  awayTeamId: string;
  awayTeamName: string;
  venueName?: string;
  status: string;
  statusDetail?: string;
  statusShortDetail?: string;
  collectedAt: Date;
  summaryCollectedAt: Date;
  payload: Record<string, unknown>;
}

export interface BetLabSelectionQuote extends BetLabSelectionDefinition {
  available: boolean;
  decimalOdds: number | null;
  /** Exact source of the virtual-play odds snapshot. */
  oddsSource: BetLabOddsSource | null;
  /** PROVIDER quotes come from the Odds module; ESTIMATED quotes are model-derived virtual prices. */
  priceType: BetLabPriceType | null;
  bookmaker: string | null;
  providerUpdatedAt: Date | null;
  oddsTimestampBasis: BetLabOddsTimestampBasis | null;
  oddsCapturedAt: Date | null;
  oddsFreshUntil?: Date | null;
  oddsBasis: 'BOOKMAKER_ONLY' | 'BOOKMAKER_PLUS_HISTORY' | 'HISTORICAL_ONLY' | 'PRIOR_ONLY' | null;
  oddsCalculationMethod: string | null;
  isStale: boolean;
  unavailableReason?: string;
}

export interface BetLabMarketWithQuotes {
  code: BetLabMarketCode;
  jsonVariable: string;
  fullName: string;
  abbreviation: string;
  category: BetLabMarketCategory;
  period: string;
  available: boolean;
  availableSelectionCount: number;
  selections: BetLabSelectionQuote[];
  notes?: string;
}

export interface BetLabSelectionRequest {
  eventId: string;
  marketCode: BetLabMarketCode;
  selectionCode: string;
}

export interface BetLabMarketQuote {
  fixture: BetLabFixtureIdentity;
  market: {
    code: BetLabMarketCode;
    jsonVariable: string;
    fullName: string;
    abbreviation: string;
  };
  selection: BetLabSelectionDefinition;
  decimalOdds: number;
  oddsSource: BetLabOddsSource;
  priceType: BetLabPriceType;
  bookmaker: string | null;
  providerUpdatedAt: Date | null;
  oddsTimestampBasis: BetLabOddsTimestampBasis;
  oddsCapturedAt: Date;
  oddsBasis: 'BOOKMAKER_ONLY' | 'BOOKMAKER_PLUS_HISTORY' | 'HISTORICAL_ONLY' | 'PRIOR_ONLY' | null;
  oddsCalculationMethod: string | null;
}

