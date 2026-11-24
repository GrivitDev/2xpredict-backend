import { Injectable } from '@nestjs/common';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { MarketModel } from '../enums/market-model.enum';
import type {
  ExpectedGoalsModel,
  PredictionMatchContext,
} from '../interfaces/prediction-match-context.interface';

export interface ConfidenceResult {
  /** User-facing model confidence score; it is not the probability of an outcome. */
  confidence: number;
  /** Raw evidence-derived score before the configured display floor is applied. */
  evidenceConfidence: number;
  dataQuality: number;
  signals: Record<string, number>;
  notes: string[];
  evidenceLevel: 'PRIOR_ONLY' | 'LIMITED' | 'DEVELOPING' | 'STRONG' | 'MARKET_SPECIFIC';
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
    calibrationAssessment?: { active?: boolean; sampleSize?: number; reliabilityScore?: number },
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
    const requiresPlayerEvidence = marketModel === MarketModel.PLAYER_MODEL;
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
    // Player markets require validated player appearance denominators, not a
    // guessed roster/lineup flag. The current Sports read contract does not
    // expose that evidence, so this signal remains false until it genuinely does.
    const playerEvidenceSignal = requiresPlayerEvidence
      ? (context.hasPlayerAppearanceEvidence ? 1 : 0)
      : 0;
    const freshnessSignal = context.sportsDataAgeHours === null
      ? 0.5
      : context.sportsDataAgeHours <= 6
        ? 1
        : context.sportsDataAgeHours <= 24
          ? 0.8
          : context.sportsDataAgeHours <= cfg.sourceDataStaleHours
            ? 0.55
            : 0.15;
    const marketSignal = Math.max(0, Math.min(1, Number.isFinite(marketSpecificDataQuality) ? marketSpecificDataQuality : 0));

    const signals: Record<string, number> = {
      history: historySignal,
      leagueSample: leagueSignal,
      odds: oddsSignal,
      headToHead: h2hSignal,
      recentForm: formSignal,
      standings: standingsSignal,
      playerEvidence: playerEvidenceSignal,
      freshness: freshnessSignal,
      marketSpecificData: marketSignal,
    };

    // Confidence measures evidence coverage, not outcome probability. When a
    // signal is irrelevant to a market, remove its weight and renormalize.
    const weights = isScoreBasedModel
      ? {
          history: 0.35, league: 0.10, odds: 0.12, h2h: 0.05,
          form: 0.16, standings: 0.08, playerEvidence: 0, freshness: 0.04, market: 0.05,
        }
      : isCountModel
        ? {
            history: 0.05, league: 0.05, odds: 0.12, h2h: 0,
            form: 0.02, standings: 0, playerEvidence: 0, freshness: 0.04, market: 0.72,
          }
        : isEventRateModel
          ? {
              history: 0.02, league: 0.02, odds: 0.12, h2h: 0,
              form: 0, standings: 0, playerEvidence: 0, freshness: 0.04, market: 0.80,
            }
          : requiresPlayerEvidence
            ? {
                history: 0.02, league: 0.02, odds: 0.12, h2h: 0,
                form: 0, standings: 0, playerEvidence: 0.26, freshness: 0.04, market: 0.54,
              }
            : {
                history: 0.35, league: 0.10, odds: 0.12, h2h: 0.05,
                form: 0.16, standings: 0.08, playerEvidence: 0, freshness: 0.04, market: 0.05,
              };
    const confidenceWeightTotal = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
    const weightedEvidence = (
      historySignal * weights.history
      + leagueSignal * weights.league
      + oddsSignal * weights.odds
      + h2hSignal * weights.h2h
      + formSignal * weights.form
      + standingsSignal * weights.standings
      + playerEvidenceSignal * weights.playerEvidence
      + freshnessSignal * weights.freshness
      + marketSignal * weights.market
    ) / confidenceWeightTotal;
    const evidenceConfidence = Math.max(0, Math.min(cfg.maximumConfidence, Math.round(cfg.maximumConfidence * weightedEvidence)));
    const minimumDisplayedConfidence = Math.max(0, Math.min(
      cfg.maximumConfidence,
      Number(cfg.minimumDisplayedConfidence ?? 40),
    ));
    const rawCalibrationSampleSize = Number(calibrationAssessment?.sampleSize ?? 0);
    const calibrationSampleSize = Number.isFinite(rawCalibrationSampleSize)
      ? Math.max(0, rawCalibrationSampleSize)
      : 0;
    const calibrationIsUsable = calibrationAssessment?.active === true
      && calibrationSampleSize >= PREDICTION_ENGINE_CONFIG.calibration.minimumSettledSamples;
    const rawCalibrationReliability = Number(calibrationAssessment?.reliabilityScore ?? 0);
    const calibrationReliability = calibrationIsUsable
      ? Math.max(0, Math.min(1, Number.isFinite(rawCalibrationReliability) ? rawCalibrationReliability / 100 : 0))
      : 1;
    const calibrationSupport = calibrationIsUsable
      ? Math.max(0, Math.min(1, calibrationSampleSize / (calibrationSampleSize + PREDICTION_ENGINE_CONFIG.calibration.minimumSettledSamples)))
      : 0;
    const configuredReliabilityPenalty = Number(PREDICTION_ENGINE_CONFIG.calibration.maximumConfidenceReliabilityPenalty ?? 0.15);
    const maximumReliabilityPenalty = Number.isFinite(configuredReliabilityPenalty)
      ? Math.max(0, Math.min(0.30, configuredReliabilityPenalty))
      : 0.15;
    // A proven calibration problem may reduce displayed confidence by up to
    // the configured penalty. It can never inflate confidence above the
    // evidence-derived score. No settled calibration means no adjustment.
    const reliabilityPenalty = calibrationIsUsable
      ? maximumReliabilityPenalty * calibrationSupport * (1 - calibrationReliability)
      : 0;
    const reliabilityAdjustedConfidence = Math.round(evidenceConfidence * (1 - reliabilityPenalty));
    // Keep the requested display floor separate from raw evidence and quality.
    const confidence = Math.max(minimumDisplayedConfidence, reliabilityAdjustedConfidence);
    const evidenceLevel: ConfidenceResult['evidenceLevel'] = isScoreBasedModel
      ? modelEvidence?.evidenceLevel ?? 'PRIOR_ONLY'
      : 'MARKET_SPECIFIC';
    signals.historicalCalibrationReliability = calibrationIsUsable ? calibrationReliability : 0;
    signals.historicalCalibrationSupport = calibrationSupport;
    signals.historicalCalibrationPenalty = reliabilityPenalty;

