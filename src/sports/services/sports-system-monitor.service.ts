// backend/src/sports/services/sports-system-monitor.service.ts

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

// ============================================================
// ESPN
// ============================================================

import {
  EspnLeague,
  EspnLeagueDocument,
} from '../schemas/espn/espn-league.schema';

import {
  EspnFixture,
  EspnFixtureDocument,
} from '../schemas/espn/espn-fixture.schema';

import {
  EspnStanding,
  EspnStandingDocument,
} from '../schemas/espn/espn-standing.schema';

import { EspnNews, EspnNewsDocument } from '../schemas/espn/espn-news.schema';

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
} from '../schemas/sports-sync-state.schema';

// ============================================================
// PROVIDER RATE LIMIT
// ============================================================

import {
  SportsProviderRateLimit,
  SportsProviderRateLimitDocument,
} from '../schemas/sports-provider-rate-limit.schema';

import { SportsProviderRateLimitService } from './sports-provider-rate-limit.service';

// ============================================================
// YOUTUBE
// ============================================================

import {
  YouTubeHighlight,
  YouTubeHighlightDocument,
} from '../schemas/youtube-highlight.schema';

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
// MONITOR INTERFACES
// ============================================================

import {
  MonitorExpectedWork,
  MonitorInventory,
  MonitorLeagueSummary,
  MonitorPipelineDefinition,
  MonitorProviderSummary,
  MonitorQueueItem,
  MonitorQueueSummary,
  MonitorSyncFailure,
  MonitorSyncStageSummary,
  MonitorSyncStateDetail,
  MonitorSyncSummary,
  MonitorUpcomingFixture,
  MonitorUpcomingSummary,
  SportsSystemMonitorQuery,
  SportsSystemMonitorResponse,
} from '../interfaces/sports-system-monitor.interface';

// ============================================================
// INTERNAL TYPES
// ============================================================

interface LeagueContext {
  competition: ActiveCompetitionDocument;
  key: string;
  aliases: string[];
  season?: number;
}

interface FixtureAggregate {
  total: number;
  upcoming: number;
  live: number;
  finished: number;
  withSummary: number;
  missingSummary: number;
  finishedMissingSummary: number;
  summaryCoveragePercent: number;
  latestCollectedAt?: Date;
  latestSummaryCollectedAt?: Date;
  storedSeasons: number;
}

interface TeamAggregate {
  documents: number;
  teamIds: Set<string>;
  latestCollectedAt?: Date;
}

interface QueueAggregate {
  total: number;
  byStatus: Map<string, number>;
  byType: Map<string, number>;
  byTypeAndStatus: Map<string, number>;
  staleProcessing: number;
  latestFailureAt?: Date;
  latestFailure?: string;
  latestCompletedAt?: Date;
}

interface SyncAggregate {
  stateCounts: Record<string, number>;
  queueStates: number;
  cronStates: number;

  unitProgress: {
    total: number;
    success: number;
    processing: number;
    pending: number;
    failed: number;
  };

  currentStages: MonitorSyncStageSummary[];
  failures: MonitorSyncFailure[];
  cron: SportsSystemMonitorResponse['sync']['cron'];
  states: MonitorSyncStateDetail[];

  latestSuccessfulAt?: Date;
  latestCompletedAt?: Date;
  nextRunAt?: Date;
}

interface OperationalSeasonData {
  fixtures: Map<string, FixtureAggregate>;
  expectedTeams: Map<string, Set<string>>;
}

interface UpcomingIndexes {
  summaries: Set<string>;
  odds: Set<string>;
}

interface ProviderConfig {
  minIntervalSeconds: number;
  dailyRequestLimit: number | null;
  monthlyRequestLimit: number | null;
}

interface ProviderStatePeriods {
  dailyPeriod?: Date | string;
  monthlyPeriod?: Date | string;
}

// ============================================================
// CONSTANTS
// ============================================================

const COMPLETED_STATUSES = new Set([
  'FT',
  'AET',
  'PEN',
  'FINAL',
  'FINISHED',
  'COMPLETED',
  'POST',
  'STATUS_FINAL',
]);

const QUEUE_COMPLETED_RETENTION_DAYS = 7;

const STALE_PROCESSING_MINUTES = 5;

const UPCOMING_WINDOW_DAYS = 4;

const STALE_ACTIVE_LEAGUE_HOURS = 48;

type ConfiguredSportsProvider = Parameters<
  SportsProviderRateLimitService['getDailyUsage']
>[0];

const PROVIDER_CONFIG: Record<ConfiguredSportsProvider, ProviderConfig> = {
  espn: {
    minIntervalSeconds: 2,
    dailyRequestLimit: null,
    monthlyRequestLimit: null,
  },

  'football-data': {
    minIntervalSeconds: 60,
    dailyRequestLimit: null,
    monthlyRequestLimit: null,
  },

  'odds-api': {
    minIntervalSeconds: 60,
    dailyRequestLimit: null,
    monthlyRequestLimit: 500,
  },

  youtube: {
    minIntervalSeconds: 200,
    dailyRequestLimit: 90,
    monthlyRequestLimit: null,
  },
};

// ============================================================
// SERVICE
// ============================================================

@Injectable()
export class SportsSystemMonitorService {
  constructor(
    // ----------------------------------------------------------
    // ACTIVE COMPETITIONS
    // ----------------------------------------------------------

    @InjectModel(ActiveCompetition.name)
    private readonly activeCompetitionModel: Model<ActiveCompetitionDocument>,

    // ----------------------------------------------------------
    // ESPN
    // ----------------------------------------------------------

    @InjectModel(EspnLeague.name)
    private readonly espnLeagueModel: Model<EspnLeagueDocument>,

    @InjectModel(EspnFixture.name)
    private readonly espnFixtureModel: Model<EspnFixtureDocument>,

    @InjectModel(EspnTeam.name)
    private readonly espnTeamModel: Model<EspnTeamDocument>,

    @InjectModel(EspnStanding.name)
    private readonly espnStandingModel: Model<EspnStandingDocument>,

    @InjectModel(EspnNews.name)
    private readonly espnNewsModel: Model<EspnNewsDocument>,

    // ----------------------------------------------------------
    // QUEUE
    // ----------------------------------------------------------

    @InjectModel(EspnQueue.name)
    private readonly espnQueueModel: Model<EspnQueueDocument>,

    // ----------------------------------------------------------
    // SYNC STATE
    // ----------------------------------------------------------

    @InjectModel(SportsSyncState.name)
    private readonly sportsSyncStateModel: Model<SportsSyncStateDocument>,

    // ----------------------------------------------------------
    // RATE LIMIT
    // ----------------------------------------------------------

    @InjectModel(SportsProviderRateLimit.name)
    private readonly sportsProviderRateLimitModel: Model<SportsProviderRateLimitDocument>,

    private readonly providerRateLimitService: SportsProviderRateLimitService,

    // ----------------------------------------------------------
    // YOUTUBE
    // ----------------------------------------------------------

    @InjectModel(YouTubeHighlight.name)
    private readonly youtubeHighlightModel: Model<YouTubeHighlightDocument>,

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
    // ODDS
    // ----------------------------------------------------------

    @InjectModel(OddsApiSport.name)
    private readonly oddsApiSportModel: Model<OddsApiSportDocument>,

    @InjectModel(SportsOddsSnapshot.name)
    private readonly sportsOddsSnapshotModel: Model<SportsOddsSnapshotDocument>,
  ) {}

  // ============================================================
  // PUBLIC
  // ============================================================

