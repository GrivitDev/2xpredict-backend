import { Injectable } from '@nestjs/common';
import { FOOTBALL_MARKET_CATALOG } from '../catalog/football-market-catalog';
import { FOOTBALL_MARKET_BY_PREDICTION_KEY } from '../../odds/catalog/football-market-catalog';
import { MarketDefinition } from '../interfaces/market-catalog.interface';
import { PredictionModelInput } from '../interfaces/prediction-match-context.interface';
import {
  MarketPredictionCalculationResult,
  SelectionPredictionResult,
} from '../interfaces/market-prediction.interface';
import { MarketEngineOutput } from '../interfaces/market-engine-output.interface';
import { PredictionStatus } from '../enums/prediction-status.enum';
import { PredictionMarket } from '../enums/prediction-market.enum';
import { PredictionSource } from '../enums/prediction-source.enum';
import { MarketModel } from '../enums/market-model.enum';
import { PredictionMathUtil } from '../utils/prediction-math.util';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { expandMarketSelections } from '../utils/market-selection.util';
import { PredictionConfidenceService } from './prediction-confidence.service';
import { MarketCalibrationService } from './market-calibration.service';
import type { MarketCalibrationAssessment } from './market-calibration.service';
import {
  MarketOddsService,
  ProviderSelectionPrice,
} from './market-odds.service';
import { ResultMarketEngine } from './market-engines/result-market.engine';
import { GoalsMarketEngine } from './market-engines/goals-market.engine';
import { PeriodMarketEngine } from './market-engines/period-market.engine';
import { HandicapMarketEngine } from './market-engines/handicap-market.engine';
import { StatisticsMarketEngine } from './market-engines/statistics-market.engine';
import { PlayerMarketEngine } from './market-engines/player-market.engine';
import { CombinationMarketEngine } from './market-engines/combination-market.engine';
import { SpecialMarketEngine } from './market-engines/special-market.engine';

@Injectable()
export class MarketPredictionCalculationService {
  constructor(
    private readonly confidenceService: PredictionConfidenceService,
    private readonly marketOddsService: MarketOddsService,
    private readonly calibrationService: MarketCalibrationService,
    private readonly resultEngine: ResultMarketEngine,
    private readonly goalsEngine: GoalsMarketEngine,
    private readonly periodEngine: PeriodMarketEngine,
    private readonly handicapEngine: HandicapMarketEngine,
    private readonly statisticsEngine: StatisticsMarketEngine,
    private readonly playerEngine: PlayerMarketEngine,
    private readonly combinationEngine: CombinationMarketEngine,
    private readonly specialEngine: SpecialMarketEngine,
  ) {}

  private readonly defaultProgressiveBatchSize = 8;

  private getOrderedDefinitions(): MarketDefinition[] {
    // Resolve core result markets first so early persisted batches expose the
    // highest-value foundational markets before secondary statistics markets.
    const priority = (key: string): number => {
      if (key === PredictionMarket.MATCH_RESULT) return 0;
      if (key.startsWith('BOTH_TEAMS_TO_SCORE')) return 1;
      if (key.includes('DRAW_NO_BET')) return 2;
      if (key.includes('DOUBLE_CHANCE')) return 3;
      if (key.includes('OVER_UNDER') || key === PredictionMarket.GOALS_OVER_UNDER) return 4;
      return 5;
    };
    return [...FOOTBALL_MARKET_CATALOG].sort(
      (a, b) => priority(String(a.key)) - priority(String(b.key))
        || String(a.key).localeCompare(String(b.key)),
    );
  }

