import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  BetLabCreditBucket,
  BetLabLedgerType,
} from '../enums/bet-lab-ledger-type.enum';

export type BetLabWalletLedgerDocument = HydratedDocument<BetLabWalletLedger>;

@Schema({ timestamps: true, collection: 'bet_lab_wallet_ledgers' })
export class BetLabWalletLedger {
  @Prop({ required: true, trim: true, index: true })
  userId!: string;

  @Prop({ required: true, trim: true, index: true })
  walletId!: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(BetLabLedgerType),
    index: true,
  })
  transactionType!: BetLabLedgerType;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(BetLabCreditBucket),
  })
  bucket!: BetLabCreditBucket;

  /** Signed virtual-point delta. Credits are positive; debits/expirations are negative. */
  @Prop({ required: true })
  delta!: number;

  @Prop({ required: true, min: 0 })
  amount!: number;

  @Prop({ required: true, min: 0 })
  balanceBefore!: number;

  @Prop({ required: true, min: 0 })
  balanceAfter!: number;

  @Prop({ trim: true, index: true })
  ticketId?: string;

  @Prop({ required: true, trim: true })
  idempotencyKey!: string;

  @Prop({ trim: true, maxlength: 300 })
  description?: string;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;
}

export const BetLabWalletLedgerSchema =
  SchemaFactory.createForClass(BetLabWalletLedger);
BetLabWalletLedgerSchema.index({ userId: 1, createdAt: -1 });
BetLabWalletLedgerSchema.index(
  { userId: 1, idempotencyKey: 1 },
  { unique: true },
);
BetLabWalletLedgerSchema.index({ ticketId: 1, createdAt: -1 });
