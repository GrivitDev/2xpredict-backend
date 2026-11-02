import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type AdminUserAuditDocument = HydratedDocument<AdminUserAudit>;

@Schema({ timestamps: true, collection: 'admin_user_audits' })
export class AdminUserAudit {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  adminId!: Types.ObjectId;

  @Prop({ required: true, enum: ['suspend', 'activate', 'delete', 'logout_all', 'revoke_session'] })
  action!: string;

  @Prop({ type: String, default: '' })
  reason!: string;

  @Prop({ type: String, default: null })
  targetId?: string | null;

  @Prop({ type: Object, default: {} })
  metadata!: Record<string, unknown>;
}

export const AdminUserAuditSchema = SchemaFactory.createForClass(AdminUserAudit);
AdminUserAuditSchema.index({ userId: 1, createdAt: -1 });
