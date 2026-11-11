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
import {
  MarketStatForecastService,
  StatisticForecast,
} from '../market-stat-forecast.service';
import { selectionOutput } from './market-engine.util';

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
              'At least five qualifying Sports team-statistics observations are required for this market.',
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
        : 'Insufficient Sports normalized team-statistics history.',
      diagnostics: forecast
        ? [
            `Historical sample size: ${forecast.sampleSize}.`,
            `Estimated ${forecast.metric}: ${forecast.mean ?? forecast.totalMean ?? 'not available'}.`,
            `Count dispersion model: ${forecast.dispersionMethod === 'NEGATIVE_BINOMIAL' ? 'Negative Binomial using shrunk observed sample variance.' : forecast.dispersionMethod === 'RANGE_APPROXIMATION' ? 'Observed-range approximation.' : 'Poisson baseline; no stable over-dispersion signal was available.'}`,
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
      if (forecast.homeMean === undefined || forecast.awayMean === undefined) return null;
      const homeDistribution = this.countDistribution(
        forecast.homeMean,
        forecast.homeVariance,
      );
      const awayDistribution = this.countDistribution(
        forecast.awayMean,
        forecast.awayVariance,
      );
      let probability = 0;
      for (let home = 0; home < homeDistribution.length; home += 1) {
        for (let away = 0; away < awayDistribution.length; away += 1) {
          const result = home > away ? 'HOME' : home === away ? 'DRAW' : 'AWAY';
          if ((['HOME_WIN', 'HOME_MOST_CORNERS'].includes(key) && result === 'HOME')
            || (['DRAW', 'DRAW_CORNERS'].includes(key) && result === 'DRAW')
            || (['AWAY_WIN', 'AWAY_MOST_CORNERS'].includes(key) && result === 'AWAY')) {
            probability += homeDistribution[home] * awayDistribution[away];
          }
        }
      }
      return PredictionMathUtil.clamp(probability, 0, 1);
    }

    const mean = forecast.mean ?? forecast.totalMean;
    if (mean === undefined || !Number.isFinite(mean) || mean < 0) return null;


    if (marketKey === 'TOTAL_CORNERS_ODD_EVEN' || marketKey === 'TOTAL_CARDS_ODD_EVEN') {
      const distribution = this.countDistribution(mean, forecast.variance);
      const even = distribution.reduce(
        (sum, probability, count) => sum + (count % 2 === 0 ? probability : 0),
        0,
      );
      return key === 'EVEN' ? even : key === 'ODD' ? 1 - even : null;
    }

    if (marketKey === (PredictionMarket.POSSESSION_OVER_UNDER as string)) {
      if (forecast.standardDeviation === undefined || selection.line === undefined) return null;
      const z = (selection.line - mean) / Math.max(forecast.standardDeviation, 1);
      const over = 1 - PredictionMathUtil.normalCdf(z);
      return key.startsWith('OVER_') ? over : key.startsWith('UNDER_') ? 1 - over : null;
    }

    if (key.startsWith('OVER_')) {
      return this.countOverProbability(mean, forecast.variance, selection.line ?? 0);
    }
    if (key.startsWith('UNDER_')) {
      return 1 - this.countOverProbability(mean, forecast.variance, selection.line ?? 0);
    }
    return null;
  }

  /**
   * Negative Binomial is used only when observed variance remains above the
   * Poisson mean after conservative shrinkage. Otherwise use Poisson.
   * The final bucket carries the remaining tail so the distribution sums to 1.
   */
  private countDistribution(
    mean: number,
    variance?: number,
    maximumCount = 80,
  ): number[] {
    const safeMean = Number.isFinite(mean) ? Math.max(0, mean) : 0;
    const distribution = new Array<number>(maximumCount + 1).fill(0);
    if (safeMean === 0) {
      distribution[0] = 1;
      return distribution;
    }

    const useNegativeBinomial = Number.isFinite(variance)
      && Number(variance) > safeMean * 1.02;

    if (useNegativeBinomial) {
      const shape = (safeMean * safeMean) / (Number(variance) - safeMean);
      const successProbability = shape / (shape + safeMean);
      const continuationProbability = 1 - successProbability;
      distribution[0] = Math.exp(shape * Math.log(successProbability));
      for (let count = 1; count < maximumCount; count += 1) {
        distribution[count] = distribution[count - 1]
          * ((count - 1 + shape) / count)
          * continuationProbability;
      }
    } else {
      distribution[0] = Math.exp(-safeMean);
      for (let count = 1; count < maximumCount; count += 1) {
        distribution[count] = distribution[count - 1] * safeMean / count;
      }
    }

    const cumulative = distribution
      .slice(0, maximumCount)
      .reduce((sum, probability) => sum + probability, 0);
    distribution[maximumCount] = Math.max(0, 1 - cumulative);
    const total = distribution.reduce((sum, probability) => sum + probability, 0);
    if (total > 0 && Math.abs(total - 1) > 1e-10) {
      for (let index = 0; index < distribution.length; index += 1) {
        distribution[index] /= total;
      }
    }
    return distribution;
  }

  private countOverProbability(mean: number, variance: number | undefined, line: number): number {
    if (!Number.isFinite(line)) return 0.5;
    const distribution = this.countDistribution(mean, variance);
    const lastUnderCount = Math.min(distribution.length - 2, Math.floor(line));
    let under = 0;
    for (let count = 0; count <= lastUnderCount; count += 1) {
      under += distribution[count];
    }
    return PredictionMathUtil.clamp(1 - under, 0, 1);
  }
}



