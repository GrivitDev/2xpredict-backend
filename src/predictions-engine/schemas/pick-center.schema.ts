import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { PickStatus } from '../enums/pick-status.enum';

@Schema({ _id: false })
export class PickCenterSelectionRecord {
  @Prop({ required: true, trim: true })
  marketPredictionId!: string;

  @Prop({ required: true, trim: true })
  marketKey!: string;

  @Prop({ required: true, trim: true })
  marketName!: string;

  @Prop({ required: true, trim: true })
  marketAbbreviation!: string;

  @Prop({ required: true, trim: true })
  selectionKey!: string;

  @Prop({ required: true, trim: true })
  selectionName!: string;

  @Prop({ required: true, trim: true })
  selectionAbbreviation!: string;

  @Prop({ type: Number })
  line?: number;

  @Prop({ type: String })
  subjectId?: string;

  @Prop({ type: String })
  subjectName?: string;

  @Prop({ required: true, type: Number, min: 0, max: 1 })
  probability!: number;

  @Prop({ required: true, type: Number, min: 0, max: 100 })
  probabilityPercent!: number;

  @Prop({ required: true, type: Number, min: 1 })
  fairOdds!: number;

  /** Odds-module price; for ESTIMATED rows this is not a bookmaker offer. */
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

  /** Present only when the price came from a provider quote. */
  @Prop({ type: Number, min: 1 })
  bookmakerOdds?: number;

  @Prop({ required: true, type: Number, min: 0, max: 98 })
  confidence!: number;

  @Prop({ type: Number, min: 0, max: 98 })
  evidenceConfidence?: number;

  @Prop({ type: Number })
  expectedValue?: number;

  @Prop({ type: Number })
  expectedValuePercent?: number;

  @Prop({ type: Number, min: 0, max: 1 })
  dataQuality?: number;

  @Prop({ type: Number, min: 0, max: 1 })
  calibrationReliability?: number;

  @Prop({ type: Number, min: 0 })
  calibrationSampleSize?: number;

  @Prop({ type: Number, min: 0, max: 1 })
  safetyScore?: number;

  @Prop({ type: Number })
  valueRatio?: number;

  @Prop({ type: Number, min: 0 })
  marketPriority?: number;

  @Prop({ type: Boolean, default: false })
  recommendationEligible?: boolean;

  @Prop({ type: Boolean, default: false, index: true })
  oddsPredictionReady?: boolean;

  @Prop({ type: Boolean, default: false, index: true })
  isFinalSelection?: boolean;

  @Prop({ type: Object })
  settlementProfile?: { fullWin?: number; halfWin?: number; push?: number; halfLoss?: number; fullLoss?: number };

  @Prop({ required: true, type: Number, index: true })
  rankingScore!: number;

  @Prop({ type: Number, min: 1, index: true })
  rank?: number;

  @Prop({ required: true, type: Boolean, default: false })
  isMatchResult!: boolean;

  @Prop({
    type: String,
    enum: Object.values(PickStatus),
    default: PickStatus.SELECTED,
  })
  status!: PickStatus;

  @Prop({ type: [String], default: [] })
  reasons!: string[];
}
export const PickCenterSelectionRecordSchema = SchemaFactory.createForClass(
  PickCenterSelectionRecord,
);

@Schema({ timestamps: true, collection: 'predictions_engine_pick_center' })
export class PickCenter {
  @Prop({ required: true, unique: true, trim: true, index: true })
  eventId!: string;

  @Prop({ required: true, trim: true, lowercase: true, index: true })
  leagueId!: string;

  @Prop({ required: true, type: Date, index: true })
  fixtureDate!: Date;

  /** Exact retention deadline copied from the canonical Sports fixture. */
  @Prop({ type: Date })
  retentionExpiresAt?: Date | null;

  @Prop({ type: Boolean, default: false, index: true })
  live?: boolean;

  @Prop({ type: Boolean, default: false, index: true })
  completed?: boolean;

  @Prop({ required: true, trim: true })
  homeTeamName!: string;

  @Prop({ required: true, trim: true })
  awayTeamName!: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(PickStatus),
    default: PickStatus.INELIGIBLE,
  })
  status!: PickStatus;

  @Prop({ type: [PickCenterSelectionRecordSchema], default: [] })
  selectedMarkets!: PickCenterSelectionRecord[];

  @Prop({ type: Number, default: 0 })
  eligibleMarketCount!: number;

  @Prop({ type: Number, default: 0 })
  selectedMarketCount!: number;

  @Prop({ type: Number, min: 0, max: 98 })
  generalConfidence?: number;

  @Prop({ type: String })
  exclusionReason?: string;

  @Prop({ type: String, required: true })
  modelVersion!: string;
}
export type PickCenterDocument = HydratedDocument<PickCenter>;
export const PickCenterSchema = SchemaFactory.createForClass(PickCenter);
PickCenterSchema.index({ fixtureDate: 1, status: 1 });
PickCenterSchema.index({ 'selectedMarkets.rankingScore': -1, fixtureDate: 1 });










PickCenterSchema.index(
  { retentionExpiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_pick_center_retention' },
);
