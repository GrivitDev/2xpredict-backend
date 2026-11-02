import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type CustomerCareReplyJobDocument = HydratedDocument<CustomerCareReplyJob>;
export type CustomerCareReplyJobStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

@Schema({ timestamps: true, collection: 'customer_care_reply_jobs' })
export class CustomerCareReplyJob {
  @Prop({ type: String, required: true, trim: true })
  jobKey!: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'SupportConversation', required: true, index: true })
  conversationId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'SupportMessage', required: true, index: true })
  userMessageId!: Types.ObjectId;

  @Prop({ type: String, enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'], default: 'PENDING', index: true })
  status!: CustomerCareReplyJobStatus;

  @Prop({ type: Number, min: 0, default: 0 })
  attempts!: number;

  @Prop({ type: Date, default: Date.now, index: true })
  scheduledAt!: Date;

  @Prop({ type: Date, index: true })
  leaseExpiresAt?: Date;

  @Prop({ type: String, trim: true, maxlength: 100 })
  claimToken?: string;

  @Prop({ type: String, maxlength: 1200, default: '' })
  lastError!: string;

  @Prop({ type: Date })
  completedAt?: Date;
}

export const CustomerCareReplyJobSchema = SchemaFactory.createForClass(CustomerCareReplyJob);
CustomerCareReplyJobSchema.index({ jobKey: 1 }, { unique: true, name: 'jobKey_1' });
CustomerCareReplyJobSchema.index({ status: 1, scheduledAt: 1, createdAt: 1 }, { name: 'support_reply_queue_order' });
CustomerCareReplyJobSchema.index({ status: 1, leaseExpiresAt: 1 }, { name: 'support_reply_expired_lease_lookup' });
CustomerCareReplyJobSchema.index({ conversationId: 1, status: 1, createdAt: 1 }, { name: 'support_reply_conversation_order' });
CustomerCareReplyJobSchema.index({ status: 1, updatedAt: 1 }, { name: 'support_reply_terminal_retention_lookup' });
CustomerCareReplyJobSchema.index({ completedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'ttl_customer_care_reply_job_terminal_90d' });
