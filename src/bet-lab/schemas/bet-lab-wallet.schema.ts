import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BetLabWalletDocument = HydratedDocument<BetLabWallet>;

@Schema({ timestamps: true, collection: 'bet_lab_wallets' })
export class BetLabWallet {
  @Prop({ required: true, unique: true, index: true, trim: true })
  userId!: string;

  /** Denormalized sum of all virtual-point buckets. */
  @Prop({ required: true, default: 0, min: 0 })
  balance!: number;

  @Prop({ required: true, default: 0, min: 0 })
  welcomeBalance!: number;

  @Prop({ required: true, default: 0, min: 0 })
  monthlyBalance!: number;

  @Prop({ required: true, default: 0, min: 0 })
  winningsBalance!: number;

  @Prop({ required: true, default: 0, min: 0 })
  bonusBalance!: number;

  @Prop({ required: true, default: false })
  registrationBonusGranted!: boolean;

  @Prop({ required: true, default: 0, min: 0 })
  monthlyAllowanceAmount!: number;

  @Prop({
    required: true,
    default: 'free',
    enum: ['free', 'regular', 'vip', 'premium'],
  })
  monthlyAllowancePlan!: string;

  @Prop({ required: true, type: Date })
  monthlyPeriodStart!: Date;

  @Prop({ required: true, type: Date })
  monthlyPeriodEnd!: Date;

  @Prop({ required: true, default: 0, min: 0 })
  totalStaked!: number;

  @Prop({ required: true, default: 0, min: 0 })
  totalReturns!: number;

  @Prop({ required: true, default: 0 })
  netProfitLoss!: number;

  @Prop({ required: true, default: 0, min: 0 })
  ticketsPlaced!: number;

  @Prop({ required: true, default: 0, min: 0 })
  ticketsSettled!: number;

  @Prop({ required: true, default: 0, min: 0 })
  ticketsWon!: number;

  @Prop({ required: true, default: 0, min: 0 })
  ticketsLost!: number;

  @Prop({ required: true, default: 0, min: 0 })
  ticketsVoided!: number;

  @Prop({ required: true, default: 0, min: 0 })
  ticketsPushed!: number;

  @Prop({ required: true, default: 0, min: 0 })
  ticketsPartiallyWon!: number;

  @Prop({ required: true, default: 0, min: 0 })
  ticketsPartiallyLost!: number;

  @Prop({ type: Date })
  lastTicketAt?: Date;
}

export const BetLabWalletSchema = SchemaFactory.createForClass(BetLabWallet);
BetLabWalletSchema.index({ balance: -1 });
BetLabWalletSchema.index({ monthlyPeriodEnd: 1 });
