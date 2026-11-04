import { Injectable } from '@nestjs/common';
import { OddsService } from './odds.service';

export interface OddsQuoteSnapshot {
  eventId: string;
  marketId: string;
  selectionKey: string;
  line?: number;
  decimalOdds: number;
  priceType: 'PROVIDER' | 'ESTIMATED';
  provider?: 'ESPN' | 'THE_ODDS_API';
  bookmaker?: string;
  fairOdds?: number | null;
  fairOddsBasis?: 'MODEL' | 'PRIOR';
  marketFairOdds?: number | null;
  impliedProbability?: number | null;
  valuePercent?: number | null;
  oddsBasis?: 'BOOKMAKER_ONLY' | 'BOOKMAKER_PLUS_HISTORY' | 'HISTORICAL_ONLY' | 'PRIOR_ONLY';
  oddsCalculationMethod?: string;
  providerUpdatedAt?: Date | null;
  updatedAt?: Date;
  predictionReady: boolean;
  oddsCapturedAt: Date | null;
  oddsFreshUntil: Date | null;
  isFresh: boolean;
}

/**
 * Read-only contract exposed to downstream modules.
 *
 * OddsService remains private to the Odds module and owns every price write,
 * provider refresh and recalculation. Consumers can retrieve quote snapshots
 * and readiness metadata, but cannot invoke refreshFixture().
 */
@Injectable()
export class OddsReadService {
  constructor(private readonly oddsService: OddsService) {}

  getFixturePrices(eventId: string): Promise<OddsQuoteSnapshot[]> {
    return this.oddsService.getFixturePrices(eventId) as Promise<OddsQuoteSnapshot[]>;
  }

  getPricesForFixtures(eventIds: string[]): Promise<OddsQuoteSnapshot[]> {
    return this.oddsService.getPricesForFixtures(eventIds) as Promise<OddsQuoteSnapshot[]>;
  }

  getPricesForSelections(
    selections: Array<{ eventId: string; marketId: string; selectionKey: string; line?: number }>,
  ): Promise<OddsQuoteSnapshot[]> {
    return this.oddsService.getPricesForSelections(selections) as Promise<OddsQuoteSnapshot[]>;
  }

  getPredictionReadinessForEvents(eventIds: string[]) {
    return this.oddsService.getPredictionReadinessForEvents(eventIds);
  }
}
