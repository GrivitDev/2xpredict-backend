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
  resultProbability,
  selectionOutput,
  totalGoalsProbability,
} from './market-engine.util';

@Injectable()
export class PeriodMarketEngine {
  private readonly supported = new Set<string>([
    PredictionMarket.HALF_TIME_RESULT,
    PredictionMarket.SECOND_HALF_RESULT,
    PredictionMarket.HALF_TIME_FULL_TIME,
    PredictionMarket.FIRST_HALF_DOUBLE_CHANCE,
    PredictionMarket.FIRST_HALF_DRAW_NO_BET,
    PredictionMarket.BOTH_TEAMS_TO_SCORE_FIRST_HALF,
    PredictionMarket.BOTH_TEAMS_TO_SCORE_SECOND_HALF,
    PredictionMarket.GOAL_IN_BOTH_HALVES,
    PredictionMarket.HOME_TEAM_TO_SCORE_IN_BOTH_HALVES,
    PredictionMarket.AWAY_TEAM_TO_SCORE_IN_BOTH_HALVES,
    PredictionMarket.HOME_WIN_EITHER_HALF,
    PredictionMarket.AWAY_WIN_EITHER_HALF,
    PredictionMarket.MOST_GOALS_HALF,
    PredictionMarket.FIRST_HALF_GOALS_OVER_UNDER,
    PredictionMarket.SECOND_HALF_GOALS_OVER_UNDER,
    PredictionMarket.HALF_TIME_CORRECT_SCORE,
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
      return selectionOutput(
        selection,
        probability,
        'Period-specific independent Poisson score distributions',
        [PredictionSource.POISSON_SCORE_MODEL, PredictionSource.DERIVED_MARKET],
        this.dataQuality(input),
        definition.key === PredictionMarket.HALF_TIME_FULL_TIME
          ? [
              'Half-time and second-half score increments are combined to estimate the nine HT/FT outcomes.',
            ]
          : [],
      );
    });

