import { Injectable } from '@nestjs/common';
import type {
  PredictionMatchContext,
  ExpectedGoalsModel,
  PredictionFixtureCore,
} from '../interfaces/prediction-match-context.interface';
import type { SportsTeamFormRecord } from '../../sports/interfaces/sports-derived-data.interface';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { PredictionMathUtil } from '../utils/prediction-math.util';

interface VenueGoalRates {
  played: number;
  scored: number;
  conceded: number;
}

interface GoalSamples {
  scored: number[];
  conceded: number[];
  homeScored: number[];
  homeConceded: number[];
  awayScored: number[];
  awayConceded: number[];
}

@Injectable()
export class ExpectedGoalsService {
  estimate(context: PredictionMatchContext): ExpectedGoalsModel {
    const cfg = PREDICTION_ENGINE_CONFIG.model;
    const kickoff = context.fixture.fixtureDate.getTime();
    const league = (context.leagueFixtures ?? [])
      .filter((fixture) => this.isValidCompletedBefore(fixture, kickoff))
      .sort((a, b) => b.fixtureDate.getTime() - a.fixtureDate.getTime())
      .slice(0, cfg.leagueMatches);

    const homeGoals = league.map((fixture) => fixture.homeScore!).filter(Number.isFinite);
    const awayGoals = league.map((fixture) => fixture.awayScore!).filter(Number.isFinite);
    const hasLeagueFacts = homeGoals.length > 0 && awayGoals.length > 0;
    const leaguePriorMatches = cfg.leaguePriorMatches;
    let leagueHomeAverage = hasLeagueFacts
      ? (homeGoals.reduce((sum, value) => sum + value, 0) + cfg.defaultLeagueHomeGoals * leaguePriorMatches)
        / (homeGoals.length + leaguePriorMatches)
      : cfg.defaultLeagueHomeGoals;
    let leagueAwayAverage = hasLeagueFacts
      ? (awayGoals.reduce((sum, value) => sum + value, 0) + cfg.defaultLeagueAwayGoals * leaguePriorMatches)
        / (awayGoals.length + leaguePriorMatches)
      : cfg.defaultLeagueAwayGoals;

    // The Sports competition projection is an independent season-to-date
    // baseline. Blend it conservatively with dated fixture rows so it remains
    // useful when the local history window is sparse without dominating it.
    const projectionMatches = Number(context.competitionScoring?.fixturesPlayed ?? 0);
    if (projectionMatches >= 6 && Number.isFinite(context.competitionScoring?.homeGoals)
      && Number.isFinite(context.competitionScoring?.awayGoals)) {
      const projectionWeight = Math.min(0.45, projectionMatches / (projectionMatches + 30) * 0.45);
      const projectionHome = context.competitionScoring!.homeGoals / projectionMatches;
      const projectionAway = context.competitionScoring!.awayGoals / projectionMatches;
      if (Number.isFinite(projectionHome) && projectionHome >= 0) {
        leagueHomeAverage = this.blend(leagueHomeAverage, projectionHome, projectionWeight);
      }
      if (Number.isFinite(projectionAway) && projectionAway >= 0) {
        leagueAwayAverage = this.blend(leagueAwayAverage, projectionAway, projectionWeight);
      }
    }

    const homeId = context.fixture.homeTeamId;
    const awayId = context.fixture.awayTeamId;
    const homeSamples = this.goalSamples(context, homeId);
    const awaySamples = this.goalSamples(context, awayId);
    const homeVenue = context.homeAwayRecords.home?.home;
    const awayVenue = context.homeAwayRecords.away?.away;

    let homeAttack = this.venueRate(
      homeVenue?.played ?? 0,
      homeVenue?.goalsFor ?? 0,
      homeSamples.homeScored,
      leagueHomeAverage,
    );
    let homeDefence = this.venueRate(
      homeVenue?.played ?? 0,
      homeVenue?.goalsAgainst ?? 0,
      homeSamples.homeConceded,
      leagueAwayAverage,
    );
    let awayAttack = this.venueRate(
      awayVenue?.played ?? 0,
      awayVenue?.goalsFor ?? 0,
      awaySamples.awayScored,
      leagueAwayAverage,
    );
    let awayDefence = this.venueRate(
      awayVenue?.played ?? 0,
      awayVenue?.goalsAgainst ?? 0,
      awaySamples.awayConceded,
      leagueHomeAverage,
    );

    // Season scoring projections fill gaps when venue-split records have not
    // accumulated enough matches. Their sample sizes are retained in evidence.
    homeAttack = this.blendSeasonFallback(homeAttack, context.scoringRecords.home?.averageGoalsFor, context.scoringRecords.home?.fixturesPlayed, leagueHomeAverage);
    homeDefence = this.blendSeasonFallback(homeDefence, context.scoringRecords.home?.averageGoalsAgainst, context.scoringRecords.home?.fixturesPlayed, leagueAwayAverage);
    awayAttack = this.blendSeasonFallback(awayAttack, context.scoringRecords.away?.averageGoalsFor, context.scoringRecords.away?.fixturesPlayed, leagueAwayAverage);
    awayDefence = this.blendSeasonFallback(awayDefence, context.scoringRecords.away?.averageGoalsAgainst, context.scoringRecords.away?.fixturesPlayed, leagueHomeAverage);

    const recentHome = this.recentRates(context.historicalFixtures, homeId, kickoff, cfg.recentFormMatchesPerTeam);
    const recentAway = this.recentRates(context.historicalFixtures, awayId, kickoff, cfg.recentFormMatchesPerTeam);
    const homeFormEvidence = context.homeForm?.results.filter((item) => new Date(item.kickoffAt).getTime() < kickoff).slice(0, cfg.recentFormMatchesPerTeam) ?? [];
    const awayFormEvidence = context.awayForm?.results.filter((item) => new Date(item.kickoffAt).getTime() < kickoff).slice(0, cfg.recentFormMatchesPerTeam) ?? [];
    const useHomeForm = recentHome.matches >= 2 ? recentHome : this.formRates(homeFormEvidence);
    const useAwayForm = recentAway.matches >= 2 ? recentAway : this.formRates(awayFormEvidence);

    const homeRecentWeight = useHomeForm.matches >= 2
      ? Math.min(0.25, useHomeForm.matches / cfg.recentFormMatchesPerTeam * 0.25)
      : 0;
    const awayRecentWeight = useAwayForm.matches >= 2
      ? Math.min(0.25, useAwayForm.matches / cfg.recentFormMatchesPerTeam * 0.25)
      : 0;
    if (homeRecentWeight) {
      homeAttack = this.blend(homeAttack, useHomeForm.scored, homeRecentWeight);
      homeDefence = this.blend(homeDefence, useHomeForm.conceded, homeRecentWeight);
    }
    if (awayRecentWeight) {
      awayAttack = this.blend(awayAttack, useAwayForm.scored, awayRecentWeight);
      awayDefence = this.blend(awayDefence, useAwayForm.conceded, awayRecentWeight);
    }

    const leagueHome = Math.max(0.2, leagueHomeAverage);
    const leagueAway = Math.max(0.2, leagueAwayAverage);
    let lambdaHome = leagueHome
      * Math.pow(Math.max(0.15, homeAttack) / leagueHome, 0.55)
      * Math.pow(Math.max(0.15, awayDefence) / leagueHome, 0.45);
    let lambdaAway = leagueAway
      * Math.pow(Math.max(0.15, awayAttack) / leagueAway, 0.55)
      * Math.pow(Math.max(0.15, homeDefence) / leagueAway, 0.45);

    const homePeriodSplit = this.periodShare(context.historicalFixtures, homeId, kickoff);
    const awayPeriodSplit = this.periodShare(context.historicalFixtures, awayId, kickoff);
    const homeFirstHalfGoalShare = homePeriodSplit.share ?? cfg.firstHalfGoalShare;
    const awayFirstHalfGoalShare = awayPeriodSplit.share ?? cfg.firstHalfGoalShare;
    const observedPeriodSplit = homePeriodSplit.share !== null && awayPeriodSplit.share !== null;

    const h2h = this.readHeadToHead(context, kickoff);
    if (h2h.matches >= 3) {
      lambdaHome = lambdaHome * 0.92 + h2h.homeGoals * 0.08;
      lambdaAway = lambdaAway * 0.92 + h2h.awayGoals * 0.08;
    } else if (h2h.matches === 2) {
      lambdaHome = lambdaHome * 0.96 + h2h.homeGoals * 0.04;
      lambdaAway = lambdaAway * 0.96 + h2h.awayGoals * 0.04;
    }

    const standings = this.standingStrength(context);
    if (standings) {
      const gap = standings.homePpg - standings.awayPpg;
      const adjustment = PredictionMathUtil.clamp(gap * 0.025, -0.10, 0.10);
      lambdaHome *= Math.exp(adjustment);
      lambdaAway *= Math.exp(-adjustment * 0.45);
    }

    // Neutral-site fixtures do not receive the implicit home advantage present
    // in league home/away scoring baselines. Pull both rates toward a symmetric
    // average rather than applying an unearned venue boost.
    if (context.fixture.neutralSite) {
      const symmetric = (lambdaHome + lambdaAway) / 2;
      lambdaHome = this.blend(lambdaHome, symmetric, 0.12);
      lambdaAway = this.blend(lambdaAway, symmetric, 0.12);
    }

    const homeSampleCount = Math.max(homeSamples.scored.length, context.scoringRecords.home?.fixturesPlayed ?? 0, context.homeAwayRecords.home?.home.played ?? 0);
    const awaySampleCount = Math.max(awaySamples.scored.length, context.scoringRecords.away?.fixturesPlayed ?? 0, context.homeAwayRecords.away?.away.played ?? 0);
    const leagueSampleCount = Math.max(league.length, context.competitionScoring?.fixturesPlayed ?? 0);
    const independentEvidenceAvailable = homeSampleCount > 0 || awaySampleCount > 0 || leagueSampleCount > 0 || h2h.matches > 0;
    const evidenceLevel: ExpectedGoalsModel['evidenceLevel'] =
      !independentEvidenceAvailable ? 'INSUFFICIENT'
        : homeSampleCount >= cfg.minimumHistoricalMatchesPerTeam
          && awaySampleCount >= cfg.minimumHistoricalMatchesPerTeam
          && leagueSampleCount >= 20 ? 'STRONG' : 'PARTIAL';

    const evidence: string[] = [
      `Sports normalized goal history: home team ${homeSampleCount} matches; away team ${awaySampleCount} matches; completed competition sample ${leagueSampleCount}.`,
      `Venue-aware rate sources: home venue record ${context.homeAwayRecords.home?.home.played ?? 0} matches; away venue record ${context.homeAwayRecords.away?.away.played ?? 0} matches.`,
      `Competition scoring prior uses ${league.length} dated results, regularized with ${leaguePriorMatches} pseudo-matches; Sports scoring projection reports ${projectionMatches} completed fixtures.`,
      `First-half goal shares: home ${homePeriodSplit.share === null ? 'assumed' : 'observed'} ${homeFirstHalfGoalShare.toFixed(3)} (${homePeriodSplit.samples} period-score samples); away ${awayPeriodSplit.share === null ? 'assumed' : 'observed'} ${awayFirstHalfGoalShare.toFixed(3)} (${awayPeriodSplit.samples} period-score samples).`,
    ];
    if (homeRecentWeight || awayRecentWeight) {
      evidence.push(`Recent form is blended conservatively: home ${useHomeForm.matches} matches (${Math.round(homeRecentWeight * 100)}% weight), away ${useAwayForm.matches} matches (${Math.round(awayRecentWeight * 100)}% weight).`);
    }
    if (h2h.matches) evidence.push(`Sports head-to-head projection supplied ${h2h.matches} prior meetings; H2H influence is capped at 8%.`);
    if (standings) evidence.push('Sports-calculated standings points-per-game were applied as a bounded strength adjustment.');
    else evidence.push('Sports-calculated standings were unavailable for both teams; no standings adjustment was applied.');
    if (!independentEvidenceAvailable) evidence.push('INSUFFICIENT INDEPENDENT EVIDENCE: default goal rates are priors only. Score-matrix and period-matrix predictions remain unavailable; bookmaker prices are not substituted for independent model probabilities.');
    else if (evidenceLevel === 'PARTIAL') evidence.push('PARTIAL EVIDENCE: supported markets may calculate, but confidence and data quality remain limited by the sample count.');

    lambdaHome = PredictionMathUtil.clamp(lambdaHome, cfg.minimumExpectedGoals, cfg.maximumExpectedGoals);
    lambdaAway = PredictionMathUtil.clamp(lambdaAway, cfg.minimumExpectedGoals, cfg.maximumExpectedGoals);
    return {
      home: Number(lambdaHome.toFixed(4)),
      away: Number(lambdaAway.toFixed(4)),
      leagueHomeAverage: Number(leagueHomeAverage.toFixed(4)),
      leagueAwayAverage: Number(leagueAwayAverage.toFixed(4)),
      homeSamples: homeSampleCount,
      awaySamples: awaySampleCount,
      leagueSamples: leagueSampleCount,
      homeFirstHalfGoalShare,
      awayFirstHalfGoalShare,
      observedPeriodSplit,
      homePeriodSplitSamples: homePeriodSplit.samples,
      awayPeriodSplitSamples: awayPeriodSplit.samples,
      calculationMethod: 'Sports-normalized, venue-aware Poisson model: season attack/defence records, competition scoring prior, recent form and low-weight head-to-head evidence.',
      independentEvidenceAvailable,
      evidenceLevel,
      historicalHeadToHeadMatches: h2h.matches,
      homeRecentFormSamples: useHomeForm.matches,
      awayRecentFormSamples: useAwayForm.matches,
      standingsStrengthAvailable: Boolean(standings),
      evidence,
    };
  }

