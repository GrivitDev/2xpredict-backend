import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  EspnFixture,
  EspnFixtureDocument,
} from '../schemas/espn/espn-fixture.schema';

import {
  YouTubeHighlight,
  YouTubeHighlightDocument,
} from '../schemas/youtube-highlight.schema';

import { YoutubeService } from '../providers/youtube.service';

import { YoutubeHighlightStatus } from '../interfaces/youtube-highlight.interface';

import { SportsProviderRateLimitService } from './sports-provider-rate-limit.service';
import { PriorityCompetitionService } from './priority-competition.service';
import { CompetitionPriority } from '../enums/competition-priority.enum';

interface MatchInfo {
  fixtureId: string;
  leagueId: string;
  competitionId?: string;
  homeTeamId?: string;
  awayTeamId?: string;
  homeTeam: string;
  awayTeam: string;
  date: Date;
}

@Injectable()
export class YoutubeHighlightService {
  private readonly logger = new Logger(YoutubeHighlightService.name);

  constructor(
    private readonly youtubeService: YoutubeService,

    private readonly sportsProviderRateLimitService: SportsProviderRateLimitService,

    private readonly priorityCompetitionService: PriorityCompetitionService,

    @InjectModel(EspnFixture.name)
    private readonly espnFixtureModel: Model<EspnFixtureDocument>,

    @InjectModel(YouTubeHighlight.name)
    private readonly highlightModel: Model<YouTubeHighlightDocument>,
  ) {}

  // ============================================================
  // PROCESS FINISHED FIXTURE
  // ============================================================

  /**
   * Called directly by FINISHED_MATCH.
   *
   * Flow:
   *
   * FINISHED_MATCH
   *      ↓
   * load ESPN fixture
   *      ↓
   * check priority competition
   *      ↓
   * YouTube search
   *      ↓
   * save/update highlight
   *
   * There is no separate YouTube queue.
   */
  async processFixture(
    fixtureId: string,
    competitionId?: string,
  ): Promise<void> {
    const normalizedFixtureId = fixtureId.trim();

    if (!normalizedFixtureId) {
      throw new Error('YouTube fixture ID is required');
    }

    /*
     * Match information comes from the fixture already stored
     * by the ESPN scoreboard refresh.
     */
    const match = await this.getMatchInfo(normalizedFixtureId);

    if (!match) {
      throw new Error(
        `ESPN fixture ${normalizedFixtureId} was not found after scoreboard collection`,
      );
    }

    /*
     * YouTube is restricted to the configured priority
     * competitions.
     *
     * SELECTIVE is a HARD BLOCK.
     *
     * It must NEVER reach the YouTube provider endpoint,
     * consume quota, or perform a YouTube search.
     */
    const priorityCompetition = this.priorityCompetitionService.getById(
      match.leagueId,
    );

    if (!priorityCompetition) {
      this.logger.debug(
        `Skipping YouTube highlight for non-priority competition ${match.leagueId}`,
      );

      return;
    }

    if (priorityCompetition.priority === CompetitionPriority.SELECTIVE) {
      this.logger.debug(
        `Skipping YouTube highlight for SELECTIVE competition ${match.leagueId}`,
      );

      return;
    }

    /*
     * A FOUND highlight does not need to be searched again.
     *
     * This check deliberately happens only after the priority
     * restriction above. SELECTIVE competitions are therefore
     * always excluded from the YouTube workflow.
     */
    const existing = await this.highlightModel
      .findOne({
        fixtureId: normalizedFixtureId,
      })
      .exec();

    if (existing && existing.status === YoutubeHighlightStatus.FOUND) {
      return;
    }

    /*
     * FINISHED_MATCH is the only caller, so the provider quota
     * is checked immediately before the actual YouTube request.
     */
    const remaining =
      (await this.sportsProviderRateLimitService.getRemainingDailyRequests(
        'youtube',
      )) ?? 0;

    if (remaining <= 0) {
      throw new Error('YouTube daily provider quota exhausted');
    }

    /*
     * One YouTube search request.
     */
    const result = await this.youtubeService.findHighlight(
      match.homeTeam,
      match.awayTeam,
      match.date,
    );

    if (!result) {
      throw new Error(
        `No suitable YouTube highlight found for ${match.homeTeam} vs ${match.awayTeam}`,
      );
    }

    /*
     * Update the existing highlight or create it if it does
     * not already exist.
     */
    await this.highlightModel
      .findOneAndUpdate(
        {
          fixtureId: normalizedFixtureId,
        },
        {
          $set: {
            competitionId: competitionId ?? match.competitionId,

            homeTeam: match.homeTeam,

            awayTeam: match.awayTeam,

            videoId: result.videoId,

            videoUrl: result.videoUrl,

            title: result.title,

            channelId: result.channelId,

            channelTitle: result.channelTitle,

            publishedAt: result.publishedAt
              ? new Date(result.publishedAt)
              : undefined,

            thumbnailUrl: result.thumbnailUrl,

            status: YoutubeHighlightStatus.FOUND,

            nextRetryAt: null,

            error: undefined,

            payload: result as unknown as Record<string, unknown>,
          },

          $setOnInsert: {
            fixtureId: normalizedFixtureId,

            retryCount: 0,
          },
        },
        {
          upsert: true,
          returnDocument: 'after',
        },
      )
      .exec();

    this.logger.debug(
      `YouTube highlight collected for ESPN fixture ${normalizedFixtureId}`,
    );
  }
  // ============================================================
  // REMAINING DAILY QUOTA
  // ============================================================

