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
import { EspnPayloadUtil } from '../../utils/espn-payload.util';
import { countOverProbability, selectionOutput } from './market-engine.util';

interface PlayerHistoryStats {
  appearances: number;
  goals: number;
  assists: number;
  shotsOnTarget: number;
  yellowCardMatches: number;
  redCardMatches: number;
  yellowCards: number;
  redCards: number;
}

@Injectable()
export class PlayerMarketEngine {
  private readonly supported = new Set<string>([
    PredictionMarket.PLAYER_ANYTIME_GOALSCORER,
    PredictionMarket.PLAYER_FIRST_GOALSCORER,
    PredictionMarket.PLAYER_LAST_GOALSCORER,
    PredictionMarket.PLAYER_TO_SCORE_TWO_OR_MORE,
    PredictionMarket.PLAYER_TO_ASSIST,
    PredictionMarket.PLAYER_SHOTS_ON_TARGET,
    PredictionMarket.PLAYER_TO_BE_BOOKED,
    PredictionMarket.PLAYER_TO_BE_SENT_OFF,
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
    if (selections.length === 0) {
      return {
        handled: true,
        selections: [],
        calculationMethod: 'ESPN roster candidates are unavailable',
        dataQuality: 0,
        unavailableReason: 'No athlete roster was supplied by ESPN.',
        diagnostics: [
          'Player markets require identifiable ESPN athlete IDs and historical player statistics.',
        ],
      };
    }

    const results = selections.map((selection): SelectionModelOutput => {
      if (!selection.subjectId) {
        return selectionOutput(
          selection,
          null,
          'Player ID missing',
          [PredictionSource.PLAYER_RATE_MODEL],
          0,
          ['ESPN did not provide an athlete ID.'],
        );
      }
      const stats = this.playerHistory(selection.subjectId, input);
      const minimumApps = 3;
      if (stats.appearances < minimumApps) {
        return selectionOutput(
          selection,
          null,
          'Insufficient player-history sample',
          [PredictionSource.PLAYER_RATE_MODEL],
          0,
          [
            `Only ${stats.appearances} historical player appearances were found; at least ${minimumApps} are required.`,
          ],
        );
      }
      const probability = this.probability(
        definition.key,
        selection,
        stats,
        input,
      );
      return selectionOutput(
        selection,
        probability,
        'Smoothed per-appearance rate from historical ESPN player boxscores and match events',
        [PredictionSource.PLAYER_RATE_MODEL, PredictionSource.ESPN_ROSTERS],
        Math.min(0.92, 0.25 + Math.min(1, stats.appearances / 12) * 0.65),
        [],
      );
    });

    const calculated = results.filter(
      (result) => result.status === 'CALCULATED',
    ).length;
    return {
      handled: true,
      selections: results,
      calculationMethod:
        'Smoothed player-event rate model using historical ESPN boxscore statistics',
      dataQuality: selections.length ? calculated / selections.length : 0,
      unavailableReason: calculated
        ? undefined
        : 'No roster player met the minimum historical data requirement.',
      diagnostics: [
        `Candidate selections: ${selections.length}.`,
        `Calculated selections: ${calculated}.`,
      ],
    };
  }

  private probability(
    marketKey: string,
    selection: ExpandedMarketSelection,
    stats: PlayerHistoryStats,
    input: PredictionModelInput,
  ): number | null {
    const appearances = Math.max(1, stats.appearances);
    const goalRate = (stats.goals + 0.5) / (appearances + 5);
    const assistRate = (stats.assists + 0.25) / (appearances + 5);
    const shotsOnTargetRate = (stats.shotsOnTarget + 1.0) / (appearances + 2);
    const bookingRate = (stats.yellowCardMatches + 0.15) / (appearances + 3);
    const redCardRate = (stats.redCardMatches + 0.02) / (appearances + 5);

    if (marketKey === String(PredictionMarket.PLAYER_ANYTIME_GOALSCORER)) {
      return 1 - Math.exp(-goalRate);
    }
    if (marketKey === String(PredictionMarket.PLAYER_TO_SCORE_TWO_OR_MORE)) {
      return 1 - Math.exp(-goalRate) * (1 + goalRate);
    }
    if (marketKey === String(PredictionMarket.PLAYER_TO_ASSIST)) {
      return 1 - Math.exp(-assistRate);
    }
    if (marketKey === String(PredictionMarket.PLAYER_SHOTS_ON_TARGET)) {
      const line = selection.line ?? 0.5;
      return selection.key.includes('_OVER_')
        ? countOverProbability(shotsOnTargetRate, line)
        : 1 - countOverProbability(shotsOnTargetRate, line);
    }
    if (marketKey === String(PredictionMarket.PLAYER_TO_BE_BOOKED)) {
      return 1 - Math.exp(-(bookingRate + redCardRate));
    }
    if (marketKey === String(PredictionMarket.PLAYER_TO_BE_SENT_OFF)) {
      return 1 - Math.exp(-redCardRate);
    }
    if (
      marketKey === String(PredictionMarket.PLAYER_FIRST_GOALSCORER) ||
      marketKey === String(PredictionMarket.PLAYER_LAST_GOALSCORER)
    ) {
      const teamId = selection.subjectTeamId;
      const homePlayer =
        String(teamId) === String(input.context.fixture.homeTeamId);
      const teamLambda = homePlayer
        ? input.expectedGoals.home
        : input.expectedGoals.away;
      const overallLambda = input.expectedGoals.home + input.expectedGoals.away;
      if (teamLambda <= 0 || overallLambda <= 0) return 0;
      const teamFirstGoalProbability =
        ((1 - Math.exp(-overallLambda)) * teamLambda) / overallLambda;
      const estimatedShare = Math.min(1, goalRate / teamLambda);
      return PredictionMathUtil.clamp(
        teamFirstGoalProbability * estimatedShare,
        0,
        1,
      );
    }
    return null;
  }

  private playerHistory(
    athleteId: string,
    input: PredictionModelInput,
  ): PlayerHistoryStats {
    const seenAppearances = new Set<string>();
    const result: PlayerHistoryStats = {
      appearances: 0,
      goals: 0,
      assists: 0,
      shotsOnTarget: 0,
      yellowCardMatches: 0,
      redCardMatches: 0,
      yellowCards: 0,
      redCards: 0,
    };

    for (const fixture of input.context.historicalFixtures) {
      if (
        !fixture.completed ||
        fixture.fixtureDate >= input.context.fixture.fixtureDate
      )
        continue;
      const stats = this.playerStatsForFixture(fixture, athleteId);
      const rosterAppeared = this.playerInRoster(fixture, athleteId);
      const eventMetrics = this.playerEventsForFixture(fixture, athleteId);
      const hasEvidence =
        stats.found || rosterAppeared || eventMetrics.appeared;
      if (!hasEvidence) continue;

      if (!seenAppearances.has(fixture.eventId)) {
        seenAppearances.add(fixture.eventId);
        result.appearances += 1;
      }
      result.goals += stats.goals ?? eventMetrics.goals;
      result.assists += stats.assists;
      result.shotsOnTarget += stats.shotsOnTarget;
      result.yellowCards += Math.max(
        stats.yellowCards,
        eventMetrics.yellowCards,
      );
      result.redCards += Math.max(stats.redCards, eventMetrics.redCards);
      if (stats.yellowCards > 0 || eventMetrics.yellowCards > 0)
        result.yellowCardMatches += 1;
      if (stats.redCards > 0 || eventMetrics.redCards > 0)
        result.redCardMatches += 1;
    }
    return result;
  }

  private playerStatsForFixture(
    fixture: any,
    athleteId: string,
  ): {
    found: boolean;
    goals?: number;
    assists: number;
    shotsOnTarget: number;
    yellowCards: number;
    redCards: number;
  } {
    const fixtureRecord = EspnPayloadUtil.asRecord(fixture);
    const payload = EspnPayloadUtil.asRecord(fixtureRecord.payload);
    const summary = EspnPayloadUtil.asRecord(payload.summary);
    const boxscore = EspnPayloadUtil.asRecord(summary.boxscore);
    const players = EspnPayloadUtil.findRecursive(
      boxscore.players,
      (record) => {
        const athlete = EspnPayloadUtil.asRecord(record.athlete);
        return (
          String(athlete.id ?? '') === athleteId && Array.isArray(record.stats)
        );
      },
    );
    let goals: number | undefined;
    let assists = 0,
      shotsOnTarget = 0,
      yellowCards = 0,
      redCards = 0;
    let found = false;

    for (const playerEntry of players) {
      found = true;
      const stats = EspnPayloadUtil.asArray(playerEntry.stats);
      for (const raw of stats) {
        const stat = EspnPayloadUtil.asRecord(raw);
        const key = String(
          stat.name ?? stat.abbreviation ?? stat.displayName ?? '',
        )
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '');
        const value = EspnPayloadUtil.finiteNumber(
          stat.displayValue ?? stat.value,
        );
        if (value === null) continue;
        if (['goals', 'totalgoals', 'goal'].includes(key))
          goals = (goals ?? 0) + value;
        if (['assists', 'goalassists', 'a'].includes(key)) assists += value;
        if (['shotsontarget', 'sot', 'shotsongoal'].includes(key))
          shotsOnTarget += value;
        if (['yellowcards', 'yellowcard', 'yc'].includes(key))
          yellowCards += value;
        if (['redcards', 'redcard', 'rc'].includes(key)) redCards += value;
      }
    }
    return { found, goals, assists, shotsOnTarget, yellowCards, redCards };
  }