  /** Mirrors Odds' observed team-specific period-share method.
   * A minimum of four completed fixtures is required before a split is trusted.
   */
  private periodShare(
    fixtures: PredictionFixtureCore[],
    teamId: string,
    kickoff: number,
  ): { share: number | null; samples: number } {
    const rows = fixtures
      .filter((fixture) => this.isValidCompletedBefore(fixture, kickoff)
        && (fixture.homeTeamId === teamId || fixture.awayTeamId === teamId))
      .sort((a, b) => b.fixtureDate.getTime() - a.fixtureDate.getTime())
      .slice(0, PREDICTION_ENGINE_CONFIG.model.historicalMatchesPerTeam);
    const observations: number[] = [];
    for (const fixture of rows) {
      const periodOne = fixture.periodScores.filter(
        (item) => item.teamId === teamId && item.period === 1,
      );
      const fullTime = fixture.homeTeamId === teamId ? fixture.homeScore : fixture.awayScore;
      if (!periodOne.length || !Number.isFinite(fullTime) || Number(fullTime) <= 0) continue;
      const firstHalfGoals = periodOne.reduce((total, item) => total + Number(item.score || 0), 0);
      observations.push(PredictionMathUtil.clamp(firstHalfGoals / Number(fullTime), 0.05, 0.95));
    }
    if (observations.length < 4) return { share: null, samples: observations.length };
    const average = observations.reduce((total, value) => total + value, 0) / observations.length;
    return { share: PredictionMathUtil.clamp(average, 0.32, 0.60), samples: observations.length };
  }