    return {
      handled: true,
      selections: results,
      calculationMethod:
        'Period-specific independent Poisson score distributions',
      dataQuality: this.dataQuality(input),
      diagnostics: [
        'First-half and second-half rates are split from full-match expected goals; this is a model assumption rather than an ESPN-provided prediction.',
      ],
    };
  }

  private probability(
    marketKey: string,
    selection: ExpandedMarketSelection,
    input: PredictionModelInput,
  ): number | null {
    const first = input.firstHalfMatrix;
    const second = input.secondHalfMatrix;
    const key = selection.key;
    const line = selection.line ?? 0;

    if (marketKey === String(PredictionMarket.HALF_TIME_RESULT))
      return resultProbability(first, key);
    if (marketKey === String(PredictionMarket.SECOND_HALF_RESULT))
      return resultProbability(second, key);
    if (marketKey === String(PredictionMarket.FIRST_HALF_DOUBLE_CHANCE)) {
      const h = resultProbability(first, 'HOME_WIN'),
        d = resultProbability(first, 'DRAW'),
        a = resultProbability(first, 'AWAY_WIN');
      if (key === 'HOME_OR_DRAW') return h + d;
      if (key === 'DRAW_OR_AWAY') return d + a;
      return h + a;
    }
    if (marketKey === String(PredictionMarket.FIRST_HALF_DRAW_NO_BET)) {
      const h = resultProbability(first, 'HOME_WIN'),
        a = resultProbability(first, 'AWAY_WIN');
      return h + a > 0 ? (key === 'HOME_DNB' ? h : a) / (h + a) : null;
    }
    if (
      marketKey === String(PredictionMarket.BOTH_TEAMS_TO_SCORE_FIRST_HALF) ||
      marketKey === String(PredictionMarket.BOTH_TEAMS_TO_SCORE_SECOND_HALF)
    ) {
      const matrix =
        marketKey === String(PredictionMarket.BOTH_TEAMS_TO_SCORE_FIRST_HALF)
          ? first
          : second;
      const yes = matrixProbability(matrix, (h, a) => h > 0 && a > 0);
      return key === 'YES' ? yes : 1 - yes;
    }
    if (marketKey === String(PredictionMarket.HALF_TIME_CORRECT_SCORE)) {
      return selection.homeGoals !== undefined &&
        selection.awayGoals !== undefined
        ? (first[selection.homeGoals]?.[selection.awayGoals] ?? 0)
        : null;
    }
    if (marketKey === String(PredictionMarket.FIRST_HALF_GOALS_OVER_UNDER)) {
      return totalGoalsProbability(first, (total) =>
        key.startsWith('OVER_') ? total > line : total < line + 0.000001,
      );
    }
    if (marketKey === String(PredictionMarket.SECOND_HALF_GOALS_OVER_UNDER)) {
      return totalGoalsProbability(second, (total) =>
        key.startsWith('OVER_') ? total > line : total < line + 0.000001,
      );
    }
    if (marketKey === String(PredictionMarket.GOAL_IN_BOTH_HALVES)) {
      const firstAny = totalGoalsProbability(first, (total) => total > 0);
      const secondAny = totalGoalsProbability(second, (total) => total > 0);
      const yes = firstAny * secondAny;
      return key === 'YES' ? yes : 1 - yes;
    }
    if (
      marketKey === String(PredictionMarket.HOME_TEAM_TO_SCORE_IN_BOTH_HALVES)
    ) {
      const firstHome = matrixProbability(first, (h) => h > 0);
      const secondHome = matrixProbability(second, (h) => h > 0);
      const yes = firstHome * secondHome;
      return key === 'YES' ? yes : 1 - yes;
    }
    if (
      marketKey === String(PredictionMarket.AWAY_TEAM_TO_SCORE_IN_BOTH_HALVES)
    ) {
      const firstAway = matrixProbability(first, (_h, a) => a > 0);
      const secondAway = matrixProbability(second, (_h, a) => a > 0);
      const yes = firstAway * secondAway;
      return key === 'YES' ? yes : 1 - yes;
    }
    if (
      marketKey === String(PredictionMarket.HOME_WIN_EITHER_HALF) ||
      marketKey === String(PredictionMarket.AWAY_WIN_EITHER_HALF)
    ) {
      const homeSelected =
        marketKey === String(PredictionMarket.HOME_WIN_EITHER_HALF);
      const firstWin = resultProbability(
        first,
        homeSelected ? 'HOME_WIN' : 'AWAY_WIN',
      );
      const secondWin = resultProbability(
        second,
        homeSelected ? 'HOME_WIN' : 'AWAY_WIN',
      );
      const yes = 1 - (1 - firstWin) * (1 - secondWin);
      return key === 'YES' ? yes : 1 - yes;
    }
    if (marketKey === String(PredictionMarket.MOST_GOALS_HALF)) {
      let firstMost = 0,
        secondMost = 0,
        equal = 0;
      const firstTotals = this.totalDistribution(first);
      const secondTotals = this.totalDistribution(second);
      for (let h1 = 0; h1 < firstTotals.length; h1 += 1) {
        for (let h2 = 0; h2 < secondTotals.length; h2 += 1) {
          const p = firstTotals[h1] * secondTotals[h2];
          if (h1 > h2) firstMost += p;
          else if (h2 > h1) secondMost += p;
          else equal += p;
        }
      }
      if (key === 'FIRST_HALF') return firstMost;
      if (key === 'SECOND_HALF') return secondMost;
      return equal;
    }
    if (marketKey === String(PredictionMarket.HALF_TIME_FULL_TIME)) {
      return this.halfTimeFullTimeProbability(key, first, second);
    }
    return null;
  }

  private halfTimeFullTimeProbability(
    key: string,
    first: number[][],
    second: number[][],
  ): number {
    const pair = key.split('_');
    const ht = pair[0];
    const ft = pair[1];
    let probability = 0;
    for (let h1 = 0; h1 < first.length; h1 += 1) {
      for (let a1 = 0; a1 < first[h1].length; a1 += 1) {
        const halftimeResult = h1 > a1 ? 'HOME' : h1 === a1 ? 'DRAW' : 'AWAY';
        if (halftimeResult !== ht) continue;
        const pHalf = first[h1][a1];
        for (let h2 = 0; h2 < second.length; h2 += 1) {
          for (let a2 = 0; a2 < second[h2].length; a2 += 1) {
            const fullHome = h1 + h2;
            const fullAway = a1 + a2;
            const fullResult =
              fullHome > fullAway
                ? 'HOME'
                : fullHome === fullAway
                  ? 'DRAW'
                  : 'AWAY';
            if (fullResult === ft) probability += pHalf * second[h2][a2];
          }
        }
      }
    }
    return PredictionMathUtil.clamp(probability, 0, 1);
  }

  private totalDistribution(matrix: number[][]): number[] {
    const output = Array.from(
      { length: matrix.length + matrix[0].length - 1 },
      () => 0,
    );
    for (let h = 0; h < matrix.length; h += 1) {
      for (let a = 0; a < matrix[h].length; a += 1)
        output[h + a] += matrix[h][a];
    }
    return output;
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
      0.2 +
        sample * 0.5 +
        Math.min(0.2, input.expectedGoals.leagueSamples / 600),
      0,
      1,
    );
  }
}

