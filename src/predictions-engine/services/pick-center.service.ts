import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { PickCenter } from '../schemas/pick-center.schema';
import { MarketPrediction } from '../schemas/market-prediction.schema';
import { PredictionStatus } from '../enums/prediction-status.enum';
import { PredictionMarket } from '../enums/prediction-market.enum';
import { MARKET_DEFINITION_BY_KEY } from '../catalog/football-market-catalog';
import { PickStatus } from '../enums/pick-status.enum';
import { PredictionRunSummary } from '../interfaces/prediction-run.interface';
import { PickCenterUpdateResult } from '../interfaces/pick-center.interface';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { isOddsQuoteFresh } from '../../odds/config/odds.config';
import { PredictionEngineMonitorService } from './prediction-engine-monitor.service';
import { MarketCalibrationService } from './market-calibration.service';
import { CuratedPredictionService } from './curated-prediction.service';
import { PredictionMathUtil } from '../utils/prediction-math.util';
import { PredictionDataService } from './prediction-data.service';

type SelectionLike = {
  status?: PredictionStatus | string;
  actualOutcome?: boolean | string | null;
  probability?: number | string | null;
  confidence?: number | string | null;
  evidenceConfidence?: number | string | null;
  calibrationReliability?: number | string | null;
  calibrationSampleSize?: number | string | null;
  calibrationApplied?: boolean;
  safetyScore?: number | string | null;
  fairOdds?: number | string | null;
  bookmakerOdds?: number | string | null;
  decimalOdds?: number | string | null;
  expectedValue?: number | string | null;
  expectedValuePercent?: number | string | null;
  dataQuality?: number | string | null;
  recommendationEligible?: boolean;
  isFinalSelection?: boolean;
  oddsPredictionReady?: boolean;
  priceType?: 'PROVIDER' | 'ESTIMATED';
  oddsUpdatedAt?: Date | string | null;
  oddsBasis?:
    | 'BOOKMAKER_ONLY'
    | 'BOOKMAKER_PLUS_HISTORY'
    | 'HISTORICAL_ONLY'
    | 'PRIOR_ONLY'
    | null;
  oddsCalculationMethod?: string | null;
  oddsProvider?: 'THE_ODDS_API' | 'ESPN' | null;
  bookmaker?: string | null;
  settlementProfile?: {
    fullWin?: number;
    halfWin?: number;
    push?: number;
    halfLoss?: number;
    fullLoss?: number;
  } | null;
  key?: string | number;
  fullName?: string;
  abbreviation?: string;
  line?: number | string;
  subjectId?: string | number;
  subjectName?: string;
};

type MarketDocumentLike = {
  _id?: string | { toString(): string };
  status?: PredictionStatus | string;
  marketKey?: string | number;
  family?: string;
  dataQuality?: number | string;
  selections?: SelectionLike[];
  marketName?: string;
  marketAbbreviation?: string;
  leagueId?: string;
  fixtureDate?: Date | string;
  homeTeamName?: string;
  awayTeamName?: string;
  modelVersion?: string;
  fixtureSourceRevision?: number;
  live?: boolean;
  completed?: boolean;
  retentionExpiresAt?: Date | string | null;
};

type Candidate = {
  marketPredictionId: string;
  marketKey: string;
  marketName: string;
  marketAbbreviation: string;
  selectionKey: string;
  selectionName: string;
  selectionAbbreviation: string;
  line?: number;
  subjectId?: string;
  subjectName?: string;
  probability: number;
  probabilityPercent: number;
  fairOdds: number;
  decimalOdds: number;
  priceType: 'PROVIDER' | 'ESTIMATED';
  oddsUpdatedAt: Date;
  oddsBasis:
    | 'BOOKMAKER_ONLY'
    | 'BOOKMAKER_PLUS_HISTORY'
    | 'HISTORICAL_ONLY'
    | 'PRIOR_ONLY';
  oddsCalculationMethod: string;
  oddsProvider?: 'THE_ODDS_API' | 'ESPN';
  bookmaker?: string;
  bookmakerOdds?: number;
  recommendationEligible: true;
  oddsPredictionReady: true;
  isFinalSelection: true;
  expectedValue?: number;
  expectedValuePercent?: number;
  dataQuality: number;
  confidence: number;
  evidenceConfidence: number;
  rankingScore: number;
  rank?: number;
  isMatchResult: boolean;
  status: PickStatus;
  reasons: string[];
  marketPriority: number;
  valueRatio: number;
  calibrationReliability: number;
  calibrationSampleSize: number;
  safetyScore: number;
  settlementProfile?: {
    fullWin?: number;
    halfWin?: number;
    push?: number;
    halfLoss?: number;
    fullLoss?: number;
  };
};

