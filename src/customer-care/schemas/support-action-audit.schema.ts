import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SupportActionAuditDocument = HydratedDocument<SupportActionAudit>;

@Schema({ timestamps: true, collection: 'support_action_audits' })
export class SupportActionAudit {
  @Prop({ type: Types.ObjectId, ref: 'SupportConversation', index: true })
  conversationId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', index: true })
  userId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', index: true })
  actorId?: Types.ObjectId;

  @Prop({ type: String, enum: ['USER', 'ADMIN', 'AI', 'SYSTEM'], default: 'AI', index: true })
  actorRole!: 'USER' | 'ADMIN' | 'AI' | 'SYSTEM';

  @Prop({ type: String, required: true, trim: true, maxlength: 100, index: true })
  actionName!: string;

  @Prop({ type: String, enum: ['DIAGNOSTIC', 'REPAIR', 'ESCALATION', 'BROADCAST'], required: true, index: true })
  actionType!: 'DIAGNOSTIC' | 'REPAIR' | 'ESCALATION' | 'BROADCAST';

  @Prop({ type: String, enum: ['STARTED', 'SUCCEEDED', 'FAILED', 'DENIED', 'SKIPPED'], required: true, index: true })
  outcome!: 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'DENIED' | 'SKIPPED';

  @Prop({ type: String, maxlength: 2000, default: '' })
  summary!: string;

  @Prop({ type: Object, default: {} })
  details!: Record<string, unknown>;

  @Prop({ type: Number, min: 0, default: 0 })
  durationMs!: number;
}

export const SupportActionAuditSchema = SchemaFactory.createForClass(SupportActionAudit);
SupportActionAuditSchema.index({ createdAt: -1, actionType: 1 });
SupportActionAuditSchema.index({ actionName: 1, createdAt: -1 }, { name: 'support_action_latest_by_name' });
