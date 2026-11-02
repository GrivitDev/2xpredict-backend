import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CuratedPredictionOutcome =
  | 'PENDING'
  | 'WON'
  | 'LOST'
  | 'VOID'
  | 'PUSH'
  | 'HALF_WON'
  | 'HALF_LOST';
export type CuratedPredictionStatus =
  | 'READY'
  | 'PUBLISHED'
  | 'SETTLED'
  | 'CANCELLED';

@Schema({ _id: false })
export class CuratedPredictionSelection {
  @Prop({ required: true, trim: true, index: true }) eventId!: string;
  @Prop({ required: true, trim: true }) leagueId!: string;
  @Prop({ required: true, trim: true }) leagueName!: string;
  @Prop({ required: true, type: Date }) fixtureDate!: Date;
  @Prop({ required: true, trim: true }) homeTeamName!: string;
  @Prop({ required: true, trim: true }) awayTeamName!: string;
  @Prop({ required: true, trim: true }) marketPredictionId!: string;
  @Prop({ required: true, trim: true }) marketKey!: string;
  @Prop({ required: true, trim: true }) marketName!: string;
  @Prop({ required: true, trim: true }) selectionKey!: string;
  @Prop({ required: true, trim: true }) selectionName!: string;
  @Prop({ required: true, min: 0.001, max: 0.999999 }) probability!: number;
  @Prop({ required: true, min: 0, max: 98 }) confidence!: number;
  /** Source type is retained; estimated prices are never presented as bookmaker offers. */
  @Prop({ type: String, enum: ['PROVIDER', 'ESTIMATED'] }) priceType?:
    | 'PROVIDER'
    | 'ESTIMATED';
  @Prop({ type: Boolean, default: false }) predictionReady?: boolean;
  /** Optional at the Curated Predictions layer; downstream priced products validate odds independently. */
  @Prop({ type: Number, min: 1.01, max: 100000 }) decimalOdds?: number;
  /** Fair odds are informational and must not gate a probability/confidence-eligible pick. */
  @Prop({ type: Number, min: 1 }) fairOdds?: number;
  @Prop({ type: Date }) oddsUpdatedAt?: Date;
  @Prop({
    type: String,
    enum: [
      'BOOKMAKER_ONLY',
      'BOOKMAKER_PLUS_HISTORY',
      'HISTORICAL_ONLY',
      'PRIOR_ONLY',
    ],
  })
  oddsBasis?:
    | 'BOOKMAKER_ONLY'
    | 'BOOKMAKER_PLUS_HISTORY'
    | 'HISTORICAL_ONLY'
    | 'PRIOR_ONLY';
  @Prop({ type: String, trim: true }) oddsCalculationMethod?: string;
  @Prop({ type: String, enum: ['THE_ODDS_API', 'ESPN'] }) oddsProvider?:
    | 'THE_ODDS_API'
    | 'ESPN';
  @Prop({ type: String, trim: true }) bookmaker?: string;
  @Prop({ type: Number }) expectedValue?: number;
  @Prop({ type: Number }) expectedValuePercent?: number;
  @Prop({ type: Number, min: 0, max: 1 }) dataQuality?: number;
  @Prop({ type: String, trim: true }) modelVersion?: string;
  @Prop({ type: Object }) settlementProfile?: {
    fullWin?: number;
    halfWin?: number;
    push?: number;
    halfLoss?: number;
    fullLoss?: number;
  };
  @Prop({ type: Number }) rankingScore?: number;
  @Prop({ type: Number, min: 0, max: 1 }) calibrationReliability?: number;
  @Prop({ type: Number, min: 0 }) calibrationSampleSize?: number;
  @Prop({ type: Number, min: 0, max: 1 }) safetyScore?: number;
  @Prop({
    type: String,
    enum: ['PENDING', 'WON', 'LOST', 'VOID', 'PUSH', 'HALF_WON', 'HALF_LOST'],
    default: 'PENDING',
    index: true,
  })
  settlementOutcome!: CuratedPredictionOutcome;
  @Prop({
    type: String,
    enum: ['PENDING', 'WON', 'LOST', 'VOID', 'PUSH', 'HALF_WON', 'HALF_LOST'],
    default: 'PENDING',
  })
  matchSettlementStatus!: CuratedPredictionOutcome;
  @Prop({ type: Date }) settledAt?: Date;
}
export const CuratedPredictionSelectionSchema = SchemaFactory.createForClass(
  CuratedPredictionSelection,
);

@Schema({ timestamps: true, collection: 'curated_predictions' })
export class CuratedPrediction {
  @Prop({ required: true, unique: true, trim: true, index: true })
  predictionCode!: string;
  // Keep this unique legacy key; new records use a date:event composite value so multiple matches can be curated per day.
  @Prop({ required: true, unique: true, trim: true, index: true })
  generatedDateKey!: string;
  @Prop({ required: true, unique: true, sparse: true, trim: true, index: true })
  eventId!: string;
  @Prop({ required: true, trim: true }) title!: string;
  @Prop({ type: Boolean, default: false, index: true }) live?: boolean;
  @Prop({ type: Boolean, default: false, index: true }) completed?: boolean;
  @Prop({
    required: true,
    type: String,
    enum: ['READY', 'PUBLISHED', 'SETTLED', 'CANCELLED'],
    default: 'READY',
    index: true,
  })
  status!: CuratedPredictionStatus;
  @Prop({
    required: true,
    type: [CuratedPredictionSelectionSchema],
    default: [],
  })
  selections!: CuratedPredictionSelection[];
  // Curated recommendations may bundle one to three distinct markets for one fixture.
  @Prop({ required: true, min: 1, max: 3 }) selectionCount!: number;
  @Prop({ required: true, min: 0, max: 1 }) combinedProbability!: number;
  /** Legacy primary-selection odds; omitted when no valid stored price exists. */
  @Prop({ type: Number, min: 1.01, max: 1e15 }) combinedOdds?: number;
  @Prop({ required: true, min: 0, max: 98 }) confidence!: number;
  @Prop({ required: true, type: String, default: 'SINGLE_SELECTION' })
  combinedProbabilityMethod!: string;
  @Prop({
    type: String,
    enum: ['PENDING', 'WON', 'LOST', 'VOID', 'PUSH', 'HALF_WON', 'HALF_LOST'],
    default: 'PENDING',
    index: true,
  })
  settlementStatus!: CuratedPredictionOutcome;
  @Prop({ type: Date, index: true }) fixtureDateFrom?: Date;
  @Prop({ type: Date, index: true }) fixtureDateTo?: Date;
  @Prop({ type: Date }) publishedAt?: Date;
  @Prop({ type: Date }) settledAt?: Date;
  @Prop({ type: [String], default: [] }) diagnostics!: string[];
}
export type CuratedPredictionDocument = HydratedDocument<CuratedPrediction>;
export const CuratedPredictionSchema =
  SchemaFactory.createForClass(CuratedPrediction);
CuratedPredictionSchema.index({ status: 1, fixtureDateFrom: 1 });