  private playerInRoster(fixture: any, athleteId: string): boolean {
    const fixtureRecord = EspnPayloadUtil.asRecord(fixture);
    const payload = EspnPayloadUtil.asRecord(fixtureRecord.payload);
    const summary = EspnPayloadUtil.asRecord(payload.summary);
    const rosters = EspnPayloadUtil.findRecursive(summary.rosters, (record) => {
      const athlete = EspnPayloadUtil.asRecord(record.athlete);
      return String(athlete.id ?? '') === athleteId;
    });
    return rosters.length > 0;
  }

  private playerEventsForFixture(
    fixture: any,
    athleteId: string,
  ): {
    appeared: boolean;
    goals: number;
    yellowCards: number;
    redCards: number;
  } {
    const fixtureRecord = EspnPayloadUtil.asRecord(fixture);
    const payload = EspnPayloadUtil.asRecord(fixtureRecord.payload);
    const summary = EspnPayloadUtil.asRecord(payload.summary);
    const detailSources: unknown[] = [];
    for (const competition of EspnPayloadUtil.asArray(payload.competitions)) {
      detailSources.push(
        EspnPayloadUtil.asRecord(competition).details as unknown,
      );
    }
    detailSources.push(summary.keyEvents as unknown);
    let goals = 0,
      yellowCards = 0,
      redCards = 0,
      appeared = false;
    for (const source of detailSources) {
      for (const raw of EspnPayloadUtil.asArray(source)) {
        const event = EspnPayloadUtil.asRecord(raw);
        const type = EspnPayloadUtil.asRecord(event.type);
        const text = String(
          type.text ?? type.name ?? event.text ?? '',
        ).toLowerCase();
        const participants = EspnPayloadUtil.asArray(
          event.athletesInvolved,
        ).concat(EspnPayloadUtil.asArray(event.participants));
        const involved = participants.some((participant) => {
          const athlete = EspnPayloadUtil.asRecord(
            EspnPayloadUtil.asRecord(participant).athlete ?? participant,
          );
          return String(athlete.id ?? '') === athleteId;
        });
        if (!involved) continue;
        appeared = true;
        if (
          text.includes('goal') &&
          !text.includes('own goal') &&
          event.scoringPlay !== false
        )
          goals += 1;
        if (text.includes('yellow card')) yellowCards += 1;
        if (text.includes('red card')) redCards += 1;
      }
    }
    return { appeared, goals, yellowCards, redCards };
  }
}

