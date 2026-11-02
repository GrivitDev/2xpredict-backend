import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ _id: false })
export class AdImage {
  @Prop({ required: true, trim: true }) url!: string;
  @Prop({ required: true, trim: true }) publicId!: string;
  @Prop({ required: true, min: 1 }) width!: number;
  @Prop({ required: true, min: 1 }) height!: number;
  @Prop({ required: true, trim: true }) format!: string;
  @Prop({ required: true, min: 0 }) bytes!: number;
}

export const AdImageSchema = SchemaFactory.createForClass(AdImage);
