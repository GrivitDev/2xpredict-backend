import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { PredictionRunStatus } from '../enums/prediction-run-status.enum';

@Schema({ timestamps: true, collection: 'predictions_engine_runs' })
export class PredictionRun {
  @Prop({ required: true, trim: true, index: true })
  runId!: string;

  @Prop({ required: true, trim: true, index: true })
  eventId!: string;

  @Prop({ required: true, trim: true, lowercase: true, index: true })
  leagueId!: string;

  @Prop({ required: true, type: Date, index: true })
  fixtureDate!: Date;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(PredictionRunStatus),
    index: true,
  })
  status!: PredictionRunStatus;

  @Prop({ required: true, trim: true })
  modelVersion!: string;

  @Prop({ required: true, type: Date, index: true })
  startedAt!: Date;

  @Prop({ type: Date, index: true })
  completedAt?: Date;

  @Prop({ type: Number, min: 0 })
  durationMs?: number;

  @Prop({ type: Number, default: 0 })
  totalMarkets!: number;

  @Prop({ type: Number, default: 0 })
  calculatedMarkets!: number;

  @Prop({ type: Number, default: 0 })
  partialMarkets!: number;

  @Prop({ type: Number, default: 0 })
  unavailableMarkets!: number;

  @Prop({ type: Number, default: 0 })
  failedMarkets!: number;

  @Prop({ type: Number, default: 0 })
  totalSelections!: number;

  @Prop({ type: Number, default: 0 })
  calculatedSelections!: number;

  @Prop({ type: Number, min: 0, max: 98 })
  generalConfidence?: number;

  @Prop({ type: Number, min: 0 })
  expectedHomeGoals?: number;

  @Prop({ type: Number, min: 0 })
  expectedAwayGoals?: number;

  @Prop({ type: Number, min: 0, max: 1 })
  oddsCoverage?: number;

  @Prop({ type: Number, min: 0, max: 1 })
  dataQuality?: number;

  @Prop({ type: [String], default: [] })
  diagnostics!: string[];

  @Prop({ type: String })
  errorMessage?: string;
}
export type PredictionRunDocument = HydratedDocument<PredictionRun>;
export const PredictionRunSchema = SchemaFactory.createForClass(PredictionRun);
PredictionRunSchema.index({ eventId: 1, startedAt: -1 });
PredictionRunSchema.index({ status: 1, startedAt: -1 });
PredictionRunSchema.index({ leagueId: 1, fixtureDate: 1 });



