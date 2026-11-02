import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { HydratedDocument } from 'mongoose';

import mongoose from 'mongoose';

export type ReferralDocument = HydratedDocument<Referral>;

@Schema({
  timestamps: true,
})
export class Referral {
  // ======================
  // REFERRER
  // ======================

  @Prop({
    type: mongoose.Schema.Types.ObjectId,

    ref: 'User',

    required: true,

    index: true,
  })
  referrerId!: mongoose.Types.ObjectId;

  // ======================
  // REFERRED USER
  // ======================

  @Prop({
    type: mongoose.Schema.Types.ObjectId,

    ref: 'User',

    required: true,

    unique: true,

    index: true,
  })
  referredUserId!: mongoose.Types.ObjectId;

  // ======================
  // TRACKED ACTIONS
  // ======================

  @Prop({
    default: true,
  })
  registered!: boolean;

  @Prop({
    default: false,
  })
  regularSubscription!: boolean;

  @Prop({
    default: false,
  })
  vipSubscription!: boolean;

  @Prop({
    default: false,
  })
  premiumSubscription!: boolean;

  // ======================
  // REWARD STATUS
  // ======================

  @Prop({
    default: false,
  })
  rewardClaimed!: boolean;

  @Prop()
  rewardClaimedAt?: Date;
}

export const ReferralSchema = SchemaFactory.createForClass(Referral);

