import { Injectable } from '@nestjs/common';
import {
  MarketDefinition,
  ExpandedMarketSelection,
} from '../../interfaces/market-catalog.interface';
import { PredictionModelInput } from '../../interfaces/prediction-match-context.interface';
import { MarketEngineOutput } from '../../interfaces/market-engine-output.interface';
import { PredictionMarket } from '../../enums/prediction-market.enum';
import { PredictionSource } from '../../enums/prediction-source.enum';
import { ODDS_CONFIG } from '../../../odds/config/odds.config';
import { PredictionMathUtil } from '../../utils/prediction-math.util';
import { selectionOutput } from './market-engine.util';

const EVENT_FIELDS: Readonly<Record<string, string>> = {
  [PredictionMarket.RED_CARD]: 'redCardMatches',
  [PredictionMarket.PENALTY_AWARDED]: 'penaltyAwardedMatches',
  [PredictionMarket.OWN_GOAL_SCORED]: 'ownGoalMatches',
};

/**
 * Pre-match event probabilities are derived only from Sports' completed,
 * Plays-covered competition projection. A current fixture timeline is never
 * treated as a pre-match sample.
 */
@Injectable()
export class SpecialMarketEngine {
  calculate(
    definition: MarketDefinition,
    selections: ExpandedMarketSelection[],
    input: PredictionModelInput,
  ): MarketEngineOutput {
    const eventField = EVENT_FIELDS[String(definition.key)];
    if (!eventField) {
      return {
        handled: false,
        selections: [],
        calculationMethod: '',
        dataQuality: 0,
        diagnostics: [],
      };
    }

    const metrics = input.context.competitionScoring?.eventMetrics;
    const coverageValue = this.nonNegativeInteger(metrics?.timelineCoverageMatches);
    const coverage = coverageValue ?? 0;
    const completedFixtures = this.nonNegativeInteger(input.context.competitionScoring?.fixturesPlayed) ?? 0;
    const coverageRate = completedFixtures > 0 ? coverage / completedFixtures : 0;
    const observedMatches = this.nonNegativeInteger(metrics?.[eventField]);
    const minimumSample = Math.max(
      ODDS_CONFIG.minimumEventTimelineSampleSize,
      definition.minimumSampleSize ?? 0,
    );

    const evidenceReady =
      coverageValue !== null
      && completedFixtures >= coverage
      && coverage >= minimumSample
      && coverageRate >= ODDS_CONFIG.minimumEventTimelineCoverage
      && observedMatches !== null
      && observedMatches <= coverage;

    if (!evidenceReady) {
      const reason =
        `Sports timeline event history is insufficient for ${String(definition.key)}. ` +
        `Covered matches: ${coverage}; completed competition matches: ${completedFixtures}; ` +
        `timeline coverage: ${(coverageRate * 100).toFixed(1)}%; required: ${minimumSample} covered matches ` +
        `and ${(ODDS_CONFIG.minimumEventTimelineCoverage * 100).toFixed(0)}% coverage.`;
      const results = selections.map((selection) => selectionOutput(
        selection,
        null,
        'Unavailable pending sufficient normalized Sports timeline coverage',
        [],
        0,
        [reason],
      ));
      return {
        handled: true,
        selections: results,
        calculationMethod: 'Unavailable: insufficient normalized Sports event sample',
        unavailableReason: reason,
        dataQuality: 0,
        diagnostics: [reason],
      };
    }

    const observedEventMatches = observedMatches ?? 0;

    // Jeffreys-style smoothing prevents a finite sample with zero or all
    // observed events from producing an artificial 0% or 100% probability.
    const yesProbability = PredictionMathUtil.clamp(
      (observedEventMatches + 0.5) / (coverage + 1),
      0.005,
      0.995,
    );
    const dataQuality = PredictionMathUtil.clamp(
      0.55
        + 0.30 * Math.min(1, coverageRate)
        + 0.10 * Math.min(1, coverage / 20),
      0,
      0.95,
    );
    const method = `Sports normalized ${String(definition.key).toLowerCase()} frequency with Jeffreys smoothing`;
    const diagnostics = [
      `Observed event matches: ${observedEventMatches}/${coverage} Plays-covered matches.`,
      `Timeline coverage: ${coverage}/${completedFixtures} completed competition matches (${(coverageRate * 100).toFixed(1)}%).`,
    ];

    const results = selections.map((selection) => {
      const probability = selection.key === 'YES'
        ? yesProbability
        : selection.key === 'NO'
          ? 1 - yesProbability
          : null;
      return selectionOutput(
        selection,
        probability,
        method,
        [PredictionSource.HISTORICAL_COUNT_MODEL],
        dataQuality,
        diagnostics,
      );
    });

    const hasCalculatedSelection = results.some((item) => item.status === 'CALCULATED');
    return {
      handled: true,
      selections: results,
      calculationMethod: method,
      unavailableReason: hasCalculatedSelection
        ? undefined
        : 'The canonical event selection could not be resolved to YES or NO.',
      dataQuality: hasCalculatedSelection ? dataQuality : 0,
      diagnostics,
    };
  }

  private nonNegativeInteger(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
}
