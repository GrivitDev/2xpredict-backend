import { FOOTBALL_MARKET_CATALOG } from '../catalog/football-market-catalog';
import { PredictionMarket } from '../enums/prediction-market.enum';
import { PredictionStatus } from '../enums/prediction-status.enum';
import { MarketPredictionCalculationService } from './market-prediction-calculation.service';

describe('MarketPredictionCalculationService mandatory baseline 1X2', () => {
  it('persists all three Match Result probabilities without waiting for Odds', () => {
    const confidenceService = {
      calculate: jest.fn().mockReturnValue({
        confidence: 40,
        evidenceConfidence: 8,
        dataQuality: 0.12,
        signals: {},
        notes: ['Prior-only evidence is available.'],
        evidenceLevel: 'PRIOR_ONLY',
      }),
    };
    const marketOddsService = {
      extractSelectionPrice: jest.fn().mockReturnValue(null),
    };
    const calibrationService = {
      adjustProbability: jest.fn((_market: string, probability: number) => ({
        probability: probability * (probability > 0.4 ? 1.12 : 0.92),
        reliabilityScore: 55,
        adjusted: true,
        sampleSize: 45,
      })),
    };
    const resultEngine = {
      calculate: jest.fn((_definition: unknown, selections: any[]) => ({
        handled: true,
        selections: selections.map((selection, index) => ({
          selection,
          probability: [0.48, 0.29, 0.23][index],
          status: 'CALCULATED' as const,
          source: [],
          method: 'PRIOR_ONLY_SCORE_MATRIX',
          diagnostics: ['Calculated from the regularized Expected Goals baseline.'],
          dataQuality: 0.12,
        })),
        calculationMethod: 'Prior-only score matrix',
        dataQuality: 0.12,
        diagnostics: ['Odds are optional for baseline Match Result.'],
      })),
    };

    const service = new MarketPredictionCalculationService(
      confidenceService as any,
      marketOddsService as any,
      calibrationService as any,
      resultEngine as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const definition = FOOTBALL_MARKET_CATALOG.find(
      (market) => market.key === PredictionMarket.MATCH_RESULT,
    )!;
    const input = {
      context: {
        fixture: { eventId: 'fixture-no-odds', live: false },
        storedOdds: [],
        hasOdds: false,
      },
      expectedGoals: {
        home: 1.45,
        away: 1.15,
        independentEvidenceAvailable: false,
        evidenceLevel: 'PRIOR_ONLY',
      },
      marketOdds: null,
    } as any;

    const result = (service as any).calculateOne(definition, input, new Map());

    expect(result.status).toBe(PredictionStatus.CALCULATED);
    expect(result.selections).toHaveLength(3);
    expect(result.selections.every((selection: any) =>
      selection.status === PredictionStatus.CALCULATED
      && Number.isFinite(selection.probability)
      && Number(selection.confidence) >= 40
      && selection.evidenceLevel === 'PRIOR_ONLY'
      && selection.oddsPredictionReady === false
      && selection.decimalOdds === undefined,
    )).toBe(true);
    expect(result.selections.reduce((sum: number, selection: any) => sum + selection.probability, 0)).toBeCloseTo(1, 8);
    expect(result.selections.filter((selection: any) => selection.isFinalSelection)).toHaveLength(1);
    expect(result.selections.find((selection: any) => selection.isFinalSelection)?.recommendationEligible).toBe(true);
    expect(marketOddsService.extractSelectionPrice).toHaveBeenCalledTimes(3);
  });
});