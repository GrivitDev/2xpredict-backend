import { PredictionMarket } from '../enums/prediction-market.enum';
import { PredictionStatus } from '../enums/prediction-status.enum';
import { PredictionSource } from '../enums/prediction-source.enum';

export interface SelectionPredictionResult {
  key: string;
  jsonVariable: string;
  fullName: string;
  abbreviation: string;
  line?: number;
  handicap?: number;
  subjectId?: string;
  subjectName?: string;
  probability: number | null;
  /** Probability before historical post-model calibration; retained to prevent recursive fitting. */
  rawProbability?: number | null;
  probabilityPercent: number | null;
  fairOdds: number | null;
  /** Expected return per unit staked using a fresh provider price; decimal fraction (0.05 = +5%). */
  expectedValue?: number | null;
  /** Rounded expected return in percentage points. */
  expectedValuePercent?: number | null;
  dataQuality?: number;
  /** Reliability of the market-specific calibration model used for this outcome. */
  calibrationReliability?: number;
  /** Number of settled final selections used to assess this market calibration. */
  calibrationSampleSize?: number;
  /** Whether an active market calibration was applied to the raw probability. */
  calibrationApplied?: boolean;
  /** Conservative selection safety score from 0 to 1; distinct from probability. */
  safetyScore?: number;
  /** Odds module explicitly endorses this exact selection and line. */
  oddsPredictionReady?: boolean;
  /** Exactly one Odds-ready calculated selection is final for each market document. */
  isFinalSelection?: boolean;
  /** Backward-compatible flag: true only for the market engine's final selection. */
  recommendationEligible?: boolean;
  bookmakerOdds?: number | null;
  decimalOdds?: number | null;
  priceType?: 'PROVIDER' | 'ESTIMATED';
  oddsUpdatedAt?: Date | null;
  oddsBasis?:
    | 'BOOKMAKER_ONLY'
    | 'BOOKMAKER_PLUS_HISTORY'
    | 'HISTORICAL_ONLY'
    | 'PRIOR_ONLY'
    | null;
  oddsCalculationMethod?: string | null;
  oddsProvider?: 'THE_ODDS_API' | 'ESPN' | null;
  bookmaker?: string | null;
  confidence: number | null;
  evidenceConfidence?: number | null;
  status: PredictionStatus;
  sources: PredictionSource[];
  calculationMethod?: string;
  settlementProfile?: {
    fullWin?: number;
    halfWin?: number;
    push?: number;
    halfLoss?: number;
    fullLoss?: number;
  };
  diagnostics?: string[];
}

export interface MarketPredictionCalculationResult {
  marketKey: PredictionMarket;
  marketName: string;
  marketAbbreviation: string;
  family: string;
  period: string;
  model: string;
  status: PredictionStatus;
  selections: SelectionPredictionResult[];
  sources: PredictionSource[];
  calculationMethod: string;
  unavailableReason?: string;
  diagnostics: string[];
  dataQuality: number;
}

