import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { HydratedDocument } from 'mongoose';

export type PromoClaimDocument = HydratedDocument<PromoClaim>;
export enum PromoClaimStatus { ACTIVE = 'active', USED = 'used', EXPIRED = 'expired' }

@Schema({ timestamps: true, collection: 'promo_claims' })
export class PromoClaim {
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Promo', required: true, index: true }) promoId!: mongoose.Types.ObjectId;
  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }) userId!: mongoose.Types.ObjectId;
  @Prop({ required: true, enum: ['verified', 'unverified'] }) verificationStatusAtClaim!: 'verified' | 'unverified';
  @Prop({ type: Number, required: true, default: 1 }) promoVersion!: number;
  @Prop({ type: Date, required: true }) expiresAt!: Date;
  @Prop({ enum: PromoClaimStatus, type: String, default: PromoClaimStatus.ACTIVE, index: true }) status!: PromoClaimStatus;
}
export const PromoClaimSchema = SchemaFactory.createForClass(PromoClaim);
PromoClaimSchema.index({ promoId: 1, userId: 1 }, { unique: true });
PromoClaimSchema.index({ status: 1, expiresAt: 1 });
