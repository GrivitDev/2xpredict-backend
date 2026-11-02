import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SupportIncidentDocument = HydratedDocument<SupportIncident>;

@Schema({ timestamps: true, collection: 'support_incidents' })
export class SupportIncident {
  @Prop({ type: Types.ObjectId, ref: 'SupportConversation', index: true })
  conversationId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', index: true })
  userId?: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 160, index: true })
  fingerprint!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 100, index: true })
  category!: string;

  @Prop({ type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], default: 'MEDIUM', index: true })
  severity!: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

  @Prop({ type: String, enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'], default: 'OPEN', index: true })
  status!: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';

  @Prop({ type: String, required: true, maxlength: 3000 })
  summary!: string;

  @Prop({ type: [String], default: [] })
  evidence!: string[];

  @Prop({ type: [String], default: [] })
  attemptedActions!: string[];

  @Prop({ type: Number, min: 1, default: 1 })
  occurrenceCount!: number;

  @Prop({ type: Date, default: Date.now })
  lastSeenAt!: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  assignedAdminId?: Types.ObjectId;

  @Prop({ type: String, maxlength: 3000, default: '' })
  resolutionNotes!: string;

  @Prop({ type: Date })
  resolvedAt?: Date;

  @Prop({ type: String, enum: ['PENDING', 'SENT', 'FAILED', 'NOT_REQUIRED'], default: 'PENDING' })
  telegramNotificationStatus!: 'PENDING' | 'SENT' | 'FAILED' | 'NOT_REQUIRED';
}

export const SupportIncidentSchema = SchemaFactory.createForClass(SupportIncident);
SupportIncidentSchema.index({ status: 1, severity: -1, lastSeenAt: -1 });
SupportIncidentSchema.index({ fingerprint: 1, status: 1, lastSeenAt: -1 });
SupportIncidentSchema.index({ status: 1, resolvedAt: 1 }, { name: 'support_incident_resolved_retention_lookup' });
