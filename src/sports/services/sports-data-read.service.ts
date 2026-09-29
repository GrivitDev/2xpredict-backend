// backend/src/sports/services/sports-data-read.service.ts

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

// ============================================================
// ACTIVE COMPETITION
// ============================================================

import {
  ActiveCompetition,
  ActiveCompetitionDocument,
} from '../schemas/active-competition.schema';

import { ActiveCompetitionStatus } from '../interfaces/active-competition.interface';

// ============================================================
// ESPN
// ============================================================

import {
  EspnFixture,
  EspnFixtureDocument,
} from '../schemas/espn/espn-fixture.schema';

import {
  EspnLeague,
  EspnLeagueDocument,
} from '../schemas/espn/espn-league.schema';

import { EspnNews, EspnNewsDocument } from '../schemas/espn/espn-news.schema';

import {
  EspnStanding,
  EspnStandingDocument,
} from '../schemas/espn/espn-standing.schema';

import { EspnTeam, EspnTeamDocument } from '../schemas/espn/espn-team.schema';

// ============================================================
// ESPN QUEUE
// ============================================================

import { EspnQueue, EspnQueueDocument } from '../schemas/espn-queue.schema';

import {
  EspnQueueJobType,
  EspnQueueStatus,
} from '../interfaces/espn-queue.interface';

// ============================================================
// SYNC STATE
// ============================================================

import {
  SportsSyncState,
  SportsSyncStateDocument,
  SportsSyncStateKind,
  SportsSyncStateStatus,
  SportsSyncUnitStatus,
  SportsSyncUnitType,
} from '../schemas/sports-sync-state.schema';

// ============================================================
// FOOTBALL-DATA
// ============================================================

import {
  FootballDataCompetition,
  FootballDataCompetitionDocument,
} from '../schemas/football-data/football-data-competition.schema';

import {
  FootballDataMatch,
  FootballDataMatchDocument,
} from '../schemas/football-data/football-data-match.schema';

import {
  FootballDataStanding,
  FootballDataStandingDocument,
} from '../schemas/football-data/football-data-standing.schema';

import {
  FootballDataTeam,
  FootballDataTeamDocument,
} from '../schemas/football-data/football-data-team.schema';

// ============================================================
// ODDS API
// ============================================================

import {
  OddsApiSport,
  OddsApiSportDocument,
} from '../schemas/odds-api-sport.schema';

import {
  SportsOddsSnapshot,
  SportsOddsSnapshotDocument,
} from '../schemas/sports-odds-snapshot.schema';

// ============================================================
// RATE LIMIT
// ============================================================

import {
  SportsProviderRateLimit,
  SportsProviderRateLimitDocument,
} from '../schemas/sports-provider-rate-limit.schema';

// ============================================================
// YOUTUBE
// ============================================================

import {
  YouTubeHighlight,
  YouTubeHighlightDocument,
} from '../schemas/youtube-highlight.schema';

// ============================================================
// QUERY TYPES
// ============================================================

export interface SportsAdminQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';

  status?: string;
  type?: string;
  kind?: string;
  leagueId?: string;
  season?: number;
  eventId?: string;
  competitionId?: string;
  teamId?: string;
  provider?: string;
  stateKey?: string;

  from?: Date;
  to?: Date;
}

interface PaginatedResult<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ============================================================
// SERVICE
// ============================================================

