import { Injectable } from '@nestjs/common';
import { PredictionSource } from '../enums/prediction-source.enum';
import {
  ExpandedMarketSelection,
  MarketDefinition,
} from '../interfaces/market-catalog.interface';
import {
  MarketOddsBaseline,
  PredictionMatchContext,
} from '../interfaces/espn-prediction-context.interface';
import { FOOTBALL_MARKET_BY_PREDICTION_KEY } from '../../odds/catalog/football-market-catalog';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import type { OddsBasis, OddsProvider } from '../interfaces/espn-prediction-context.interface';

export interface ProviderSelectionPrice {
  decimalOdds: number;
  predictionReady: true;
  fairOdds: number | null;
  source: PredictionSource;
  priceType: 'PROVIDER' | 'ESTIMATED';
  updatedAt: Date | null;
  oddsBasis: OddsBasis | null;
  oddsCalculationMethod: string | null;
  provider: OddsProvider | null;
  bookmaker: string | null;
}

@Injectable()
export class MarketOddsService {
  private isFreshProviderQuote(
    updatedAt: Date | null | undefined,
    _provider?: OddsProvider | null,
  ): boolean {
    // Source timestamp is required for every provider, including ESPN. The Odds
    // document's updatedAt must never be used to disguise an unknown quote age.
    if (!(updatedAt instanceof Date) || !Number.isFinite(updatedAt.getTime())) return false;
    const ageMs = Date.now() - updatedAt.getTime();
    const maxAgeMs = PREDICTION_ENGINE_CONFIG.model.maximumProviderOddsAgeHours * 3_600_000;
    return ageMs >= -5 * 60_000 && ageMs <= maxAgeMs;
  }

  /**
   * Reads real provider 1X2 quotes persisted by OddsService. All three outcomes
   * must have a valid provider quote. External provider freshness follows the
   * Odds-module policy; ESPN Summary quotes are accepted when stored.
   */
  extractMatchResultOdds(context: PredictionMatchContext): MarketOddsBaseline | null {
    const stored = (context.storedOdds ?? []).filter((quote) =>
      quote.predictionReady === true
      && quote.marketId === 'MATCH_RESULT'
      && quote.priceType === 'PROVIDER'
      && Number.isFinite(quote.decimalOdds)
      && quote.decimalOdds > 1
      && Boolean(quote.oddsCalculationMethod)
      && this.isFreshProviderQuote(quote.providerUpdatedAt, quote.provider),
    );
    const priceFor = (key: string) => stored.find((quote) => quote.selectionKey === key)?.decimalOdds;
    const home = priceFor('HOME_WIN');
    const draw = priceFor('DRAW');
    const away = priceFor('AWAY_WIN');
    if (![home, draw, away].every((value) => Number.isFinite(value) && Number(value) > 1)) return null;

    const decimalOdds = { home: Number(home), draw: Number(draw), away: Number(away) };
    const totalImplied = 1 / decimalOdds.home + 1 / decimalOdds.draw + 1 / decimalOdds.away;
    if (!Number.isFinite(totalImplied) || totalImplied <= 0) return null;

    return {
      home: (1 / decimalOdds.home) / totalImplied,
      draw: (1 / decimalOdds.draw) / totalImplied,
      away: (1 / decimalOdds.away) / totalImplied,
      decimalOdds,
      source: 'STORED_PROVIDER',
      normalized: true,
    };
  }

  extractSelectionPrice(
    context: PredictionMatchContext,
    definition: MarketDefinition,
    selection: ExpandedMarketSelection,
  ): ProviderSelectionPrice | null {
    const canonicalMarket = FOOTBALL_MARKET_BY_PREDICTION_KEY.get(String(definition.key));
    if (!canonicalMarket) return null;

    const quote = (context.storedOdds ?? []).find((item) =>
      item.marketId === canonicalMarket.id
      && item.selectionKey === selection.key
      && (selection.line === undefined
        ? item.line === undefined
        : item.line !== undefined && Math.abs(Number(item.line) - Number(selection.line)) < 0.001),
    );
    if (
      !quote
      || quote.predictionReady !== true
      || (quote.priceType !== 'PROVIDER' && quote.priceType !== 'ESTIMATED')
      || !Number.isFinite(quote.decimalOdds)
      || quote.decimalOdds < 1.01
      || !quote.oddsCalculationMethod
      || !['BOOKMAKER_ONLY', 'BOOKMAKER_PLUS_HISTORY', 'HISTORICAL_ONLY', 'PRIOR_ONLY'].includes(String(quote.oddsBasis))
      || (quote.priceType === 'PROVIDER' && quote.provider !== 'ESPN' && quote.provider !== 'THE_ODDS_API')
    ) return null;

    if (quote.priceType === 'PROVIDER' && quote.provider !== 'ESPN' && !this.isFreshProviderQuote(quote.providerUpdatedAt, quote.provider)) return null;
    return {
      decimalOdds: Number(quote.decimalOdds),
      predictionReady: true,
      fairOdds: Number.isFinite(Number(quote.fairOdds)) && Number(quote.fairOdds) > 0 ? Number(quote.fairOdds) : null,
      source: quote.priceType === 'PROVIDER' ? PredictionSource.PROVIDER_ODDS : PredictionSource.ESTIMATED_ODDS,
      priceType: quote.priceType,
      updatedAt: (quote.priceType === 'PROVIDER' ? quote.providerUpdatedAt : quote.updatedAt) instanceof Date
        && Number.isFinite(((quote.priceType === 'PROVIDER' ? quote.providerUpdatedAt : quote.updatedAt) as Date).getTime())
        ? (quote.priceType === 'PROVIDER' ? quote.providerUpdatedAt : quote.updatedAt) as Date
        : null,
      oddsBasis: quote.oddsBasis ?? null,
      oddsCalculationMethod: quote.oddsCalculationMethod ?? null,
      provider: quote.provider ?? null,
      bookmaker: quote.bookmaker ?? null,
    };
  }
}



