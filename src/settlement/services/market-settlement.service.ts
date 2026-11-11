import { Injectable } from '@nestjs/common';
import {
  SettlementEvaluation,
  SettlementEventFacts,
  SettlementSelectionInput,
  SettlementPhase,
} from '../interfaces/settlement-context.interface';
import { SettlementOutcome as O } from '../enums/settlement-outcome.enum';
import { SETTLEMENT_CONFIG } from '../config/settlement.config';
import { FOOTBALL_MARKET_CATALOG } from '../../odds/catalog/football-market-catalog';
import type { CanonicalMarketDefinition } from '../../odds/catalog/football-market-catalog';

const unresolved = (
  reason: string,
  evidence?: Record<string, unknown>,
): SettlementEvaluation => ({
  outcome: O.UNRESOLVED,
  method: 'INSUFFICIENT_EVIDENCE',
  reason,
  evidence,
});
const resolved = (
  outcome: O,
  method: string,
  evidence?: Record<string, unknown>,
  phase?: SettlementPhase,
): SettlementEvaluation => {
  const safeEvidence = evidence;
  return {
    outcome,
    method,
    evidence: safeEvidence,
    ...(phase ? { phase } : {}),
  };
};
const boolOutcome = (
  condition: boolean,
  method: string,
  evidence?: Record<string, unknown>,
  phase?: SettlementPhase,
): SettlementEvaluation =>
  resolved(condition ? O.WON : O.LOST, method, evidence, phase);
