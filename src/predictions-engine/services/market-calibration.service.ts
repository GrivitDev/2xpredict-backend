import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { MarketPrediction } from '../schemas/market-prediction.schema';
import { MarketCalibration } from '../schemas/market-calibration.schema';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { FOOTBALL_MARKET_CATALOG } from '../catalog/football-market-catalog';
import { PredictionMathUtil } from '../utils/prediction-math.util';

export interface MarketCalibrationAssessment {
  marketKey: string;
  sampleSize: number;
  /** Retained for dashboard/backward compatibility; logistic calibration is used for new assessments. */
  probabilityAdjustment: number;
  calibrationIntercept?: number;
  calibrationSlope?: number;
  reliabilityScore: number;
  logLoss?: number;
  active: boolean;
}

interface CalibrationObservation {
  probability: number;
  actual: 0 | 1;
}

interface LogisticCalibration {
  intercept: number;
  slope: number;
}

function logit(probability: number): number {
  const p = PredictionMathUtil.clamp(probability, 0.000001, 0.999999);
  return Math.log(p / (1 - p));
}

function sigmoid(value: number): number {
  const bounded = PredictionMathUtil.clamp(value, -30, 30);
  return 1 / (1 + Math.exp(-bounded));
}

/**
 * Fits a small, ridge-regularized logistic recalibrator to settled selections.
 * The slope is regularized toward 1 and the intercept toward 0; sparse history
 * therefore cannot radically reshape probabilities. The final correction is
 * also blended back toward the raw model probability according to reliability.
 */
function fitLogisticCalibration(observations: CalibrationObservation[]): LogisticCalibration {
  if (observations.length < 2) return { intercept: 0, slope: 1 };
  const inputs = observations.map((item) => ({ x: logit(item.probability), y: item.actual }));
  const ridge = Math.max(2, 12 * (30 / Math.max(30, observations.length)) ** 0.5);
  let intercept = 0;
  let slope = 1;

  for (let iteration = 0; iteration < 35; iteration += 1) {
    let gradientIntercept = ridge * intercept;
    let gradientSlope = ridge * (slope - 1);
    let h00 = ridge;
    let h01 = 0;
    let h11 = ridge;

    for (const item of inputs) {
      const predicted = sigmoid(intercept + slope * item.x);
      const variance = Math.max(1e-7, predicted * (1 - predicted));
      const residual = predicted - item.y;
      gradientIntercept += residual;
      gradientSlope += residual * item.x;
      h00 += variance;
      h01 += variance * item.x;
      h11 += variance * item.x * item.x;
    }

    const determinant = h00 * h11 - h01 * h01;
    if (!Number.isFinite(determinant) || determinant <= 1e-12) break;
    const stepIntercept = (gradientIntercept * h11 - gradientSlope * h01) / determinant;
    const stepSlope = (gradientSlope * h00 - gradientIntercept * h01) / determinant;
    if (!Number.isFinite(stepIntercept) || !Number.isFinite(stepSlope)) break;

    intercept = PredictionMathUtil.clamp(intercept - stepIntercept, -1.25, 1.25);
    slope = PredictionMathUtil.clamp(slope - stepSlope, 0.35, 2.5);
    if (Math.max(Math.abs(stepIntercept), Math.abs(stepSlope)) < 1e-5) break;
  }

  return {
    intercept: Number(intercept.toFixed(6)),
    slope: Number(slope.toFixed(6)),
  };
}

function expectedCalibrationError(observations: CalibrationObservation[], binCount = 10): number | undefined {
  if (!observations.length) return undefined;
  const sorted = [...observations].sort((a, b) => a.probability - b.probability);
  const effectiveBins = Math.max(1, Math.min(binCount, sorted.length));
  let error = 0;
  for (let bin = 0; bin < effectiveBins; bin += 1) {
    const start = Math.floor((bin * sorted.length) / effectiveBins);
    const end = Math.floor(((bin + 1) * sorted.length) / effectiveBins);
    const items = sorted.slice(start, Math.max(start + 1, end));
    if (!items.length) continue;
    const predicted = items.reduce((sum, item) => sum + item.probability, 0) / items.length;
    const observed = items.reduce((sum, item) => sum + item.actual, 0) / items.length;
    error += (items.length / sorted.length) * Math.abs(predicted - observed);
  }
  return Number(error.toFixed(6));
}

