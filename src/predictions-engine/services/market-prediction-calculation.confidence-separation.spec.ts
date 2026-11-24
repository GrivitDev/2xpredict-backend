import { FOOTBALL_MARKET_CATALOG } from '../catalog/football-market-catalog';
import { PredictionMarket } from '../enums/prediction-market.enum';
import { PredictionStatus } from '../enums/prediction-status.enum';
import { MarketPredictionCalculationService } from './market-prediction-calculation.service';

describe('MarketPredictionCalculationService probability and confidence separation', () => {
  it('preserves model probabilities while exposing the display floor and raw evidence separately', () => {
    const confidenceService = {
      calculate: jest.fn().mockReturnValue({
        confidence: 40,
        evidenceConfidence: 8,
        dataQuality: 0.12,
        signals: {},
        notes: ['PRIOR_ONLY evidence.'],
        evidenceLevel: 'PRIOR_ONLY',
      }),
    };
    const marketOddsService = {
      extractSelectionPrice: jest.fn().mockReturnValue(null),
    };
    const calibrationService = {
      adjustProbability: jest.fn((_market: string, probability: number) => ({
        probability,
        reliabilityScore: 0,
        adjusted: false,
        sampleSize: 0,
      })),
    };

    const modelProbabilities: Record<string, number> = {
      HOME_WIN: 0.48,
      DRAW: 0.29,
      AWAY_WIN: 0.23,
    };
    const resultEngine = {
      calculate: jest.fn((_definition: unknown, selections: any[]) => ({
        handled: true,
        selections: selections.map((selection) => ({
          selection,
          probability: modelProbabilities[selection.key],
          status: 'CALCULATED' as const,
          source: [],
          method: 'PRIOR_ONLY_SCORE_MATRIX',
          diagnostics: ['Calculated from the regularized Expected Goals baseline.'],
          dataQuality: 0.12,
        })),
        calculationMethod: 'Prior-only score matrix',
        dataQuality: 0.12,
        diagnostics: ['The model probabilities are independent of the confidence score.'],
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
        fixture: {
          eventId: 'fixture-confidence-separation',
          live: false,
          homeTeamId: 'team-home',
          awayTeamId: 'team-away',
          fixtureDate: new Date('2026-12-01T12:00:00.000Z'),
        },
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

    for (const selection of result.selections) {
      const expectedProbability = modelProbabilities[selection.key];
      expect(selection.status).toBe(PredictionStatus.CALCULATED);
      expect(selection.probability).toBeCloseTo(expectedProbability, 8);
      expect(selection.probabilityPercent).toBeCloseTo(expectedProbability * 100, 2);
      expect(selection.fairOdds).toBeCloseTo(1 / expectedProbability, 4);
      expect(selection.confidence).toBe(40);
      expect(selection.evidenceConfidence).toBe(8);
      expect(selection.dataQuality).toBe(0.12);
      expect(selection.evidenceLevel).toBe('PRIOR_ONLY');
    }

    expect(result.selections.reduce(
      (total: number, selection: any) => total + selection.probability,
      0,
    )).toBeCloseTo(1, 8);
    expect(new Set(result.selections.map((selection: any) => selection.confidence)).size).toBe(1);
    expect(new Set(result.selections.map((selection: any) => selection.probability)).size).toBe(3);
    expect(confidenceService.calculate).toHaveBeenCalledTimes(3);
    expect(marketOddsService.extractSelectionPrice).toHaveBeenCalledTimes(3);
  });
});