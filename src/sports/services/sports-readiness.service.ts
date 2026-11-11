import { Injectable } from '@nestjs/common';

import type {
  SportsFixtureReadiness,
  SportsReadinessMeasure,
  SportsStatisticReadiness,
  SportsEventReadiness,
} from '../interfaces/sports-readiness.interface';
import type {
  SportsCompetitionScoringTotalsRecord,
  SportsHeadToHeadRecord,
  SportsTeamHomeAwayRecord,
  SportsTeamScoringRecord,
  SportsTeamStatisticsAggregateRecord,
} from '../interfaces/sports-derived-data.interface';
import type { SportsMatchReadModel, SportsTeamReadModel } from '../interfaces/sports-read.interface';
import { SportsDomainReadService } from './sports-domain-read.service';

type PlainRecord = Record<string, any>;
type StatisticValue = { average: number; sampleSize: number } | null;

const MINIMUM_HISTORICAL_SAMPLE = 5;
const MINIMUM_STATISTIC_SAMPLE = 5;
const MINIMUM_RED_CARD_SAMPLE = 8;
const MINIMUM_EVENT_TIMELINE_SAMPLE = 8;
const MINIMUM_EVENT_TIMELINE_COVERAGE = 0.65;
const MINIMUM_DATA_QUALITY = 0.62;

/** Preloaded normalized Sports facts shared by Odds and the readiness evaluator. */
export interface SportsReadinessSourceContext {
  match: SportsMatchReadModel;
  homeScoring: SportsTeamScoringRecord | null;
  awayScoring: SportsTeamScoringRecord | null;
  homeAway: SportsTeamHomeAwayRecord | null;
  awayAway: SportsTeamHomeAwayRecord | null;
  competitionScoring: SportsCompetitionScoringTotalsRecord | null;
  homeStatistics: SportsTeamStatisticsAggregateRecord | null;
  awayStatistics: SportsTeamStatisticsAggregateRecord | null;
  homeTeamData: SportsTeamReadModel | null;
  awayTeamData: SportsTeamReadModel | null;
  headToHead: SportsHeadToHeadRecord | null;
}

const STATISTIC_ALIASES: Record<string, string[]> = {
  corners: ['corners', 'woncorners', 'cornerkicks', 'cornerkickswon', 'totalcorners'],
  shots: ['shots', 'totalshots', 'shotsattempted'],
  shotsOnTarget: ['shotsontarget', 'shotsongoal', 'ontargetattempts'],
  yellowCards: ['yellowcards', 'yellowcard'],
  redCards: ['redcards', 'redcard'],
  fouls: ['fouls', 'foulscommitted', 'totalfouls'],
  offsides: ['offsides', 'offside'],
};

const normalizeKey = (value: unknown): string =>
  String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

@Injectable()
export class SportsReadinessService {
  constructor(private readonly sportsRead: SportsDomainReadService) {}

