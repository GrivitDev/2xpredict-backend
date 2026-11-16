import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { DisplayLevel } from '../enums/display-level.enum';
import { InternalAdPlacement } from '../enums/internal-ad-placement.enum';

export type InternalAdDocument = HydratedDocument<InternalAd>;

@Schema({ _id: false })
export class AdAction {
  @Prop({ required: true, trim: true, maxlength: 64 })
  label!: string;

  @Prop({ required: true, trim: true, maxlength: 2048 })
  url!: string;
}

const AdActionSchema = SchemaFactory.createForClass(AdAction);

@Schema({ timestamps: true })
export class InternalAd {
  @Prop({ required: true, trim: true, maxlength: 120 })
  title!: string;

  @Prop({ default: '', trim: true, maxlength: 180 })
  subtitle!: string;

  @Prop({ default: '', trim: true, maxlength: 1200 })
  message!: string;

  @Prop({ type: [String], default: [] })
  description!: string[];

  @Prop({ type: [String], default: [] })
  instructions!: string[];

  @Prop({ type: [AdActionSchema], default: [] })
  actions!: AdAction[];

  @Prop({ default: '' })
  image!: string;

  /** New records target the existing web surface unless Telegram is selected explicitly. */
  @Prop({
    type: [String],
    enum: Object.values(InternalAdPlacement),
    default: [InternalAdPlacement.WEB],
    index: true,
  })
  placements!: InternalAdPlacement[];

  @Prop({
    type: String,
    enum: DisplayLevel,
    default: DisplayLevel.MEDIUM,
    index: true,
  })
  displayLevel!: DisplayLevel;

  @Prop({ default: 0, index: true })
  sortOrder!: number;

  @Prop({ default: true, index: true })
  isActive!: boolean;

  @Prop({ default: Date.now, index: true })
  startDate!: Date;

  @Prop({ default: () => new Date('2099-12-31'), index: true })
  endDate!: Date;

  /** Delivery rotation metadata; it does not control ad eligibility. */
  @Prop({ type: Date, default: null, index: true })
  lastTelegramSentAt?: Date | null;

  @Prop({ type: Number, default: null })
  lastTelegramMessageId?: number | null;
}

export const InternalAdSchema = SchemaFactory.createForClass(InternalAd);
