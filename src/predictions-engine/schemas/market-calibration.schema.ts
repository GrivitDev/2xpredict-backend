import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ timestamps: true, collection: 'predictions_engine_calibrations' })
export class MarketCalibration {
  @Prop({ required: true, trim: true, index: true })
  marketKey!: string;

  @Prop({ required: true, trim: true, index: true })
  modelVersion!: string;

  @Prop({ type: Number, default: 0, min: 0 })
  sampleSize!: number;

  @Prop({ type: Number, min: 0, max: 1 })
  averagePredictedProbability?: number;

  @Prop({ type: Number, min: 0, max: 1 })
  observedSuccessRate?: number;

  @Prop({ type: Number, min: 0, max: 1 })
  brierScore?: number;

  @Prop({ type: Number, min: 0, max: 1 })
  calibrationError?: number;

  /** Mean logarithmic loss; strongly penalizes confident incorrect recommendations. */
  @Prop({ type: Number, min: 0 })
  logLoss?: number;

  /** Legacy mean-bias correction retained for monitoring and compatibility. */
  @Prop({ type: Number, min: -0.1, max: 0.1, default: 0 })
  probabilityAdjustment!: number;

  /** Ridge-regularized logistic recalibration coefficient. */
  @Prop({ type: Number, min: -1.25, max: 1.25, default: 0 })
  calibrationIntercept!: number;

  /** Ridge-regularized logistic recalibration slope; 1 is the identity transform. */
  @Prop({ type: Number, min: 0.35, max: 2.5, default: 1 })
  calibrationSlope!: number;

  @Prop({ type: Number, min: 0, max: 100, default: 0 })
  reliabilityScore!: number;

  @Prop({ type: Boolean, default: false, index: true })
  active!: boolean;

  @Prop({ type: Date })
  lastCalculatedAt?: Date;
}
export type MarketCalibrationDocument = HydratedDocument<MarketCalibration>;
export const MarketCalibrationSchema =
  SchemaFactory.createForClass(MarketCalibration);
MarketCalibrationSchema.index(
  { marketKey: 1, modelVersion: 1 },
  { unique: true },
);


