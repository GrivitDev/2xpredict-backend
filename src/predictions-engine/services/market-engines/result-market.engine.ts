import { Injectable } from '@nestjs/common';
import {
  MarketDefinition,
  ExpandedMarketSelection,
} from '../../interfaces/market-catalog.interface';
import { PredictionModelInput } from '../../interfaces/espn-prediction-context.interface';
import {
  MarketEngineOutput,
  SelectionModelOutput,
} from '../../interfaces/market-engine-output.interface';
import { MarketModel } from '../../enums/market-model.enum';
import { PredictionMarket } from '../../enums/prediction-market.enum';
import { PredictionSource } from '../../enums/prediction-source.enum';
import { PredictionMathUtil } from '../../utils/prediction-math.util';
import { resultProbability, selectionOutput } from './market-engine.util';

@Injectable()
export class ResultMarketEngine {
  calculate(
    definition: MarketDefinition,
    selections: ExpandedMarketSelection[],
    input: PredictionModelInput,
  ): MarketEngineOutput {
    const supported = new Set<string>([
      PredictionMarket.MATCH_RESULT,
      PredictionMarket.DOUBLE_CHANCE,
      PredictionMarket.DRAW_NO_BET,
    ]);
    if (!supported.has(definition.key)) {
      return {
        handled: false,
        selections: [],
        calculationMethod: '',
        dataQuality: 0,
        diagnostics: [],
      };
    }

    const matrix = input.scoreMatrix;
    const results = selections.map((selection): SelectionModelOutput => {
      const key = selection.key;
      let probability: number | null = null;
      if (definition.key === PredictionMarket.MATCH_RESULT) {
        probability = resultProbability(matrix, key);
      } else if (definition.key === PredictionMarket.DOUBLE_CHANCE) {
        const home = resultProbability(matrix, 'HOME_WIN');
        const draw = resultProbability(matrix, 'DRAW');
        const away = resultProbability(matrix, 'AWAY_WIN');
        if (key === 'HOME_OR_DRAW') probability = home + draw;
        else if (key === 'DRAW_OR_AWAY') probability = draw + away;
        else probability = home + away;
      } else if (definition.key === PredictionMarket.DRAW_NO_BET) {
        const home = resultProbability(matrix, 'HOME_WIN');
        const away = resultProbability(matrix, 'AWAY_WIN');
        const decisive = home + away;
        probability =
          decisive > 0 ? (key === 'HOME_DNB' ? home : away) / decisive : null;
      }

      const oddsSource =
        input.marketOdds?.source === 'ESPN_PICKCENTER'
          ? PredictionSource.ESPN_PICKCENTER
          : input.marketOdds?.source === 'ESPN_EVENT_ODDS'
            ? PredictionSource.ESPN_EVENT_ODDS
            : PredictionSource.ESPN_ODDS;
      const oddsWereUsed = Boolean(
        input.marketOdds && definition.model === MarketModel.SCORE_MATRIX,
      );
      return selectionOutput(
        selection,
        probability,
        oddsWereUsed
          ? 'Poisson score matrix reconciled with normalized ESPN three-way odds'
          : 'Independent Poisson score matrix',
        oddsWereUsed
          ? [PredictionSource.POISSON_SCORE_MODEL, oddsSource]
          : [PredictionSource.POISSON_SCORE_MODEL],
        this.dataQuality(input),
        definition.key === PredictionMarket.DRAW_NO_BET
          ? [
              'Probability is conditional on a non-draw result; a draw voids the selection.',
            ]
          : [],
      );
    });

    return {
      handled: true,
      selections: results,
      calculationMethod: results[0]?.method ?? 'Result market model',
      dataQuality: this.dataQuality(input),
      diagnostics: input.expectedGoals.evidence,
    };
  }

  private dataQuality(input: PredictionModelInput): number {
    const sample = Math.min(
      1,
      Math.min(
        input.expectedGoals.homeSamples,
        input.expectedGoals.awaySamples,
      ) / 8,
    );
    return PredictionMathUtil.clamp(
      0.25 +
        sample * 0.45 +
        (input.marketOdds ? 0.2 : 0) +
        Math.min(0.1, input.expectedGoals.leagueSamples / 1200),
      0,
      1,
    );
  }
}

