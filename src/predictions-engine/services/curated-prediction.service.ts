import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';

import { PickCenter } from '../schemas/pick-center.schema';
import { CuratedPrediction } from '../schemas/curated-prediction.schema';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { PredictionMathUtil } from '../utils/prediction-math.util';
import { isOddsQuoteFresh } from '../../odds/config/odds.config';
import { PredictionEngineMonitorService } from './prediction-engine-monitor.service';

interface PickCenterSource {
  eventId: string | number;
  leagueId?: string | number | null;
  leagueName?: string | null;
  fixtureDate: Date | string | number;
  retentionExpiresAt?: Date | string | null;
  homeTeamName?: string | null;
  awayTeamName?: string | null;
  modelVersion?: string | null;
  live?: boolean;
  completed?: boolean;
  status?: string;
  selectedMarkets?: unknown;
}

interface CuratedSelectionCandidate {
  eventId: string;
  leagueId: string;
  leagueName: string;
  fixtureDate: Date;
  retentionExpiresAt?: Date;
  homeTeamName: string;
  awayTeamName: string;
  marketPredictionId: string;
  marketKey: string;
  marketName: string;
  selectionKey: string;
  selectionName: string;
  probability: number;
  confidence: number;
  decimalOdds?: number;
  fairOdds?: number;
  priceType?: 'PROVIDER' | 'ESTIMATED';
  predictionReady: true;
  expectedValue?: number;
  expectedValuePercent?: number;
  dataQuality: number;
  oddsUpdatedAt?: Date;
  oddsBasis?:
    | 'BOOKMAKER_ONLY'
    | 'BOOKMAKER_PLUS_HISTORY'
    | 'HISTORICAL_ONLY'
    | 'PRIOR_ONLY';
  oddsCalculationMethod?: string;
  oddsProvider?: 'THE_ODDS_API' | 'ESPN';
  bookmaker?: string;
  bookmakerOdds?: number;
  modelVersion: string;
  settlementProfile?: {
    fullWin?: number;
    halfWin?: number;
    push?: number;
    halfLoss?: number;
    fullLoss?: number;
  };
  rankingScore: number;
  rank?: number;
  calibrationReliability?: number;
  calibrationSampleSize?: number;
  safetyScore: number;
  live: boolean;
  settlementOutcome: 'PENDING';
  matchSettlementStatus: 'PENDING';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSelectionText(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number')
    return new Date(value);
  return new Date(Number.NaN);
}

/** Pick Center can retain a stale live flag; completion/status always wins. */
function isFinishedPick(pick: PickCenterSource): boolean {
  if (pick.completed === true) return true;
  const status = String(pick.status ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  return new Set([
    'FINAL',
    'FINISHED',
    'FULL_TIME',
    'FULLTIME',
    'FT',
    'AET',
    'AFTER_EXTRA_TIME',
    'PEN',
    'PENALTIES',
    'COMPLETED',
    'ENDED',
    'CANCELLED',
    'CANCELED',
    'ABANDONED',
  ]).has(status);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function lagosDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** Reject obvious contradictions when several standalone picks are grouped on one fixture. */
function selectionsAreCompatible(
  left: { eventId: string; marketKey: string; selectionKey: string },
  right: { eventId: string; marketKey: string; selectionKey: string },
): boolean {
  if (left.eventId !== right.eventId) return true;
  const leftMarket = left.marketKey.toUpperCase();
  const rightMarket = right.marketKey.toUpperCase();
  const leftKey = left.selectionKey.toUpperCase();
  const rightKey = right.selectionKey.toUpperCase();
  const familyFor = (market: string): 'FT' | 'HT' | 'SH' | null => {
    if (market === 'MATCH_RESULT') return 'FT';
    if (market === 'DOUBLE_CHANCE' || market === 'DRAW_NO_BET') return 'FT';
    if (market === 'HALF_TIME_RESULT') return 'HT';
    if (
      market === 'FIRST_HALF_DOUBLE_CHANCE' ||
      market === 'FIRST_HALF_DRAW_NO_BET'
    )
      return 'HT';
    if (market === 'SECOND_HALF_RESULT') return 'SH';
    return null;
  };
  const outcomeForResult = (market: string, key: string): string | null => {
    if (
      !['MATCH_RESULT', 'HALF_TIME_RESULT', 'SECOND_HALF_RESULT'].includes(
        market,
      )
    )
      return null;
    if (['HOME_WIN', 'HOME', '1'].includes(key)) return 'HOME';
    if (['DRAW', 'X'].includes(key)) return 'DRAW';
    if (['AWAY_WIN', 'AWAY', '2'].includes(key)) return 'AWAY';
    return null;
  };
  const outcomesForDoubleChance = (
    market: string,
    key: string,
  ): Set<string> | null => {
    if (!['DOUBLE_CHANCE', 'FIRST_HALF_DOUBLE_CHANCE'].includes(market))
      return null;
    if (['HOME_OR_DRAW', '1X', 'HOME_DRAW'].includes(key))
      return new Set(['HOME', 'DRAW']);
    if (['DRAW_OR_AWAY', 'X2', 'DRAW_AWAY'].includes(key))
      return new Set(['DRAW', 'AWAY']);
    if (['HOME_OR_AWAY', '12', 'HOME_AWAY'].includes(key))
      return new Set(['HOME', 'AWAY']);
    return null;
  };
  const resultVsDoubleChance = (
    resultMarket: string,
    resultKey: string,
    dcMarket: string,
    dcKey: string,
  ): boolean => {
    if (familyFor(resultMarket) !== familyFor(dcMarket)) return true;
    const outcome = outcomeForResult(resultMarket, resultKey);
    const accepted = outcomesForDoubleChance(dcMarket, dcKey);
    return !outcome || !accepted || accepted.has(outcome);
  };
  const leftOutcome = outcomeForResult(leftMarket, leftKey);
  const rightOutcome = outcomeForResult(rightMarket, rightKey);
  const leftDc = outcomesForDoubleChance(leftMarket, leftKey);
  const rightDc = outcomesForDoubleChance(rightMarket, rightKey);
  if (leftOutcome && rightDc)
    return resultVsDoubleChance(leftMarket, leftKey, rightMarket, rightKey);
  if (rightOutcome && leftDc)
    return resultVsDoubleChance(rightMarket, rightKey, leftMarket, leftKey);

  const leftDnbMarket = ['DRAW_NO_BET', 'FIRST_HALF_DRAW_NO_BET'].includes(
    leftMarket,
  );
  const rightDnbMarket = ['DRAW_NO_BET', 'FIRST_HALF_DRAW_NO_BET'].includes(
    rightMarket,
  );
  if (
    leftOutcome &&
    rightDnbMarket &&
    familyFor(leftMarket) === familyFor(rightMarket)
  ) {
    return (
      !(leftOutcome === 'HOME' && rightKey === 'AWAY_DNB') &&
      !(leftOutcome === 'AWAY' && rightKey === 'HOME_DNB')
    );
  }
  if (
    rightOutcome &&
    leftDnbMarket &&
    familyFor(rightMarket) === familyFor(leftMarket)
  ) {
    return (
      !(rightOutcome === 'HOME' && leftKey === 'AWAY_DNB') &&
      !(rightOutcome === 'AWAY' && leftKey === 'HOME_DNB')
    );
  }
  return true;
}

@Injectable()
export class CuratedPredictionService {
  private readonly logger = new Logger(CuratedPredictionService.name);
  private lastRefreshAt = 0;
  private refreshInProgress = false;

  constructor(
    @InjectModel(PickCenter.name)
    private readonly pickCenterModel: Model<PickCenter>,
    @InjectModel(CuratedPrediction.name)
    private readonly curatedPredictionModel: Model<CuratedPrediction>,
    private readonly monitor: PredictionEngineMonitorService,
  ) {}

  async listAdmin(
    input: { page?: number; pageSize?: number; status?: string } = {},
  ): Promise<Record<string, unknown>> {
    const page = Math.max(1, Math.floor(Number(input.page) || 1));
    const pageSize = Math.max(
      1,
      Math.min(200, Math.floor(Number(input.pageSize) || 50)),
    );
    const query: Record<string, unknown> = {};
    if (input.status?.trim()) query.status = input.status.trim().toUpperCase();

    const [items, total] = await Promise.all([
      this.curatedPredictionModel
        .find(query)
        .sort({ fixtureDateFrom: 1, createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean()
        .exec(),
      this.curatedPredictionModel.countDocuments(query).exec(),
    ]);

    return {
      items,
      pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
      accessPlan: 'admin',
    };
  }

  /**
   * Read-only query used by the daily Telegram publisher. It uses the existing
   * curated collection and publication/settlement state; it does not generate,
   * rescore, publish, or mutate any prediction.
   */
  async listPublishedForDateRange(
    from: Date,
    to: Date,
    limitValue = 200,
  ): Promise<Record<string, unknown>[]> {
    if (
      !(from instanceof Date) ||
      !Number.isFinite(from.getTime()) ||
      !(to instanceof Date) ||
      !Number.isFinite(to.getTime()) ||
      to <= from
    ) {
      throw new BadRequestException(
        'A valid prediction date range is required.',
      );
    }

    const limit = Math.max(
      1,
      Math.min(500, Math.floor(Number(limitValue) || 200)),
    );
    const rows = await this.curatedPredictionModel
      .find({
        status: 'PUBLISHED',
        settlementStatus: 'PENDING',
        completed: { $ne: true },
        live: { $ne: true },
        fixtureDateFrom: {
          $gte: new Date(Math.max(from.getTime(), Date.now())),
          $lt: to,
        },
      })
      .sort({
        'selections.rankingScore': -1,
        confidence: -1,
        fixtureDateFrom: 1,
      })
      .limit(limit)
      .lean()
      .exec();

    return rows as unknown as Record<string, unknown>[];
  }

  /** Revalidates every selected market against the live Pick Center and its Odds readiness. */
  async setPublicationStatus(
    predictionId: string,
    publish: boolean,
  ): Promise<Record<string, unknown>> {
    const prediction = await this.curatedPredictionModel
      .findById(predictionId)
      .exec();
    if (!prediction)
      throw new NotFoundException('Curated prediction was not found.');

    const nextStatus = publish ? 'PUBLISHED' : 'CANCELLED';
    if (publish && String(prediction.status).toUpperCase() === 'PUBLISHED') {
      return prediction.toObject() as unknown as Record<string, unknown>;
    }
    if (publish) {
      if (
        String(prediction.settlementStatus ?? 'PENDING').toUpperCase() !==
        'PENDING'
      ) {
        throw new BadRequestException(
          'A settled curated prediction cannot be republished.',
        );
      }
      const selectionCount = prediction.selections?.length ?? 0;
      const config = PREDICTION_ENGINE_CONFIG.curatedPredictions;
      if (
        selectionCount < config.minimumSelectionsPerMatch ||
        selectionCount > config.maximumSelectionsPerMatch
      ) {
        throw new BadRequestException(
          `A curated prediction must contain ${config.minimumSelectionsPerMatch}–${config.maximumSelectionsPerMatch} selected markets.`,
        );
      }
      if (prediction.completed === true) {
        throw new BadRequestException(
          'A completed fixture cannot be published as an active prediction.',
        );
      }

      const now = new Date();
      const nowMs = now.getTime();
      const horizon = nowMs + config.horizonHours * 3_600_000;
      const kickoff = asDate(prediction.fixtureDateFrom);
      if (
        prediction.live === true ||
        !Number.isFinite(kickoff.getTime()) ||
        kickoff.getTime() <= nowMs ||
        kickoff.getTime() > horizon
      ) {
        throw new BadRequestException(
          `Only pre-match fixtures kicking off within the next ${config.horizonHours} hours can be published.`,
        );
      }

      const seenMarkets = new Set<string>();
      for (const selection of prediction.selections ?? []) {
        const probability = Number(selection.probability);
        const confidence = Number(selection.confidence);
        const marketPredictionId = String(
          selection.marketPredictionId ?? '',
        ).trim();
        const selectionKey = String(selection.selectionKey ?? '').trim();
        const marketKey = String(selection.marketKey ?? '').toUpperCase();
        const offeredOdds = Number(selection.decimalOdds);
        const oddsUpdatedAt = asDate(selection.oddsUpdatedAt);
        const validPriceType = selection.priceType === 'PROVIDER' || selection.priceType === 'ESTIMATED';
        const oddsBasis = String(selection.oddsBasis ?? '');
        const validOddsBasis = ['BOOKMAKER_ONLY', 'BOOKMAKER_PLUS_HISTORY', 'HISTORICAL_ONLY', 'PRIOR_ONLY'].includes(oddsBasis);
        if (!marketKey || seenMarkets.has(marketKey)) {
          throw new BadRequestException(
            'Curated selections must use distinct market keys.',
          );
        }
        seenMarkets.add(marketKey);
        if (
          !marketPredictionId ||
          !marketKey ||
          !selectionKey ||
          !Number.isFinite(probability) ||
          probability < config.minimumProbability ||
          probability >= 1 ||
          !Number.isFinite(confidence) ||
          confidence < config.minimumConfidence ||
          confidence > PREDICTION_ENGINE_CONFIG.model.maximumConfidence ||
          selection.predictionReady !== true ||
          !validPriceType ||
          !Number.isFinite(offeredOdds) ||
          offeredOdds < PREDICTION_ENGINE_CONFIG.selectionEligibility.minimumDecimalOdds ||
          offeredOdds > PREDICTION_ENGINE_CONFIG.selectionEligibility.maximumDecimalOdds ||
          !isOddsQuoteFresh(oddsUpdatedAt) ||
          !validOddsBasis ||
          !toSelectionText(selection.oddsCalculationMethod)
        ) {
          throw new BadRequestException(
            'A curated selection must meet the final market-probability and confidence thresholds and retain a fresh, valid Odds-module quote.',
          );
        }
      }

      const currentPick = (await this.pickCenterModel
        .findOne({
          eventId: String(prediction.eventId),
          completed: { $ne: true },
          live: { $ne: true },
          'selectedMarkets.0': { $exists: true },
          fixtureDate: { $gt: now, $lte: new Date(horizon) },
        })
        .lean()
        .exec()) as unknown as PickCenterSource | null;
      if (!currentPick || currentPick.completed === true || currentPick.live === true || isFinishedPick(currentPick)) {
        throw new BadRequestException(
          'The fixture no longer has a current unfinished Pick Center ranking within the curated horizon. Regenerate it before publication.',
        );
      }
      const currentMarkets: unknown[] = Array.isArray(
        currentPick.selectedMarkets,
      )
        ? currentPick.selectedMarkets
        : [];
      for (const selection of prediction.selections ?? []) {
        const current = currentMarkets.find(
          (item) =>
            isRecord(item) &&
            toSelectionText(item.marketPredictionId) ===
              toSelectionText(selection.marketPredictionId) &&
            toSelectionText(item.marketKey) ===
              toSelectionText(selection.marketKey) &&
            toSelectionText(item.selectionKey) ===
              toSelectionText(selection.selectionKey),
        );
        const currentProbability = Number(
          isRecord(current) ? current.probability : undefined,
        );
        const currentConfidence = Number(
          isRecord(current) ? current.confidence : undefined,
        );
        const currentOdds = Number(isRecord(current) ? current.decimalOdds : undefined);
        const currentOddsUpdatedAt = asDate(isRecord(current) ? current.oddsUpdatedAt : undefined);
        const snapshotProbability = Number(selection.probability);
        const snapshotOdds = Number(selection.decimalOdds);
        const snapshotOddsUpdatedAt = asDate(selection.oddsUpdatedAt);
        const snapshotConfidence = Number(selection.confidence);
        const snapshotPriceType = selection.priceType;
        const snapshotOddsBasis = String(selection.oddsBasis ?? '');
        const snapshotOddsMethod = toSelectionText(selection.oddsCalculationMethod);
        const currentPriceType = isRecord(current) ? current.priceType : undefined;
        const currentOddsBasis = String(isRecord(current) ? current.oddsBasis ?? '' : '');
        const currentOddsMethod = toSelectionText(isRecord(current) ? current.oddsCalculationMethod : undefined);
        if (
          !current ||
          (
            isRecord(current) &&
            (current.isFinalSelection !== true ||
              current.recommendationEligible !== true ||
              current.oddsPredictionReady !== true)
          ) ||
          !Number.isFinite(currentProbability) ||
          Math.abs(currentProbability - snapshotProbability) > 0.000001 ||
          Math.abs(currentOdds - snapshotOdds) > 0.000001 ||
          currentOddsUpdatedAt.getTime() !== snapshotOddsUpdatedAt.getTime() ||
          currentProbability < config.minimumProbability ||
          currentProbability >= 1 ||
          !Number.isFinite(currentConfidence) ||
          Math.abs(currentConfidence - snapshotConfidence) > 0.000001 ||
          currentConfidence < config.minimumConfidence ||
          currentConfidence > PREDICTION_ENGINE_CONFIG.model.maximumConfidence ||
          (currentPriceType !== 'PROVIDER' && currentPriceType !== 'ESTIMATED') ||
          currentPriceType !== snapshotPriceType ||
          currentOddsBasis !== snapshotOddsBasis ||
          currentOddsMethod !== snapshotOddsMethod ||
          !Number.isFinite(currentOdds) ||
          currentOdds < PREDICTION_ENGINE_CONFIG.selectionEligibility.minimumDecimalOdds ||
          currentOdds > PREDICTION_ENGINE_CONFIG.selectionEligibility.maximumDecimalOdds ||
          !isOddsQuoteFresh(currentOddsUpdatedAt) ||
          !['BOOKMAKER_ONLY', 'BOOKMAKER_PLUS_HISTORY', 'HISTORICAL_ONLY', 'PRIOR_ONLY'].includes(currentOddsBasis) ||
          !currentOddsMethod
        ) {
          throw new BadRequestException(
            'A curated selection must remain the same current final Pick Center selection and retain its fresh Odds-module quote.',
          );
        }
      }
    }

    if (String(prediction.status).toUpperCase() !== nextStatus) {
      prediction.status = nextStatus;
      if (publish) prediction.publishedAt = new Date();
      await prediction.save();
    }

    this.logger.log(
      `Curated prediction ${prediction.predictionCode} ${publish ? 'published' : 'unpublished'} by admin.`,
    );
    await this.monitor.recordEvent({
      type: 'ADMIN_ACTION',
      level: 'INFO',
      message: `Curated prediction ${prediction.predictionCode} ${publish ? 'published' : 'unpublished'} by admin.`,
      metadata: {
        predictionId,
        publish,
        selectionCount: prediction.selections?.length ?? 0,
      },
    });
    return prediction.toObject() as unknown as Record<string, unknown>;
  }

  async withdrawActiveForEvent(eventId: string, reason: string): Promise<void> {
    const normalizedEventId = String(eventId ?? '').trim();
    if (!normalizedEventId) return;
    const predictions = await this.curatedPredictionModel
      .find({
        eventId: normalizedEventId,
        status: 'READY',
        settlementStatus: 'PENDING',
        completed: { $ne: true },
        live: { $ne: true },
      })
      .exec();
    for (const prediction of predictions) {
      prediction.status = 'CANCELLED';
      prediction.diagnostics = [
        `AUTO_WITHDRAWN_NO_CURRENT_MARKET_SET: ${String(reason).slice(0, 350)}`,
      ];
      await prediction.save();
    }
  }

  /**
   * Builds one curated snapshot per eligible fixture in the final 48 hours.
   * A snapshot contains one to seven distinct, compatible market selections.
   * Once published, it is immutable; only settlement fields are changed by settlement workflows.
   */
  async refreshFromPickCenter(force = false): Promise<Record<string, unknown>> {
    const nowMs = Date.now();
    if (this.refreshInProgress) {
      return { skipped: true, reason: 'REFRESH_ALREADY_RUNNING' };
    }
    const refreshIntervalMs =
      PREDICTION_ENGINE_CONFIG.curatedPredictions.refreshIntervalMs;
    if (!force && nowMs - this.lastRefreshAt < refreshIntervalMs) {
      return { skipped: true, reason: 'REFRESH_THROTTLED' };
    }
    this.refreshInProgress = true;
    this.lastRefreshAt = nowMs;
    try {
      return await this.refreshFromPickCenterCycle(nowMs);
    } finally {
      this.refreshInProgress = false;
    }
  }

  private async refreshFromPickCenterCycle(
    nowMs: number,
  ): Promise<Record<string, unknown>> {
    const config = PREDICTION_ENGINE_CONFIG.curatedPredictions;
    if (!config.enabled)
      return { skipped: true, reason: 'CURATED_PREDICTIONS_DISABLED' };
    const now = new Date(nowMs);
    const horizon = new Date(nowMs + config.horizonHours * 3_600_000);
    const queriedPicks = (await this.pickCenterModel
      .find({
        completed: { $ne: true },
        'selectedMarkets.0': { $exists: true },
        live: { $ne: true },
        fixtureDate: { $gt: now, $lte: horizon },
      })
      .sort({ fixtureDate: 1 })
      .lean()
      .exec()) as unknown as PickCenterSource[];
    // A populated Pick Center record is the source of truth here. Do not lose
    // usable market selections only because the aggregate Pick Center status
    // was not refreshed, but never publish completed/abandoned fixtures.
    const picks = queriedPicks.filter((pick) => {
      if (isFinishedPick(pick)) return false;
      const kickoff = asDate(pick.fixtureDate);
      return (
        pick.live !== true &&
        Number.isFinite(kickoff.getTime()) &&
        kickoff.getTime() > nowMs &&
        kickoff.getTime() <= horizon.getTime()
      );
    });

    // Pick Center is the sole probability/calibration source. Curated Predictions
    // applies eligibility gates and reuses Pick Center's safety ranking; it does not
    // recalculate or independently calibrate probabilities.
    const candidatesByEvent = new Map<string, CuratedSelectionCandidate[]>();
    let validOddsReadySelections = 0;
    for (const pick of picks) {
      const eventId = toSelectionText(pick.eventId);
      const fixtureDate = asDate(pick.fixtureDate);
      if (
        !eventId ||
        pick.completed === true ||
        !Number.isFinite(fixtureDate.getTime())
      )
        continue;
      if (
        pick.live === true ||
        fixtureDate.getTime() <= nowMs ||
        fixtureDate.getTime() > horizon.getTime()
      ) continue;
      const selections = Array.isArray(pick.selectedMarkets)
        ? pick.selectedMarkets
        : [];
      const candidates = candidatesByEvent.get(eventId) ?? [];

      for (const value of selections) {
        if (!isRecord(value)) continue;
        const selection = value;
        const probability = Number(selection.probability);
        const confidence = Number(selection.confidence ?? 0);
        const rawDataQuality = Number(selection.dataQuality ?? 0);
        const dataQuality = Number.isFinite(rawDataQuality)
          ? Math.max(0, Math.min(1, rawDataQuality))
          : 0;
        const marketPredictionId = toSelectionText(
          selection.marketPredictionId,
        );
        const marketKey = toSelectionText(selection.marketKey);
        const selectionKey = toSelectionText(selection.selectionKey);
        const priceType =
          selection.priceType === 'PROVIDER' || selection.priceType === 'ESTIMATED'
            ? selection.priceType
            : null;
        const rawOddsBasis =
          typeof selection.oddsBasis === 'string' ? selection.oddsBasis : '';
        const oddsBasis = [
          'BOOKMAKER_ONLY',
          'BOOKMAKER_PLUS_HISTORY',
          'HISTORICAL_ONLY',
          'PRIOR_ONLY',
        ].includes(rawOddsBasis)
          ? (rawOddsBasis as CuratedSelectionCandidate['oddsBasis'])
          : undefined;
        const offeredOddsInput = Number(selection.decimalOdds);
        const hasValidOfferedOdds =
          Number.isFinite(offeredOddsInput) &&
          offeredOddsInput >=
            PREDICTION_ENGINE_CONFIG.selectionEligibility.minimumDecimalOdds &&
          offeredOddsInput <=
            PREDICTION_ENGINE_CONFIG.selectionEligibility.maximumDecimalOdds;
        const offeredOdds = hasValidOfferedOdds ? offeredOddsInput : undefined;
        const oddsUpdatedAt = asDate(selection.oddsUpdatedAt);
        const fairOddsInput = Number(selection.fairOdds);
        const fairOdds =
          Number.isFinite(fairOddsInput) && fairOddsInput > 1
            ? fairOddsInput
            : probability > 0
              ? 1 / probability
              : undefined;
        const safetyScoreInput = Number(
          selection.safetyScore ?? selection.rankingScore ?? 0,
        );
        const safetyScore = Number.isFinite(safetyScoreInput)
        ? Math.max(0, Math.min(1, safetyScoreInput))
        : 0;
        const oddsCalculationMethod = toSelectionText(selection.oddsCalculationMethod);
        const hasFreshOdds = isOddsQuoteFresh(oddsUpdatedAt, nowMs);
        const isFinalMarketSelection =
          selection.isFinalSelection === true &&
          selection.recommendationEligible === true &&
          selection.oddsPredictionReady === true;
        if (
          !Number.isFinite(probability) ||
          probability < config.minimumProbability ||
          probability >= 1 ||
          !Number.isFinite(confidence) ||
          confidence < config.minimumConfidence ||
          confidence > PREDICTION_ENGINE_CONFIG.model.maximumConfidence ||
          !marketPredictionId ||
          !marketKey ||
          !selectionKey ||
          !isFinalMarketSelection ||
          !priceType ||
          !hasValidOfferedOdds ||
          !hasFreshOdds ||
          !oddsBasis ||
          !oddsCalculationMethod
        )
          continue;

        validOddsReadySelections += 1;
        const settlementProfile = isRecord(selection.settlementProfile)
          ? (selection.settlementProfile as CuratedSelectionCandidate['settlementProfile'])
          : undefined;
        const expectedValue =
          priceType === 'PROVIDER' &&
          oddsBasis === 'BOOKMAKER_ONLY' &&
          offeredOdds !== undefined
            ? PredictionMathUtil.expectedValue(
                probability,
                offeredOdds,
                settlementProfile,
              )
            : null;
        // Reuse Pick Center's existing score; do not derive a second safety score.
        const pickCenterRanking = Number(selection.rankingScore ?? 0);
        candidates.push({
          eventId,
          leagueId: String(pick.leagueId ?? ''),
          leagueName: String(
            pick.leagueName ?? pick.leagueId ?? 'Unknown league',
          ),
          fixtureDate,
          ...(asDate(pick.retentionExpiresAt).getTime() > 0
            ? { retentionExpiresAt: asDate(pick.retentionExpiresAt) }
            : {}),
          homeTeamName: String(pick.homeTeamName ?? ''),
          awayTeamName: String(pick.awayTeamName ?? ''),
          marketPredictionId,
          marketKey,
          marketName: toSelectionText(selection.marketName) ?? marketKey,
          selectionKey,
          selectionName:
            toSelectionText(selection.selectionName) ?? selectionKey,
          probability,
          confidence,
          ...(offeredOdds !== undefined ? { decimalOdds: offeredOdds } : {}),
          ...(fairOdds !== undefined &&
          Number.isFinite(fairOdds) &&
          fairOdds > 1
            ? { fairOdds }
            : {}),
          priceType,
          predictionReady: true,
          ...(expectedValue !== null
            ? { expectedValue, expectedValuePercent: expectedValue * 100 }
            : {}),
          dataQuality,
          ...(Number.isFinite(oddsUpdatedAt.getTime())
            ? { oddsUpdatedAt }
            : {}),
          ...(oddsBasis ? { oddsBasis } : {}),
          oddsCalculationMethod,
          ...(selection.oddsProvider === 'ESPN' ||
          selection.oddsProvider === 'THE_ODDS_API'
            ? { oddsProvider: selection.oddsProvider }
            : {}),
          ...(toSelectionText(selection.bookmaker)
            ? { bookmaker: toSelectionText(selection.bookmaker) }
            : {}),
          ...(priceType === 'PROVIDER' && offeredOdds !== undefined
            ? { bookmakerOdds: offeredOdds }
            : {}),
          modelVersion:
            toSelectionText(pick.modelVersion) ??
            PREDICTION_ENGINE_CONFIG.modelVersion,
          ...(settlementProfile ? { settlementProfile } : {}),
          rankingScore: pickCenterRanking,
          ...(Number.isFinite(Number(selection.rank))
            ? { rank: Number(selection.rank) }
            : {}),
          ...(Number.isFinite(Number(selection.calibrationReliability))
            ? {
                calibrationReliability: clamp01(
                  Number(selection.calibrationReliability),
                ),
              }
            : {}),
          ...(Number.isFinite(Number(selection.calibrationSampleSize))
            ? {
                calibrationSampleSize: Math.max(
                  0,
                  Number(selection.calibrationSampleSize),
                ),
              }
            : {}),
          safetyScore,
          live: false,
          settlementOutcome: 'PENDING',
          matchSettlementStatus: 'PENDING',
        });
      }
      candidatesByEvent.set(eventId, candidates);
    }

    const results: Array<Record<string, unknown>> = [];
    const publishableEventIds = new Set<string>();
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let riskRejected = 0;

    const selectionCountDistribution: Record<string, number> = {};
    for (let count = 1; count <= config.maximumSelectionsPerMatch; count += 1) {
      selectionCountDistribution[String(count)] = 0;
    }
    const recordSelectionCount = (count: number): void => {
      if (count >= 1 && count <= config.maximumSelectionsPerMatch) {
        const key = String(count);
        selectionCountDistribution[key] = (selectionCountDistribution[key] ?? 0) + 1;
      }
    };

    for (const [eventId, candidates] of candidatesByEvent) {
      const existing = await this.curatedPredictionModel
        .findOne({ eventId })
        .exec();
      const existingStatus = String(existing?.status ?? '').toUpperCase();
      const existingSettlementStatus = String(
        existing?.settlementStatus ?? 'PENDING',
      ).toUpperCase();

      if (
        existing &&
        (existingSettlementStatus !== 'PENDING' || existingStatus === 'SETTLED')
      ) {
        skipped += 1;
        results.push({
          eventId,
          created: false,
          reason: 'MATCH_ALREADY_SETTLED',
          predictionId: String(existing._id),
        });
        continue;
      }

      // The first publication is the permanent recommendation snapshot.
      // Later Pick Center, Odds, model, or fixture refreshes must not add,
      // replace, rescore, or rewrite its markets, prices, probabilities, or metadata.
      if (existing && existingStatus === 'PUBLISHED') {
        publishableEventIds.add(eventId);
        const storedSelectionCount = Array.isArray(existing.selections)
          ? existing.selections.length
          : 0;
        recordSelectionCount(storedSelectionCount);
        skipped += 1;
        results.push({
          eventId,
          created: false,
          updated: false,
          reason: 'PUBLISHED_SNAPSHOT_FROZEN',
          predictionId: String(existing._id),
          selectionCount: storedSelectionCount,
        });
        continue;
      }

      const wasAutoWithdrawn =
        Array.isArray(existing?.diagnostics) &&
        existing.diagnostics.some(
          (item: unknown) =>
            typeof item === 'string' &&
            item.startsWith('AUTO_WITHDRAWN_NO_CURRENT_MARKET_SET:'),
        );
      if (existingStatus === 'CANCELLED' && !wasAutoWithdrawn) {
        skipped += 1;
        results.push({
          eventId,
          created: false,
          reason: 'CANCELLED_RECORD_PRESERVED',
          predictionId: String(existing?._id ?? ''),
        });
        continue;
      }

      const uniqueByMarket = new Map<string, CuratedSelectionCandidate>();
      for (const candidate of candidates) {
        const marketIdentity = candidate.marketKey.toUpperCase();
        const current = uniqueByMarket.get(marketIdentity);
        if (!current || candidate.safetyScore > current.safetyScore) {
          uniqueByMarket.set(marketIdentity, candidate);
        }
      }
      const ranked = [...uniqueByMarket.values()].sort(
        (a, b) =>
          b.safetyScore - a.safetyScore ||
          b.rankingScore - a.rankingScore ||
          b.probability - a.probability ||
          b.confidence - a.confidence ||
          (a.rank ?? Number.MAX_SAFE_INTEGER) -
            (b.rank ?? Number.MAX_SAFE_INTEGER),
      );

      // Final probability (after any active market-specific calibration) and confidence
      // are hard gates. Pick Center's safety ranking then selects up to seven markets.
      const selected: CuratedSelectionCandidate[] = [];
      for (const candidate of ranked) {
        if (
          selected.some(
            (current) => !selectionsAreCompatible(current, candidate),
          )
        ) {
          continue;
        }
        selected.push(candidate);
        if (selected.length >= config.maximumSelectionsPerMatch) break;
      }

      if (selected.length < config.minimumSelectionsPerMatch) {
        skipped += 1;
        riskRejected += 1;
        results.push({
          eventId,
          created: false,
          reason: ranked.length
            ? 'NO_COMPATIBLE_ELIGIBLE_SELECTION'
            : 'NO_SELECTION_PASSED_PROBABILITY_CONFIDENCE_ODDS_READINESS_AND_FRESHNESS',
          availableMarkets: ranked.length,
          eligibleSelections: candidates.length,
        });
        continue;
      }

      const kickoffDateKey = lagosDateKey(selected[0].fixtureDate);
      const predictionCode =
        existing?.predictionCode ??
        `2XP-P-${kickoffDateKey.replace(/-/g, '')}-${randomUUID().slice(0, 6).toUpperCase()}`;
      const generatedDateKey =
        existing?.generatedDateKey ?? `${kickoffDateKey}:${eventId}`;
      const selectionRecords = selected.map((selection) => ({
        ...selection,
        settlementOutcome: 'PENDING',
        matchSettlementStatus: 'PENDING',
      }));
      // Curated selections remain standalone recommendations, not a same-game accumulator.
      const primarySelection = selected[0];
      const combinedOdds = primarySelection.decimalOdds;
      const combinedProbability = primarySelection.probability;
      const combinedConfidence = primarySelection.confidence;
      const hasMultipleMarkets = selected.length > 1;
      const publishedAt = new Date();
      const update = {
        $set: {
          eventId,
          title: `${primarySelection.homeTeamName} vs ${primarySelection.awayTeamName}`,
          status: 'PUBLISHED',
          publishedAt,
          live: false,
          completed: false,
          selections: selectionRecords,
          selectionCount: selected.length,
          combinedProbability: Number(combinedProbability.toFixed(8)),
          combinedOdds: Number(Number(combinedOdds).toFixed(6)),
          confidence: combinedConfidence,
          combinedProbabilityMethod: hasMultipleMarkets
            ? 'PRIMARY_SELECTION_WITH_ADDITIONAL_MARKET_RECOMMENDATIONS'
            : 'SINGLE_SELECTION',
          settlementStatus: existing?.settlementStatus ?? 'PENDING',
          fixtureDateFrom: primarySelection.fixtureDate,
          fixtureDateTo: primarySelection.fixtureDate,
          retentionExpiresAt: primarySelection.retentionExpiresAt ?? null,
          diagnostics: [
            `Frozen ${selected.length} distinct, compatible market selection(s) at the first qualifying curated refresh.`,
            `Eligibility: final market probability (with calibration applied when active) >= ${(config.minimumProbability * 100).toFixed(0)}%; evidence confidence >= ${config.minimumConfidence}/98; explicit final market selection; fresh Odds-module quote >= ${PREDICTION_ENGINE_CONFIG.selectionEligibility.minimumDecimalOdds.toFixed(2)}.`,
            hasMultipleMarkets
              ? 'These are independent recommendations for the same fixture, not a combined bet. Legacy probability/odds fields represent only the highest-safety primary selection.'
              : 'The record contains one market recommendation; probability and odds fields correspond to that selection.',
            selected.some((selection) => selection.priceType === 'ESTIMATED')
              ? 'At least one displayed price is an Odds-module estimate, not a bookmaker offer.'
              : 'Displayed prices were provider-backed when the snapshot was created.',
            `Model version ${primarySelection.modelVersion}; selected markets: ${selected.map((item) => `${item.marketKey}/${item.selectionKey}`).join(', ')}.`,
            `Pick Center safety scores: ${selected.map((item) => `${item.marketKey}=${(item.safetyScore * 100).toFixed(1)}`).join(', ')}.`,
            'IMMUTABLE_CURATED_SNAPSHOT: future Pick Center, Odds, or model refreshes cannot supplement or replace these selections.',
          ],
        },
        $setOnInsert: {
          predictionCode,
          generatedDateKey,
        },
      };

      const result = await this.curatedPredictionModel
        .findOneAndUpdate({ eventId }, update, {
          upsert: true,
          returnDocument: 'after',
          setDefaultsOnInsert: true,
          runValidators: true,
        })
        .lean()
        .exec();
      if (existing) updated += 1;
      else created += 1;
      publishableEventIds.add(eventId);
      recordSelectionCount(selected.length);
      results.push({
        eventId,
        created: !existing,
        updated: Boolean(existing),
        selectionCount: selected.length,
        prediction: result,
      });
    }

    // Withdraw only stale READY drafts that are in the curated time horizon. Published
    // recommendations remain immutable and records outside the horizon are not rewritten.
    const activePredictions = (await this.curatedPredictionModel
      .find({
        status: 'READY',
        settlementStatus: 'PENDING',
        completed: { $ne: true },
        live: { $ne: true },
        fixtureDateFrom: { $gte: now, $lte: horizon },
      })
      .select({ eventId: 1 })
      .lean()
      .exec()) as Array<{ eventId: string }>;
    const withdrawnEventIds = activePredictions
      .map((item) => String(item.eventId ?? ''))
      .filter((id) => id && !publishableEventIds.has(id));
    if (withdrawnEventIds.length) {
      await this.curatedPredictionModel
        .updateMany(
          {
            eventId: { $in: withdrawnEventIds },
            status: 'READY',
            settlementStatus: 'PENDING',
          },
          {
            $set: {
              status: 'CANCELLED',
              diagnostics: [
                'AUTO_WITHDRAWN_NO_CURRENT_MARKET_SET: No current Pick Center selection passed the configured probability, confidence, and market-identifier requirements.',
              ],
            },
          },
        )
        .exec();
    }

    const skipReasonCounts = results.reduce<Record<string, number>>(
      (counts, result) => {
        const reason = toSelectionText(result.reason) ?? 'UNKNOWN';
        counts[reason] = (counts[reason] ?? 0) + 1;
        return counts;
      },
      {},
    );
    const summary = {
      skipped: false,
      generatedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - nowMs),
      horizonHours: config.horizonHours,
      matchesScanned: queriedPicks.length,
      eligibleFixtures: candidatesByEvent.size,
      completedOrOutOfWindowExcluded: Math.max(
        0,
        queriedPicks.length - picks.length,
      ),
      validOddsReadySelections,
      created,
      updated,
      publishedSnapshotsFrozen: results.filter(
        (result) => result.reason === 'PUBLISHED_SNAPSHOT_FROZEN',
      ).length,
      selectionCountDistribution,
      skippedMatches: skipped,
      riskRejected,
      withdrawn: withdrawnEventIds.length,
      selectedMarkets: Object.entries(selectionCountDistribution).reduce(
        (total, [count, matches]) => total + Number(count) * matches,
        0,
      ),
      minimumSafetyScore: config.minimumSafetyScore,
      skipReasonCounts,
      results,
    };
    this.logger.log(
      `Curated refresh: ${created} created, ${updated} legacy drafts refreshed, ${skipped} skipped, ${riskRejected} risk-rejected, ${withdrawnEventIds.length} stale drafts withdrawn; ${results.filter((result) => result.reason === 'PUBLISHED_SNAPSHOT_FROZEN').length} published snapshots frozen; scanned ${queriedPicks.length} Pick Center records within the rolling ${config.horizonHours}-hour pre-match horizon.`,
    );
    await this.monitor.recordCuratedRefresh(summary);
    return {
      ...summary,
      rules: {
        selectionsPerFixture: `${config.minimumSelectionsPerMatch}–${config.maximumSelectionsPerMatch} distinct market selections`,
        fixtureHorizon: `rolling ${config.horizonHours} hours before kickoff; pre-match fixtures only`,
        minimumProbability: config.minimumProbability,
        minimumConfidence: config.minimumConfidence,
        minimumDataQuality: config.minimumDataQuality,
        minimumSafetyScore: config.minimumSafetyScore,
        minimumDecimalOdds:
          PREDICTION_ENGINE_CONFIG.selectionEligibility.minimumDecimalOdds,
        maximumDecimalOdds:
          PREDICTION_ENGINE_CONFIG.selectionEligibility.maximumDecimalOdds,
        requireExplicitOddsReadiness: true,
        requireFreshStoredOdds: true,
        requireValidStoredOdds: true,
        dataQualityAndSafetyAreHardGates: false,
        pickCenterRankingUsed: true,
        calibrationUsedWhenAvailable: false,
        probabilityCombination:
          'Pick Center probabilities are reused; no new predictions are calculated',
        originalPublishedSelectionsPreserved: true,
        publishedRecordsMayBeSupplementedUpToMaximum: false,
        publishedSnapshotsAreImmutable: true,
      },
    };
  }
}

