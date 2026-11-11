import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { BetLabTicketStatus } from '../enums/bet-lab-ticket-status.enum';
import { BetLabTicketType } from '../enums/bet-lab-ticket-type.enum';
import {
  BetLabTicketLeg,
  BetLabTicketLegSchema,
} from './bet-lab-ticket-leg.schema';

export type BetLabTicketDocument = HydratedDocument<BetLabTicket>;

@Schema({
  timestamps: true,
  collection: 'bet_lab_tickets',
  optimisticConcurrency: true,
})
export class BetLabTicket {
  @Prop({ required: true, trim: true, index: true })
  userId!: string;

  @Prop({ required: true, unique: true, trim: true, immutable: true })
  ticketNumber!: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(BetLabTicketType),
    index: true,
    immutable: true,
  })
  ticketType!: BetLabTicketType;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(BetLabTicketStatus),
    default: BetLabTicketStatus.OPEN,
    index: true,
  })
  status!: BetLabTicketStatus;

  @Prop({ required: true, min: 1, immutable: true })
  stake!: number;

  @Prop({ required: true, min: 1.01, immutable: true })
  combinedOdds!: number;

  @Prop({ required: true, min: 0, immutable: true })
  potentialReturn!: number;

  @Prop({ required: true, min: 0, immutable: true })
  potentialProfit!: number;

  @Prop({ required: true, type: [BetLabTicketLegSchema], default: [] })
  legs!: BetLabTicketLeg[];

  @Prop({ required: true, trim: true, immutable: true })
  idempotencyKey!: string;

  @Prop({ required: true, trim: true, immutable: true })
  requestFingerprint!: string;

  /** Versioned commitment to all accepted per-leg Odds snapshots and joint adjustments. */
  @Prop({ trim: true, immutable: true })
  pricingSnapshotVersion?: string;

  @Prop({ trim: true, minlength: 64, maxlength: 64, immutable: true })
  pricingSnapshotFingerprint?: string;

  @Prop({ type: Date, immutable: true })
  pricingSnapshotCapturedAt?: Date;

  /** Filled only by the separate Settlement module's trusted integration call. */
  @Prop({ trim: true, index: true })
  settlementId?: string;

  /** Hash of the authoritative settlement payload accepted for this final result. */
  @Prop({ type: String, trim: true, maxlength: 64 })
  settlementFingerprint?: string;

  @Prop({ type: Date, index: true, immutable: true })
  placedAt?: Date;

  @Prop({ type: Date, index: true })
  settledAt?: Date;

  /** Set only after final settlement. Retention does not apply to unsettled tickets. */
  @Prop({ type: Date, index: true })
  visibleUntil?: Date;

  @Prop({ min: 0, default: 0 })
  settledGrossReturn!: number;

  @Prop({ trim: true })
  settlementNote?: string;
}

export const BetLabTicketSchema = SchemaFactory.createForClass(BetLabTicket);
BetLabTicketSchema.index({ userId: 1, placedAt: -1 });
BetLabTicketSchema.index({ userId: 1, status: 1, placedAt: -1 });
BetLabTicketSchema.index({ visibleUntil: 1, status: 1 });
BetLabTicketSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
BetLabTicketSchema.index({ settlementId: 1, userId: 1 }, { sparse: true });


