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
import { PredictionMarket } from '../../enums/prediction-market.enum';
import { PredictionSource } from '../../enums/prediction-source.enum';
import { PredictionMathUtil } from '../../utils/prediction-math.util';
import { matrixProbability, selectionOutput } from './market-engine.util';

@Injectable()
export class CombinationMarketEngine {
  calculate(
    definition: MarketDefinition,
    selections: ExpandedMarketSelection[],
    input: PredictionModelInput,
  ): MarketEngineOutput {
    if (
      ![
        PredictionMarket.BOTH_TEAMS_TO_SCORE_AND_RESULT,
        PredictionMarket.BOTH_TEAMS_TO_SCORE_AND_TOTAL_GOALS,
      ].includes(definition.key)
    ) {
      return {
        handled: false,
        selections: [],
        calculationMethod: '',
        dataQuality: 0,
        diagnostics: [],
      };
    }

    const results = selections.map((selection): SelectionModelOutput => {
      let probability: number | null = null;
      if (definition.key === PredictionMarket.BOTH_TEAMS_TO_SCORE_AND_RESULT) {
        const bttsYes = (home: number, away: number) => home > 0 && away > 0;
        if (selection.key === 'HOME_YES')
          probability = matrixProbability(
            input.scoreMatrix,
            (h, a) => h > a && bttsYes(h, a),
          );
        if (selection.key === 'HOME_NO')
          probability = matrixProbability(
            input.scoreMatrix,
            (h, a) => h > a && !bttsYes(h, a),
          );
        if (selection.key === 'DRAW_YES')
          probability = matrixProbability(
            input.scoreMatrix,
            (h, a) => h === a && bttsYes(h, a),
          );
        if (selection.key === 'DRAW_NO')
          probability = matrixProbability(
            input.scoreMatrix,
            (h, a) => h === a && !bttsYes(h, a),
          );
        if (selection.key === 'AWAY_YES')
          probability = matrixProbability(
            input.scoreMatrix,
            (h, a) => h < a && bttsYes(h, a),
          );
        if (selection.key === 'AWAY_NO')
          probability = matrixProbability(
            input.scoreMatrix,
            (h, a) => h < a && !bttsYes(h, a),
          );
      } else {
        const bttsWanted = selection.key.startsWith('YES_');
        const overWanted = selection.key.includes('_OVER_');
        const line = selection.line ?? 0;
        probability = matrixProbability(input.scoreMatrix, (home, away) => {
          const btts = home > 0 && away > 0;
          const totalGoals = home + away;
          return (
            btts === bttsWanted &&
            (overWanted ? totalGoals > line : totalGoals < line + 0.000001)
          );
        });
      }

      return selectionOutput(
        selection,
        probability,
        'Joint probability calculated from the same score distribution used by the related markets',
        [PredictionSource.POISSON_SCORE_MODEL, PredictionSource.DERIVED_MARKET],
        this.dataQuality(input),
        [
          'Combination probability is calculated directly from scoreline outcomes; it is not obtained by multiplying correlated market probabilities.',
        ],
      );
    });

    return {
      handled: true,
      selections: results,
      calculationMethod:
        'Joint score-matrix probability for related market conditions',
      dataQuality: this.dataQuality(input),
      diagnostics: [
        'Composite market probabilities are computed from joint score outcomes to preserve dependence.',
      ],
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
        sample * 0.55 +
        Math.min(0.15, input.expectedGoals.leagueSamples / 800),
      0,
      1,
    );
  }
}