  async getRemainingDailyQuota(): Promise<number> {
    return (
      (await this.sportsProviderRateLimitService.getRemainingDailyRequests(
        'youtube',
      )) ?? 0
    );
  }

  // ============================================================
  // MATCH INFORMATION
  // ============================================================

  private async getMatchInfo(fixtureId: string): Promise<MatchInfo | null> {
    const normalizedFixtureId = fixtureId.trim();

    if (!normalizedFixtureId) {
      return null;
    }

    const fixture = await this.espnFixtureModel
      .findOne({
        eventId: normalizedFixtureId,
      })
      .lean()
      .exec();

    if (!fixture) {
      return null;
    }

    const payload =
      fixture.payload && typeof fixture.payload === 'object'
        ? fixture.payload
        : {};

    const event =
      payload['event'] && typeof payload['event'] === 'object'
        ? (payload['event'] as Record<string, unknown>)
        : payload;

    const competitionsValue = event['competitions'] ?? payload['competitions'];

    const competitions = Array.isArray(competitionsValue)
      ? competitionsValue
      : [];

    const firstCompetition =
      competitions.length > 0 &&
      competitions[0] &&
      typeof competitions[0] === 'object'
        ? (competitions[0] as Record<string, unknown>)
        : undefined;

    const competitionValue = payload['competition'] ?? event['competition'];

    const competition =
      competitionValue && typeof competitionValue === 'object'
        ? (competitionValue as Record<string, unknown>)
        : firstCompetition;

    const competitorsValue = firstCompetition?.['competitors'];

    const competitors = Array.isArray(competitorsValue) ? competitorsValue : [];

    const competitorObjects = competitors.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === 'object',
    );

    const home =
      competitorObjects.find(
        (item) => item['homeAway'] === 'home' || item['isHome'] === true,
      ) ?? competitorObjects[0];

    const away =
      competitorObjects.find(
        (item) => item['homeAway'] === 'away' || item['isAway'] === true,
      ) ?? competitorObjects[1];

    const homeTeamValue = home?.['team'];

    const awayTeamValue = away?.['team'];

    const homeTeam =
      homeTeamValue && typeof homeTeamValue === 'object'
        ? (homeTeamValue as Record<string, unknown>)
        : undefined;

    const awayTeam =
      awayTeamValue && typeof awayTeamValue === 'object'
        ? (awayTeamValue as Record<string, unknown>)
        : undefined;

    const homeName = this.getTeamName(homeTeam);

    const awayName = this.getTeamName(awayTeam);

    /*
     * Prefer the original event date, then the competition date,
     * then the normalized fixtureDate stored in MongoDB.
     */
    const dateValue =
      event['date'] ?? firstCompetition?.['date'] ?? fixture.fixtureDate;

    if (!homeName || !awayName || !dateValue) {
      return null;
    }

    const date =
      dateValue instanceof Date
        ? dateValue
        : typeof dateValue === 'string' || typeof dateValue === 'number'
          ? new Date(dateValue)
          : new Date(Number.NaN);

    if (Number.isNaN(date.getTime())) {
      return null;
    }

    const competitionId =
      this.getStringValue(competition?.['id']) ??
      this.getStringValue(competition?.['uid']);

    const homeTeamId =
      this.getStringValue(homeTeam?.['id']) ??
      this.getStringValue(fixture.homeTeamId);

    const awayTeamId =
      this.getStringValue(awayTeam?.['id']) ??
      this.getStringValue(fixture.awayTeamId);

    return {
      fixtureId: normalizedFixtureId,

      leagueId: fixture.leagueId,

      competitionId,

      homeTeamId,

      awayTeamId,

      homeTeam: homeName,

      awayTeam: awayName,

      date,
    };
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private getTeamName(team?: Record<string, unknown>): string | undefined {
    if (!team) {
      return undefined;
    }

    const displayName = team['displayName'];

    if (typeof displayName === 'string' && displayName.trim()) {
      return displayName.trim();
    }

    const name = team['name'];

    if (typeof name === 'string' && name.trim()) {
      return name.trim();
    }

    const shortDisplayName = team['shortDisplayName'];

    if (typeof shortDisplayName === 'string' && shortDisplayName.trim()) {
      return shortDisplayName.trim();
    }

    return undefined;
  }

  private getStringValue(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (typeof value === 'number') {
      return String(value);
    }

    return undefined;
  }
}