function meanLogLoss(observations: CalibrationObservation[]): number | undefined {
  if (!observations.length) return undefined;
  const epsilon = 1e-6;
  const loss = observations.reduce((sum, item) => {
    const p = PredictionMathUtil.clamp(item.probability, epsilon, 1 - epsilon);
    return sum - (item.actual === 1 ? Math.log(p) : Math.log(1 - p));
  }, 0) / observations.length;
  return Number(loss.toFixed(6));
}

@Injectable()
export class MarketCalibrationService {
  private lastRefreshCheckAt = 0;

  constructor(
    @InjectModel(MarketPrediction.name)
    private readonly predictionModel: Model<MarketPrediction>,
    @InjectModel(MarketCalibration.name)
    private readonly calibrationModel: Model<MarketCalibration>,
  ) {}

  async rebuildMarket(marketKey: string): Promise<Record<string, unknown>> {
    const key = String(marketKey ?? '').trim().toUpperCase();
    if (!key) throw new Error('marketKey is required.');
    const documents = (await this.predictionModel
      .find({
        marketKey: key as MarketPrediction['marketKey'],
        modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
        'selections.actualOutcome': { $in: ['WON', 'LOST'] },
      })
      .select({ selections: 1 })
      .lean()
      .exec()) as Array<{
      selections?: Array<{ probability?: unknown; rawProbability?: unknown; actualOutcome?: string; isFinalSelection?: boolean; recommendationEligible?: boolean }>;
    }>;

    const observations: CalibrationObservation[] = [];
    for (const document of documents) {
      for (const selection of document.selections ?? []) {
        // Calibrate the market engine's selected recommendation, not every unused
        // alternative line/outcome. Counting alternatives would inflate samples and
        // distort reliability toward many correlated outcomes from the same fixture.
        if (selection.isFinalSelection !== true && selection.recommendationEligible !== true) continue;
        // Fit on the pre-calibration probability where available. Falling back to probability
        // keeps historical documents created before rawProbability was persisted readable.
        const probability = Number(selection.rawProbability ?? selection.probability);
        if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) continue;
        if (selection.actualOutcome !== 'WON' && selection.actualOutcome !== 'LOST') continue;
        observations.push({
          probability: PredictionMathUtil.clamp(probability, 0.000001, 0.999999),
          actual: selection.actualOutcome === 'WON' ? 1 : 0,
        });
      }
    }

    const sampleSize = observations.length;
    const averagePredictedProbability = sampleSize
      ? observations.reduce((sum, item) => sum + item.probability, 0) / sampleSize
      : undefined;
    const observedSuccessRate = sampleSize
      ? observations.reduce((sum, item) => sum + item.actual, 0) / sampleSize
      : undefined;
    const brierScore = sampleSize
      ? observations.reduce((sum, item) => sum + (item.probability - item.actual) ** 2, 0) / sampleSize
      : undefined;
    const calibrationError = expectedCalibrationError(observations);
    const logLoss = meanLogLoss(observations);
    const fitted = fitLogisticCalibration(observations);

    const sampleReliability = sampleSize ? 1 - Math.exp(-sampleSize / 40) : 0;
    const brierReliability = brierScore === undefined ? 0 : Math.max(0, 1 - brierScore);
    const calibrationReliability = calibrationError === undefined ? 0 : Math.max(0, 1 - calibrationError * 2);
    // A weighted quality score avoids the old multiplicative penalty making
    // otherwise useful calibrators effectively inert. Log loss remains strongly
    // represented, but a moderately high loss does not collapse reliability to zero.
    const logLossReliability = logLoss === undefined ? 0 : Math.max(0, Math.min(1, Math.exp(-logLoss)));
    const observedFitReliability =
      brierReliability * 0.35 + calibrationReliability * 0.35 + logLossReliability * 0.30;
    const reliabilityScore = Math.round(100 * sampleReliability * observedFitReliability);
    const active = sampleSize >= PREDICTION_ENGINE_CONFIG.calibration.minimumSettledSamples
      && calibrationError !== undefined && logLoss !== undefined;
    const shrinkage = sampleSize / (sampleSize + 80);
    const rawAdjustment = observedSuccessRate === undefined || averagePredictedProbability === undefined
      ? 0
      : (observedSuccessRate - averagePredictedProbability) * shrinkage;
    const probabilityAdjustment = active
      ? Number(Math.max(-0.05, Math.min(0.05, rawAdjustment)).toFixed(4))
      : 0;

