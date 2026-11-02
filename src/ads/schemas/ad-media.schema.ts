import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export enum AdMediaType {
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
}

@Schema({ _id: false })
export class AdMedia {
  @Prop({ required: true, trim: true }) url!: string;
  @Prop({ required: true, type: String, enum: Object.values(AdMediaType) })
  type!: AdMediaType;
  @Prop({ type: String, trim: true }) publicId?: string;
  @Prop({ type: String, trim: true }) posterUrl?: string;
  @Prop({ type: String, trim: true }) mimeType?: string;
  @Prop({ type: Number, min: 0, max: 3600 }) durationSeconds?: number;
  @Prop({ type: Boolean, default: false }) autoplay!: boolean;
  @Prop({ type: Boolean, default: true }) muted!: boolean;
  @Prop({ type: Boolean, default: false }) loop!: boolean;
}

export const AdMediaSchema = SchemaFactory.createForClass(AdMedia);
