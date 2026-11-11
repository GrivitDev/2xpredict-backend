import { FOOTBALL_MARKET_CATALOG } from '../catalog/football-market-catalog';
import { MarketPredictionCalculationService } from './market-prediction-calculation.service';
import { PredictionStatus } from '../enums/prediction-status.enum';

describe('MarketPredictionCalculationService progressive calculation', () => {
  function createService() {
    return new MarketPredictionCalculationService(
      {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any,
    );
  }

  it('emits ordered bounded batches and continues after an individual market failure', async () => {
    const service = createService();
    const orderedDefinitions = (service as any).getOrderedDefinitions() as Array<{ key: string }>;
    const failingMarketKey = String(orderedDefinitions[1].key);
    const calculateOne = jest.spyOn(service as any, 'calculateOne');
    calculateOne.mockImplementation((definition: any) => {
      if (String(definition.key) === failingMarketKey) {
        throw new Error('isolated-market-error');
      }
      return {
        marketKey: definition.key,
        marketName: definition.fullName,
        marketAbbreviation: definition.abbreviation,
        family: definition.family,
        period: definition.period,
        model: definition.model,
        status: PredictionStatus.CALCULATED,
        selections: [],
        sources: [],
        calculationMethod: 'test',
        diagnostics: [],
        dataQuality: 1,
      };
    });

    const batches: Array<{ keys: string[]; processed: number; total: number }> = [];
    const results = await service.calculateProgressively(
      {} as any,
      new Map(),
      async (batch, progress) => {
        batches.push({
          keys: batch.map((row) => String(row.marketKey)),
          processed: progress.processedMarkets,
          total: progress.totalMarkets,
        });
      },
      7,
    );

    expect(results).toHaveLength(FOOTBALL_MARKET_CATALOG.length);
    expect(results[1].status).toBe(PredictionStatus.FAILED);
    expect(results[results.length - 1]?.status).toBe(PredictionStatus.CALCULATED);
    expect(batches.length).toBe(Math.ceil(FOOTBALL_MARKET_CATALOG.length / 7));
    expect(batches.every((batch) => batch.keys.length <= 7)).toBe(true);
    expect(batches[batches.length - 1]?.processed).toBe(FOOTBALL_MARKET_CATALOG.length);
    expect(batches[batches.length - 1]?.total).toBe(FOOTBALL_MARKET_CATALOG.length);
    expect(calculateOne).toHaveBeenCalledTimes(FOOTBALL_MARKET_CATALOG.length);
  });
});
