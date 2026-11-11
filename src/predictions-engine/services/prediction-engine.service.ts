import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AnyBulkWriteOperation, Model } from 'mongoose';
import { randomUUID } from 'node:crypto';

import { MarketPrediction } from '../schemas/market-prediction.schema';
import { PredictionRun } from '../schemas/prediction-run.schema';
import { PredictionRunStatus } from '../enums/prediction-run-status.enum';
import { PredictionStatus } from '../enums/prediction-status.enum';
import {
  PredictionDataService,
  PredictionSourceRevisionChangedError,
} from './prediction-data.service';
import type { PredictionModelInput } from '../interfaces/prediction-match-context.interface';
import { ExpectedGoalsService } from './expected-goals.service';
import { MarketOddsService } from './market-odds.service';
import { MarketPredictionCalculationService } from './market-prediction-calculation.service';
import { PredictionMathUtil } from '../utils/prediction-math.util';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { PickCenterService } from './pick-center.service';
import { PredictionEngineMonitorService } from './prediction-engine-monitor.service';
import { getMarketDefinition } from '../catalog/football-market-catalog';
import { MarketCalibrationService } from './market-calibration.service';
import { SettlementTriggerService } from '../../settlement/services/settlement-trigger.service';
import { OddsReadService } from '../../odds/services/odds-read.service';
import { FOOTBALL_MARKET_BY_PREDICTION_KEY } from '../../odds/catalog/football-market-catalog';
import { hasReusableFinalMarketSnapshot } from '../utils/prediction-market-snapshot.util';

@Injectable()
export class PredictionEngineService {
  private readonly logger = new Logger(PredictionEngineService.name);

  constructor(
    @InjectModel(MarketPrediction.name)
    private readonly marketPredictionModel: Model<MarketPrediction>,
    @InjectModel(PredictionRun.name)
    private readonly predictionRunModel: Model<PredictionRun>,
    private readonly predictionDataService: PredictionDataService,
    private readonly expectedGoalsService: ExpectedGoalsService,
    private readonly marketOddsService: MarketOddsService,
    private readonly marketCalculationService: MarketPredictionCalculationService,
    private readonly pickCenterService: PickCenterService,
    private readonly monitor: PredictionEngineMonitorService,
    private readonly marketCalibrationService: MarketCalibrationService,
    private readonly settlementTrigger: SettlementTriggerService,
    private readonly oddsService: OddsReadService,
  ) {}

