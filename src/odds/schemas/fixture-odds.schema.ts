import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type FixtureOddsDocument = HydratedDocument<FixtureOdds>;

@Schema({ timestamps: true, collection: 'sports_fixture_odds' })
export class FixtureOdds {
  @Prop({ required: true, trim: true, index: true })
  eventId!: string;

  @Prop({ required: true, trim: true, index: true })
  marketId!: string;

  @Prop({ required: true, trim: true })
  selectionKey!: string;

  @Prop({ type: Number })
  line?: number;

  @Prop({ required: true, type: Number, min: 1.01, max: 100000 })
  decimalOdds!: number;

  /** Distinguishes real bookmaker odds from internal estimates. */
  @Prop({ required: true, type: String, enum: ['PROVIDER', 'ESTIMATED'] })
  priceType!: 'PROVIDER' | 'ESTIMATED';

  /** True only when this exact market/selection/line has a valid usable Odds-module value. */
  @Prop({ type: Boolean, default: false, index: true })
  predictionReady!: boolean;

  /** Actual bookmaker source; API-Football is intentionally removed from active pricing. */
  @Prop({ type: String, enum: ['THE_ODDS_API', 'ESPN'] })
  provider?: 'THE_ODDS_API' | 'ESPN';

  @Prop({ type: String, trim: true })
  bookmaker?: string;

  /** Model-derived fair decimal odds. It remains separate from the offered price. */
  @Prop({ type: Number, min: 1, max: 100000 })
  fairOdds?: number | null;

  @Prop({ type: String, enum: ['MODEL', 'PRIOR'] })
  fairOddsBasis?: 'MODEL' | 'PRIOR';

  /** Provenance of decimalOdds; this is deliberately separate from fairOddsBasis. */
  @Prop({
    type: String,
    enum: [
      'BOOKMAKER_ONLY',
      'BOOKMAKER_PLUS_HISTORY',
      'HISTORICAL_ONLY',
      'PRIOR_ONLY',
    ],
    index: true,
  })
  oddsBasis?:
    | 'BOOKMAKER_ONLY'
    | 'BOOKMAKER_PLUS_HISTORY'
    | 'HISTORICAL_ONLY'
    | 'PRIOR_ONLY';

  /** Exact method used to obtain or estimate decimalOdds. */
  @Prop({ type: String, trim: true })
  oddsCalculationMethod?: string;

  /** Vig-removed provider consensus price, when complete outcomes are available. */
  @Prop({ type: Number, min: 1, max: 100000 })
  marketFairOdds?: number | null;

  @Prop({ type: Number, min: 0, max: 1 })
  impliedProbability?: number | null;

  /** Positive is value against the model fair price; null when no model fair price exists. */
  @Prop({ type: Number })
  valuePercent?: number | null;

  @Prop({ type: Date })
  providerUpdatedAt?: Date;

  /** Set after actual completion; MongoDB's TTL index removes the temporary price. */
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
FixtureOddsSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_fixture_odds_expiry' },
);
FixtureOddsSchema.index({ eventId: 1, updatedAt: -1 });
FixtureOddsSchema.index(
  { eventId: 1, expiresAt: 1 },
  { name: 'fixture_odds_event_expiry_lookup' },
);