  /**
   * Returns Sports-owned evidence coverage for one fixture. This method does
   * not collect provider data, calculate projections, or create prices.
   */
  async getFixtureReadiness(
    fixtureId: string,
    sourceContext?: SportsReadinessSourceContext,
  ): Promise<SportsFixtureReadiness | null> {
    const id = String(fixtureId ?? '').trim();
    if (!id) return null;

    const match = sourceContext?.match ?? await this.sportsRead.getMatch(id);
    if (!match || String(match.fixture.id) !== id) return null;

    const fixture = match.fixture;
    const home = fixture.competitors?.find((competitor) => competitor.homeAway === 'HOME');
    const away = fixture.competitors?.find((competitor) => competitor.homeAway === 'AWAY');
    if (!home?.teamId || !away?.teamId) return null;

    const seasonId = fixture.seasonId;
    const source = sourceContext
      ? [
          sourceContext.homeScoring,
          sourceContext.awayScoring,
          sourceContext.homeAway,
          sourceContext.awayAway,
          sourceContext.competitionScoring,
          sourceContext.homeStatistics,
          sourceContext.awayStatistics,
          sourceContext.homeTeamData,
          sourceContext.awayTeamData,
          sourceContext.headToHead,
        ] as const
      : await Promise.all([
          seasonId
            ? this.sportsRead.getTeamScoringRecord(home.teamId, fixture.competitionId, seasonId, 'HOME')
            : Promise.resolve(null),
          seasonId
            ? this.sportsRead.getTeamScoringRecord(away.teamId, fixture.competitionId, seasonId, 'AWAY')
            : Promise.resolve(null),
          seasonId
            ? this.sportsRead.getTeamHomeAwayRecord(home.teamId, fixture.competitionId, seasonId)
            : Promise.resolve(null),
          seasonId
            ? this.sportsRead.getTeamHomeAwayRecord(away.teamId, fixture.competitionId, seasonId)
            : Promise.resolve(null),
          seasonId
            ? this.sportsRead.getCompetitionScoringTotals(fixture.competitionId, seasonId)
            : Promise.resolve(null),
          seasonId
            ? this.sportsRead.getTeamStatisticsAggregate(home.teamId, fixture.competitionId, seasonId, 'HOME')
            : Promise.resolve(null),
          seasonId
            ? this.sportsRead.getTeamStatisticsAggregate(away.teamId, fixture.competitionId, seasonId, 'AWAY')
            : Promise.resolve(null),
          this.sportsRead.getTeamData(home.teamId, 40, fixture.competitionId, seasonId),
          this.sportsRead.getTeamData(away.teamId, 40, fixture.competitionId, seasonId),
          this.sportsRead.getHeadToHead(home.teamId, away.teamId, fixture.competitionId),
        ]);
    const [
      homeScoring,
      awayScoring,
      homeAway,
      awayAway,
      competitionScoring,
      homeStatistics,
      awayStatistics,
      homeTeamData,
      awayTeamData,
      headToHead,
    ] = source;

    const homeSamples = Math.max(
      this.number(homeScoring?.fixturesPlayed) ?? 0,
      this.number(homeAway?.home?.played) ?? 0,
    );
    const awaySamples = Math.max(
      this.number(awayScoring?.fixturesPlayed) ?? 0,
      this.number(awayAway?.away?.played) ?? 0,
    );
    const sampleSize = Math.min(homeSamples, awaySamples);

    const homeAttack = this.valueOrUndefined(
      this.number(homeAway?.home?.played) !== null && (this.number(homeAway?.home?.played) ?? 0) >= 3
        ? this.divide(homeAway?.home?.goalsFor, homeAway?.home?.played)
        : homeScoring?.averageGoalsFor,
    );
    const awayDefence = this.valueOrUndefined(
      this.number(awayAway?.away?.played) !== null && (this.number(awayAway?.away?.played) ?? 0) >= 3
        ? this.divide(awayAway?.away?.goalsAgainst, awayAway?.away?.played)
        : awayScoring?.averageGoalsAgainst,
    );
    const awayAttack = this.valueOrUndefined(
      this.number(awayAway?.away?.played) !== null && (this.number(awayAway?.away?.played) ?? 0) >= 3
        ? this.divide(awayAway?.away?.goalsFor, awayAway?.away?.played)
        : awayScoring?.averageGoalsFor,
    );
    const homeDefence = this.valueOrUndefined(
      this.number(homeAway?.home?.played) !== null && (this.number(homeAway?.home?.played) ?? 0) >= 3
        ? this.divide(homeAway?.home?.goalsAgainst, homeAway?.home?.played)
        : homeScoring?.averageGoalsAgainst,
    );
    const hasHomeGoalInputs = homeAttack !== undefined && awayDefence !== undefined;
    const hasAwayGoalInputs = awayAttack !== undefined && homeDefence !== undefined;

    const h2hSampleSize = Array.isArray(headToHead?.matches) ? headToHead.matches.length : 0;
    const homeRecentSampleSize = this.recentFormSample(homeTeamData, fixture.competitionId);
    const awayRecentSampleSize = this.recentFormSample(awayTeamData, fixture.competitionId);
    const recentFormSampleSize = Math.min(homeRecentSampleSize, awayRecentSampleSize);
    const competitionFixtures = this.number(competitionScoring?.fixturesPlayed) ?? 0;
    const venueProjectionAvailable = Boolean(homeAway && awayAway);
    const competitionProjectionAvailable = Boolean(competitionScoring && competitionFixtures >= 10);

    // Mirrors the score-model quality calculation used by the Odds pricing engine.
    const seasonCoverage = Math.min(1, sampleSize / 10);
    const venueCoverage = venueProjectionAvailable ? 1 : 0;
    const competitionCoverage = competitionProjectionAvailable ? 1 : 0;
    const h2hCoverage = h2hSampleSize >= 3 ? 1 : 0;
    const recentCoverage = homeRecentSampleSize >= 3 && awayRecentSampleSize >= 3 ? 1 : 0;
    const scoreQuality = this.clamp(
      0.35 * seasonCoverage + 0.20 * venueCoverage + 0.20 * competitionCoverage
        + 0.10 * h2hCoverage + 0.15 * recentCoverage,
      0,
      0.96,
    );
    const fixtureEligible = ![
      'POSTPONED', 'CANCELLED', 'CANCELED', 'ABANDONED',
    ].includes(String(fixture.status?.state ?? '').toUpperCase());
    const scoreMatrix = this.measure({
      sampleSize,
      minimumSampleSize: MINIMUM_HISTORICAL_SAMPLE,
      quality: scoreQuality,
      minimumQuality: MINIMUM_DATA_QUALITY,
      hasData: hasHomeGoalInputs && hasAwayGoalInputs,
      reasonWhenMissing: 'Verified home and away scoring inputs are not available.',
      reasonWhenInsufficient: 'The score model has not reached the minimum sample or data-quality threshold.',
      eligible: fixtureEligible,
    }) as SportsFixtureReadiness['scoreMatrix'];
    Object.assign(scoreMatrix, {
      homeSampleSize: homeSamples,
      awaySampleSize: awaySamples,
      hasHomeGoalInputs,
      hasAwayGoalInputs,
      venueProjectionAvailable,
      competitionProjectionAvailable,
      headToHeadSampleSize: h2hSampleSize,
      recentFormSampleSize,
    });

    const homePeriodObservations = this.periodObservationCount(homeTeamData, home.teamId);
    const awayPeriodObservations = this.periodObservationCount(awayTeamData, away.teamId);
    const observedPeriodSplit = homePeriodObservations >= 4 && awayPeriodObservations >= 4;
    const periodQuality = observedPeriodSplit ? scoreQuality : scoreQuality * 0.55;
    const periodMatrix = this.measure({
      sampleSize,
      minimumSampleSize: MINIMUM_HISTORICAL_SAMPLE,
      quality: periodQuality,
      minimumQuality: MINIMUM_DATA_QUALITY,
      hasData: hasHomeGoalInputs && hasAwayGoalInputs,
      reasonWhenMissing: 'Scoring inputs required by the period model are missing.',
      reasonWhenInsufficient: observedPeriodSplit
        ? 'The period model has not reached the minimum sample or data-quality threshold.'
        : 'Both teams need at least four observed first-half score splits.',
      eligible: fixtureEligible,
    }) as SportsFixtureReadiness['periodMatrix'];
    Object.assign(periodMatrix, {
      homePeriodObservations,
      awayPeriodObservations,
      observedPeriodSplit,
    });

    const homeTimelineSamples = this.number(
      (homeScoring?.metrics as PlainRecord | undefined)?.eventMetrics?.matchesWithTimeline,
    ) ?? 0;
    const awayTimelineSamples = this.number(
      (awayScoring?.metrics as PlainRecord | undefined)?.eventMetrics?.matchesWithTimeline,
    ) ?? 0;
    const homeFirstGoalRate = this.number(
      (homeScoring?.metrics as PlainRecord | undefined)?.eventMetrics?.firstGoalRate,
    );
    const awayFirstGoalRate = this.number(
      (awayScoring?.metrics as PlainRecord | undefined)?.eventMetrics?.firstGoalRate,
    );
    const homeLastGoalRate = this.number(
      (homeScoring?.metrics as PlainRecord | undefined)?.eventMetrics?.lastGoalRate,
    );
    const awayLastGoalRate = this.number(
      (awayScoring?.metrics as PlainRecord | undefined)?.eventMetrics?.lastGoalRate,
    );
    const goalOrderAdjustmentSamples = Math.min(homeTimelineSamples, awayTimelineSamples);
    const firstGoalEmpiricalAdjustmentReady = goalOrderAdjustmentSamples >= MINIMUM_EVENT_TIMELINE_SAMPLE
      && homeFirstGoalRate !== null && awayFirstGoalRate !== null;
    const lastGoalEmpiricalAdjustmentReady = goalOrderAdjustmentSamples >= MINIMUM_EVENT_TIMELINE_SAMPLE
      && homeLastGoalRate !== null && awayLastGoalRate !== null;
    const goalOrderMarkets = {
      ...scoreMatrix,
      firstGoalEmpiricalAdjustmentReady,
      lastGoalEmpiricalAdjustmentReady,
      homeTimelineSamples,
      awayTimelineSamples,
    };

    const minimumCompletedStatisticSamples = Math.min(
      this.number(homeStatistics?.fixturesWithStatistics) ?? 0,
      this.number(awayStatistics?.fixturesWithStatistics) ?? 0,
    );
    const statisticKeys = [
      'corners', 'shots', 'shotsOnTarget', 'cards', 'yellowCards', 'redCards', 'fouls', 'offsides',
    ];
    const teamStatistics: Record<string, SportsStatisticReadiness> = {};
    for (const key of statisticKeys) {
      const homeValue = this.statisticValue(homeStatistics, key);
      const awayValue = this.statisticValue(awayStatistics, key);
      const statisticSampleSize = Math.min(homeValue?.sampleSize ?? 0, awayValue?.sampleSize ?? 0);
      const requiredSampleSize = key === 'redCards'
        ? MINIMUM_RED_CARD_SAMPLE
        : MINIMUM_STATISTIC_SAMPLE;
      const dataQuality = this.clamp(
        0.48 + 0.38 * Math.min(1, statisticSampleSize / 10)
          + 0.08 * Math.min(1, minimumCompletedStatisticSamples / 10)
          + (competitionScoring ? 0.06 : 0),
        0,
        0.96,
      );
      const hasData = Boolean(homeValue && awayValue);
      const measure = this.measure({
        sampleSize: statisticSampleSize,
        minimumSampleSize: requiredSampleSize,
        quality: dataQuality,
        minimumQuality: MINIMUM_DATA_QUALITY,
        hasData,
        reasonWhenMissing: `Both teams need verified ${key} statistics.`,
        reasonWhenInsufficient: `${key} statistics have not reached the required sample or data-quality threshold for both teams.`,
        eligible: fixtureEligible,
      });
      teamStatistics[key] = {
        ...measure,
        key,
        homeSampleSize: homeValue?.sampleSize ?? 0,
        awaySampleSize: awayValue?.sampleSize ?? 0,
        homeAverage: homeValue?.average ?? null,
        awayAverage: awayValue?.average ?? null,
      };
    }

    const eventMetrics = competitionScoring?.eventMetrics ?? {};
    const coveredFixtures = this.number(eventMetrics.timelineCoverageMatches) ?? 0;
    const completedFixtures = competitionFixtures;
    const coverageRate = completedFixtures > 0 ? coveredFixtures / completedFixtures : 0;
    const eventQuality = this.clamp(
      0.55 + 0.30 * Math.min(1, coverageRate)
        + 0.10 * Math.min(1, coveredFixtures / 20),
      0,
      0.95,
    );
    const timeline = this.measure({
      sampleSize: coveredFixtures,
      minimumSampleSize: MINIMUM_EVENT_TIMELINE_SAMPLE,
      quality: eventQuality,
      minimumQuality: MINIMUM_DATA_QUALITY,
      coverageRate,
      minimumCoverageRate: MINIMUM_EVENT_TIMELINE_COVERAGE,
      hasData: Boolean(competitionScoring && completedFixtures > 0),
      reasonWhenMissing: 'No completed-fixture Plays coverage projection is available.',
      reasonWhenInsufficient: 'Plays coverage must contain at least eight fixtures and cover at least 65% of completed fixtures.',
      eligible: fixtureEligible,
    }) as SportsFixtureReadiness['timeline'];
    Object.assign(timeline, { coveredFixtures, completedFixtures });

    const eventMarkets = {
      redCard: this.eventMeasure('redCardMatches', eventMetrics, timeline, fixtureEligible),
      penaltyAwarded: this.eventMeasure('penaltyAwardedMatches', eventMetrics, timeline, fixtureEligible),
      ownGoal: this.eventMeasure('ownGoalMatches', eventMetrics, timeline, fixtureEligible),
    };

    const playerMarkets: SportsFixtureReadiness['playerMarkets'] = {
      state: 'UNSUPPORTED',
      ready: false,
      sampleSize: 0,
      minimumSampleSize: MINIMUM_EVENT_TIMELINE_SAMPLE,
      quality: null,
      minimumQuality: MINIMUM_DATA_QUALITY,
      pricingSupported: false,
      reason: 'Per-player markets are disabled in the current Odds pricing engine.',
    };

    return {
      fixtureId: fixture.id,
      competitionId: fixture.competitionId,
      ...(fixture.seasonId ? { seasonId: fixture.seasonId } : {}),
      checkedAt: new Date(),
      fixtureEligible,
      ...(!fixtureEligible ? { fixtureIneligibleReason: `Fixture status ${fixture.status?.state ?? 'UNKNOWN'} is not priceable.` } : {}),
      scoreMatrix,
      periodMatrix,
      goalOrderMarkets,
      teamStatistics,
      timeline,
      eventMarkets,
      playerMarkets,
      sourceComputedAt: {
        homeScoring: this.date(homeScoring?.computedAt),
        awayScoring: this.date(awayScoring?.computedAt),
        homeAway: this.date(homeAway?.computedAt),
        awayAway: this.date(awayAway?.computedAt),
        competitionScoring: this.date(competitionScoring?.computedAt),
        homeStatistics: this.date(homeStatistics?.computedAt),
        awayStatistics: this.date(awayStatistics?.computedAt),
        headToHead: this.date(headToHead?.computedAt),
      },
    };
  }