  async getSystemMonitor(
    query: SportsSystemMonitorQuery = {},
  ): Promise<SportsSystemMonitorResponse> {
    const now = new Date();

    const activeCompetitions = await this.getActiveCompetitions(query);

    const catalogue = await this.espnLeagueModel.find({}).lean().exec();

    const catalogueById = new Map<string, EspnLeagueDocument>();

    for (const league of catalogue) {
      const leagueId = this.normalize(league.leagueId);
      const slug = this.normalize(league.slug);

      if (leagueId) {
        catalogueById.set(leagueId, league);
      }

      if (slug) {
        catalogueById.set(slug, league);
      }
    }

    const contexts: LeagueContext[] = activeCompetitions.map((competition) => ({
      competition,
      key: this.normalize(competition.competitionId),

      aliases: [
        ...new Set(
          [competition.competitionId, competition.espnLeagueSlug]
            .map((value) => this.normalize(value))
            .filter(Boolean),
        ),
      ],

      season:
        typeof competition.season === 'number' ? competition.season : undefined,
    }));

    const [inventory, queue, sync, providers] = await Promise.all([
      this.buildInventory(),
      this.buildQueueSummary(),
      this.buildSyncSummary(contexts, now),
      this.buildProviderSummaries(),
    ]);

    const pipeline = this.buildPipelineDefinitions(sync);

    if (!contexts.length) {
      return {
        generatedAt: this.toIso(now) as string,

        scope: {
          activeLeagueFilter: query.leagueId
            ? this.normalize(query.leagueId)
            : undefined,

          activeCompetitions: 0,

          catalogueCompetitions: catalogue.length,

          operationalSeasonScope: true,
        },

        inventory,

        queue,

        sync,

        pipeline,

        providers,

        expectedWork: this.emptyExpectedWork(),

        leagues: [],

        architectureNotes: this.getArchitectureNotes(),
      };
    }

    const [
      operationalSeasonData,
      teamAggregates,
      queueAggregates,
      syncAggregates,
      upcomingFixtures,
    ] = await Promise.all([
      this.buildOperationalSeasonData(contexts, now),

      this.aggregateTeams(contexts),

      this.aggregateQueueData(contexts),

      this.aggregateSyncData(contexts, now),

      this.loadUpcomingFixtures(contexts, now),
    ]);

    const upcomingIndexes = await this.buildUpcomingIndexes(upcomingFixtures);

    const leagues = contexts.map((context) =>
      this.buildLeagueSummary({
        context,
        catalogueById,
        operationalSeasonData,
        teamAggregates,
        queueAggregates,
        syncAggregates,
        upcomingFixtures,
        upcomingIndexes,
      }),
    );

    const expectedWork = this.sumExpectedWork(
      leagues.map((league) => league.expectedWork),
    );

    return {
      generatedAt: this.toIso(now) as string,

      scope: {
        activeLeagueFilter: query.leagueId
          ? this.normalize(query.leagueId)
          : undefined,

        activeCompetitions: activeCompetitions.length,

        catalogueCompetitions: catalogue.length,

        operationalSeasonScope: true,
      },

      inventory,

      queue,

      sync,

      pipeline,

      providers,

      expectedWork,

      leagues,

      architectureNotes: this.getArchitectureNotes(),
    };
  }

  // ============================================================
  // ACTIVE COMPETITIONS
  // ============================================================

  private async getActiveCompetitions(
    query: SportsSystemMonitorQuery,
  ): Promise<ActiveCompetitionDocument[]> {
    const filter: Record<string, unknown> = {};

    if (query.leagueId?.trim()) {
      const normalized = this.normalize(query.leagueId);

      filter.$or = [
        {
          competitionId: normalized,
        },

        {
          espnLeagueSlug: normalized,
        },
      ];
    }

    return this.activeCompetitionModel
      .find(filter)
      .sort({
        priority: 1,
        nextFixtureDate: 1,
        name: 1,
      })
      .lean()
      .exec();
  }

  // ============================================================
  // INVENTORY
  // ============================================================

  private async buildInventory(): Promise<MonitorInventory> {
    const [
      activeCompetitions,
      espnCatalogue,
      espnFixtures,
      espnTeams,
      espnStandings,
      espnNews,
      espnQueue,
      sportsSyncStates,
      footballDataCompetitions,
      footballDataMatches,
      footballDataStandings,
      footballDataTeams,
      oddsApiSports,
      sportsOddsSnapshots,
      youtubeHighlights,
    ] = await Promise.all([
      this.activeCompetitionModel.countDocuments(),

      this.espnLeagueModel.countDocuments(),

      this.espnFixtureModel.countDocuments(),

      this.espnTeamModel.countDocuments(),

      this.espnStandingModel.countDocuments(),

      this.espnNewsModel.countDocuments(),

      this.espnQueueModel.countDocuments(),

      this.sportsSyncStateModel.countDocuments(),

      this.footballDataCompetitionModel.countDocuments(),

      this.footballDataMatchModel.countDocuments(),

      this.footballDataStandingModel.countDocuments(),

      this.footballDataTeamModel.countDocuments(),

      this.oddsApiSportModel.countDocuments(),

      this.sportsOddsSnapshotModel.countDocuments(),

      this.youtubeHighlightModel.countDocuments(),
    ]);

    return {
      activeCompetitions,
      espnCatalogue,
      espnFixtures,
      espnTeams,
      espnStandings,
      espnNews,
      espnQueue,
      sportsSyncStates,
      footballDataCompetitions,
      footballDataMatches,
      footballDataStandings,
      footballDataTeams,
      oddsApiSports,
      sportsOddsSnapshots,
      youtubeHighlights,
    };
  }

  // ============================================================
  // OPERATIONAL SEASON DATA
  // ============================================================

  private async buildOperationalSeasonData(
    contexts: LeagueContext[],
    now: Date,
  ): Promise<OperationalSeasonData> {
    const clauses = contexts
      .filter((context) => typeof context.season === 'number')
      .flatMap((context) =>
        context.aliases.map((leagueId) => ({
          leagueId,
          season: context.season,
        })),
      );

    const contextByAlias = new Map<string, LeagueContext>();

    for (const context of contexts) {
      for (const alias of context.aliases) {
        contextByAlias.set(alias, context);
      }
    }

    const fixtureRows = clauses.length
      ? await this.espnFixtureModel
          .aggregate<{
            _id: {
              leagueId: string;
              season: number;
            };

            total: number;

            upcoming: number;

            live: number;

            finished: number;

            withSummary: number;

            finishedWithSummary: number;

            latestCollectedAt?: Date;

            latestSummaryCollectedAt?: Date;
          }>([
            {
              $match: {
                $or: clauses,
              },
            },

            {
              $group: {
                _id: {
                  leagueId: '$leagueId',
                  season: '$season',
                },

                total: {
                  $sum: 1,
                },

                upcoming: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          {
                            $gte: ['$fixtureDate', now],
                          },

                          {
                            $ne: ['$completed', true],
                          },
                        ],
                      },

                      1,

                      0,
                    ],
                  },
                },

                live: {
                  $sum: {
                    $cond: [
                      {
                        $eq: ['$live', true],
                      },

                      1,

                      0,
                    ],
                  },
                },

                finished: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          {
                            $eq: ['$completed', true],
                          },

