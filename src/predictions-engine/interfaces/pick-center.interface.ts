export interface PickCenterSelection {
  marketPredictionId: string;
  marketKey: string;
  marketName: string;
  marketAbbreviation: string;
  selectionKey: string;
  selectionName: string;
  selectionAbbreviation: string;
  line?: number;
  subjectId?: string;
  subjectName?: string;
  probability: number;
  probabilityPercent: number;
  fairOdds: number;
  confidence: number;
  evidenceConfidence?: number;
  rankingScore: number;
  rank?: number;
  decimalOdds?: number;
  bookmakerOdds?: number;
  priceType?: 'PROVIDER' | 'ESTIMATED';
  oddsUpdatedAt?: Date;
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
  calibrationReliability?: number;
  calibrationSampleSize?: number;
  safetyScore?: number;
  valueRatio?: number;
  marketPriority?: number;
  modelVersion?: string;
  settlementProfile?: {
    fullWin?: number;
    halfWin?: number;
    push?: number;
    halfLoss?: number;
    fullLoss?: number;
  };
  isMatchResult: boolean;
  reasons: string[];
}

export interface PickCenterUpdateResult {
  eventId: string;
  selectedCount: number;
  eligibleCount: number;
  status: string;
}

