import { ExpandedMarketSelection } from './market-catalog.interface';
import { PredictionSource } from '../enums/prediction-source.enum';

export interface SelectionModelOutput {
  selection: ExpandedMarketSelection;
  probability: number | null;
  status: 'CALCULATED' | 'UNAVAILABLE';
  source: PredictionSource[];
  method: string;
  diagnostics: string[];
  settlementProfile?: {
    fullWin?: number;
    halfWin?: number;
    push?: number;
    halfLoss?: number;
    fullLoss?: number;
  };
  dataQuality: number;
}

export interface MarketEngineOutput {
  handled: boolean;
  selections: SelectionModelOutput[];
  calculationMethod: string;
  dataQuality: number;
  unavailableReason?: string;
  diagnostics: string[];
}