  private eventMeasure(
    field: string,
    eventMetrics: PlainRecord,
    timeline: SportsFixtureReadiness['timeline'],
    fixtureEligible: boolean,
  ): SportsEventReadiness {
    const eventMatches = this.number(eventMetrics?.[field]);
    const hasEventCount = eventMatches !== null && eventMatches >= 0 && eventMatches <= timeline.coveredFixtures;
    const measure = this.measure({
      sampleSize: timeline.sampleSize,
      minimumSampleSize: MINIMUM_EVENT_TIMELINE_SAMPLE,
      quality: timeline.quality,
      minimumQuality: MINIMUM_DATA_QUALITY,
      coverageRate: timeline.coverageRate,
      minimumCoverageRate: MINIMUM_EVENT_TIMELINE_COVERAGE,
      hasData: timeline.state !== 'MISSING' && hasEventCount,
      reasonWhenMissing: `Verified ${field} event counts are not available from the covered Plays sample.`,
      reasonWhenInsufficient: timeline.reason ?? 'Plays event coverage is insufficient.',
      eligible: fixtureEligible,
    });
    return { ...measure, eventMatches };
  }

  private measure(input: {
    sampleSize: number;
    minimumSampleSize: number;
    quality: number | null;
    minimumQuality: number;
    coverageRate?: number | null;
    minimumCoverageRate?: number;
    hasData: boolean;
    reasonWhenMissing: string;
    reasonWhenInsufficient: string;
    eligible: boolean;
  }): SportsReadinessMeasure {
    const sampleSize = Math.max(0, Math.floor(input.sampleSize));
    const quality = input.quality === null || !Number.isFinite(input.quality)
      ? null
      : this.clamp(input.quality, 0, 1);
    const hasMinimumCoverage = input.minimumCoverageRate === undefined
      || (input.coverageRate ?? 0) >= input.minimumCoverageRate;
    const meetsSample = sampleSize >= input.minimumSampleSize;
    const meetsQuality = quality !== null && quality >= input.minimumQuality;
    const ready = input.eligible && input.hasData && meetsSample && meetsQuality && hasMinimumCoverage;
    const state = ready
      ? 'READY'
      : !input.eligible
        ? 'UNSUPPORTED'
        : !input.hasData
          ? 'MISSING'
          : 'INSUFFICIENT';
    let reason: string | undefined;
    if (!input.eligible) reason = 'Fixture is not eligible for pricing.';
    else if (!input.hasData) reason = input.reasonWhenMissing;
    else if (!meetsSample || !meetsQuality || !hasMinimumCoverage) reason = input.reasonWhenInsufficient;
    return {
      state,
      ready,
      sampleSize,
      minimumSampleSize: input.minimumSampleSize,
      quality,
      minimumQuality: input.minimumQuality,
      ...(input.coverageRate !== undefined
        ? { coverageRate: input.coverageRate === null ? null : this.clamp(input.coverageRate, 0, 1) }
        : {}),
      ...(input.minimumCoverageRate !== undefined ? { minimumCoverageRate: input.minimumCoverageRate } : {}),
      ...(reason ? { reason } : {}),
    };
  }

