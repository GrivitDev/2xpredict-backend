import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CustomerCareJobDocument = HydratedDocument<CustomerCareJob>;
export type CustomerCareJobType = 'DAILY_PICKS' | 'PROMOTION' | 'INCIDENT_ALERT' | 'SUPPORT_NOTIFICATION';

@Schema({ timestamps: true, collection: 'customer_care_jobs' })
export class CustomerCareJob {
  @Prop({ type: String, required: true, trim: true })
  jobKey!: string;

  @Prop({ type: String, enum: ['DAILY_PICKS', 'PROMOTION', 'INCIDENT_ALERT', 'SUPPORT_NOTIFICATION'], required: true, index: true })
  type!: CustomerCareJobType;

  @Prop({ type: String, required: true, index: true })
  dateKey!: string;

  @Prop({ type: String, default: '' })
  sourceId!: string;

  @Prop({ type: Object, default: {} })
  payload!: Record<string, unknown>;

  @Prop({ type: String, enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'], default: 'PENDING', index: true })
  status!: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

  @Prop({ type: Date, default: Date.now, index: true })
  scheduledAt!: Date;

  @Prop({ type: Date, index: true })
  leaseExpiresAt?: Date;

  @Prop({ type: Number, min: 0, default: 0 })
  attempts!: number;

  @Prop({ type: String, maxlength: 1200, default: '' })
  lastError!: string;

  @Prop({ type: Date })
  completedAt?: Date;
}

export const CustomerCareJobSchema = SchemaFactory.createForClass(CustomerCareJob);
CustomerCareJobSchema.index({ jobKey: 1 }, { unique: true, name: 'jobKey_1' });
CustomerCareJobSchema.index({ status: 1, scheduledAt: 1, leaseExpiresAt: 1 });
CustomerCareJobSchema.index({ status: 1, updatedAt: 1 }, { name: 'customer_care_terminal_job_retention_lookup' });
