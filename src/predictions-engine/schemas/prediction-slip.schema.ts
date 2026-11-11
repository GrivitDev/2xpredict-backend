import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { SlipStatus } from '../enums/slip-status.enum';
import { SlipProductType } from '../enums/slip-product-type.enum';

@Schema({ _id: false })
export class PredictionSlipLeg {
  @Prop({ required: true, trim: true })
  eventId!: string;

  @Prop({ required: true, trim: true })
  homeTeamName!: string;

  @Prop({ required: true, trim: true })
  awayTeamName!: string;

  @Prop({ required: true, type: Date })
  fixtureDate!: Date;

  /** Exact season-relative expiry for this fixture leg. */
  @Prop({ type: Date })
  retentionExpiresAt?: Date | null;

  @Prop({ required: true, trim: true })
  marketPredictionId!: string;

  @Prop({ required: true, trim: true })
  marketKey!: string;

  @Prop({ required: true, trim: true })
  marketName!: string;

  @Prop({ required: true, trim: true })
  selectionKey!: string;

  @Prop({ required: true, trim: true })
  selectionName!: string;

  @Prop({ required: true, type: Number, min: 0, max: 1 })
  probability!: number;

  @Prop({ required: true, type: Number, min: 0, max: 98 })
  confidence!: number;

  @Prop({ required: true, type: Number, min: 1 })
  fairOdds!: number;

  /** Odds captured for this slip leg from the shared Odds Module. */
  @Prop({ required: true, type: Number, min: 1.01 })
  decimalOdds!: number;

  @Prop({ required: true, type: String, enum: ['PROVIDER', 'ESTIMATED'] })
  priceType!: 'PROVIDER' | 'ESTIMATED';

  /** Readiness acknowledgement carried from Odds module through Pick Center. */
  @Prop({ type: Boolean, default: false, index: true })
  oddsPredictionReady?: boolean;

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

  @Prop({ type: Number })
  expectedValue?: number;

  @Prop({ type: Number })
  expectedValuePercent?: number;

  @Prop({ type: Number, min: 0, max: 1 })
  dataQuality?: number;

  @Prop({ type: String, trim: true })
  modelVersion?: string;

  @Prop({ type: Object })
  settlementProfile?: { fullWin?: number; halfWin?: number; push?: number; halfLoss?: number; fullLoss?: number };

  /** Provider quote retained separately when available. */
  @Prop({ type: Number, min: 1 })
  bookmakerOdds?: number;

  /** Settlement outcome of this exact market selection, populated by SettlementModule. */
  @Prop({ type: String, enum: ['PENDING', 'WON', 'LOST', 'VOID', 'PUSH', 'HALF_WON', 'HALF_LOST'], default: 'PENDING', index: true })
  settlementOutcome!: 'PENDING' | 'WON' | 'LOST' | 'VOID' | 'PUSH' | 'HALF_WON' | 'HALF_LOST';

  /** Aggregate result of every selected market belonging to this fixture in the slip. */
  @Prop({ type: String, enum: ['PENDING', 'WON', 'LOST', 'VOID', 'PUSH', 'HALF_WON', 'HALF_LOST'], default: 'PENDING' })
  matchSettlementStatus!: 'PENDING' | 'WON' | 'LOST' | 'VOID' | 'PUSH' | 'HALF_WON' | 'HALF_LOST';

  @Prop({ type: Date })
  settledAt?: Date;

  /** Provenance is retained so a changed Sports source can revise only provisional outcomes. */
  @Prop({ type: String, enum: ['IN_PLAY', 'HALF_TIME', 'FULL_TIME'] })
  settlementPhase?: 'IN_PLAY' | 'HALF_TIME' | 'FULL_TIME';

  @Prop({ type: String, trim: true })
  settlementSourceFingerprint?: string;

  @Prop({ type: [Object], default: [] })
  settlementHistory?: Array<Record<string, unknown>>;
}
export const PredictionSlipLegSchema =
  SchemaFactory.createForClass(PredictionSlipLeg);

@Schema({ timestamps: true, collection: 'predictions_engine_slips' })
export class PredictionSlip {
  @Prop({ required: true, unique: true, trim: true, index: true })
  slipCode!: string;

