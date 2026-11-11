import { Injectable } from '@nestjs/common';
import {
  MarketDefinition,
  ExpandedMarketSelection,
} from '../../interfaces/market-catalog.interface';
import { PredictionModelInput } from '../../interfaces/prediction-match-context.interface';
import { MarketEngineOutput } from '../../interfaces/market-engine-output.interface';
import { PredictionMarket } from '../../enums/prediction-market.enum';

/**
 * Player props are intentionally withheld until Sports exposes validated
 * per-appearance athlete rates for goals, assists, cards and shots. A current
 * roster or lineup alone is not enough to estimate a player probability.
 */
@Injectable()
export class PlayerMarketEngine {
  private readonly supported = new Set<string>([
    PredictionMarket.PLAYER_ANYTIME_GOALSCORER,
    PredictionMarket.PLAYER_FIRST_GOALSCORER,
    PredictionMarket.PLAYER_LAST_GOALSCORER,
    PredictionMarket.PLAYER_TO_SCORE_TWO_OR_MORE,
    PredictionMarket.PLAYER_TO_ASSIST,
    PredictionMarket.PLAYER_SHOTS_ON_TARGET,
    PredictionMarket.PLAYER_SHOTS_OVER_UNDER,
    PredictionMarket.PLAYER_SHOTS_ON_TARGET_OVER_UNDER,
    PredictionMarket.PLAYER_TO_BE_BOOKED,
    PredictionMarket.PLAYER_TO_BE_SENT_OFF,
  ]);

  calculate(
    definition: MarketDefinition,
    selections: ExpandedMarketSelection[],
    _input: PredictionModelInput,
  ): MarketEngineOutput {
    if (!this.supported.has(definition.key)) {
      return {
        handled: false,
        selections: [],
        calculationMethod: '',
        dataQuality: 0,
        diagnostics: [],
      };
    }

    const reason =
      'Player markets remain unavailable until normalized Sports data provides sufficiently sampled per-appearance player statistics. Roster and lineup presence alone are not treated as probability evidence.';
    return {
      handled: true,
      selections: selections.map((selection) => ({
        selection,
        probability: null,
        status: 'UNAVAILABLE' as const,
        source: [],
        method: 'Withheld pending normalized Sports player-event history',
        diagnostics: [reason],
        dataQuality: 0,
      })),
      calculationMethod: 'Unavailable pending normalized Sports player-event history',
      unavailableReason: reason,
      dataQuality: 0,
      diagnostics: [reason],
    };
  }
}
