import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PlanConfigDocument = HydratedDocument<PlanConfig>;

@Schema({
  timestamps: true,
})
export class PlanConfig {
  /** Stable singleton key; legacy records are adopted on first read. */
  @Prop({ type: String, enum: ['primary'], default: undefined })
  configKey?: 'primary';

  // ===========================
  // Nigeria Pricing
  // ===========================
  @Prop({
    default: 10000,
    min: 0,
  })
  regularPrice!: number;

  @Prop({
    default: 50000,
    min: 0,
  })
  vipPrice!: number;

  @Prop({
    default: 100000,
    min: 0,
  })
  premiumPrice!: number;

  @Prop({
    type: Object,
    default: {
      bankName: '',
      accountName: '',
      accountNumber: '',
      instructions: '',
    },
  })
  bankDetails!: {
    bankName: string;
    accountName: string;
    accountNumber: string;
    instructions: string;
  };

  // ===========================
  // International Pricing
  // ===========================
  @Prop({
    default: 10,
    min: 0,
  })
  regularPriceUSD!: number;

  @Prop({
    default: 50,
    min: 0,
  })
  vipPriceUSD!: number;

  @Prop({
    default: 100,
    min: 0,
  })
  premiumPriceUSD!: number;

  @Prop({
    type: Object,
    default: {
      bankName: '',
      accountName: '',
      accountNumber: '',
      instructions: '',
    },
  })
  bankDetailsUSD!: {
    bankName: string;
    accountName: string;
    accountNumber: string;
    instructions: string;
  };

  // ===========================
  // Common
  // ===========================
  @Prop({
    default: 30,
    min: 30,
    max: 30,
  })
  subscriptionDurationDays!: number;

  @Prop({
    type: Object,
    default: {
      free: 'Free Plan',
      regular: 'Regular Plan',
      vip: 'VIP Plan',
      premium: 'Premium Plan',
    },
  })
  planLabels!: {
    free: string;
    regular: string;
    vip: string;
    premium: string;
  };
}

export const PlanConfigSchema = SchemaFactory.createForClass(PlanConfig);
PlanConfigSchema.index(
  { configKey: 1 },
  {
    unique: true,
    partialFilterExpression: { configKey: { $type: 'string' } },
    name: 'plan_config_singleton_key_unique',
  },
);

