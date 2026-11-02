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

  @Prop({ required: true, unique: true, trim: true })
  ticketNumber!: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(BetLabTicketType),
    index: true,
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

  @Prop({ required: true, min: 1 })
  stake!: number;

  @Prop({ required: true, min: 1.01 })
  combinedOdds!: number;

  @Prop({ required: true, min: 0 })
  potentialReturn!: number;

  @Prop({ required: true, min: 0 })
  potentialProfit!: number;

  @Prop({ required: true, type: [BetLabTicketLegSchema], default: [] })
  legs!: BetLabTicketLeg[];

  @Prop({ required: true, trim: true })
  idempotencyKey!: string;

  @Prop({ required: true, trim: true })
  requestFingerprint!: string;

  /** Filled only by the separate Settlement module's trusted integration call. */
  @Prop({ trim: true, index: true })
  settlementId?: string;

  @Prop({ type: Date, index: true })
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