  /** Latest expiry among all legs; a mixed-season slip cannot expire early. */
  @Prop({ type: Date })
  retentionExpiresAt?: Date | null;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(SlipStatus),
    default: SlipStatus.DRAFT,
    index: true,
  })
  status!: SlipStatus;

  @Prop({ type: [PredictionSlipLegSchema], required: true, default: [] })
  legs!: PredictionSlipLeg[];

  /** Aggregate settlement outcome across all selections, independent of publication status. */
  @Prop({ type: String, enum: ['PENDING', 'WON', 'LOST', 'VOID', 'PUSH', 'HALF_WON', 'HALF_LOST'], default: 'PENDING', index: true })
  settlementStatus!: 'PENDING' | 'WON' | 'LOST' | 'VOID' | 'PUSH' | 'HALF_WON' | 'HALF_LOST';

  @Prop({ type: Date, index: true })
  settledAt?: Date;

  @Prop({ required: true, type: Number, min: 1 })
  legCount!: number;

  @Prop({ required: true, type: Number, min: 0, max: 1 })
  combinedProbability!: number;

  @Prop({ required: true, type: Number, min: 1 })
  combinedFairOdds!: number;

  /** Product of each leg's stored decimal price. */
  @Prop({ type: Number, min: 1, index: true })
  combinedOdds?: number;

  @Prop({
    type: String,
    enum: Object.values(SlipProductType),
    default: SlipProductType.STANDARD,
    index: true,
  })
  productType!: SlipProductType;

  @Prop({ type: String, enum: ['regular', 'vip', 'premium'], default: 'vip', index: true })
  requiredPlan!: 'regular' | 'vip' | 'premium';

  @Prop({ type: String, enum: ['VIP', 'PREMIUM'], index: true })
  sureOddsTier?: 'VIP' | 'PREMIUM';

  @Prop({ type: String, enum: ['SURE_2', 'SURE_5', 'SURE_7'], index: true })
  sureOddsProduct?: 'SURE_2' | 'SURE_5' | 'SURE_7';

  @Prop({ type: Boolean, default: false, index: true })
  sureOdds!: boolean;

  @Prop({ type: String, index: true })
  generatedDateKey?: string;

  /** Nigeria kickoff date this automatic slip was allocated to; distinct from its creation date. */
  @Prop({ type: String })
  targetDateKey?: string;

  @Prop({ type: Number, min: 1 })
  targetOddsMinimum?: number;

  @Prop({ type: Number, min: 1 })
  targetOddsMaximum?: number;

  @Prop({ required: true, type: Number, min: 0, max: 98 })
  averageConfidence!: number;

  @Prop({ type: Number, min: 0, max: 98 })
  generalConfidence?: number;

  @Prop({ type: Number, min: 0, max: 1 })
  minimumLegProbability?: number;

  @Prop({ type: Date, index: true })
  fixtureDateFrom?: Date;

  @Prop({ type: Date, index: true })
  fixtureDateTo?: Date;

  /** Optional manually entered betting-site metadata. */
  @Prop({ type: String, trim: true })
  sportyBetSlipCode?: string;

  @Prop({ type: String, trim: true })
  sportyBetSlipLink?: string;

  @Prop({ type: String, trim: true })
  createdBy?: string;

  @Prop({ type: Boolean, default: false, index: true })
  automatic!: boolean;

  @Prop({ type: Date })
  publishedAt?: Date;

  /** Timestamp at which the slip's selected legs and prices became immutable. */
  @Prop({ type: Date, index: true })
  snapshotFrozenAt?: Date;

  @Prop({ type: String, trim: true })
  fingerprint?: string;

  /** Stable hash of the complete fixture set, independent of market selections and product. */
  @Prop({ type: String, trim: true })
  matchSetFingerprint?: string;

  @Prop({ type: String, default: 'INDEPENDENCE_APPROXIMATION' })
  combinedProbabilityMethod?: string;

  @Prop({ type: [String], default: [] })
  diagnostics!: string[];
}
export type PredictionSlipDocument = HydratedDocument<PredictionSlip>;
export const PredictionSlipSchema =
  SchemaFactory.createForClass(PredictionSlip);
PredictionSlipSchema.index({ status: 1, createdAt: -1 });
PredictionSlipSchema.index(
  { automatic: 1, fingerprint: 1 },
  { unique: true, sparse: true },
);
PredictionSlipSchema.index({ 'legs.eventId': 1 });
PredictionSlipSchema.index(
  { matchSetFingerprint: 1 },
  { unique: true, sparse: true },
);
PredictionSlipSchema.index({
  productType: 1,
  requiredPlan: 1,
  status: 1,
  fixtureDateFrom: 1,
});
PredictionSlipSchema.index({
  sureOdds: 1,
  sureOddsTier: 1,
  sureOddsProduct: 1,
  generatedDateKey: 1,
});












PredictionSlipSchema.index(
  { retentionExpiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_prediction_slip_retention' },
);
