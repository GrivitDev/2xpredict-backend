import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { AdPage } from '../enums/ad-page.enum';
import { AdPosition } from '../enums/ad-position.enum';
import { AdTrigger } from '../enums/ad-trigger.enum';
import { AdDevice } from '../enums/ad-device.enum';

@Schema({ _id: false })
export class AdDisplay {
  @Prop({ required: true, enum: Object.values(AdPage) }) page!: AdPage;
  @Prop({ required: true, enum: Object.values(AdPosition) })
  position!: AdPosition;
  @Prop({
    required: true,
    enum: Object.values(AdTrigger),
    default: AdTrigger.ALWAYS,
  })
  trigger!: AdTrigger;
  @Prop({
    required: true,
    enum: Object.values(AdDevice),
    default: AdDevice.ALL,
  })
  device!: AdDevice;
  @Prop({ default: false }) fixed!: boolean;
  @Prop({ default: 1, min: 1 }) displayOrder!: number;
  @Prop({ type: Number, min: 0, max: 4000 }) width?: number;
  @Prop({ type: Number, min: 0, max: 4000 }) height?: number;
  @Prop({ type: Number, min: 0, max: 100 }) widthPercent?: number;
  @Prop({ type: Number, min: 0, max: 100 }) maxWidthPercent?: number;
  @Prop({ type: Number, min: 0, max: 4000 }) maxWidth?: number;
  @Prop({ type: Number, min: 0, max: 4000 }) maxHeight?: number;
  @Prop({ type: String, trim: true }) aspectRatio?: string;
  @Prop({ type: String, trim: true }) objectFit?: 'contain' | 'cover' | 'fill';
}

export const AdDisplaySchema = SchemaFactory.createForClass(AdDisplay);
