import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { PredictionMarket } from '../enums/prediction-market.enum';
import { MarketFamily } from '../enums/market-family.enum';
import { PredictionSource } from '../enums/prediction-source.enum';
import { PredictionStatus } from '../enums/prediction-status.enum';

type PersistedSettlementOutcome =
  | 'WON'
  | 'LOST'
  | 'VOID'
  | 'PUSH'
  | 'HALF_WON'
  | 'HALF_LOST';

const PERSISTED_SETTLEMENT_OUTCOMES: PersistedSettlementOutcome[] = [
  'WON',
  'LOST',
  'VOID',
  'PUSH',
  'HALF_WON',
  'HALF_LOST',
];

@Schema({ _id: false })
export class MarketSelectionPrediction {
  @Prop({ required: true, trim: true })
  key!: string;

  @Prop({ required: true, trim: true })
  jsonVariable!: string;

  @Prop({ required: true, trim: true })
  fullName!: string;

  @Prop({ required: true, trim: true })
  abbreviation!: string;

  @Prop({ type: Number })
  line?: number;

  @Prop({ type: Number })
  handicap?: number;

  @Prop({ type: String })
  subjectId?: string;

  @Prop({ type: String })
  subjectName?: string;

  @Prop({ type: String })
  subjectTeamId?: string;

  @Prop({ type: Number, min: 0 })
  homeGoals?: number;

  @Prop({ type: Number, min: 0 })
  awayGoals?: number;

  @Prop({ type: String, trim: true })
  settlementKey?: string;

  /** Probability as a fraction in [0, 1]. */
  @Prop({ type: Number, min: 0, max: 1, default: null })
  probability!: number | null;

  /** Probability before historical post-model calibration; source for future calibration fitting. */
  @Prop({ type: Number, min: 0, max: 1, default: null })
  rawProbability?: number | null;

  /** Convenience presentation value in [0, 100]. */
  @Prop({ type: Number, min: 0, max: 100, default: null })
  probabilityPercent!: number | null;

  /** Model fair decimal odds; not a bookmaker price. */
  @Prop({ type: Number, min: 1, default: null })
  fairOdds!: number | null;

  /** Optional observed ESPN bookmaker price when its market mapping is unambiguous. */
  @Prop({ type: Number, min: 1 })
  bookmakerOdds?: number;

  /** Current stored price, which may be provider supplied or statistically estimated. */
  @Prop({ type: Number, min: 1 })
  decimalOdds?: number;

  @Prop({ type: String, enum: ['PROVIDER', 'ESTIMATED'] })
  priceType?: 'PROVIDER' | 'ESTIMATED';

  @Prop({ type: Date })
  oddsUpdatedAt?: Date;

  @Prop({ type: String, enum: ['BOOKMAKER_ONLY', 'BOOKMAKER_PLUS_HISTORY', 'HISTORICAL_ONLY', 'PRIOR_ONLY'] })
  oddsBasis?: 'BOOKMAKER_ONLY' | 'BOOKMAKER_PLUS_HISTORY' | 'HISTORICAL_ONLY' | 'PRIOR_ONLY';

  @Prop({ type: String, trim: true })
  oddsCalculationMethod?: string;

  @Prop({ type: String, enum: ['THE_ODDS_API', 'ESPN'] })
  oddsProvider?: 'THE_ODDS_API' | 'ESPN';

  @Prop({ type: String, trim: true })
  bookmaker?: string;

  /** Evidence-derived confidence; intentionally never padded. */
  @Prop({ type: Number, min: 0, max: 98, default: null })
  confidence!: number | null;

  /** Unpadded evidence score used by products with stricter confidence ceilings. */
  @Prop({ type: Number, min: 0, max: 98, default: null })
  evidenceConfidence?: number | null;

  @Prop({ type: Number, min: 0, max: 1 })
  calibrationReliability?: number;

  @Prop({ type: Number, min: 0 })
  calibrationSampleSize?: number;

  @Prop({ type: Boolean })
  calibrationApplied?: boolean;

  @Prop({ type: Number, min: 0, max: 1 })
  safetyScore?: number;

  @Prop({ type: Number, default: null })
  expectedValue?: number | null;

  @Prop({ type: Number, default: null })
  expectedValuePercent?: number | null;

  @Prop({ type: Number, min: 0, max: 1, default: null })
  dataQuality?: number;

  /** Exact line/selection price was explicitly endorsed by the Odds module. */
  @Prop({ type: Boolean, default: false, index: true })
  oddsPredictionReady?: boolean;

  /** Exactly one final candidate is selected by the market engine per market. */
  @Prop({ type: Boolean, default: false, index: true })
  isFinalSelection?: boolean;

