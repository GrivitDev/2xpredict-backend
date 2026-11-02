import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ timestamps: true, collection: 'predictions_engine_state' })
export class PredictionEngineState {
  @Prop({ required: true, unique: true, trim: true, default: 'main' })
  key!: string;

  @Prop({ required: true, type: Boolean, default: true })
  enabled!: boolean;

  @Prop({ required: true, type: Boolean, default: false })
  workerRunning!: boolean;

  @Prop({ required: true, trim: true })
  modelVersion!: string;

  @Prop({ type: Date })
  lastQueueSyncAt?: Date;

  @Prop({ type: Date })
  lastSuccessfulRunAt?: Date;

  @Prop({ type: Date })
  lastFailedRunAt?: Date;

  @Prop({ type: String })
  lastError?: string;

  @Prop({ type: Number, default: 0 })
  lastScannedFixtures!: number;

  @Prop({ type: Number, default: 0 })
  lastEnqueuedFixtures!: number;

  @Prop({ type: Number, default: 0 })
  processedSinceStart!: number;

  @Prop({ type: Number, default: 0 })
  failedSinceStart!: number;

  @Prop({ type: Date })
  lastProductRefreshAt?: Date;

  @Prop({ type: Date })
  lastCuratedRefreshAt?: Date;

  @Prop({ type: String })
  lastCuratedRefreshStatus?: string;

  @Prop({ type: Number, default: 0 })
  lastCuratedRefreshDurationMs!: number;

  @Prop({ type: Number, default: 0 })
  lastCuratedMatchesScanned!: number;

  @Prop({ type: Number, default: 0 })
  lastCuratedEligibleFixtures!: number;

  @Prop({ type: Number, default: 0 })
  lastCuratedCreated!: number;

  @Prop({ type: Number, default: 0 })
  lastCuratedUpdated!: number;

  @Prop({ type: Number, default: 0 })
  lastCuratedSkipped!: number;

  @Prop({ type: Number, default: 0 })
  lastCuratedRiskRejected!: number;

  @Prop({ type: Number, default: 0 })
  lastCuratedOneSelectionMatches!: number;

  @Prop({ type: Number, default: 0 })
  lastCuratedTwoSelectionMatches!: number;

  @Prop({ type: Number, default: 0 })
  lastCuratedThreeSelectionMatches!: number;

  @Prop({ type: Number, default: 0 })
  lastCuratedPublishedRecordsSupplemented!: number;

  @Prop({ type: Number, default: 0 })
  lastCuratedPublishedRecordsReconciled!: number;

  @Prop({ type: Object, default: {} })
  lastCuratedSkipReasonCounts!: Record<string, number>;

  @Prop({ type: String })
  lastCuratedError?: string;

  @Prop({ type: Date })
  lastSlipRefreshAt?: Date;

  @Prop({ type: String })
  lastSlipRefreshStatus?: string;

  @Prop({ type: Number, default: 0 })
  lastSlipRefreshDurationMs!: number;

  @Prop({ type: Number, default: 0 })
  lastSlipCreatedOrUpdated!: number;

  @Prop({ type: Number, default: 0 })
  lastSlipSkipped!: number;

  @Prop({ type: Number, default: 0 })
  lastSlipFixtureCandidates!: number;

  @Prop({ type: Number, default: 0 })
  lastSlipEligibleFixtures!: number;

  @Prop({ type: Number, default: 0 })
  lastSlipEligibleFixtureDays!: number;

  @Prop({ type: Number, default: 0 })
  lastSlipEligibleEvents!: number;

  @Prop({ type: Number, default: 0 })
  lastSlipPickCenterEventsWithoutEligibleSelections!: number;

  @Prop({ type: [String], default: [] })
  lastSlipPickCenterEventIdsWithoutEligibleSelections!: string[];

  @Prop({ type: Number, default: 0 })
  lastSlipCoveredEvents!: number;

  @Prop({ type: Number, default: 0 })
  lastSlipCoverageEventsRequired!: number;

  @Prop({ type: Number, default: 0 })
  lastSlipCoverageEventsSatisfied!: number;

  @Prop({ type: [String], default: [] })
  lastSlipCoverageEventIdsMissing!: string[];

  @Prop({ type: Number, default: 0 })
  lastSlipCoverageDatesRequired!: number;

  @Prop({ type: Number, default: 0 })
  lastSlipCoverageDatesSatisfied!: number;

  @Prop({ type: [String], default: [] })
  lastSlipCoverageDatesMissing!: string[];

  @Prop({ type: Number, default: 0 })
  lastSlipCoverageSlipsCreated!: number;

  @Prop({ type: Number, default: 0 })
  lastSlipPublishedProductsToday!: number;

  @Prop({ type: Number, default: 0 })
  lastSlipPublishedProductsTomorrow!: number;

  @Prop({ type: String })
  lastSlipTargetDateTodayKey?: string;

  @Prop({ type: String })
  lastSlipTargetDateTomorrowKey?: string;

  @Prop({ type: Number, default: 30 })
  lastSlipTodayTarget!: number;

  @Prop({ type: Number, default: 30 })
  lastSlipTomorrowTarget!: number;

  @Prop({ type: Number, default: 30 })
  lastSlipTodayRemaining!: number;

  @Prop({ type: Number, default: 30 })
  lastSlipTomorrowRemaining!: number;

  /** Deprecated compatibility field. New refreshes always write false. */
  @Prop({ type: Boolean, default: false })
  lastSlipSameDayFixtureCombinationProhibited!: boolean;

  @Prop({ type: String })
  lastSlipError?: string;

  @Prop({ type: Date })
  lastCalibrationRefreshAt?: Date;

  @Prop({ type: String })
  lastCalibrationRefreshStatus?: string;

  @Prop({ type: String })
  lastCalibrationError?: string;

  @Prop({ type: Number, default: 0 })
  lastCalibrationMarketsRefreshed!: number;

  @Prop({ type: Number, default: 0 })
  lastCalibrationActiveMarkets!: number;

}
export type PredictionEngineStateDocument =
  HydratedDocument<PredictionEngineState>;
export const PredictionEngineStateSchema = SchemaFactory.createForClass(
  PredictionEngineState,
);