const str = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return '';
    }
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  )
    return value.toString();
  if (typeof value === 'symbol') return value.description ?? '';
  if (typeof value === 'function') return value.name;
  return '';
};
const num = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const match = value.match(/^-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const norm = (value: unknown): string =>
  str(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
const compact = (value: unknown): string =>
  str(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

const settlementEvidenceConfig = ((
  SETTLEMENT_CONFIG as { evidence?: Record<string, number> } | undefined
)?.evidence ?? {
  fullTimeStatisticsFreshnessMs: 5 * 60_000,
  inPlayFixtureFreshnessMs: 90_000,
  inPlayTimelineFreshnessMs: 90_000,
  inPlayStatisticsFreshnessMs: 90_000,
}) as {
  fullTimeStatisticsFreshnessMs: number;
  inPlayFixtureFreshnessMs: number;
  inPlayTimelineFreshnessMs: number;
  inPlayStatisticsFreshnessMs: number;
};

const EXTRA_TIME_AGGREGATE_MARKETS = new Set([
  'TOTAL_CORNERS_OVER_UNDER',
  'TOTAL_CORNERS_ODD_EVEN',
  'CORNER_MATCH_RESULT',
  'HOME_TEAM_CORNERS_OVER_UNDER',
  'AWAY_TEAM_CORNERS_OVER_UNDER',
  'HOME_CORNERS_OVER_UNDER',
  'AWAY_CORNERS_OVER_UNDER',
  'TOTAL_SHOTS_OVER_UNDER',
  'TOTAL_SHOTS_ON_TARGET_OVER_UNDER',
  'HOME_SHOTS_ON_TARGET_OVER_UNDER',
  'AWAY_SHOTS_ON_TARGET_OVER_UNDER',
  'TOTAL_CARDS_OVER_UNDER',
  'TOTAL_YELLOW_CARDS_OVER_UNDER',
  'TOTAL_RED_CARDS_OVER_UNDER',
  'HOME_TEAM_CARDS_OVER_UNDER',
  'AWAY_TEAM_CARDS_OVER_UNDER',
  'TOTAL_OFFSIDES_OVER_UNDER',
  'TOTAL_FOULS_OVER_UNDER',
  'POSSESSION_OVER_UNDER',
  'PLAYER_ANYTIME_GOALSCORER',
  'PLAYER_FIRST_GOALSCORER',
  'PLAYER_LAST_GOALSCORER',
  'PLAYER_TO_SCORE_TWO_OR_MORE',
  'PLAYER_TO_ASSIST',
  'PLAYER_SHOTS_ON_TARGET',
  'PLAYER_SHOTS_ON_TARGET_OVER_UNDER',
  'PLAYER_SHOTS_OVER_UNDER',
  'PLAYER_TO_BE_BOOKED',
  'PLAYER_TO_BE_SENT_OFF',
]);

@Injectable()
export class MarketSettlementService {
  settle(
    marketKey: string,
    selection: SettlementSelectionInput,
    facts: SettlementEventFacts,
  ): SettlementEvaluation {
    if (facts.settlementBlockers?.length) {
      return unresolved(
        'Settlement was blocked because authoritative fixture facts conflict.',
        {
          blockers: facts.settlementBlockers,
          sourceDiagnostics: facts.sourceDiagnostics,
        },
      );
    }
    const definition = this.resolveMarketDefinition(marketKey);
    if (!definition) {
      return unresolved(
        `Market ${marketKey} is not present in the Odds module's canonical football market catalogue.`,
        { marketKey, catalogue: 'FOOTBALL_MARKET_CATALOG' },
      );
    }
    const sourceMarket = norm(marketKey);
    const market = definition.predictionMarketKey;
    const resolvedSelection = this.resolveCatalogSelection(
      definition,
      selection,
    );
    if (definition.selectionMode === 'STATIC' && !resolvedSelection) {
      return unresolved(
        `Selection is not defined by the Odds catalogue for market ${definition.id}.`,
        {
          market: definition.id,
          selectionKey: selection.key,
          settlementKey: selection.settlementKey,
        },
      );
    }
    const preferHandicapLine = definition.selectionMode === 'ASIAN_HANDICAP';
    const suppliedLine = preferHandicapLine
      ? this.readHandicap(selection)
      : this.readLine(selection);
    if (
      (definition.selectionMode === 'OVER_UNDER' ||
        definition.selectionMode === 'ASIAN_HANDICAP' ||
        definition.selectionMode === 'EUROPEAN_HANDICAP') &&
      suppliedLine !== undefined &&
      definition.lines?.length &&
      !definition.lines.some(
        (candidate) => Math.abs(candidate - suppliedLine) < 1e-7,
      )
    ) {
      return unresolved(
        `Line ${suppliedLine} is not supported by the Odds catalogue for market ${definition.id}.`,
        {
          market: definition.id,
          line: suppliedLine,
          supportedLines: definition.lines,
        },
      );
    }
    if (facts.afterExtraTime && EXTRA_TIME_AGGREGATE_MARKETS.has(market)) {
      return unresolved(
        'Sports aggregate statistics may include extra time; regulation-only statistics are not available for this market.',
        { afterExtraTime: true, market },
      );
    }
    const key = norm(
      resolvedSelection?.key ??
        selection.settlementKey ??
        selection.key ??
        selection.code,
    );
    const name = str(
      resolvedSelection?.fullName ??
        selection.fullName ??
        selection.subjectName ??
        selection.code ??
        selection.key,
    );
    const label = `${key} ${name}`.toUpperCase();
    const scoreAvailable =
      facts.regulationScoreAvailable !== false &&
      facts.homeGoals !== undefined &&
      facts.awayGoals !== undefined;
    const fullHome = facts.homeGoals;
    const fullAway = facts.awayGoals;
    const fullTotal = scoreAvailable ? fullHome! + fullAway! : undefined;
    const firstHome = facts.halfTimeHomeGoals;
    const firstAway = facts.halfTimeAwayGoals;
    const secondHome = facts.secondHalfHomeGoals;
    const secondAway = facts.secondHalfAwayGoals;
    const side = this.selectedSide(selection, facts);
    const line = this.readLine(selection, preferHandicapLine);
    const hasFreshTeamStatistics = (): boolean => {
      const maxAge = settlementEvidenceConfig.fullTimeStatisticsFreshnessMs;
      const now = Date.now();
      const collectedAt: unknown[] = [
        facts.homeStatisticsCollectedAt,
        facts.awayStatisticsCollectedAt,
      ];
      return collectedAt.every((collectedAt) =>
        Boolean(
          collectedAt instanceof Date &&
          Number.isFinite(collectedAt.getTime()) &&
          now >= collectedAt.getTime() - 60_000 &&
          now - collectedAt.getTime() <= maxAge,
        ),
      );
    };

    const yesNo = (
      actual: boolean | undefined,
      method: string,
      reason: string,
      phase?: SettlementPhase,
    ): SettlementEvaluation => {
      if (actual === undefined) return unresolved(reason);
      const no =
        /(^|_)NO($|_)|\bNO\b|\bNG\b/.test(label) && !/NO_GOAL/.test(key);
      const yes = /(^|_)YES($|_)|\bYES\b|\bGG\b/.test(label);
      if (!no && !yes)
        return unresolved('Selection could not be identified as Yes or No.');
      return boolOutcome(
        no ? !actual : actual,
        method,
        {
          actual,
          selected: no ? 'NO' : 'YES',
        },
        phase,
      );
    };

    const resultOf = (
      home?: number,
      away?: number,
    ): 'HOME' | 'DRAW' | 'AWAY' | undefined =>
      home === undefined || away === undefined
        ? undefined
        : home > away
          ? 'HOME'
          : home < away
            ? 'AWAY'
            : 'DRAW';
    const compareResultSelection = (
      home?: number,
      away?: number,
      mode: string = market,
      phase?: SettlementPhase,
    ): SettlementEvaluation => {
      const result = resultOf(home, away);
      if (!result)
        return unresolved(
          'The required score for this match period is unavailable.',
        );
      if (
        mode === 'MATCH_RESULT' ||
        mode === 'HALF_TIME_RESULT' ||
        mode === 'SECOND_HALF_RESULT' ||
        mode === 'CORNER_MATCH_RESULT'
      ) {
        const expected = this.resultSelection(key, label);
        return expected
          ? boolOutcome(
              result === expected,
              `${mode}_SCORE_COMPARISON`,
              {
                result,
                expected,
                home,
                away,
              },
              phase,
            )
          : unresolved(
              'Result selection could not be mapped to Home/Draw/Away.',
            );
      }
      if (mode === 'DOUBLE_CHANCE' || mode === 'FIRST_HALF_DOUBLE_CHANCE') {
        const expected =
          key.includes('HOME_OR_DRAW') || key === '1X'
            ? ['HOME', 'DRAW']
            : key.includes('DRAW_OR_AWAY') || key === 'X2'
              ? ['DRAW', 'AWAY']
              : key.includes('HOME_OR_AWAY') || key === '12'
                ? ['HOME', 'AWAY']
                : undefined;
        return expected
          ? boolOutcome(
              expected.includes(result),
              `${mode}_SCORE_COMPARISON`,
              {
                result,
                expected,
                home,
                away,
              },
              phase,
            )
          : unresolved('Double Chance selection could not be mapped.');
      }
      if (mode === 'DRAW_NO_BET' || mode === 'FIRST_HALF_DRAW_NO_BET') {
        if (result === 'DRAW')
          return resolved(O.PUSH, `${mode}_DRAW_PUSH`, { home, away }, phase);
        const expected = side;
        return expected
          ? boolOutcome(
              result === expected,
              `${mode}_SCORE_COMPARISON`,
              {
                result,
                expected,
                home,
                away,
              },
              phase,
            )
          : unresolved('Draw No Bet team could not be identified.');
      }
      return unresolved(`No result settlement rule exists for ${mode}.`);
    };

    // IN-PLAY SETTLEMENT: only outcomes that are mathematically irreversible
    // from already-observed facts are written before the full-time whistle.
    // Missing events never prove a negative result; only positive events,
    // completed first-half facts, or monotonic count thresholds can resolve.
    if (!facts.isFinished) {
      const phase: SettlementPhase =
        facts.fixtureState === 'HALFTIME' ? 'HALF_TIME' : 'IN_PLAY';
      const isFresh = (date: unknown, maxAgeMs: number): boolean =>
        Boolean(
          date instanceof Date &&
          Number.isFinite(date.getTime()) &&
          Date.now() - date.getTime() <= maxAgeMs &&
          Date.now() >= date.getTime() - 60_000,
        );
      const selectedYesNo = (): 'YES' | 'NO' | undefined => {
        const no =
          /(^|_)NO($|_)|\bNO\b|\bNG\b/.test(label) && !/NO_GOAL/.test(key);
        const yes = /(^|_)YES($|_)|\bYES\b|\bGG\b/.test(label);
        return no ? 'NO' : yes ? 'YES' : undefined;
      };
      const firstHalfReady = Boolean(
        facts.firstHalfComplete &&
        firstHome !== undefined &&
        firstAway !== undefined &&
        isFresh(
          facts.fixtureSourceCollectedAt,
          settlementEvidenceConfig.inPlayFixtureFreshnessMs,
        ),
      );
      const liveScoreReady =
        scoreAvailable &&
        isFresh(
          facts.fixtureSourceCollectedAt,
          settlementEvidenceConfig.inPlayFixtureFreshnessMs,
        );
      const secondHalfScoreReady =
        facts.periodScoresAvailable &&
        secondHome !== undefined &&
        secondAway !== undefined &&
        isFresh(
          facts.fixtureSourceCollectedAt,
          settlementEvidenceConfig.inPlayFixtureFreshnessMs,
        );
      const observedGoals = facts.afterExtraTime
        ? facts.goals.filter(
            (goal) => goal.minute !== undefined && goal.minute <= 90.99,
          )
        : facts.goals;
      const observedCards = facts.afterExtraTime
        ? facts.cards.filter(
            (card) => card.minute !== undefined && card.minute <= 90.99,
          )
        : facts.cards;
      const timelineReady = isFresh(
        facts.timelineCollectedAt,
        settlementEvidenceConfig.inPlayTimelineFreshnessMs,
      );
      const observedGoalTotal = liveScoreReady ? fullTotal! : undefined;
      const selectedSide = side;

      // First-half markets become final as soon as Sports confirms the first
      // half has ended; they do not wait for the full match to finish.
      if (
        market === 'HALF_TIME_RESULT' ||
        market === 'FIRST_HALF_DOUBLE_CHANCE' ||
        market === 'FIRST_HALF_DRAW_NO_BET'
      ) {
        if (!firstHalfReady)
          return unresolved(
            'The first-half period is not yet closed with fresh normalized Sports scores.',
          );
        const mode =
          market === 'HALF_TIME_RESULT'
            ? 'HALF_TIME_RESULT'
            : market === 'FIRST_HALF_DOUBLE_CHANCE'
              ? 'FIRST_HALF_DOUBLE_CHANCE'
              : 'FIRST_HALF_DRAW_NO_BET';
        return compareResultSelection(firstHome, firstAway, mode, 'HALF_TIME');
      }
      if (market === 'FIRST_HALF_GOALS_OVER_UNDER') {
        if (!firstHalfReady)
          return unresolved(
            'First-half goals cannot be settled until the half is complete.',
          );
        if (line === undefined)
          return unresolved('The selected first-half goals line is missing.');
        return this.overUnder(
          firstHome! + firstAway!,
          line,
          this.isOverSelection(key, label),
          'FIRST_HALF_GOALS_PERIOD_SCORE',
          'HALF_TIME',
        );
      }
      if (market === 'BOTH_TEAMS_TO_SCORE_FIRST_HALF') {
        if (!firstHalfReady)
          return unresolved(
            'First-half BTTS requires a confirmed completed first half.',
          );
        return yesNo(
          firstHome! > 0 && firstAway! > 0,
          'FIRST_HALF_BTTS_PERIOD_SCORE',
          'First-half score is unavailable.',
          'HALF_TIME',
        );
      }
      if (market === 'HALF_TIME_GOALS_ODD_EVEN') {
        if (!firstHalfReady)
          return unresolved(
            'Half-time odd/even requires a confirmed completed first half.',
          );
        const evaluation = this.oddEven(
          firstHome! + firstAway!,
          key,
          label,
          market,
        );
        return evaluation.outcome === O.UNRESOLVED
          ? evaluation
          : { ...evaluation, phase: 'HALF_TIME' };
      }
      if (market === 'HALF_TIME_CORRECT_SCORE') {
        if (!firstHalfReady)
          return unresolved(
            'Half-time correct score requires a confirmed completed first half.',
          );
        const expected = this.readCorrectScore(selection);
        if (!expected)
          return unresolved(
            'Half-time correct-score selection could not be parsed.',
          );
        return boolOutcome(
          firstHome === expected.home && firstAway === expected.away,
          'HALF_TIME_CORRECT_SCORE',
          {
            actualHome: firstHome,
            actualAway: firstAway,
            expectedHome: expected.home,
            expectedAway: expected.away,
          },
          'HALF_TIME',
        );
      }
      if (
        market === 'GOAL_IN_BOTH_HALVES' ||
        market === 'HOME_TEAM_TO_SCORE_IN_BOTH_HALVES' ||
        market === 'AWAY_TEAM_TO_SCORE_IN_BOTH_HALVES'
      ) {
        if (!firstHalfReady)
          return unresolved(
            'Both-halves markets require a completed first half.',
          );
        const firstTotal = firstHome! + firstAway!;
        const selectedFirstGoals =
          market === 'HOME_TEAM_TO_SCORE_IN_BOTH_HALVES'
            ? firstHome
            : market === 'AWAY_TEAM_TO_SCORE_IN_BOTH_HALVES'
              ? firstAway
              : firstTotal;
        const selectedYes = selectedYesNo();
        if (!selectedYes)
          return unresolved(
            'Both-halves selection could not be identified as Yes or No.',
          );
        if (selectedFirstGoals === 0 && selectedYes === 'NO') {
          return boolOutcome(
            true,
            `${market}_FIRST_HALF_NEGATIVE_PROOF`,
            { firstHalfGoals: selectedFirstGoals },
            'HALF_TIME',
          );
        }
        if (selectedFirstGoals === 0 && selectedYes === 'YES') {
          // Second half cannot repair a zero-goal first half.
          return boolOutcome(
            false,
            `${market}_FIRST_HALF_NEGATIVE_PROOF`,
            { firstHalfGoals: selectedFirstGoals },
            'HALF_TIME',
          );
        }
        if (
          facts.secondHalfHomeGoals !== undefined &&
          facts.secondHalfAwayGoals !== undefined
        ) {
          const secondTotal =
            facts.secondHalfHomeGoals + facts.secondHalfAwayGoals;
          const secondSelected =
            market === 'HOME_TEAM_TO_SCORE_IN_BOTH_HALVES'
              ? facts.secondHalfHomeGoals
              : market === 'AWAY_TEAM_TO_SCORE_IN_BOTH_HALVES'
                ? facts.secondHalfAwayGoals
                : secondTotal;
          if (secondSelected > 0 && selectedYes === 'YES')
            return boolOutcome(
              true,
              `${market}_PERIOD_SCORE_POSITIVE_PROOF`,
              {
                firstHalfGoals: selectedFirstGoals,
                secondHalfGoals: secondSelected,
              },
              phase,
            );
          if (secondSelected > 0 && selectedYes === 'NO')
            return boolOutcome(
              false,
              `${market}_PERIOD_SCORE_POSITIVE_PROOF`,
              {
                firstHalfGoals: selectedFirstGoals,
                secondHalfGoals: secondSelected,
              },
              phase,
            );
        }
        return unresolved(
          'The required second-half scoring condition has not yet been established.',
        );
      }
      if (
        market === 'HOME_WIN_EITHER_HALF' ||
        market === 'AWAY_WIN_EITHER_HALF'
      ) {
        if (!firstHalfReady)
          return unresolved(
            'Win Either Half requires a completed first half before any early outcome can be proven.',
          );
        const selected = market === 'HOME_WIN_EITHER_HALF' ? 'HOME' : 'AWAY';
        const firstResult = resultOf(firstHome, firstAway);
        const wonFirstHalf = firstResult === selected;
        const expected = selectedYesNo();
        if (!expected)
          return unresolved(
            'Win Either Half selection could not be identified as Yes or No.',
          );
        if (wonFirstHalf)
          return boolOutcome(
            expected === 'YES',
            `${market}_FIRST_HALF_POSITIVE_PROOF`,
            { firstHome, firstAway, selected },
            'HALF_TIME',
          );
        return unresolved(
          'The selected team did not win the first half; the second half must finish before No can be settled.',
        );
      }

      // Second-half BTTS is irreversible once both sides have scored in the
      // second-half period. Do not infer No from an incomplete live period.
      if (
        secondHalfScoreReady &&
        market === 'BOTH_TEAMS_TO_SCORE_SECOND_HALF' &&
        secondHome > 0 &&
        secondAway > 0
      ) {
        return yesNo(
          true,
          'BOTH_TEAMS_TO_SCORE_SECOND_HALF_IN_PLAY_POSITIVE_PROOF',
          'Second-half BTTS selection could not be identified as Yes or No.',
          phase,
        );
      }
      // A second-half goal line can be decided before fulltime once its
      // monotonic period-score lower bound has crossed the entire line.
      if (secondHalfScoreReady && market === 'SECOND_HALF_GOALS_OVER_UNDER') {
        if (line === undefined)
          return unresolved('The selected second-half goals line is missing.');
        const secondHalfTotal = secondHome + secondAway;
        const early = this.settleOverUnderLowerBound(
          secondHalfTotal,
          line,
          this.isOverSelection(key, label),
          'SECOND_HALF_GOALS_OVER_UNDER_IN_PLAY_LOWER_BOUND',
          phase,
        );
        if (early) return early;
      }

      // Positive in-play score facts can decide one-sided/event markets. A
      // zero score while play continues is never treated as a final No.
      if (
        liveScoreReady &&
        (market === 'BOTH_TEAMS_TO_SCORE' ||
          market === 'HOME_TEAM_TO_SCORE' ||
          market === 'AWAY_TEAM_TO_SCORE')
      ) {
        const actual =
          market === 'BOTH_TEAMS_TO_SCORE'
            ? fullHome! > 0 && fullAway! > 0
            : market === 'HOME_TEAM_TO_SCORE'
              ? fullHome! > 0
              : fullAway! > 0;
        if (actual)
          return yesNo(
            true,
            `${market}_IN_PLAY_SCORE_POSITIVE_PROOF`,
            'Positive score evidence is unavailable.',
            phase,
          );
      }
      if (
        liveScoreReady &&
        (market === 'CLEAN_SHEET' ||
          market === 'HOME_TEAM_CLEAN_SHEET' ||
          market === 'AWAY_TEAM_CLEAN_SHEET' ||
          market === 'WIN_TO_NIL' ||
          market === 'HOME_TEAM_TO_WIN_TO_NIL' ||
          market === 'AWAY_TEAM_TO_WIN_TO_NIL')
      ) {
        const selected =
          sourceMarket.includes('AWAY') || key.includes('AWAY')
            ? 'AWAY'
            : sourceMarket.includes('HOME') || key.includes('HOME')
              ? 'HOME'
              : selectedSide;
        const opponentGoals =
          selected === 'HOME'
            ? fullAway
            : selected === 'AWAY'
              ? fullHome
              : undefined;
        if (opponentGoals !== undefined && opponentGoals > 0) {
          const expected = selectedYesNo();
          if (expected)
            return boolOutcome(
              expected === 'NO',
              `${market}_CONCEDED_GOAL_PROOF`,
              { selected, opponentGoals },
              phase,
            );
          return boolOutcome(
            false,
            `${market}_CONCEDED_GOAL_PROOF`,
            { selected, opponentGoals },
            phase,
          );
        }
      }
      // Total-goal and team-goal lines are settleable only once the current
      // score has crossed the entire line (both components for quarter lines).
      if (
        liveScoreReady &&
        (market === 'GOALS_OVER_UNDER' ||
          market === 'ASIAN_TOTAL_GOALS' ||
          market === 'HOME_TEAM_GOALS_OVER_UNDER' ||
          market === 'AWAY_TEAM_GOALS_OVER_UNDER')
      ) {
        const actual =
          market === 'HOME_TEAM_GOALS_OVER_UNDER'
            ? fullHome!
            : market === 'AWAY_TEAM_GOALS_OVER_UNDER'
              ? fullAway!
              : observedGoalTotal!;
        if (line === undefined)
          return unresolved('The selected live goals line is missing.');
        const early = this.settleOverUnderLowerBound(
          actual,
          line,
          this.isOverSelection(key, label),
          `${market}_IN_PLAY_LOWER_BOUND`,
          phase,
        );
        if (early) return early;
      }
      if (liveScoreReady && market === 'BOTH_TEAMS_TO_SCORE_AND_TOTAL_GOALS') {
        const expectedBtts = /(^|_)YES(_|$)/.test(key)
          ? true
          : /(^|_)NO(_|$)/.test(key)
            ? false
            : undefined;
        if (expectedBtts === undefined)
          return unresolved(
            'BTTS & Total Goals selection requires a Yes/No outcome.',
          );
        const bothScored = fullHome! > 0 && fullAway! > 0;
        if (bothScored && !expectedBtts) {
          return boolOutcome(
            false,
            'BTTS_TOTAL_IN_PLAY_BOTH_SCORED',
            {
              bothScored,
              expectedBtts,
              home: fullHome,
              away: fullAway,
            },
            phase,
          );
        }
        if (bothScored && expectedBtts && line !== undefined) {
          const totalPart = this.settleOverUnderLowerBound(
            observedGoalTotal!,
            line,
            this.isOverSelection(key, label),
            'BTTS_TOTAL_IN_PLAY_GOAL_LOWER_BOUND',
            phase,
          );
          if (totalPart) {
            return resolved(
              totalPart.outcome,
              'BTTS_TOTAL_IN_PLAY_COMPONENTS_PROVEN',
              {
                bothScored,
                total: observedGoalTotal,
                line,
                totalOutcome: totalPart.outcome,
              },
              phase,
            );
          }
        }
      }
      if (liveScoreReady && market === 'CORRECT_SCORE') {
        const expected = this.readCorrectScore(selection);
        if (
          expected &&
          (fullHome! > expected.home || fullAway! > expected.away)
        ) {
          return boolOutcome(
            false,
            'CORRECT_SCORE_IN_PLAY_IMPOSSIBLE',
            {
              actualHome: fullHome,
              actualAway: fullAway,
              expectedHome: expected.home,
              expectedAway: expected.away,
            },
            phase,
          );
        }
      }
      if (liveScoreReady && market === 'EXACT_TOTAL_GOALS') {
        const exact = this.integerFromKey(key, ['GOALS_']);
        if (
          key.includes('6_PLUS') ||
          key.includes('6_OR_MORE') ||
          /6\s*(?:\+|OR MORE)/i.test(name)
        ) {
          if (fullTotal! >= 6)
            return boolOutcome(
              true,
              'EXACT_TOTAL_GOALS_RANGE_REACHED',
              { actual: fullTotal, selection: '6+' },
              phase,
            );
        } else if (exact !== undefined && fullTotal! > exact) {
          return boolOutcome(
            false,
            'EXACT_TOTAL_GOALS_EXCEEDED',
            { actual: fullTotal, expected: exact },
            phase,
          );
        }
      }
      if (liveScoreReady && market === 'TOTAL_GOALS_RANGE') {
        const range = this.readRange(key, name);
        if (range?.high === undefined && range && fullTotal! >= range.low) {
          return boolOutcome(
            true,
            'TOTAL_GOALS_OPEN_RANGE_REACHED',
            { actual: fullTotal, ...range },
            phase,
          );
        }
        if (range?.high !== undefined && fullTotal! > range.high) {
          return boolOutcome(
            false,
            'TOTAL_GOALS_RANGE_EXCEEDED',
            { actual: fullTotal, ...range },
            phase,
          );
        }
      }

      // First/last-scorer outcomes require a complete timeline; a live partial event feed
      // cannot safely prove which scorer came first. They are evaluated at full time.
      if (
        timelineReady &&
        market === 'OWN_GOAL_SCORED' &&
        observedGoals.some((goal) => goal.ownGoal)
      ) {
        return yesNo(
          true,
          'OWN_GOAL_IN_PLAY_TIMELINE_EVENT',
          'Own-goal selection could not be identified.',
          phase,
        );
      }
      // Penalty counts do not carry reliable regulation/extra-time separation;
      // do not use the aggregate in-play count once extra time has started.
      if (
        timelineReady &&
        !facts.afterExtraTime &&
        market === 'PENALTY_AWARDED' &&
        (facts.penaltiesAwarded ?? 0) > 0
      ) {
        return yesNo(
          true,
          'PENALTY_AWARDED_IN_PLAY_TIMELINE_EVENT',
          'Penalty selection could not be identified.',
          phase,
        );
      }
      if (
        timelineReady &&
        market === 'RED_CARD' &&
        observedCards.some((card) => card.red)
      ) {
        return yesNo(
          true,
          'RED_CARD_IN_PLAY_TIMELINE_EVENT',
          'Red-card selection could not be identified.',
          phase,
        );
      }

      // Player/event markets may win as soon as the selected player's event is
      // positively recorded. No player/event absence is settled before fulltime.
      if (market.startsWith('PLAYER_') && timelineReady) {
        const athleteId =
          str(selection.subjectId) || this.playerIdFrom(key, name);
        if (!athleteId)
          return unresolved(
            'Player selection is missing its canonical Sports athlete ID.',
          );
        const scorerEvents = observedGoals.filter(
          (goal) => !goal.ownGoal && goal.playerIds.includes(athleteId),
        );
        if (market === 'PLAYER_ANYTIME_GOALSCORER' && scorerEvents.length > 0) {
          return boolOutcome(
            true,
            'PLAYER_ANYTIME_GOALSCORER_IN_PLAY_GOAL_EVENT',
            { athleteId, eventKeys: scorerEvents.map((goal) => goal.eventKey) },
            phase,
          );
        }
        if (
          market === 'PLAYER_TO_SCORE_TWO_OR_MORE' &&
          scorerEvents.length >= 2
        ) {
          return boolOutcome(
            true,
            'PLAYER_TO_SCORE_TWO_OR_MORE_IN_PLAY_GOAL_EVENTS',
            { athleteId, count: scorerEvents.length },
            phase,
          );
        }
        if (
          market === 'PLAYER_TO_ASSIST' &&
          (facts.playerStats[athleteId]?.assists ?? 0) > 0
        ) {
          return boolOutcome(
            true,
            'PLAYER_TO_ASSIST_IN_PLAY_TIMELINE_EVENT',
            { athleteId, assists: facts.playerStats[athleteId].assists },
            phase,
          );
        }
        if (
          (market === 'PLAYER_TO_BE_BOOKED' ||
            market === 'PLAYER_TO_BE_SENT_OFF') &&
          observedCards.some(
            (card) =>
              card.playerIds.includes(athleteId) &&
              (market === 'PLAYER_TO_BE_SENT_OFF'
                ? card.red
                : card.yellow || card.red),
          )
        ) {
          return boolOutcome(
            true,
            `${market}_IN_PLAY_TIMELINE_EVENT`,
            { athleteId },
            phase,
          );
        }
      }

      // Live count statistics are monotonic. Settle only when the observed
      // lower bound has crossed the complete whole/quarter-line boundary.
      const statisticMarket = new Set([
        'TOTAL_CORNERS_OVER_UNDER',
        'HOME_TEAM_CORNERS_OVER_UNDER',
        'AWAY_TEAM_CORNERS_OVER_UNDER',
        'TOTAL_SHOTS_OVER_UNDER',
        'TOTAL_SHOTS_ON_TARGET_OVER_UNDER',
        'HOME_SHOTS_ON_TARGET_OVER_UNDER',
        'AWAY_SHOTS_ON_TARGET_OVER_UNDER',
        'TOTAL_FOULS_OVER_UNDER',
        'TOTAL_OFFSIDES_OVER_UNDER',
      ]).has(market);
      if (statisticMarket) {
        if (
          ![
            facts.homeStatisticsCollectedAt as unknown as Date | undefined,
            facts.awayStatisticsCollectedAt as unknown as Date | undefined,
          ].every((date) =>
            isFresh(date, settlementEvidenceConfig.inPlayStatisticsFreshnessMs),
          )
        )
          return unresolved(
            'Fresh normalized Sports statistics are required for both teams before in-play count-market settlement.',
          );
        const canonicalStat = market.includes('CORNER')
          ? 'corners'
          : market.includes('YELLOW')
            ? 'yellowcards'
            : market.includes('RED')
              ? 'redcards'
              : market.includes('CARD')
                ? 'cards'
                : market.includes('SHOTS_ON_TARGET')
                  ? 'shotsontarget'
                  : market.includes('SHOTS')
                    ? 'shots'
                    : market.includes('FOUL')
                      ? 'fouls'
                      : 'offsides';
        if (
          this.hasStatConflict(facts, [
            `home:${canonicalStat}`,
            `away:${canonicalStat}`,
          ])
        )
          return unresolved(
            'Conflicting in-play Sports statistics prevent a safe count-market decision.',
          );
        const home = this.stat(facts.homeStats, [canonicalStat]);
        const away = this.stat(facts.awayStats, [canonicalStat]);
        if (home === undefined || away === undefined)
          return unresolved(
            `Both team ${canonicalStat} counts are required for an in-play market decision.`,
          );
        const actual = market.startsWith('HOME_')
          ? home
          : market.startsWith('AWAY_')
            ? away
            : home + away;
        if (line === undefined)
          return unresolved('The selected statistical line is missing.');
        const early = this.settleOverUnderLowerBound(
          actual,
          line,
          this.isOverSelection(key, label),
          `${market}_IN_PLAY_STATISTIC_LOWER_BOUND`,
          phase,
        );
        if (early) return early;
      }

      return unresolved(
        'This market is not yet mathematically decided. It will be re-evaluated when Sports publishes another fixture, timeline or statistics update.',
      );
    }

    // Result and period-result markets.
    if (market === 'MATCH_RESULT')
      return compareResultSelection(fullHome, fullAway, market);
    if (market === 'DOUBLE_CHANCE')
      return compareResultSelection(fullHome, fullAway, market);
    if (market === 'DRAW_NO_BET')
      return compareResultSelection(fullHome, fullAway, market);
    if (market === 'HALF_TIME_RESULT')
      return compareResultSelection(firstHome, firstAway, market);
    if (market === 'FIRST_HALF_DOUBLE_CHANCE')
      return compareResultSelection(firstHome, firstAway, market);
    if (market === 'FIRST_HALF_DRAW_NO_BET')
      return compareResultSelection(firstHome, firstAway, market);
    if (market === 'SECOND_HALF_RESULT')
      return compareResultSelection(secondHome, secondAway, market);

    if (market === 'HALF_TIME_FULL_TIME') {
      const ht = resultOf(firstHome, firstAway);
      const ft = resultOf(fullHome, fullAway);
      if (!ht || !ft)
        return unresolved(
          'Half-Time / Full-Time requires both half-time and full-time scores.',
        );
      const parts = key.split('_');
      const expectedHt = this.resultToken(parts[0]);
      const expectedFt = this.resultToken(parts[1]);
      if (!expectedHt || !expectedFt)
        return unresolved(
          'HT/FT selection does not follow a recognized 1/X/2 mapping.',
        );
      return boolOutcome(
        ht === expectedHt && ft === expectedFt,
        'HALF_TIME_FULL_TIME_SCORE',
        { ht, ft, expectedHt, expectedFt },
      );
    }

    // Main goal outcomes.
    if (
      market === 'BOTH_TEAMS_TO_SCORE' ||
      market === 'BOTH_TEAMS_TO_SCORE_FIRST_HALF' ||
      market === 'BOTH_TEAMS_TO_SCORE_SECOND_HALF'
    ) {
      const h =
        market === 'BOTH_TEAMS_TO_SCORE'
          ? fullHome
          : market === 'BOTH_TEAMS_TO_SCORE_FIRST_HALF'
            ? firstHome
            : secondHome;
      const a =
        market === 'BOTH_TEAMS_TO_SCORE'
          ? fullAway
          : market === 'BOTH_TEAMS_TO_SCORE_FIRST_HALF'
            ? firstAway
            : secondAway;
      if (h === undefined || a === undefined)
        return unresolved(
          'Both Teams to Score requires scores for the relevant match period.',
        );
      return yesNo(
        h > 0 && a > 0,
        `${market}_SCORE`,
        'Both Teams to Score cannot be settled without both relevant scores.',
      );
    }
    if (market === 'HALF_TIME_GOALS_ODD_EVEN') {
      if (firstHome === undefined || firstAway === undefined)
        return unresolved(
          'Half-Time Goals Odd/Even requires both half-time scores.',
        );
      return this.oddEven(
        firstHome + firstAway,
        key,
        label,
        'HALF_TIME_GOALS_ODD_EVEN',
      );
    }
    if (
      market === 'GOALS_OVER_UNDER' ||
      market === 'ASIAN_TOTAL_GOALS' ||
      market === 'EXACT_TOTAL_GOALS' ||
      market === 'TOTAL_GOALS_RANGE' ||
      market === 'ODD_EVEN_TOTAL_GOALS'
    ) {
      if (fullTotal === undefined)
        return unresolved(
          'Final score is required for total-goals settlement.',
        );
      if (market === 'GOALS_OVER_UNDER' || market === 'ASIAN_TOTAL_GOALS') {
        if (line === undefined)
          return unresolved('The selected goals line is missing.');
        return this.overUnder(
          fullTotal,
          line,
          this.isOverSelection(key, label),
          `${market}_FINAL_GOALS`,
        );
      }
      if (market === 'EXACT_TOTAL_GOALS') {
        const exact = this.integerFromKey(key, ['GOALS_']);
        if (
          key.includes('6_PLUS') ||
          key.includes('6_OR_MORE') ||
          /6\s*(?:\+|OR MORE)/i.test(name)
        )
          return boolOutcome(fullTotal >= 6, 'EXACT_TOTAL_GOALS_RANGE', {
            actual: fullTotal,
            selection: '6+',
          });
        if (exact === undefined)
          return unresolved('Exact total-goals selection could not be parsed.');
        return boolOutcome(fullTotal === exact, 'EXACT_TOTAL_GOALS', {
          actual: fullTotal,
          expected: exact,
        });
      }
      if (market === 'TOTAL_GOALS_RANGE') {
        const range = this.readRange(key, name);
        if (!range) return unresolved('Total-goals range could not be parsed.');
        return boolOutcome(
          fullTotal >= range.low &&
            (range.high === undefined || fullTotal <= range.high),
          'TOTAL_GOALS_RANGE',
          { actual: fullTotal, ...range },
        );
      }
      return this.oddEven(fullTotal, key, label, 'TOTAL_GOALS_ODD_EVEN');
    }
    if (
      market === 'HOME_TEAM_GOALS_OVER_UNDER' ||
      market === 'AWAY_TEAM_GOALS_OVER_UNDER' ||
      market === 'FIRST_HALF_GOALS_OVER_UNDER' ||
      market === 'SECOND_HALF_GOALS_OVER_UNDER'
    ) {
      const actual =
        market === 'HOME_TEAM_GOALS_OVER_UNDER'
          ? fullHome
          : market === 'AWAY_TEAM_GOALS_OVER_UNDER'
            ? fullAway
            : market === 'FIRST_HALF_GOALS_OVER_UNDER'
              ? firstHome !== undefined && firstAway !== undefined
                ? firstHome + firstAway
                : undefined
              : secondHome !== undefined && secondAway !== undefined
                ? secondHome + secondAway
                : undefined;
      if (actual === undefined)
        return unresolved(
          'The required team or period goal total is unavailable.',
        );
      if (line === undefined)
        return unresolved('The selected goal line is missing.');
      return this.overUnder(
        actual,
        line,
        this.isOverSelection(key, label),
        `${market}_SCORE`,
      );
    }
    if (market === 'HOME_TEAM_TO_SCORE' || market === 'AWAY_TEAM_TO_SCORE') {
      const actualGoals = market === 'HOME_TEAM_TO_SCORE' ? fullHome : fullAway;
      if (actualGoals === undefined)
        return unresolved('Final team score is unavailable.');
      return yesNo(
        actualGoals > 0,
        `${market}_SCORE`,
        'Final team score is unavailable.',
      );
    }
    if (
      market === 'WIN_TO_NIL' ||
      market === 'HOME_TEAM_TO_WIN_TO_NIL' ||
      market === 'AWAY_TEAM_TO_WIN_TO_NIL'
    ) {
      if (!scoreAvailable)
        return unresolved('Final score is required for Win to Nil.');
      const selected =
        sourceMarket.includes('AWAY_TEAM_TO_WIN_TO_NIL') ||
        sourceMarket === 'AWAY_TEAM_TO_WIN_TO_NIL' ||
        key.includes('AWAY')
          ? 'AWAY'
          : sourceMarket.includes('HOME_TEAM_TO_WIN_TO_NIL') ||
              sourceMarket === 'HOME_TEAM_TO_WIN_TO_NIL' ||
              key.includes('HOME')
            ? 'HOME'
            : side;
      if (selected !== 'HOME' && selected !== 'AWAY')
        return unresolved('Win to Nil team could not be mapped.');
      const actual =
        selected === 'HOME'
          ? fullHome! > fullAway! && fullAway === 0
          : fullAway! > fullHome! && fullHome === 0;
      const hasYesNoSelection =
        /(^|_)YES($|_)|(^|_)NO($|_)/.test(key) ||
        /\bYES\b|\bNO\b/.test(name.toUpperCase());
      return hasYesNoSelection
        ? yesNo(
            actual,
            'WIN_TO_NIL_FINAL_SCORE',
            'Win to Nil selection is not Yes/No.',
          )
        : boolOutcome(actual, 'WIN_TO_NIL_FINAL_SCORE', {
            home: fullHome,
            away: fullAway,
            selected,
          });
    }
    if (
      market === 'CLEAN_SHEET' ||
      market === 'HOME_TEAM_CLEAN_SHEET' ||
      market === 'AWAY_TEAM_CLEAN_SHEET'
    ) {
      if (!scoreAvailable)
        return unresolved('Final score is required for Clean Sheet.');
      const selected =
        sourceMarket.includes('AWAY_TEAM_CLEAN_SHEET') ||
        sourceMarket === 'AWAY_TEAM_CLEAN_SHEET' ||
        key.includes('AWAY')
          ? 'AWAY'
          : sourceMarket.includes('HOME_TEAM_CLEAN_SHEET') ||
              sourceMarket === 'HOME_TEAM_CLEAN_SHEET' ||
              key.includes('HOME')
            ? 'HOME'
            : side;
      if (selected !== 'HOME' && selected !== 'AWAY')
        return unresolved('Clean Sheet team could not be mapped.');
      const actual = selected === 'HOME' ? fullAway === 0 : fullHome === 0;
      const hasYesNoSelection =
        /(^|_)YES($|_)|(^|_)NO($|_)/.test(key) ||
        /\bYES\b|\bNO\b/.test(name.toUpperCase());
      return hasYesNoSelection
        ? yesNo(
            actual,
            'CLEAN_SHEET_FINAL_SCORE',
            'Clean Sheet selection is not Yes/No.',
          )
        : boolOutcome(actual, 'CLEAN_SHEET_FINAL_SCORE', {
            home: fullHome,
            away: fullAway,
            selected,
          });
    }
    if (
      market === 'GOAL_IN_BOTH_HALVES' ||
      market === 'HOME_TEAM_TO_SCORE_IN_BOTH_HALVES' ||
      market === 'AWAY_TEAM_TO_SCORE_IN_BOTH_HALVES'
    ) {
      if (!facts.periodScoresAvailable)
        return unresolved(
          'Both-halves markets require scores split into the two regulation halves.',
        );
      const firstTotal = (firstHome ?? 0) + (firstAway ?? 0);
      const secondTotal = (secondHome ?? 0) + (secondAway ?? 0);
      const actual =
        market === 'GOAL_IN_BOTH_HALVES'
          ? firstTotal > 0 && secondTotal > 0
          : market === 'HOME_TEAM_TO_SCORE_IN_BOTH_HALVES'
            ? (firstHome ?? 0) > 0 && (secondHome ?? 0) > 0
            : (firstAway ?? 0) > 0 && (secondAway ?? 0) > 0;
      return yesNo(
        actual,
        `${market}_PERIOD_SCORES`,
        'Both-halves market requires period score evidence.',
      );
    }
    if (
      market === 'HOME_WIN_EITHER_HALF' ||
      market === 'AWAY_WIN_EITHER_HALF'
    ) {
      if (!facts.periodScoresAvailable)
        return unresolved(
          'Win Either Half requires scores split into the two regulation halves.',
        );
      const selected = market === 'HOME_WIN_EITHER_HALF' ? 'HOME' : 'AWAY';
      const firstWinner = resultOf(firstHome, firstAway);
      const secondWinner = resultOf(secondHome, secondAway);
      const actual =
        selected === 'HOME'
          ? firstWinner === 'HOME' || secondWinner === 'HOME'
          : firstWinner === 'AWAY' || secondWinner === 'AWAY';
      return yesNo(
        actual,
        `${market}_PERIOD_RESULTS`,
        'Period outcomes could not be established.',
      );
    }
    if (market === 'MOST_GOALS_HALF') {
      if (!facts.periodScoresAvailable)
        return unresolved(
          'Highest-scoring-half market requires both half goal totals.',
        );
      const firstTotal = (firstHome ?? 0) + (firstAway ?? 0);
      const secondTotal = (secondHome ?? 0) + (secondAway ?? 0);
      const expected =
        key.includes('FIRST_HALF') || key === '1H'
          ? 'FIRST_HALF'
          : key.includes('SECOND_HALF') || key === '2H'
            ? 'SECOND_HALF'
            : key.includes('EQUAL') || key.includes('DRAW')
              ? 'EQUAL'
              : undefined;
      if (!expected)
        return unresolved(
          'Highest-scoring-half selection could not be identified.',
        );
      const actual =
        firstTotal > secondTotal
          ? 'FIRST_HALF'
          : secondTotal > firstTotal
            ? 'SECOND_HALF'
            : 'EQUAL';
      return boolOutcome(actual === expected, 'MOST_GOALS_HALF_PERIOD_SCORE', {
        actual,
        expected,
        firstTotal,
        secondTotal,
      });
    }

    if (market === 'ASIAN_HANDICAP') {
      if (!scoreAvailable)
        return unresolved('Final score is required for Asian Handicap.');
      const handicap = this.readHandicap(selection);
      if (handicap === undefined || !side)
        return unresolved(
          'Asian Handicap requires a selected team and signed handicap line.',
        );
      const selectedScore = side === 'HOME' ? fullHome! : fullAway!;
      const opposingScore = side === 'HOME' ? fullAway! : fullHome!;
      return this.handicapOutcome(
        selectedScore - opposingScore,
        handicap,
        `${market}_FINAL_SCORE`,
        { side, handicap, home: fullHome, away: fullAway },
      );
    }
    if (
      market === 'EUROPEAN_HANDICAP' ||
      market === 'HALF_TIME_EUROPEAN_HANDICAP'
    ) {
      const h = market === 'EUROPEAN_HANDICAP' ? fullHome : firstHome;
      const a = market === 'EUROPEAN_HANDICAP' ? fullAway : firstAway;
      if (h === undefined || a === undefined)
        return unresolved('European Handicap requires the relevant score.');
      const handicap = this.readHandicap(selection);
      if (handicap === undefined)
        return unresolved('European Handicap line is missing.');
      const result = resultOf(h + handicap, a);
      if (!result)
        return unresolved('European Handicap result is unavailable.');
      const expected = this.resultSelection(key, label);
      return expected
        ? boolOutcome(result === expected, `${market}_ADJUSTED_SCORE`, {
            home: h,
            away: a,
            handicap,
            result,
            expected,
          })
        : unresolved('European Handicap outcome could not be identified.');
    }

    if (market === 'CORRECT_SCORE' || market === 'HALF_TIME_CORRECT_SCORE') {
      const h = market === 'CORRECT_SCORE' ? fullHome : firstHome;
      const a = market === 'CORRECT_SCORE' ? fullAway : firstAway;
      if (h === undefined || a === undefined)
        return unresolved(
          'Correct Score requires the final or half-time score.',
        );
      if (key.startsWith('ANY_OTHER_')) {
        const expectedResult = key.includes('HOME')
          ? 'HOME'
          : key.includes('DRAW')
            ? 'DRAW'
            : key.includes('AWAY')
              ? 'AWAY'
              : undefined;
        if (!expectedResult)
          return unresolved(
            'Any Other Correct Score selection could not be mapped.',
          );
        const max = market === 'CORRECT_SCORE' ? 5 : 3;
        const anyOther = h > max || a > max;
        return boolOutcome(
          anyOther && resultOf(h, a) === expectedResult,
          `${market}_ANY_OTHER_SCORE`,
          { home: h, away: a, max, expectedResult },
        );
      }
      const score = this.readCorrectScore(selection);
      if (!score)
        return unresolved('Correct Score selection could not be parsed.');
      return boolOutcome(
        h === score.home && a === score.away,
        `${market}_EXACT_SCORE`,
        {
          actualHome: h,
          actualAway: a,
          expectedHome: score.home,
          expectedAway: score.away,
        },
      );
    }

    if (market === 'WIN_MARGIN') {
      if (!scoreAvailable)
        return unresolved('Winning Margin requires the final score.');
      const difference = fullHome! - fullAway!;
      let actual: string;
      if (difference === 0) actual = 'DRAW';
      else if (difference > 0)
        actual =
          difference === 1
            ? 'HOME_BY_1'
            : difference === 2
              ? 'HOME_BY_2'
              : 'HOME_BY_3_PLUS';
      else
        actual =
          difference === -1
            ? 'AWAY_BY_1'
            : difference === -2
              ? 'AWAY_BY_2'
              : 'AWAY_BY_3_PLUS';
      const expected = this.normalizedMarginSelection(key, label);
      if (!expected)
        return unresolved('Winning Margin selection could not be identified.');
      // Prediction engine uses a 2+ bucket in some versions; Bet Lab uses 2 and 3+ buckets.
      const matches =
        expected === 'HOME_BY_2_PLUS'
          ? difference >= 2
          : expected === 'AWAY_BY_2_PLUS'
            ? difference <= -2
            : actual === expected;
      return boolOutcome(matches, 'WIN_MARGIN_FINAL_SCORE', {
        difference,
        actual,
        expected,
      });
    }

    if (market === 'BOTH_TEAMS_TO_SCORE_AND_RESULT') {
      if (!scoreAvailable)
        return unresolved('BTTS and Result requires the final score.');
      const btts = fullHome! > 0 && fullAway! > 0;
      const result = resultOf(fullHome, fullAway);
      const expectedResult =
        /(?:^|_)HOME(?:_|$)|HOME_WIN|\bHOME WIN\b|\b1\b/.test(key + ' ' + label)
          ? 'HOME'
          : /(?:^|_)DRAW(?:_|$)|\bDRAW\b|\bX\b/.test(key + ' ' + label)
            ? 'DRAW'
            : /(?:^|_)AWAY(?:_|$)|AWAY_WIN|\bAWAY WIN\b|\b2\b/.test(
                  key + ' ' + label,
                )
              ? 'AWAY'
              : undefined;
      const expectedBtts =
        key.endsWith('_YES') ||
        key.includes('_YES_') ||
        /BTTS\s*YES/i.test(name)
          ? true
          : key.endsWith('_NO') ||
              key.includes('_NO_') ||
              /BTTS\s*NO/i.test(name)
            ? false
            : undefined;
      if (!expectedResult || expectedBtts === undefined)
        return unresolved('BTTS & Result selection is not recognized.');
      return boolOutcome(
        result === expectedResult && btts === expectedBtts,
        'BTTS_AND_RESULT_FINAL_SCORE',
        { result, btts, expectedResult, expectedBtts },
      );
    }
    if (market === 'BOTH_TEAMS_TO_SCORE_AND_TOTAL_GOALS') {
      if (fullTotal === undefined)
        return unresolved('BTTS & Total Goals requires the final score.');
      const btts = fullHome! > 0 && fullAway! > 0;
      const expectedBtts = /(^|_)YES(_|$)/.test(key)
        ? true
        : /(^|_)NO(_|$)/.test(key)
          ? false
          : undefined;
      if (expectedBtts === undefined || line === undefined)
        return unresolved(
          'BTTS & Total Goals selection requires Yes/No and a goal line.',
        );
      const totalPart = this.overUnder(
        fullTotal,
        line,
        this.isOverSelection(key, label),
        'BTTS_TOTAL_LINE',
      );
      if (totalPart.outcome === O.UNRESOLVED) return totalPart;
      if (btts !== expectedBtts) {
        return boolOutcome(false, 'BTTS_AND_TOTAL_GOALS_FINAL_SCORE', {
          btts,
          expectedBtts,
          total: fullTotal,
          line,
          totalOutcome: totalPart.outcome,
        });
      }
      // Preserve the total-goal market's push / Asian quarter-line result when BTTS is correct.
      // A combo selection must not turn a legitimate push or half-win into a full loss.
      return resolved(totalPart.outcome, 'BTTS_AND_TOTAL_GOALS_FINAL_SCORE', {
        btts,
        expectedBtts,
        total: fullTotal,
        line,
        totalOutcome: totalPart.outcome,
      });
    }

    // Scoreless-event markets require either the official final score or complete goal events.
    if (market === 'TEAM_TO_SCORE_FIRST' || market === 'TEAM_TO_SCORE_LAST') {
      if (!scoreAvailable)
        return unresolved('First/Last Team to Score requires final scores.');
      const total = fullHome! + fullAway!;
      const requested =
        key.includes('NO_GOAL') || key.includes('NO_SCORE') || key === 'NG'
          ? 'NO_GOAL'
          : key.includes('HOME') || key === '1'
            ? 'HOME'
            : key.includes('AWAY') || key === '2'
              ? 'AWAY'
              : undefined;
      if (!requested)
        return unresolved(
          'First/Last Team to Score selection could not be identified.',
        );
      if (total === 0)
        return boolOutcome(
          requested === 'NO_GOAL',
          `${market}_SCORELESS_MATCH`,
          { requested },
        );
      if (
        !facts.goalEventsComplete ||
        !facts.goals.length ||
        (facts.afterExtraTime &&
          facts.goals.some((goal) => goal.minute === undefined))
      )
        return unresolved(
          'Final score confirms goals, but complete ordered regulation-time goal events are unavailable.',
        );
      const ordered = [...this.goalsInSettlementPeriod(facts)].sort(
        (a, b) =>
          (a.minute !== undefined && b.minute !== undefined
            ? a.minute - b.minute
            : a.order - b.order) || a.order - b.order,
      );
      const event =
        market === 'TEAM_TO_SCORE_FIRST'
          ? ordered[0]
          : ordered[ordered.length - 1];
      const credited = event.creditedTeamId;
      const actual =
        credited === facts.homeTeamId
          ? 'HOME'
          : credited === facts.awayTeamId
            ? 'AWAY'
            : undefined;
      if (!actual)
        return unresolved(
          'The selected scoring event could not be mapped to a team.',
        );
      return boolOutcome(
        actual === requested,
        `${market}_ORDERED_GOAL_EVENTS`,
        { requested, actual, eventKey: event.eventKey },
      );
    }

    // Corners and cards.
    if (
      market === 'TOTAL_CORNERS_OVER_UNDER' ||
      market === 'HOME_TEAM_CORNERS_OVER_UNDER' ||
      market === 'AWAY_TEAM_CORNERS_OVER_UNDER' ||
      market === 'CORNER_MATCH_RESULT' ||
      market === 'TOTAL_CORNERS_ODD_EVEN'
    ) {
      if (!hasFreshTeamStatistics()) {
        return unresolved(
          'Fresh normalized Sports corner totals for both teams are required before full-time settlement.',
          {
            homeStatisticsCollectedAt: facts.homeStatisticsCollectedAt,
            awayStatisticsCollectedAt: facts.awayStatisticsCollectedAt,
          },
        );
      }
      if (this.hasStatConflict(facts, ['home:corners', 'away:corners'])) {
        return unresolved(
          'Conflicting normalized Sports match data/event snapshots contain different corner totals.',
          {
            conflictingStats: facts.conflictingStats,
          },
        );
      }
      const home = this.stat(facts.homeStats, [
        'corners',
        'wonCorners',
        'cornerKicks',
        'totalCorners',
      ]);
      const away = this.stat(facts.awayStats, [
        'corners',
        'wonCorners',
        'cornerKicks',
        'totalCorners',
      ]);
      if (home === undefined || away === undefined)
        return unresolved(
          'normalized Sports match data does not contain sufficient home and away corner totals.',
        );
      if (market === 'CORNER_MATCH_RESULT')
        return compareResultSelection(home, away, market);
      const total = home + away;
      if (market === 'TOTAL_CORNERS_ODD_EVEN')
        return this.oddEven(total, key, label, market);
      const actual =
        market === 'HOME_TEAM_CORNERS_OVER_UNDER'
          ? home
          : market === 'AWAY_TEAM_CORNERS_OVER_UNDER'
            ? away
            : total;
      if (line === undefined)
        return unresolved('Corner total line is missing.');
      return this.overUnder(
        actual,
        line,
        this.isOverSelection(key, label),
        `${market}_BOX_SCORE`,
      );
    }
    if (
      market === 'TOTAL_CARDS_OVER_UNDER' ||
      market === 'TOTAL_YELLOW_CARDS_OVER_UNDER' ||
      market === 'TOTAL_RED_CARDS_OVER_UNDER' ||
      market === 'HOME_TEAM_CARDS_OVER_UNDER' ||
      market === 'AWAY_TEAM_CARDS_OVER_UNDER' ||
      market === 'TOTAL_CARDS_ODD_EVEN'
    ) {
      if (!hasFreshTeamStatistics()) {
        return unresolved(
          'Fresh normalized Sports card totals for both teams are required before full-time settlement.',
          {
            homeStatisticsCollectedAt: facts.homeStatisticsCollectedAt,
            awayStatisticsCollectedAt: facts.awayStatisticsCollectedAt,
          },
        );
      }
      if (
        this.hasStatConflict(facts, [
          'home:yellowcards',
          'away:yellowcards',
          'home:redcards',
          'away:redcards',
        ])
      ) {
        return unresolved(
          'Conflicting normalized Sports match data/event snapshots contain different card totals.',
          {
            conflictingStats: facts.conflictingStats,
          },
        );
      }
      const homeYellow = this.stat(facts.homeStats, ['yellowcards']);
      const awayYellow = this.stat(facts.awayStats, ['yellowcards']);
      const homeRed = this.stat(facts.homeStats, ['redcards']);
      const awayRed = this.stat(facts.awayStats, ['redcards']);

      let actual: number | undefined;
      let exact = false;
      if (!facts.afterExtraTime && market === 'TOTAL_YELLOW_CARDS_OVER_UNDER') {
        if (homeYellow !== undefined && awayYellow !== undefined) {
          actual = homeYellow + awayYellow;
          exact = true;
        }
      } else if (
        !facts.afterExtraTime &&
        market === 'TOTAL_RED_CARDS_OVER_UNDER'
      ) {
        if (homeRed !== undefined && awayRed !== undefined) {
          actual = homeRed + awayRed;
          exact = true;
        }
      } else if (
        !facts.afterExtraTime &&
        market === 'HOME_TEAM_CARDS_OVER_UNDER'
      ) {
        if (homeYellow !== undefined && homeRed !== undefined) {
          actual = homeYellow + homeRed;
          exact = true;
        }
      } else if (
        !facts.afterExtraTime &&
        market === 'AWAY_TEAM_CARDS_OVER_UNDER'
      ) {
        if (awayYellow !== undefined && awayRed !== undefined) {
          actual = awayYellow + awayRed;
          exact = true;
        }
      } else if (
        !facts.afterExtraTime &&
        homeYellow !== undefined &&
        awayYellow !== undefined &&
        homeRed !== undefined &&
        awayRed !== undefined
      ) {
        actual = homeYellow + awayYellow + homeRed + awayRed;
        exact = true;
      }

      if (market === 'TOTAL_CARDS_ODD_EVEN') {
        if (actual === undefined || !exact) {
          return unresolved(
            'Odd/even cards requires authoritative yellow and red card totals for both teams.',
          );
        }
        return this.oddEven(actual, key, label, market);
      }

      if (line === undefined) return unresolved('Card total line is missing.');
      const over = this.isOverSelection(key, label);
      if (over === undefined)
        return unresolved('Over/Under card selection could not be identified.');
      if (exact && actual !== undefined) {
        return this.overUnder(actual, line, over, `${market}_TEAM_STATISTICS`);
      }

      // Card event streams are not guaranteed to contain every event. They can
      // prove an outcome only when the observed lower bound already crosses the
      // line; they cannot turn an absent event into a fabricated zero count.
      const observedCards = facts.cards.filter((card) => {
        if (
          facts.afterExtraTime &&
          (card.minute === undefined || card.minute > 90.99)
        )
          return false;
        if (market === 'TOTAL_YELLOW_CARDS_OVER_UNDER') return card.yellow;
        if (market === 'TOTAL_RED_CARDS_OVER_UNDER') return card.red;
        if (market === 'HOME_TEAM_CARDS_OVER_UNDER')
          return card.teamId === facts.homeTeamId;
        if (market === 'AWAY_TEAM_CARDS_OVER_UNDER')
          return card.teamId === facts.awayTeamId;
        return true;
      });
      const observedCount = observedCards.length;
      // For quarter-lines the outcome can be HALF_WON/HALF_LOST at the upper
      // adjacent half-line. A lower-bound count equal to that boundary cannot
      // establish the final outcome because unobserved events may change it.
      // Settle only when the observed count is beyond the entire split-line
      // boundary, which proves the same full outcome for every possible total.
      const isQuarterLine = Math.abs(line * 2 - Math.round(line * 2)) > 1e-7;
      const provenBoundary = isQuarterLine
        ? Math.floor(line * 2) / 2 + 0.5
        : line;
      if (observedCount > provenBoundary) {
        return boolOutcome(over, `${market}_OBSERVED_EVENT_LOWER_BOUND`, {
          observedCount,
          line,
          provenBoundary,
          over,
          evidenceComplete: false,
        });
      }
      return unresolved(
        'Complete card totals are unavailable; the observed event list alone cannot establish the final total.',
        { observedCount, line, over, evidenceComplete: false },
      );
    }

    if (
      market === 'TOTAL_SHOTS_OVER_UNDER' ||
      market === 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER' ||
      market === 'HOME_SHOTS_ON_TARGET_OVER_UNDER' ||
      market === 'AWAY_SHOTS_ON_TARGET_OVER_UNDER' ||
      market === 'TOTAL_OFFSIDES_OVER_UNDER' ||
      market === 'TOTAL_FOULS_OVER_UNDER' ||
      market === 'POSSESSION_OVER_UNDER'
    ) {
      if (!hasFreshTeamStatistics()) {
        return unresolved(
          'Fresh normalized Sports statistics for both teams are required before full-time settlement.',
          {
            homeStatisticsCollectedAt: facts.homeStatisticsCollectedAt,
            awayStatisticsCollectedAt: facts.awayStatisticsCollectedAt,
          },
        );
      }
      const relevantStatistic =
        market === 'TOTAL_SHOTS_OVER_UNDER'
          ? 'shots'
          : market === 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER'
            ? 'shotsontarget'
            : market === 'TOTAL_OFFSIDES_OVER_UNDER'
              ? 'offsides'
              : market === 'TOTAL_FOULS_OVER_UNDER'
                ? 'fouls'
                : 'possession';
      if (
        this.hasStatConflict(facts, [
          `home:${relevantStatistic}`,
          `away:${relevantStatistic}`,
        ])
      ) {
        return unresolved(
          `Conflicting normalized Sports match data/event snapshots contain different ${relevantStatistic} values.`,
          {
            conflictingStats: facts.conflictingStats,
          },
        );
      }
      const homeKey =
        market === 'TOTAL_SHOTS_OVER_UNDER'
          ? 'shots'
          : market === 'TOTAL_SHOTS_ON_TARGET_OVER_UNDER' ||
              market === 'HOME_SHOTS_ON_TARGET_OVER_UNDER' ||
              market === 'AWAY_SHOTS_ON_TARGET_OVER_UNDER'
            ? 'shotsontarget'
            : market === 'TOTAL_OFFSIDES_OVER_UNDER'
              ? 'offsides'
              : market === 'TOTAL_FOULS_OVER_UNDER'
                ? 'fouls'
                : 'possession';
      const home = this.stat(facts.homeStats, [homeKey]);
      const away = this.stat(facts.awayStats, [homeKey]);
      if (home === undefined || away === undefined)
        return unresolved(
          `normalized Sports match data does not contain both required ${homeKey} statistics.`,
        );
      const actual =
        market === 'HOME_SHOTS_ON_TARGET_OVER_UNDER'
          ? home
          : market === 'AWAY_SHOTS_ON_TARGET_OVER_UNDER'
            ? away
            : market === 'POSSESSION_OVER_UNDER'
              ? home
              : home + away;
      if (line === undefined)
        return unresolved('The selected statistical line is missing.');
      return this.overUnder(
        actual,
        line,
        this.isOverSelection(key, label),
        `${market}_BOX_SCORE`,
      );
    }

    if (market === 'RED_CARD') {
      const observedRedCards = facts.cards.filter(
        (card) =>
          card.red &&
          (!facts.afterExtraTime ||
            (card.minute !== undefined && card.minute <= 90.99)),
      ).length;
      if (observedRedCards > 0) {
        return yesNo(
          true,
          'RED_CARD_OBSERVED_EVENT',
          'A red-card event was not observed.',
        );
      }
      // Aggregate card totals may include extra time. Without a regulation-time
      // red card, the provider data cannot safely settle a negative selection.
      if (
        !facts.afterExtraTime &&
        facts.redCards !== undefined &&
        hasFreshTeamStatistics()
      ) {
        return yesNo(
          facts.redCards > 0,
          'RED_CARD_TEAM_STATISTICS',
          'Red-card statistics and event details are unavailable.',
        );
      }
      return unresolved(
        'No red card was observed, but complete team red-card totals are unavailable.',
      );
    }
    if (market === 'PENALTY_AWARDED') {
      if (facts.afterExtraTime) {
        return unresolved(
          'Penalty event totals cannot be isolated to regulation time for this extra-time fixture.',
        );
      }
      const count = facts.penaltiesAwarded;
      return yesNo(
        count === undefined ? undefined : count > 0,
        'PENALTY_STATISTICS_OR_EVENTS',
        'Penalty-awarded evidence is unavailable.',
      );
    }
    if (market === 'OWN_GOAL_SCORED') {
      if (
        facts.afterExtraTime &&
        facts.goals.some((goal) => goal.minute === undefined)
      ) {
        return unresolved(
          'Goal event times are incomplete, so regulation-time own-goal settlement is unsafe.',
        );
      }
      const settlementGoals = this.goalsInSettlementPeriod(facts);
      const observedOwnGoals = settlementGoals.filter(
        (goal) => goal.ownGoal,
      ).length;
      if (observedOwnGoals > 0) {
        return yesNo(
          true,
          'OWN_GOAL_OBSERVED_EVENT',
          'Own-goal flags are not available in the stored match details.',
        );
      }
      if (
        facts.goalEventsComplete &&
        (!facts.afterExtraTime ||
          facts.goals.every((goal) => goal.minute !== undefined))
      ) {
        return yesNo(
          false,
          'OWN_GOAL_COMPLETE_GOAL_EVENTS',
          'Own-goal flags are not available in the stored match details.',
        );
      }
      return unresolved(
        'No own goal was observed, but the stored goal events are incomplete.',
      );
    }

    // Player markets: use explicit athlete IDs and exact event/stat evidence.
    if (market.startsWith('PLAYER_')) {
      const athleteId =
        str(selection.subjectId) || this.playerIdFrom(key, name);
      if (!athleteId)
        return unresolved('Player selection is missing an Sports athlete ID.');
      if (market === 'PLAYER_ANYTIME_GOALSCORER') {
        if (
          !facts.goalEventsComplete ||
          (facts.afterExtraTime &&
            facts.goals.some((goal) => goal.minute === undefined))
        )
          return unresolved(
            'Complete goal event data is required to settle an anytime goalscorer.',
          );
        return boolOutcome(
          this.goalsInSettlementPeriod(facts).some(
            (goal) => !goal.ownGoal && goal.playerIds.includes(athleteId),
          ),
          'PLAYER_GOAL_EVENT_ID',
          { athleteId },
        );
      }
      if (
        market === 'PLAYER_FIRST_GOALSCORER' ||
        market === 'PLAYER_LAST_GOALSCORER'
      ) {
        if (
          !facts.goalEventsComplete ||
          (facts.afterExtraTime &&
            facts.goals.some((goal) => goal.minute === undefined))
        )
          return unresolved(
            'Complete ordered goal events are required to settle this player scorer market.',
          );
        const creditedGoals = this.goalsInSettlementPeriod(facts).filter(
          (goal) => !goal.ownGoal,
        );
        if (!creditedGoals.length)
          return unresolved(
            'The match contains no credited player goal (for example, only own goals); the applicable player-scorer void rule cannot be inferred from the fixture feed.',
            { athleteId, totalMatchGoals: facts.goals.length },
          );
        const ordered = [...creditedGoals].sort(
          (a, b) =>
            (a.minute !== undefined && b.minute !== undefined
              ? a.minute - b.minute
              : a.order - b.order) || a.order - b.order,
        );
        const target =
          market === 'PLAYER_FIRST_GOALSCORER'
            ? ordered[0]
            : ordered[ordered.length - 1];
        return boolOutcome(
          target.playerIds.includes(athleteId),
          `${market}_GOAL_EVENT_ID`,
          { athleteId, eventKey: target.eventKey },
        );
      }
      if (market === 'PLAYER_TO_SCORE_TWO_OR_MORE') {
        if (
          !facts.goalEventsComplete ||
          (facts.afterExtraTime &&
            facts.goals.some((goal) => goal.minute === undefined))
        )
          return unresolved(
            "Complete goal events are required to count an individual player's goals.",
          );
        const count = this.goalsInSettlementPeriod(facts).filter(
          (goal) => !goal.ownGoal && goal.playerIds.includes(athleteId),
        ).length;
        return boolOutcome(count >= 2, 'PLAYER_GOAL_EVENT_COUNT', {
          athleteId,
          count,
        });
      }
      if (
        market === 'PLAYER_TO_BE_BOOKED' ||
        market === 'PLAYER_TO_BE_SENT_OFF'
      ) {
        const cards = facts.cards.filter(
          (card) =>
            card.playerIds.includes(athleteId) &&
            (!facts.afterExtraTime ||
              (card.minute !== undefined && card.minute <= 90.99)),
        );
        if (facts.afterExtraTime) {
          const observed = cards.some((card) =>
            market === 'PLAYER_TO_BE_SENT_OFF'
              ? card.red
              : card.yellow || card.red,
          );
          return observed
            ? boolOutcome(true, `${market}_REGULATION_PLAYER_EVENT_ID`, {
                athleteId,
                observedCards: cards.length,
              })
            : unresolved(
                'Regulation-time player card statistics are unavailable for a fixture that went to extra time.',
                { athleteId, observedCards: cards.length },
              );
        }
        const playerStats = facts.playerStats[athleteId] ?? {};
        const playerYellows = this.stat(playerStats, ['yellowcards']);
        const playerReds = this.stat(playerStats, ['redcards']);
        if (market === 'PLAYER_TO_BE_SENT_OFF') {
          // One observed red-card event proves the selection. A missing red-card
          // event does not prove a loss unless Sports supplies the player's count.
          if (cards.some((card) => card.red)) {
            return boolOutcome(true, `${market}_PLAYER_EVENT_ID`, {
              athleteId,
              count: cards.length,
              evidenceComplete: false,
            });
          }
          if (playerReds !== undefined) {
            return boolOutcome(playerReds > 0, `${market}_PLAYER_STATISTICS`, {
              athleteId,
              redCards: playerReds,
            });
          }
          return unresolved(
            'No red-card event was observed, but complete player red-card evidence is unavailable.',
            { athleteId, observedCards: cards.length },
          );
        }
        // A positive booking event is sufficient to settle Yes. To settle No,
        // require explicit player yellow- and red-card statistics; event feeds
        // can contain goals without carrying every booking.
        if (cards.some((card) => card.yellow || card.red)) {
          return boolOutcome(true, `${market}_PLAYER_EVENT_ID`, {
            athleteId,
            count: cards.length,
            evidenceComplete: false,
          });
        }
        if (playerYellows !== undefined && playerReds !== undefined) {
          return boolOutcome(
            playerYellows + playerReds > 0,
            `${market}_PLAYER_STATISTICS`,
            { athleteId, yellowCards: playerYellows, redCards: playerReds },
          );
        }
        return unresolved(
          'No booking event was observed, but complete player booking evidence is unavailable.',
          { athleteId, observedCards: cards.length },
        );
      }
      if (market === 'PLAYER_TO_ASSIST') {
        const player = facts.playerStats[athleteId] ?? {};
        const assists = this.stat(player, ['assists', 'goalassists']);
        return assists === undefined
          ? unresolved(
              'Individual assists are not available in the stored normalized Sports match data player statistics.',
            )
          : boolOutcome(assists > 0, 'PLAYER_ASSIST_BOX_SCORE', {
              athleteId,
              assists,
            });
      }
      if (
        market === 'PLAYER_SHOTS_ON_TARGET' ||
        market === 'PLAYER_SHOTS_ON_TARGET_OVER_UNDER' ||
        market === 'PLAYER_SHOTS_OVER_UNDER'
      ) {
        const player = facts.playerStats[athleteId] ?? {};
        const statKey =
          market === 'PLAYER_SHOTS_ON_TARGET' || market === 'PLAYER_SHOTS_ON_TARGET_OVER_UNDER'
            ? 'shotsontarget'
            : 'shots';
        let actual = this.stat(player, [statKey]);
        let method = `${market}_PLAYER_BOX_SCORE`;

        // A credited non-own goal proves at least one shot and one shot on target.
        // It cannot establish a higher count, so this inference is only valid for 0.5 lines.
        if (
          actual === undefined &&
          line === 0.5 &&
          facts.goalEventsComplete &&
          facts.goals.some(
            (goal) => !goal.ownGoal && goal.playerIds.includes(athleteId),
          )
        ) {
          actual = 1;
          method = `${market}_MINIMUM_INFERRED_FROM_CREDITED_GOAL`;
        }

        if (actual === undefined || line === undefined)
          return unresolved(
            'Player shot statistics or the selected line are unavailable.',
          );
        return this.overUnder(
          actual,
          line,
          this.isOverSelection(key, label),
          method,
        );
      }
    }

    return unresolved(
      `No settlement rule is implemented for market ${marketKey}.`,
    );
  }

  private goalsInSettlementPeriod(facts: SettlementEventFacts) {
    if (!facts.afterExtraTime) return facts.goals;
    // Added time is represented as 90.01, 90.02, etc. Extra time begins at 91.
    return facts.goals.filter(
      (goal) => goal.minute !== undefined && goal.minute <= 90.99,
    );
  }

  /** Resolve market identity exclusively against the Odds module catalogue. */
  canonicalMarket(marketKey: string): string {
    return (
      this.resolveMarketDefinition(marketKey)?.predictionMarketKey ??
      'UNSUPPORTED_MARKET'
    );
  }

  private resolveMarketDefinition(
    marketKey: string,
  ): CanonicalMarketDefinition | undefined {
    const key = norm(marketKey);
    const matched = FOOTBALL_MARKET_CATALOG.find((definition) =>
      [
        definition.id,
        definition.predictionMarketKey,
        definition.betLabMarketCode,
        definition.jsonVariable,
        definition.fullName,
        definition.abbreviation,
      ].some((candidate) => norm(candidate) === key),
    );
    if (matched) return matched;

    // Compatibility aliases may resolve only to an existing Odds catalogue
    // definition. They cannot create an independent settlement market.
    const legacyAliases: Record<string, string> = {
      FIRST_HALF_TOTAL_GOALS: 'FIRST_HALF_TOTAL_GOALS',
      FIRST_HALF_GOALS_OVER_UNDER: 'FIRST_HALF_TOTAL_GOALS',
      TOTAL_GOALS_OVER_UNDER: 'TOTAL_GOALS_OVER_UNDER',
      GOALS_OVER_UNDER: 'TOTAL_GOALS_OVER_UNDER',
    };
    const target = legacyAliases[key];
    if (!target) return undefined;
    return FOOTBALL_MARKET_CATALOG.find((definition) =>
      [
        definition.id,
        definition.predictionMarketKey,
        definition.betLabMarketCode,
      ].some((candidate) => norm(candidate) === norm(target)),
    );
  }

  private resolveCatalogSelection(
    market: CanonicalMarketDefinition,
    selection: SettlementSelectionInput,
  ): CanonicalMarketDefinition['selections'][number] | undefined {
    if (market.selectionMode !== 'STATIC') return undefined;
    const candidates = [
      selection.settlementKey,
      selection.key,
      selection.code,
      selection.jsonVariable,
      selection.fullName,
      selection.abbreviation,
    ]
      .map(norm)
      .filter(Boolean);
    return market.selections.find((item) =>
      [
        item.key,
        item.jsonVariable,
        item.fullName,
        item.abbreviation,
        item.settlementKey,
      ].some((value) => candidates.includes(norm(value))),
    );
  }

  private resultSelection(
    key: string,
    label: string,
  ): 'HOME' | 'DRAW' | 'AWAY' | undefined {
    if (
      key.startsWith('HOME') ||
      key === '1' ||
      (/\bHOME\b/.test(label) && /WIN|RESULT|MOST CORNERS/.test(label))
    )
      return 'HOME';
    if (
      key.startsWith('AWAY') ||
      key === '2' ||
      (/\bAWAY\b/.test(label) && /WIN|RESULT|MOST CORNERS/.test(label))
    )
      return 'AWAY';
    if (
      key.startsWith('DRAW') ||
      key === 'X' ||
      key === 'EQUAL' ||
      /\bDRAW\b|\bEQUAL CORNERS\b/.test(label)
    )
      return 'DRAW';
    return undefined;
  }

  private resultToken(token?: string): 'HOME' | 'DRAW' | 'AWAY' | undefined {
    if (!token) return undefined;
    return token.startsWith('HOME') || token === '1'
      ? 'HOME'
      : token.startsWith('DRAW') || token === 'X'
        ? 'DRAW'
        : token.startsWith('AWAY') || token === '2'
          ? 'AWAY'
          : undefined;
  }

  private selectedSide(
    selection: SettlementSelectionInput,
    facts: SettlementEventFacts,
  ): 'HOME' | 'AWAY' | undefined {
    const combined =
      `${str(selection.key)} ${str(selection.code)} ${str(selection.fullName)} ${str(selection.subjectTeamId)}`.toUpperCase();
    if (
      /^HOME|HOME_|_HOME|\bHOME\b|\b1\s*(?:DNB|[+-])/i.test(combined) ||
      (selection.subjectTeamId && selection.subjectTeamId === facts.homeTeamId)
    )
      return 'HOME';
    if (
      /^AWAY|AWAY_|_AWAY|\bAWAY\b|\b2\s*(?:DNB|[+-])/i.test(combined) ||
      (selection.subjectTeamId && selection.subjectTeamId === facts.awayTeamId)
    )
      return 'AWAY';
    const full = compact(combined);
    if (facts.homeTeamName && full.includes(compact(facts.homeTeamName)))
      return 'HOME';
    if (facts.awayTeamName && full.includes(compact(facts.awayTeamName)))
      return 'AWAY';
    return undefined;
  }

  private readLine(
    selection: SettlementSelectionInput,
    preferHandicap = false,
  ): number | undefined {
    if (
      preferHandicap &&
      selection.handicap !== undefined &&
      Number.isFinite(selection.handicap)
    )
      return selection.handicap;
    if (selection.line !== undefined && Number.isFinite(selection.line))
      return selection.line;
    if (selection.handicap !== undefined && Number.isFinite(selection.handicap))
      return selection.handicap;
    const raw = `${str(selection.key)} ${str(selection.code)} ${str(selection.settlementKey)} ${str(selection.fullName)} ${str(selection.abbreviation)}`;
    // Prefer encoded tokens like OVER_2_5; a generic decimal regex would incorrectly parse that as 2.
    const encoded = raw.match(
      /(?:OVER|UNDER|O\/U|O|U)[_\s]+(-?\d+(?:[_.]\d{1,2})?)/i,
    );
    if (encoded) {
      const parsed = this.parseNumericToken(encoded[1]);
      if (parsed !== undefined) return parsed;
    }
    const display = raw.match(/\b(?:OVER|UNDER)\s+(-?\d+(?:\.\d+)?)/i);
    if (display) return Number(display[1]);
    const labelled = raw.match(
      /(?:GOALS?|CORNERS?|CARDS?|SHOTS?|OFFSIDES?|FOULS?)\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i,
    );
    if (labelled) return Number(labelled[1]);
    return undefined;
  }

  private parseNumericToken(value: string): number | undefined {
    const text = value.trim().replace(/,/g, '');
    if (/^-?\d+\.\d+$/.test(text)) return Number(text);
    const match = text.match(/^(-?\d+)[_](\d{1,2})$/);
    if (match) return Number(`${match[1]}.${match[2]}`);
    return num(text);
  }

  private readHandicap(
    selection: SettlementSelectionInput,
  ): number | undefined {
    if (selection.handicap !== undefined && Number.isFinite(selection.handicap))
      return selection.handicap;
    const raw = `${str(selection.key)} ${str(selection.code)} ${str(selection.fullName)} ${str(selection.abbreviation)}`;
    const encoded = raw.match(
      /(?:MINUS|PLUS|ZERO)[_\s]+(\d+(?:[_.](?:\d{1,2}))?)/i,
    );
    if (encoded) {
      const value = this.parseNumericToken(encoded[1]);
      if (value === undefined) return undefined;
      return /MINUS/i.test(raw) ? -value : /ZERO/i.test(raw) ? 0 : value;
    }
    const matches = [
      ...raw.matchAll(
        /(?:\(|HANDICAP\s*)?([+-]\s*\d+(?:\.\d+)?|\b0(?:\.\d+)?)(?=\)|\s|$)/gi,
      ),
    ];
    const match = matches[matches.length - 1];
    if (match) return Number(match[1].replace(/\s+/g, ''));
    return undefined;
  }

  private isOverSelection(key: string, label: string): boolean | undefined {
    if (/^OVER(?:_|$)|_OVER_|\bOVER\b|\bO\s*\d/i.test(key + ' ' + label))
      return true;
    if (/^UNDER(?:_|$)|_UNDER_|\bUNDER\b|\bU\s*\d/i.test(key + ' ' + label))
      return false;
    return undefined;
  }

  private overUnder(
    actual: number,
    line: number,
    over: boolean | undefined,
    method: string,
    phase?: SettlementPhase,
  ): SettlementEvaluation {
    if (over === undefined)
      return unresolved('Over/Under selection could not be identified.');
    const hundredths = Math.round(line * 100);
    const remainder = hundredths % 50;
    if (remainder === 25 || remainder === 75) {
      // Quarter-lines split the stake evenly across the adjacent half-lines.
      const lower = Math.floor(line * 2) / 2;
      const upper = lower + 0.5;
      const first = this.simpleOverUnder(actual, lower, over);
      const second = this.simpleOverUnder(actual, upper, over);
      const outcome = this.combineSplit(first, second);
      const evidence = {
        actual,
        line,
        over,
        componentOutcomes: [first, second],
      };
      return outcome === O.UNRESOLVED
        ? unresolved(
            'Quarter-line outcomes could not be combined safely.',
            evidence,
          )
        : resolved(outcome, `${method}_QUARTER_LINE_SPLIT`, evidence, phase);
    }
    return resolved(
      this.simpleOverUnder(actual, line, over),
      method,
      {
        actual,
        line,
        over,
      },
      phase,
    );
  }

  private simpleOverUnder(actual: number, line: number, over: boolean): O {
    return actual === line
      ? O.PUSH
      : (over ? actual > line : actual < line)
        ? O.WON
        : O.LOST;
  }

  private combineSplit(a: O, b: O): O {
    if (a === O.WON && b === O.WON) return O.WON;
    if (a === O.LOST && b === O.LOST) return O.LOST;
    if (a === O.PUSH && b === O.PUSH) return O.PUSH;
    if ((a === O.WON && b === O.PUSH) || (a === O.PUSH && b === O.WON))
      return O.HALF_WON;
    if ((a === O.LOST && b === O.PUSH) || (a === O.PUSH && b === O.LOST))
      return O.HALF_LOST;
    // Defensive branch for malformed lines; do not invent a settlement.
    return O.UNRESOLVED;
  }

  private handicapOutcome(
    goalDifference: number,
    handicap: number,
    method: string,
    evidence: Record<string, unknown>,
  ): SettlementEvaluation {
    const adjusted = goalDifference + handicap;
    const hundredths = Math.round(handicap * 100);
    const remainder = Math.abs(hundredths) % 50;
    if (remainder === 25 || remainder === 75) {
      const lower = Math.floor(handicap * 2) / 2;
      const upper = lower + 0.5;
      const first = this.handicapComponent(goalDifference, lower);
      const second = this.handicapComponent(goalDifference, upper);
      const outcome = this.combineSplit(first, second);
      const details = { ...evidence, adjusted, components: [first, second] };
      return outcome === O.UNRESOLVED
        ? unresolved(
            'Quarter-handicap outcomes could not be combined safely.',
            details,
          )
        : resolved(outcome, `${method}_QUARTER_LINE_SPLIT`, details);
    }
    return resolved(
      adjusted > 0 ? O.WON : adjusted < 0 ? O.LOST : O.PUSH,
      method,
      { ...evidence, adjusted },
    );
  }

  private handicapComponent(goalDifference: number, handicap: number): O {
    const adjusted = goalDifference + handicap;
    return adjusted > 0 ? O.WON : adjusted < 0 ? O.LOST : O.PUSH;
  }

  private oddEven(
    actual: number,
    key: string,
    label: string,
    method: string,
  ): SettlementEvaluation {
    const expected =
      /ODD/.test(key) || /\bODD\b/.test(label)
        ? 'ODD'
        : /EVEN/.test(key) || /\bEVEN\b/.test(label)
          ? 'EVEN'
          : undefined;
    if (!expected)
      return unresolved('Odd/Even selection could not be identified.');
    const outcome = actual % 2 === 0 ? 'EVEN' : 'ODD';
    return boolOutcome(outcome === expected, method, {
      actual,
      outcome,
      expected,
    });
  }

  private readCorrectScore(
    selection: SettlementSelectionInput,
  ): { home: number; away: number } | undefined {
    if (selection.homeGoals !== undefined && selection.awayGoals !== undefined)
      return { home: selection.homeGoals, away: selection.awayGoals };
    const source = `${str(selection.key ?? selection.code)} ${str(selection.fullName)}`;
    const encoded = source.match(/SCORE[_\s]+(\d+)[_\s]+(\d+)/i);
    if (encoded) return { home: Number(encoded[1]), away: Number(encoded[2]) };
    const display = str(selection.fullName ?? selection.abbreviation).match(
      /(?:^|\b)(\d{1,2})\s*[-:–]\s*(\d{1,2})(?:\b|$)/,
    );
    return display
      ? { home: Number(display[1]), away: Number(display[2]) }
      : undefined;
  }

  private integerFromKey(key: string, prefixes: string[]): number | undefined {
    const prefix = prefixes.find((item) => key.startsWith(item));
    if (!prefix) return undefined;
    const rest = key.slice(prefix.length);
    return /^\d+$/.test(rest) ? Number(rest) : undefined;
  }

  private readRange(
    key: string,
    name: string,
  ): { low: number; high?: number } | undefined {
    if (key.includes('6_PLUS') || /6\s*(?:\+|OR MORE)/i.test(name))
      return { low: 6 };
    let match = key.match(/GOALS?[_\s]+(\d+)[_\s]+(\d+)/i);
    if (match) return { low: Number(match[1]), high: Number(match[2]) };
    match = name.match(/(\d+)\s*(?:–|-|TO)\s*(\d+)\s*GOALS?/i);
    if (match) return { low: Number(match[1]), high: Number(match[2]) };
    return undefined;
  }

  private normalizedMarginSelection(
    key: string,
    label: string,
  ): string | undefined {
    if (key === 'DRAW' || key === 'X') return 'DRAW';
    const source = key || label;
    const side =
      source.startsWith('HOME') || /HOME WIN/.test(label)
        ? 'HOME'
        : source.startsWith('AWAY') || /AWAY WIN/.test(label)
          ? 'AWAY'
          : undefined;
    if (!side) return undefined;
    if (
      /3_PLUS|3PLUS|3_OR_MORE|3\+/.test(source) ||
      /3\s*OR MORE|3\s*\+/.test(label)
    )
      return `${side}_BY_3_PLUS`;
    if (/2_PLUS|2PLUS|2_OR_MORE|2\+/.test(source) || /2\s*\+/.test(label))
      return `${side}_BY_2_PLUS`;
    if (/BY_2|EXACTLY 2|BY EXACTLY 2/.test(source + ' ' + label))
      return `${side}_BY_2`;
    if (/BY_1|EXACTLY 1/.test(source + ' ' + label)) return `${side}_BY_1`;
    return undefined;
  }

  private playerIdFrom(key: string, name: string): string {
    const match = `${key} ${name}`.match(/(?:PLAYER|ATHLETE)[_\s-]*(\d{3,})/i);
    return match?.[1] ?? '';
  }

  private hasStatConflict(
    facts: SettlementEventFacts,
    keys: string[],
  ): boolean {
    const conflicts = new Set(facts.conflictingStats ?? []);
    return keys.some((key) => conflicts.has(key));
  }

  private settleOverUnderLowerBound(
    actual: number,
    line: number,
    over: boolean | undefined,
    method: string,
    phase: SettlementPhase,
  ): SettlementEvaluation | undefined {
    if (over === undefined) return undefined;
    const hundredths = Math.round(line * 100);
    const remainder = Math.abs(hundredths) % 50;
    const isQuarterLine = remainder === 25;
    const upperComponent = isQuarterLine
      ? Math.floor(line * 2) / 2 + 0.5
      : line;
    if (actual <= upperComponent) return undefined;
    return boolOutcome(
      over,
      method,
      {
        observedLowerBound: actual,
        line,
        over,
        upperSplitBoundary: upperComponent,
        quarterLine: isQuarterLine,
        evidenceComplete: false,
      },
      phase,
    );
  }

  private stat(
    stats: Record<string, number>,
    aliases: string[],
  ): number | undefined {
    for (const alias of aliases) {
      const key = compact(alias);
      const value = stats[key];
      if (value !== undefined) return value;
      // Exact normalized aliases only. Substring matching made "shots" collide
      // with "shotsOnTarget" and could settle a market using the wrong statistic.
      const matching = Object.entries(stats).find(
        ([name]) => compact(name) === key,
      );
      if (matching) return matching[1];
    }
    return undefined;
  }
}