    const saved = await this.calibrationModel
      .findOneAndUpdate(
        { marketKey: key, modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion },
        {
          $set: {
            marketKey: key,
            modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
            sampleSize,
            averagePredictedProbability,
            observedSuccessRate,
            brierScore,
            calibrationError,
            logLoss,
            probabilityAdjustment,
            calibrationIntercept: fitted.intercept,
            calibrationSlope: fitted.slope,
            reliabilityScore,
            active,
            lastCalculatedAt: new Date(),
          },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true },
      )
      .lean()
      .exec();

    return {
      marketKey: key,
      modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
      sampleSize,
      averagePredictedProbability,
      observedSuccessRate,
      brierScore,
      expectedCalibrationError: calibrationError,
      logLoss,
      reliabilityScore,
      calibrationIntercept: fitted.intercept,
      calibrationSlope: fitted.slope,
      active,
      probabilityAdjustment,
      note: active
        ? 'Regularized logistic recalibration is active on settled final recommendations only. Correction strength depends on sample size and reliability; calibration never inflates evidence confidence.'
        : `Calibration is observational until at least ${PREDICTION_ENGINE_CONFIG.calibration.minimumSettledSamples} settled final recommendations are available; no probability correction is applied.`,
      saved,
    };
  }

  async getAssessments(): Promise<Map<string, MarketCalibrationAssessment>> {
    const documents = (await this.calibrationModel
      .find({ modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion })
      .select({ marketKey: 1, sampleSize: 1, probabilityAdjustment: 1, calibrationIntercept: 1, calibrationSlope: 1, reliabilityScore: 1, active: 1, logLoss: 1 })
      .lean()
      .exec()) as Array<{
        marketKey: string;
        sampleSize?: number;
        probabilityAdjustment?: number;
        calibrationIntercept?: number;
        calibrationSlope?: number;
        reliabilityScore?: number;
        logLoss?: number;
        active?: boolean;
      }>;
    const entries: Array<[string, MarketCalibrationAssessment]> = documents.map((item) => {
      const marketKey = String(item.marketKey).toUpperCase();
      const sampleSize = Number(item.sampleSize ?? 0);
      const active = item.active === true && sampleSize >= PREDICTION_ENGINE_CONFIG.calibration.minimumSettledSamples;
      const intercept = Number(item.calibrationIntercept);
      const slope = Number(item.calibrationSlope);
      return [marketKey, {
        marketKey,
        sampleSize,
        probabilityAdjustment: active ? Math.max(-0.05, Math.min(0.05, Number(item.probabilityAdjustment ?? 0))) : 0,
        ...(Number.isFinite(intercept) ? { calibrationIntercept: PredictionMathUtil.clamp(intercept, -1.25, 1.25) } : {}),
        ...(Number.isFinite(slope) ? { calibrationSlope: PredictionMathUtil.clamp(slope, 0.35, 2.5) } : {}),
        reliabilityScore: Math.max(0, Math.min(100, Number(item.reliabilityScore ?? 0))),
        ...(Number.isFinite(Number(item.logLoss)) ? { logLoss: Number(item.logLoss) } : {}),
        active,
      }];
    });
    return new Map<string, MarketCalibrationAssessment>(entries);
  }

  adjustProbability(
    marketKey: string,
    probability: number,
    assessments: Map<string, MarketCalibrationAssessment>,
  ): { probability: number; reliabilityScore: number; adjusted: boolean; sampleSize: number } {
    const assessment = assessments.get(String(marketKey).toUpperCase());
    if (!assessment || !assessment.active || assessment.sampleSize < PREDICTION_ENGINE_CONFIG.calibration.minimumSettledSamples || !Number.isFinite(probability)) {
      return { probability, reliabilityScore: assessment?.reliabilityScore ?? 0, adjusted: false, sampleSize: assessment?.sampleSize ?? 0 };
    }

    const raw = PredictionMathUtil.clamp(probability, 0.000001, 0.999999);
    let calibrated: number;
    if (Number.isFinite(assessment.calibrationIntercept) && Number.isFinite(assessment.calibrationSlope)) {
      calibrated = sigmoid(Number(assessment.calibrationIntercept) + Number(assessment.calibrationSlope) * logit(raw));
    } else {
      // Compatibility for older calibration records that predate the logistic coefficients.
      calibrated = PredictionMathUtil.clamp(raw + assessment.probabilityAdjustment, 0.01, 0.99);
    }

    const sampleWeight = assessment.sampleSize / (assessment.sampleSize + 30);
    const reliabilityWeight = Math.max(0, Math.min(1, assessment.reliabilityScore / 100));
    const blendWeight = Math.min(PREDICTION_ENGINE_CONFIG.calibration.maximumCorrectionBlendWeight, sampleWeight * reliabilityWeight);
    const corrected = PredictionMathUtil.clamp(raw + (calibrated - raw) * blendWeight, 0.000001, 0.999999);
    return {
      probability: Number(corrected.toFixed(6)),
      reliabilityScore: assessment.reliabilityScore,
      adjusted: Math.abs(corrected - raw) > 0.000001,
      sampleSize: assessment.sampleSize,
    };
  }

  /**
   * Refresh calibration from current-model settled results without rebuilding on
   * every fixture. The oldest assessment timestamp is checked intentionally: if
   * a rebuild was interrupted, a stale market assessment must trigger recovery.
   * rawProbability stores the uncalibrated model/market blend and avoids recursive fit.
   */
  async refreshAllIfStale(force = false): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (!force && now - this.lastRefreshCheckAt < PREDICTION_ENGINE_CONFIG.calibration.checkIntervalMs) {
      return { skipped: true, reason: 'CHECK_THROTTLED' };
    }
    this.lastRefreshCheckAt = now;

    const minimumSamples = PREDICTION_ENGINE_CONFIG.calibration.minimumSettledSamples;
    const settledAggregate = await this.predictionModel.aggregate<{ count: number }>([
      { $match: { modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion } },
      { $unwind: '$selections' },
      { $match: {
        'selections.actualOutcome': { $in: ['WON', 'LOST'] },
        $or: [
          { 'selections.isFinalSelection': true },
          { 'selections.recommendationEligible': true },
        ],
      } },
      { $count: 'count' },
    ]).exec();
    const settledSamples = Number(settledAggregate[0]?.count ?? 0);
    if (settledSamples < minimumSamples) {
      return { skipped: true, reason: 'INSUFFICIENT_SETTLED_HISTORY', settledSamples, minimumSamples };
    }

    const latest = await this.calibrationModel
      .findOne({ modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion })
      .sort({ lastCalculatedAt: 1 })
      .select({ lastCalculatedAt: 1 })
      .lean()
      .exec() as { lastCalculatedAt?: Date } | null;
    const lastCalculatedAt = latest?.lastCalculatedAt instanceof Date
      ? latest.lastCalculatedAt.getTime()
      : latest?.lastCalculatedAt ? new Date(String(latest.lastCalculatedAt)).getTime() : Number.NaN;
    const intervalMs = PREDICTION_ENGINE_CONFIG.calibration.refreshIntervalMs;
    if (!force && Number.isFinite(lastCalculatedAt) && now - lastCalculatedAt < intervalMs) {
      return { skipped: true, reason: 'CALIBRATION_IS_FRESH', lastCalculatedAt: new Date(lastCalculatedAt).toISOString(), nextRefreshAt: new Date(lastCalculatedAt + intervalMs).toISOString(), settledSamples };
    }

    const results = await this.rebuildAll();
    return {
      skipped: false,
      modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
      settledSamples,
      minimumSamples,
      marketsRefreshed: results.length,
      activeMarkets: results.filter((item) => item.active === true).length,
      refreshedAt: new Date().toISOString(),
    };
  }

  async rebuildAll(): Promise<Record<string, unknown>[]> {
    const historicalKeys = await this.predictionModel
      .distinct('marketKey', {
        modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
        'selections.actualOutcome': { $in: ['WON', 'LOST'] },
      })
      .exec();
    const keys = new Set<string>([
      ...FOOTBALL_MARKET_CATALOG.map((market) => String(market.key)),
      ...historicalKeys.map((key) => String(key)),
    ]);
    const results: Record<string, unknown>[] = [];
    for (const key of keys) results.push(await this.rebuildMarket(key));
    return results;
  }

  async list(): Promise<unknown[]> {
    return this.calibrationModel
      .find({ modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion })
      .sort({ reliabilityScore: -1, sampleSize: -1 })
      .lean()
      .exec();
  }
}



