import { Injectable } from '@nestjs/common';
import {
  PredictionMatchContext,
  ExpectedGoalsModel,
} from '../interfaces/espn-prediction-context.interface';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { PredictionMathUtil } from '../utils/prediction-math.util';
import { EspnPayloadUtil } from '../utils/espn-payload.util';

interface TeamGoalStats {
  scored: number[];
  conceded: number[];
  homeScored: number[];
  homeConceded: number[];
  awayScored: number[];
  awayConceded: number[];
}

interface RecentTeamGoalStats {
  scored: number[];
  conceded: number[];
}

interface StandingStrength {
  pointsPerGame: number;
  source: string;
}

@Injectable()
export class ExpectedGoalsService {
  estimate(context: PredictionMatchContext): ExpectedGoalsModel {
    const config = PREDICTION_ENGINE_CONFIG.model;
    // Only completed matches before this fixture may contribute to the model.
    // This protects historical re-runs from accidentally using future results.
    const completedLeague = context.leagueFixtures
      .filter(
        (fixture) =>
          fixture.fixtureDate < context.fixture.fixtureDate &&
          fixture.completed &&
          Number.isFinite(fixture.homeScore) &&
          Number.isFinite(fixture.awayScore),
      )
      .sort((a, b) => b.fixtureDate.getTime() - a.fixtureDate.getTime())
      .slice(0, config.leagueMatches);

    // League rates are a prior, not a raw average to trust after one or two
    // completed fixtures. Shrink the observed league mean toward conservative
    // defaults so a single unusual scoreline cannot distort every market.
    const leaguePriorMatches = config.leaguePriorMatches;
    const leagueHomeGoalsTotal = completedLeague.reduce(
      (total, fixture) => total + fixture.homeScore!, 0,
    );
    const leagueAwayGoalsTotal = completedLeague.reduce(
      (total, fixture) => total + fixture.awayScore!, 0,
    );
    const leagueHomeAverage =
      (leagueHomeGoalsTotal + config.defaultLeagueHomeGoals * leaguePriorMatches)
      / (completedLeague.length + leaguePriorMatches);
    const leagueAwayAverage =
      (leagueAwayGoalsTotal + config.defaultLeagueAwayGoals * leaguePriorMatches)
      / (completedLeague.length + leaguePriorMatches);

    const homeStats = this.teamGoalStats(context, context.fixture.homeTeamId);
    const awayStats = this.teamGoalStats(context, context.fixture.awayTeamId);
    const homeScored =
      homeStats.homeScored.length >= 2
        ? homeStats.homeScored
        : homeStats.scored;
    const homeAttackAverage =
      homeScored.length > 0
        ? homeScored.reduce((total, goals) => total + goals, 0) /
          homeScored.length
        : undefined;
    // Shrink small team samples toward the league baseline. A single unusually
    // high-scoring match should not dominate the expected-goals estimate.
    let homeAttack =
      homeAttackAverage === undefined
        ? leagueHomeAverage
        : this.shrinkTowardBaseline(
            homeAttackAverage,
            homeScored.length,
            leagueHomeAverage,
          );
    const homeConceded =
      homeStats.homeConceded.length >= 2
        ? homeStats.homeConceded
        : homeStats.conceded;
    const homeConcedeAverage =
      homeConceded.length > 0
        ? homeConceded.reduce((total, goals) => total + goals, 0) /
          homeConceded.length
        : undefined;
    let homeConcede =
      homeConcedeAverage === undefined
        ? leagueAwayAverage
        : this.shrinkTowardBaseline(
            homeConcedeAverage,
            homeConceded.length,
            leagueAwayAverage,
          );
    const awayScored =
      awayStats.awayScored.length >= 2
        ? awayStats.awayScored
        : awayStats.scored;
    const awayAttackAverage =
      awayScored.length > 0
        ? awayScored.reduce((total, goals) => total + goals, 0) /
          awayScored.length
        : undefined;
    let awayAttack =
      awayAttackAverage === undefined
        ? leagueAwayAverage
        : this.shrinkTowardBaseline(
            awayAttackAverage,
            awayScored.length,
            leagueAwayAverage,
          );
    const awayConceded =
      awayStats.awayConceded.length >= 2
        ? awayStats.awayConceded
        : awayStats.conceded;
    const awayConcedeAverage =
      awayConceded.length > 0
        ? awayConceded.reduce((total, goals) => total + goals, 0) /
          awayConceded.length
        : undefined;
    let awayConcede =
      awayConcedeAverage === undefined
        ? leagueHomeAverage
        : this.shrinkTowardBaseline(
            awayConcedeAverage,
            awayConceded.length,
            leagueHomeAverage,
          );

    const recentHome = this.readRecentTeamGoalStats(
      context,
      context.fixture.homeTeamId,
    );
    const recentAway = this.readRecentTeamGoalStats(
      context,
      context.fixture.awayTeamId,
    );
    const homeRecentWeight = Math.min(
      0.3,
      (recentHome.scored.length / config.recentFormMatchesPerTeam) * 0.3,
    );
    const awayRecentWeight = Math.min(
      0.3,
      (recentAway.scored.length / config.recentFormMatchesPerTeam) * 0.3,
    );

    if (recentHome.scored.length >= 2) {
      homeAttack = this.blend(
        homeAttack,
        recentHome.scored.reduce((total, goals) => total + goals, 0) /
          recentHome.scored.length,
        homeRecentWeight,
      );
      homeConcede = this.blend(
        homeConcede,
        recentHome.conceded.reduce((total, goals) => total + goals, 0) /
          recentHome.conceded.length,
        homeRecentWeight,
      );
    }
    if (recentAway.scored.length >= 2) {
      awayAttack = this.blend(
        awayAttack,
        recentAway.scored.reduce((total, goals) => total + goals, 0) /
          recentAway.scored.length,
        awayRecentWeight,
      );
      awayConcede = this.blend(
        awayConcede,
        recentAway.conceded.reduce((total, goals) => total + goals, 0) /
          recentAway.conceded.length,
        awayRecentWeight,
      );
    }

    const leagueHome = Math.max(0.2, leagueHomeAverage);
    const leagueAway = Math.max(0.2, leagueAwayAverage);
    const homeAttackStrength = homeAttack / leagueHome;
    const awayDefenceWeakness = awayConcede / leagueHome;
    const awayAttackStrength = awayAttack / leagueAway;
    const homeDefenceWeakness = homeConcede / leagueAway;

    // Standard independent-Poisson attack/defence estimate, softly shrunk toward the league baseline.
    let lambdaHome =
      leagueHome *
      Math.pow(homeAttackStrength, 0.55) *
      Math.pow(awayDefenceWeakness, 0.45);
    let lambdaAway =
      leagueAway *
      Math.pow(awayAttackStrength, 0.55) *
      Math.pow(homeDefenceWeakness, 0.45);

    const h2h = this.readHeadToHead(context);
    if (h2h.matches >= 2) {
      // H2H is a small, bounded secondary signal. Historical meetings are
      // deduplicated by fixture date and the actual home/away team identities.
      lambdaHome = lambdaHome * 0.88 + h2h.homeGoals * 0.12;
      lambdaAway = lambdaAway * 0.88 + h2h.awayGoals * 0.12;
    } else if (h2h.matches === 1) {
      // One meeting contributes only a 4% nudge; it is not strong enough to
      // steer the expected-goals rate by itself.
      lambdaHome = lambdaHome * 0.96 + h2h.homeGoals * 0.04;
      lambdaAway = lambdaAway * 0.96 + h2h.awayGoals * 0.04;
    }

    const homeStanding = this.readStandingStrength(
      context,
      context.fixture.homeTeamId,
      context.homeTeam.name,
    );
    const awayStanding = this.readStandingStrength(
      context,
      context.fixture.awayTeamId,
      context.awayTeam.name,
    );

    const homeEvidenceSamples = Math.max(homeStats.scored.length, recentHome.scored.length);
    const awayEvidenceSamples = Math.max(awayStats.scored.length, recentAway.scored.length);
    const standingsStrengthAvailable = Boolean(homeStanding && awayStanding);
    const independentEvidenceAvailable =
      homeEvidenceSamples > 0
      || awayEvidenceSamples > 0
      || completedLeague.length > 0
      || h2h.matches > 0
      || standingsStrengthAvailable;
    const evidenceLevel: ExpectedGoalsModel['evidenceLevel'] =
      !independentEvidenceAvailable
        ? 'INSUFFICIENT'
        : homeEvidenceSamples >= config.minimumHistoricalMatchesPerTeam
          && awayEvidenceSamples >= config.minimumHistoricalMatchesPerTeam
          && completedLeague.length >= 20
          ? 'STRONG'
          : 'PARTIAL';

    const evidence: string[] = [
      `Completed pre-kickoff team samples: home ${homeEvidenceSamples}, away ${awayEvidenceSamples}.`,
      `Completed league score sample: ${completedLeague.length}; target ${config.leagueMatches} maximum.`,
      `League scoring rates are regularized toward prior averages using ${leaguePriorMatches} pseudo-matches.`,
    ];

    if (recentHome.scored.length > 0) {
      evidence.push(
        `Home-team recent form reconstructed from ${recentHome.scored.length} unique dated completed matches (historical fixtures first; ESPN last-five payload supplements missing records).`,
      );
    }
    if (recentAway.scored.length > 0) {
      evidence.push(
        `Away-team recent form reconstructed from ${recentAway.scored.length} unique dated completed matches (historical fixtures first; ESPN last-five payload supplements missing records).`,
      );
    }
    if (h2h.matches > 0) {
      evidence.push(
        `Found ${h2h.matches} unique completed head-to-head meetings before kickoff${h2h.matches >= 2 ? '; the average was blended as a bounded secondary signal.' : '; one meeting contributed only a 4% regularized adjustment.'}`,
      );
    }
    if (homeStanding && awayStanding) {
      const standingGap =
        homeStanding.pointsPerGame - awayStanding.pointsPerGame;
      const adjustment = PredictionMathUtil.clamp(
        standingGap * 0.035,
        -0.12,
        0.12,
      );
      lambdaHome *= Math.exp(adjustment);
      lambdaAway *= Math.exp(-adjustment * 0.5);
      evidence.push(
        `ESPN standings strength was applied as a bounded adjustment (${homeStanding.source}; ${awayStanding.source}).`,
      );
    } else {
      evidence.push(
        'Usable points-per-game standings were not matched for both teams; no standings adjustment was applied.',
      );
    }

    if (!independentEvidenceAvailable) {
      evidence.push(
        'INSUFFICIENT INDEPENDENT EVIDENCE: no dated team scores, league score observations, usable historical head-to-head scores, or matched standings strength were available. The default goal rates below are diagnostic priors only; score-matrix and period-market probabilities must be marked unavailable.',
      );
    } else if (evidenceLevel === 'PARTIAL') {
      evidence.push(
        'PARTIAL EVIDENCE: the model is allowed to calculate supported markets, but sparse team/league samples remain reflected in data quality and confidence; no confidence padding is applied.',
      );
    } else {
      evidence.push(
        'STRONG CORE EVIDENCE: each team has the configured minimum historical sample and at least 20 league results are available.',
      );
    }

    lambdaHome = PredictionMathUtil.clamp(
      lambdaHome,
      config.minimumExpectedGoals,
      config.maximumExpectedGoals,
    );
    lambdaAway = PredictionMathUtil.clamp(
      lambdaAway,
      config.minimumExpectedGoals,
      config.maximumExpectedGoals,
    );

    return {
      home: Number(lambdaHome.toFixed(4)),
      away: Number(lambdaAway.toFixed(4)),
      leagueHomeAverage: Number(leagueHomeAverage.toFixed(4)),
      leagueAwayAverage: Number(leagueAwayAverage.toFixed(4)),
      homeSamples: homeEvidenceSamples,
      awaySamples: awayEvidenceSamples,
      leagueSamples: completedLeague.length,
      calculationMethod:
        'Independent Poisson goal model using venue-aware historical team attack/defence rates and regularized league baselines; recent form is reconstructed from unique prior fixtures and head-to-head remains a bounded secondary blend.',
      independentEvidenceAvailable,
      evidenceLevel,
      historicalHeadToHeadMatches: h2h.matches,
      homeRecentFormSamples: recentHome.scored.length,
      awayRecentFormSamples: recentAway.scored.length,
      standingsStrengthAvailable,
      evidence,
    };
  }

