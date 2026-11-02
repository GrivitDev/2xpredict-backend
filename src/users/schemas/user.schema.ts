import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type UserDocument = HydratedDocument<User>;

export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
}

export enum UserStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  DELETED = 'deleted',
}

@Schema({
  timestamps: true,
})
export class User {
  // ======================
  // BASIC INFO
  // ======================
  @Prop({ required: true, trim: true })
  fullName!: string;

  @Prop({
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true,
  })
  username!: string;

  @Prop({
    required: true,
    unique: true,
    lowercase: true,
    index: true,
  })
  email!: string;

  @Prop({ default: '', index: true })
  phoneNumber!: string;

  @Prop({ required: true, select: false })
  password!: string;

  // ======================
  // LOCATION
  // ======================

  @Prop({
    default: '',
  })
  country!: string;

  @Prop({
    default: '',
    uppercase: true,
  })
  countryCode!: string;

  @Prop({
    type: String,
    enum: ['NGN', 'USD'],
    default: 'USD',
    uppercase: true,
  })
  currency!: 'NGN' | 'USD';

  // ======================
  // ACCOUNT STATUS (NEW)
  // ======================
  @Prop({ enum: UserStatus, default: UserStatus.ACTIVE, index: true })
  status!: UserStatus;

  // ======================
  // VERIFICATION
  // ======================
  @Prop({ default: false })
  isVerified!: boolean;

  // Retained for backwards compatibility only. Unverified registrations do not expire.
  @Prop({ type: Date, default: null })
  verificationExpiresAt?: Date | null;

  // ======================
  // ROLE
  // ======================
  @Prop({ enum: UserRole, default: UserRole.USER, index: true })
  role!: UserRole;

  // ======================
  // PASSWORD RESET
  // ======================
  @Prop()
  passwordResetToken?: string;

  @Prop()
  passwordResetExpires?: Date;

  // ======================
  // LOGIN TRACKING (NEW)
  // ======================
  @Prop()
  lastLoginAt?: Date;

  @Prop({ default: 0 })
  loginCount!: number;

  // ======================
  // BAN SYSTEM (NEW)
  // ======================
  @Prop()
  bannedUntil?: Date;

  @Prop()
  banReason?: string;

  @Prop()
  bannedBy?: string; // admin userId

  // ======================
  // SOFT DELETE (NEW)
  // ======================
  @Prop({ default: false })
  isDeleted!: boolean;

  @Prop()
  deletedAt?: Date;

  @Prop()
  deletedBy?: string;

  // ======================
  // REFERRAL SYSTEM
  // ======================

  @Prop({
    index: true,
  })
  referredBy?: string; // User ID of referrer

  @Prop({
    trim: true,
  })
  pendingPromoCode?: string;

  @Prop({
    default: 0,
  })
  successfulReferrals!: number;
}

export const UserSchema = SchemaFactory.createForClass(User);
