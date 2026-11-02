import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { AdType } from '../enums/ad-type.enum';
import { ExternalAdFrequency } from '../enums/external-ad-frequency.enum';

const DEFAULT_AUDIENCES = {
  GUEST: true,
  FREE: true,
  REGULAR: true,
  VIP: false,
  PREMIUM: false,
};
const DEFAULT_TYPES = {
  [AdType.BANNER]: true,
  [AdType.INTERSTITIAL]: true,
  [AdType.NATIVE]: true,
  [AdType.REWARDED]: false,
  [AdType.POPUP]: false,
  [AdType.STICKY]: true,
  [AdType.VIDEO]: false,
};

export type ExternalAdPolicyDocument = HydratedDocument<ExternalAdPolicyConfig>;

@Schema({ timestamps: true, collection: 'external_ad_policy' })
export class ExternalAdPolicyConfig {
  @Prop({ type: String, default: 'global', unique: true, index: true })
  key!: string;
  @Prop({ type: Boolean, default: true }) enabled!: boolean;
  @Prop({ type: Object, default: DEFAULT_AUDIENCES }) audiences!: Record<
    string,
    boolean
  >;
  @Prop({
    type: String,
    enum: Object.values(ExternalAdFrequency),
    default: ExternalAdFrequency.NORMAL,
  })
  frequency!: ExternalAdFrequency;
  @Prop({ type: Number, min: 0, max: 3600, default: 300 })
  refreshIntervalSeconds!: number;
  @Prop({ type: Number, min: 0, max: 20, default: 3 })
  maxImpressionsPerSession!: number;
  @Prop({ type: Number, min: 0, max: 100, default: 20 })
  maxImpressionsPerDay!: number;
  @Prop({ type: Object, default: DEFAULT_TYPES }) allowedTypes!: Record<
    AdType,
    boolean
  >;
  /** Backward-compatible toggles still read by previous frontend builds. */
  @Prop({ type: Boolean, default: true }) allowBanner!: boolean;
  @Prop({ type: Boolean, default: true }) allowNative!: boolean;
  @Prop({ type: Boolean, default: true }) allowInterstitial!: boolean;
  @Prop({ type: Boolean, default: false }) allowPopup!: boolean;
  @Prop({ type: Boolean, default: false }) allowRewarded!: boolean;
  @Prop({ type: Boolean, default: true }) allowSticky!: boolean;
  @Prop({ type: Boolean, default: false }) allowVideo!: boolean;
  @Prop({ type: String }) updatedBy?: string;
}

export const ExternalAdPolicySchema = SchemaFactory.createForClass(
  ExternalAdPolicyConfig,
);
