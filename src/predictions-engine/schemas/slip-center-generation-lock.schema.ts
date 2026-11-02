import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Distributed refresh lease for Slip Center. A unique date key prevents two
 * application instances from generating the same daily allocation concurrently.
 */
@Schema({ timestamps: true, collection: 'slip_center_generation_locks' })
export class SlipCenterGenerationLock {
  @Prop({ required: true, unique: true, trim: true })
  dateKey!: string;

  @Prop({ required: true, trim: true })
  lockToken!: string;

  @Prop({ required: true, type: Date, index: true })
  lockExpiresAt!: Date;
}

export type SlipCenterGenerationLockDocument =
  HydratedDocument<SlipCenterGenerationLock>;

export const SlipCenterGenerationLockSchema = SchemaFactory.createForClass(
  SlipCenterGenerationLock,
);
