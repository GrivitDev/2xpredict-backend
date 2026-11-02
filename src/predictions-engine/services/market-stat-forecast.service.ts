import { Injectable } from '@nestjs/common';
import { PredictionMatchContext } from '../interfaces/espn-prediction-context.interface';
import { EspnPayloadUtil } from '../utils/espn-payload.util';

export interface StatisticForecast {
  metric: string;
  totalMean?: number;
  homeMean?: number;
  awayMean?: number;
  mean?: number;
  standardDeviation?: number;
  sampleSize: number;
  source: string;
}

const METRICS: Record<
  string,
  { aliases: string[]; scope: 'TOTAL' | 'HOME' | 'AWAY' | 'POSSESSION' }
> = {
  TOTAL_CORNERS_OVER_UNDER: {
    aliases: ['wonCorners', 'cornerKicks', 'corners', 'corner'],
    scope: 'TOTAL',
  },
  CORNER_MATCH_RESULT: {
    aliases: ['wonCorners', 'cornerKicks', 'corners', 'corner'],
    scope: 'TOTAL',
  },
  HOME_CORNERS_OVER_UNDER: {
    aliases: ['wonCorners', 'cornerKicks', 'corners', 'corner'],
    scope: 'HOME',
  },
  AWAY_CORNERS_OVER_UNDER: {
    aliases: ['wonCorners', 'cornerKicks', 'corners', 'corner'],
    scope: 'AWAY',
  },
  TOTAL_CARDS_OVER_UNDER: {
    aliases: ['yellowCards', 'redCards', 'cards'],
    scope: 'TOTAL',
  },
  TOTAL_YELLOW_CARDS_OVER_UNDER: {
    aliases: ['yellowCards', 'yellowCard'],
    scope: 'TOTAL',
  },
  TOTAL_RED_CARDS_OVER_UNDER: {
    aliases: ['redCards', 'redCard'],
    scope: 'TOTAL',
  },
  HOME_TEAM_CARDS_OVER_UNDER: {
    aliases: ['yellowCards', 'redCards', 'cards'],
    scope: 'HOME',
  },
  AWAY_TEAM_CARDS_OVER_UNDER: {
    aliases: ['yellowCards', 'redCards', 'cards'],
    scope: 'AWAY',
  },
  TOTAL_SHOTS_OVER_UNDER: {
    aliases: ['totalShots', 'shots', 'shot'],
    scope: 'TOTAL',
  },
  TOTAL_SHOTS_ON_TARGET_OVER_UNDER: {
    aliases: ['shotsOnTarget', 'shotsOnGoal', 'sot', 'onGoal'],
    scope: 'TOTAL',
  },
  HOME_SHOTS_ON_TARGET_OVER_UNDER: {
    aliases: ['shotsOnTarget', 'shotsOnGoal', 'sot', 'onGoal'],
    scope: 'HOME',
  },
  AWAY_SHOTS_ON_TARGET_OVER_UNDER: {
    aliases: ['shotsOnTarget', 'shotsOnGoal', 'sot', 'onGoal'],
    scope: 'AWAY',
  },
  TOTAL_OFFSIDES_OVER_UNDER: {
    aliases: ['offsides', 'offside'],
    scope: 'TOTAL',
  },
  TOTAL_FOULS_OVER_UNDER: {
    aliases: ['foulsCommitted', 'fouls', 'foul'],
    scope: 'TOTAL',
  },
  POSSESSION_OVER_UNDER: {
    aliases: ['possessionPct', 'possession', 'possessionPercentage'],
    scope: 'POSSESSION',
  },
};

