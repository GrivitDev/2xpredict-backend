import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ResendEmailProviderEventDocument = HydratedDocument<ResendEmailProviderEvent>;

export enum ResendEmailProviderEventStatus {
  PENDING = 'PENDING',
  PROCESSED = 'PROCESSED',
  IGNORED = 'IGNORED',
}

/** Minimal provider event ledger. It stores no recipient address or email body. */
@Schema({ timestamps: true, collection: 'notification_email_provider_events', minimize: false })
export class ResendEmailProviderEvent {
  @Prop({ type: String, required: true, unique: true, maxlength: 160 })
  eventId!: string;

  @Prop({ type: String, required: true, maxlength: 100 })
  eventType!: string;

  @Prop({ type: String, default: null, maxlength: 160, index: true })
  providerMessageId?: string | null;

  @Prop({ type: Date, default: Date.now })
  occurredAt!: Date;

  @Prop({ type: String, enum: Object.values(ResendEmailProviderEventStatus), default: ResendEmailProviderEventStatus.PENDING, index: true })
  status!: ResendEmailProviderEventStatus;

  @Prop({ type: Date, default: null })
  processedAt?: Date | null;

  @Prop({ type: String, default: null, maxlength: 1000 })
  lastError?: string | null;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;
}

export const ResendEmailProviderEventSchema = SchemaFactory.createForClass(ResendEmailProviderEvent);
ResendEmailProviderEventSchema.index({ status: 1, providerMessageId: 1, occurredAt: 1 }, { name: 'idx_notification_email_provider_event_reconcile' });
ResendEmailProviderEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_notification_email_provider_events_18_months' });