  private statisticValue(aggregate: any, key: string): StatisticValue {
    if (!aggregate || !Array.isArray(aggregate.statistics)) return null;
    if (key === 'cards') {
      const yellow = this.findStatistic(aggregate.statistics, STATISTIC_ALIASES.yellowCards);
      const red = this.findStatistic(aggregate.statistics, STATISTIC_ALIASES.redCards);
      if (yellow && red) {
        return {
          average: yellow.average + red.average,
          sampleSize: Math.min(yellow.sampleSize, red.sampleSize),
        };
      }
      return this.findStatistic(aggregate.statistics, ['cards', 'totalcards']);
    }
    return this.findStatistic(aggregate.statistics, STATISTIC_ALIASES[key] ?? [key]);
  }

  private findStatistic(rows: any[], aliases: string[]): StatisticValue {
    const accepted = new Set(aliases.map(normalizeKey));
    const row = rows.find((candidate) => accepted.has(normalizeKey(candidate?.key))
      || accepted.has(normalizeKey(candidate?.name))
      || (candidate?.category ? accepted.has(normalizeKey(candidate.category)) : false));
    const average = this.number(row?.average);
    const sampleSize = this.number(row?.sampleSize);
    if (average === null || average < 0 || sampleSize === null || sampleSize < 1) return null;
    return { average, sampleSize: Math.floor(sampleSize) };
  }

