import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type FixtureOddsDocument = HydratedDocument<FixtureOdds>;

/**
 * One Grivit bookmaker price per Sports fixture / market / selection / line.
 * External bookmaker data is optional validation metadata and never replaces
 * the Grivit price or determines whether the selection is prediction-ready.
 */
@Schema({ timestamps: true, collection: 'sports_fixture_odds', versionKey: false })
export class FixtureOdds {
  /** Canonical SportsFixtureRecord.id (kept as eventId for consumer compatibility). */
  @Prop({ required: true, trim: true, index: true })
  eventId!: string;

  @Prop({ required: true, trim: true, index: true })
  marketId!: string;

  @Prop({ required: true, trim: true })
  selectionKey!: string;

  @Prop({ type: Number })
  line?: number;

  /** Grivit decimal odds; ESTIMATED is retained as the legacy internal model-price discriminator. */
  @Prop({ required: true, type: Number, min: 1.01, max: 100000 })
  decimalOdds!: number;

  @Prop({ required: true, type: String, enum: ['PROVIDER', 'ESTIMATED'], index: true })
  priceType!: 'PROVIDER' | 'ESTIMATED';

  @Prop({ type: Boolean, default: false, index: true })
  predictionReady!: boolean;

  /** Reserved for legacy provider rows; Grivit prices do not have a provider. */
  @Prop({ type: String, enum: ['ESPN', 'THE_ODDS_API', 'ODDS_API', 'API_FOOTBALL'] })
  provider?: 'ESPN' | 'THE_ODDS_API' | 'ODDS_API' | 'API_FOOTBALL';

  @Prop({ type: String, trim: true })
  bookmaker?: string;

  /** Grivit is the bookmaker of record; external books are reference-only. */
  @Prop({ type: String, enum: ['GRIVIT_MODEL'], default: 'GRIVIT_MODEL', index: true })
  pricingSource?: 'GRIVIT_MODEL';

  @Prop({ type: Number, min: 0, default: 0 })
  externalBookmakerCount?: number;

  @Prop({ type: Number, min: 1, max: 100000 })
  externalConsensusFairOdds?: number | null;

  @Prop({ type: Number, min: 0, max: 1 })
  externalConsensusProbability?: number | null;

  @Prop({ type: Number })
  externalDeviationPercent?: number | null;

  @Prop({ type: Date })
  externalValidatedAt?: Date | null;

  @Prop({ type: String, enum: ['VALIDATED', 'NO_EXTERNAL_REFERENCE', 'REFERENCE_AVAILABLE_NO_CONSENSUS'], default: 'NO_EXTERNAL_REFERENCE' })
  externalValidationStatus?: 'VALIDATED' | 'NO_EXTERNAL_REFERENCE' | 'REFERENCE_AVAILABLE_NO_CONSENSUS';

  /** Independently calculated model fair decimal odds. */
  @Prop({ type: Number, min: 1, max: 100000 })
  fairOdds?: number | null;

  @Prop({ type: String, enum: ['MODEL', 'PRIOR'] })
  fairOddsBasis?: 'MODEL' | 'PRIOR';

  @Prop({
    type: String,
    enum: ['BOOKMAKER_ONLY', 'BOOKMAKER_PLUS_HISTORY', 'HISTORICAL_ONLY', 'PRIOR_ONLY'],
    index: true,
  })
  oddsBasis?: 'BOOKMAKER_ONLY' | 'BOOKMAKER_PLUS_HISTORY' | 'HISTORICAL_ONLY' | 'PRIOR_ONLY';

  @Prop({ type: String, trim: true })
  oddsCalculationMethod?: string;

  /** Backward-compatible alias for optional external bookmaker consensus fair odds. */
  @Prop({ type: Number, min: 1, max: 100000 })
  marketFairOdds?: number | null;

  /** Raw implied probability of decimalOdds (not vig-removed). */
  @Prop({ type: Number, min: 0, max: 1 })
  impliedProbability?: number | null;

  @Prop({ type: Number, min: 0, max: 1 })
  fairProbability?: number | null;

  /** Positive means the bookmaker offer is larger than the model fair price. */
  @Prop({ type: Number })
  valuePercent?: number | null;

  @Prop({ type: Number, min: 0, max: 1 })
  dataQuality?: number;

  @Prop({ type: Number, min: 0 })
  sampleSize?: number;

  /** Highest Sports derived-projection revision consumed by the Grivit model. */
  @Prop({ type: Number, min: 0, default: 0 })
  sourceRevision?: number;

  /** Exact revision of this fixture's normalized Sports source record. */
  @Prop({ type: Number, min: 0 })
  fixtureSourceRevision?: number;

  @Prop({ type: String, trim: true, index: true })
  sourceDataHash?: string;

  @Prop({ type: Date, index: true })
  sourceDataUpdatedAt?: Date;

  @Prop({ type: String, trim: true })
  calculationVersion?: string;

  @Prop({ type: Date })
  providerUpdatedAt?: Date;

  @Prop({ type: Date })
  expiresAt?: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const FixtureOddsSchema = SchemaFactory.createForClass(FixtureOdds);
FixtureOddsSchema.index(
  { eventId: 1, marketId: 1, selectionKey: 1, line: 1 },
  { unique: true, name: 'uniq_fixture_market_selection_line' },
);
FixtureOddsSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_fixture_odds_expiry' });
FixtureOddsSchema.index({ eventId: 1, predictionReady: 1, updatedAt: -1 }, { name: 'fixture_odds_readiness_lookup' });
// Supports active-model-version reads after a pricing algorithm rollout.
FixtureOddsSchema.index({ eventId: 1, calculationVersion: 1, predictionReady: 1, updatedAt: -1 }, { name: 'fixture_odds_active_model_lookup' });
FixtureOddsSchema.index({ eventId: 1, marketId: 1, updatedAt: -1 }, { name: 'fixture_odds_market_lookup' });
FixtureOddsSchema.index({ pricingSource: 1, externalValidationStatus: 1, updatedAt: -1 }, { name: 'fixture_odds_grivit_validation_lookup' });
