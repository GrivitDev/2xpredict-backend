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

  /** HMAC-SHA256 code digest. Raw OTPs are never stored for newly issued codes. */
  @Prop({ type: String, select: false, default: undefined })
  codeHash?: string;

  /** Legacy field retained only to permit already-issued codes to finish during rollout. */
  @Prop({ type: String, select: false, default: undefined })
  code?: string;

  @Prop({ type: String, enum: Object.values(OtpPurpose), default: OtpPurpose.ACCOUNT_VERIFICATION, index: true })
  purpose!: OtpPurpose;

  @Prop({ type: String, default: undefined, index: true })
  userId?: string;

  @Prop({ type: String, lowercase: true, trim: true, default: undefined })
  targetEmail?: string;

  /** One active OTP per purpose and user; unset atomically when consumed. */
  @Prop({ type: String, default: undefined })
  activeKey?: string;

  @Prop({ type: Number, default: 0 })
  attempts!: number;

  @Prop({ type: Date, default: undefined })
  lockedUntil?: Date;

  /** Short processing lease prevents concurrent requests consuming one OTP twice. */
  @Prop({ type: Date, default: undefined })
  processingUntil?: Date;

  @Prop({ type: String, default: undefined })
  processingToken?: string;

  @Prop({ type: Date, default: undefined })
  consumedAt?: Date;

  // MongoDB TTL cleanup is asynchronous. Services also enforce the 20-minute age.
  @Prop({ type: Date, default: Date.now, expires: 1200, index: true })
  createdAt!: Date;
}

export const OtpSchema = SchemaFactory.createForClass(Otp);
OtpSchema.index({ userId: 1, purpose: 1, createdAt: -1 });
OtpSchema.index({ email: 1, purpose: 1, createdAt: -1 });
OtpSchema.index(
  { activeKey: 1 },
  { unique: true, sparse: true, name: 'uniq_otp_active_key' },
);