@Injectable()
export class PickCenterService {
  private readonly logger = new Logger(PickCenterService.name);

  constructor(
    @InjectModel(PickCenter.name)
    private readonly pickCenterModel: Model<PickCenter>,
    @InjectModel(MarketPrediction.name)
    private readonly marketPredictionModel: Model<MarketPrediction>,
    private readonly monitor: PredictionEngineMonitorService,
    private readonly marketCalibrationService: MarketCalibrationService,
    private readonly curatedPredictionService: CuratedPredictionService,
    private readonly predictionDataService: PredictionDataService,
  ) {}

  /**
   * Reconciles Pick Center independently of queue completion. It only rebuilds
   * fixtures whose market documents are newer than their Pick Center snapshot,
   * or whose snapshot is missing/outdated. A small batch keeps database load bounded.
   */
  async refreshStaleUpcoming(): Promise<{
    scanned: number;
    rebuilt: number;
    failed: number;
  }> {
    if (!PREDICTION_ENGINE_CONFIG.pickCenter.enabled) {
      return { scanned: 0, rebuilt: 0, failed: 0 };
    }
    const now = new Date();
    const marketGroups = await this.marketPredictionModel
      .aggregate<{
        _id: string;
        fixtureDate: Date;
        latestMarketUpdate?: Date;
      }>([
        {
          $match: {
            modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
            completed: { $ne: true },
            live: { $ne: true },
            fixtureDate: { $gt: now },
          },
        },
        {
          $group: {
            _id: '$eventId',
            fixtureDate: { $min: '$fixtureDate' },
            latestMarketUpdate: { $max: '$updatedAt' },
          },
        },
        { $sort: { fixtureDate: 1 } },
      ])
      .exec();
    if (!marketGroups.length) return { scanned: 0, rebuilt: 0, failed: 0 };

    const eventIds = marketGroups.map((row) => String(row._id));
    const existingRows = (await this.pickCenterModel
      .find({ eventId: { $in: eventIds } })
      .select({ eventId: 1, modelVersion: 1, updatedAt: 1 })
      .lean()
      .exec()) as unknown as Array<{
      eventId: string;
      modelVersion?: string;
      updatedAt?: Date | string;
    }>;
    const existingByEvent = new Map(
      existingRows.map((row) => [String(row.eventId), row]),
    );
    const toRebuild = marketGroups
      .filter((row) => {
        const eventId = String(row._id);
        const current = existingByEvent.get(eventId);
        if (
          !current ||
          current.modelVersion !== PREDICTION_ENGINE_CONFIG.modelVersion
        )
          return true;
        const pickUpdatedAt =
          current.updatedAt instanceof Date
            ? current.updatedAt.getTime()
            : new Date(String(current.updatedAt ?? '')).getTime();
        const marketUpdatedAt =
          row.latestMarketUpdate instanceof Date
            ? row.latestMarketUpdate.getTime()
            : new Date(String(row.latestMarketUpdate ?? '')).getTime();
        return (
          !Number.isFinite(pickUpdatedAt) ||
          (Number.isFinite(marketUpdatedAt) &&
            marketUpdatedAt > pickUpdatedAt + 250)
        );
      })
      .slice(0, PREDICTION_ENGINE_CONFIG.pickCenter.refreshBatchSize);

    let rebuilt = 0;
    let failed = 0;
    for (const row of toRebuild) {
      try {
        const result = await this.rebuildForEvent(String(row._id));
        if (result.status !== 'FROZEN') rebuilt += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `Independent Pick Center refresh failed for ${String(row._id)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (rebuilt || failed) {
      this.logger.log(
        `Independent Pick Center reconciliation: scanned=${marketGroups.length}, rebuilt=${rebuilt}, failed=${failed}.`,
      );
    }
    return { scanned: marketGroups.length, rebuilt, failed };
  }

  async rebuildForEvent(
    eventId: string,
    run?: PredictionRunSummary,
  ): Promise<PickCenterUpdateResult> {
    const modelVersion =
      run?.modelVersion ?? PREDICTION_ENGINE_CONFIG.modelVersion;
    if (!(await this.predictionDataService.isFixturePreMatch(eventId))) {
      return this.getFrozenSnapshotResult(eventId);
    }
    const retentionExpiresAt =
      await this.predictionDataService.getFixtureRetentionExpiresAt(eventId);

    const loadedMarketDocuments = (await this.marketPredictionModel
      .find({ eventId, modelVersion, completed: { $ne: true }, live: { $ne: true } })
      .lean()
      .exec()) as unknown as MarketDocumentLike[];
    const currentFixtureSourceRevision =
      await this.predictionDataService.getCurrentFixtureSourceRevision(eventId);
    const marketDocuments = loadedMarketDocuments.filter(
      (document) => Number(document.fixtureSourceRevision ?? -1) === currentFixtureSourceRevision,
    );

    if (!marketDocuments.length) {
      if (!(await this.predictionDataService.isFixturePreMatch(eventId))) {
        return this.getFrozenSnapshotResult(eventId);
      }
      await this.pickCenterModel
        .findOneAndUpdate(
          { eventId },
          {
            $set: {
              eventId,
              retentionExpiresAt: retentionExpiresAt ?? null,
              status: PickStatus.INELIGIBLE,
              selectedMarkets: [],
              eligibleMarketCount: 0,
              selectedMarketCount: 0,
              generalConfidence: undefined,
              modelVersion,
              exclusionReason:
                'No unfinished market predictions exist for the active model version.',
            },
          },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
        )
        .exec();
      try {
        await this.curatedPredictionService.withdrawActiveForEvent(
          eventId,
          'No unfinished market predictions exist for the active model version.',
        );
      } catch (error) {
        this.logger.warn(
          `Could not withdraw stale curated prediction for ${eventId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        eventId,
        selectedCount: 0,
        eligibleCount: 0,
        status: PickStatus.INELIGIBLE,
      };
    }

    const now = Date.now();
    const config = PREDICTION_ENGINE_CONFIG;
    let calibrationAssessments = new Map();
    try {
      calibrationAssessments =
        await this.marketCalibrationService.getAssessments();
    } catch (error) {
      this.logger.warn(
        `Pick Center could not load calibration assessments; rankings will use neutral calibration support for this rebuild: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.monitor.recordEvent({
        type: 'CALIBRATION_UPDATED',
        level: 'WARNING',
        eventId,
        message:
          'Pick Center could not load calibration assessments; neutral calibration support was used for this rebuild.',
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    const candidates: Candidate[] = [];

    // Pick Center does not choose between outcome candidates and is not an
    // eligibility gate. It reads only the one final outcome already chosen by
    // each market engine, then ranks those final outcomes across market keys.
    for (const document of marketDocuments) {
      if (document.completed === true) continue;
      const marketKey = String(document.marketKey ?? '').trim().toUpperCase();
      const marketDefinition = MARKET_DEFINITION_BY_KEY.get(
        marketKey as PredictionMarket,
      );
      // Published recommendations must come from the active canonical catalogue.
      // Legacy enum values remain readable in settled history but are not active products.
      if (!marketDefinition || marketDefinition.pricingEnabled === false) continue;
      const marketName = String(document.marketName ?? marketKey);
      const documentQualityValue = Number(document.dataQuality ?? 0);
      const documentQuality = Number.isFinite(documentQualityValue)
        ? Math.max(0, Math.min(1, documentQualityValue))
        : 0;
      const validSelections = (document.selections ?? []).filter(
        (selection) =>
          selection.status === PredictionStatus.CALCULATED &&
          selection.isFinalSelection === true &&
          selection.recommendationEligible === true &&
          selection.oddsPredictionReady === true &&
          (selection.priceType === 'PROVIDER' ||
            selection.priceType === 'ESTIMATED') &&
          (selection.actualOutcome === undefined ||
            selection.actualOutcome === null),
      );
      // The market engine owns outcome selection. Pick Center accepts exactly
      // one final selection per market and never repairs or re-ranks malformed
      // market documents containing multiple final outcomes.
      if (validSelections.length > 1) {
        this.logger.warn(
          `Skipping malformed ${marketKey} prediction for ${eventId}: ${validSelections.length} final selections were marked eligible; exactly one is required.`,
        );
        continue;
      }
      const finalSelections = validSelections;

      for (const selection of finalSelections) {
        const probability = Number(selection.probability);
        const offeredOdds = Number(selection.decimalOdds);
        const confidenceInput = Number(selection.confidence ?? 0);
        const confidence = Number.isFinite(confidenceInput)
          ? Math.max(
              0,
              Math.min(config.model.maximumConfidence, confidenceInput),
            )
          : 0;
        const fairOddsInput = Number(selection.fairOdds);
        const fairOdds =
          Number.isFinite(fairOddsInput) && fairOddsInput > 1
            ? fairOddsInput
            : probability > 0
              ? 1 / probability
              : Number.NaN;
        const updatedAt =
          selection.oddsUpdatedAt instanceof Date
            ? selection.oddsUpdatedAt
            : new Date(String(selection.oddsUpdatedAt ?? ''));
        const hasDocumentQuality =
          document.dataQuality !== undefined &&
          document.dataQuality !== null &&
          Number.isFinite(documentQualityValue);
        const qualityInput = Number(
          selection.dataQuality ?? (hasDocumentQuality ? documentQuality : 0),
        );
        const dataQuality = Number.isFinite(qualityInput)
          ? Math.max(
              0,
              Math.min(
                1,
                Math.min(
                  hasDocumentQuality ? documentQuality : qualityInput,
                  qualityInput,
                ),
              ),
            )
          : 0;
        const directBookmaker =
          selection.priceType === 'PROVIDER' &&
          selection.oddsBasis === 'BOOKMAKER_ONLY' &&
          Boolean(selection.oddsProvider);

        // These are data-integrity checks only. Odds band, expected value,
        // confidence and historical sample size are ranked—not rejected here.
        if (
          !Number.isFinite(probability) ||
          probability <= 0 ||
          probability >= 1
        )
          continue;
        if (
          !Number.isFinite(offeredOdds) ||
          offeredOdds < 1.01 ||
          offeredOdds > 100000
        )
          continue;
        if (!Number.isFinite(fairOdds) || fairOdds <= 1) continue;
        if (!Number.isFinite(updatedAt.getTime())) continue;
        if (!isOddsQuoteFresh(updatedAt, now)) continue;
        if (!selection.oddsCalculationMethod || !selection.oddsBasis) continue;

        const settlementProfile = selection.settlementProfile ?? undefined;
        const expectedValue = directBookmaker
          ? PredictionMathUtil.expectedValue(
              probability,
              offeredOdds,
              settlementProfile,
            )
          : null;
        const evidenceConfidenceValue = Number(
          selection.evidenceConfidence ?? confidence,
        );
        const evidenceConfidence = Number.isFinite(evidenceConfidenceValue)
          ? Math.max(0, Math.min(98, evidenceConfidenceValue))
          : confidence;
        const calibration = calibrationAssessments.get(marketKey);
        const calibrationReliability = calibration?.active
          ? Math.max(0, Math.min(1, calibration.reliabilityScore / 100))
          : 0.5;
        const calibrationSampleSize = Math.max(
          0,
          Number(calibration?.sampleSize ?? 0),
        );
        const calibrationSupport = calibration?.active
          ? calibrationReliability *
            (calibrationSampleSize / (calibrationSampleSize + 30))
          : 0.5; // neutral until enough settled selected recommendations exist
        const provenanceScore =
          selection.priceType === 'PROVIDER'
            ? selection.oddsBasis === 'BOOKMAKER_ONLY'
              ? 1
              : 0.82
            : selection.oddsBasis === 'BOOKMAKER_PLUS_HISTORY'
              ? 0.68
              : selection.oddsBasis === 'HISTORICAL_ONLY'
                ? 0.54
                : 0.38;
        const confidenceScore = evidenceConfidence / 98;
        const priorityScore = 1 / (1 + this.marketPriority(marketKey));
        const providerValueScore =
          expectedValue === null
            ? 0
            : Math.max(0, Math.min(1, expectedValue / 0.5));
        const rankingScore = Number(
          (
            probability * 0.36 +
            confidenceScore * 0.15 +
            dataQuality * 0.15 +
            provenanceScore * 0.12 +
            calibrationSupport * 0.16 +
            providerValueScore * 0.04 +
            priorityScore * 0.02
          ).toFixed(6),
        );
        const selectionKey = String(selection.key ?? '');
        if (!selectionKey) continue;

        candidates.push({
          marketPredictionId: String(document._id ?? ''),
          marketKey,
          marketName,
          marketAbbreviation: String(document.marketAbbreviation ?? marketKey),
          selectionKey,
          selectionName: String(selection.fullName ?? selectionKey),
          selectionAbbreviation: String(selection.abbreviation ?? selectionKey),
          ...(Number.isFinite(Number(selection.line))
            ? { line: Number(selection.line) }
            : {}),
          ...(selection.subjectId !== undefined
            ? { subjectId: String(selection.subjectId) }
            : {}),
          ...(selection.subjectName
            ? { subjectName: String(selection.subjectName) }
            : {}),
          probability,
          probabilityPercent: Number((probability * 100).toFixed(2)),
          fairOdds,
          decimalOdds: offeredOdds,
          priceType: selection.priceType!,
          oddsUpdatedAt: updatedAt,
          oddsBasis: selection.oddsBasis,
          oddsCalculationMethod: String(selection.oddsCalculationMethod),
          ...(selection.oddsProvider
            ? { oddsProvider: selection.oddsProvider }
            : {}),
          ...(selection.bookmaker ? { bookmaker: selection.bookmaker } : {}),
          ...(selection.priceType === 'PROVIDER'
            ? { bookmakerOdds: offeredOdds }
            : {}),
          recommendationEligible: true,
          oddsPredictionReady: true,
          isFinalSelection: true,
          ...(expectedValue !== null
            ? {
                expectedValue: Number(expectedValue.toFixed(6)),
                expectedValuePercent: Number((expectedValue * 100).toFixed(2)),
              }
            : {}),
          dataQuality: Number(dataQuality.toFixed(4)),
          confidence,
          evidenceConfidence,
          rankingScore,
          isMatchResult: marketKey === 'MATCH_RESULT',
          status: PickStatus.SELECTED,
          marketPriority: this.marketPriority(marketKey),
          valueRatio: offeredOdds / fairOdds,
          calibrationReliability,
          calibrationSampleSize,
          safetyScore: rankingScore,
          ...(settlementProfile ? { settlementProfile } : {}),
          reasons: [
            `Market engine final selection: ${(probability * 100).toFixed(2)}% model probability; evidence confidence ${evidenceConfidence}/98; data quality ${(dataQuality * 100).toFixed(1)}%.`,
            selection.priceType === 'PROVIDER' &&
            selection.oddsBasis === 'BOOKMAKER_ONLY'
              ? `Odds-module price ${offeredOdds.toFixed(2)} is a direct ${selection.bookmaker ?? selection.oddsProvider ?? 'provider'} quote${expectedValue === null ? '' : `; model expected value ${(expectedValue * 100).toFixed(2)}%`}.`
              : `Odds-module price ${offeredOdds.toFixed(2)} is ${selection.priceType === 'ESTIMATED' ? 'an estimate' : 'provider-backed with derived provenance'} (${selection.oddsBasis}); it is not represented as a direct bookmaker offer.`,
            calibration?.active
              ? `Historical calibration informs ranking (${calibration.sampleSize} settled samples; reliability ${calibration.reliabilityScore}/100).`
              : 'Market-specific calibration sample is insufficient; no calibration uplift was assumed.',
          ],
        });
      }
    }

    candidates.sort(
      (a, b) =>
        b.rankingScore - a.rankingScore ||
        b.probability - a.probability ||
        b.confidence - a.confidence ||
        b.dataQuality - a.dataQuality ||
        this.marketPriority(a.marketKey) - this.marketPriority(b.marketKey) ||
        a.marketKey.localeCompare(b.marketKey),
    );

    // Each market can offer many outcomes, but Pick Center publishes only one
    // selected outcome per market: the highest-ranked eligible candidate.
    const bestByMarket = new Map<string, (typeof candidates)[number]>();
    for (const candidate of candidates) {
      if (!bestByMarket.has(candidate.marketKey)) {
        bestByMarket.set(candidate.marketKey, candidate);
      }
    }
    const selected = [...bestByMarket.values()].map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
    }));
    const status =
      selected.length > 0 ? PickStatus.SELECTED : PickStatus.INELIGIBLE;
    const generalConfidence = selected.length
      ? Math.round(
          selected.reduce((sum, item) => sum + item.confidence, 0) /
            selected.length,
        )
      : undefined;
    const exclusionReason = selected.length
      ? undefined
      : 'No final Odds-ready market selections were available to rank for this unfinished fixture.';
    const first = marketDocuments[0];

    // Re-read Sports at the write boundary. If kickoff occurred while this
    // ranking was in progress, preserve the last pre-match Pick Center snapshot.
    if (!(await this.predictionDataService.isFixturePreMatch(eventId))) {
      return this.getFrozenSnapshotResult(eventId);
    }

    const saved = await this.pickCenterModel
      .findOneAndUpdate(
        { eventId },
        {
          $set: {
            eventId,
            leagueId: first.leagueId,
            fixtureDate: first.fixtureDate,
            retentionExpiresAt: retentionExpiresAt ?? null,
            live: false,
            completed: false,
            homeTeamName: first.homeTeamName,
            awayTeamName: first.awayTeamName,
            status,
            selectedMarkets: selected,
            eligibleMarketCount: selected.length,
            selectedMarketCount: selected.length,
            generalConfidence,
            modelVersion,
            exclusionReason,
          },
        },
        {
          upsert: true,
          returnDocument: 'after',
          setDefaultsOnInsert: true,
          runValidators: true,
        },
      )
      .exec();

    if (!selected.length) {
      try {
        await this.curatedPredictionService.withdrawActiveForEvent(
          eventId,
          exclusionReason ?? 'No final market selection remains.',
        );
      } catch (error) {
        this.logger.warn(
          `Could not withdraw stale curated prediction for ${eventId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    try {
      await this.curatedPredictionService.refreshFromPickCenter();
    } catch (error) {
      this.logger.warn(
        `Curated prediction refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.logger.log(
      `Pick Center rebuilt for ${eventId}: ranked ${selected.length} market-engine final selections (${selected.filter((item) => item.priceType === 'PROVIDER').length} provider-priced, ${selected.filter((item) => item.priceType === 'ESTIMATED').length} estimated).`,
    );
    await this.monitor.recordEvent({
      type: 'PICK_CENTER_UPDATED',
      level: selected.length ? 'INFO' : 'WARNING',
      eventId,
      message: `Pick Center ranked ${selected.length} market-engine final selections; it did not select or reject market outcomes.`,
      metadata: {
        selectedCount: selected.length,
        providerPricedCount: selected.filter(
          (item) => item.priceType === 'PROVIDER',
        ).length,
        estimatedCount: selected.filter(
          (item) => item.priceType === 'ESTIMATED',
        ).length,
        status,
        exclusionReason,
      },
    });

    return {
      eventId,
      selectedCount: saved?.selectedMarketCount ?? selected.length,
      eligibleCount: selected.length,
      status,
    };
  }

  private async getFrozenSnapshotResult(
    eventId: string,
  ): Promise<PickCenterUpdateResult> {
    const existing = await this.pickCenterModel
      .findOne({ eventId })
      .select({ selectedMarkets: 1, selectedMarketCount: 1, eligibleMarketCount: 1 })
      .lean()
      .exec();

    const selectedCount = Number(
      existing?.selectedMarketCount ?? existing?.selectedMarkets?.length ?? 0,
    );
    const eligibleCount = Number(
      existing?.eligibleMarketCount ?? selectedCount,
    );

    return {
      eventId,
      selectedCount: Number.isFinite(selectedCount) ? selectedCount : 0,
      eligibleCount: Number.isFinite(eligibleCount) ? eligibleCount : 0,
      status: 'FROZEN',
    };
  }

  private marketPriority(marketKey: string): number {
    if (marketKey === 'MATCH_RESULT') return 0;
    if (marketKey.startsWith('BOTH_TEAMS_TO_SCORE')) return 1;
    if (marketKey.includes('DRAW_NO_BET')) return 2;
    if (marketKey.includes('DOUBLE_CHANCE')) return 3;
    if (marketKey.includes('OVER_UNDER') || marketKey === 'GOALS_OVER_UNDER')
      return 4;
    return 5;
  }
}



