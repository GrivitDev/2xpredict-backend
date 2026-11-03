import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  EspnFixture,
  EspnFixtureDocument,
} from '../schemas/espn/espn-fixture.schema';
import {
  EspnLeague,
  EspnLeagueDocument,
} from '../schemas/espn/espn-league.schema';
import {
  EspnStanding,
  EspnStandingDocument,
} from '../schemas/espn/espn-standing.schema';
import { EspnTeam, EspnTeamDocument } from '../schemas/espn/espn-team.schema';
import { EspnQueue, EspnQueueDocument } from '../schemas/espn-queue.schema';
import { EspnQueueStatus } from '../interfaces/espn-queue.interface';
import {
  SportsSyncState,
  SportsSyncStateDocument,
} from '../schemas/sports-sync-state.schema';
import {
  YouTubeHighlight,
  YouTubeHighlightDocument,
} from '../schemas/youtube-highlight.schema';

interface SeasonCleanupResult {
  cleaned: boolean;
  reason?: string;
  deletedFixtures?: number;
  deletedStandings?: number;
  deletedTeams?: number;
  deletedQueueJobs?: number;
  deletedSyncStates?: number;
  deletedHighlights?: number;
}

@Injectable()
export class EspnSeasonDataService {
  private readonly logger = new Logger(EspnSeasonDataService.name);

  private readonly eventIdBatchSize = 500;

  constructor(
    @InjectModel(EspnFixture.name)
    private readonly espnFixtureModel: Model<EspnFixtureDocument>,

    @InjectModel(EspnLeague.name)
    private readonly espnLeagueModel: Model<EspnLeagueDocument>,

    @InjectModel(EspnStanding.name)
    private readonly espnStandingModel: Model<EspnStandingDocument>,

    @InjectModel(EspnTeam.name)
    private readonly espnTeamModel: Model<EspnTeamDocument>,

    @InjectModel(EspnQueue.name)
    private readonly espnQueueModel: Model<EspnQueueDocument>,

    @InjectModel(SportsSyncState.name)
    private readonly sportsSyncStateModel: Model<SportsSyncStateDocument>,

    @InjectModel(YouTubeHighlight.name)
    private readonly youtubeHighlightModel: Model<YouTubeHighlightDocument>,
  ) {}

