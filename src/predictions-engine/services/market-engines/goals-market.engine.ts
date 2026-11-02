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
import {
  matrixProbability,
  selectionOutput,
  totalGoalsProbability,
} from './market-engine.util';

@Injectable()
export class GoalsMarketEngine {
  private readonly supported = new Set<string>([
    PredictionMarket.GOALS_OVER_UNDER,
    PredictionMarket.EXACT_TOTAL_GOALS,
    PredictionMarket.TOTAL_GOALS_RANGE,
    PredictionMarket.ODD_EVEN_TOTAL_GOALS,
    PredictionMarket.BOTH_TEAMS_TO_SCORE,
    PredictionMarket.HOME_TEAM_GOALS_OVER_UNDER,
    PredictionMarket.AWAY_TEAM_GOALS_OVER_UNDER,
    PredictionMarket.CORRECT_SCORE,
    PredictionMarket.WIN_TO_NIL,
    PredictionMarket.CLEAN_SHEET,
    PredictionMarket.TEAM_TO_SCORE_FIRST,
    PredictionMarket.TEAM_TO_SCORE_LAST,
    PredictionMarket.WIN_MARGIN,
  ]);

  calculate(
    definition: MarketDefinition,
    selections: ExpandedMarketSelection[],
    input: PredictionModelInput,
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
    const results = selections.map((selection): SelectionModelOutput => {
      const probability = this.probability(definition.key, selection, input);
      const diagnostics: string[] = [];
      if (
        [
          PredictionMarket.TEAM_TO_SCORE_FIRST,
          PredictionMarket.TEAM_TO_SCORE_LAST,
        ].includes(definition.key)
      ) {
        diagnostics.push(
          'First/last-scoring-team probabilities use a constant scoring-hazard approximation from the expected-goals model.',
        );
      }
      return selectionOutput(
        selection,
        probability,
        'Independent Poisson score matrix',
        [PredictionSource.POISSON_SCORE_MODEL],
        this.dataQuality(input),
        diagnostics,
      );
    });
    return {
      handled: true,
      selections: results,
      calculationMethod: 'Independent Poisson score matrix',
      dataQuality: this.dataQuality(input),
      diagnostics: input.expectedGoals.evidence,
    };
  }

  private probability(
    marketKey: string,
    selection: ExpandedMarketSelection,
    input: PredictionModelInput,
  ): number | null {
    const matrix = input.scoreMatrix;
    const key = selection.key;
    const line = selection.line ?? 0;

    switch (marketKey as PredictionMarket) {
      case PredictionMarket.GOALS_OVER_UNDER:
        return totalGoalsProbability(matrix, (total) =>
          key.startsWith('OVER_') ? total > line : total < line + 0.000001,
        );
      case PredictionMarket.EXACT_TOTAL_GOALS:
        if (key === 'GOALS_6_PLUS')
          return totalGoalsProbability(matrix, (total) => total >= 6);
        {
          const exactTotal = Number(key.replace('GOALS_', ''));
          return Number.isFinite(exactTotal)
            ? totalGoalsProbability(matrix, (total) => total === exactTotal)
            : null;
        }
      case PredictionMarket.TOTAL_GOALS_RANGE:
        if (key === 'GOALS_0_1')
          return totalGoalsProbability(matrix, (total) => total <= 1);
        if (key === 'GOALS_2_3')
          return totalGoalsProbability(
            matrix,
            (total) => total >= 2 && total <= 3,
          );
        if (key === 'GOALS_4_5')
          return totalGoalsProbability(
            matrix,
            (total) => total >= 4 && total <= 5,
          );
        return totalGoalsProbability(matrix, (total) => total >= 6);
      case PredictionMarket.ODD_EVEN_TOTAL_GOALS:
        return totalGoalsProbability(matrix, (total) =>
          key === 'ODD' ? total % 2 === 1 : total % 2 === 0,
        );
      case PredictionMarket.BOTH_TEAMS_TO_SCORE: {
        const yes = matrixProbability(
          matrix,
          (home, away) => home > 0 && away > 0,
        );
        return key === 'YES' ? yes : 1 - yes;
      }
      case PredictionMarket.HOME_TEAM_GOALS_OVER_UNDER:
        return matrixProbability(matrix, (home) =>
          key.startsWith('OVER_') ? home > line : home < line + 0.000001,
        );
      case PredictionMarket.AWAY_TEAM_GOALS_OVER_UNDER:
        return matrixProbability(matrix, (_home, away) =>
          key.startsWith('OVER_') ? away > line : away < line + 0.000001,
        );
      case PredictionMarket.CORRECT_SCORE:
        if (
          selection.homeGoals === undefined ||
          selection.awayGoals === undefined
        )
          return null;
        return matrix[selection.homeGoals]?.[selection.awayGoals] ?? 0;
      case PredictionMarket.WIN_TO_NIL:
        if (key === 'HOME_WIN_TO_NIL')
          return matrixProbability(
            matrix,
            (home, away) => home > away && away === 0,
          );
        return matrixProbability(
          matrix,
          (home, away) => away > home && home === 0,
        );
      case PredictionMarket.CLEAN_SHEET:
        if (key === 'HOME_CLEAN_SHEET')
          return matrixProbability(matrix, (_home, away) => away === 0);
        return matrixProbability(matrix, (home) => home === 0);
      case PredictionMarket.TEAM_TO_SCORE_FIRST:
      case PredictionMarket.TEAM_TO_SCORE_LAST: {
        const totalLambda = input.expectedGoals.home + input.expectedGoals.away;
        const anyGoal = 1 - Math.exp(-totalLambda);
        if (key === 'NO_GOAL') return 1 - anyGoal;
        if (totalLambda <= 0) return null;
        const sideRate = key.startsWith('HOME_')
          ? input.expectedGoals.home
          : input.expectedGoals.away;
        return (anyGoal * sideRate) / totalLambda;
      }
      case PredictionMarket.WIN_MARGIN:
        if (key === 'HOME_BY_1')
          return matrixProbability(matrix, (home, away) => home - away === 1);
        if (key === 'HOME_BY_2_PLUS')
          return matrixProbability(matrix, (home, away) => home - away >= 2);
        if (key === 'DRAW')
          return matrixProbability(matrix, (home, away) => home === away);
        if (key === 'AWAY_BY_1')
          return matrixProbability(matrix, (home, away) => away - home === 1);
        if (key === 'AWAY_BY_2_PLUS')
          return matrixProbability(matrix, (home, away) => away - home >= 2);
        return null;
      default:
        return null;
    }
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
      0.22 +
        sample * 0.5 +
        Math.min(0.2, input.expectedGoals.leagueSamples / 600),
      0,
      1,
    );
  }
}

