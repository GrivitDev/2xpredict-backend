import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { BetLabPlan } from '../config/bet-lab.config';

export type BetLabSettingsDocument = HydratedDocument<BetLabSettings>;

@Schema({ timestamps: true, collection: 'bet_lab_settings' })
export class BetLabSettings {
  @Prop({ required: true, unique: true, index: true, default: 'virtual-points' })
  key!: string;

  @Prop({ required: true, min: 0, default: 10_000 })
  registrationBonus!: number;

  @Prop({
    type: Object,
    required: true,
    default: () => ({ free: 1_000, regular: 3_000, vip: 5_000, premium: 10_000 }),
  })
  monthlyAllowanceByPlan!: Record<BetLabPlan, number>;

  @Prop({ trim: true })
  updatedBy?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export const BetLabSettingsSchema = SchemaFactory.createForClass(BetLabSettings);