@Injectable()
export class SportsDataReadService {
  constructor(
    // ----------------------------------------------------------
    // ACTIVE COMPETITION
    // ----------------------------------------------------------

    @InjectModel(ActiveCompetition.name)
    private readonly activeCompetitionModel: Model<ActiveCompetitionDocument>,

    // ----------------------------------------------------------
    // ESPN
    // ----------------------------------------------------------

    @InjectModel(EspnFixture.name)
    private readonly espnFixtureModel: Model<EspnFixtureDocument>,

    @InjectModel(EspnLeague.name)
    private readonly espnLeagueModel: Model<EspnLeagueDocument>,

    @InjectModel(EspnNews.name)
    private readonly espnNewsModel: Model<EspnNewsDocument>,

    @InjectModel(EspnStanding.name)
    private readonly espnStandingModel: Model<EspnStandingDocument>,

    @InjectModel(EspnTeam.name)
    private readonly espnTeamModel: Model<EspnTeamDocument>,

    // ----------------------------------------------------------
    // ESPN QUEUE
    // ----------------------------------------------------------

    @InjectModel(EspnQueue.name)
    private readonly espnQueueModel: Model<EspnQueueDocument>,

    // ----------------------------------------------------------
    // SYNC STATE
    // ----------------------------------------------------------

    @InjectModel(SportsSyncState.name)
    private readonly sportsSyncStateModel: Model<SportsSyncStateDocument>,

    // ----------------------------------------------------------
    // FOOTBALL-DATA
    // ----------------------------------------------------------

    @InjectModel(FootballDataCompetition.name)
    private readonly footballDataCompetitionModel: Model<FootballDataCompetitionDocument>,

    @InjectModel(FootballDataMatch.name)
    private readonly footballDataMatchModel: Model<FootballDataMatchDocument>,

    @InjectModel(FootballDataStanding.name)
    private readonly footballDataStandingModel: Model<FootballDataStandingDocument>,

    @InjectModel(FootballDataTeam.name)
    private readonly footballDataTeamModel: Model<FootballDataTeamDocument>,

    // ----------------------------------------------------------
    // ODDS API
    // ----------------------------------------------------------

    @InjectModel(OddsApiSport.name)
    private readonly oddsApiSportModel: Model<OddsApiSportDocument>,

    @InjectModel(SportsOddsSnapshot.name)
    private readonly sportsOddsSnapshotModel: Model<SportsOddsSnapshotDocument>,

    // ----------------------------------------------------------
    // RATE LIMIT
    // ----------------------------------------------------------

    @InjectModel(SportsProviderRateLimit.name)
    private readonly sportsProviderRateLimitModel: Model<SportsProviderRateLimitDocument>,

    // ----------------------------------------------------------
    // YOUTUBE
    // ----------------------------------------------------------

    @InjectModel(YouTubeHighlight.name)
    private readonly youtubeHighlightModel: Model<YouTubeHighlightDocument>,
  ) {}

  // ============================================================
  // PUBLIC / APPLICATION READS
  // ============================================================

  async getLive(): Promise<unknown[]> {
    return this.getLiveFixtures();
  }

  async getFixtures(competitionId?: string): Promise<unknown[]> {
    return this.getUpcomingFixtures(undefined, undefined, competitionId);
  }

  async getResults(competitionId?: string): Promise<unknown[]> {
    return this.getFinishedFixtures(undefined, undefined, competitionId);
  }

  /**
   * Emergency/fallback standings read.
   *
   * Normal application presentation should use ESPN Summary data
   * stored inside the canonical fixture payload.
   */
  async getStandings(
    competitionId: string,
    season?: number,
  ): Promise<unknown[]> {
    return this.getLeagueTable(competitionId, season);
  }

  async getTeams(competitionId: string): Promise<unknown[]> {
    const competition = competitionId?.trim().toLowerCase();

    const espnTeams = await this.espnTeamModel
      .find({
        leagueId: competition,
      })
      .sort({
        name: 1,
      })
      .lean()
      .exec();

    if (espnTeams.length > 0) {
      return espnTeams;
    }

    return this.footballDataTeamModel
      .find({
        competitionCode: competitionId?.trim().toUpperCase(),
      })
      .sort({
        name: 1,
      })
      .lean()
      .exec();
  }

  // ============================================================
  // COMPETITIONS
  // ============================================================

  async getCompetitions(
    options: {
      activeOnly?: boolean;
      predictionEnabled?: boolean;
    } = {},
  ) {
    let competitions = await this.activeCompetitionModel
      .find()
      .sort({
        priority: 1,
        name: 1,
      })
      .lean()
      .exec();

    if (options.activeOnly) {
      competitions = competitions.filter(
        (competition) =>
          competition.status === ActiveCompetitionStatus.ACTIVE ||
          competition.status === ActiveCompetitionStatus.UPCOMING,
      );
    }

    if (options.predictionEnabled) {
      return competitions;
    }

    return competitions;
  }

  async getActiveCompetitions(): Promise<ActiveCompetitionDocument[]> {
    return this.activeCompetitionModel
      .find({
        status: {
          $in: [
            ActiveCompetitionStatus.UPCOMING,
            ActiveCompetitionStatus.ACTIVE,
          ],
        },
      })
      .sort({
        priority: 1,
        name: 1,
      })
      .lean()
      .exec();
  }

  async getCompetition(
    competitionId: string,
    season?: number,
  ): Promise<ActiveCompetitionDocument | null> {
    const filter: Record<string, unknown> = {
      competitionId: String(competitionId).trim().toLowerCase(),
    };

    if (typeof season === 'number' && Number.isFinite(season)) {
      filter.season = season;
    }

    return this.activeCompetitionModel.findOne(filter).lean().exec();
  }