  private isValidCompletedBefore(fixture: PredictionFixtureCore, kickoff: number): boolean {
    return fixture.fixtureDate instanceof Date
      && fixture.fixtureDate.getTime() < kickoff
      && fixture.completed === true
      && Number.isFinite(fixture.homeScore)
      && Number.isFinite(fixture.awayScore);
  }

  private goalSamples(context: PredictionMatchContext, teamId: string): GoalSamples {
    const rows = context.historicalFixtures
      .filter((item) => this.isValidCompletedBefore(item, context.fixture.fixtureDate.getTime())
        && (item.homeTeamId === teamId || item.awayTeamId === teamId))
      .sort((a, b) => b.fixtureDate.getTime() - a.fixtureDate.getTime())
      .slice(0, PREDICTION_ENGINE_CONFIG.model.historicalMatchesPerTeam);
    const result: GoalSamples = { scored: [], conceded: [], homeScored: [], homeConceded: [], awayScored: [], awayConceded: [] };
    for (const item of rows) {
      if (item.homeTeamId === teamId) {
        result.scored.push(item.homeScore!); result.conceded.push(item.awayScore!);
        result.homeScored.push(item.homeScore!); result.homeConceded.push(item.awayScore!);
      } else {
        result.scored.push(item.awayScore!); result.conceded.push(item.homeScore!);
        result.awayScored.push(item.awayScore!); result.awayConceded.push(item.homeScore!);
      }
    }
    return result;
  }

