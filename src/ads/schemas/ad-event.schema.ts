import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { AdEventType } from '../enums/ad-event-type.enum';
import { AdAudience } from '../enums/ad-audience.enum';
import { AdPage } from '../enums/ad-page.enum';
import { AdPosition } from '../enums/ad-position.enum';
import { AdDevice } from '../enums/ad-device.enum';

export type AdEventDocument = HydratedDocument<AdEvent>;

@Schema({ timestamps: true, collection: 'ads_events' })
export class AdEvent {
  @Prop({ type: Types.ObjectId, ref: 'Ad', required: true, index: true })
  adId!: Types.ObjectId;
  @Prop({ required: true, enum: Object.values(AdEventType), index: true })
  type!: AdEventType;
  @Prop({ required: true, trim: true, maxlength: 120 }) eventKey!: string;
  /** Anonymous visitor/session identifiers are SHA-256 hashes, never raw browser identifiers. */
  @Prop({ type: String, index: true, maxlength: 64 }) visitorKeyHash?: string;
  @Prop({ type: String, index: true, maxlength: 64 }) sessionKeyHash?: string;
  @Prop({ type: String, index: true }) userId?: string;
  @Prop({ type: String, maxlength: 100 }) placement?: string;
  @Prop({ type: String, enum: Object.values(AdPage) }) page?: AdPage;
  @Prop({ type: String, enum: Object.values(AdPosition) })
  position?: AdPosition;
  @Prop({ type: String, enum: Object.values(AdDevice) }) device?: AdDevice;
  @Prop({ type: String, enum: Object.values(AdAudience) })
  audience?: AdAudience;
  @Prop({ type: String, maxlength: 80 }) conversionType?: string;
  @Prop({ type: Number, min: 0 }) conversionValue?: number;
  @Prop({ type: String, enum: ['NGN', 'USD'] }) currency?: 'NGN' | 'USD';
  @Prop({ type: Object, default: {} }) metadata!: Record<string, unknown>;
}

export const AdEventSchema = SchemaFactory.createForClass(AdEvent);
AdEventSchema.index({ adId: 1, type: 1, createdAt: -1 });
AdEventSchema.index(
  { adId: 1, eventKey: 1, type: 1 },
  { unique: true, name: 'uniq_ad_event_key_type' },
);
AdEventSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 180 },
);