  // ============================================================
  // FIXTURES
  // ============================================================

  async getUpcomingFixtures(
    from?: Date,
    to?: Date,
    competitionId?: string,
  ): Promise<unknown[]> {
    const start = from ?? new Date();

    const filter: Record<string, unknown> = {
      fixtureDate: {
        $gte: start,
      },
    };

    if (to) {
      (filter.fixtureDate as Record<string, Date>).$lt = to;
    }

    if (competitionId) {
      filter.leagueId = String(competitionId).trim().toLowerCase();
    }

    return this.espnFixtureModel
      .find(filter)
      .sort({
        fixtureDate: 1,
      })
      .lean()
      .exec();
  }

  async getLiveFixtures(competitionId?: string): Promise<unknown[]> {
    const filter: Record<string, unknown> = {
      live: true,
    };

    if (competitionId) {
      filter.leagueId = competitionId.trim().toLowerCase();
    }

    return this.espnFixtureModel
      .find(filter)
      .sort({
        fixtureDate: 1,
      })
      .lean()
      .exec();
  }

  async getFinishedFixtures(
    from?: Date,
    to?: Date,
    competitionId?: string,
  ): Promise<unknown[]> {
    const filter: Record<string, unknown> = {
      completed: true,
    };

    if (competitionId) {
      filter.leagueId = competitionId.trim().toLowerCase();
    }

    if (from || to) {
      filter.fixtureDate = {};

      if (from) {
        (filter.fixtureDate as Record<string, Date>).$gte = from;
      }

      if (to) {
        (filter.fixtureDate as Record<string, Date>).$lt = to;
      }
    }

    return this.espnFixtureModel
      .find(filter)
      .sort({
        fixtureDate: -1,
      })
      .lean()
      .exec();
  }

  // ============================================================
  // ESPN SUMMARY
  // ============================================================

  /**
   * Returns the canonical ESPN Summary stored inside the
   * corresponding fixture document.
   */
  async getFixtureSummary(eventId: string): Promise<unknown> {
    const normalizedEventId = eventId.trim();

    if (!normalizedEventId) {
      return null;
    }

    const fixture = await this.espnFixtureModel
      .findOne({
        eventId: normalizedEventId,
      })
      .select({
        eventId: 1,
        leagueId: 1,
        season: 1,
        fixtureDate: 1,
        completed: 1,
        payload: 1,
      })
      .lean()
      .exec();

    if (!fixture) {
      return null;
    }

    const payload =
      fixture.payload && typeof fixture.payload === 'object'
        ? fixture.payload
        : undefined;

    const summary = payload?.summary;

    if (!summary || typeof summary !== 'object') {
      return null;
    }

    return {
      eventId: fixture.eventId,

      leagueId: fixture.leagueId,

      season: fixture.season,

      fixtureDate: fixture.fixtureDate,

      completed: fixture.completed,

      summary,

      summaryCollectedAt: payload?.summaryCollectedAt ?? null,
    };
  }

  // ============================================================
  // LEAGUE TABLE — FALLBACK
  // ============================================================

  async getLeagueTable(
    competitionId: string,
    season?: number,
  ): Promise<unknown[]> {
    const filter: Record<string, unknown> = {
      leagueId: competitionId.trim().toLowerCase(),
    };

    if (typeof season === 'number' && Number.isFinite(season)) {
      filter.season = season;
    }

    return this.espnStandingModel
      .find(filter)
      .sort({
        rank: 1,
      })
      .lean()
      .exec();
  }

  // ============================================================
  // ODDS
  // ============================================================

  async getOddsForEvent(eventId: string): Promise<unknown[]> {
    const normalizedEventId = eventId.trim();

    return this.sportsOddsSnapshotModel
      .find({
        eventId: normalizedEventId,
      })
      .sort({
        collectedAt: -1,
      })
      .lean()
      .exec();
  }

  // ============================================================
  // YOUTUBE
  // ============================================================

  async getYoutubeHighlight(
    fixtureId: string,
  ): Promise<YouTubeHighlightDocument | null> {
    return this.youtubeHighlightModel
      .findOne({
        fixtureId: fixtureId.trim(),
      })
      .sort({
        searchedAt: -1,
      })
      .lean()
      .exec();
  }

  // ============================================================
  // ADMIN PAGINATION
  // ============================================================

