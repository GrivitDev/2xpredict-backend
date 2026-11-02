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
import { EspnPayloadUtil } from '../../utils/espn-payload.util';
import { selectionOutput } from './market-engine.util';

@Injectable()
export class SpecialMarketEngine {
  calculate(
    definition: MarketDefinition,
    selections: ExpandedMarketSelection[],
    input: PredictionModelInput,
  ): MarketEngineOutput {
    if (
      ![
        PredictionMarket.PENALTY_AWARDED,
        PredictionMarket.OWN_GOAL_SCORED,
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

    const evidence = this.eventEvidence(definition.key, input);
    const results = selections.map((selection): SelectionModelOutput => {
      if (evidence.sampleSize < 8) {
        return selectionOutput(
          selection,
          null,
          'Insufficient ESPN event-history coverage',
          [PredictionSource.HISTORICAL_FIXTURES],
          0,
          [
            `Only ${evidence.sampleSize} historical fixtures had usable event details; at least 8 are required.`,
          ],
        );
      }
      const probabilityYes = (evidence.events + 1) / (evidence.sampleSize + 2);
      const probability =
        selection.key === 'YES' ? probabilityYes : 1 - probabilityYes;
      return selectionOutput(
        selection,
        probability,
        'Smoothed historical event frequency',
        [PredictionSource.HISTORICAL_FIXTURES],
        Math.min(0.85, evidence.sampleSize / 20),
        [
          `Observed in ${evidence.events} of ${evidence.sampleSize} fixtures; one-event/one-non-event beta smoothing applied.`,
        ],
      );
    });

    return {
      handled: true,
      selections: results,
      calculationMethod: 'Smoothed historical ESPN event frequency',
      dataQuality: Math.min(1, evidence.sampleSize / 20),
      unavailableReason:
        evidence.sampleSize < 8
          ? 'Insufficient historical event details.'
          : undefined,
      diagnostics: [
        `Event count: ${evidence.events}; usable fixture sample: ${evidence.sampleSize}.`,
      ],
    };
  }

  private eventEvidence(
    marketKey: PredictionMarket,
    input: PredictionModelInput,
  ): { events: number; sampleSize: number } {
    const all = [
      ...input.context.historicalFixtures,
      ...input.context.leagueFixtures,
    ];
    const unique = new Map(all.map((fixture) => [fixture.eventId, fixture]));
    let events = 0;
    let sampleSize = 0;

    for (const fixture of unique.values()) {
      if (
        !fixture.completed ||
        fixture.fixtureDate >= input.context.fixture.fixtureDate
      )
        continue;
      const payload = EspnPayloadUtil.asRecord(fixture.payload);
      const summary = EspnPayloadUtil.asRecord(payload.summary);
      const competitions = EspnPayloadUtil.asArray(payload.competitions);
      const details: unknown[] = [];
      for (const competition of competitions) {
        for (const detail of EspnPayloadUtil.asArray(
          EspnPayloadUtil.asRecord(competition).details,
        )) {
          details.push(detail as unknown);
        }
      }
      for (const event of EspnPayloadUtil.asArray(summary.keyEvents)) {
        details.push(event as unknown);
      }
      if (!details.length) continue;
      sampleSize += 1;
      const foundEvent = details.some((raw) => {
        const event = EspnPayloadUtil.asRecord(raw);
        const type = EspnPayloadUtil.asRecord(event.type);
        const text = String(
          type.text ?? type.name ?? event.text ?? '',
        ).toLowerCase();
        if (marketKey === PredictionMarket.PENALTY_AWARDED) {
          return (
            event.penaltyKick === true ||
            text.includes('penalty') ||
            text.includes('penalty kick')
          );
        }
        return event.ownGoal === true || text.includes('own goal');
      });
      if (foundEvent) events += 1;
    }
    return { events, sampleSize };
  }
}