@Injectable()
export class MarketStatForecastService {
  forecast(
    context: PredictionMatchContext,
    marketKey: string,
  ): StatisticForecast | null {
    const spec = METRICS[marketKey];
    if (!spec) return null;
    const matchTotals: number[] = [];
    const homeValues: number[] = [];
    const awayValues: number[] = [];

    const matches = context.historicalFixtures
      .filter(
        (fixture) =>
          fixture.completed &&
          fixture.fixtureDate < context.fixture.fixtureDate &&
          (fixture.homeTeamId === context.fixture.homeTeamId ||
            fixture.awayTeamId === context.fixture.homeTeamId ||
            fixture.homeTeamId === context.fixture.awayTeamId ||
            fixture.awayTeamId === context.fixture.awayTeamId),
      )
      .sort((a, b) => b.fixtureDate.getTime() - a.fixtureDate.getTime());

    for (const match of matches) {
      const homeStats = this.getTeamStats(match, match.homeTeamId);
      const awayStats = this.getTeamStats(match, match.awayTeamId);
      const homeTeamStat = this.readMetric(homeStats, spec.aliases, marketKey);
      const awayTeamStat = this.readMetric(awayStats, spec.aliases, marketKey);

      const teamSpecificHome =
        match.homeTeamId === context.fixture.homeTeamId
          ? homeTeamStat
          : match.awayTeamId === context.fixture.homeTeamId
            ? awayTeamStat
            : null;
      const teamSpecificAway =
        match.homeTeamId === context.fixture.awayTeamId
          ? homeTeamStat
          : match.awayTeamId === context.fixture.awayTeamId
            ? awayTeamStat
            : null;

      if (teamSpecificHome !== null) homeValues.push(teamSpecificHome);
      if (teamSpecificAway !== null) awayValues.push(teamSpecificAway);

      if (
        spec.scope === 'TOTAL' &&
        homeTeamStat !== null &&
        awayTeamStat !== null
      ) {
        matchTotals.push(
          this.metricValue(
            homeStats,
            awayStats,
            marketKey,
            homeTeamStat,
            awayTeamStat,
          ),
        );
      } else if (spec.scope === 'POSSESSION' && teamSpecificHome !== null) {
        homeValues[homeValues.length - 1] =
          teamSpecificHome > 1 ? teamSpecificHome : teamSpecificHome * 100;
      }
    }

    // If team-specific box-score history is sparse, use completed league
    // box-score observations from before kickoff. Missing fields are skipped;
    // they are never silently converted to zero.
    let usedLeagueFallback = false;
    const leagueMatches = context.leagueFixtures
      .filter(
        (fixture) =>
          fixture.completed && fixture.fixtureDate < context.fixture.fixtureDate,
      )
      .sort((a, b) => b.fixtureDate.getTime() - a.fixtureDate.getTime());

    if (spec.scope === 'TOTAL' && matchTotals.length < 3) {
      const leagueTotals: number[] = [];
      for (const match of leagueMatches) {
        const homeStats = this.getTeamStats(match, match.homeTeamId);
        const awayStats = this.getTeamStats(match, match.awayTeamId);
        const homeValue = this.readMetric(homeStats, spec.aliases, marketKey);
        const awayValue = this.readMetric(awayStats, spec.aliases, marketKey);
        if (homeValue !== null && awayValue !== null) {
          leagueTotals.push(this.metricValue(homeStats, awayStats, marketKey, homeValue, awayValue));
        }
        if (leagueTotals.length >= 120) break;
      }
      if (leagueTotals.length >= 3) {
        matchTotals.splice(0, matchTotals.length, ...leagueTotals);
        usedLeagueFallback = true;
      }
    } else if (spec.scope === 'HOME' && homeValues.length < 3) {
      const leagueHomeValues: number[] = [];
      for (const match of leagueMatches) {
        const stats = this.getTeamStats(match, match.homeTeamId);
        const value = this.readMetric(stats, spec.aliases, marketKey);
        if (value !== null) leagueHomeValues.push(value);
        if (leagueHomeValues.length >= 120) break;
      }
      if (leagueHomeValues.length >= 3) {
        homeValues.splice(0, homeValues.length, ...leagueHomeValues);
        usedLeagueFallback = true;
      }
    } else if (spec.scope === 'AWAY' && awayValues.length < 3) {
      const leagueAwayValues: number[] = [];
      for (const match of leagueMatches) {
        const stats = this.getTeamStats(match, match.awayTeamId);
        const value = this.readMetric(stats, spec.aliases, marketKey);
        if (value !== null) leagueAwayValues.push(value);
        if (leagueAwayValues.length >= 120) break;
      }
      if (leagueAwayValues.length >= 3) {
        awayValues.splice(0, awayValues.length, ...leagueAwayValues);
        usedLeagueFallback = true;
      }
    } else if (spec.scope === 'POSSESSION' && homeValues.length < 3) {
      const leaguePossessionValues: number[] = [];
      for (const match of leagueMatches) {
        const stats = this.getTeamStats(match, match.homeTeamId);
        const value = this.readMetric(stats, spec.aliases, marketKey);
        if (value !== null) leaguePossessionValues.push(value > 1 ? value : value * 100);
        if (leaguePossessionValues.length >= 120) break;
      }
      if (leaguePossessionValues.length >= 3) {
        homeValues.splice(0, homeValues.length, ...leaguePossessionValues);
        usedLeagueFallback = true;
      }
    }

    if (spec.scope === 'POSSESSION') {
      const values = homeValues.filter(Number.isFinite);
      if (values.length < 3) return null;
      const mean =
        values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance =
        values.reduce((sum, value) => sum + (value - (mean ?? value)) ** 2, 0) /
        values.length;
      return {
        metric: spec.aliases[0],
        mean: mean ?? undefined,
        standardDeviation: Math.max(4, Math.sqrt(variance)),
        sampleSize: values.length,
        source: usedLeagueFallback
          ? 'League-level historical ESPN boxscore possession statistics'
          : 'Historical ESPN boxscore possession statistics',
      };
    }

    if (spec.scope === 'HOME') {
      if (homeValues.length < 3) return null;
      return {
        metric: spec.aliases[0],
        mean:
          homeValues.reduce((sum, value) => sum + value, 0) / homeValues.length,
        sampleSize: homeValues.length,
        source: usedLeagueFallback
          ? 'League-level historical ESPN boxscore statistics for the home side'
          : 'Historical ESPN boxscore statistics for the current home team',
      };
    }

    if (spec.scope === 'AWAY') {
      if (awayValues.length < 3) return null;
      return {
        metric: spec.aliases[0],
        mean:
          awayValues.reduce((sum, value) => sum + value, 0) / awayValues.length,
        sampleSize: awayValues.length,
        source: usedLeagueFallback
          ? 'League-level historical ESPN boxscore statistics for the away side'
          : 'Historical ESPN boxscore statistics for the current away team',
      };
    }

    if (matchTotals.length < 3) return null;
    const totalMean =
      matchTotals.reduce((sum, value) => sum + value, 0) / matchTotals.length;
    const homeMean =
      homeValues.length > 0
        ? homeValues.reduce((sum, value) => sum + value, 0) / homeValues.length
        : undefined;
    const awayMean =
      awayValues.length > 0
        ? awayValues.reduce((sum, value) => sum + value, 0) / awayValues.length
        : undefined;
    return {
      metric: spec.aliases[0],
      totalMean,
      homeMean,
      awayMean,
      mean: totalMean,
      sampleSize: matchTotals.length,
      source: usedLeagueFallback
        ? 'League-level historical ESPN boxscore statistics from completed fixtures'
        : 'Historical ESPN boxscore statistics from completed fixtures',
    };
  }

