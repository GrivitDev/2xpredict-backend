import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { BetLabLegStatus } from '../enums/bet-lab-leg-status.enum';
import { BetLabMarketCode } from '../enums/bet-lab-market-code.enum';
import { BetLabOddsSource } from '../enums/bet-lab-odds-source.enum';

@Schema({ _id: false })
export class BetLabTicketLeg {
  @Prop({ required: true, trim: true, immutable: true })
  legId!: string;

  @Prop({ required: true, trim: true, index: true, immutable: true })
  eventId!: string;

  @Prop({ required: true, trim: true, immutable: true })
  leagueId!: string;

  @Prop({ required: true, trim: true, immutable: true })
  leagueName!: string;

  @Prop({ required: true, type: Date, immutable: true })
  fixtureDate!: Date;

  @Prop({ required: true, trim: true, immutable: true })
  homeTeamId!: string;

  @Prop({ required: true, trim: true, immutable: true })
  homeTeamName!: string;

  @Prop({ required: true, trim: true, immutable: true })
  awayTeamId!: string;

  @Prop({ required: true, trim: true, immutable: true })
  awayTeamName!: string;

  @Prop({ required: true, type: String, enum: Object.values(BetLabMarketCode), immutable: true })
  marketCode!: BetLabMarketCode;

  @Prop({ required: true, trim: true, immutable: true })
  marketJsonVariable!: string;

  @Prop({ required: true, trim: true, immutable: true })
  marketFullName!: string;

  @Prop({ required: true, trim: true, immutable: true })
  marketAbbreviation!: string;

  @Prop({ required: true, trim: true, immutable: true })
  selectionCode!: string;

  @Prop({ required: true, trim: true, immutable: true })
  selectionJsonVariable!: string;

  @Prop({ required: true, trim: true, immutable: true })
  selectionFullName!: string;

  @Prop({ required: true, trim: true, immutable: true })
  selectionAbbreviation!: string;

  @Prop({ required: true, min: 1.01, immutable: true })
  decimalOdds!: number;

  /** Correlated same-fixture pricing group used by relationship-aware Bet Lab odds. */
  @Prop({ type: String, enum: ['MATCH', 'SCORE', 'SHOTS'], immutable: true })
  fixturePricingGroup?: 'MATCH' | 'SCORE' | 'SHOTS';

  /** Applied once at settlement only when every leg in the group wins. */
  @Prop({ type: Number, min: 0.0000001, immutable: true })
  fixturePricingAdjustment?: number;

  @Prop({ required: true, type: String, enum: Object.values(BetLabOddsSource), immutable: true })
  oddsSource!: BetLabOddsSource;

  /** Provider versus model-generated price, frozen when the virtual ticket is placed. */
  @Prop({ type: String, enum: ['PROVIDER', 'ESTIMATED'], immutable: true })
  priceType?: 'PROVIDER' | 'ESTIMATED';

  /** Provider/bookmaker label for auditing the virtual odds snapshot. */
  @Prop({ type: String, trim: true, immutable: true })
  bookmaker?: string;

  @Prop({ type: Date, immutable: true })
  providerUpdatedAt?: Date;

  @Prop({ type: String, enum: ['PROVIDER_UPDATED_AT', 'INGESTED_AT', 'MODEL_GENERATED'], immutable: true })
  oddsTimestampBasis?: 'PROVIDER_UPDATED_AT' | 'INGESTED_AT' | 'MODEL_GENERATED';

  @Prop({ type: String, enum: ['BOOKMAKER_ONLY', 'BOOKMAKER_PLUS_HISTORY', 'HISTORICAL_ONLY', 'PRIOR_ONLY'], immutable: true })
  oddsBasis?: 'BOOKMAKER_ONLY' | 'BOOKMAKER_PLUS_HISTORY' | 'HISTORICAL_ONLY' | 'PRIOR_ONLY';

  @Prop({ type: String, trim: true, immutable: true })
  oddsCalculationMethod?: string;

  /** Odds-module fair-price and quote quality snapshot captured at placement. */
  @Prop({ type: Number, min: 1, immutable: true })
  fairOdds?: number;