  private teamGoalStats(
    context: PredictionMatchContext,
    teamId: string,
  ): TeamGoalStats {
    const candidates = context.historicalFixtures
      .filter(
        (fixture) =>
          fixture.fixtureDate < context.fixture.fixtureDate &&
          fixture.completed &&
          Number.isFinite(fixture.homeScore) &&
          Number.isFinite(fixture.awayScore) &&
          (fixture.homeTeamId === teamId || fixture.awayTeamId === teamId),
      )
      .sort((a, b) => b.fixtureDate.getTime() - a.fixtureDate.getTime());
    const sameCompetition = candidates.filter(
      (fixture) => String(fixture.leagueId).toLowerCase() === String(context.fixture.leagueId).toLowerCase(),
    );
    const preferredRecords = sameCompetition.length >= 3 ? sameCompetition : candidates;
    const records = preferredRecords.slice(0, PREDICTION_ENGINE_CONFIG.model.historicalMatchesPerTeam);

    const result: TeamGoalStats = {
      scored: [],
      conceded: [],
      homeScored: [],
      homeConceded: [],
      awayScored: [],
      awayConceded: [],
    };
    for (const match of records) {
      if (match.homeTeamId === teamId) {
        result.scored.push(match.homeScore!);
        result.conceded.push(match.awayScore!);
        result.homeScored.push(match.homeScore!);
        result.homeConceded.push(match.awayScore!);
      } else {
        result.scored.push(match.awayScore!);
        result.conceded.push(match.homeScore!);
        result.awayScored.push(match.awayScore!);
        result.awayConceded.push(match.homeScore!);
      }
    }
    return result;
  }