                          {
                            $in: ['$status', [...COMPLETED_STATUSES]],
                          },
                        ],
                      },

                      1,

                      0,
                    ],
                  },
                },

                withSummary: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          {
                            $ne: [
                              {
                                $ifNull: ['$payload.summary', null],
                              },

                              null,
                            ],
                          },

                          {
                            $ne: [
                              {
                                $ifNull: ['$payload.summary', {}],
                              },

                              {},
                            ],
                          },
                        ],
                      },

                      1,

                      0,
                    ],
                  },
                },

                finishedWithSummary: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          {
                            $or: [
                              {
                                $eq: ['$completed', true],
                              },

                              {
                                $in: ['$status', [...COMPLETED_STATUSES]],
                              },
                            ],
                          },

                          {
                            $ne: [
                              {
                                $ifNull: ['$payload.summary', null],
                              },

                              null,
                            ],
                          },

                          {
                            $ne: [
                              {
                                $ifNull: ['$payload.summary', {}],
                              },

                              {},
                            ],
                          },
                        ],
                      },

                      1,

                      0,
                    ],
                  },
                },

                latestCollectedAt: {
                  $max: '$collectedAt',
                },

                latestSummaryCollectedAt: {
                  $max: '$payload.summaryCollectedAt',
                },
              },
            },
          ])
          .exec()
      : [];

    const expectedTeams = new Map<string, Set<string>>();

    const fixtureRowsForTeams = clauses.length
      ? await this.espnFixtureModel
          .find({
            $or: clauses,
          })
          .select({
            leagueId: 1,
            season: 1,
            homeTeamId: 1,
            awayTeamId: 1,
          })
          .lean()
          .exec()
      : [];

    for (const fixture of fixtureRowsForTeams) {
      const context = contextByAlias.get(this.normalize(fixture.leagueId));

      if (!context) {
        continue;
      }

      if (fixture.season !== context.season) {
        continue;
      }

      if (!expectedTeams.has(context.key)) {
        expectedTeams.set(context.key, new Set<string>());
      }

      if (fixture.homeTeamId) {
        expectedTeams.get(context.key)!.add(String(fixture.homeTeamId));
      }

      if (fixture.awayTeamId) {
        expectedTeams.get(context.key)!.add(String(fixture.awayTeamId));
      }
    }

    const fixtureAggregates = new Map<string, FixtureAggregate>();

    const storedSeasonSets = new Map<string, Set<number>>();

    for (const row of fixtureRows) {
      const context = contextByAlias.get(this.normalize(row._id.leagueId));

      if (!context) {
        continue;
      }

      if (
        typeof row._id.season !== 'number' ||
        row._id.season !== context.season
      ) {
        continue;
      }

      const key = context.key;

      const total = Number(row.total ?? 0);

      const withSummary = Number(row.withSummary ?? 0);

      const finished = Number(row.finished ?? 0);

      const finishedWithSummary = Number(row.finishedWithSummary ?? 0);

      const existing = fixtureAggregates.get(key);

      if (!storedSeasonSets.has(key)) {
        storedSeasonSets.set(key, new Set<number>());
      }

      storedSeasonSets.get(key)!.add(row._id.season);

      const incoming: FixtureAggregate = {
        total,

        upcoming: Number(row.upcoming ?? 0),

        live: Number(row.live ?? 0),

        finished,

        withSummary,

        missingSummary: Math.max(0, total - withSummary),

        finishedMissingSummary: Math.max(0, finished - finishedWithSummary),

        summaryCoveragePercent:
          total > 0 ? this.percent(withSummary, total) : 0,

        latestCollectedAt: row.latestCollectedAt,

        latestSummaryCollectedAt: row.latestSummaryCollectedAt,

        storedSeasons: 1,
      };

      if (!existing) {
        fixtureAggregates.set(key, incoming);

        continue;
      }

      existing.total += incoming.total;

      existing.upcoming += incoming.upcoming;

      existing.live += incoming.live;

      existing.finished += incoming.finished;

      existing.withSummary += incoming.withSummary;

      existing.missingSummary += incoming.missingSummary;

      existing.finishedMissingSummary += incoming.finishedMissingSummary;

      if (
        incoming.latestCollectedAt &&
        (!existing.latestCollectedAt ||
          incoming.latestCollectedAt.getTime() >
            existing.latestCollectedAt.getTime())
      ) {
        existing.latestCollectedAt = incoming.latestCollectedAt;
      }

      if (
        incoming.latestSummaryCollectedAt &&
        (!existing.latestSummaryCollectedAt ||
          incoming.latestSummaryCollectedAt.getTime() >
            existing.latestSummaryCollectedAt.getTime())
      ) {
        existing.latestSummaryCollectedAt = incoming.latestSummaryCollectedAt;
      }
    }

    for (const [key, aggregate] of fixtureAggregates) {
      aggregate.summaryCoveragePercent =
        aggregate.total > 0
          ? this.percent(aggregate.withSummary, aggregate.total)
          : 0;

      aggregate.storedSeasons = storedSeasonSets.get(key)?.size ?? 0;
    }

    return {
      fixtures: fixtureAggregates,

      expectedTeams,
    };
  }

  // ============================================================
  // TEAMS
  // ============================================================

  private async aggregateTeams(
    contexts: LeagueContext[],
  ): Promise<Map<string, TeamAggregate>> {
    const aliases = [
      ...new Set(contexts.flatMap((context) => context.aliases)),
    ];

    if (!aliases.length) {
      return new Map();
    }

    const contextByAlias = new Map<string, LeagueContext>();

    for (const context of contexts) {
      for (const alias of context.aliases) {
        contextByAlias.set(alias, context);
      }
    }

    const rows = await this.espnTeamModel
      .aggregate<{
        _id: string;
        documents: number;
        teamIds: string[];
        latestCollectedAt?: Date;
      }>([
        {
          $match: {
            leagueId: {
              $in: aliases,
            },
          },
        },

        {
          $group: {
            _id: '$leagueId',

            documents: {
              $sum: 1,
            },

            teamIds: {
              $addToSet: '$teamId',
            },

            latestCollectedAt: {
              $max: '$collectedAt',
            },
          },
        },
      ])
      .exec();

    const result = new Map<string, TeamAggregate>();

    for (const row of rows) {
      const context = contextByAlias.get(this.normalize(row._id));

      if (!context) {
        continue;
      }

      const incoming: TeamAggregate = {
        documents: Number(row.documents ?? 0),

        teamIds: new Set(
          (row.teamIds ?? []).filter(Boolean).map((teamId) => String(teamId)),
        ),

        latestCollectedAt: row.latestCollectedAt,
      };

      const current = result.get(context.key);

      if (!current) {
        result.set(context.key, incoming);

        continue;
      }

      current.documents += incoming.documents;

      for (const teamId of incoming.teamIds) {
        current.teamIds.add(teamId);
      }

      if (
        incoming.latestCollectedAt &&
        (!current.latestCollectedAt ||
          incoming.latestCollectedAt.getTime() >
            current.latestCollectedAt.getTime())
      ) {
        current.latestCollectedAt = incoming.latestCollectedAt;
      }
    }

    return result;
  }

  // ============================================================
  // QUEUE
  // ============================================================

  private async buildQueueSummary(): Promise<MonitorQueueSummary> {
    const staleCutoff = new Date(
      Date.now() - STALE_PROCESSING_MINUTES * 60 * 1000,
    );

    const [
      statusRows,
      typeRows,
      typeStatusRows,
      latestFailure,
      latestCompleted,
      staleProcessing,
    ] = await Promise.all([
      this.espnQueueModel
        .aggregate<{
          _id: string;
          count: number;
        }>([
          {
            $group: {
              _id: '$status',

              count: {
                $sum: 1,
              },
            },
          },
        ])
        .exec(),

      this.espnQueueModel
        .aggregate<{
          _id: string;
          count: number;
        }>([
          {
            $group: {
              _id: '$type',

              count: {
                $sum: 1,
              },
            },
          },
        ])
        .exec(),

      this.espnQueueModel
        .aggregate<{
          _id: {
            type: string;
            status: string;
          };

          count: number;
        }>([
          {
            $group: {
              _id: {
                type: '$type',
                status: '$status',
              },

              count: {
                $sum: 1,
              },
            },
          },
        ])
        .exec(),

      this.espnQueueModel
        .findOne({
          status: EspnQueueStatus.FAILED,
        })
        .sort({
          failedAt: -1,
          updatedAt: -1,
        })
        .lean()
        .exec(),

      this.espnQueueModel
        .findOne({
          status: EspnQueueStatus.COMPLETED,
        })
        .sort({
          completedAt: -1,
          updatedAt: -1,
        })
        .lean()
        .exec(),

      this.espnQueueModel.countDocuments({
        status: EspnQueueStatus.PROCESSING,

        updatedAt: {
          $lt: staleCutoff,
        },
      }),
    ]);

    const byStatus: Record<string, number> = {};

    for (const row of statusRows) {
      byStatus[String(row._id)] = Number(row.count ?? 0);
    }

    const byType: Record<string, number> = {};

    for (const row of typeRows) {
      byType[String(row._id)] = Number(row.count ?? 0);
    }

    const byTypeAndStatus: MonitorQueueItem[] = typeStatusRows.map((row) => ({
      type: String(row._id.type),

      status: String(row._id.status),

      count: Number(row.count ?? 0),
    }));

    return {
      total: Object.values(byStatus).reduce((sum, value) => sum + value, 0),

      pending: byStatus[EspnQueueStatus.PENDING] ?? 0,

      processing: byStatus[EspnQueueStatus.PROCESSING] ?? 0,

      completedRetained: byStatus[EspnQueueStatus.COMPLETED] ?? 0,

      failed: byStatus[EspnQueueStatus.FAILED] ?? 0,

      staleProcessing,

      completedRetentionDays: QUEUE_COMPLETED_RETENTION_DAYS,

      byType,

      byTypeAndStatus,

      latestFailureAt: latestFailure?.failedAt
        ? this.toIso(latestFailure.failedAt)
        : undefined,

      latestFailure:
        (
          latestFailure as unknown as {
            lastError?: string;
            error?: string;
          } | null
        )?.lastError ??
        (
          latestFailure as unknown as {
            lastError?: string;
            error?: string;
          } | null
        )?.error,

      latestCompletedAt: latestCompleted?.completedAt
        ? this.toIso(latestCompleted.completedAt)
        : undefined,
    };
  }

  private async aggregateQueueData(
    contexts: LeagueContext[],
  ): Promise<Map<string, QueueAggregate>> {
    const clauses = contexts.flatMap((context) =>
      context.aliases.map((leagueId) => ({
        leagueId,

        ...(typeof context.season === 'number'
          ? {
              season: context.season,
            }
          : {}),
      })),
    );

    if (!clauses.length) {
      return new Map();
    }

    const contextByAlias = new Map<string, LeagueContext>();

    for (const context of contexts) {
      for (const alias of context.aliases) {
        contextByAlias.set(alias, context);
      }
    }

    const rows = await this.espnQueueModel
      .aggregate<{
        _id: {
          leagueId: string;
          type: string;
          status: string;
        };

        count: number;
      }>([
        {
          $match: {
            $or: clauses,
          },
        },

        {
          $group: {
            _id: {
              leagueId: '$leagueId',

              type: '$type',

              status: '$status',
            },

            count: {
              $sum: 1,
            },
          },
        },
      ])
      .exec();

    const result = new Map<string, QueueAggregate>();

    for (const row of rows) {
      const context = contextByAlias.get(this.normalize(row._id.leagueId));

      if (!context) {
        continue;
      }

      let aggregate = result.get(context.key);

      if (!aggregate) {
        aggregate = {
          total: 0,

          byStatus: new Map(),

          byType: new Map(),

          byTypeAndStatus: new Map(),

          staleProcessing: 0,
        };

        result.set(context.key, aggregate);
      }

      const count = Number(row.count ?? 0);

      const status = String(row._id.status);

      const type = String(row._id.type);

      aggregate.total += count;

      aggregate.byStatus.set(
        status,
        (aggregate.byStatus.get(status) ?? 0) + count,
      );

      aggregate.byType.set(type, (aggregate.byType.get(type) ?? 0) + count);

      const compoundKey = `${type}:${status}`;

      aggregate.byTypeAndStatus.set(
        compoundKey,
        (aggregate.byTypeAndStatus.get(compoundKey) ?? 0) + count,
      );
    }

    const staleCutoff = new Date(
      Date.now() - STALE_PROCESSING_MINUTES * 60 * 1000,
    );

    const staleRows = await this.espnQueueModel
      .aggregate<{
        _id: string;
        count: number;
      }>([
        {
          $match: {
            $or: clauses,

            status: EspnQueueStatus.PROCESSING,

            updatedAt: {
              $lt: staleCutoff,
            },
          },
        },

        {
          $group: {
            _id: '$leagueId',

            count: {
              $sum: 1,
            },
          },
        },
      ])
      .exec();

    for (const row of staleRows) {
      const context = contextByAlias.get(this.normalize(row._id));

      if (!context) {
        continue;
      }

      const aggregate = result.get(context.key);

      if (aggregate) {
        aggregate.staleProcessing += Number(row.count ?? 0);
      }
    }

    return result;
  }

  // ============================================================
  // SYNC SUMMARY
  // ============================================================

  private async buildSyncSummary(
    contexts: LeagueContext[],
    now: Date,
  ): Promise<MonitorSyncSummary> {
    const states = await this.sportsSyncStateModel.find({}).lean().exec();

    const contextByAlias = new Map<string, LeagueContext>();

    for (const context of contexts) {
      for (const alias of context.aliases) {
        contextByAlias.set(alias, context);
      }
    }

    const byStatus: Record<string, number> = {};

    let queueStates = 0;

    let cronStates = 0;

    let totalUnits = 0;

    let successUnits = 0;

    let processingUnits = 0;

    let pendingUnits = 0;

    let failedUnits = 0;

    let successfulStates = 0;

    let latestSuccessfulAt: Date | undefined;

    let latestCompletedAt: Date | undefined;

    let nextRunAt: Date | undefined;

    const stages: MonitorSyncStageSummary[] = [];

    const failures: MonitorSyncFailure[] = [];

    const cron: SportsSystemMonitorResponse['sync']['cron'] = [];

    const syncStateDetails: MonitorSyncStateDetail[] = [];

    for (const state of states) {
      const status = String(state.status);

      byStatus[status] = (byStatus[status] ?? 0) + 1;

      if (state.kind === SportsSyncStateKind.QUEUE) {
        queueStates += 1;

        const context = state.leagueId
          ? contextByAlias.get(this.normalize(state.leagueId))
          : undefined;

        syncStateDetails.push(
          this.buildSyncStateDetail(state, context?.competition.name, now),
        );
      }

      if (state.kind === SportsSyncStateKind.CRON) {
        cronStates += 1;

        cron.push({
          stateKey: state.stateKey,

          taskKey: state.taskKey,

          status,

          cronExpression: state.cronExpression,

          timeZone: state.timeZone,

          lastStartedAt: this.toIso(state.lastStartedAt),

          lastSuccessfulAt: this.toIso(state.lastSuccessfulAt),

          lastCompletedAt: this.toIso(state.lastCompletedAt),

          nextRunAt: this.toIso(state.nextRunAt),

          consecutiveFailures: state.consecutiveFailures ?? 0,

          lastError: state.lastError,
        });
      }

      if (state.status === SportsSyncStateStatus.SUCCESS) {
        successfulStates += 1;
      }

      if (state.lastSuccessfulAt) {
        const value = new Date(state.lastSuccessfulAt);

        if (
          !latestSuccessfulAt ||
          value.getTime() > latestSuccessfulAt.getTime()
        ) {
          latestSuccessfulAt = value;
        }
      }

      if (state.lastCompletedAt) {
        const value = new Date(state.lastCompletedAt);

        if (
          !latestCompletedAt ||
          value.getTime() > latestCompletedAt.getTime()
        ) {
          latestCompletedAt = value;
        }
      }

      if (state.nextRunAt) {
        const value = new Date(state.nextRunAt);

        if (!nextRunAt || value.getTime() < nextRunAt.getTime()) {
          nextRunAt = value;
        }
      }

      for (const unit of state.units ?? []) {
        totalUnits += 1;

        switch (unit.status) {
          case SportsSyncUnitStatus.SUCCESS:
            successUnits += 1;
            break;

          case SportsSyncUnitStatus.PROCESSING:
            processingUnits += 1;
            break;

          case SportsSyncUnitStatus.PENDING:
            pendingUnits += 1;
            break;

          case SportsSyncUnitStatus.FAILED:
            failedUnits += 1;
            break;
        }

        if (unit.status !== SportsSyncUnitStatus.SUCCESS) {
          stages.push({
            jobType: state.jobType,

            stage: unit.stepKey ?? unit.dateKey ?? unit.key,

            unitType: String(unit.type),

            status: String(unit.status),

            count: 1,
          });
        }
      }

      if (
        state.status === SportsSyncStateStatus.FAILED ||
        (state.consecutiveFailures ?? 0) > 0 ||
        state.lastError
      ) {
        failures.push({
          stateKey: state.stateKey,

          jobType: state.jobType,

          leagueId: state.leagueId,

          season: state.season,

          eventId: state.eventId,

          error: state.lastError,

          at: this.toIso(
            state.lastCompletedAt ?? state.lastStartedAt ?? state.updatedAt,
          ),

          consecutiveFailures: state.consecutiveFailures ?? 0,
        });
      }
    }

    const groupedStages = this.groupSyncStages(stages);

    failures.sort(
      (a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime(),
    );

    syncStateDetails.sort((a, b) => {
      const leagueCompare = (a.leagueName ?? '').localeCompare(
        b.leagueName ?? '',
      );

      if (leagueCompare !== 0) {
        return leagueCompare;
      }

      const jobCompare = (a.jobType ?? '').localeCompare(b.jobType ?? '');

      if (jobCompare !== 0) {
        return jobCompare;
      }

      return a.stateKey.localeCompare(b.stateKey);
    });

    return {
      totalStates: states.length,

      queueStates,

      cronStates,

      byStatus,

      unitProgress: {
        total: totalUnits,

        success: successUnits,

        processing: processingUnits,

        pending: pendingUnits,

        failed: failedUnits,

        completionPercent:
          totalUnits > 0 ? this.percent(successUnits, totalUnits) : 0,
      },

      stateCompletionPercent:
        states.length > 0 ? this.percent(successfulStates, states.length) : 0,

      currentStages: groupedStages,

      failures: failures.slice(0, 100),

      cron,

      states: syncStateDetails,

      latestSuccessfulAt: this.toIso(latestSuccessfulAt),

      latestCompletedAt: this.toIso(latestCompletedAt),

      nextRunAt: this.toIso(nextRunAt),
    };
  }

  private async aggregateSyncData(
    contexts: LeagueContext[],
    now: Date,
  ): Promise<Map<string, SyncAggregate>> {
    const clauses = contexts.flatMap((context) =>
      context.aliases.map((leagueId) => ({
        leagueId,

        ...(typeof context.season === 'number'
          ? {
              season: context.season,
            }
          : {}),
      })),
    );

    if (!clauses.length) {
      return new Map();
    }

    const contextByAlias = new Map<string, LeagueContext>();

    for (const context of contexts) {
      for (const alias of context.aliases) {
        contextByAlias.set(alias, context);
      }
    }

    const states = await this.sportsSyncStateModel
      .find({
        $or: clauses,
      })
      .lean()
      .exec();

    const result = new Map<string, SyncAggregate>();

    for (const state of states) {
      const context = contextByAlias.get(this.normalize(state.leagueId));

      if (!context) {
        continue;
      }

      let aggregate = result.get(context.key);

      if (!aggregate) {
        aggregate = {
          stateCounts: {},

          queueStates: 0,

          cronStates: 0,

          unitProgress: {
            total: 0,
            success: 0,
            processing: 0,
            pending: 0,
            failed: 0,
          },

          currentStages: [],

          failures: [],

          cron: [],

          states: [],
        };

        result.set(context.key, aggregate);
      }

      const status = String(state.status);

      aggregate.stateCounts[status] = (aggregate.stateCounts[status] ?? 0) + 1;

      if (state.kind === SportsSyncStateKind.QUEUE) {
        aggregate.queueStates += 1;

        aggregate.states.push(
          this.buildSyncStateDetail(state, context.competition.name, now),
        );
      }

      if (state.kind === SportsSyncStateKind.CRON) {
        aggregate.cronStates += 1;

        aggregate.cron.push({
          stateKey: state.stateKey,

          taskKey: state.taskKey,

          status,

          cronExpression: state.cronExpression,

          timeZone: state.timeZone,

          lastStartedAt: this.toIso(state.lastStartedAt),

          lastSuccessfulAt: this.toIso(state.lastSuccessfulAt),

          lastCompletedAt: this.toIso(state.lastCompletedAt),

          nextRunAt: this.toIso(state.nextRunAt),

          consecutiveFailures: state.consecutiveFailures ?? 0,

          lastError: state.lastError,
        });
      }

      if (state.lastSuccessfulAt) {
        const value = new Date(state.lastSuccessfulAt);

        if (
          !aggregate.latestSuccessfulAt ||
          value.getTime() > aggregate.latestSuccessfulAt.getTime()
        ) {
          aggregate.latestSuccessfulAt = value;
        }
      }

      if (state.lastCompletedAt) {
        const value = new Date(state.lastCompletedAt);

        if (
          !aggregate.latestCompletedAt ||
          value.getTime() > aggregate.latestCompletedAt.getTime()
        ) {
          aggregate.latestCompletedAt = value;
        }
      }

      if (state.nextRunAt) {
        const value = new Date(state.nextRunAt);

        if (
          !aggregate.nextRunAt ||
          value.getTime() < aggregate.nextRunAt.getTime()
        ) {
          aggregate.nextRunAt = value;
        }
      }

      for (const unit of state.units ?? []) {
        aggregate.unitProgress.total += 1;

        switch (unit.status) {
          case SportsSyncUnitStatus.SUCCESS:
            aggregate.unitProgress.success += 1;
            break;

          case SportsSyncUnitStatus.PROCESSING:
            aggregate.unitProgress.processing += 1;
            break;

          case SportsSyncUnitStatus.PENDING:
            aggregate.unitProgress.pending += 1;
            break;

          case SportsSyncUnitStatus.FAILED:
            aggregate.unitProgress.failed += 1;
            break;
        }

        if (unit.status !== SportsSyncUnitStatus.SUCCESS) {
          aggregate.currentStages.push({
            jobType: state.jobType,

            stage: unit.stepKey ?? unit.dateKey ?? unit.key,

            unitType: String(unit.type),

            status: String(unit.status),

            count: 1,
          });
        }
      }

      if (
        state.status === SportsSyncStateStatus.FAILED ||
        (state.consecutiveFailures ?? 0) > 0 ||
        state.lastError
      ) {
        aggregate.failures.push({
          stateKey: state.stateKey,

          jobType: state.jobType,

          leagueId: state.leagueId,

          season: state.season,

          eventId: state.eventId,

          error: state.lastError,

          at: this.toIso(
            state.lastCompletedAt ?? state.lastStartedAt ?? state.updatedAt,
          ),

          consecutiveFailures: state.consecutiveFailures ?? 0,
        });
      }
    }

    for (const aggregate of result.values()) {
      aggregate.currentStages = this.groupSyncStages(aggregate.currentStages);

      aggregate.failures.sort(
        (a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime(),
      );

      aggregate.states.sort((a, b) => {
        const jobCompare = (a.jobType ?? '').localeCompare(b.jobType ?? '');

        if (jobCompare !== 0) {
          return jobCompare;
        }

        return a.stateKey.localeCompare(b.stateKey);
      });
    }

    return result;
  }

  // ============================================================
  // UPCOMING
  // ============================================================

  private async loadUpcomingFixtures(
    contexts: LeagueContext[],
    now: Date,
  ): Promise<EspnFixtureDocument[]> {
    const clauses = contexts
      .filter((context) => typeof context.season === 'number')
      .flatMap((context) =>
        context.aliases.map((leagueId) => ({
          leagueId,

          season: context.season,
        })),
      );

    if (!clauses.length) {
      return [];
    }

    const until = new Date(
      now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    return this.espnFixtureModel
      .find({
        $or: clauses,

        fixtureDate: {
          $gte: now,

          $lte: until,
        },

        completed: {
          $ne: true,
        },
      })
      .sort({
        fixtureDate: 1,
      })
      .lean()
      .exec();
  }

  private async buildUpcomingIndexes(
    fixtures: EspnFixtureDocument[],
  ): Promise<UpcomingIndexes> {
    const summaries = new Set<string>();

    const odds = new Set<string>();

    const fixtureIds = fixtures
      .map((fixture) => fixture.eventId)
      .filter((eventId): eventId is string => Boolean(eventId));

    for (const fixture of fixtures) {
      if (!fixture.eventId) {
        continue;
      }

      if (this.hasSummary(fixture)) {
        summaries.add(fixture.eventId);
      }
    }

    if (fixtureIds.length) {
      const oddsDocs = await this.sportsOddsSnapshotModel
        .find({
          eventId: {
            $in: fixtureIds,
          },
        })
        .select({
          eventId: 1,
        })
        .lean()
        .exec();

      for (const document of oddsDocs) {
        if (document.eventId) {
          odds.add(document.eventId);
        }
      }
    }

    return {
      summaries,
      odds,
    };
  }

  // ============================================================
  // LEAGUE SUMMARY
  // ============================================================

  private buildLeagueSummary(params: {
    context: LeagueContext;

    catalogueById: Map<string, EspnLeagueDocument>;

    operationalSeasonData: OperationalSeasonData;

    teamAggregates: Map<string, TeamAggregate>;

    queueAggregates: Map<string, QueueAggregate>;

    syncAggregates: Map<string, SyncAggregate>;

    upcomingFixtures: EspnFixtureDocument[];

    upcomingIndexes: UpcomingIndexes;
  }): MonitorLeagueSummary {
    const {
      context,
      catalogueById,
      operationalSeasonData,
      teamAggregates,
      queueAggregates,
      syncAggregates,
      upcomingFixtures,
      upcomingIndexes,
    } = params;

    const competition = context.competition;

    const catalogue =
      catalogueById.get(this.normalize(competition.espnLeagueSlug)) ??
      catalogueById.get(this.normalize(competition.competitionId));

    const fixtureSummary = operationalSeasonData.fixtures.get(context.key) ?? {
      total: 0,
      upcoming: 0,
      live: 0,
      finished: 0,
      withSummary: 0,
      missingSummary: 0,
      finishedMissingSummary: 0,
      summaryCoveragePercent: 0,
      storedSeasons: 0,
    };

    const expectedTeamIds =
      operationalSeasonData.expectedTeams.get(context.key) ?? new Set<string>();

    const teamSummary = teamAggregates.get(context.key) ?? {
      documents: 0,
      teamIds: new Set<string>(),
    };

    const expectedTeams = expectedTeamIds.size;

    const teamsCovered = [...expectedTeamIds].filter((teamId) =>
      teamSummary.teamIds.has(teamId),
    ).length;

    const upcoming = this.buildUpcomingSummary(
      context,
      upcomingFixtures,
      upcomingIndexes,
    );

    const queue = this.toQueueSummary(queueAggregates.get(context.key));

    const sync = this.toSyncSummary(syncAggregates.get(context.key));

    const latestFixtureCollectedAt = fixtureSummary.latestCollectedAt;

    const staleCutoff = new Date(
      Date.now() - STALE_ACTIVE_LEAGUE_HOURS * 60 * 60 * 1000,
    );

    const stale =
      !latestFixtureCollectedAt ||
      latestFixtureCollectedAt.getTime() < staleCutoff.getTime();

    const expectedWork: MonitorExpectedWork = {
      finishedFixturesMissingSummary: fixtureSummary.finishedMissingSummary,

      upcomingFixturesMissingSummary: upcoming.missingSummary,

      staleActiveLeagues: stale ? 1 : 0,

      upcomingFixturesMissingOdds: upcoming.fixtures.filter(
        (fixture) => fixture.sources.oddsMatchable && !fixture.sources.odds,
      ).length,
    };

    return {
      competitionId: competition.competitionId,

      espnLeagueSlug: competition.espnLeagueSlug,

      name: competition.name,

      type: String(competition.type),

      region: String(competition.region),

      priority: String(competition.priority),

      status: String(competition.status),

      season: competition.season,

      seasonStartDate: this.toIso(competition.seasonStartDate),

      seasonEndDate: this.toIso(competition.seasonEndDate),

      nextFixtureDate: this.toIso(competition.nextFixtureDate),

      lastFixtureDate: this.toIso(competition.lastFixtureDate),

      catalogue: {
        exists: Boolean(catalogue),

        name: catalogue?.name,

        country: catalogue?.country,

        isActive: catalogue?.isActive,

        isPriority: catalogue?.isPriority,

        lastSyncedAt: this.toIso(catalogue?.lastSyncedAt),

        detailLastSyncedAt: this.toIso(catalogue?.detailLastSyncedAt),
      },

      fixtures: {
        total: fixtureSummary.total,

        upcoming: fixtureSummary.upcoming,

        live: fixtureSummary.live,

        finished: fixtureSummary.finished,

        withSummary: fixtureSummary.withSummary,

        missingSummary: fixtureSummary.missingSummary,

        summaryCoveragePercent: fixtureSummary.summaryCoveragePercent,

        latestCollectedAt: this.toIso(fixtureSummary.latestCollectedAt),

        latestSummaryCollectedAt: this.toIso(
          fixtureSummary.latestSummaryCollectedAt,
        ),

        storedSeasons: fixtureSummary.storedSeasons,
      },

      teams: {
        documents: teamSummary.documents,

        distinctTeams: teamSummary.teamIds.size,

        expectedCurrentSeasonTeams: expectedTeams,

        missingCurrentSeasonTeams: Math.max(0, expectedTeams - teamsCovered),

        coveragePercent:
          expectedTeams > 0 ? this.percent(teamsCovered, expectedTeams) : 0,

        latestCollectedAt: this.toIso(teamSummary.latestCollectedAt),
      },

      upcoming,

      queue,

      sync,

      expectedWork,
    };
  }

  // ============================================================
  // UPCOMING READINESS
  // ============================================================

  private buildUpcomingSummary(
    context: LeagueContext,
    allFixtures: EspnFixtureDocument[],
    indexes: UpcomingIndexes,
  ): MonitorUpcomingSummary {
    const fixtures = allFixtures.filter(
      (fixture) =>
        context.aliases.includes(this.normalize(fixture.leagueId)) &&
        fixture.season === context.season,
    );

    const readiness = fixtures.map((fixture): MonitorUpcomingFixture => {
      const hasSummary = Boolean(
        fixture.eventId && indexes.summaries.has(fixture.eventId),
      );

      const hasOdds = Boolean(
        fixture.eventId && indexes.odds.has(fixture.eventId),
      );

      const oddsMatchable = Boolean(context.competition.oddsApiSportKey);

      const missingSources: string[] = [];

      if (!hasSummary) {
        missingSources.push('summary');
      }

      if (oddsMatchable && !hasOdds) {
        missingSources.push('odds');
      }

      const ready = hasSummary && (!oddsMatchable || hasOdds);

      let status: 'READY' | 'PARTIAL' | 'MISSING';

      if (ready) {
        status = 'READY';
      } else if (hasSummary || hasOdds) {
        status = 'PARTIAL';
      } else {
        status = 'MISSING';
      }

      return {
        eventId: String(fixture.eventId),

        fixtureDate: this.toIso(fixture.fixtureDate) ?? '',

        homeTeamId: fixture.homeTeamId,

        awayTeamId: fixture.awayTeamId,

        homeTeamName: this.extractFixtureTeamName(fixture, 'home'),

        awayTeamName: this.extractFixtureTeamName(fixture, 'away'),

        sources: {
          espnFixture: true,

          summary: hasSummary,

          odds: hasOdds,

          oddsMatchable,
        },

        status,

        missingSources,
      };
    });

    const withSummary = readiness.filter(
      (fixture) => fixture.sources.summary,
    ).length;

    const missingSummary = readiness.length - withSummary;

    const withOdds = readiness.filter((fixture) => fixture.sources.odds).length;

    const ready = readiness.filter(
      (fixture) => fixture.status === 'READY',
    ).length;

    const partial = readiness.filter(
      (fixture) => fixture.status === 'PARTIAL',
    ).length;

    const missing = readiness.filter(
      (fixture) => fixture.status === 'MISSING',
    ).length;

    return {
      total: readiness.length,

      ready,

      partial,

      missing,

      withSummary,

      missingSummary,

      withOdds,

      nextFixtureDate: readiness[0]?.fixtureDate,

      fixtures: readiness,
    };
  }

  // ============================================================
  // PROVIDERS
  // ============================================================

  private async buildProviderSummaries(): Promise<MonitorProviderSummary[]> {
    const result: MonitorProviderSummary[] = [];

    for (const provider of Object.keys(
      PROVIDER_CONFIG,
    ) as ConfiguredSportsProvider[]) {
      const config = PROVIDER_CONFIG[provider];

      const [
        dailyRequests,
        monthlyRequests,
        remainingDailyRequests,
        remainingMonthlyRequests,
        providerState,
        endpointDocuments,
      ] = await Promise.all([
        this.providerRateLimitService.getDailyUsage(provider),

        this.providerRateLimitService.getMonthlyUsage(provider),

        this.providerRateLimitService.getRemainingDailyRequests(provider),

        this.providerRateLimitService.getRemainingMonthlyRequests(provider),

        this.providerRateLimitService.getProviderState(provider),

        this.sportsProviderRateLimitModel
          .find({
            provider,

            endpoint: {
              $ne: '__provider_quota__',
            },
          })
          .sort({
            endpoint: 1,
          })
          .lean()
          .exec(),
      ]);

      const periods = providerState as unknown as
        ProviderStatePeriods | null | undefined;

      const endpoints = endpointDocuments.map((document) => ({
        endpoint: document.endpoint,

        dailyRequests: Number(document.dailyRequests ?? 0),

        monthlyRequests: Number(document.monthlyRequests ?? 0),

        lastRequestAt: this.toIso(document.lastRequestAt),

        lockedUntil: this.toIso(document.lockedUntil),
      }));

      const activeLocks = endpoints.filter(
        (endpoint) =>
          endpoint.lockedUntil &&
          new Date(endpoint.lockedUntil).getTime() > Date.now(),
      ).length;

      const latestEndpointRequest = endpoints
        .map((endpoint) =>
          endpoint.lastRequestAt ? new Date(endpoint.lastRequestAt) : undefined,
        )
        .filter((value): value is Date => Boolean(value))
        .sort((a, b) => b.getTime() - a.getTime())[0];

      result.push({
        provider,

        limits: {
          minIntervalSeconds: config.minIntervalSeconds,

          dailyRequestLimit: config.dailyRequestLimit,

          monthlyRequestLimit: config.monthlyRequestLimit,
        },

        usage: {
          dailyRequests: Number(dailyRequests ?? 0),

          monthlyRequests: Number(monthlyRequests ?? 0),

          remainingDailyRequests: remainingDailyRequests ?? null,

          remainingMonthlyRequests: remainingMonthlyRequests ?? null,

          dailyPeriod: this.toIso(periods?.dailyPeriod),

          monthlyPeriod: this.toIso(periods?.monthlyPeriod),

          lastRequestAt: latestEndpointRequest
            ? latestEndpointRequest.toISOString()
            : undefined,

          activeLocks,
        },

        endpoints,

        telemetry: {
          historicalRequestEventsAvailable: false,

          historicalRateByHourAvailable: false,

          historicalRateByLeagueAvailable: false,

          note: 'The current rate-limit collection stores current-period aggregate usage, endpoint usage, last request and lock state. It does not store immutable outbound request events.',
        },
      });
    }

    return result;
  }

  // ============================================================
  // PIPELINE
  // ============================================================

  private buildPipelineDefinitions(
    sync: MonitorSyncSummary,
  ): Record<string, MonitorPipelineDefinition> {
    const stateCounts = this.getPipelineStateCounts(sync);

    return {
      [EspnQueueJobType.FIXTURE_REFRESH]: {
        stages: ['DATE_WINDOW', 'FIXTURES', 'TEAMS'],

        operations: {
          DATE_WINDOW: {
            source: 'QUEUE',

            operation:
              'Track the rolling ESPN fixture window from today through today+8 days.',
          },

          FIXTURES: {
            source: 'ESPN',

            operation:
              'Collect ESPN scoreboard fixtures and upsert them into sports_espn_fixtures while preserving stored Summary data.',
          },

          TEAMS: {
            source: 'ESPN',

            operation:
              'Persist league-scoped ESPN team identities discovered in scoreboard responses.',
          },
        },

        stateCounts: stateCounts[EspnQueueJobType.FIXTURE_REFRESH] ?? {},
      },

      [EspnQueueJobType.SUMMARY_REFRESH]: {
        stages: ['SUMMARY', 'YOUTUBE'],

        operations: {
          SUMMARY: {
            source: 'ESPN',

            operation:
              'Fetch ESPN Summary and persist it under sports_espn_fixtures.payload.summary.',
          },

          YOUTUBE: {
            source: 'YOUTUBE',

            operation:
              'Search directly for a finished-match highlight without a separate YouTube queue.',
            conditional: true,
          },
        },

        stateCounts: stateCounts[EspnQueueJobType.SUMMARY_REFRESH] ?? {},
      },
    };
  }

  private getPipelineStateCounts(
    sync: MonitorSyncSummary,
  ): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = {};

    for (const stage of sync.currentStages) {
      const jobType = stage.jobType ?? 'UNKNOWN';

      if (!result[jobType]) {
        result[jobType] = {};
      }

      result[jobType][stage.status] =
        (result[jobType][stage.status] ?? 0) + stage.count;
    }

    return result;
  }

  // ============================================================
  // QUEUE CONVERSION
  // ============================================================

  private toQueueSummary(aggregate?: QueueAggregate): MonitorQueueSummary {
    if (!aggregate) {
      return {
        total: 0,

        pending: 0,

        processing: 0,

        completedRetained: 0,

        failed: 0,

        staleProcessing: 0,

        completedRetentionDays: QUEUE_COMPLETED_RETENTION_DAYS,

        byType: {},

        byTypeAndStatus: [],
      };
    }

    const byType: Record<string, number> = {};

    for (const [type, count] of aggregate.byType) {
      byType[type] = count;
    }

    const byTypeAndStatus: MonitorQueueItem[] = [];

    for (const [compoundKey, count] of aggregate.byTypeAndStatus) {
      const separator = compoundKey.indexOf(':');

      byTypeAndStatus.push({
        type: separator >= 0 ? compoundKey.slice(0, separator) : compoundKey,

        status: separator >= 0 ? compoundKey.slice(separator + 1) : 'UNKNOWN',

        count,
      });
    }

    return {
      total: aggregate.total,

      pending: aggregate.byStatus.get(EspnQueueStatus.PENDING) ?? 0,

      processing: aggregate.byStatus.get(EspnQueueStatus.PROCESSING) ?? 0,

      completedRetained: aggregate.byStatus.get(EspnQueueStatus.COMPLETED) ?? 0,

      failed: aggregate.byStatus.get(EspnQueueStatus.FAILED) ?? 0,

      staleProcessing: aggregate.staleProcessing,

      completedRetentionDays: QUEUE_COMPLETED_RETENTION_DAYS,

      byType,

      byTypeAndStatus,

      latestFailureAt: this.toIso(aggregate.latestFailureAt),

      latestFailure: aggregate.latestFailure,

      latestCompletedAt: this.toIso(aggregate.latestCompletedAt),
    };
  }

  // ============================================================
  // SYNC CONVERSION
  // ============================================================

  private toSyncSummary(aggregate?: SyncAggregate): MonitorSyncSummary {
    if (!aggregate) {
      return {
        totalStates: 0,

        queueStates: 0,

        cronStates: 0,

        byStatus: {},

        unitProgress: {
          total: 0,
          success: 0,
          processing: 0,
          pending: 0,
          failed: 0,
          completionPercent: 0,
        },

        stateCompletionPercent: 0,

        currentStages: [],

        failures: [],

        cron: [],

        states: [],
      };
    }

    const totalStates = Object.values(aggregate.stateCounts).reduce(
      (sum, value) => sum + value,
      0,
    );

    const successfulStates =
      aggregate.stateCounts[SportsSyncStateStatus.SUCCESS] ?? 0;

    return {
      totalStates,

      queueStates: aggregate.queueStates,

      cronStates: aggregate.cronStates,

      byStatus: aggregate.stateCounts,

      unitProgress: {
        ...aggregate.unitProgress,

        completionPercent:
          aggregate.unitProgress.total > 0
            ? this.percent(
                aggregate.unitProgress.success,
                aggregate.unitProgress.total,
              )
            : 0,
      },

      stateCompletionPercent:
        totalStates > 0 ? this.percent(successfulStates, totalStates) : 0,

      currentStages: aggregate.currentStages,

      failures: aggregate.failures.slice(0, 50),

      cron: aggregate.cron,

      states: aggregate.states,

      latestSuccessfulAt: this.toIso(aggregate.latestSuccessfulAt),

      latestCompletedAt: this.toIso(aggregate.latestCompletedAt),

      nextRunAt: this.toIso(aggregate.nextRunAt),
    };
  }

  // ============================================================
  // SYNC STATE DETAIL
  // ============================================================

  private buildSyncStateDetail(
    state: SportsSyncStateDocument,
    leagueName: string | undefined,
    now: Date,
  ): MonitorSyncStateDetail {
    const units = state.units ?? [];

    let success = 0;

    let processing = 0;

    let pending = 0;

    let failed = 0;

    let dateUnits = 0;

    let stepUnits = 0;

    const durationsMs: number[] = [];

    let currentProcessingElapsedSeconds: number | undefined;

    for (const unit of units) {
      const unitType = String(unit.type).toUpperCase();

      if (unitType === 'DATE') {
        dateUnits += 1;
      }

      if (unitType === 'STEP') {
        stepUnits += 1;
      }

      switch (unit.status) {
        case SportsSyncUnitStatus.SUCCESS: {
          success += 1;

          if (unit.startedAt && unit.completedAt) {
            const startedAt = new Date(unit.startedAt).getTime();

            const completedAt = new Date(unit.completedAt).getTime();

            const durationMs = completedAt - startedAt;

            if (durationMs > 0) {
              durationsMs.push(durationMs);
            }
          }

          break;
        }

        case SportsSyncUnitStatus.PROCESSING: {
          processing += 1;

          if (unit.startedAt) {
            const startedAt = new Date(unit.startedAt).getTime();

            const elapsedSeconds = Math.max(
              0,
              (now.getTime() - startedAt) / 1000,
            );

            if (
              currentProcessingElapsedSeconds === undefined ||
              elapsedSeconds > currentProcessingElapsedSeconds
            ) {
              currentProcessingElapsedSeconds = elapsedSeconds;
            }
          }

          break;
        }

        case SportsSyncUnitStatus.PENDING:
          pending += 1;
          break;

        case SportsSyncUnitStatus.FAILED:
          failed += 1;
          break;
      }
    }

    const total = units.length;

    const completionPercent = total > 0 ? this.percent(success, total) : 0;

    const averageDurationMs =
      durationsMs.length > 0
        ? durationsMs.reduce((sum, value) => sum + value, 0) /
          durationsMs.length
        : undefined;

    const averageSecondsPerUnit =
      averageDurationMs !== undefined
        ? Number((averageDurationMs / 1000).toFixed(2))
        : undefined;

    const unitsPerMinute =
      averageSecondsPerUnit !== undefined && averageSecondsPerUnit > 0
        ? Number((60 / averageSecondsPerUnit).toFixed(2))
        : undefined;

    const remainingUnits = Math.max(0, total - success);

    const remainingSeconds =
      averageSecondsPerUnit !== undefined && remainingUnits > 0
        ? Number((remainingUnits * averageSecondsPerUnit).toFixed(2))
        : undefined;

    const estimatedCompletionAt =
      remainingSeconds !== undefined && remainingSeconds > 0
        ? new Date(now.getTime() + remainingSeconds * 1000)
        : undefined;

    return {
      stateKey: state.stateKey,

      kind: String(state.kind),

      leagueId: state.leagueId,

      leagueName,

      season: state.season,

      jobType: state.jobType,

      status: String(state.status),

      trackingMode: state.trackingMode,

      dateFrom: state.dateFrom,

      dateTo: state.dateTo,

      unitProgress: {
        total,

        dateUnits,

        stepUnits,

        success,

        processing,

        pending,

        failed,

        completionPercent,
      },

      timing: {
        sampleCount: durationsMs.length,

        averageSecondsPerUnit,

        unitsPerMinute,

        currentProcessingElapsedSeconds:
          currentProcessingElapsedSeconds !== undefined
            ? Number(currentProcessingElapsedSeconds.toFixed(2))
            : undefined,
      },

      estimate: {
        remainingUnits,

        remainingSeconds,

        estimatedCompletionAt: this.toIso(estimatedCompletionAt),
      },

      lastStartedAt: this.toIso(state.lastStartedAt),

      lastCompletedAt: this.toIso(state.lastCompletedAt),
    };
  }

  private groupSyncStages(
    stages: MonitorSyncStageSummary[],
  ): MonitorSyncStageSummary[] {
    const grouped = new Map<string, MonitorSyncStageSummary>();

    for (const stage of stages) {
      const key = [
        stage.jobType ?? 'UNKNOWN',
        stage.stage,
        stage.unitType,
        stage.status,
      ].join(':');

      const existing = grouped.get(key);

      if (existing) {
        existing.count += stage.count;
      } else {
        grouped.set(key, {
          ...stage,
        });
      }
    }

    return [...grouped.values()];
  }

  // ============================================================
  // EXPECTED WORK
  // ============================================================

  private sumExpectedWork(items: MonitorExpectedWork[]): MonitorExpectedWork {
    return items.reduce(
      (total, item) => ({
        finishedFixturesMissingSummary:
          total.finishedFixturesMissingSummary +
          item.finishedFixturesMissingSummary,

        upcomingFixturesMissingSummary:
          total.upcomingFixturesMissingSummary +
          item.upcomingFixturesMissingSummary,

        staleActiveLeagues: total.staleActiveLeagues + item.staleActiveLeagues,

        upcomingFixturesMissingOdds:
          total.upcomingFixturesMissingOdds + item.upcomingFixturesMissingOdds,
      }),

      this.emptyExpectedWork(),
    );
  }

  private emptyExpectedWork(): MonitorExpectedWork {
    return {
      finishedFixturesMissingSummary: 0,

      upcomingFixturesMissingSummary: 0,

      staleActiveLeagues: 0,

      upcomingFixturesMissingOdds: 0,
    };
  }

  // ============================================================
  // ARCHITECTURE NOTES
  // ============================================================

  private getArchitectureNotes() {
    return {
      activeCompetitionSourceOfTruth:
        'sports_active_competitions defines the operational competition set used by startup, fixture collection and the normal queue.',

      catalogueRole:
        'sports_espn_leagues stores the complete ESPN catalogue, including active and inactive leagues. ActiveCompetition remains the operational source of truth.',

      fixtureStorageModel:
        'ESPN scoreboard fixtures are stored canonically in sports_espn_fixtures. Fixture payloads preserve the provider event data and stored Summary data.',

      summaryStorageModel:
        'ESPN Summary is stored inside sports_espn_fixtures.payload.summary with payload.summaryCollectedAt. No separate Summary collection is used.',

      fixtureRefreshModel:
        'FIXTURE_REFRESH is responsible only for the rolling ESPN fixture window. Normal collection covers today through today+8 days. Stale active leagues are refreshed when fixture collection is older than 48 hours.',

      summaryRefreshModel:
        'SUMMARY_REFRESH is event-specific. Continuous processing covers fixtures within the next four days and newly finished fixtures. A Summary job is not created when payload.summary already exists.',

      queueHistoryWindow:
        'Completed ESPN queue documents are retained as operational history for seven days before cleanup.',

      syncProgressSource:
        'sports_sync_states.units[] is the source of detailed date/step progress. Queue types are FIXTURE_REFRESH and SUMMARY_REFRESH.',

      providerTelemetryLimit:
        'Current provider telemetry contains usage totals, endpoint usage, last requests and current locks. It does not contain immutable outbound request events.',

      oddsMatchingLimit:
        'The monitor treats an exact stored Sports Odds Snapshot eventId as confirmed odds availability. A missing exact eventId is reported as missing odds only for competitions that have an Odds API sport key.',
    };
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private normalize(value?: string): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  private percent(numerator: number, denominator: number): number {
    if (denominator <= 0 || numerator <= 0) {
      return 0;
    }

    return Number(((numerator / denominator) * 100).toFixed(2));
  }

  private toIso(value?: Date | string | null): string | undefined {
    if (!value) {
      return undefined;
    }

    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
      return undefined;
    }

    return date.toISOString();
  }

  private hasSummary(fixture: Pick<EspnFixtureDocument, 'payload'>): boolean {
    const payload = fixture.payload;

    if (!payload || typeof payload !== 'object') {
      return false;
    }

    const summary = payload.summary;

    return Boolean(
      summary && typeof summary === 'object' && Object.keys(summary).length > 0,
    );
  }

  private extractFixtureTeamName(
    fixture: EspnFixtureDocument,
    side: 'home' | 'away',
  ): string | undefined {
    const payload =
      fixture.payload && typeof fixture.payload === 'object'
        ? fixture.payload
        : {};

    const payloadRecord = payload as Record<string, unknown>;
    const competitions = Array.isArray(payloadRecord.competitions)
      ? payloadRecord.competitions
      : [];

    const competition =
      competitions[0] && typeof competitions[0] === 'object'
        ? (competitions[0] as Record<string, unknown>)
        : undefined;

    const competitors: unknown[] = Array.isArray(competition?.competitors)
      ? (competition.competitors as unknown[])
      : [];

    const competitor =
      competitors.find(
        (item) =>
          item &&
          typeof item === 'object' &&
          (item as Record<string, unknown>).homeAway === side,
      ) ?? competitors[side === 'home' ? 0 : 1];

    if (!competitor || typeof competitor !== 'object') {
      return undefined;
    }

    const record = competitor as Record<string, unknown>;

    const team =
      record.team && typeof record.team === 'object'
        ? (record.team as Record<string, unknown>)
        : record;

    return (
      (typeof team.displayName === 'string' ? team.displayName : undefined) ??
      (typeof team.name === 'string' ? team.name : undefined) ??
      (typeof team.shortDisplayName === 'string'
        ? team.shortDisplayName
        : undefined)
    );
  }
}
