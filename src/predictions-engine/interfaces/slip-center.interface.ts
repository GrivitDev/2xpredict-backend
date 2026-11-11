import { SlipProductType } from '../enums/slip-product-type.enum';

export interface SlipLegInput {
  eventId: string;
  homeTeamName: string;
  awayTeamName: string;
  fixtureDate: Date;
  /** Sports season-relative expiry for this fixture leg. */
  retentionExpiresAt?: Date | null;
  marketPredictionId: string;
  marketKey: string;
  marketName: string;
  selectionKey: string;
  selectionName: string;
  probability: number;
  confidence: number;
  fairOdds: number;
  /** Shared stored decimal price used to calculate a slip's combined odds. */
  decimalOdds: number;
  priceType: 'PROVIDER' | 'ESTIMATED';
  /** True only when Odds-module readiness was confirmed for this exact selection and line. */
  oddsPredictionReady?: boolean;
  oddsUpdatedAt?: Date | null;
  oddsBasis?:
    | 'BOOKMAKER_ONLY'
    | 'BOOKMAKER_PLUS_HISTORY'
    | 'HISTORICAL_ONLY'
    | 'PRIOR_ONLY';
  oddsCalculationMethod?: string;
  oddsProvider?: 'THE_ODDS_API' | 'ESPN';
  bookmaker?: string;
  expectedValue?: number;
  expectedValuePercent?: number;
  dataQuality?: number;
  modelVersion?: string;
  settlementProfile?: {
    fullWin?: number;
    halfWin?: number;
    push?: number;
    halfLoss?: number;
    fullLoss?: number;
  };
  /** Only populated when decimalOdds is an observed provider quote. */
  bookmakerOdds?: number;
}

export interface SlipBuildRequest {
  eventIds?: string[];
  name?: string;
  selectionCount?: number;
  minimumProbability?: number;
  minimumConfidence?: number;
  fixtureFrom?: Date;
  fixtureTo?: Date;
  createdBy?: string;
  publish?: boolean;
  productType?: SlipProductType;
  sureOddsTier?: 'VIP' | 'PREMIUM';
  sureOddsProduct?: 'SURE_2' | 'SURE_5' | 'SURE_7';
}