  private calculateSafely(
    definition: MarketDefinition,
    input: PredictionModelInput,
    calibrations: Map<string, MarketCalibrationAssessment>,
  ): MarketPredictionCalculationResult {
    try {
      return this.calculateOne(definition, input, calibrations);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        marketKey: definition.key,
        marketName: definition.fullName,
        marketAbbreviation: definition.abbreviation,
        family: definition.family,
        period: definition.period,
        model: definition.model,
        status: PredictionStatus.FAILED,
        selections: [],
        sources: [],
        calculationMethod: 'Market calculation failed in isolation.',
        unavailableReason: message,
        diagnostics: [`${String(definition.key)} calculation failed without blocking other markets: ${message}`],
        dataQuality: 0,
      };
    }
  }

  calculateAll(
    input: PredictionModelInput,
    calibrations: Map<string, MarketCalibrationAssessment> = new Map(),
  ): MarketPredictionCalculationResult[] {
    return this.getOrderedDefinitions().map((definition) =>
      this.calculateSafely(definition, input, calibrations),
    );
  }

  /**
   * Calculate each canonical market independently and persist-ready batches
   * as soon as they are available. A failed market is recorded as FAILED and
   * does not prevent later markets from being calculated.
   */
  async calculateProgressively(
    input: PredictionModelInput,
    calibrations: Map<string, MarketCalibrationAssessment> = new Map(),
    onBatch: (
      batch: MarketPredictionCalculationResult[],
      progress: { processedMarkets: number; totalMarkets: number; batchNumber: number },
    ) => Promise<void>,
    batchSize = 8,
  ): Promise<MarketPredictionCalculationResult[]> {
    const definitions = this.getOrderedDefinitions();
    const safeBatchSize = Number.isInteger(batchSize) && batchSize > 0
      ? Math.min(25, batchSize)
      : this.defaultProgressiveBatchSize;
    const calculations: MarketPredictionCalculationResult[] = [];
    let pending: MarketPredictionCalculationResult[] = [];
    let batchNumber = 0;

    for (let index = 0; index < definitions.length; index += 1) {
      const calculation = this.calculateSafely(definitions[index], input, calibrations);
      calculations.push(calculation);
      pending.push(calculation);

      const isFullBatch = pending.length >= safeBatchSize;
      const isLastMarket = index === definitions.length - 1;
      if (!isFullBatch && !isLastMarket) continue;

      batchNumber += 1;
      const batch = pending;
      pending = [];
      await onBatch(batch, {
        processedMarkets: index + 1,
        totalMarkets: definitions.length,
        batchNumber,
      });
    }

    return calculations;
  }

  private calculateOne(
    definition: MarketDefinition,
    input: PredictionModelInput,
    calibrations: Map<string, MarketCalibrationAssessment>,
  ): MarketPredictionCalculationResult {
    const canonicalMarket = FOOTBALL_MARKET_BY_PREDICTION_KEY.get(String(definition.key));
    const availableOddsLines = canonicalMarket
      ? (input.context.storedOdds ?? [])
          .filter((quote) =>
            quote.marketId === canonicalMarket.id
            && quote.isFresh === true
            && quote.predictionReady === true
            && quote.line !== undefined
            && Number.isFinite(Number(quote.line))
            && Number.isFinite(Number(quote.decimalOdds))
            && Number(quote.decimalOdds) >= 1.01
            && Boolean(quote.oddsCalculationMethod)
            && ['BOOKMAKER_ONLY', 'BOOKMAKER_PLUS_HISTORY', 'HISTORICAL_ONLY', 'PRIOR_ONLY'].includes(String(quote.oddsBasis)),
          )
          .map((quote) => Number(quote.line))
      : [];
    const mergedLines = [...(definition.lines ?? [])];
    for (const line of availableOddsLines) {
      if (!mergedLines.some((existingLine) => Math.abs(existingLine - line) < 0.001)) {
        mergedLines.push(line);
      }
    }
    mergedLines.sort((a, b) => a - b);
    const oddsAwareDefinition = canonicalMarket && availableOddsLines.length
      && ['OVER_UNDER', 'ASIAN_HANDICAP', 'EUROPEAN_HANDICAP', 'BTTS_TOTAL', 'POSSESSION'].includes(definition.selectionMode)
      ? { ...definition, lines: mergedLines }
      : definition;
    let selections = expandMarketSelections(oddsAwareDefinition, input.context);
    if (definition.pricingEnabled === false) {
      const disabledNote = definition.notes ?? 'The canonical Odds catalogue has disabled pricing for this market until its required Sports evidence is available.';
      const disabledSelections = selections.map((selection) => ({
        key: selection.key,
        jsonVariable: selection.jsonVariable,
        fullName: selection.fullName,
        abbreviation: selection.abbreviation,
        line: selection.line,
        handicap: selection.handicap,
        subjectId: selection.subjectId,
        subjectName: selection.subjectName,
        probability: null,
        rawProbability: null,
        probabilityPercent: null,
        fairOdds: null,
        confidence: null,
        evidenceConfidence: null,
        dataQuality: 0,
        decimalOdds: null,
        bookmakerOdds: null,
        oddsPredictionReady: false,
        status: PredictionStatus.UNAVAILABLE,
        sources: [],
        calculationMethod: 'Market intentionally disabled by the canonical Odds catalogue.',
        diagnostics: [disabledNote, ...(definition.requiredData?.length ? [`Required Sports evidence: ${definition.requiredData.join(', ')}.`] : [])],
        isFinalSelection: false,
        recommendationEligible: false,
      }));
      return {
        marketKey: definition.key,
        marketName: definition.fullName,
        marketAbbreviation: definition.abbreviation,
        family: definition.family,
        period: definition.period,
        model: definition.model,
        status: PredictionStatus.UNAVAILABLE,
        selections: disabledSelections,
        sources: [],
        calculationMethod: 'Pricing disabled pending required normalized Sports evidence.',
        unavailableReason: disabledNote,
        diagnostics: [disabledNote, ...(definition.requiredData?.length ? [`Required Sports evidence: ${definition.requiredData.join(', ')}.`] : [])],
        dataQuality: 0,
      };
    }

    // The Odds module is a price/provenance source, not a substitute for an
    // independent probability model. Do not publish score/period distributions
    // when Sports supplies no independent goal evidence. Live period markets
    // also stay unavailable until a live-period-conditioned model is available.
    const goalEvidenceBlocked =
      (definition.model === MarketModel.SCORE_MATRIX || definition.model === MarketModel.PERIOD_MATRIX)
      && input.expectedGoals.evidenceLevel === 'INSUFFICIENT';
    const livePeriodBlocked = input.context.fixture.live === true
      && definition.model === MarketModel.PERIOD_MATRIX;
    let registeredEngine: MarketEngineOutput | undefined;
    if (goalEvidenceBlocked || livePeriodBlocked) {
      const reason = livePeriodBlocked
        ? 'Live first-half/second-half probabilities are withheld because the current engine does not yet condition period distributions on the live match clock and score.'
        : 'Independent Sports goal evidence is insufficient. Default goal-rate priors and bookmaker prices are not used as stand-alone prediction probabilities.';
      registeredEngine = {
        handled: true,
        selections: selections.map((selection) => ({
          selection,
          probability: null,
          status: 'UNAVAILABLE' as const,
          source: [],
          method: 'Prediction withheld by evidence-quality gate',
          diagnostics: [reason],
          dataQuality: 0,
        })),
        calculationMethod: 'Unavailable: independent Sports evidence gate',
        unavailableReason: reason,
        dataQuality: 0,
        diagnostics: [reason],
      };
    } else {
      // A market belongs to one catalog family. Invoke only that family handler
      // instead of calling all engines for every market definition.
      switch (String(definition.family).toUpperCase()) {
        case 'RESULT':
          registeredEngine = this.resultEngine.calculate(definition, selections, input);
          break;
        case 'GOALS':
          registeredEngine = this.goalsEngine.calculate(definition, selections, input);
          break;
        case 'EVENTS':
          registeredEngine = definition.model === MarketModel.COUNT_MODEL
            ? this.specialEngine.calculate(definition, selections, input)
            : this.goalsEngine.calculate(definition, selections, input);
          break;
        case 'PERIOD':
          registeredEngine = this.periodEngine.calculate(definition, selections, input);
          break;
        case 'HANDICAP':
          registeredEngine = this.handicapEngine.calculate(definition, selections, input);
          break;
        case 'STATISTICS':
          registeredEngine = this.statisticsEngine.calculate(definition, selections, input);
          break;
        case 'PLAYER':
          registeredEngine = this.playerEngine.calculate(definition, selections, input);
          break;
        case 'COMBINATIONS':
          registeredEngine = this.combinationEngine.calculate(definition, selections, input);
          break;
        case 'SPECIAL':
          registeredEngine = this.specialEngine.calculate(definition, selections, input);
          break;
      }
    }
    if (registeredEngine && !registeredEngine.handled) registeredEngine = undefined;
    // A missing handler is an implementation gap, not permission to turn an
    // Odds quote into a prediction. Preserve price visibility while withholding
    // probability and recommendation eligibility.
    const engine: MarketEngineOutput = registeredEngine ?? {
      handled: true,
      selections: selections.map((selection) => ({
        selection,
        probability: null,
        status: 'UNAVAILABLE' as const,
        source: [],
        method: 'No specialized prediction handler is registered',
        diagnostics: ['The market has no specialized probability model. Odds-module prices remain separate and are not converted into predictions.'],
        dataQuality: 0,
      })),
      calculationMethod: 'Unavailable: specialized prediction handler missing',
      dataQuality: 0,
      diagnostics: ['Specialized prediction handler missing; no Odds-implied probability fallback is permitted.'],
    };

    const providerPrices = new Map<string, ProviderSelectionPrice>();
    for (const output of engine.selections) {
      const price = this.marketOddsService.extractSelectionPrice(
        input.context,
        definition,
        output.selection,
      );
      if (price) providerPrices.set(output.selection.key, price);
    }
    const oddsAdjustedProbabilities = this.blendCompleteGoalsOverUnderOdds(
      definition,
      engine.selections,
      providerPrices,
    );
    for (const [selectionKey, probability] of this.blendCompleteProviderMarketOdds(
      definition,
      engine.selections,
      providerPrices,
    )) {
      if (!oddsAdjustedProbabilities.has(selectionKey)) {
        oddsAdjustedProbabilities.set(selectionKey, probability);
      }
    }

    let selectionResults: SelectionPredictionResult[] = engine.selections.map(
      (output) => {
        const providerPrice = providerPrices.get(output.selection.key);
        const modelProbability =
          output.status === 'CALCULATED' && output.probability !== null
            ? PredictionMathUtil.clamp(output.probability, 0.000001, 0.999999)
            : null;
        // Keep model probabilities independent. Odds adjustments are applied
        // only when a complete de-vigged outcome set exists and every model
        // outcome in that group has already been calculated.
        const probability = modelProbability === null
          ? null
          : oddsAdjustedProbabilities.has(output.selection.key)
            ? oddsAdjustedProbabilities.get(output.selection.key)!
            : modelProbability;
        // An estimated price is a value source, not independent evidence. Only
        // direct provider prices (or a real 1X2 market baseline already present
        // in the model input) can increase the confidence odds signal.
        const hasUsableMarketOdds = Boolean(
          providerPrice?.priceType === 'PROVIDER'
          || (input.marketOdds && definition.model === MarketModel.SCORE_MATRIX),
        );
        const confidenceResult =
          probability === null
            ? null
            : this.confidenceService.calculate(
                input.context,
                output.dataQuality,
                hasUsableMarketOdds,
                `${input.context.fixture.eventId}:${definition.key}:${output.selection.key}`,
                input.expectedGoals,
                definition.model,
              );
        const sources = [...output.source];
        if (providerPrice) sources.push(providerPrice.source);
        if (
          probability !== null &&
          input.marketOdds &&
          definition.model === MarketModel.SCORE_MATRIX
        ) {
          sources.push(PredictionSource.PROVIDER_ODDS);
        }
        return {
          key: output.selection.key,
          jsonVariable: output.selection.jsonVariable,
          fullName: output.selection.fullName,
          abbreviation: output.selection.abbreviation,
          line: output.selection.line,
          handicap: output.selection.handicap,
          subjectId: output.selection.subjectId,
          subjectName: output.selection.subjectName,
          probability,
          // Raw means uncalibrated final probability after any complete-market
          // odds blend. Calibration must adjust the same estimate users would see
          // before calibration, not silently revert to the standalone model value.
          rawProbability: probability,
          probabilityPercent:
            probability === null
              ? null
              : Number((probability * 100).toFixed(2)),
          // Offered decimal odds and their provenance are owned by OddsService.
          // fairOdds is the model fair price for this calculated probability;
          // the offered decimalOdds and source remain separately preserved.
          fairOdds: probability !== null && probability > 0
            ? Number((1 / probability).toFixed(4))
            : null,
          oddsBasis: providerPrice?.oddsBasis ?? null,
          oddsCalculationMethod: providerPrice?.oddsCalculationMethod ?? null,
          oddsProvider: providerPrice?.provider ?? null,
          bookmaker: providerPrice?.bookmaker ?? null,
          expectedValue: probability !== null && providerPrice?.priceType === 'PROVIDER' && providerPrice.oddsBasis === 'BOOKMAKER_ONLY'
            ? PredictionMathUtil.expectedValue(probability, providerPrice.decimalOdds, output.settlementProfile)
            : null,
          expectedValuePercent: probability !== null && providerPrice?.priceType === 'PROVIDER' && providerPrice.oddsBasis === 'BOOKMAKER_ONLY'
            ? Number(((PredictionMathUtil.expectedValue(probability, providerPrice.decimalOdds, output.settlementProfile) ?? 0) * 100).toFixed(2))
            : null,
          dataQuality: confidenceResult
            ? Number(Math.min(output.dataQuality, confidenceResult.dataQuality).toFixed(4))
            : 0,
          decimalOdds: providerPrice?.decimalOdds,
          priceType: providerPrice?.priceType,
          oddsPredictionReady: providerPrice?.predictionReady === true,
          oddsUpdatedAt: providerPrice?.updatedAt ?? undefined,
          bookmakerOdds: providerPrice?.priceType === 'PROVIDER' ? providerPrice.decimalOdds : undefined,
          confidence: confidenceResult ? confidenceResult.confidence : null,
          evidenceConfidence: confidenceResult ? confidenceResult.evidenceConfidence : null,
          // A valid probability remains a calculated prediction even when
          // confidence is low. Confidence is metadata, not a calculation gate;
          // Slip Center may apply its own product-specific quality requirements.
          status:
            probability === null || !confidenceResult || !providerPrice
              ? PredictionStatus.UNAVAILABLE
              : PredictionStatus.CALCULATED,
          sources: [...new Set(sources)],
          calculationMethod: output.method,
          settlementProfile: output.settlementProfile,
          diagnostics: [
            ...output.diagnostics,
            ...(modelProbability === null && providerPrice
              ? ['An Odds-module quote exists, but the specialized Sports-based model did not calculate this selection; the quote is retained as price information only and is not converted into a prediction probability.']
              : []),
            ...(!providerPrice
              ? ['No valid Odds-module quote is ready for this exact market, selection, and line; the selection is not emitted as a calculated prediction.']
              : []),
            ...(providerPrice?.priceType === 'PROVIDER' &&
            !oddsAdjustedProbabilities.has(output.selection.key) &&
            definition.key === PredictionMarket.GOALS_OVER_UNDER
              ? [
                  'A provider bookmaker price was found, but the opposing price for this exact line was unavailable; probability was not blended from a one-sided price.',
                ]
              : []),
            ...(confidenceResult?.notes ?? []),
          ],
        };
      },
    );

    // Apply the same historical market calibration to every calculated outcome
    // before choosing the final selection. Calibration changes probability/fair
    // odds only; it never inflates confidence or bypasses odds eligibility.
    selectionResults = selectionResults.map((selection) => {
      if (selection.status !== PredictionStatus.CALCULATED || selection.probability === null) return selection;
      const marketCalibration = calibrations.get(String(definition.key).toUpperCase());
      const assessment = this.calibrationService.adjustProbability(
        String(definition.key),
        Number(selection.rawProbability ?? selection.probability),
        calibrations,
      );
      const calibrationReliability = marketCalibration?.active
        ? Math.max(0, Math.min(1, Number(marketCalibration.reliabilityScore ?? 0) / 100))
        : 0.5; // neutral when there is not enough validated history; never fabricate trust
      const calibrationFields = {
        calibrationReliability,
        calibrationSampleSize: assessment.sampleSize,
        calibrationApplied: assessment.adjusted,
      };
      if (!assessment.adjusted) return { ...selection, ...calibrationFields };
      return {
        ...selection,
        ...calibrationFields,
        rawProbability: Number(selection.rawProbability ?? selection.probability),
        probability: assessment.probability,
        probabilityPercent: Number((assessment.probability * 100).toFixed(2)),
        fairOdds: assessment.probability > 0
          ? Number((1 / assessment.probability).toFixed(4))
          : null,
        expectedValue: selection.priceType === 'PROVIDER'
          && selection.oddsBasis === 'BOOKMAKER_ONLY'
          && Number.isFinite(Number(selection.decimalOdds))
          ? PredictionMathUtil.expectedValue(assessment.probability, Number(selection.decimalOdds), selection.settlementProfile)
          : null,
        expectedValuePercent: selection.priceType === 'PROVIDER'
          && selection.oddsBasis === 'BOOKMAKER_ONLY'
          && Number.isFinite(Number(selection.decimalOdds))
          ? Number(((PredictionMathUtil.expectedValue(assessment.probability, Number(selection.decimalOdds), selection.settlementProfile) ?? 0) * 100).toFixed(2))
          : null,
        diagnostics: [
          ...(selection.diagnostics ?? []),
          `Historical market calibration adjusted probability using ${assessment.sampleSize} settled final recommendations (reliability ${assessment.reliabilityScore}/100).`,
        ],
      };
    });

    // The market engine—not Pick Center—owns the final outcome for this market.
    // Select exactly one calculated selection with an explicitly Odds-ready price.
    // This is a relative ranking, not a hard probability, odds, value, or provider gate.
    const finalCandidates = selectionResults.filter((selection) =>
      selection.status === PredictionStatus.CALCULATED
      && selection.probability !== null
      && Number.isFinite(Number(selection.probability))
      && Number(selection.probability) > 0
      && Number(selection.probability) < 1
      && selection.oddsPredictionReady === true
      && (selection.priceType === 'PROVIDER' || selection.priceType === 'ESTIMATED')
      && Number.isFinite(Number(selection.decimalOdds))
      && Number(selection.decimalOdds) >= PREDICTION_ENGINE_CONFIG.selectionEligibility.minimumDecimalOdds
      && Number(selection.decimalOdds) <= PREDICTION_ENGINE_CONFIG.selectionEligibility.maximumDecimalOdds,
    );
    const sourceScore = (selection: SelectionPredictionResult): number => {
      if (selection.priceType === 'PROVIDER' && selection.oddsBasis === 'BOOKMAKER_ONLY') return 1;
      if (selection.priceType === 'PROVIDER') return 0.82;
      if (selection.oddsBasis === 'BOOKMAKER_PLUS_HISTORY') return 0.68;
      if (selection.oddsBasis === 'HISTORICAL_ONLY') return 0.54;
      return 0.38;
    };
    const finalScore = (selection: SelectionPredictionResult): number => {
      const probability = Number(selection.probability ?? 0); // calibrated when reliable history exists
      const confidence = Math.max(0, Math.min(98, Number(selection.evidenceConfidence ?? selection.confidence ?? 0))) / 98;
      const quality = Math.max(0, Math.min(1, Number(selection.dataQuality ?? 0)));
      const calibrationReliability = Math.max(0, Math.min(1, Number(selection.calibrationReliability ?? 0.5)));
      const samples = Math.max(0, Number(selection.calibrationSampleSize ?? 0));
      const calibrationSupport = samples >= PREDICTION_ENGINE_CONFIG.calibration.minimumSettledSamples
        ? calibrationReliability * (samples / (samples + 30))
        : 0.5; // neutral when history is sparse; active evidence remains relevant even if correction is tiny
      const independentEvidence = input.expectedGoals.independentEvidenceAvailable
        ? 1
        : input.expectedGoals.evidenceLevel === 'PARTIAL' ? 0.5 : 0;
      const providerValue = selection.priceType === 'PROVIDER' && Number.isFinite(Number(selection.expectedValue))
        ? Math.max(0, Math.min(1, Number(selection.expectedValue) / 0.5))
        : 0;
      // Safety leads; calibration and evidence are meaningful inputs. Decimal
      // odds have no arbitrary upper bound: every Odds-ready price >= 1.01 may win
      // if it is the safest calculated outcome in this market.
      return probability * 0.42
        + confidence * 0.16
        + quality * 0.15
        + sourceScore(selection) * 0.10
        + calibrationSupport * 0.14
        + independentEvidence * 0.02
        + providerValue * 0.01;
    };
    const rankedCandidates = [...finalCandidates].sort((a, b) =>
      finalScore(b) - finalScore(a)
      || Number(b.probability ?? 0) - Number(a.probability ?? 0)
      || Number(b.dataQuality ?? 0) - Number(a.dataQuality ?? 0)
      || String(a.key).localeCompare(String(b.key)),
    );
    const finalKey = rankedCandidates[0]?.key;
    const finalSelections = selectionResults.map((selection) => {
      const isFinalSelection = finalKey !== undefined && selection.key === finalKey;
      const safetyScore = Number(finalScore(selection).toFixed(6));
      const diagnostics = [...(selection.diagnostics ?? [])];
      if (isFinalSelection) {
        diagnostics.push(selection.priceType === 'PROVIDER' && selection.oddsBasis === 'BOOKMAKER_ONLY'
          ? 'Final selection chosen for safety by this market engine. Odds module marked the exact selection and price prediction-ready; the value is a direct provider/bookmaker quote.'
          : `Final selection chosen for safety by this market engine. Odds module marked the ${selection.priceType === 'ESTIMATED' ? 'estimated' : 'provider-backed'} price prediction-ready; provenance is ${selection.oddsBasis ?? 'unknown'}. This price is not represented as a direct bookmaker offer.`);
        diagnostics.push(`Safety score ${(safetyScore * 100).toFixed(1)}/100 incorporates calibrated probability, evidence confidence, data quality, price provenance, calibration reliability, independent evidence and a capped value signal.`);
        if (Number(selection.decimalOdds) < 1.01) {
          diagnostics.push('Selection rejected because decimal odds are below 1.01.');
        }
      }
      return {
        ...selection,
        safetyScore,
        oddsPredictionReady: selection.oddsPredictionReady === true,
        isFinalSelection,
        recommendationEligible: isFinalSelection,
        diagnostics,
      };
    });
    const status = finalKey === undefined
      ? PredictionStatus.UNAVAILABLE
      : PredictionStatus.CALCULATED;
    const allSources = [
      ...new Set(finalSelections.flatMap((selection) => selection.sources)),
    ];
    return {
      marketKey: definition.key,
      marketName: definition.fullName,
      marketAbbreviation: definition.abbreviation,
      family: definition.family,
      period: definition.period,
      model: definition.model,
      status,
      selections: finalSelections,
      sources: allSources,
      calculationMethod: engine.calculationMethod,
      unavailableReason: finalKey === undefined
        ? 'No calculated selection with an explicitly Odds-ready quote was available for this market.'
        : engine.unavailableReason,
      diagnostics: [
        ...engine.diagnostics,
        ...(definition.notes ? [definition.notes] : []),
      ],
      dataQuality: engine.dataQuality,
    };
  }


  /**
   * Blend complete, mutually exclusive market groups with de-vigged provider
   * prices. Partial market quotes are not normalized: a subset must not be
   * misrepresented as a complete outcome distribution.
   */
  private blendCompleteProviderMarketOdds(
    definition: MarketDefinition,
    outputs: MarketEngineOutput['selections'],
    prices: Map<string, ProviderSelectionPrice>,
  ): Map<string, number> {
    const adjusted = new Map<string, number>();
    if (
      definition.selectionMode === 'PLAYER' ||
      definition.key === PredictionMarket.GOALS_OVER_UNDER ||
      definition.key === PredictionMarket.DOUBLE_CHANCE
    ) {
      return adjusted;
    }

    const normalizedMarketKeys = new Set<string>([
      PredictionMarket.HALF_TIME_RESULT,
      PredictionMarket.SECOND_HALF_RESULT,
      PredictionMarket.HALF_TIME_FULL_TIME,
      PredictionMarket.DRAW_NO_BET,
      PredictionMarket.BOTH_TEAMS_TO_SCORE,
      PredictionMarket.BOTH_TEAMS_TO_SCORE_FIRST_HALF,
      PredictionMarket.BOTH_TEAMS_TO_SCORE_SECOND_HALF,
      PredictionMarket.ODD_EVEN_TOTAL_GOALS,
      PredictionMarket.HALF_TIME_GOALS_ODD_EVEN,
      PredictionMarket.TOTAL_CORNERS_ODD_EVEN,
      PredictionMarket.TOTAL_CARDS_ODD_EVEN,
      PredictionMarket.FIRST_HALF_GOALS_OVER_UNDER,
      PredictionMarket.SECOND_HALF_GOALS_OVER_UNDER,
      PredictionMarket.HOME_TEAM_GOALS_OVER_UNDER,
      PredictionMarket.AWAY_TEAM_GOALS_OVER_UNDER,
      PredictionMarket.ASIAN_HANDICAP,
      PredictionMarket.EUROPEAN_HANDICAP,
      PredictionMarket.HALF_TIME_EUROPEAN_HANDICAP,
      PredictionMarket.TOTAL_CORNERS_OVER_UNDER,
      PredictionMarket.HOME_CORNERS_OVER_UNDER,
      PredictionMarket.HOME_TEAM_CORNERS_OVER_UNDER,
      PredictionMarket.AWAY_CORNERS_OVER_UNDER,
      PredictionMarket.AWAY_TEAM_CORNERS_OVER_UNDER,
      PredictionMarket.TOTAL_CARDS_OVER_UNDER,
      PredictionMarket.TOTAL_YELLOW_CARDS_OVER_UNDER,
      PredictionMarket.TOTAL_RED_CARDS_OVER_UNDER,
      PredictionMarket.HOME_TEAM_CARDS_OVER_UNDER,
      PredictionMarket.AWAY_TEAM_CARDS_OVER_UNDER,
      PredictionMarket.TOTAL_SHOTS_OVER_UNDER,
      PredictionMarket.TOTAL_SHOTS_ON_TARGET_OVER_UNDER,
      PredictionMarket.HOME_SHOTS_ON_TARGET_OVER_UNDER,
      PredictionMarket.AWAY_SHOTS_ON_TARGET_OVER_UNDER,
      PredictionMarket.TOTAL_OFFSIDES_OVER_UNDER,
      PredictionMarket.TOTAL_FOULS_OVER_UNDER,
      PredictionMarket.POSSESSION_OVER_UNDER,
    ]);
    if (!normalizedMarketKeys.has(String(definition.key))) return adjusted;

    const groups = new Map<string, MarketEngineOutput['selections']>();
    // Group every model outcome first. Filtering to priced outcomes before
    // grouping would make a partial 1X2/Over-Under set look complete and would
    // incorrectly renormalize the subset to 100%.
    for (const output of outputs) {
      const line = output.selection.line;
      const groupKey = line === undefined ? 'all' : `line:${Number(line).toFixed(3)}`;
      const group = groups.get(groupKey) ?? [];
      group.push(output);
      groups.set(groupKey, group);
    }

    const weight = PREDICTION_ENGINE_CONFIG.model.oddsBlendWeight;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      // Blend only if every outcome in this exact mutually exclusive group has
      // a valid Odds-module price. Missing prices never become implied outcomes.
      if (group.some((output) => !prices.has(output.selection.key))) continue;
      const groupPrices = group.map((output) => prices.get(output.selection.key));
      if (groupPrices.some((price) =>
        !price || (price.priceType !== 'PROVIDER' && price.priceType !== 'ESTIMATED')
          || !Number.isFinite(price.decimalOdds) || price.decimalOdds <= 1,
      )) continue;

      const modelComplete = group.every((output) =>
        output.probability !== null
        && Number.isFinite(Number(output.probability))
        && Number(output.probability) >= 0,
      );
      const modelValues = group.map((output) => Math.max(0, Number(output.probability ?? 0)));
      const modelTotal = modelValues.reduce((sum, value) => sum + value, 0);
      if (!modelComplete || !Number.isFinite(modelTotal) || modelTotal <= 0) continue;
      const impliedValues = groupPrices.map((price) => 1 / Number(price!.decimalOdds));
      const impliedTotal = impliedValues.reduce((sum, value) => sum + value, 0);
      if (!Number.isFinite(impliedTotal) || impliedTotal <= 0) continue;

      const providerNormal = impliedValues.map((value) => value / impliedTotal);
      const modelNormal = modelValues.map((value) => value / modelTotal);
      const blended = modelNormal.map((modelProbability, index) => {
        const price = groupPrices[index]!;
        const marketWeight = price.priceType === 'PROVIDER' ? weight : Math.min(weight, 0.08);
        return PredictionMathUtil.clamp(
          modelProbability * (1 - marketWeight) + providerNormal[index] * marketWeight,
          0.0001,
          0.9999,
        );
      });
      const blendedTotal = blended.reduce((sum, value) => sum + value, 0);
      if (!Number.isFinite(blendedTotal) || blendedTotal <= 0) continue;
      group.forEach((output, index) => {
        adjusted.set(output.selection.key, Number((blended[index] / blendedTotal).toFixed(6)));
      });
    }
    return adjusted;
  }

  /**
   * Blend Odds-module over/under prices only when both sides and both
   * independent model probabilities exist at the exact same line. Each line
   * remains complementary and the bookmaker overround is normalized first.
   */
  private blendCompleteGoalsOverUnderOdds(
    definition: MarketDefinition,
    outputs: MarketEngineOutput['selections'],
    prices: Map<string, ProviderSelectionPrice>,
  ): Map<string, number> {
    const adjusted = new Map<string, number>();
    if (definition.key !== PredictionMarket.GOALS_OVER_UNDER) return adjusted;

    const lines = new Map<
      number,
      {
        over?: MarketEngineOutput['selections'][number];
        under?: MarketEngineOutput['selections'][number];
      }
    >();
    for (const output of outputs) {
      if (!Number.isFinite(output.selection.line)) continue;
      const line = Number(output.selection.line);
      const group = lines.get(line) ?? {};
      if (output.selection.key.startsWith('OVER_')) group.over = output;
      if (output.selection.key.startsWith('UNDER_')) group.under = output;
      lines.set(line, group);
    }

    const weight = PREDICTION_ENGINE_CONFIG.model.oddsBlendWeight;
    for (const [, group] of lines) {
      if (
        !group.over ||
        !group.under
      ) continue;

      const overPrice = prices.get(group.over.selection.key);
      const underPrice = prices.get(group.under.selection.key);
      if (
        !overPrice || !underPrice ||
        (overPrice.priceType !== 'PROVIDER' && overPrice.priceType !== 'ESTIMATED') ||
        (underPrice.priceType !== 'PROVIDER' && underPrice.priceType !== 'ESTIMATED') ||
        group.over.status !== 'CALCULATED' || group.under.status !== 'CALCULATED' ||
        group.over.probability === null || group.under.probability === null ||
        !Number.isFinite(Number(group.over.probability)) || !Number.isFinite(Number(group.under.probability))
      ) continue;
      const overOdds = overPrice.decimalOdds;
      const underOdds = underPrice.decimalOdds;
      if (overOdds <= 1 || underOdds <= 1) continue;

      const rawOver = 1 / overOdds;
      const rawUnder = 1 / underOdds;
      const impliedTotal = rawOver + rawUnder;
      if (!Number.isFinite(impliedTotal) || impliedTotal <= 0) continue;

      const marketOverProbability = rawOver / impliedTotal;
      const modelOverProbability = PredictionMathUtil.clamp(Number(group.over.probability), 0, 1);
      const modelWeight = overPrice.priceType === 'PROVIDER' && underPrice.priceType === 'PROVIDER'
        ? weight
        : Math.min(weight, 0.08);
      const blendedOver = PredictionMathUtil.clamp(
        modelOverProbability * (1 - modelWeight) + marketOverProbability * modelWeight,
        0.0001,
        0.9999,
      );
      const roundedOver = Math.round(blendedOver * 10_000) / 10_000;
      adjusted.set(group.over.selection.key, roundedOver);
      adjusted.set(group.under.selection.key, 1 - roundedOver);
    }

    return adjusted;
  }
}













