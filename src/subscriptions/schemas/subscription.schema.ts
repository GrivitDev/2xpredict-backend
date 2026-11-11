import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SubscriptionDocument = HydratedDocument<Subscription>;

export type PlanType = 'free' | 'regular' | 'vip' | 'premium';
export type PaidPlanType = Exclude<PlanType, 'free'>;

@Schema({ timestamps: true })
export class Subscription {
  @Prop({ required: true })
  userId!: string;

  @Prop({ required: true })
  email!: string;

  @Prop({
    type: String,
    enum: ['regular', 'vip', 'premium'],
    required: true,
  })
  plan!: PaidPlanType;

  @Prop({ required: true })
  amount!: number;

  @Prop({ required: true })
  startDate!: Date;

  @Prop({ required: true })
  expiryDate!: Date;

  @Prop({ default: true })
  isActive!: boolean;

  /** Stable originating payment reference used to prevent duplicate entitlements. */
  @Prop({ type: String, default: undefined, trim: true })
  sourceReference?: string;

  @Prop({
    default: false,
  })
  expiringReminderSent: boolean = false;

  @Prop({
    default: false,
  })
  expiredNotificationSent: boolean = false;
}

export const SubscriptionSchema = SchemaFactory.createForClass(Subscription);
SubscriptionSchema.index({ sourceReference: 1 }, { unique: true, sparse: true });


