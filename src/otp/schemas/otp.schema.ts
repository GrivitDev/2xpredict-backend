import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OtpDocument = HydratedDocument<Otp>;

export enum OtpPurpose {
  ACCOUNT_VERIFICATION = 'account_verification',
  EMAIL_CHANGE_CURRENT = 'email_change_current',
  EMAIL_CHANGE_NEW = 'email_change_new',
}

@Schema({ timestamps: true, collection: 'otps' })
export class Otp {
  @Prop({ required: true, lowercase: true, trim: true, index: true, type: String })
  email!: string;

  @Prop({ required: true, type: String })
  code!: string;

  @Prop({ type: String, enum: Object.values(OtpPurpose), default: OtpPurpose.ACCOUNT_VERIFICATION, index: true })
  purpose!: OtpPurpose;

  @Prop({ type: String, default: undefined, index: true })
  userId?: string;

  @Prop({ type: String, lowercase: true, trim: true, default: undefined })
  targetEmail?: string;

  // All OTP purposes expire after 20 minutes. The application also checks age
  // explicitly because MongoDB TTL cleanup runs asynchronously.
  @Prop({ type: Date, default: Date.now, expires: 1200, index: true })
  createdAt!: Date;
}

export const OtpSchema = SchemaFactory.createForClass(Otp);
OtpSchema.index({ userId: 1, purpose: 1, createdAt: -1 });
OtpSchema.index({ email: 1, purpose: 1, createdAt: -1 });
