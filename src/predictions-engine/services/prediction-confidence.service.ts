import { Injectable } from '@nestjs/common';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { MarketModel } from '../enums/market-model.enum';
import {
  ExpectedGoalsModel,
  PredictionMatchContext,
} from '../interfaces/espn-prediction-context.interface';

export interface ConfidenceResult {
  /** Evidence quality score from 0 to 98; it is not the probability of winning. */
  confidence: number;
  evidenceConfidence: number;
  dataQuality: number;
  signals: Record<string, number>;
  notes: string[];
}

@Injectable()
export class PredictionConfidenceService {
  calculate(
    context: PredictionMatchContext,
    marketSpecificDataQuality = 0.5,
    hasUsableMatchOdds = context.hasOdds,
    _confidenceSeed = `${context.fixture.eventId}:${context.fixture.homeTeamId}:${context.fixture.awayTeamId}`,
    modelEvidence?: ExpectedGoalsModel,
    marketModel: MarketModel = MarketModel.SCORE_MATRIX,
  ): ConfidenceResult {
    const cfg = PREDICTION_ENGINE_CONFIG.model;
    const kickoff = context.fixture.fixtureDate.getTime();
    const validHistorical = (context.historicalFixtures ?? []).filter((fixture) =>
      fixture.fixtureDate instanceof Date
      && Number.isFinite(fixture.fixtureDate.getTime())
      && fixture.fixtureDate.getTime() < kickoff
      && fixture.completed === true
      && Number.isFinite(fixture.homeScore)
      && Number.isFinite(fixture.awayScore),
    );
    const homeHistoryMatches = validHistorical.filter(
      (fixture) => fixture.homeTeamId === context.fixture.homeTeamId || fixture.awayTeamId === context.fixture.homeTeamId,
    ).length;
    const awayHistoryMatches = validHistorical.filter(
      (fixture) => fixture.homeTeamId === context.fixture.awayTeamId || fixture.awayTeamId === context.fixture.awayTeamId,
    ).length;
    const homeMatches = Math.max(homeHistoryMatches, modelEvidence?.homeSamples ?? 0);
    const awayMatches = Math.max(awayHistoryMatches, modelEvidence?.awaySamples ?? 0);

    const completedLeagueMatches = (context.leagueFixtures ?? []).filter((fixture) =>
      fixture.fixtureDate instanceof Date
      && Number.isFinite(fixture.fixtureDate.getTime())
      && fixture.fixtureDate.getTime() < kickoff
      && fixture.completed === true
      && Number.isFinite(fixture.homeScore)
      && Number.isFinite(fixture.awayScore),
    );

    const isScoreBasedModel = marketModel === MarketModel.SCORE_MATRIX || marketModel === MarketModel.PERIOD_MATRIX;
    const isCountModel = marketModel === MarketModel.COUNT_MODEL;
    const isEventRateModel = marketModel === MarketModel.EVENT_RATE;
    const requiresRoster = marketModel === MarketModel.PLAYER_MODEL;
    const historySignal = Math.min(1, Math.sqrt(Math.min(homeMatches, awayMatches) / cfg.historicalMatchesPerTeam));
    const leagueCount = Math.max(completedLeagueMatches.length, modelEvidence?.leagueSamples ?? 0);
    const leagueSignal = Math.min(1, leagueCount / cfg.leagueMatches);
    const oddsSignal = hasUsableMatchOdds ? 1 : 0;
    const h2hCount = Math.max(modelEvidence?.historicalHeadToHeadMatches ?? 0, context.hasHeadToHead ? 1 : 0);
    const h2hSignal = Math.min(1, h2hCount / 5);
    const formSignal = Math.min(1, Math.min(
      modelEvidence?.homeRecentFormSamples ?? homeMatches,
      modelEvidence?.awayRecentFormSamples ?? awayMatches,
    ) / cfg.recentFormMatchesPerTeam);
    const standingsSignal = modelEvidence
      ? (modelEvidence.standingsStrengthAvailable ? 1 : 0)
      : (context.hasStandings ? 0.5 : 0);
    // Roster availability is relevant to player-specific markets only. A
    // missing current-fixture roster must not lower match-result confidence.
    const rosterSignal = requiresRoster ? (context.hasRosters ? 1 : 0) : 0;
    // An absent Summary is unknown, not evidence that stored historical
    // fixtures are stale. Give it neutral freshness credit; do not assume fresh.
    const freshnessSignal = context.summaryAgeHours === null
      ? 0.5
      : context.summaryAgeHours <= 6
        ? 1
        : context.summaryAgeHours <= 24
          ? 0.8
          : context.summaryAgeHours <= cfg.sourceSummaryStaleHours
            ? 0.55
            : 0.15;
    const marketSignal = Math.max(0, Math.min(1, Number.isFinite(marketSpecificDataQuality) ? marketSpecificDataQuality : 0));

    const signals = {
      history: historySignal,
      leagueSample: leagueSignal,
      odds: oddsSignal,
      headToHead: h2hSignal,
      recentForm: formSignal,
      standings: standingsSignal,
      rosters: rosterSignal,
      freshness: freshnessSignal,
      marketSpecificData: marketSignal,
    };

    // Confidence measures evidence coverage, not outcome probability. When a
    // signal is irrelevant (rosters for a goals market), remove its weight and
    // renormalize instead of silently rewarding or penalizing missing data.
    // Confidence follows the evidence domain used by the market. A market
    // based on corner/card/shots observations should not be scored as if it
    // depended on goal-score history; player/event markets have their own
    // relevant evidence requirements too.
    const weights = isScoreBasedModel
      ? {
          history: 0.35, league: 0.10, odds: 0.12, h2h: 0.05,
          form: 0.16, standings: 0.08, roster: 0, freshness: 0.04, market: 0.05,
        }
      : isCountModel
        ? {
            history: 0.05, league: 0.05, odds: 0.12, h2h: 0,
            form: 0.02, standings: 0, roster: 0, freshness: 0.04, market: 0.72,
          }
        : isEventRateModel
          ? {
              history: 0.02, league: 0.02, odds: 0.12, h2h: 0,
              form: 0, standings: 0, roster: 0, freshness: 0.04, market: 0.80,
            }
          : requiresRoster
            ? {
                history: 0.02, league: 0.02, odds: 0.12, h2h: 0,
                form: 0, standings: 0, roster: 0.26, freshness: 0.04, market: 0.54,
              }
            : {
                history: 0.35, league: 0.10, odds: 0.12, h2h: 0.05,
                form: 0.16, standings: 0.08, roster: 0, freshness: 0.04, market: 0.05,
              };
    const confidenceWeightTotal = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
    const weightedEvidence = (
      historySignal * weights.history
      + leagueSignal * weights.league
      + oddsSignal * weights.odds
      + h2hSignal * weights.h2h
      + formSignal * weights.form
      + standingsSignal * weights.standings
      + rosterSignal * weights.roster
      + freshnessSignal * weights.freshness
      + marketSignal * weights.market
    ) / confidenceWeightTotal;
    const confidence = Math.max(0, Math.min(cfg.maximumConfidence, Math.round(cfg.maximumConfidence * weightedEvidence)));

    const qualityWeights = isScoreBasedModel
      ? {
          history: 0.35, league: 0.16, odds: 0.12, h2h: 0.05,
          form: 0.16, standings: 0.07, roster: 0, freshness: 0.03, market: 0.03,
        }
      : isCountModel
        ? {
            history: 0.05, league: 0.05, odds: 0.12, h2h: 0,
            form: 0.02, standings: 0, roster: 0, freshness: 0.04, market: 0.72,
          }
        : isEventRateModel
          ? {
              history: 0.02, league: 0.02, odds: 0.12, h2h: 0,
              form: 0, standings: 0, roster: 0, freshness: 0.04, market: 0.80,
            }
          : requiresRoster
            ? {
                history: 0.02, league: 0.02, odds: 0.12, h2h: 0,
                form: 0, standings: 0, roster: 0.26, freshness: 0.04, market: 0.54,
              }
            : {
                history: 0.35, league: 0.16, odds: 0.12, h2h: 0.05,
                form: 0.16, standings: 0.07, roster: 0, freshness: 0.03, market: 0.03,
              };
    const qualityWeightTotal = Object.values(qualityWeights).reduce((sum, weight) => sum + weight, 0);
    const dataQuality = Math.max(0, Math.min(1, (
      historySignal * qualityWeights.history
      + leagueSignal * qualityWeights.league
      + oddsSignal * qualityWeights.odds
      + h2hSignal * qualityWeights.h2h
      + formSignal * qualityWeights.form
      + standingsSignal * qualityWeights.standings
      + rosterSignal * qualityWeights.roster
      + freshnessSignal * qualityWeights.freshness
      + marketSignal * qualityWeights.market
    ) / qualityWeightTotal));

    const notes: string[] = [];
    if (isScoreBasedModel && Math.min(homeMatches, awayMatches) < cfg.minimumHistoricalMatchesPerTeam) {
      notes.push(`Limited pre-kickoff goal-score history: home-team sample ${homeMatches}; away-team sample ${awayMatches}; reference target ${cfg.minimumHistoricalMatchesPerTeam}+ each. This is a quality signal, not an automatic rejection.`);
    } else if (!isScoreBasedModel && Math.min(homeMatches, awayMatches) === 0) {
      notes.push('Goal-score history is sparse; this market is assessed primarily using its own relevant historical observations and evidence quality.');
    }
    if (isScoreBasedModel && leagueCount < 30) notes.push(`Limited completed league score sample (${leagueCount}); league-baseline uncertainty is higher.`);
    if (!hasUsableMatchOdds) notes.push('No fresh provider quote was available for this market; bookmaker value cannot be established from this market result.');
    if (!context.summaryAvailable) notes.push('The current ESPN Summary is missing. Recent form and head-to-head are reconstructed from dated prior ESPN fixtures when available; target-summary absence alone does not block a market supported by historical evidence.');
    if (context.summaryAgeHours === null) notes.push('Current Summary freshness is unknown; no freshness bonus was assumed.');
    else if (context.summaryAgeHours > cfg.sourceSummaryStaleHours) notes.push('ESPN Summary is older than the configured freshness window.');
    if (isScoreBasedModel && !standingsSignal) notes.push('Usable points-per-game standings strength was not matched for both target teams.');
    if (requiresRoster && !context.hasRosters) notes.push('Roster evidence was unavailable; player-specific markets may remain unavailable.');
    if (isScoreBasedModel && modelEvidence?.evidenceLevel === 'INSUFFICIENT') notes.push('Independent core statistical evidence was insufficient. The market calculation may use the Odds-module quote as a low-evidence fallback; treat confidence as limited.');

    return { confidence, evidenceConfidence: confidence, dataQuality, signals, notes };
  }
}

