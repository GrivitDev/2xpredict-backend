import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OddsProviderStateDocument = HydratedDocument<OddsProviderState>;

@Schema({ timestamps: true, collection: 'odds_provider_state' })
export class OddsProviderState {
  @Prop({ required: true, unique: true, trim: true })
  key!: string;

  @Prop({ required: true, enum: ['THE_ODDS_API'] })
  provider!: 'THE_ODDS_API';

  @Prop({ required: true, trim: true })
  utcDate!: string;

  @Prop({ required: true, default: 0, min: 0 })
  requestsToday!: number;

  /** Durable round-robin cursor so low-priority leagues are not starved after restarts. */
  @Prop({ type: String })
  collectionCursor?: string;

  @Prop({ type: Date })
  lastRequestAt?: Date;

  @Prop({ type: Date })
  nextAllowedAt?: Date;

  @Prop({ type: Date })
  lockedUntil?: Date;

  @Prop({ type: Date })
  blockedUntil?: Date;

  @Prop({
    required: true,
    enum: [
      'READY',
      'QUOTA_EXHAUSTED',
      'THROTTLED',
      'AUTH_ERROR',
      'DEGRADED',
      'DISABLED',
    ],
    default: 'READY',
  })
  status!:
    | 'READY'
    | 'QUOTA_EXHAUSTED'
    | 'THROTTLED'
    | 'AUTH_ERROR'
    | 'DEGRADED'
    | 'DISABLED';

  @Prop({ type: String })
  message?: string;

  @Prop({ type: Number })
  providerRequestsRemaining?: number;

  @Prop({ type: Number })
  providerRequestsUsed?: number;

  @Prop({ type: Number })
  providerLastRequestCost?: number;
}

export const OddsProviderStateSchema =
  SchemaFactory.createForClass(OddsProviderState);