  private getTeamStats(fixture: any, teamId: string): Record<string, number> {
    const payload = EspnPayloadUtil.asRecord(
      EspnPayloadUtil.asRecord(fixture).payload,
    );
    const summary = EspnPayloadUtil.asRecord(payload.summary);
    const boxscore = EspnPayloadUtil.asRecord(summary.boxscore);
    const teams = EspnPayloadUtil.asArray(boxscore.teams);
    const team: unknown = teams.find(
      (entry) =>
        String(
          EspnPayloadUtil.asRecord(EspnPayloadUtil.asRecord(entry).team).id ??
            '',
        ) === teamId,
    );
    const stats = EspnPayloadUtil.asArray(
      EspnPayloadUtil.asRecord(team).statistics,
    );
    const output: Record<string, number> = {};
    for (const raw of stats) {
      const statistic = EspnPayloadUtil.asRecord(raw);
      const keys = [
        statistic.name,
        statistic.abbreviation,
        statistic.label,
        statistic.displayName,
      ]
        .filter((v) => typeof v === 'string')
        .map((v) =>
          String(v)
            .toLowerCase()
            .replace(/[^a-z0-9]/g, ''),
        );
      const value = EspnPayloadUtil.finiteNumber(
        statistic.displayValue ?? statistic.value,
      );
      if (value === null) continue;
      for (const key of keys) output[key] = value;
    }

    // The scoreboard competitor node is a useful fallback when Summary boxscore team stats are absent.
    if (!Object.keys(output).length) {
      for (const competition of EspnPayloadUtil.asArray(payload.competitions)) {
        const competitors = EspnPayloadUtil.asArray(
          EspnPayloadUtil.asRecord(competition).competitors,
        );
        const competitor: unknown = competitors.find(
          (entry) =>
            String(EspnPayloadUtil.asRecord(entry).id ?? '') === teamId,
        );
        const rawStats = EspnPayloadUtil.asArray(
          EspnPayloadUtil.asRecord(competitor).statistics,
        );
        for (const raw of rawStats) {
          const statistic = EspnPayloadUtil.asRecord(raw);
          const key = String(statistic.name ?? statistic.abbreviation ?? '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
          const value = EspnPayloadUtil.finiteNumber(
            statistic.displayValue ?? statistic.value,
          );
          if (key && value !== null) output[key] = value;
        }
      }
    }
    return output;
  }

  private readMetric(
    stats: Record<string, number>,
    aliases: string[],
    marketKey: string,
  ): number | null {
    const normalized = Object.fromEntries(
      Object.entries(stats).map(([key, value]) => [
        key.toLowerCase().replace(/[^a-z0-9]/g, ''),
        value,
      ]),
    );
    const read = (names: string[]): number | null => {
      for (const alias of names) {
        const value = normalized[alias.toLowerCase().replace(/[^a-z0-9]/g, '')];
        if (Number.isFinite(value)) return value;
      }
      return null;
    };
    if (
      marketKey === 'TOTAL_CARDS_OVER_UNDER' ||
      marketKey === 'HOME_TEAM_CARDS_OVER_UNDER' ||
      marketKey === 'AWAY_TEAM_CARDS_OVER_UNDER'
    ) {
      const yellow = read(['yellowCards', 'yellowCard']);
      const red = read(['redCards', 'redCard']);
      return yellow !== null && red !== null ? yellow + red : null;
    }
    if (marketKey === 'TOTAL_YELLOW_CARDS_OVER_UNDER')
      return read(['yellowCards', 'yellowCard']);
    if (marketKey === 'TOTAL_RED_CARDS_OVER_UNDER')
      return read(['redCards', 'redCard']);
    if (
      marketKey === 'TOTAL_CORNERS_OVER_UNDER' ||
      marketKey === 'CORNER_MATCH_RESULT' ||
      marketKey === 'HOME_CORNERS_OVER_UNDER' ||
      marketKey === 'AWAY_CORNERS_OVER_UNDER'
    ) {
      return read(['wonCorners', 'cornerKicks', 'corners', 'corner']);
    }
    return read(aliases);
  }

  private metricValue(
    homeStats: Record<string, number>,
    awayStats: Record<string, number>,
    marketKey: string,
    homeValue: number,
    awayValue: number,
  ): number {
    if (marketKey === 'TOTAL_CARDS_OVER_UNDER') {
      // readMetric already includes red+yellow per team.
      return homeValue + awayValue;
    }
    return homeValue + awayValue;
  }
}


