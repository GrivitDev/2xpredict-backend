import { Injectable } from '@nestjs/common';
import type {
  PredictionMatchContext,
  PredictionStatisticAggregate,
} from '../interfaces/prediction-match-context.interface';

export interface StatisticForecast {
  metric: string;
  totalMean?: number;
  homeMean?: number;
  awayMean?: number;
  mean?: number;
  /** Observed count variance, conservatively shrunk toward the Poisson mean. */
  variance?: number;
  homeVariance?: number;
  awayVariance?: number;
  /** Kept for future continuous metrics that have a supported observed range. */
  standardDeviation?: number;
  sampleSize: number;
  source: string;
  dispersionMethod?: 'NEGATIVE_BINOMIAL' | 'POISSON' | 'RANGE_APPROXIMATION';
}

type Scope = 'TOTAL' | 'HOME' | 'AWAY' | 'POSSESSION';
interface MetricSpec {
  aliases: string[];
  scope: Scope;
  combine?: 'SUM' | 'CARDS';
}

const METRICS: Record<string, MetricSpec> = {
  TOTAL_CORNERS_OVER_UNDER: { aliases: ['wonCorners', 'cornerKicks', 'corners', 'corner'], scope: 'TOTAL' },
  TOTAL_CORNERS_ODD_EVEN: { aliases: ['wonCorners', 'cornerKicks', 'corners', 'corner'], scope: 'TOTAL' },
  CORNER_MATCH_RESULT: { aliases: ['wonCorners', 'cornerKicks', 'corners', 'corner'], scope: 'TOTAL' },
  HOME_CORNERS_OVER_UNDER: { aliases: ['wonCorners', 'cornerKicks', 'corners', 'corner'], scope: 'HOME' },
  AWAY_CORNERS_OVER_UNDER: { aliases: ['wonCorners', 'cornerKicks', 'corners', 'corner'], scope: 'AWAY' },
  HOME_TEAM_CORNERS_OVER_UNDER: { aliases: ['wonCorners', 'cornerKicks', 'corners', 'corner'], scope: 'HOME' },
  AWAY_TEAM_CORNERS_OVER_UNDER: { aliases: ['wonCorners', 'cornerKicks', 'corners', 'corner'], scope: 'AWAY' },
  TOTAL_CARDS_OVER_UNDER: { aliases: ['yellowCards', 'redCards', 'cards'], scope: 'TOTAL', combine: 'CARDS' },
  TOTAL_CARDS_ODD_EVEN: { aliases: ['yellowCards', 'redCards', 'cards'], scope: 'TOTAL', combine: 'CARDS' },
  TOTAL_YELLOW_CARDS_OVER_UNDER: { aliases: ['yellowCards', 'yellowCard'], scope: 'TOTAL' },
  TOTAL_RED_CARDS_OVER_UNDER: { aliases: ['redCards', 'redCard'], scope: 'TOTAL' },
  HOME_TEAM_CARDS_OVER_UNDER: { aliases: ['yellowCards', 'redCards', 'cards'], scope: 'HOME', combine: 'CARDS' },
  AWAY_TEAM_CARDS_OVER_UNDER: { aliases: ['yellowCards', 'redCards', 'cards'], scope: 'AWAY', combine: 'CARDS' },
  TOTAL_SHOTS_OVER_UNDER: { aliases: ['totalShots', 'shots', 'shot'], scope: 'TOTAL' },
  TOTAL_SHOTS_ON_TARGET_OVER_UNDER: { aliases: ['shotsOnTarget', 'shotsOnGoal', 'sot', 'onGoal'], scope: 'TOTAL' },
  HOME_SHOTS_ON_TARGET_OVER_UNDER: { aliases: ['shotsOnTarget', 'shotsOnGoal', 'sot', 'onGoal'], scope: 'HOME' },
  AWAY_SHOTS_ON_TARGET_OVER_UNDER: { aliases: ['shotsOnTarget', 'shotsOnGoal', 'sot', 'onGoal'], scope: 'AWAY' },
  TOTAL_OFFSIDES_OVER_UNDER: { aliases: ['offsides', 'offside'], scope: 'TOTAL' },
  TOTAL_FOULS_OVER_UNDER: { aliases: ['foulsCommitted', 'fouls', 'foul'], scope: 'TOTAL' },
  POSSESSION_OVER_UNDER: { aliases: ['possessionPct', 'possession', 'possessionPercentage'], scope: 'POSSESSION' },
};

const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const toPercent = (value: number): number => value > 1 ? value : value * 100;

