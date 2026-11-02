import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SupportMessageDocument = HydratedDocument<SupportMessage>;
export type SupportMessageRole = 'USER' | 'ASSISTANT' | 'ADMIN' | 'TOOL' | 'SYSTEM';
export type SupportReplyStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

@Schema({ timestamps: true, collection: 'support_messages' })
export class SupportMessage {
  @Prop({ type: Types.ObjectId, ref: 'SupportConversation', required: true, index: true })
  conversationId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ type: String, enum: ['USER', 'ASSISTANT', 'ADMIN', 'TOOL', 'SYSTEM'], required: true })
  role!: SupportMessageRole;

  @Prop({ type: String, required: true, maxlength: 12000 })
  content!: string;

  /** Client supplied key makes safe network retries idempotent. */
  @Prop({ type: String, trim: true, maxlength: 128 })
  idempotencyKey?: string;

  /** Processing state is set on user messages while the AI reply is queued. */
  @Prop({ type: String, enum: ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'] })
  replyStatus?: SupportReplyStatus;

  /** A unique link ensures retries never create duplicate assistant replies. */
  @Prop({ type: Types.ObjectId, ref: 'SupportMessage' })
  replyToMessageId?: Types.ObjectId;

  @Prop({ type: Object, default: {} })
  metadata!: Record<string, unknown>;
}

export const SupportMessageSchema = SchemaFactory.createForClass(SupportMessage);
SupportMessageSchema.index({ conversationId: 1, createdAt: 1 });
SupportMessageSchema.index({ userId: 1, createdAt: -1 });
SupportMessageSchema.index({ userId: 1, role: 1, createdAt: -1 }, { name: 'support_user_role_message_time_lookup' });
SupportMessageSchema.index({ conversationId: 1, userId: 1, role: 1, createdAt: -1 }, { name: 'support_conversation_history_lookup' });
SupportMessageSchema.index({ conversationId: 1, role: 1, replyStatus: 1 }, { name: 'support_active_reply_retention_lookup' });
SupportMessageSchema.index(
  { userId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } }, name: 'uniq_support_user_idempotency_key' },
);
SupportMessageSchema.index(
  { replyToMessageId: 1 },
  { unique: true, partialFilterExpression: { replyToMessageId: { $type: 'objectId' } }, name: 'uniq_support_reply_per_user_message' },
);
