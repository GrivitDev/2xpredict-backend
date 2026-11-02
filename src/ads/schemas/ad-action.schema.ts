import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ _id: false })
export class AdAction {
  @Prop({ required: true, trim: true, maxlength: 50 })
  label!: string;

  @Prop({ required: true, trim: true, maxlength: 500 })
  url!: string;
}

export const AdActionSchema = SchemaFactory.createForClass(AdAction);