  private readRecentTeamGoalStats(
    context: PredictionMatchContext,
    teamId: string,
  ): RecentTeamGoalStats {
    type FormObservation = {
      eventId: string;
      date: Date;
      scored: number;
      conceded: number;
    };
    const observations = new Map<string, FormObservation>();
    const kickoff = context.fixture.fixtureDate.getTime();

    // The stored ESPN fixture history is the primary source. This keeps recent
    // form available when the target fixture has no Summary at all.
    for (const fixture of context.historicalFixtures ?? []) {
      if (
        !(fixture.fixtureDate instanceof Date)
        || !Number.isFinite(fixture.fixtureDate.getTime())
        || fixture.fixtureDate.getTime() >= kickoff
        || fixture.completed !== true
        || !Number.isFinite(fixture.homeScore)
        || !Number.isFinite(fixture.awayScore)
      ) continue;

      let scored: number;
      let conceded: number;
      if (fixture.homeTeamId === teamId) {
        scored = fixture.homeScore!;
        conceded = fixture.awayScore!;
      } else if (fixture.awayTeamId === teamId) {
        scored = fixture.awayScore!;
        conceded = fixture.homeScore!;
      } else {
        continue;
      }

      // Prefer day-level fixture identity here. ESPN's stored kickoff timestamp
      // and the Summary event timestamp can differ slightly even for the same match.
      const key = `${fixture.fixtureDate.toISOString().slice(0, 10)}-${fixture.homeTeamId}-${fixture.awayTeamId}`;
      observations.set(key, {
        eventId: String(fixture.eventId ?? key),
        date: fixture.fixtureDate,
        scored,
        conceded,
      });
    }

    // A Summary payload can supplement historical fixtures that have not been
    // saved locally. It must be dated, completed, score-bearing and unique.
    const historicalEventIds = new Set(
      (context.historicalFixtures ?? [])
        .map((fixture) => String(fixture.eventId ?? '').trim())
        .filter(Boolean),
    );
    for (const blockValue of EspnPayloadUtil.asArray(context.summary.lastFiveGames)) {
      const block = EspnPayloadUtil.asRecord(blockValue);
      const team = EspnPayloadUtil.asRecord(block.team);
      const blockTeamId = String(team.id ?? block.teamId ?? block.id ?? '');
      if (blockTeamId !== teamId) continue;

      for (const eventValue of EspnPayloadUtil.asArray(block.events)) {
        const event = EspnPayloadUtil.asRecord(eventValue);
        const eventDate = EspnPayloadUtil.toValidDate(event.gameDate ?? event.date);
        if (!eventDate || eventDate.getTime() >= kickoff) continue;
        const summaryEventId = String(event.id ?? '').trim();
        if (summaryEventId && historicalEventIds.has(summaryEventId)) continue;

        const status = EspnPayloadUtil.asRecord(event.status);
        const statusType = EspnPayloadUtil.asRecord(status.type);
        if (statusType.completed === false || statusType.state === 'pre' || statusType.state === 'in') continue;

        const homeId = String(event.homeTeamId ?? '');
        const awayId = String(event.awayTeamId ?? '');
        const homeScore = EspnPayloadUtil.finiteNumber(event.homeTeamScore ?? event.homeScore);
        const awayScore = EspnPayloadUtil.finiteNumber(event.awayTeamScore ?? event.awayScore);
        if (homeScore === null || awayScore === null) continue;

        let scored: number;
        let conceded: number;
        if (homeId === teamId) {
          scored = homeScore;
          conceded = awayScore;
        } else if (awayId === teamId) {
          scored = awayScore;
          conceded = homeScore;
        } else {
          continue;
        }

        const key = `${eventDate.toISOString().slice(0, 10)}-${homeId}-${awayId}`;
        if (observations.has(key)) continue;
        observations.set(key, { eventId: summaryEventId || key, date: eventDate, scored, conceded });
      }
    }

    const recent = [...observations.values()]
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, PREDICTION_ENGINE_CONFIG.model.recentFormMatchesPerTeam);
    return {
      scored: recent.map((item) => item.scored),
      conceded: recent.map((item) => item.conceded),
    };
  }

  private readStandingStrength(
    context: PredictionMatchContext,
    teamId: string,
    teamName: string,
  ): StandingStrength | null {
    // Standings now live in their own collection as the complete, untouched
    // ESPN response. Do not read the legacy summary.standings representation.
    const root = context.standingsPayload;
    if (!root) return null;

    type StandingCandidate = {
      entry: Record<string, any>;
      tableEntries: Record<string, any>[];
    };

    const candidates: StandingCandidate[] = [];
    const visited = new Set<object>();

    const visit = (value: unknown, depth = 0): void => {
      if (depth > 12 || !value || typeof value !== 'object') return;
      if (visited.has(value as object)) return;
      visited.add(value as object);

      const node = EspnPayloadUtil.asRecord(value);
      const standings = EspnPayloadUtil.asRecord(node.standings);
      const entries = EspnPayloadUtil.asArray(standings.entries)
        .map((entry) => EspnPayloadUtil.asRecord(entry))
        .filter((entry) => Object.keys(entry).length > 0);

      if (entries.length) {
        for (const entry of entries) candidates.push({ entry, tableEntries: entries });
      }

      for (const child of EspnPayloadUtil.asArray(node.children)) {
        visit(child, depth + 1);
      }
    };

    visit(root);

    const normalizedName = EspnPayloadUtil.normalizeKey(teamName);
    const matched = candidates.find(({ entry }) => {
      const team = EspnPayloadUtil.asRecord(entry.team);
      const identifiers = [
        entry.id,
        entry.teamId,
        team.id,
        team.uid,
      ]
        .filter((value) => value !== null && value !== undefined)
        .map(String);

      if (identifiers.includes(teamId)) return true;

      const names = [
        team.displayName,
        team.name,
        team.shortDisplayName,
        team.abbreviation,
        entry.displayName,
        entry.name,
      ]
        .filter((value) => typeof value === 'string')
        .map((value) => EspnPayloadUtil.normalizeKey(String(value)));

      return Boolean(normalizedName && names.includes(normalizedName));
    });

    if (!matched) return null;

    const entry = matched.entry;
    const stats = [
      ...EspnPayloadUtil.asArray(entry.stats),
      ...EspnPayloadUtil.asArray(entry.statistics),
    ].map((value) => EspnPayloadUtil.asRecord(value));

    const readStat = (aliases: string[]): number | null => {
      const normalizedAliases = new Set(
        aliases.map((alias) => EspnPayloadUtil.normalizeKey(alias)),
      );

      for (const stat of stats) {
        const keys = [
          stat.name,
          stat.abbreviation,
          stat.displayName,
          stat.shortDisplayName,
          stat.type,
        ]
          .filter((value) => typeof value === 'string')
          .map((value) => EspnPayloadUtil.normalizeKey(String(value)));

        if (!keys.some((key) => normalizedAliases.has(key))) continue;

        const number = EspnPayloadUtil.finiteNumber(
          stat.value ?? stat.displayValue ?? stat.summary,
        );
        if (number !== null) return number;
      }

      return null;
    };

    const directPointsPerGame = readStat([
      'pointsPerGame',
      'points per game',
      'PPG',
    ]);
    const points = readStat(['points', 'PTS']);
    const gamesPlayed = readStat([
      'gamesPlayed',
      'games played',
      'played',
      'GP',
      'MP',
    ]);
    const goalDifference = readStat([
      'goalDifference',
      'goal difference',
      'goalDiff',
      'pointDifferential',
      'GD',
    ]);

    let pointsPerGame = directPointsPerGame;
    if (
      pointsPerGame === null &&
      points !== null &&
      gamesPlayed !== null &&
      gamesPlayed > 0
    ) {
      pointsPerGame = points / gamesPlayed;
    }

    if (pointsPerGame === null || !Number.isFinite(pointsPerGame)) {
      // A rank-only fallback creates a synthetic points scale and can distort
      // expected goals. If the full payload has no usable points evidence, skip
      // the standings adjustment instead of inventing a strength value.
      return null;
    }

    if (
      goalDifference !== null &&
      gamesPlayed !== null &&
      gamesPlayed > 0
    ) {
      pointsPerGame += (goalDifference / gamesPlayed) * 0.15;
    }

    return {
      pointsPerGame,
      source: 'complete ESPN standings payload points-per-game statistics',
    };
  }

  private shrinkTowardBaseline(
    observedAverage: number,
    sampleSize: number,
    baseline: number,
  ): number {
    const priorMatches = 5;
    const sampleWeight = sampleSize / (sampleSize + priorMatches);
    return observedAverage * sampleWeight + baseline * (1 - sampleWeight);
  }

  private blend(base: number, recent: number, recentWeight: number): number {
    return base * (1 - recentWeight) + recent * recentWeight;
  }

  private readHeadToHead(context: PredictionMatchContext): {
    matches: number;
    homeGoals: number;
    awayGoals: number;
  } {
    type Meeting = { eventId: string; date: Date; homeGoals: number; awayGoals: number };
    const meetings = new Map<string, Meeting>();
    const historicalEventIds = new Set<string>();
    const targetHome = context.fixture.homeTeamId;
    const targetAway = context.fixture.awayTeamId;
    const kickoff = context.fixture.fixtureDate.getTime();

    const addOrientedMeeting = (
      eventId: string,
      date: Date,
      actualHomeId: string,
      actualAwayId: string,
      actualHomeGoals: number,
      actualAwayGoals: number,
    ) => {
      if (date.getTime() >= kickoff) return;
      if (actualHomeId === targetHome && actualAwayId === targetAway) {
        meetings.set(eventId, { eventId, date, homeGoals: actualHomeGoals, awayGoals: actualAwayGoals });
      } else if (actualHomeId === targetAway && actualAwayId === targetHome) {
        meetings.set(eventId, { eventId, date, homeGoals: actualAwayGoals, awayGoals: actualHomeGoals });
      }
    };

    for (const fixture of context.historicalFixtures ?? []) {
      if (
        !(fixture.fixtureDate instanceof Date)
        || !Number.isFinite(fixture.fixtureDate.getTime())
        || !fixture.completed
        || !Number.isFinite(fixture.homeScore)
        || !Number.isFinite(fixture.awayScore)
      ) continue;
      if (!(
        (fixture.homeTeamId === targetHome && fixture.awayTeamId === targetAway)
        || (fixture.homeTeamId === targetAway && fixture.awayTeamId === targetHome)
      )) continue;
      const key = `${fixture.fixtureDate.toISOString().slice(0, 10)}-${fixture.homeTeamId}-${fixture.awayTeamId}`;
      if (fixture.eventId) historicalEventIds.add(String(fixture.eventId));
      addOrientedMeeting(key, fixture.fixtureDate, fixture.homeTeamId, fixture.awayTeamId, fixture.homeScore!, fixture.awayScore!);
    }

    // The target fixture's Summary is supplemental only. Historical documents
    // win on duplicates, avoiding the same meeting being counted twice.
    for (const blockValue of EspnPayloadUtil.asArray(context.summary.seasonseries)) {
      const events = EspnPayloadUtil.asArray(EspnPayloadUtil.asRecord(blockValue).events);
      for (const eventValue of events) {
        const record = EspnPayloadUtil.asRecord(eventValue);
        const eventDate = EspnPayloadUtil.toValidDate(record.gameDate ?? record.date);
        if (!eventDate || eventDate.getTime() >= kickoff) continue;
        const summaryEventId = String(record.id ?? '').trim();
        if (summaryEventId && historicalEventIds.has(summaryEventId)) continue;
        const status = EspnPayloadUtil.asRecord(record.status);
        const statusType = EspnPayloadUtil.asRecord(status.type);
        if (statusType.completed === false || statusType.state === 'pre' || statusType.state === 'in') continue;
        const competitors = EspnPayloadUtil.asArray(record.competitors);
        const home = competitors.find((item) => EspnPayloadUtil.asRecord(item).homeAway === 'home');
        const away = competitors.find((item) => EspnPayloadUtil.asRecord(item).homeAway === 'away');
        const homeRecord = EspnPayloadUtil.asRecord(home);
        const awayRecord = EspnPayloadUtil.asRecord(away);
        const actualHomeId = String(EspnPayloadUtil.asRecord(homeRecord.team).id ?? homeRecord.id ?? '');
        const actualAwayId = String(EspnPayloadUtil.asRecord(awayRecord.team).id ?? awayRecord.id ?? '');
        const homeGoals = EspnPayloadUtil.finiteNumber(homeRecord.score);
        const awayGoals = EspnPayloadUtil.finiteNumber(awayRecord.score);
        if (homeGoals === null || awayGoals === null) continue;
        if (!(
          (actualHomeId === targetHome && actualAwayId === targetAway)
          || (actualHomeId === targetAway && actualAwayId === targetHome)
        )) continue;
        const key = `${eventDate.toISOString().slice(0, 10)}-${actualHomeId}-${actualAwayId}`;
        if (meetings.has(key)) continue;
        addOrientedMeeting(key, eventDate, actualHomeId, actualAwayId, homeGoals, awayGoals);
      }
    }

    const recent = [...meetings.values()]
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, PREDICTION_ENGINE_CONFIG.model.maximumHeadToHeadMatches);
    return {
      matches: recent.length,
      homeGoals: recent.length > 0
        ? recent.reduce((total, item) => total + item.homeGoals, 0) / recent.length
        : 0,
      awayGoals: recent.length > 0
        ? recent.reduce((total, item) => total + item.awayGoals, 0) / recent.length
        : 0,
    };
  }

}

