import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { PredictionEventLevel } from '../enums/prediction-event-level.enum';
import { EngineEventType } from '../enums/engine-event-type.enum';

@Schema({ timestamps: true, collection: 'predictions_engine_events' })
export class PredictionEngineEvent {
  @Prop({
    required: true,
    type: String,
    enum: Object.values(PredictionEventLevel),
    index: true,
  })
  level!: PredictionEventLevel;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(EngineEventType),
    index: true,
  })
  type!: EngineEventType;

  @Prop({ type: String, index: true })
  eventId?: string;

  @Prop({ type: String, index: true })
  runId?: string;

  @Prop({ required: true, trim: true })
  message!: string;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;

  @Prop({ required: true, type: Date, default: Date.now })
  occurredAt!: Date;
}
export type PredictionEngineEventDocument =
  HydratedDocument<PredictionEngineEvent>;
export const PredictionEngineEventSchema = SchemaFactory.createForClass(
  PredictionEngineEvent,
);
PredictionEngineEventSchema.index({ occurredAt: -1 });
PredictionEngineEventSchema.index(
  { occurredAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 45 },
);