  /** Compatibility flag mirroring the market engine's final selection; not a value gate. */
  @Prop({ type: Boolean, default: false, index: true })
  recommendationEligible?: boolean;

  @Prop({ type: String, enum: Object.values(PredictionStatus), required: true })
  status!: PredictionStatus;

  @Prop({ type: [String], enum: Object.values(PredictionSource), default: [] })
  sources!: PredictionSource[];

  @Prop({ type: String })
  calculationMethod?: string;

  @Prop({ type: Object, default: undefined })
  settlementProfile?: {
    fullWin?: number;
    halfWin?: number;
    push?: number;
    halfLoss?: number;
    fullLoss?: number;
  };

  @Prop({ type: [String], default: [] })
  diagnostics!: string[];

  /**
   * Written by the separate settlement module after the actual event is known.
   * This module does not calculate or perform settlement.
   */
  @Prop({ type: String, enum: PERSISTED_SETTLEMENT_OUTCOMES })
  actualOutcome?: PersistedSettlementOutcome;

  @Prop({ type: Date })
  settledAt?: Date;

  @Prop({ type: String, trim: true })
  settlementMethod?: string;

  @Prop({ type: String, trim: true })
  settlementReason?: string;

  @Prop({ type: Object })
  settlementEvidence?: Record<string, unknown>;

  @Prop({ type: String, trim: true })
  settlementSourceFingerprint?: string;

  /** Append-only audit trail for controlled historical outcome corrections. */
  @Prop({ type: [Object], default: [] })
  settlementHistory?: Array<Record<string, unknown>>;
}
export const MarketSelectionPredictionSchema = SchemaFactory.createForClass(
  MarketSelectionPrediction,
);

@Schema({
  timestamps: true,
  collection: 'predictions_engine_markets',
})
export class MarketPrediction {
  @Prop({ required: true, trim: true, index: true })
  eventId!: string;

  @Prop({ required: true, trim: true, lowercase: true, index: true })
  leagueId!: string;

  @Prop({ required: true, type: Date, index: true })
  fixtureDate!: Date;

  @Prop({ type: Boolean, default: false, index: true })
  live?: boolean;

  @Prop({ type: Boolean, default: false, index: true })
  completed?: boolean;

  @Prop({ required: true, trim: true })
  homeTeamId!: string;

  @Prop({ required: true, trim: true })
  awayTeamId!: string;

  @Prop({ required: true, trim: true })
  homeTeamName!: string;

  @Prop({ required: true, trim: true })
  awayTeamName!: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(PredictionMarket),
    index: true,
  })
  marketKey!: PredictionMarket;

  @Prop({ required: true, trim: true })
  marketJsonVariable!: string;

  @Prop({ required: true, trim: true })
  marketName!: string;

  @Prop({ required: true, trim: true })
  marketAbbreviation!: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(MarketFamily),
    index: true,
  })
  family!: MarketFamily;

  @Prop({ required: true, trim: true })
  period!: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(PredictionStatus),
    index: true,
  })
  status!: PredictionStatus;

  @Prop({ type: [MarketSelectionPredictionSchema], default: [] })
  selections!: MarketSelectionPrediction[];

  @Prop({ type: [String], enum: Object.values(PredictionSource), default: [] })
  sources!: PredictionSource[];

  @Prop({ required: true, trim: true })
  modelVersion!: string;

  @Prop({ required: true, trim: true })
  calculationMethod!: string;

  @Prop({ type: Number, min: 0, max: 1, default: 0 })
  dataQuality!: number;

  @Prop({ type: [String], default: [] })
  diagnostics!: string[];

  @Prop({ type: Object, default: undefined })
  expectedGoals?: { home: number; away: number };

  /** Unknown remains null; this must not be backfilled with generic fixture collection time. */
  @Prop({ type: Date, required: false, default: null, index: true })
  sourceSummaryCollectedAt?: Date | null;

  @Prop({ type: Date, required: true, index: true })
  generatedAt!: Date;

  @Prop({ type: Date })
  calculationStartedAt?: Date;

  @Prop({ type: Number, min: 0 })
  calculationDurationMs?: number;
}
export type MarketPredictionDocument = HydratedDocument<MarketPrediction>;
export const MarketPredictionSchema =
  SchemaFactory.createForClass(MarketPrediction);

MarketPredictionSchema.index(
  { eventId: 1, marketKey: 1, modelVersion: 1 },
  { unique: true, name: 'uniq_event_market_model' },
);
MarketPredictionSchema.index({ eventId: 1, fixtureDate: 1 });
MarketPredictionSchema.index({ marketKey: 1, status: 1, fixtureDate: 1 });
MarketPredictionSchema.index({
  'selections.confidence': -1,
  'selections.probability': -1,
});
MarketPredictionSchema.index({ 'selections.actualOutcome': 1, marketKey: 1 });









