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
  MarketStatForecastService,
  StatisticForecast,
} from '../market-stat-forecast.service';
import { countOverProbability, selectionOutput } from './market-engine.util';

@Injectable()
export class StatisticsMarketEngine {
  constructor(
    private readonly statForecastService: MarketStatForecastService,
  ) {}

  calculate(
    definition: MarketDefinition,
    selections: ExpandedMarketSelection[],
    input: PredictionModelInput,
  ): MarketEngineOutput {
    if ((definition.family as string) !== 'STATISTICS') {
      return {
        handled: false,
        selections: [],
        calculationMethod: '',
        dataQuality: 0,
        diagnostics: [],
      };
    }

    const forecast = this.statForecastService.forecast(
      input.context,
      definition.key,
    );
    const results = selections.map((selection): SelectionModelOutput => {
      const probability = forecast
        ? this.getProbability(definition.key, selection, forecast)
        : null;
      const sampleQuality = forecast
        ? Math.min(1, forecast.sampleSize / 12)
        : 0;
      return selectionOutput(
        selection,
        probability,
        forecast?.source ?? 'No qualifying historic team-stat sample',
        [PredictionSource.HISTORICAL_COUNT_MODEL],
        forecast
          ? PredictionMathUtil.clamp(0.18 + sampleQuality * 0.72, 0, 0.9)
          : 0,
        forecast
          ? []
          : [
              'At least three usable historic observations are required for this statistic market.',
            ],
      );
    });
    const calculated = results.some((result) => result.status === 'CALCULATED');
    return {
      handled: true,
      selections: results,
      calculationMethod:
        forecast?.source ??
        'Unavailable: insufficient historical statistic observations',
      dataQuality: forecast ? Math.min(1, forecast.sampleSize / 12) : 0,
      unavailableReason: calculated
        ? undefined
        : 'Insufficient historical ESPN boxscore statistics.',
      diagnostics: forecast
        ? [
            `Historical sample size: ${forecast.sampleSize}.`,
            `Estimated ${forecast.metric}: ${forecast.mean ?? forecast.totalMean ?? 'not available'}.`,
          ]
        : ['No supported historical-statistics sample was found.'],
    };
  }

  private getProbability(
    marketKey: string,
    selection: ExpandedMarketSelection,
    forecast: StatisticForecast,
  ): number | null {
    const key = selection.key;
    if (marketKey === (PredictionMarket.CORNER_MATCH_RESULT as string)) {
      if (forecast.homeMean === undefined || forecast.awayMean === undefined)
        return null;
      const homeDistribution = PredictionMathUtil.poissonDistribution(
        forecast.homeMean,
        25,
      );
      const awayDistribution = PredictionMathUtil.poissonDistribution(
        forecast.awayMean,
        25,
      );
      let probability = 0;
      for (let home = 0; home < homeDistribution.length; home += 1) {
        for (let away = 0; away < awayDistribution.length; away += 1) {
          const result = home > away ? 'HOME' : home === away ? 'DRAW' : 'AWAY';
          if (
            (key === 'HOME_MOST_CORNERS' && result === 'HOME') ||
            (key === 'DRAW_CORNERS' && result === 'DRAW') ||
            (key === 'AWAY_MOST_CORNERS' && result === 'AWAY')
          )
            probability += homeDistribution[home] * awayDistribution[away];
        }
      }
      return PredictionMathUtil.clamp(probability, 0, 1);
    }

    if (marketKey === (PredictionMarket.POSSESSION_OVER_UNDER as string)) {
      if (
        forecast.mean === undefined ||
        forecast.standardDeviation === undefined
      )
        return null;
      const z =
        (selection.line! - forecast.mean) /
        Math.max(forecast.standardDeviation, 1);
      const over = 1 - PredictionMathUtil.normalCdf(z);
      return key.startsWith('OVER_') ? over : 1 - over;
    }

    const mean = forecast.mean ?? forecast.totalMean;
    if (mean === undefined || !Number.isFinite(mean) || mean < 0) return null;
    if (key.startsWith('OVER_'))
      return countOverProbability(mean, selection.line ?? 0);
    if (key.startsWith('UNDER_'))
      return 1 - countOverProbability(mean, selection.line ?? 0);
    return null;
  }
}