@Injectable()
export class MarketStatForecastService {
  forecast(context: PredictionMatchContext, marketKey: string): StatisticForecast | null {
    const spec = METRICS[marketKey];
    if (!spec) return null;

    const home = this.readAggregate(context.teamStatisticsAggregates.home?.statistics ?? [], spec);
    const away = this.readAggregate(context.teamStatisticsAggregates.away?.statistics ?? [], spec);

    if (spec.scope === 'POSSESSION') {
      if (!home || home.sampleSize < this.minimumSampleSize(marketKey)) return null;

      // Continuous possession forecasts require actual observed bounds. The
      // Sports projection now retains them from per-fixture source observations;
      // do not infer a range from an average alone.
      const rawMinimum = finite(home.minimum);
      const rawMaximum = finite(home.maximum);
      if (rawMinimum === null || rawMaximum === null || rawMaximum < rawMinimum) return null;

      const mean = toPercent(home.average);
      const minimum = toPercent(rawMinimum);
      const maximum = toPercent(rawMaximum);
      if (![mean, minimum, maximum].every(Number.isFinite)) return null;

      const range = Math.max(0, maximum - minimum);
      return {
        metric: home.key,
        mean,
        standardDeviation: Math.max(2, range / Math.sqrt(12)),
        sampleSize: home.sampleSize,
        source: 'Sports team-statistics aggregate; dispersion is approximated from actual observed min/max bounds, not inferred from the average.',
        dispersionMethod: 'RANGE_APPROXIMATION',
      };
    }

    if (spec.scope === 'HOME' || spec.scope === 'AWAY') {
      const selected = spec.scope === 'HOME' ? home : away;
      if (!selected || selected.sampleSize < this.minimumSampleSize(marketKey)) return null;
      const variance = this.stabilizeVariance(
        selected.average,
        selected.variance,
        selected.sampleSize,
      );
      return {
        metric: selected.key,
        mean: selected.average,
        ...(variance !== null ? { variance } : {}),
        sampleSize: selected.sampleSize,
        source: `Sports normalized venue-specific ${spec.scope.toLowerCase()} team-statistics aggregate (${selected.sampleSize} qualifying matches); observed dispersion is shrunk toward the Poisson baseline for stability.`,
        dispersionMethod: variance !== null && variance > selected.average * 1.02
          ? 'NEGATIVE_BINOMIAL'
          : 'POISSON',
      };
    }

    if (!home || !away) return null;
    const sampleSize = Math.min(home.sampleSize, away.sampleSize);
    if (sampleSize < this.minimumSampleSize(marketKey)) return null;

    const homeMean = home.average;
    const awayMean = away.average;
    const totalMean = homeMean + awayMean;
    const homeVariance = this.stabilizeVariance(homeMean, home.variance, home.sampleSize);
    const awayVariance = this.stabilizeVariance(awayMean, away.variance, away.sampleSize);
    // The source does not expose paired home/away covariance. Sum the independent
    // venue-sample variances as an explicit approximation rather than inventing one.
    const variance = homeVariance !== null && awayVariance !== null
      ? homeVariance + awayVariance
      : null;
    const dispersionMethod = variance !== null && variance > totalMean * 1.02
      ? 'NEGATIVE_BINOMIAL'
      : 'POISSON';
    return {
      metric: home.key,
      homeMean,
      awayMean,
      totalMean,
      mean: totalMean,
      ...(homeVariance !== null ? { homeVariance } : {}),
      ...(awayVariance !== null ? { awayVariance } : {}),
      ...(variance !== null ? { variance } : {}),
      sampleSize,
      source: `Combined Sports normalized team-statistics aggregates; both team samples have at least ${this.minimumSampleSize(marketKey)} matches. ${dispersionMethod === 'NEGATIVE_BINOMIAL' ? 'Over-dispersion is modelled with a Negative Binomial distribution.' : 'A Poisson distribution is retained because observed dispersion does not support an over-dispersed fit.'}`,
      dispersionMethod,
    };
  }

  private stabilizeVariance(
    mean: number,
    observedVariance: number | null | undefined,
    sampleSize: number,
  ): number | null {
    if (
      !Number.isFinite(mean)
      || mean < 0
      || observedVariance === null
      || observedVariance === undefined
      || !Number.isFinite(Number(observedVariance))
      || Number(observedVariance) < 0
      || !Number.isFinite(sampleSize)
      || sampleSize < 2
    ) return null;

    // Keep the count model at least as dispersed as Poisson. The empirical
    // over-dispersion signal is shrunk toward variance=mean, especially for small samples.
    const reliability = sampleSize / (sampleSize + 5);
    return mean + Math.max(0, Number(observedVariance) - mean) * reliability;
  }

  private minimumSampleSize(key: string): number {
    return key === 'TOTAL_RED_CARDS_OVER_UNDER' ? 8 : 5;
  }

  private readAggregate(
    rows: PredictionStatisticAggregate[],
    spec: MetricSpec,
  ): PredictionStatisticAggregate | null {
    const wanted = new Set(spec.aliases.map(normalize));
    const candidates = rows.filter((row) => wanted.has(normalize(row.key)) || wanted.has(normalize(row.name)));
    if (!candidates.length) return null;

    const find = (aliases: string[]): PredictionStatisticAggregate | null => {
      const match = rows.find((row) => aliases.some((alias) =>
        normalize(row.key) === normalize(alias) || normalize(row.name) === normalize(alias),
      ));
      return match && Number.isFinite(match.average) && match.sampleSize > 0 ? match : null;
    };

    if (spec.combine === 'CARDS') {
      const yellow = find(['yellowCards', 'yellowCard']);
      const red = find(['redCards', 'redCard']);
      if (yellow && red) {
        const minimum = finite(yellow.minimum);
        const redMinimum = finite(red.minimum);
        const maximum = finite(yellow.maximum);
        const redMaximum = finite(red.maximum);
        return {
          key: 'cards',
          name: 'Cards',
          sampleSize: Math.min(yellow.sampleSize, red.sampleSize),
          average: yellow.average + red.average,
          minimum: minimum !== null && redMinimum !== null ? minimum + redMinimum : null,
          maximum: maximum !== null && redMaximum !== null ? maximum + redMaximum : null,
        };
      }
      return find(['cards', 'totalCards']);
    }

    return candidates.find((row) => Number.isFinite(row.average) && row.sampleSize > 0) ?? null;
  }
}

