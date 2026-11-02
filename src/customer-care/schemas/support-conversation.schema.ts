import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SupportConversationDocument = HydratedDocument<SupportConversation>;
export type SupportConversationStatus = 'OPEN' | 'RESOLVED' | 'CLOSED';
export type HumanSupportStatus = 'AI_HANDLING' | 'WAITING_FOR_ADMIN' | 'ASSIGNED' | 'HUMAN_REPLIED';

@Schema({ timestamps: true, collection: 'support_conversations' })
export class SupportConversation {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ type: String, trim: true, maxlength: 160, default: 'Customer support' })
  title!: string;

  /** Stable customer-care persona assigned when this conversation is created. */
  @Prop({ type: String, trim: true, maxlength: 40 })
  assistantName?: string;

  @Prop({
    type: String,
    enum: ['OPEN', 'RESOLVED', 'CLOSED'],
    default: 'OPEN',
    index: true,
  })
  status!: SupportConversationStatus;

  @Prop({ type: String, trim: true, maxlength: 80, default: 'GENERAL', index: true })
  category!: string;

  @Prop({ type: String, maxlength: 4000, default: '' })
  summary!: string;

  /** Separates AI conversation lifecycle from the human-support assignment lifecycle. */
  @Prop({ type: String, enum: ['AI_HANDLING', 'WAITING_FOR_ADMIN', 'ASSIGNED', 'HUMAN_REPLIED'], default: 'AI_HANDLING', index: true })
  humanSupportStatus!: HumanSupportStatus;

  @Prop({ type: Types.ObjectId, ref: 'User', index: true })
  assignedAdminId?: Types.ObjectId;

  @Prop({ type: Date, index: true })
  claimedAt?: Date;

  @Prop({ type: Date, index: true })
  handoffRequestedAt?: Date;

  @Prop({ type: Date, index: true })
  lastCustomerMessageAt?: Date;

  @Prop({ type: Date, index: true })
  lastSupportReplyAt?: Date;

  @Prop({ type: Date })
  customerLastReadAt?: Date;

  @Prop({ type: Date })
  adminLastReadAt?: Date;

  @Prop({ type: Date, default: Date.now, index: true })
  lastMessageAt!: Date;

  // Internal retention lock prevents a concurrent message from being deleted mid-request.
  @Prop({ type: Boolean, default: false, select: false })
  retentionDeleting!: boolean;

  @Prop({ type: String, select: false })
  retentionLockToken?: string;

  @Prop({ type: Date, select: false })
  retentionDeletionStartedAt?: Date;

  @Prop({ type: String, select: false })
  replyProcessingLockToken?: string;

  @Prop({ type: Date, select: false })
  replyProcessingLockExpiresAt?: Date;

  @Prop({ type: Date })
  resolvedAt?: Date;
}

export const SupportConversationSchema = SchemaFactory.createForClass(SupportConversation);
SupportConversationSchema.index({ userId: 1, lastMessageAt: -1 });
SupportConversationSchema.index({ retentionDeleting: 1, lastMessageAt: 1, createdAt: 1 }, { name: 'support_retention_candidate_lookup' });
SupportConversationSchema.index({ retentionDeleting: 1, retentionDeletionStartedAt: 1 }, { name: 'support_retention_stale_lock_lookup' });

SupportConversationSchema.index({ humanSupportStatus: 1, assignedAdminId: 1, status: 1, lastMessageAt: -1 }, { name: 'support_human_inbox_lookup' });
SupportConversationSchema.index({ userId: 1, humanSupportStatus: 1, lastMessageAt: -1 }, { name: 'support_user_handoff_lookup' });