  @Prop({ type: String, enum: ['MODEL', 'PRIOR'], immutable: true })
  fairOddsBasis?: 'MODEL' | 'PRIOR';

  @Prop({ type: Number, min: 1, immutable: true })
  marketFairOdds?: number;

  @Prop({ type: Number, min: 0, max: 1, immutable: true })
  impliedProbability?: number;

  @Prop({ type: Number, min: 0, max: 1, immutable: true })
  fairProbability?: number;

  @Prop({ type: Number, immutable: true })
  valuePercent?: number;

  @Prop({ type: Number, min: 0, max: 1, immutable: true })
  dataQuality?: number;

  @Prop({ type: Number, min: 0, immutable: true })
  sampleSize?: number;

  @Prop({ type: String, trim: true, immutable: true })
  calculationVersion?: string;

  @Prop({ type: Number, min: 0, immutable: true })
  sourceRevision?: number;

  /** Sports fixture revision consumed by the Odds module for this exact price. */
  @Prop({ type: Number, min: 0, immutable: true })
  fixtureSourceRevision?: number;

  /** SHA-256 fingerprint of the exact quote and canonical selection accepted. */
  @Prop({ type: String, trim: true, minlength: 64, maxlength: 64, immutable: true })
  oddsSnapshotFingerprint?: string;

  @Prop({ type: Date, immutable: true })
  sourceDataUpdatedAt?: Date;

  @Prop({ type: String, enum: ['ESPN', 'THE_ODDS_API'], immutable: true })
  provider?: 'ESPN' | 'THE_ODDS_API';

  @Prop({ type: Date, immutable: true })
  oddsFreshUntil?: Date;

  @Prop({ required: true, type: Date, immutable: true })
  oddsCapturedAt!: Date;

  /** Exact Odds collection row update timestamp at placement. */
  @Prop({ type: Date, immutable: true })
  oddsRecordUpdatedAt?: Date;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(BetLabLegStatus),
    default: BetLabLegStatus.OPEN,
  })
  status!: BetLabLegStatus;

  /** Canonical market settlement rule snapshot; independent of the display label. */
  @Prop({ type: String, trim: true, immutable: true })
  settlementKey?: string;

  @Prop({ type: Number, immutable: true })
  line?: number;

  @Prop({ type: Number, immutable: true })
  handicap?: number;

  @Prop({ type: Number, min: 0, immutable: true })
  homeGoals?: number;

  @Prop({ type: Number, min: 0, immutable: true })
  awayGoals?: number;

  @Prop({ type: String, trim: true, immutable: true })
  subjectId?: string;

  @Prop({ type: String, trim: true, immutable: true })
  subjectName?: string;

  @Prop({ type: String, trim: true, immutable: true })
  subjectTeamId?: string;

  @Prop({ type: String, trim: true })
  settlementMethod?: string;

  @Prop({ type: String, trim: true, maxlength: 500 })
  settlementNote?: string;

  @Prop({ type: String })
  settlementOutcome?: string;

  /** Market-resolution phase and normalized Sports source snapshot for audit. */
  @Prop({ type: String, enum: ['IN_PLAY', 'HALF_TIME', 'FULL_TIME'] })
  settlementPhase?: 'IN_PLAY' | 'HALF_TIME' | 'FULL_TIME';

  @Prop({ type: String, trim: true })
  settlementSourceFingerprint?: string;

  @Prop({ type: Object })
  settlementEvidence?: Record<string, unknown>;

  @Prop({ type: [Object], default: [] })
  settlementHistory?: Array<Record<string, unknown>>;

  /** Aggregate outcome of all selections from this same fixture on the ticket. */
  @Prop({ type: String, enum: Object.values(BetLabLegStatus), default: BetLabLegStatus.OPEN })
  matchSettlementStatus!: BetLabLegStatus;

  @Prop({ type: Date })
  settledAt?: Date;
}

export const BetLabTicketLegSchema =
  SchemaFactory.createForClass(BetLabTicketLeg);