    const qualityWeights = isScoreBasedModel
      ? {
          history: 0.35, league: 0.16, odds: 0.12, h2h: 0.05,
          form: 0.16, standings: 0.07, playerEvidence: 0, freshness: 0.03, market: 0.03,
        }
      : isCountModel
        ? {
            history: 0.05, league: 0.05, odds: 0.12, h2h: 0,
            form: 0.02, standings: 0, playerEvidence: 0, freshness: 0.04, market: 0.72,
          }
        : isEventRateModel
          ? {
              history: 0.02, league: 0.02, odds: 0.12, h2h: 0,
              form: 0, standings: 0, playerEvidence: 0, freshness: 0.04, market: 0.80,
            }
          : requiresPlayerEvidence
            ? {
                history: 0.02, league: 0.02, odds: 0.12, h2h: 0,
                form: 0, standings: 0, playerEvidence: 0.26, freshness: 0.04, market: 0.54,
              }
            : {
                history: 0.35, league: 0.16, odds: 0.12, h2h: 0.05,
                form: 0.16, standings: 0.07, playerEvidence: 0, freshness: 0.03, market: 0.03,
              };
    const qualityWeightTotal = Object.values(qualityWeights).reduce((sum, weight) => sum + weight, 0);
    const dataQuality = Math.max(0, Math.min(1, (
      historySignal * qualityWeights.history
      + leagueSignal * qualityWeights.league
      + oddsSignal * qualityWeights.odds
      + h2hSignal * qualityWeights.h2h
      + formSignal * qualityWeights.form
      + standingsSignal * qualityWeights.standings
      + playerEvidenceSignal * qualityWeights.playerEvidence
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
    if (!hasUsableMatchOdds) notes.push('No independent provider market quote was available. Internally generated Grivit prices are not counted as independent evidence because they are derived from the same pricing model.');
    if (!context.summaryAvailable) notes.push('The normalized Sports match projection is unavailable; this forecast relies more heavily on the remaining historical inputs and configured priors.');
    if (context.sportsDataAgeHours === null) notes.push('Normalized Sports fixture freshness is unknown; no freshness bonus was assumed.');
    else if (context.sportsDataAgeHours > cfg.sourceDataStaleHours) notes.push('Normalized Sports fixture data is older than the configured freshness window.');
    if (isScoreBasedModel && !standingsSignal) notes.push('Usable points-per-game standings strength was not matched for both target teams.');
    if (requiresPlayerEvidence && !context.hasPlayerAppearanceEvidence) {
      notes.push('Validated pre-match player appearance rates are unavailable from the current Sports read contract; player-specific probabilities remain withheld.');
    }
    if (isScoreBasedModel && evidenceLevel === 'PRIOR_ONLY') {
      notes.push('PRIOR_ONLY evidence: no independent team or competition results were available. The model still produces a baseline; the displayed confidence floor does not increase evidenceConfidence or dataQuality.');
    } else if (isScoreBasedModel && evidenceLevel === 'LIMITED') {
      notes.push('LIMITED evidence: only a small number of independent observations support this forecast. The prediction is still calculated and will be updated as new Sports data arrives.');
    } else if (isScoreBasedModel && evidenceLevel === 'DEVELOPING') {
      notes.push('DEVELOPING evidence: early team or competition observations are available, but the evidence base is not yet mature.');
    }
    if (calibrationIsUsable) {
      notes.push(`Historical outcome calibration used ${calibrationSampleSize} settled selections with reliability ${Math.round(calibrationReliability * 100)}/100; displayed confidence was conservatively adjusted by ${(reliabilityPenalty * 100).toFixed(1)}%.`);
    }

    return { confidence, evidenceConfidence, dataQuality, signals, notes, evidenceLevel };
  }
}

