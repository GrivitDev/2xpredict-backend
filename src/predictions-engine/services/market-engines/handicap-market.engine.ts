import { Injectable } from '@nestjs/common';
import {
  MarketDefinition,
  ExpandedMarketSelection,
} from '../../interfaces/market-catalog.interface';
import { PredictionModelInput } from '../../interfaces/prediction-match-context.interface';
import {
  MarketEngineOutput,
  SelectionModelOutput,
} from '../../interfaces/market-engine-output.interface';
import { PredictionMarket } from '../../enums/prediction-market.enum';
import { PredictionSource } from '../../enums/prediction-source.enum';
import { PredictionMathUtil } from '../../utils/prediction-math.util';
import { asianHandicapOutput, selectionOutput } from './market-engine.util';

@Injectable()
export class HandicapMarketEngine {
  calculate(
    definition: MarketDefinition,
    selections: ExpandedMarketSelection[],
    input: PredictionModelInput,
  ): MarketEngineOutput {
    if (
      ![
        PredictionMarket.ASIAN_HANDICAP,
        PredictionMarket.EUROPEAN_HANDICAP,
        PredictionMarket.HALF_TIME_EUROPEAN_HANDICAP,
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

    const matrix =
      definition.key === PredictionMarket.HALF_TIME_EUROPEAN_HANDICAP
        ? input.firstHalfMatrix
        : input.scoreMatrix;

    const results = selections.map((selection): SelectionModelOutput => {
      if (definition.key === PredictionMarket.ASIAN_HANDICAP) {
        return asianHandicapOutput(
          matrix,
          selection,
          input,
          'Asian handicap applied to the selected team score',
        );
      }

      const handicap = selection.handicap ?? 0;
      const p = this.probabilityEuropean(matrix, selection.key, handicap);
      return selectionOutput(
        selection,
        p,
        'Three-way European handicap based on the adjusted scoreline',
        [PredictionSource.POISSON_SCORE_MODEL, PredictionSource.DERIVED_MARKET],
        this.dataQuality(input),
      );
    });

    return {
      handled: true,
      selections: results,
      calculationMethod:
        definition.key === PredictionMarket.ASIAN_HANDICAP
          ? 'Asian handicap settlement distribution from the score matrix'
          : 'Three-way European handicap distribution from the adjusted score matrix',
      dataQuality: this.dataQuality(input),
      diagnostics: [
        'Handicap selections are calculated from scoreline distributions; selection odds are fair model odds, not bookmaker prices.',
      ],
    };
  }

  private probabilityEuropean(
    matrix: number[][],
    selectionKey: string,
    homeHandicap: number,
  ): number {
    let total = 0;
    for (let home = 0; home < matrix.length; home += 1) {
      for (let away = 0; away < matrix[home].length; away += 1) {
        const adjustedHome = home + homeHandicap;
        const outcome =
          adjustedHome > away
            ? 'HOME'
            : adjustedHome === away
              ? 'DRAW'
              : 'AWAY';
        if (selectionKey.startsWith(`${outcome}_`)) total += matrix[home][away];
      }
    }
    return PredictionMathUtil.clamp(total, 0, 1);
  }

  private dataQuality(input: PredictionModelInput): number {
    const teamSample = Math.min(
      1,
      Math.min(
        input.expectedGoals.homeSamples,
        input.expectedGoals.awaySamples,
      ) / 8,
    );
    return PredictionMathUtil.clamp(
      0.22 +
        teamSample * 0.5 +
        (input.marketOdds ? 0.12 : 0) +
        Math.min(0.12, input.expectedGoals.leagueSamples / 1000),
      0,
      1,
    );
  }
}