  async generateForFixture(eventId: string): Promise<any> {
    // Prediction generation consumes canonical Sports facts and Odds-module prices.
    // Sports owns fixture collection; the Odds module gates exact selection readiness.
    const startedAt = new Date();
    const runId = randomUUID();
    const modelVersion = PREDICTION_ENGINE_CONFIG.modelVersion;
    let runRecordId: string | undefined;

    await this.monitor.recordEvent({
      type: 'PREDICTION_STARTED',
      level: 'INFO',
      eventId,
      runId,
      message: `Prediction generation started for Sports fixture ${eventId}.`,
    });

    try {
      const context =
        await this.predictionDataService.loadForPrediction(eventId);
      // Loading match evidence can take time. Recheck the canonical Sports
      // fixture before doing any model work so a kickoff transition wins.
      await this.predictionDataService.assertFixtureStillPreMatch(
        context.fixture.eventId,
      );

      // The Odds module is authoritative. This gate also protects direct/admin
      // calls that bypass the durable prediction queue worker.
      const readinessByEvent = await this.oddsService.getPredictionReadinessForEvents([context.fixture.eventId]);
      const readiness = readinessByEvent.get(String(context.fixture.eventId));
      if (!readiness?.ready) {
        throw new UnprocessableEntityException(
          readiness?.reason ?? 'The Odds module has not marked this fixture prediction-ready.',
        );
      }
      const expectedGoals = this.expectedGoalsService.estimate(context);
      const marketOdds = this.marketOddsService.extractMatchResultOdds(context);
      const scoreMatrixBase = PredictionMathUtil.scoreMatrix(
        expectedGoals.home,
        expectedGoals.away,
        PREDICTION_ENGINE_CONFIG.model.maxGoals,
      );

      // All market calculations are pre-match. Live score conditioning has
      // deliberately been removed; fixtures cannot be forecast after kickoff.
      let scoreMatrix = scoreMatrixBase;
      if (
        marketOdds &&
        marketOdds.home !== undefined &&
        marketOdds.draw !== undefined &&
        marketOdds.away !== undefined
      ) {
        const modelResult =
          PredictionMathUtil.resultProbabilities(scoreMatrixBase);
        const oddsWeight = PREDICTION_ENGINE_CONFIG.model.oddsBlendWeight;
        const reconciledResult = PredictionMathUtil.normalizeThreeWay({
          home:
            modelResult.home * (1 - oddsWeight) + marketOdds.home * oddsWeight,
          draw:
            modelResult.draw * (1 - oddsWeight) + marketOdds.draw * oddsWeight,
          away:
            modelResult.away * (1 - oddsWeight) + marketOdds.away * oddsWeight,
        });
        scoreMatrix = PredictionMathUtil.normalizeResultMatrix(
          scoreMatrixBase,
          reconciledResult,
        );
      }

      const firstHalfMatrix = PredictionMathUtil.scoreMatrix(
        expectedGoals.home * expectedGoals.homeFirstHalfGoalShare,
        expectedGoals.away * expectedGoals.awayFirstHalfGoalShare,
        PREDICTION_ENGINE_CONFIG.model.maxGoals,
      );
      const secondHalfMatrix = PredictionMathUtil.scoreMatrix(
        expectedGoals.home * (1 - expectedGoals.homeFirstHalfGoalShare),
        expectedGoals.away * (1 - expectedGoals.awayFirstHalfGoalShare),
        PREDICTION_ENGINE_CONFIG.model.maxGoals,
      );

      const input: PredictionModelInput = {
        context,
        expectedGoals,
        scoreMatrix,
        firstHalfMatrix,
        secondHalfMatrix,
        marketOdds,
        modelVersion,
      };

      const runCreated = await this.predictionRunModel.create({
        runId,
        eventId: context.fixture.eventId,
        leagueId: context.fixture.leagueId,
        fixtureDate: context.fixture.fixtureDate,
        retentionExpiresAt: context.fixture.retentionExpiresAt ?? null,
        fixtureSourceRevision: context.fixtureSourceRevision,
        status: PredictionRunStatus.PROCESSING,
        modelVersion,
        startedAt,
      });
      runRecordId = String(runCreated._id);

      // Load the most recently persisted calibration first. If a rebuild fails,
      // predictions must retain trusted existing assessments rather than silently
      // reverting every market to an uncalibrated model.
      let calibrationAssessments: Awaited<
        ReturnType<MarketCalibrationService['getAssessments']>
      > = new Map();
      try {
        calibrationAssessments = await this.marketCalibrationService.getAssessments();
      } catch (assessmentError) {
        this.logger.error(
          `Stored calibration assessments could not be loaded for ${eventId}: ${assessmentError instanceof Error ? assessmentError.message : String(assessmentError)}`,
        );
        await this.monitor.recordEvent({
          type: 'CALIBRATION_UPDATED',
          level: 'ERROR',
          eventId: context.fixture.eventId,
          runId,
          message: 'Stored calibration assessments could not be loaded; this run has reduced calibration coverage.',
          metadata: { error: assessmentError instanceof Error ? assessmentError.message : String(assessmentError) },
        });
      }
      // Calibration rebuilds run in the independent maintenance cycle, not
      // inside every fixture calculation. Each market run consumes the latest
      // successfully persisted assessments without waiting for a full rebuild.
      const generatedAt = new Date();
      const sourceSummaryCollectedAt = context.fixture.summaryCollectedAt
        ? new Date(context.fixture.summaryCollectedAt)
        : null;
      const existingMarketRows = (await this.marketPredictionModel
        .find({ eventId: context.fixture.eventId, modelVersion })
        .select({ marketKey: 1, status: 1, fixtureSourceRevision: 1, selections: 1 })
        .lean()
        .exec()) as Array<Record<string, any>>;
      const existingByMarketKey = new Map(
        existingMarketRows.map((row) => [String(row.marketKey), row]),
      );
      let persistedMarketDocuments = 0;
      let preservedMarketDocuments = 0;
      let persistenceBatches = 0;

      const calculations = await this.marketCalculationService.calculateProgressively(
        input,
        calibrationAssessments,
        async (batch, progress) => {
          // A fixture may change while a long catalogue is being calculated.
          // Validate before each commit batch so only the current Sports revision
          // can be written, even when earlier market batches have already landed.
          await this.predictionDataService.assertFixtureStillPreMatch(
            context.fixture.eventId,
          );
          await this.predictionDataService.assertFixtureSourceRevision(
            context.fixture.eventId,
            context.fixtureSourceRevision,
          );

          const operations: AnyBulkWriteOperation<MarketPrediction>[] = [];
          for (const calculation of batch) {
            const marketKey = String(calculation.marketKey);
            const canonicalMarket = FOOTBALL_MARKET_BY_PREDICTION_KEY.get(marketKey);
            const existing = existingByMarketKey.get(marketKey);
            const hasFinalSelection = calculation.status === PredictionStatus.CALCULATED
              && calculation.selections.some((selection) =>
                selection.status === PredictionStatus.CALCULATED
                && selection.isFinalSelection === true
                && selection.recommendationEligible === true
                && selection.oddsPredictionReady === true
                && (selection.priceType === 'PROVIDER' || selection.priceType === 'ESTIMATED'),
              );

            // Keep an existing good market only if its Sports revision and its
            // exact current Odds quote have not changed. A newly available price
            // or better model result will replace it immediately in this batch.
            if (!hasFinalSelection
              && getMarketDefinition(marketKey)?.pricingEnabled !== false
              && canonicalMarket
              && hasReusableFinalMarketSnapshot(
                existing,
                canonicalMarket.id,
                context.fixtureSourceRevision,
                context.storedOdds ?? [],
              )) {
              preservedMarketDocuments += 1;
              continue;
            }

            operations.push({
              updateOne: {
                filter: {
                  eventId: context.fixture.eventId,
                  marketKey: calculation.marketKey,
                  modelVersion,
                },
                update: {
                  $set: {
                    eventId: context.fixture.eventId,
                    leagueId: context.fixture.leagueId,
                    fixtureDate: context.fixture.fixtureDate,
                    retentionExpiresAt: context.fixture.retentionExpiresAt ?? null,
                    fixtureSourceRevision: context.fixtureSourceRevision,
                    live: false,
                    completed: false,
                    homeTeamId: context.fixture.homeTeamId,
                    awayTeamId: context.fixture.awayTeamId,
                    homeTeamName: context.homeTeam.name,
                    awayTeamName: context.awayTeam.name,
                    marketKey: calculation.marketKey,
                    marketJsonVariable:
                      getMarketDefinition(calculation.marketKey)?.jsonVariable
                      ?? calculation.marketKey,
                    marketName: calculation.marketName,
                    marketAbbreviation: calculation.marketAbbreviation,
                    family: calculation.family as MarketPrediction['family'],
                    period: calculation.period,
                    status: calculation.status,
                    selections: calculation.selections.map((selection) => ({
                      ...selection,
                      decimalOdds: selection.decimalOdds ?? undefined,
                      bookmakerOdds: selection.bookmakerOdds ?? undefined,
                      oddsUpdatedAt: selection.oddsUpdatedAt ?? undefined,
                      oddsBasis: selection.oddsBasis ?? undefined,
                      oddsCalculationMethod: selection.oddsCalculationMethod ?? undefined,
                      oddsProvider: selection.oddsProvider ?? undefined,
                      bookmaker: selection.bookmaker ?? undefined,
                      diagnostics: selection.diagnostics ?? [],
                    })) as MarketPrediction['selections'],
                    sources: calculation.sources,
                    modelVersion,
                    calculationMethod: calculation.calculationMethod,
                    dataQuality: calculation.dataQuality,
                    diagnostics: calculation.diagnostics,
                    expectedGoals: {
                      home: expectedGoals.home,
                      away: expectedGoals.away,
                    },
                    ...(sourceSummaryCollectedAt && Number.isFinite(sourceSummaryCollectedAt.getTime())
                      ? { sourceSummaryCollectedAt }
                      : { sourceSummaryCollectedAt: null }),
                    generatedAt,
                  },
                },
                upsert: true,
              },
            });
          }

          if (operations.length) {
            await this.marketPredictionModel.bulkWrite(operations, { ordered: false });
            persistedMarketDocuments += operations.length;
            persistenceBatches += 1;
          }
          this.logger.debug(
            `Progressive market generation for ${context.fixture.eventId}: ${progress.processedMarkets}/${progress.totalMarkets} markets calculated; ${persistedMarketDocuments} market documents written and ${preservedMarketDocuments} current snapshots preserved across ${persistenceBatches} persistence batches.`,
          );
        },
        8,
      );

      // Revalidate once more before dependent settlement and Pick Center work.
      await this.predictionDataService.assertFixtureStillPreMatch(
        context.fixture.eventId,
      );
      await this.predictionDataService.assertFixtureSourceRevision(
        context.fixture.eventId,
        context.fixtureSourceRevision,
      );
      const hasSettlementTarget = calculations.some(
        (calculation) =>
          (calculation.status === PredictionStatus.CALCULATED ||
            calculation.status === PredictionStatus.PARTIAL) &&
          calculation.selections.some(
            (selection) =>
              selection.status !== PredictionStatus.UNAVAILABLE &&
              selection.status !== PredictionStatus.FAILED,
          ),
      );
      if (hasSettlementTarget) {
        try {
          await this.settlementTrigger.onTargetsCreated(
            [context.fixture.eventId],
            'PREDICTION_CREATED',
          );
        } catch (settlementError) {
          this.logger.error(
            `Settlement handoff failed for persisted prediction fixture ${context.fixture.eventId}; recurring reconciliation will retry: ${settlementError instanceof Error ? settlementError.message : String(settlementError)}`,
          );
        }
      }

      const savedMarkets = (await this.marketPredictionModel
        .find({
          eventId: context.fixture.eventId,
          modelVersion,
        })
        .lean()
        .exec()) as any[];
      const calculatedMarkets = calculations.filter(
        (item) => item.status === PredictionStatus.CALCULATED,
      ).length;
      const partialMarkets = calculations.filter(
        (item) => item.status === PredictionStatus.PARTIAL,
      ).length;
      const unavailableMarkets = calculations.filter(
        (item) => item.status === PredictionStatus.UNAVAILABLE,
      ).length;
      const failedMarkets = calculations.filter(
        (item) => item.status === PredictionStatus.FAILED,
      ).length;
      const totalSelections = calculations.reduce(
        (sum, item) => sum + item.selections.length,
        0,
      );
      const calculatedSelections = calculations.reduce(
        (sum, item) =>
          sum +
          item.selections.filter(
            (selection) => selection.status === PredictionStatus.CALCULATED,
          ).length,
        0,
      );
      const minimumConfidence =
        PREDICTION_ENGINE_CONFIG.selectionEligibility.minimumConfidence;
      const calculatedSelectionRecords = calculations
        .flatMap((item) => item.selections)
        .filter(
          (selection) =>
            selection.status === PredictionStatus.CALCULATED &&
            Number.isFinite(Number(selection.confidence)),
        );
      const perMarketConfidence = calculatedSelectionRecords.map((selection) =>
        Number(selection.confidence),
      );
      const qualifiedConfidenceCount = perMarketConfidence.filter(
        (value) => value >= minimumConfidence,
      ).length;
      const generalConfidence = perMarketConfidence.length
        ? Math.max(
            0,
            Math.min(
              98,
              Math.round(
                perMarketConfidence.reduce((sum, value) => sum + value, 0) /
                  perMarketConfidence.length,
              ),
            ),
          )
        : undefined;
      const providerPricedSelections = calculatedSelectionRecords.filter(
        (selection) => selection.priceType === 'PROVIDER',
      );
      const oddsCoverage = calculatedSelectionRecords.length
        ? Number(
            (
              providerPricedSelections.length /
              calculatedSelectionRecords.length
            ).toFixed(4),
          )
        : 0;
      const dataQuality = calculations.length
        ? calculations.reduce((sum, item) => sum + item.dataQuality, 0) /
          calculations.length
        : 0;
      const durationMs = Date.now() - startedAt.getTime();
      const status =
        unavailableMarkets || failedMarkets || partialMarkets
          ? PredictionRunStatus.PARTIAL
          : PredictionRunStatus.COMPLETED;
      const finalSelections = calculations.flatMap((item) => item.selections);
      const providerMissingCount = finalSelections.filter(
        (selection) =>
          selection.status === PredictionStatus.CALCULATED &&
          selection.priceType !== 'PROVIDER',
      ).length;
      const providerPricedNonFinalAlternatives = finalSelections.filter(
        (selection) =>
          selection.status === PredictionStatus.CALCULATED &&
          selection.priceType === 'PROVIDER' &&
          selection.isFinalSelection !== true,
      ).length;
      const pricedButUnmodelledSelections = finalSelections.filter(
        (selection) => selection.status === PredictionStatus.UNAVAILABLE
          && selection.oddsPredictionReady === true
          && (selection.priceType === 'PROVIDER' || selection.priceType === 'ESTIMATED'),
      ).length;
      const diagnostics = [
        ...expectedGoals.evidence,
        `Sports fixture source revision used: ${context.fixtureSourceRevision}.`,
        `Core evidence assessment: ${expectedGoals.evidenceLevel}; independent statistical evidence ${expectedGoals.independentEvidenceAvailable ? 'available' : 'unavailable'}.`,
        `Evidence counts: home form ${expectedGoals.homeRecentFormSamples}; away form ${expectedGoals.awayRecentFormSamples}; H2H ${expectedGoals.historicalHeadToHeadMatches}; league scored fixtures ${expectedGoals.leagueSamples}; matched standings for both teams ${expectedGoals.standingsStrengthAvailable ? 'yes' : 'no'}.`,
        `Market selection audit: ${providerMissingCount} calculated candidates use estimated Odds-module prices; ${providerPricedNonFinalAlternatives} other provider-priced candidates were not chosen as their market's single final outcome; ${pricedButUnmodelledSelections} Odds-ready quotes were retained as prices but withheld from prediction because no independent model probability was available.`,
        `Odds-module 1X2 baseline: ${marketOdds?.source ?? 'none'}.`,
        context.summaryAvailable
          ? 'Normalized Sports match projection: available.'
          : 'Normalized Sports match projection: unavailable; only markets with independently sufficient historical evidence can be calculated.',
        `Active calibrated markets: ${[...calibrationAssessments.values()].filter((item) => item.active).length}.`,
        `Markets calculated: ${calculatedMarkets}; partial: ${partialMarkets}; unavailable: ${unavailableMarkets}; failed: ${failedMarkets}.`,
        `Progressive persistence: ${persistedMarketDocuments} market documents written; ${preservedMarketDocuments} current market snapshots preserved; ${persistenceBatches} database batches.`,
        `Selections meeting the evidence-confidence threshold (>= ${minimumConfidence}/98): ${qualifiedConfidenceCount}/${perMarketConfidence.length}.`,
        `Fresh provider-odds coverage across calculated final selections: ${(oddsCoverage * 100).toFixed(1)}%.`,
        ...calculations
          .filter((item) => item.status === PredictionStatus.UNAVAILABLE)
          .slice(0, 15)
          .map(
            (item) =>
              `${item.marketKey}: ${item.unavailableReason ?? 'insufficient market-specific evidence'}`,
          ),
      ];

      const runSummary = {
        runId,
        eventId: context.fixture.eventId,
        retentionExpiresAt: context.fixture.retentionExpiresAt ?? null,
        fixtureSourceRevision: context.fixtureSourceRevision,
        status,
        modelVersion,
        startedAt,
        completedAt: new Date(),
        durationMs,
        totalMarkets: calculations.length,
        calculatedMarkets,
        partialMarkets,
        unavailableMarkets,
        failedMarkets,
        persistedMarketDocuments,
        preservedMarketDocuments,
        persistenceBatches,
        totalSelections,
        calculatedSelections,
        generalConfidence,
        averageConfidence: generalConfidence,
        oddsCoverage,
        expectedHomeGoals: expectedGoals.home,
        expectedAwayGoals: expectedGoals.away,
        dataQuality,
        diagnostics,
      };

      await this.predictionRunModel
        .findByIdAndUpdate(
          runRecordId,
          { $set: runSummary },
          { returnDocument: 'after' },
        )
        .exec();

      await this.predictionDataService.assertFixtureStillPreMatch(
        context.fixture.eventId,
      );
      await this.predictionDataService.assertFixtureSourceRevision(
        context.fixture.eventId,
        context.fixtureSourceRevision,
      );
      const pickCenterResult = await this.pickCenterService.rebuildForEvent(
        context.fixture.eventId,
        runSummary,
      );
      // Slip Center has its own recurring cycle. A rejected/failed slip must
      // never turn a successfully saved market run into a failed prediction run.

      await this.monitor.recordRunCompleted({
        status,
        eventId: context.fixture.eventId,
        runId,
        calculatedMarkets,
        totalMarkets: calculations.length,
        durationMs,
        generalConfidence,
      });

      this.logger.log(
        `Prediction run ${runId} completed for ${context.fixture.homeTeamId} vs ${context.fixture.awayTeamId}: ${calculatedSelections}/${totalSelections} selections calculated.`,
      );

      return {
        ...runSummary,
        savedMarketDocuments: savedMarkets.length,
        persistedMarketDocuments,
        preservedMarketDocuments,
        persistenceBatches,
        oddsBaseline: marketOdds,
        expectedGoals,
        pickCenter: pickCenterResult,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runRecordId) {
        await this.predictionRunModel
          .findByIdAndUpdate(runRecordId, {
            $set: {
              status: PredictionRunStatus.FAILED,
              completedAt: new Date(),
              durationMs: Date.now() - startedAt.getTime(),
              errorMessage: message,
            },
          })
          .exec()
          .catch(() => undefined);
      }
      if (error instanceof PredictionSourceRevisionChangedError) {
        await this.monitor.recordEvent({
          type: 'PREDICTION_PARTIAL',
          level: 'WARNING',
          eventId,
          runId,
          message: `Prediction run for ${eventId} was superseded by a newer Sports fixture revision and will be recalculated.`,
          metadata: { retryable: true, sourceRevisionChanged: true },
        });
        throw error;
      }
      if (
        error instanceof NotFoundException ||
        error instanceof UnprocessableEntityException
      ) {
        await this.monitor.recordEvent({
          type: 'PREDICTION_SKIPPED',
          level: 'WARNING',
          eventId,
          runId,
          message: `Prediction run skipped for event ${eventId}: ${message}`,
          metadata: { expectedSkip: true },
        });
        throw error;
      }
      await this.monitor.recordRunFailed(eventId, runId, message);
      throw error;
    }
  }

}




