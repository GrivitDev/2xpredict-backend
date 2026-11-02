import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  BetLabEventCategory,
  BetLabEventLevel,
} from '../enums/bet-lab-event.enum';

export type BetLabEventDocument = HydratedDocument<BetLabEvent>;

@Schema({ timestamps: true, collection: 'bet_lab_events' })
export class BetLabEvent {
  @Prop({
    required: true,
    type: String,
    enum: Object.values(BetLabEventLevel),
    index: true,
  })
  level!: BetLabEventLevel;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(BetLabEventCategory),
    index: true,
  })
  category!: BetLabEventCategory;

  @Prop({ required: true, trim: true, index: true })
  action!: string;

  @Prop({ required: true, trim: true, maxlength: 2000 })
  message!: string;

  @Prop({ trim: true, index: true })
  userId?: string;

  @Prop({ trim: true, index: true })
  eventId?: string;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;
}

export const BetLabEventSchema = SchemaFactory.createForClass(BetLabEvent);
BetLabEventSchema.index({ createdAt: -1 });
BetLabEventSchema.index({ level: 1, createdAt: -1 });
