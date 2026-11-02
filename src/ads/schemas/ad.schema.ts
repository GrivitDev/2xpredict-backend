import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { AdAction, AdActionSchema } from './ad-action.schema';
import { AdDisplay, AdDisplaySchema } from './ad-display.schema';
import { AdImage, AdImageSchema } from './ad-image.schema';
import { AdMedia, AdMediaSchema } from './ad-media.schema';
import { AdAudience } from '../enums/ad-audience.enum';
import { AdType } from '../enums/ad-type.enum';
import { AdContentSource } from '../enums/ad-content-source.enum';
import { AdAutomationKey } from '../enums/ad-automation-key.enum';
import type {
  AdAudienceVisibility,
  AdTargeting,
} from '../interfaces/ad-content-visibility.interface';

export type AdDocument = HydratedDocument<Ad>;

@Schema({ timestamps: true, collection: 'ads' })
export class Ad {
  @Prop({ required: true, trim: true, maxlength: 150 }) title!: string;
  @Prop({ trim: true, default: '', maxlength: 150 }) subTitle?: string;
  @Prop({ trim: true, default: '', maxlength: 2000 }) description?: string;
  @Prop({ type: [String], default: [] }) instructions!: string[];
  @Prop({ type: AdImageSchema }) image?: AdImage;
  @Prop({ type: AdMediaSchema }) media?: AdMedia;
  @Prop({ type: [AdActionSchema], default: [] }) actions!: AdAction[];
  @Prop({ type: [AdDisplaySchema], required: true, default: [] })
  displays!: AdDisplay[];
  @Prop({
    type: String,
    enum: Object.values(AdType),
    default: AdType.BANNER,
    index: true,
  })
  type!: AdType;
  @Prop({
    type: String,
    enum: Object.values(AdContentSource),
    default: AdContentSource.CUSTOM,
    index: true,
  })
  contentSource!: AdContentSource;
  @Prop({ type: String, index: true }) sourceId?: string;
  @Prop({ type: Object, default: {} }) contentVisibility!: AdAudienceVisibility;
  @Prop({ type: Object, default: {} }) design!: Record<string, unknown>;
  @Prop({ type: Object, default: {} }) targeting!: AdTargeting;
  @Prop({ min: 1, max: 10, default: 5, index: true }) priority!: number;
  @Prop({
    type: [String],
    enum: Object.values(AdAudience),
    default: [AdAudience.ALL],
    index: true,
  })
  audience!: AdAudience[];
  @Prop({ type: Boolean, default: true, index: true }) isActive!: boolean;
  @Prop({ type: Boolean, default: false, index: true }) automated!: boolean;
  @Prop({ type: String, enum: Object.values(AdAutomationKey), index: true })
  automationKey?: AdAutomationKey;
  @Prop({ type: Number, min: 0, default: 0 }) impressions!: number;
  @Prop({ type: Number, min: 0, default: 0 }) clicks!: number;
  @Prop({ type: Number, min: 0, default: 0 }) conversions!: number;
  @Prop({ type: Number, min: 0, max: 1000 })
  maxImpressionsPerVisitorPerDay?: number;
  @Prop({ type: Date, index: true }) startDate?: Date;
  @Prop({ type: Date, index: true }) endDate?: Date;
  @Prop({ type: Types.ObjectId, ref: 'User' }) createdBy?: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User' }) updatedBy?: Types.ObjectId;
}

export const AdSchema = SchemaFactory.createForClass(Ad);
AdSchema.index({ isActive: 1, startDate: 1, endDate: 1, priority: -1 });
AdSchema.index({ automated: 1, automationKey: 1, isActive: 1 });
