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
import { PredictionDataService } from './prediction-data.service';
import { ExpectedGoalsService } from './expected-goals.service';
import { MarketOddsService } from './market-odds.service';
import { MarketPredictionCalculationService } from './market-prediction-calculation.service';
import { PredictionMathUtil } from '../utils/prediction-math.util';
import { PredictionModelInput } from '../interfaces/espn-prediction-context.interface';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { PickCenterService } from './pick-center.service';
import { PredictionEngineMonitorService } from './prediction-engine-monitor.service';
import { getMarketDefinition } from '../catalog/football-market-catalog';
import { MarketCalibrationService } from './market-calibration.service';
import { SettlementTriggerService } from '../../settlement/services/settlement-trigger.service';
import { OddsService } from '../../odds/services/odds.service';

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
    private readonly oddsService: OddsService,
  ) {}

  async generateForFixture(eventId: string): Promise<any> {
    // Prediction generation is not coupled to the ESPN collection queue. The
    // Odds module controls selection readiness; generation only excludes matches
    // that have already finished.
    const startedAt = new Date();
    const runId = randomUUID();
    const modelVersion = PREDICTION_ENGINE_CONFIG.modelVersion;
    let runRecordId: string | undefined;

    await this.monitor.recordEvent({
      type: 'PREDICTION_STARTED',
      level: 'INFO',
      eventId,
      runId,
      message: `Prediction generation started for ESPN event ${eventId}.`,
    });

    try {
      const context =
        await this.predictionDataService.loadForPrediction(eventId);
      if (this.isFinishedFixture(context)) {
        throw new UnprocessableEntityException(
          'Prediction generation is unavailable for a fixture that has finished.',
        );
      }
      if (!this.isInPredictionWindow(context)) {
        throw new UnprocessableEntityException(
          `Only unfinished fixtures within the next ${PREDICTION_ENGINE_CONFIG.queue.forwardWindowHours} hours and active live fixtures can be forecast.`,
        );
      }

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

      const liveState = context.fixture.live
        ? this.getLiveMatchState(context)
        : null;
      let scoreMatrix = liveState
        ? this.buildLiveFullTimeMatrix(expectedGoals, liveState)
        : scoreMatrixBase;
      if (liveState) {
        expectedGoals.evidence.push(
          `In-play score-conditioned forecast: current score ${liveState.homeScore}-${liveState.awayScore}; estimated elapsed minute ${liveState.elapsedMinutes}. Remaining goal expectation is scaled to the estimated time remaining.`,
        );
      }
      // Do not reapply a potentially pre-match 1X2 quote to a live score matrix.
      // The exact market quotes still flow through selection-level Odds readiness.
      if (
        !context.fixture.live &&
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

      const firstHalfShare = PREDICTION_ENGINE_CONFIG.model.firstHalfGoalShare;
      const firstHalfMatrix = PredictionMathUtil.scoreMatrix(
        expectedGoals.home * firstHalfShare,
        expectedGoals.away * firstHalfShare,
        PREDICTION_ENGINE_CONFIG.model.maxGoals,
      );
      const secondHalfMatrix = PredictionMathUtil.scoreMatrix(
        expectedGoals.home * (1 - firstHalfShare),
        expectedGoals.away * (1 - firstHalfShare),
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
      const calculations = this.marketCalculationService.calculateAll(
        input,
        calibrationAssessments,
      );
      const generatedAt = new Date();
      const sourceSummaryCollectedAt = context.fixture.summaryCollectedAt
        ? new Date(context.fixture.summaryCollectedAt)
        : null;
      const bulkOperations: AnyBulkWriteOperation<MarketPrediction>[] =
        calculations.map(
          (calculation): AnyBulkWriteOperation<MarketPrediction> => ({
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
                  live: context.fixture.live === true,
                  completed: context.fixture.completed === true,
                  homeTeamId: context.fixture.homeTeamId,
                  awayTeamId: context.fixture.awayTeamId,
                  homeTeamName: context.homeTeam.name,
                  awayTeamName: context.awayTeam.name,
                  marketKey: calculation.marketKey,
                  marketJsonVariable:
                    getMarketDefinition(calculation.marketKey)?.jsonVariable ??
                    calculation.marketKey,
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
                    oddsCalculationMethod:
                      selection.oddsCalculationMethod ?? undefined,
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
                  ...(sourceSummaryCollectedAt &&
                  Number.isFinite(sourceSummaryCollectedAt.getTime())
                    ? { sourceSummaryCollectedAt }
                    : { sourceSummaryCollectedAt: null }),
                  generatedAt,
                },
              },
              upsert: true,
            },
          }),
        );

      if (bulkOperations.length) {
        await this.marketPredictionModel.bulkWrite(bulkOperations, {
          ordered: false,
        });
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
          await this.settlementTrigger.onTargetsCreated(
            [context.fixture.eventId],
            'PREDICTION_CREATED',
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
      const oddsFallbackSelections = calculations
        .flatMap((item) => item.selections)
        .filter((selection) => String(selection.calculationMethod ?? '').includes('Odds-module implied-probability fallback'))
        .length;
      const diagnostics = [
        ...expectedGoals.evidence,
        `Core evidence assessment: ${expectedGoals.evidenceLevel}; independent statistical evidence ${expectedGoals.independentEvidenceAvailable ? 'available' : 'unavailable'}.`,
        `Evidence counts: home form ${expectedGoals.homeRecentFormSamples}; away form ${expectedGoals.awayRecentFormSamples}; H2H ${expectedGoals.historicalHeadToHeadMatches}; league scored fixtures ${expectedGoals.leagueSamples}; matched standings for both teams ${expectedGoals.standingsStrengthAvailable ? 'yes' : 'no'}.`,
        `Market selection audit: ${providerMissingCount} calculated candidates use estimated Odds-module prices; ${providerPricedNonFinalAlternatives} other provider-priced candidates were not chosen as their market's single final outcome; ${oddsFallbackSelections} selections used the Odds-module implied-probability fallback.`,
        `Summary odds baseline: ${marketOdds?.source ?? 'none'}.`,
        context.summaryAvailable
          ? 'ESPN Summary evidence: available.'
          : 'ESPN Summary evidence: missing; fixture-history fallback mode was used, and markets without sufficient evidence remain unavailable.',
        `Active calibrated markets: ${[...calibrationAssessments.values()].filter((item) => item.active).length}.`,
        `Markets calculated: ${calculatedMarkets}; partial: ${partialMarkets}; unavailable: ${unavailableMarkets}; failed: ${failedMarkets}.`,
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

  private isInPredictionWindow(context: PredictionModelInput['context']): boolean {
    if (context.fixture.live === true) return true;
    const fixtureDate = context.fixture.fixtureDate instanceof Date
      ? context.fixture.fixtureDate.getTime()
      : new Date(context.fixture.fixtureDate).getTime();
    if (!Number.isFinite(fixtureDate)) return false;
    const now = Date.now();
    const horizon = now + PREDICTION_ENGINE_CONFIG.queue.forwardWindowHours * 60 * 60_000;
    return fixtureDate >= now && fixtureDate <= horizon;
  }

  private isFinishedFixture(context: PredictionModelInput['context']): boolean {
    if (context.fixture.completed === true) return true;
    const roots: Array<Record<string, any>> = [context.summary, context.fixture.payload];
    const statusValues: unknown[] = [context.fixture.status];
    for (const root of roots) {
      statusValues.push(root.status, root.statusDetail, root.statusShortDetail);
      const header = root.header && typeof root.header === 'object' ? root.header : {};
      const competitionLists = [
        Array.isArray(header.competitions) ? header.competitions : [],
        Array.isArray(root.competitions) ? root.competitions : [],
      ];
      for (const list of competitionLists) {
        for (const competition of list) {
          if (!competition || typeof competition !== 'object') continue;
          const status = competition.status && typeof competition.status === 'object' ? competition.status : {};
          const type = status.type && typeof status.type === 'object' ? status.type : {};
          if (status.completed === true || type.completed === true) return true;
          statusValues.push(status.name, status.detail, status.shortDetail, status.state, type.name, type.detail, type.shortDetail, type.state);
        }
      }
    }
    return statusValues.some((value) =>
      /(^|[^A-Z])(FINAL|FINISHED|FULL[ _-]?TIME|AFTER EXTRA TIME|AFTER PENALTIES|STATUS_FINAL|POST|FT)([^A-Z]|$)/i.test(String(value ?? ''))
      || /postpon|cancel|abandon|delay/i.test(String(value ?? '')),
    );
  }

  private getLiveMatchState(context: PredictionModelInput['context']): {
    homeScore: number;
    awayScore: number;
    elapsedMinutes: number;
  } | null {
    const toScore = (value: unknown): number | null => {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0) return Math.floor(Number(value));
      return null;
    };

    let homeScore = toScore(context.fixture.homeScore);
    let awayScore = toScore(context.fixture.awayScore);
    const roots: Array<Record<string, any>> = [context.summary, context.fixture.payload];
    const statusCandidates: Array<Record<string, any>> = [];

    for (const root of roots) {
      const header = root.header && typeof root.header === 'object' ? root.header : {};
      const competitionLists = [
        Array.isArray(header.competitions) ? header.competitions : [],
        Array.isArray(root.competitions) ? root.competitions : [],
      ];
      for (const list of competitionLists) {
        for (const competition of list) {
          if (!competition || typeof competition !== 'object') continue;
          const status = competition.status && typeof competition.status === 'object' ? competition.status : {};
          statusCandidates.push(status);
          const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
          for (const competitor of competitors) {
            if (!competitor || typeof competitor !== 'object') continue;
            const side = String(competitor.homeAway ?? '').toLowerCase();
            const score = toScore(competitor.score);
            if (score === null) continue;
            if (side === 'home' && homeScore === null) homeScore = score;
            if (side === 'away' && awayScore === null) awayScore = score;
          }
        }
      }
      if (root.status && typeof root.status === 'object') statusCandidates.push(root.status);
    }

    if (homeScore === null || awayScore === null) return null;

    let elapsedMinutes: number | null = null;
    for (const status of statusCandidates) {
      const period = toScore(status.period);
      const clock = String(status.displayClock ?? status.clock ?? '').trim();
      const match = clock.match(/^(?:(\d+):)?(\d{1,3}):(\d{2})$/);
      if (match) {
        const hours = match[1] === undefined ? 0 : Number(match[1]);
        const minutes = Number(match[2]);
        const seconds = Number(match[3]);
        let parsed = hours * 60 + minutes + seconds / 60;
        // Some feeds express the second-half clock as minutes since halftime.
        if (period === 2 && parsed < 45) parsed += 45;
        elapsedMinutes = Math.min(90, Math.max(0, parsed));
        break;
      }
      if (period !== null) {
        if (period <= 1) elapsedMinutes = 25;
        else if (period === 2) elapsedMinutes = 65;
        else elapsedMinutes = 90;
        break;
      }
    }

    if (elapsedMinutes === null) {
      const kickoff = context.fixture.fixtureDate instanceof Date
        ? context.fixture.fixtureDate.getTime()
        : new Date(context.fixture.fixtureDate).getTime();
      elapsedMinutes = Number.isFinite(kickoff)
        ? Math.min(90, Math.max(0, (Date.now() - kickoff) / 60_000))
        : 45;
    }

    return { homeScore, awayScore, elapsedMinutes: Math.round(elapsedMinutes * 10) / 10 };
  }

  private buildLiveFullTimeMatrix(
    expectedGoals: PredictionModelInput['expectedGoals'],
    liveState: { homeScore: number; awayScore: number; elapsedMinutes: number },
  ): number[][] {
    const remainingShare = Math.max(0, 90 - liveState.elapsedMinutes) / 90;
    const remaining = PredictionMathUtil.scoreMatrix(
      expectedGoals.home * remainingShare,
      expectedGoals.away * remainingShare,
      PREDICTION_ENGINE_CONFIG.model.maxGoals,
    );
    const rows = liveState.homeScore + remaining.length;
    const columns = liveState.awayScore + (remaining[0]?.length ?? 0);
    const finalMatrix = Array.from({ length: rows }, () => Array(columns).fill(0) as number[]);
    for (let remainingHome = 0; remainingHome < remaining.length; remainingHome += 1) {
      for (let remainingAway = 0; remainingAway < remaining[remainingHome].length; remainingAway += 1) {
        finalMatrix[liveState.homeScore + remainingHome][liveState.awayScore + remainingAway] += remaining[remainingHome][remainingAway];
      }
    }
    return finalMatrix;
  }
}