  private recentFormSample(teamData: any, competitionId: string): number {
    if (!Array.isArray(teamData?.form)) return 0;
    const results = teamData.form
      .filter((record: any) => !record?.competitionId || record.competitionId === competitionId)
      .flatMap((record: any) => Array.isArray(record?.results) ? record.results : [])
      .filter((row: any) => this.date(row?.kickoffAt) && this.number(row?.goalsFor) !== null && this.number(row?.goalsAgainst) !== null)
      .sort((left: any, right: any) => this.date(right.kickoffAt)!.getTime() - this.date(left.kickoffAt)!.getTime())
      .slice(0, 5);
    return results.length;
  }

  private periodObservationCount(teamData: any, teamId: string): number {
    if (!Array.isArray(teamData?.recentFixtures)) return 0;
    return teamData.recentFixtures.filter((fixture: any) => {
      const fullScore = fixture?.competitors?.find((competitor: any) => competitor?.teamId === teamId)?.score;
      if (typeof fullScore !== 'number' || fullScore <= 0 || !Array.isArray(fixture?.periodScores)) return false;
      return fixture.periodScores.some((period: any) => period?.teamId === teamId && period?.period === 1);
    }).length;
  }

  private divide(numerator: unknown, denominator: unknown): number | null {
    const top = this.number(numerator);
    const bottom = this.number(denominator);
    return top === null || bottom === null || bottom <= 0 ? null : top / bottom;
  }

  private valueOrUndefined(value: unknown): number | undefined {
    const parsed = this.number(value);
    return parsed === null || parsed < 0 ? undefined : parsed;
  }

  private number(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private date(value: unknown): Date | null {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  private clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
  }
}