  private async paginateModel<T = any>(
    model: Model<any>,
    query: SportsAdminQuery,
    filter: Record<string, unknown> = {},
  ): Promise<PaginatedResult<T>> {
    const page = this.normalizePage(query.page);

    const limit = this.normalizeLimit(query.limit);

    const sortBy = this.normalizeSortField(query.sortBy);

    const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      model
        .find(filter)
        .sort({
          [sortBy]: sortOrder,
        })
        .skip(skip)
        .limit(limit)
        .lean<T[]>()
        .exec(),

      model.countDocuments(filter).exec(),
    ]);

    return {
      data,

      page,

      limit,

      total,

      totalPages: Math.ceil(total / limit),
    };
  }

  private normalizePage(value?: number): number {
    if (!Number.isFinite(value)) {
      return 1;
    }

    return Math.max(Math.floor(value as number), 1);
  }

  private normalizeLimit(value?: number): number {
    if (!Number.isFinite(value)) {
      return 50;
    }

    return Math.min(Math.max(Math.floor(value as number), 1), 200);
  }

  private normalizeSortField(value?: string): string {
    if (!value?.trim()) {
      return 'createdAt';
    }

    const normalized = value.trim();

    if (!/^[a-zA-Z0-9_]+$/.test(normalized)) {
      return 'createdAt';
    }

    return normalized;
  }

  private addDateRange(
    filter: Record<string, unknown>,
    field: string,
    from?: Date,
    to?: Date,
  ): void {
    if (!from && !to) {
      return;
    }

    filter[field] = {};

    if (from) {
      (filter[field] as Record<string, Date>).$gte = from;
    }

    if (to) {
      (filter[field] as Record<string, Date>).$lt = to;
    }
  }

  // ============================================================
  // ADMIN: ACTIVE COMPETITIONS
  // ============================================================

  async getAdminActiveCompetitions(query: SportsAdminQuery = {}) {
    const filter: Record<string, unknown> = {};

    if (query.status) {
      filter.status = query.status;
    }

    if (query.competitionId) {
      filter.competitionId = query.competitionId.trim().toLowerCase();
    }

    if (typeof query.season === 'number') {
      filter.season = query.season;
    }

    return this.paginateModel(this.activeCompetitionModel, query, filter);
  }

  // ============================================================
  // ADMIN: SPORTS SYNC STATES
  // ============================================================

  async getAdminSportsSyncStates(query: SportsAdminQuery = {}) {
    const filter: Record<string, unknown> = {};

    if (query.kind) {
      filter.kind = query.kind;
    }

    if (query.status) {
      filter.status = query.status;
    }

    if (query.type) {
      filter.jobType = query.type;
    }

    if (query.stateKey) {
      filter.stateKey = query.stateKey.trim();
    }

    if (query.leagueId) {
      filter.leagueId = query.leagueId.trim().toLowerCase();
    }

    if (typeof query.season === 'number') {
      filter.season = query.season;
    }

    if (query.eventId) {
      filter.eventId = query.eventId.trim();
    }

    const result = await this.paginateModel(
      this.sportsSyncStateModel,
      {
        ...query,
        sortBy: query.sortBy ?? 'updatedAt',
      },
      filter,
    );

    return {
      ...result,

      data: result.data.map((state) => this.summarizeSyncState(state)),
    };
  }

  async getAdminSportsSyncStateSummary(): Promise<unknown> {
    const [
      queueStates,
      cronStates,
      processingStates,
      pendingStates,
      partialStates,
      failedStates,
      successfulStates,
    ] = await Promise.all([
      this.sportsSyncStateModel.countDocuments({
        kind: SportsSyncStateKind.QUEUE,
      }),

      this.sportsSyncStateModel.countDocuments({
        kind: SportsSyncStateKind.CRON,
      }),

      this.sportsSyncStateModel.countDocuments({
        status: SportsSyncStateStatus.PROCESSING,
      }),

      this.sportsSyncStateModel.countDocuments({
        status: SportsSyncStateStatus.PENDING,
      }),

      this.sportsSyncStateModel.countDocuments({
        status: SportsSyncStateStatus.PARTIAL,
      }),

      this.sportsSyncStateModel.countDocuments({
        status: SportsSyncStateStatus.FAILED,
      }),

      this.sportsSyncStateModel.countDocuments({
        status: SportsSyncStateStatus.SUCCESS,
      }),
    ]);

    const current = await this.sportsSyncStateModel
      .findOne({
        status: SportsSyncStateStatus.PROCESSING,
      })
      .sort({
        updatedAt: -1,
      })
      .lean()
      .exec();

    return {
      total: queueStates + cronStates,

      kind: {
        queue: queueStates,
        cron: cronStates,
      },

      status: {
        pending: pendingStates,
        processing: processingStates,
        partial: partialStates,
        failed: failedStates,
        success: successfulStates,
      },

      current: current
        ? {
            ...this.summarizeSyncState(current),

            currentUnit: this.getCurrentSyncUnit(current),
          }
        : null,
    };
  }

  async getAdminSportsSyncState(stateKey: string) {
    const normalizedStateKey = stateKey.trim();

    if (!normalizedStateKey) {
      return null;
    }

    const state = await this.sportsSyncStateModel
      .findOne({
        stateKey: normalizedStateKey,
      })
      .lean()
      .exec();

    if (!state) {
      return null;
    }

    const units = state.units ?? [];

    const dates = units.filter((unit) => unit.type === SportsSyncUnitType.DATE);

    const steps = units.filter((unit) => unit.type === SportsSyncUnitType.STEP);

    return {
      ...state,

      progress: {
        total: units.length,

        completed: units.filter(
          (unit) => unit.status === SportsSyncUnitStatus.SUCCESS,
        ).length,

        processing: units.filter(
          (unit) => unit.status === SportsSyncUnitStatus.PROCESSING,
        ).length,

        pending: units.filter(
          (unit) => unit.status === SportsSyncUnitStatus.PENDING,
        ).length,

        failed: units.filter(
          (unit) => unit.status === SportsSyncUnitStatus.FAILED,
        ).length,

        dates: {
          total: dates.length,

          completed: dates.filter(
            (unit) => unit.status === SportsSyncUnitStatus.SUCCESS,
          ).length,

          processing: dates.filter(
            (unit) => unit.status === SportsSyncUnitStatus.PROCESSING,
          ).length,

          pending: dates.filter(
            (unit) => unit.status === SportsSyncUnitStatus.PENDING,
          ).length,

          failed: dates.filter(
            (unit) => unit.status === SportsSyncUnitStatus.FAILED,
          ).length,
        },

        steps: {
          total: steps.length,

          completed: steps.filter(
            (unit) => unit.status === SportsSyncUnitStatus.SUCCESS,
          ).length,

          processing: steps.filter(
            (unit) => unit.status === SportsSyncUnitStatus.PROCESSING,
          ).length,

          pending: steps.filter(
            (unit) => unit.status === SportsSyncUnitStatus.PENDING,
          ).length,

          failed: steps.filter(
            (unit) => unit.status === SportsSyncUnitStatus.FAILED,
          ).length,
        },

        percent:
          units.length > 0
            ? Math.round(
                (units.filter(
                  (unit) => unit.status === SportsSyncUnitStatus.SUCCESS,
                ).length /
                  units.length) *
                  100,
              )
            : 0,
      },

      currentUnit: this.getCurrentSyncUnit(state),

      incompleteUnits: units
        .filter(
          (unit) =>
            unit.status === SportsSyncUnitStatus.PENDING ||
            unit.status === SportsSyncUnitStatus.PROCESSING ||
            unit.status === SportsSyncUnitStatus.FAILED,
        )
        .map((unit) => ({
          key: unit.key,
          type: unit.type,
          dateKey: unit.dateKey,
          stepKey: unit.stepKey,
          status: unit.status,
          attempts: unit.attempts,
          startedAt: unit.startedAt,
          completedAt: unit.completedAt,
          nextAttemptAt: unit.nextAttemptAt,
          lastError: unit.lastError,
        })),
    };
  }

  private summarizeSyncState(state: SportsSyncStateDocument) {
    const units = state.units ?? [];

    const completed = units.filter(
      (unit) => unit.status === SportsSyncUnitStatus.SUCCESS,
    ).length;

    return {
      stateKey: state.stateKey,

      kind: state.kind,

      jobType: state.jobType,

      taskKey: state.taskKey,

      leagueId: state.leagueId,

      season: state.season,

      eventId: state.eventId,

      priority: state.priority,

      status: state.status,

      trackingMode: state.trackingMode,

      dateFrom: state.dateFrom,

      dateTo: state.dateTo,

      cronExpression: state.cronExpression,

      timeZone: state.timeZone,

      lastStartedAt: state.lastStartedAt,

      lastSuccessfulAt: state.lastSuccessfulAt,

      nextRunAt: state.nextRunAt,

      lastCompletedAt: state.lastCompletedAt,

      lastQueueJobKey: state.lastQueueJobKey,

      consecutiveFailures: state.consecutiveFailures,

      lastError: state.lastError,

      units,

      updatedAt: state.updatedAt,

      createdAt: state.createdAt,

      progress: {
        total: units.length,

        completed,

        processing: units.filter(
          (unit) => unit.status === SportsSyncUnitStatus.PROCESSING,
        ).length,

        pending: units.filter(
          (unit) => unit.status === SportsSyncUnitStatus.PENDING,
        ).length,

        failed: units.filter(
          (unit) => unit.status === SportsSyncUnitStatus.FAILED,
        ).length,

        percent:
          units.length > 0 ? Math.round((completed / units.length) * 100) : 0,
      },

      currentUnit: this.getCurrentSyncUnit(state),
    };
  }

  private getCurrentSyncUnit(state: Pick<SportsSyncState, 'units'> | null) {
    if (!state?.units?.length) {
      return null;
    }

    const unit =
      state.units.find(
        (candidate) => candidate.status === SportsSyncUnitStatus.PROCESSING,
      ) ??
      state.units.find(
        (candidate) =>
          candidate.status === SportsSyncUnitStatus.FAILED ||
          candidate.status === SportsSyncUnitStatus.PENDING,
      );

    if (!unit) {
      return null;
    }

    return {
      key: unit.key,

      type: unit.type,

      dateKey: unit.dateKey,

      stepKey: unit.stepKey,

      status: unit.status,

      attempts: unit.attempts,

      startedAt: unit.startedAt,

      completedAt: unit.completedAt,

      nextAttemptAt: unit.nextAttemptAt,

      lastError: unit.lastError,
    };
  }

  // ============================================================
  // ADMIN: ESPN QUEUE
  // ============================================================

  async getAdminEspnQueues(query: SportsAdminQuery = {}) {
    const filter: Record<string, unknown> = {};

    if (query.status) {
      filter.status = query.status;
    }

    if (query.type) {
      filter.type = query.type;
    }

    if (query.leagueId) {
      filter.leagueId = query.leagueId.trim();
    }

    if (query.eventId) {
      filter.eventId = query.eventId.trim();
    }

    if (query.competitionId) {
      filter.competitionId = query.competitionId.trim();
    }

    if (typeof query.season === 'number') {
      filter.season = query.season;
    }

    this.addDateRange(filter, 'scheduledFor', query.from, query.to);

    return this.paginateModel(
      this.espnQueueModel,
      {
        ...query,
        sortBy: query.sortBy ?? 'scheduledFor',
      },
      filter,
    );
  }

  async getAdminEspnQueueSummary() {
    const [
      pending,
      processing,
      completed,
      failed,
      fixtureRefresh,
      summaryRefresh,
      total,
    ] = await Promise.all([
      this.espnQueueModel.countDocuments({
        status: EspnQueueStatus.PENDING,
      }),

      this.espnQueueModel.countDocuments({
        status: EspnQueueStatus.PROCESSING,
      }),

      this.espnQueueModel.countDocuments({
        status: EspnQueueStatus.COMPLETED,
      }),

      this.espnQueueModel.countDocuments({
        status: EspnQueueStatus.FAILED,
      }),

      this.espnQueueModel.countDocuments({
        type: EspnQueueJobType.FIXTURE_REFRESH,
      }),

      this.espnQueueModel.countDocuments({
        type: EspnQueueJobType.SUMMARY_REFRESH,
      }),

      this.espnQueueModel.countDocuments(),
    ]);

    return {
      total,

      status: {
        pending,
        processing,
        completed,
        failed,
      },

      type: {
        fixtureRefresh,
        summaryRefresh,
      },
    };
  }

  // ============================================================
  // ADMIN: ESPN FIXTURES
  // ============================================================

  async getAdminEspnFixtures(query: SportsAdminQuery = {}) {
    const filter: Record<string, unknown> = {};

    if (query.leagueId) {
      filter.leagueId = query.leagueId.trim();
    }

    if (query.eventId) {
      filter.eventId = query.eventId.trim();
    }

    if (query.status) {
      filter.status = query.status;
    }

    if (typeof query.season === 'number') {
      filter.season = query.season;
    }

    if (query.teamId) {
      filter.$or = [
        {
          homeTeamId: query.teamId.trim(),
        },
        {
          awayTeamId: query.teamId.trim(),
        },
      ];
    }

    this.addDateRange(filter, 'fixtureDate', query.from, query.to);

    return this.paginateModel(
      this.espnFixtureModel,
      {
        ...query,
        sortBy: query.sortBy ?? 'fixtureDate',
      },
      filter,
    );
  }

  // ============================================================
  // ADMIN: ESPN LEAGUES
  // ============================================================

  async getAdminEspnLeagues(query: SportsAdminQuery = {}) {
    const filter: Record<string, unknown> = {};

    if (query.leagueId) {
      filter.leagueId = query.leagueId.trim();
    }

    if (query.status) {
      filter.isActive = query.status === 'active';
    }

    return this.paginateModel(
      this.espnLeagueModel,
      {
        ...query,
        sortBy: query.sortBy ?? 'name',
        sortOrder: query.sortOrder ?? 'asc',
      },
      filter,
    );
  }

  // ============================================================
  // ADMIN: ESPN LIVE MATCHES
  // ============================================================

  async getAdminEspnLiveMatches(query: SportsAdminQuery = {}) {
    const filter: Record<string, unknown> = {
      live: true,
    };

    if (query.leagueId) {
      filter.leagueId = query.leagueId.trim().toLowerCase();
    }

    if (query.eventId) {
      filter.eventId = query.eventId.trim();
    }

    return this.paginateModel(
      this.espnFixtureModel,
      {
        ...query,
        sortBy: query.sortBy ?? 'fixtureDate',
      },
      filter,
    );
  }

  // ============================================================
  // ADMIN: ESPN NEWS
  // ============================================================

  async getAdminEspnNews(query: SportsAdminQuery = {}) {
    const filter: Record<string, unknown> = {};

    this.addDateRange(filter, 'collectedAt', query.from, query.to);

    return this.paginateModel(
      this.espnNewsModel,
      {
        ...query,
        sortBy: query.sortBy ?? 'collectedAt',
      },
      filter,
    );
  }

  // ============================================================
  // ADMIN: ESPN STANDINGS FALLBACK
  // ============================================================

  async getAdminEspnStandings(query: SportsAdminQuery = {}) {
    const filter: Record<string, unknown> = {};

    if (query.leagueId) {
      filter.leagueId = query.leagueId.trim();
    }

    if (query.teamId) {
      filter.teamId = query.teamId.trim();
    }

    if (typeof query.season === 'number') {
      filter.season = query.season;
    }

    return this.paginateModel(
      this.espnStandingModel,
      {
        ...query,
        sortBy: query.sortBy ?? 'rank',
        sortOrder: query.sortOrder ?? 'asc',
      },
      filter,
    );
  }

  // ============================================================
  // ADMIN: ESPN TEAMS
  // ============================================================

  async getAdminEspnTeams(query: SportsAdminQuery = {}) {
    const filter: Record<string, unknown> = {};

    if (query.leagueId) {
      filter.leagueId = query.leagueId.trim();
    }

    if (query.teamId) {
      filter.teamId = query.teamId.trim();
    }

    return this.paginateModel(
      this.espnTeamModel,
      {
        ...query,
        sortBy: query.sortBy ?? 'name',
        sortOrder: query.sortOrder ?? 'asc',
      },
      filter,
    );
  }

  // ============================================================
  // ADMIN: FOOTBALL-DATA COMPETITIONS
  // ============================================================

  async getAdminFootballDataCompetitions(query: SportsAdminQuery = {}) {
    return this.paginateModel(this.footballDataCompetitionModel, {
      ...query,
      sortBy: query.sortBy ?? 'name',
      sortOrder: query.sortOrder ?? 'asc',
    });
  }

  // ============================================================
  // ADMIN: FOOTBALL-DATA MATCHES
  // ============================================================

  async getAdminFootballDataMatches(query: SportsAdminQuery = {}) {
    const filter: Record<string, unknown> = {};

    if (query.competitionId) {
      filter.competitionCode = query.competitionId.trim().toUpperCase();
    }

    if (query.status) {
      filter.status = query.status;
    }

    this.addDateRange(filter, 'utcDate', query.from, query.to);

    return this.paginateModel(
      this.footballDataMatchModel,
      {
        ...query,
        sortBy: query.sortBy ?? 'utcDate',
      },
      filter,
    );
  }

  // ============================================================
  // ADMIN: FOOTBALL-DATA STANDINGS
  // ============================================================

  async getAdminFootballDataStandings(query: SportsAdminQuery = {}) {
    const filter: Record<string, unknown> = {};

    if (query.competitionId) {
      filter.competitionCode = query.competitionId.trim().toUpperCase();
    }

    if (typeof query.season === 'number') {
      filter.seasonId = query.season;
    }

    return this.paginateModel(
      this.footballDataStandingModel,
      {
        ...query,
        sortBy: query.sortBy ?? 'seasonId',
      },
      filter,
    );
  }

  // ============================================================
  // ADMIN: FOOTBALL-DATA TEAMS
  // ============================================================

  async getAdminFootballDataTeams(query: SportsAdminQuery = {}) {
    const filter: Record<string, unknown> = {};

    if (query.competitionId) {
      filter.competitionCode = query.competitionId.trim().toUpperCase();
    }

    if (query.teamId) {
      filter.teamId = Number(query.teamId);
    }

    return this.paginateModel(
      this.footballDataTeamModel,
      {
        ...query,
        sortBy: query.sortBy ?? 'name',
        sortOrder: query.sortOrder ?? 'asc',
      },
      filter,
    );
  }

  // ============================================================
  // ADMIN: ODDS API SPORTS
  // ============================================================

  async getAdminOddsApiSports(query: SportsAdminQuery = {}) {
    const filter: Record<string, unknown> = {};

    if (query.provider) {
      filter.sportKey = query.provider.trim();
    }

    return this.paginateModel(
      this.oddsApiSportModel,
      {
        ...query,
        sortBy: query.sortBy ?? 'title',
        sortOrder: query.sortOrder ?? 'asc',
      },
      filter,
    );
  }

  // ============================================================
  // ADMIN: SPORTS ODDS SNAPSHOTS
  // ============================================================

  async getAdminSportsOddsSnapshots(query: SportsAdminQuery = {}) {
    const filter: Record<string, unknown> = {};

    if (query.eventId) {
      filter.eventId = query.eventId.trim();
    }

    if (query.provider) {
      filter.provider = query.provider.trim();
    }

    this.addDateRange(filter, 'collectedAt', query.from, query.to);

    return this.paginateModel(
      this.sportsOddsSnapshotModel,
      {
        ...query,
        sortBy: query.sortBy ?? 'collectedAt',
      },
      filter,
    );
  }

  // ============================================================
  // ADMIN: PROVIDER RATE LIMITS
  // ============================================================

  async getAdminProviderRateLimits(query: SportsAdminQuery = {}) {
    const filter: Record<string, unknown> = {};

    if (query.provider) {
      filter.provider = query.provider.trim();
    }

    return this.paginateModel(
      this.sportsProviderRateLimitModel,
      {
        ...query,
        sortBy: query.sortBy ?? 'provider',
        sortOrder: query.sortOrder ?? 'asc',
      },
      filter,
    );
  }

  // ============================================================
  // ADMIN: YOUTUBE HIGHLIGHTS
  // ============================================================

  async getAdminYoutubeHighlights(query: SportsAdminQuery = {}) {
    const filter: Record<string, unknown> = {};

    if (query.status) {
      filter.status = query.status;
    }

    if (query.eventId) {
      filter.fixtureId = query.eventId.trim();
    }

    if (query.competitionId) {
      filter.competitionId = query.competitionId.trim();
    }

    this.addDateRange(filter, 'searchedAt', query.from, query.to);

    return this.paginateModel(
      this.youtubeHighlightModel,
      {
        ...query,
        sortBy: query.sortBy ?? 'searchedAt',
      },
      filter,
    );
  }

  // ============================================================
  // FIXTURE HELPERS
  // ============================================================

  async getFixtureByEventId(
    eventId: string,
  ): Promise<EspnFixtureDocument | null> {
    const normalizedEventId = eventId.trim();

    if (!normalizedEventId) {
      return null;
    }

    return this.espnFixtureModel
      .findOne({
        eventId: normalizedEventId,
      })
      .lean()
      .exec();
  }

  async getFixturesByEventIds(
    eventIds: string[],
  ): Promise<EspnFixtureDocument[]> {
    const normalizedEventIds = [
      ...new Set(eventIds.map((id) => id.trim()).filter(Boolean)),
    ];

    if (!normalizedEventIds.length) {
      return [];
    }

    return this.espnFixtureModel
      .find({
        eventId: {
          $in: normalizedEventIds,
        },
      })
      .lean()
      .exec();
  }
}
