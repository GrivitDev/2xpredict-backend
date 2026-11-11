import { Injectable } from '@nestjs/common';
import { FOOTBALL_MARKET_CATALOG, expandCanonicalSelections } from '../catalog/football-market-catalog';
import { OddsService } from './odds.service';
import type { OddsQuoteSnapshot } from './odds.service';

/** Read-only price contract exported to Prediction, Bet Lab and other modules. */
@Injectable()
export class OddsReadService {
  constructor(private readonly oddsService: OddsService) {}

  getMarketCatalog() {
    return FOOTBALL_MARKET_CATALOG.map((market) => ({
      id: market.id,
      predictionMarketKey: market.predictionMarketKey,
      betLabMarketCode: market.betLabMarketCode,
      jsonVariable: market.jsonVariable,
      fullName: market.fullName,
      abbreviation: market.abbreviation,
      family: market.family,
      model: market.model,
      selectionMode: market.selectionMode,
      period: market.period,
      lines: market.lines ? [...market.lines] : undefined,
      pricingEnabled: market.pricingEnabled !== false,
      pricingStatus: market.pricingEnabled === false ? 'UNAVAILABLE' : 'HISTORICAL_DATA_REQUIRED',
      sourceOfTruth: 'GRIVIT_MODEL',
      bookmakerOfRecord: 'Grivit',
      externalBookmakerValidation: 'OPTIONAL_REFERENCE_ONLY',
      supportMode: market.family === 'PLAYER'
        ? 'PLAYER_HISTORY_PENDING'
        : market.family === 'STATISTICS'
          ? 'SPORTS_TEAM_STATISTICS'
          : market.family === 'EVENTS' && market.model === 'COUNT_MODEL'
            ? 'SPORTS_MATCH_TIMELINE'
            : market.model === 'PERIOD_MATRIX'
              ? 'SPORTS_PERIOD_SCORE_MATRIX'
              : market.model === 'SCORE_MATRIX'
                ? 'SPORTS_SCORE_MATRIX'
                : market.model,
      requiredData: market.requiredData ? [...market.requiredData] : [],
      minimumSampleSize: market.minimumSampleSize ?? null,
      notes: market.notes ?? null,
      selections: expandCanonicalSelections(market),
    }));
  }

  getFixturePrices(eventId: string): Promise<OddsQuoteSnapshot[]> {
    return this.oddsService.getFixturePrices(eventId);
  }

  getPricesForFixtures(eventIds: string[]): Promise<OddsQuoteSnapshot[]> {
    return this.oddsService.getPricesForFixtures(eventIds);
  }

  getPricesForSelections(selections: Array<{ eventId: string; marketId: string; selectionKey: string; line?: number }>): Promise<OddsQuoteSnapshot[]> {
    return this.oddsService.getPricesForSelections(selections);
  }

  getPredictionReadinessForEvents(eventIds: string[]) {
    return this.oddsService.getPredictionReadinessForEvents(eventIds);
  }

  /** Read-only aggregate for administrative analytics; no pricing work is triggered. */
  getInventorySummary(): Promise<Record<string, unknown>> {
    return this.oddsService.getInventorySummary();
  }
}