  private venueRate(played: number, total: number, fallback: number[], prior: number): number {
    const sample = played > 0 ? total / played : fallback.length ? fallback.reduce((a, b) => a + b, 0) / fallback.length : prior;
    const n = played > 0 ? played : fallback.length;
    return this.shrink(sample, n, prior, 5);
  }

  private blendSeasonFallback(current: number, average: number | undefined, sample: number | undefined, prior: number): number {
    if (!Number.isFinite(average) || !Number.isFinite(sample) || Number(sample) < 1) return current;
    const reliability = Math.min(0.4, Number(sample) / (Number(sample) + 12) * 0.4);
    return this.blend(current || prior, Number(average), reliability);
  }

  private recentRates(fixtures: PredictionFixtureCore[], teamId: string, kickoff: number, limit: number): { matches: number; scored: number; conceded: number } {
    const rows = fixtures.filter((item) => this.isValidCompletedBefore(item, kickoff)
      && (item.homeTeamId === teamId || item.awayTeamId === teamId))
      .sort((a, b) => b.fixtureDate.getTime() - a.fixtureDate.getTime())
      .slice(0, limit);
    if (!rows.length) return { matches: 0, scored: 0, conceded: 0 };
    const scored = rows.reduce((sum, row) => sum + (row.homeTeamId === teamId ? row.homeScore! : row.awayScore!), 0) / rows.length;
    const conceded = rows.reduce((sum, row) => sum + (row.homeTeamId === teamId ? row.awayScore! : row.homeScore!), 0) / rows.length;
    return { matches: rows.length, scored, conceded };
  }

