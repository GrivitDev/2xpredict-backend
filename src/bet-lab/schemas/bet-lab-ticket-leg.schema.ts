import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { BetLabLegStatus } from '../enums/bet-lab-leg-status.enum';
import { BetLabMarketCode } from '../enums/bet-lab-market-code.enum';
import { BetLabOddsSource } from '../enums/bet-lab-odds-source.enum';

@Schema({ _id: false })
export class BetLabTicketLeg {
  @Prop({ required: true, trim: true })
  legId!: string;

  @Prop({ required: true, trim: true, index: true })
  eventId!: string;

  @Prop({ required: true, trim: true })
  leagueId!: string;

  @Prop({ required: true, trim: true })
  leagueName!: string;

  @Prop({ required: true, type: Date })
  fixtureDate!: Date;

  @Prop({ required: true, trim: true })
  homeTeamId!: string;

  @Prop({ required: true, trim: true })
  homeTeamName!: string;

  @Prop({ required: true, trim: true })
  awayTeamId!: string;

  @Prop({ required: true, trim: true })
  awayTeamName!: string;

  @Prop({ required: true, type: String, enum: Object.values(BetLabMarketCode) })
  marketCode!: BetLabMarketCode;

  @Prop({ required: true, trim: true })
  marketJsonVariable!: string;

  @Prop({ required: true, trim: true })
  marketFullName!: string;

  @Prop({ required: true, trim: true })
  marketAbbreviation!: string;

  @Prop({ required: true, trim: true })
  selectionCode!: string;

  @Prop({ required: true, trim: true })
  selectionJsonVariable!: string;

  @Prop({ required: true, trim: true })
  selectionFullName!: string;

  @Prop({ required: true, trim: true })
  selectionAbbreviation!: string;

  @Prop({ required: true, min: 1.01 })
  decimalOdds!: number;

  @Prop({ required: true, type: String, enum: Object.values(BetLabOddsSource) })
  oddsSource!: BetLabOddsSource;

  /** Provider versus model-generated price, frozen when the virtual ticket is placed. */
  @Prop({ type: String, enum: ['PROVIDER', 'ESTIMATED'] })
  priceType?: 'PROVIDER' | 'ESTIMATED';

  /** Provider/bookmaker label for auditing the virtual odds snapshot. */
  @Prop({ type: String, trim: true })
  bookmaker?: string;

  @Prop({ type: Date })
  providerUpdatedAt?: Date;

  @Prop({ type: String, enum: ['PROVIDER_UPDATED_AT', 'INGESTED_AT', 'MODEL_GENERATED'] })
  oddsTimestampBasis?: 'PROVIDER_UPDATED_AT' | 'INGESTED_AT' | 'MODEL_GENERATED';

  @Prop({ type: String, enum: ['BOOKMAKER_ONLY', 'BOOKMAKER_PLUS_HISTORY', 'HISTORICAL_ONLY', 'PRIOR_ONLY'] })
  oddsBasis?: 'BOOKMAKER_ONLY' | 'BOOKMAKER_PLUS_HISTORY' | 'HISTORICAL_ONLY' | 'PRIOR_ONLY';

  @Prop({ type: String, trim: true })
  oddsCalculationMethod?: string;

  @Prop({ required: true, type: Date })
  oddsCapturedAt!: Date;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(BetLabLegStatus),
    default: BetLabLegStatus.OPEN,
  })
  status!: BetLabLegStatus;

  /** Canonical market settlement rule snapshot; independent of the display label. */
  @Prop({ type: String, trim: true })
  settlementKey?: string;

  @Prop({ type: Number })
  line?: number;

  @Prop({ type: Number })
  handicap?: number;

  @Prop({ type: Number, min: 0 })
  homeGoals?: number;

  @Prop({ type: Number, min: 0 })
  awayGoals?: number;

  @Prop({ type: String, trim: true })
  subjectId?: string;

  @Prop({ type: String, trim: true })
  subjectName?: string;

  @Prop({ type: String, trim: true })
  subjectTeamId?: string;

  @Prop({ type: String, trim: true })
  settlementMethod?: string;

  @Prop({ type: String, trim: true, maxlength: 500 })
  settlementNote?: string;

  @Prop({ type: String })
  settlementOutcome?: string;

  /** Aggregate outcome of all selections from this same fixture on the ticket. */
  @Prop({ type: String, enum: Object.values(BetLabLegStatus), default: BetLabLegStatus.OPEN })
  matchSettlementStatus!: BetLabLegStatus;

  @Prop({ type: Date })
  settledAt?: Date;
}

export const BetLabTicketLegSchema =
  SchemaFactory.createForClass(BetLabTicketLeg);