  /**
   * Delete only ESPN cache and synchronization data belonging to one ended
   * league-season. The league catalogue, active-competition configuration,
   * non-ESPN provider collections, predictions, and application data survive.
   *
   * Team rows are scoped by league rather than season in the current schema,
   * so they are refreshed naturally as the new season's fixture catalogue is
   * collected.
   */
  async cleanupLeagueSeason(params: {
    leagueId: string;
    season: number;
    seasonEndDate?: Date;
  }): Promise<SeasonCleanupResult> {
    const leagueId = this.normalizeLeagueId(params.leagueId);
    const { season } = params;

    if (!leagueId || !Number.isInteger(season)) {
      return {
        cleaned: false,
        reason: 'Invalid league ID or season',
      };
    }

    if (!params.seasonEndDate || !this.hasSeasonEnded(params.seasonEndDate)) {
      return {
        cleaned: false,
        reason: 'Season end date has not elapsed in Africa/Lagos',
      };
    }

    const league = await this.espnLeagueModel
      .findOne({
        $or: [{ leagueId }, { slug: leagueId }],
      })
      .select({
        leagueId: 1,
        slug: 1,
        season: 1,
        fixturesCollectedSeason: 1,
        lastCleanedSeason: 1,
        previousSeason: 1,
        fixtureCollectionAttemptSeason: 1,
      })
      .lean()
      .exec();

    if (!league) {
      return {
        cleaned: false,
        reason: 'ESPN league metadata was not found; cleanup was not run',
      };
    }

    if (
      typeof league.lastCleanedSeason === 'number' &&
      league.lastCleanedSeason >= season
    ) {
      const unset: Record<string, number> = {};
      if (league.previousSeason === season) {
        unset.previousSeason = 1;
        unset.previousSeasonEndDate = 1;
      }
      if (
        league.season === season &&
        league.fixturesCollectedSeason === season
      ) {
        unset.fixturesCollectedSeason = 1;
      }
      if (league.fixtureCollectionAttemptSeason === season) {
        unset.fixtureCollectionAttemptSeason = 1;
        unset.fixtureCollectionAttemptedAt = 1;
      }
      if (Object.keys(unset).length > 0) {
        await this.espnLeagueModel
          .updateOne(
            { $or: [{ leagueId }, { slug: leagueId }] },
            { $unset: unset },
          )
          .exec();
      }

      return {
        cleaned: true,
        reason: 'Season was already cleaned',
        deletedFixtures: 0,
        deletedStandings: 0,
        deletedTeams: 0,
        deletedQueueJobs: 0,
        deletedSyncStates: 0,
        deletedHighlights: 0,
      };
    }

    const processingJobs = await this.espnQueueModel.countDocuments({
      leagueId,
      season,
      status: EspnQueueStatus.PROCESSING,
    });

    if (processingJobs > 0) {
      return {
        cleaned: false,
        reason: `${processingJobs} queue job(s) are still processing`,
      };
    }

    const now = new Date();
    const futureUnfinishedFixtures = await this.espnFixtureModel.countDocuments(
      {
        leagueId,
        season,
        fixtureDate: { $gt: now },
        completed: { $ne: true },
      },
    );

    if (futureUnfinishedFixtures > 0) {
      return {
        cleaned: false,
        reason: `${futureUnfinishedFixtures} future fixture(s) remain`,
      };
    }

    let deletedHighlights = 0;
    const fixtureCursor = this.espnFixtureModel
      .find({ leagueId, season })
      .select({ eventId: 1 })
      .lean()
      .cursor({ batchSize: this.eventIdBatchSize });

    let eventIds: string[] = [];

    const deleteHighlightBatch = async (): Promise<void> => {
      if (eventIds.length === 0) {
        return;
      }

      const result = await this.youtubeHighlightModel.deleteMany({
        fixtureId: { $in: eventIds },
      });

      deletedHighlights += result.deletedCount ?? 0;
      eventIds = [];
    };

    for await (const fixture of fixtureCursor) {
      const eventId = String(fixture.eventId ?? '').trim();

      if (eventId) {
        eventIds.push(eventId);
      }

      if (eventIds.length >= this.eventIdBatchSize) {
        await deleteHighlightBatch();
      }
    }

    await deleteHighlightBatch();

    const [
      fixturesResult,
      standingsResult,
      teamsResult,
      queueResult,
      stateResult,
    ] = await Promise.all([
      this.espnFixtureModel.deleteMany({ leagueId, season }),
      this.espnStandingModel.deleteMany({ leagueId, season }),
      this.espnTeamModel.deleteMany({ leagueId }),
      this.espnQueueModel.deleteMany({ leagueId, season }),
      this.sportsSyncStateModel.deleteMany({ leagueId, season }),
    ]);

    await this.espnLeagueModel
      .updateOne(
        { $or: [{ leagueId }, { slug: leagueId }] },
        {
          $max: { lastCleanedSeason: season },
          ...(league.previousSeason === season ||
          (league.season === season &&
            league.fixturesCollectedSeason === season) ||
          league.fixtureCollectionAttemptSeason === season
            ? {
                $unset: {
                  ...(league.previousSeason === season
                    ? { previousSeason: 1, previousSeasonEndDate: 1 }
                    : {}),
                  ...(league.season === season &&
                  league.fixturesCollectedSeason === season
                    ? { fixturesCollectedSeason: 1 }
                    : {}),
                  ...(league.fixtureCollectionAttemptSeason === season
                    ? {
                        fixtureCollectionAttemptSeason: 1,
                        fixtureCollectionAttemptedAt: 1,
                      }
                    : {}),
                },
              }
            : {}),
        },
      )
      .exec();

    const result: SeasonCleanupResult = {
      cleaned: true,
      deletedFixtures: fixturesResult.deletedCount ?? 0,
      deletedStandings: standingsResult.deletedCount ?? 0,
      deletedTeams: teamsResult.deletedCount ?? 0,
      deletedQueueJobs: queueResult.deletedCount ?? 0,
      deletedSyncStates: stateResult.deletedCount ?? 0,
      deletedHighlights,
    };

    this.logger.warn(
      `Cleaned ended ESPN season ${leagueId}/${season}: ` +
        `fixtures=${result.deletedFixtures}, ` +
        `standings=${result.deletedStandings}, ` +
        `teams=${result.deletedTeams}, ` +
        `queue=${result.deletedQueueJobs}, ` +
        `syncStates=${result.deletedSyncStates}, ` +
        `highlights=${result.deletedHighlights}`,
    );

    return result;
  }

  private hasSeasonEnded(endDate: Date): boolean {
    if (!(endDate instanceof Date) || Number.isNaN(endDate.getTime())) {
      return false;
    }

    /*
     * ESPN sometimes publishes a season end date as midnight UTC on the
     * final calendar date. Wait until that date has passed in Lagos before
     * deleting anything, rather than interpreting midnight UTC as season end.
     */
    return this.getLagosDateKey(endDate) < this.getLagosDateKey(new Date());
  }

  private getLagosDateKey(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Lagos',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);

    const values = new Map(parts.map((part) => [part.type, part.value]));

    return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
  }

  private normalizeLeagueId(value: string): string {
    return value.trim().toLowerCase();
  }
}

