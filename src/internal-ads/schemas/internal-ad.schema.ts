import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { HydratedDocument } from 'mongoose';

import { DisplayLevel } from '../enums/display-level.enum';

export type InternalAdDocument = HydratedDocument<InternalAd>;

@Schema({
  _id: false,
})
export class AdAction {
  @Prop({ required: true, trim: true })
  label!: string;

  @Prop({ required: true, trim: true })
  url!: string;
}

const AdActionSchema = SchemaFactory.createForClass(AdAction);

@Schema({
  timestamps: true,
})
export class InternalAd {
  @Prop({
    required: true,
    trim: true,
  })
  title!: string;

  @Prop({
    default: '',
    trim: true,
  })
  subtitle!: string;

  @Prop({
    default: '',
    trim: true,
  })
  message!: string;

  @Prop({
    type: [String],
    default: [],
  })
  description!: string[];

  @Prop({
    type: [String],
    default: [],
  })
  instructions!: string[];

  @Prop({
    type: [AdActionSchema],
    default: [],
  })
  actions!: AdAction[];

  @Prop({
    default: '',
  })
  image!: string;

  @Prop({
    type: String,
    enum: DisplayLevel,
    default: DisplayLevel.MEDIUM,
    index: true,
  })
  displayLevel!: DisplayLevel;

  @Prop({
    default: 0,
    index: true,
  })
  sortOrder!: number;

  @Prop({
    default: true,
    index: true,
  })
  isActive!: boolean;

  @Prop({
    default: Date.now,
    index: true,
  })
  startDate!: Date;

  @Prop({
    default: () => new Date('2099-12-31'),
    index: true,
  })
  endDate!: Date;
}

export const InternalAdSchema = SchemaFactory.createForClass(InternalAd);

