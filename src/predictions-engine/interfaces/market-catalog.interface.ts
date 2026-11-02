import { PredictionMarket } from '../enums/prediction-market.enum';
import { MarketFamily } from '../enums/market-family.enum';
import { MarketModel } from '../enums/market-model.enum';

export interface MarketSelectionDefinition {
  key: string;
  jsonVariable: string;
  fullName: string;
  abbreviation: string;
}

export type MarketSelectionMode =
  | 'STATIC'
  | 'OVER_UNDER'
  | 'EXACT_TOTAL'
  | 'CORRECT_SCORE'
  | 'ASIAN_HANDICAP'
  | 'EUROPEAN_HANDICAP'
  | 'BTTS_TOTAL'
  | 'POSSESSION'
  | 'PLAYER';

export interface MarketSelectionTemplate {
  /** Stable key template emitted when this market is expanded at runtime. */
  keyPatterns: string[];
  /** Stable JSON property templates emitted by runtime expansion. */
  jsonVariablePatterns: string[];
  /** Display-name templates; tokens are resolved by the selection expander. */
  fullNamePatterns: string[];
  /** Common display abbreviations for each selection pattern. */
  abbreviationPatterns: string[];
  /** Explains any condition used when a dynamic selection is emitted. */
  condition?: string;
}

export interface MarketDefinition {
  key: PredictionMarket;
  jsonVariable: string;
  fullName: string;
  abbreviation: string;
  family: MarketFamily;
  model: MarketModel;
  selectionMode: MarketSelectionMode;
  period: 'FULL_TIME' | 'FIRST_HALF' | 'SECOND_HALF';
  selections: MarketSelectionDefinition[];
  /** Present for line/player/score markets whose actual selections are expanded at runtime. */
  selectionTemplates?: MarketSelectionTemplate[];
  lines?: number[];
  notes?: string;
  entityType?: 'ATHLETE';
}

export interface ExpandedMarketSelection extends MarketSelectionDefinition {
  line?: number;
  handicap?: number;
  homeGoals?: number;
  awayGoals?: number;
  totalGoals?: number;
  lowerGoals?: number;
  upperGoals?: number | null;
  side?: 'HOME' | 'AWAY';
  subjectId?: string;
  subjectName?: string;
  subjectAbbreviation?: string;
  subjectTeamId?: string;
}