  private formRates(results: SportsTeamFormRecord['results']): { matches: number; scored: number; conceded: number } {
    const rows = results.filter((item) => Number.isFinite(item.goalsFor) && Number.isFinite(item.goalsAgainst));
    if (!rows.length) return { matches: 0, scored: 0, conceded: 0 };
    return {
      matches: rows.length,
      scored: rows.reduce((sum, item) => sum + item.goalsFor, 0) / rows.length,
      conceded: rows.reduce((sum, item) => sum + item.goalsAgainst, 0) / rows.length,
    };
  }

  private standingStrength(context: PredictionMatchContext): { homePpg: number; awayPpg: number } | null {
    const rows = context.standings?.entries ?? [];
    const home = rows.find((item) => item.teamId === context.fixture.homeTeamId);
    const away = rows.find((item) => item.teamId === context.fixture.awayTeamId);
    if (!home || !away || home.played < 1 || away.played < 1) return null;
    return { homePpg: home.points / home.played, awayPpg: away.points / away.played };
  }

  private readHeadToHead(context: PredictionMatchContext, kickoff: number): { matches: number; homeGoals: number; awayGoals: number } {
    const meetings = new Map<string, { date: number; home: number; away: number }>();
    for (const item of context.headToHead?.matches ?? []) {
      const date = new Date(item.kickoffAt).getTime();
      if (!Number.isFinite(date) || date >= kickoff) continue;
      const home = item.homeTeamId === context.fixture.homeTeamId ? item.homeScore : item.awayTeamId === context.fixture.homeTeamId ? item.awayScore : undefined;
      const away = item.homeTeamId === context.fixture.awayTeamId ? item.homeScore : item.awayTeamId === context.fixture.awayTeamId ? item.awayScore : undefined;
      if (home === undefined || away === undefined) continue;
      meetings.set(item.fixtureId || `${date}`, { date, home, away });
    }
    for (const row of context.historicalFixtures) {
      if (!this.isValidCompletedBefore(row, kickoff)) continue;
      if (!((row.homeTeamId === context.fixture.homeTeamId && row.awayTeamId === context.fixture.awayTeamId)
        || (row.homeTeamId === context.fixture.awayTeamId && row.awayTeamId === context.fixture.homeTeamId))) continue;
      const home = row.homeTeamId === context.fixture.homeTeamId ? row.homeScore! : row.awayScore!;
      const away = row.homeTeamId === context.fixture.awayTeamId ? row.homeScore! : row.awayScore!;
      meetings.set(row.eventId, { date: row.fixtureDate.getTime(), home, away });
    }
    const recent = [...meetings.values()].sort((a, b) => b.date - a.date).slice(0, PREDICTION_ENGINE_CONFIG.model.maximumHeadToHeadMatches);
    return {
      matches: recent.length,
      homeGoals: recent.length ? recent.reduce((sum, item) => sum + item.home, 0) / recent.length : 0,
      awayGoals: recent.length ? recent.reduce((sum, item) => sum + item.away, 0) / recent.length : 0,
    };
  }

  private shrink(observed: number, sample: number, baseline: number, priorMatches: number): number {
    if (sample <= 0) return baseline;
    const weight = sample / (sample + priorMatches);
    return observed * weight + baseline * (1 - weight);
  }

  private blend(base: number, observed: number, weight: number): number {
    return base * (1 - weight) + observed * weight;
  }
}
