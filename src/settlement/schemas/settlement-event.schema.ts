import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { SettlementEventLevel } from '../enums/settlement-event-level.enum';
import { SETTLEMENT_CONFIG } from '../config/settlement.config';

export type SettlementEventDocument = HydratedDocument<SettlementEvent>;

@Schema({ timestamps: true, collection: 'settlement_events' })
export class SettlementEvent {
  @Prop({
    required: true,
    type: String,
    enum: Object.values(SettlementEventLevel),
    index: true,
  })
  level!: SettlementEventLevel;

  @Prop({ required: true, trim: true, index: true })
  action!: string;

  @Prop({ required: true, trim: true, maxlength: 2500 })
  message!: string;

  @Prop({ trim: true, index: true })
  eventId?: string;

  @Prop({ trim: true, index: true })
  jobKey?: string;

  @Prop({ trim: true })
  runId?: string;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;

  @Prop({ type: Date, required: true, default: Date.now })
  occurredAt!: Date;
}

export const SettlementEventSchema =
  SchemaFactory.createForClass(SettlementEvent);
SettlementEventSchema.index(
  { occurredAt: 1 },
  {
    expireAfterSeconds: SETTLEMENT_CONFIG.monitor.eventRetentionDays * 24 * 60 * 60,
    name: 'ttl_settlement_events_occurred_at',
  },
);
SettlementEventSchema.index({ eventId: 1, occurredAt: -1 });

