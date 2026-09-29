// backend/src/sports/services/sports-collection.service.ts

import { Injectable, Logger } from '@nestjs/common';

import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { EspnService } from '../providers/espn.service';

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

import {
  OddsApiSport,
  OddsApiSportDocument,
} from '../schemas/odds-api-sport.schema';

import {
  SportsOddsSnapshot,
  SportsOddsSnapshotDocument,
} from '../schemas/sports-odds-snapshot.schema';

import {
  FootballDataCompetition as FootballDataCompetitionPayload,
  FootballDataMatch as FootballDataMatchPayload,
  FootballDataStandingTable,
  FootballDataTeam as FootballDataTeamPayload,
} from '../providers/football-data.interfaces';

import {
  OddsApiSport as OddsApiSportPayload,
  OddsApiEventOdds,
} from '../providers/the-odds-api.interfaces';

import {
  EspnLeague as EspnLeaguePayload,
  EspnNewsResponse,
  EspnStandingEntry,
  EspnStandingsResponse,
} from '../providers/espn.interfaces';

import { EspnQueueService } from './espn-queue.service';

import { CompetitionPriority } from '../enums/competition-priority.enum';

import { CompetitionRegion } from '../enums/competition-region.enum';

import { CompetitionType } from '../enums/competition-type.enum';

import { ActiveCompetitionService } from './active-competition.service';

import { PriorityCompetitionService } from './priority-competition.service';

import { EspnNews, EspnNewsDocument } from '../schemas/espn/espn-news.schema';

@Injectable()
export class SportsCollectionService {
  private readonly logger = new Logger(SportsCollectionService.name);

  /**
   * Full season/live-discovery collection window.
   *
   * season start
   *      ->
   * today + 8 days
   */
  private readonly STARTUP_FIXTURE_FORWARD_DAYS = 8;

  /**
   * Normal fixture refresh window.
   *
   * today
   *      ->
   * today + 8 days
   */
  private readonly LEAGUE_REFRESH_PAST_DAYS = 0;

  private readonly LEAGUE_REFRESH_FORWARD_DAYS = 8;

  constructor(
    private readonly espnService: EspnService,

    private readonly activeCompetitionService: ActiveCompetitionService,

    private readonly priorityCompetitionService: PriorityCompetitionService,

    private readonly espnQueueService: EspnQueueService,

    // ----------------------------------------------------------
    // ESPN
    // ----------------------------------------------------------

    @InjectModel(EspnFixture.name)
    private readonly espnFixtureModel: Model<EspnFixtureDocument>,

    @InjectModel(EspnLeague.name)
    private readonly espnLeagueModel: Model<EspnLeagueDocument>,

    @InjectModel(EspnStanding.name)
    private readonly espnStandingModel: Model<EspnStandingDocument>,

    @InjectModel(EspnTeam.name)
    private readonly espnTeamModel: Model<EspnTeamDocument>,

    @InjectModel(EspnNews.name)
    private readonly espnNewsModel: Model<EspnNewsDocument>,

    // ----------------------------------------------------------
    // Football-Data
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
    // Odds API
    // ----------------------------------------------------------

    @InjectModel(OddsApiSport.name)
    private readonly oddsApiSportModel: Model<OddsApiSportDocument>,

    @InjectModel(SportsOddsSnapshot.name)
    private readonly sportsOddsSnapshotModel: Model<SportsOddsSnapshotDocument>,
  ) {}

  // ============================================================
  // ESPN — ACTIVE LEAGUE SYNCHRONIZATION
  // ============================================================

  /**
   * Synchronize the complete ESPN fixture data required for one
   * active league.
   *
   * This is a manual/recovery-compatible collection method.
   *
   * Normal startup and queue processing do not call standings here.
   * ESPN standings remain available through the provider and
   * collection methods only as emergency/fallback functionality.
   */
  async synchronizeEspnActiveLeague(params: {
    leagueId: string;
    season?: number;
    seasonStartDate?: Date;
  }): Promise<{
    fixtureIds: string[];
    fixturesCollected: number;
    standingsCollected: number;
    dateFrom: string;
    dateTo: string;
  }> {
    const normalizedLeagueId = this.normalizeLeagueId(params.leagueId);

    if (!normalizedLeagueId) {
      throw new Error('ESPN leagueId is required');
    }

    const now = new Date();

    const dateFrom = this.toUtcDateOnly(params.seasonStartDate ?? now);

    const dateTo = this.toUtcDateOnly(
      new Date(
        now.getTime() + this.STARTUP_FIXTURE_FORWARD_DAYS * 24 * 60 * 60 * 1000,
      ),
    );

    const fixtureResponse = await this.espnService.getFixtures(
      normalizedLeagueId,
      dateFrom,
      dateTo,
    );

    const fixtureResult = await this.collectEspnFixtures(
      normalizedLeagueId,
      fixtureResponse,
    );

    this.logger.log(
      `ESPN active league synchronized for ${normalizedLeagueId}: ` +
        `${fixtureResult.collected} fixtures ` +
        `(${dateFrom} -> ${dateTo})`,
    );

    return {
      fixtureIds: fixtureResult.fixtureIds,
      fixturesCollected: fixtureResult.collected,
      standingsCollected: 0,
      dateFrom,
      dateTo,
    };
  }

  // ============================================================
  // ESPN — STARTUP SEASON FIXTURE COLLECTION
  // ============================================================

  /**
   * Collect fixtures for the currently active season of one
   * ESPN league.
   *
   * Range:
   *
   * season start
   *        ->
   * today + 8 days
   */
  async collectEspnSeasonFixtures(params: {
    leagueId: string;
    season?: number;
    seasonStartDate?: Date;
  }): Promise<{
    fixtureIds: string[];
    collected: number;
    dateFrom?: string;
    dateTo: string;
  }> {
    const now = new Date();

    const dateFrom = this.toUtcDateOnly(params.seasonStartDate ?? now);

    const dateToDate = new Date(
      now.getTime() + this.STARTUP_FIXTURE_FORWARD_DAYS * 24 * 60 * 60 * 1000,
    );

    const dateTo = this.toUtcDateOnly(dateToDate);

    const response = await this.espnService.getFixtures(
      params.leagueId,
      dateFrom,
      dateTo,
    );

    const result = await this.collectEspnFixtures(params.leagueId, response);

    this.logger.log(
      `ESPN startup fixtures collected for ${params.leagueId}: ` +
        `${result.collected} fixtures (${dateFrom} -> ${dateTo})`,
    );

    return {
      fixtureIds: result.fixtureIds,
      collected: result.collected,
      dateFrom,
      dateTo,
    };
  }

  // ============================================================
  // ESPN — FIXTURE WINDOW REFRESH
  // ============================================================

  /**
   * Refresh a league's current and upcoming fixture window.
   *
   * Range:
   *
   * today
   *     ->
   * today + 8 days
   *
   * This method performs ONLY fixture/scoreboard collection.
   *
   * Summary, standings, odds, YouTube, and derived data are not
   * collected here.
   */
  async processEspnLeagueRefresh(params: {
    leagueId: string;
    season?: number;
  }): Promise<{
    scoreboard: unknown;
    fixtureIds: string[];
    collected: number;
    dateFrom: string;
    dateTo: string;
  }> {
    const now = new Date();

    const dateFromDate = new Date(
      now.getTime() - this.LEAGUE_REFRESH_PAST_DAYS * 24 * 60 * 60 * 1000,
    );

    const dateToDate = new Date(
      now.getTime() + this.LEAGUE_REFRESH_FORWARD_DAYS * 24 * 60 * 60 * 1000,
    );

    const dateFrom = this.toUtcDateOnly(dateFromDate);

    const dateTo = this.toUtcDateOnly(dateToDate);

    const scoreboard = await this.espnService.getFixtures(
      params.leagueId,
      dateFrom,
      dateTo,
    );

    const fixtureResult = await this.collectEspnFixtures(
      params.leagueId,
      scoreboard,
    );

    this.logger.log(
      `ESPN fixture refresh completed for ${params.leagueId}: ` +
        `${fixtureResult.collected} fixtures ` +
        `(${dateFrom} -> ${dateTo})`,
    );

    return {
      scoreboard,
      fixtureIds: fixtureResult.fixtureIds,
      collected: fixtureResult.collected,
      dateFrom,
      dateTo,
    };
  }

  // ============================================================
  // ESPN — FIXTURES / SCOREBOARD
  // ============================================================

  async collectEspnFixtures(
    leagueId: string,
    response: unknown,
  ): Promise<{
    fixtureIds: string[];
    collected: number;
  }> {
    const normalizedLeagueId = this.normalizeLeagueId(leagueId);

    const events = this.extractArray(response, ['events', 'items']);

    const eventIds = events
      .map((event) => {
        if (!event || typeof event !== 'object') {
          return undefined;
        }

        return this.toStringValue((event as { id?: unknown }).id);
      })
      .filter((eventId): eventId is string => Boolean(eventId));

    const existingFixtures =
      eventIds.length > 0
        ? await this.espnFixtureModel
            .find({
              eventId: {
                $in: eventIds,
              },
            })
            .select({
              eventId: 1,
              'payload.summary': 1,
              'payload.summaryCollectedAt': 1,
            })
            .lean()
            .exec()
        : [];

    const existingSummaryMap = new Map<
      string,
      {
        summary?: unknown;
        summaryCollectedAt?: Date;
      }
    >();

    for (const fixture of existingFixtures) {
      if (!fixture.eventId) {
        continue;
      }

      const payload =
        fixture.payload && typeof fixture.payload === 'object'
          ? fixture.payload
          : undefined;

      if (!payload) {
        continue;
      }

      existingSummaryMap.set(fixture.eventId, {
        summary: payload.summary,
        summaryCollectedAt:
          payload.summaryCollectedAt instanceof Date
            ? payload.summaryCollectedAt
            : undefined,
      });
    }

    const fixtureIds: string[] = [];

    const fixtureOperations: Parameters<
      Model<EspnFixtureDocument>['bulkWrite']
    >[0] = [];

    const teamOperations: Parameters<Model<EspnTeamDocument>['bulkWrite']>[0] =
      [];

    const collectedAt = new Date();

    for (const event of events) {
      if (!event || typeof event !== 'object') {
        continue;
      }

      const eventId = this.toStringValue((event as { id?: unknown }).id);

      const fixtureDate = this.parseDate((event as { date?: unknown }).date);

      if (!eventId || !fixtureDate) {
        continue;
      }

      type EspnCompetitor = {
        homeAway?: unknown;
        isHome?: unknown;
        isAway?: unknown;
        score?: unknown;
        [key: string]: unknown;
      };

      const competition = (
        event as {
          competitions?: Array<{
            competitors?: EspnCompetitor[];
            season?: { year?: unknown };
            status?: { period?: unknown };
            venue?: {
              id?: unknown;
              fullName?: unknown;
              name?: unknown;
            };
          }>;
        }
      ).competitions?.[0];

      const competitors = competition?.competitors ?? [];

      const home =
        competitors.find(
          (item) => item.homeAway === 'home' || item.isHome === true,
        ) ?? competitors[0];

      const away =
        competitors.find(
          (item) => item.homeAway === 'away' || item.isAway === true,
        ) ?? competitors[1];

      const season =
        this.toNumber(
          (event as { season?: { year?: unknown } }).season?.year,
        ) ??
        this.toNumber(competition?.season?.year) ??
        fixtureDate.getUTCFullYear();

      const status = this.extractStatus(event);

      const completed = this.isCompleted(event);

      const eventPayload = event as Record<string, unknown>;

      const existingSummary = existingSummaryMap.get(eventId);

      const payload: Record<string, unknown> = {
        ...eventPayload,
      };

      if (
        existingSummary &&
        Object.prototype.hasOwnProperty.call(existingSummary, 'summary')
      ) {
        payload.summary = existingSummary.summary;

        if (existingSummary.summaryCollectedAt) {
          payload.summaryCollectedAt = existingSummary.summaryCollectedAt;
        }
      }

      fixtureOperations.push({
        updateOne: {
          filter: {
            eventId,
          },

          update: {
            $set: {
              eventId,

              leagueId: normalizedLeagueId,

              season,

              fixtureDate,

              status,

              statusDetail: this.getNestedString(competition, [
                'status',
                'type',
                'description',
              ]),

              statusShortDetail: this.getNestedString(competition, [
                'status',
                'type',
                'shortDetail',
              ]),

              period: this.toNumber(competition?.status?.period),

              completed,

              live: this.isLiveEvent(event),

              displayClock:
                this.getNestedString(event, ['status', 'displayClock']) ??
                this.getNestedString(competition, ['status', 'displayClock']),

              homeTeamId: this.getTeamId(home),

              awayTeamId: this.getTeamId(away),

              homeScore: this.toNumber(home?.score),

              awayScore: this.toNumber(away?.score),

              venueId: this.toStringValue(competition?.venue?.id),

              venueName:
                this.getNestedString(competition, ['venue', 'fullName']) ??
                this.getNestedString(competition, ['venue', 'name']),

              payload,

              collectedAt,
            },
          },

          upsert: true,
        },
      });

      this.appendEspnTeamOperations(
        teamOperations,
        normalizedLeagueId,
        competitors,
        collectedAt,
      );

      fixtureIds.push(eventId);
    }

    if (fixtureOperations.length > 0) {
      await this.espnFixtureModel.bulkWrite(fixtureOperations, {
        ordered: false,
      });
    }

    if (teamOperations.length > 0) {
      await this.espnTeamModel.bulkWrite(teamOperations, {
        ordered: false,
      });
    }

    return {
      fixtureIds,
      collected: fixtureIds.length,
    };
  }

  // ============================================================
  // ESPN — LIVE MATCHES
  // ============================================================

  /**
   * Synchronize the current ESPN global live scoreboard.
   *
   * Live processing can also receive a just-finished event while
   * ESPN still exposes that event in the live scoreboard. Such an
   * event is persisted as completed and returned through
   * newlyFinished so the scheduler can immediately trigger:
   *
   * 1. affected-league fixture refresh;
   * 2. event Summary refresh.
   *
   * This method does not directly collect Summary, standings,
   * odds, YouTube, or derived data.
   */
  async collectEspnLiveMatches(response: unknown): Promise<{
    received: number;
    updated: number;
    cleared: number;
    newlyFinished: Array<{
      eventId: string;
      leagueId: string;
      season: number;
    }>;
  }> {
    const events = this.extractArray(response, ['events', 'items']);

    const leagueMap = this.buildLiveLeagueMap(response);

    const liveEventIds = new Set<string>();

    const newlyFinished: Array<{
      eventId: string;
      leagueId: string;
      season: number;
    }> = [];

    let updated = 0;

    for (const event of events) {
      if (!event || typeof event !== 'object') {
        continue;
      }

      const eventRecord = event as Record<string, unknown>;

      const eventId = this.toStringValue(eventRecord.id);

      if (!eventId) {
        continue;
      }

      const isLive = this.isLiveEvent(event);

      const completed = this.isCompleted(event);

      /*
       * ESPN can expose a just-finished event briefly in the
       * global live scoreboard. Accept both live and completed
       * events so the transition can be detected.
       */
      if (!isLive && !completed) {
        continue;
      }

      const fixtureDate = this.parseDate(eventRecord.date);

      if (!fixtureDate) {
        continue;
      }

      const leagueReference = this.resolveLiveEventLeagueId(event, leagueMap);

      let leagueId: string | undefined;

      if (leagueReference) {
        try {
          leagueId = await this.resolveLiveLeague(leagueReference, fixtureDate);
        } catch (error) {
          this.logger.warn(
            `Live ESPN league resolution failed for event ${eventId} ` +
              `(${leagueReference}): ${
                error instanceof Error ? error.message : String(error)
              }`,
          );
        }
      }

      let storedFixture: {
        leagueId?: string;
        season?: number;
        completed?: boolean;
        live?: boolean;
      } | null = null;

      if (!leagueId) {
        storedFixture = await this.espnFixtureModel
          .findOne({
            eventId,
          })
          .select({
            leagueId: 1,
            season: 1,
            completed: 1,
            live: 1,
          })
          .lean()
          .exec();

        if (storedFixture?.leagueId) {
          try {
            leagueId = await this.resolveLiveLeague(
              storedFixture.leagueId,
              fixtureDate,
            );
          } catch (error) {
            this.logger.debug(
              `Stored ESPN league resolution failed for event ${eventId}: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        if (!leagueId) {
          leagueId = storedFixture?.leagueId;
        }
      }

      if (!leagueId) {
        this.logger.debug(
          `Skipping live ESPN event ${eventId}: unable to resolve ESPN league`,
        );

        continue;
      }

      const competition = this.getFirstCompetition(event);

      const competitors = this.extractArray(competition, ['competitors']);

      const home =
        competitors.find(
          (item) => this.getNestedString(item, ['homeAway']) === 'home',
        ) ?? competitors[0];

      const away =
        competitors.find(
          (item) => this.getNestedString(item, ['homeAway']) === 'away',
        ) ?? competitors[1];

      const season =
        this.toNumber(this.getNestedString(event, ['season', 'year'])) ??
        this.toNumber(this.getNestedString(competition, ['season', 'year'])) ??
        storedFixture?.season ??
        fixtureDate.getUTCFullYear();

      const status = this.extractStatus(event);

      const displayClock =
        this.getNestedString(event, ['status', 'displayClock']) ??
        this.getNestedString(competition, ['status', 'displayClock']);

      const normalizedLeagueId = this.normalizeLeagueId(leagueId);

      const existingPayloadFixture = await this.espnFixtureModel
        .findOne({
          eventId,
        })
        .select({
          completed: 1,
          live: 1,
          'payload.summary': 1,
          'payload.summaryCollectedAt': 1,
        })
        .lean()
        .exec();

      const wasCompleted = Boolean(
        existingPayloadFixture?.completed || storedFixture?.completed,
      );

      const wasLive = Boolean(
        existingPayloadFixture?.live || storedFixture?.live,
      );

      const existingPayload =
        existingPayloadFixture?.payload &&
        typeof existingPayloadFixture.payload === 'object'
          ? existingPayloadFixture.payload
          : undefined;

      const livePayload: Record<string, unknown> = {
        ...eventRecord,
      };

      /*
       * Preserve an already collected Summary.
       */
      if (
        existingPayload &&
        Object.prototype.hasOwnProperty.call(existingPayload, 'summary')
      ) {
        livePayload.summary = existingPayload.summary;

        if (existingPayload.summaryCollectedAt) {
          livePayload.summaryCollectedAt = existingPayload.summaryCollectedAt;
        }
      }

      await this.espnFixtureModel
        .updateOne(
          {
            eventId,
          },
          {
            $set: {
              eventId,

              leagueId: normalizedLeagueId,

              season,

              fixtureDate,

              status,

              statusDetail: this.getNestedString(competition, [
                'status',
                'type',
                'description',
              ]),

              statusShortDetail: this.getNestedString(competition, [
                'status',
                'type',
                'shortDetail',
              ]),

              period:
                this.toNumber(
                  this.getNestedString(event, ['status', 'period']),
                ) ??
                this.toNumber(
                  this.getNestedString(competition, ['status', 'period']),
                ),

              displayClock,

              completed,

              live: isLive,

              homeTeamId: this.getTeamId(home),

              awayTeamId: this.getTeamId(away),

              homeScore: this.toNumber(this.getNestedString(home, ['score'])),

              awayScore: this.toNumber(this.getNestedString(away, ['score'])),

              venueId: this.getNestedString(competition, ['venue', 'id']),

              venueName:
                this.getNestedString(competition, ['venue', 'fullName']) ??
                this.getNestedString(competition, ['venue', 'name']),

              payload: livePayload,

              collectedAt: new Date(),
            },
          },
          {
            upsert: true,
          },
        )
        .exec();

      await this.collectEspnTeams(normalizedLeagueId, competitors);

      if (isLive) {
        liveEventIds.add(eventId);
      }

      if (completed && !wasCompleted && wasLive) {
        newlyFinished.push({
          eventId,

          leagueId: normalizedLeagueId,

          season,
        });
      }

      updated += 1;
    }

    const clearedResult = await this.espnFixtureModel
      .updateMany(
        {
          live: true,

          fixtureDate: {
            $gte: this.getUtcStartOfDay(
              new Date(Date.now() - 24 * 60 * 60 * 1000),
            ),
          },

          eventId: {
            $nin: [...liveEventIds],
          },
        },
        {
          $set: {
            live: false,

            collectedAt: new Date(),
          },
        },
      )
      .exec();

    return {
      received: events.length,

      updated,

      cleared: clearedResult.modifiedCount,

      newlyFinished,
    };
  }

  // ============================================================
  // LIVE LEAGUE RESOLUTION
  // ============================================================

  /**
   * Resolve an ESPN league for a live scoreboard event.
   *
   * Order:
   *
   * 1. ActiveCompetition by ESPN league slug.
   * 2. Existing ESPN catalogue by slug/id.
   * 3. Refresh ESPN's complete league catalogue.
   * 4. Check the refreshed catalogue again.
   * 5. Get authoritative ESPN league detail.
   * 6. Update sports_espn_leagues.
   * 7. Synchronize ActiveCompetition when the current season
   *    is active.
   * 8. Queue a fixture refresh for newly discovered active
   *    leagues.
   *
   * Standings are intentionally not requested here.
   */
  private async resolveLiveLeague(
    leagueReference: string,
    fixtureDate: Date,
  ): Promise<string | undefined> {
    const normalizedReference = this.normalizeLeagueId(leagueReference);

    if (!normalizedReference) {
      return undefined;
    }

    /*
     * ============================================================
     * 1. ACTIVE COMPETITION
     * ============================================================
     */

    const activeCompetition =
      await this.activeCompetitionService.getByEspnLeagueSlug(
        normalizedReference,
      );

    if (activeCompetition?.espnLeagueSlug) {
      return this.normalizeLeagueId(activeCompetition.espnLeagueSlug);
    }

    /*
     * ============================================================
     * 2. COMPLETE ESPN CATALOGUE
     * ============================================================
     */

    let catalogueLeague =
      (await this.espnLeagueModel
        .findOne({
          slug: normalizedReference,
        })
        .lean()
        .exec()) ??
      (await this.espnLeagueModel
        .findOne({
          leagueId: normalizedReference,
        })
        .lean()
        .exec());

    /*
     * ============================================================
     * 3. UNKNOWN TO OUR CATALOGUE
     * ============================================================
     */

    if (!catalogueLeague) {
      const leagues = await this.espnService.getLeagues();

      await this.storeEspnLeagueCatalogue(leagues);

      /*
       * ==========================================================
       * 4. CHECK THE CATALOGUE AGAIN
       * ==========================================================
       */

      catalogueLeague =
        (await this.espnLeagueModel
          .findOne({
            slug: normalizedReference,
          })
          .lean()
          .exec()) ??
        (await this.espnLeagueModel
          .findOne({
            leagueId: normalizedReference,
          })
          .lean()
          .exec());
    }

    if (!catalogueLeague) {
      this.logger.debug(
        `ESPN live league ${normalizedReference} was not found ` +
          `after catalogue refresh`,
      );

      return undefined;
    }

    /*
     * ============================================================
     * 5. AUTHORITATIVE ESPN LEAGUE DETAIL
     * ============================================================
     */

    const detailReference =
      this.normalizeLeagueId(catalogueLeague.slug) ||
      this.normalizeLeagueId(catalogueLeague.leagueId);

    if (!detailReference) {
      return undefined;
    }

    const detail = await this.espnService.getLeague(detailReference);

    /*
     * ============================================================
     * 6 + 7. UPDATE CATALOGUE / ACTIVE COMPETITION
     * ============================================================
     */

    const synchronizedLeague = await this.updateEspnLeagueFromDetail(
      catalogueLeague,
      detail,
      fixtureDate,
    );

    /*
     * ============================================================
     * 8. IMMEDIATE FIXTURE REFRESH
     * ============================================================
     */

    if (
      synchronizedLeague.isActive &&
      typeof synchronizedLeague.season === 'number'
    ) {
      const priority = this.getQueuePriority(
        this.getStoredPriority(catalogueLeague),
      );

      try {
        await this.espnQueueService.addFixtureRefreshJob({
          leagueId: synchronizedLeague.slug || synchronizedLeague.leagueId,

          season: synchronizedLeague.season,

          priority,

          scheduledFor: new Date(),

          triggerEventId: `LIVE_DISCOVERY:${synchronizedLeague.slug}`,
        });

        this.logger.debug(
          `Queued ESPN fixture refresh for newly discovered ` +
            `active league ${synchronizedLeague.slug}: ` +
            `season=${synchronizedLeague.season}`,
        );
      } catch (error) {
        this.logger.warn(
          `Failed to queue ESPN fixture refresh for newly discovered ` +
            `league ${synchronizedLeague.slug}: ${
              error instanceof Error ? error.message : String(error)
            }`,
        );
      }
    }

    return synchronizedLeague.slug;
  }

  private getQueuePriority(priority: CompetitionPriority): number {
    switch (priority) {
      case CompetitionPriority.ELITE:
        return 1;

      case CompetitionPriority.HIGH:
        return 2;

      case CompetitionPriority.REGIONAL:
        return 3;

      case CompetitionPriority.SELECTIVE:
      default:
        return 4;
    }
  }

  // ============================================================
  // ESPN — CATALOGUE
  // ============================================================

  /**
   * Persist ESPN's complete catalogue.
   *
   * Catalogue discovery does NOT decide whether a league is
   * currently active. That decision belongs to league detail.
   */
  private async storeEspnLeagueCatalogue(
    leagues: EspnLeaguePayload[],
  ): Promise<void> {
    const now = new Date();

    const operations: Parameters<Model<EspnLeagueDocument>['bulkWrite']>[0] =
      [];

    let stored = 0;

    for (const league of leagues) {
      const leagueId =
        this.normalizeLeagueId(league.id) ||
        this.normalizeLeagueId(league.slug);

      const slug = this.normalizeLeagueId(league.slug) || leagueId;

      if (!leagueId || !slug) {
        continue;
      }

      const priorityConfig = this.findPriorityCompetition(leagueId, slug);

      const priority =
        priorityConfig?.priority ?? CompetitionPriority.SELECTIVE;

      const name =
        this.getStringValue(league.name) ??
        this.getStringValue(league.displayName) ??
        this.getStringValue(league.shortName) ??
        slug;

      const country = this.extractCountryFromLeague(league);

      operations.push({
        updateOne: {
          filter: {
            $or: [
              {
                leagueId,
              },
              {
                slug,
              },
            ],
          },

          update: {
            $set: {
              leagueId,

              slug,

              name,

              abbreviation: this.getStringValue(league.abbreviation),

              country,

              priority,

              isPriority: Boolean(priorityConfig),

              payload: league as unknown as Record<string, unknown>,

              lastSyncedAt: now,
            },

            $setOnInsert: {
              isActive: false,
            },
          },

          upsert: true,
        },
      });

      stored += 1;
    }

    if (operations.length > 0) {
      await this.espnLeagueModel.bulkWrite(operations, {
        ordered: false,
      });
    }

    this.logger.log(`ESPN live catalogue refresh stored ${stored} leagues`);
  }

  /**
   * Replace catalogue metadata with authoritative ESPN
   * league-detail information.
   *
   * Only an active current season enters ActiveCompetition.
   */
  private async updateEspnLeagueFromDetail(
    catalogueLeague: EspnLeagueDocument,
    detail: EspnLeaguePayload,
    fixtureDate: Date,
  ): Promise<{
    leagueId: string;
    slug: string;
    name: string;
    isActive: boolean;
    season?: number;
  }> {
    const normalizedSlug =
      this.normalizeLeagueId(detail.slug) ||
      this.normalizeLeagueId(catalogueLeague.slug) ||
      this.normalizeLeagueId(detail.id) ||
      this.normalizeLeagueId(catalogueLeague.leagueId);

    const canonicalLeagueId =
      this.normalizeLeagueId(detail.id) ||
      this.normalizeLeagueId(catalogueLeague.leagueId) ||
      normalizedSlug;

    if (!normalizedSlug || !canonicalLeagueId) {
      throw new Error(
        'ESPN league detail did not contain a usable league identity',
      );
    }

    const season = this.extractEspnLeagueSeason(detail);

    const priorityConfig = this.findPriorityCompetition(
      normalizedSlug,
      canonicalLeagueId,
    );

    const priority =
      priorityConfig?.priority ?? this.getStoredPriority(catalogueLeague);

    const name =
      this.getStringValue(detail.name) ??
      this.getStringValue(detail.displayName) ??
      this.getStringValue(detail.shortName) ??
      catalogueLeague.name;

    const abbreviation =
      this.getStringValue(detail.abbreviation) ?? catalogueLeague.abbreviation;

    const country =
      this.extractCountryFromLeague(detail) ?? catalogueLeague.country;

    const now = new Date();

    const isActive = season
      ? this.isSeasonActive(season.startDate, season.endDate, now)
      : false;

    const update: Record<string, unknown> = {
      leagueId: canonicalLeagueId,

      slug: normalizedSlug,

      name,

      abbreviation,

      country,

      priority,

      isPriority: Boolean(priorityConfig),

      isActive,

      lastFixtureDate: fixtureDate,

      payload: detail,

      lastSyncedAt: now,
    };

    if (season) {
      update.season = season.season;

      update.seasonStartDate = season.startDate;

      update.seasonEndDate = season.endDate;
    } else {
      update.isActive = false;
    }

    await this.espnLeagueModel
      .updateOne(
        {
          _id: catalogueLeague._id,
        },
        {
          $set: update,
        },
      )
      .exec();

    /*
     * ============================================================
     * ACTIVE COMPETITION
     * ============================================================
     */

    if (season && isActive) {
      await this.activeCompetitionService.syncLeague({
        competitionId: canonicalLeagueId,

        espnLeagueSlug: normalizedSlug,

        name,

        type: priorityConfig?.type ?? CompetitionType.LEAGUE,

        region:
          priorityConfig?.region ?? this.getDefaultCompetitionRegion(detail),

        priority,

        footballDataCode: priorityConfig?.providers?.footballDataCode,

        oddsApiSportKey: priorityConfig?.providers?.oddsApiSportKey,

        season: season.season,

        seasonStartDate: season.startDate,

        seasonEndDate: season.endDate,

        lastFixtureDate: fixtureDate,

        espnPayload: detail,
      });
    } else {
      await this.activeCompetitionService.removeByCompetitionId(
        canonicalLeagueId,
      );
    }

    const refreshed = await this.espnLeagueModel
      .findOne({
        _id: catalogueLeague._id,
      })
      .lean()
      .exec();

    return {
      leagueId:
        this.normalizeLeagueId(refreshed?.leagueId) || canonicalLeagueId,

      slug: this.normalizeLeagueId(refreshed?.slug) || normalizedSlug,

      name: refreshed?.name || name,

      isActive,

      season: season?.season,
    };
  }

  // ============================================================
  // LIVE EVENT HELPERS
  // ============================================================

  private isLiveEvent(event: unknown): boolean {
    if (!event || typeof event !== 'object') {
      return false;
    }

    const eventRecord = event as Record<string, unknown>;

    const status =
      eventRecord.status && typeof eventRecord.status === 'object'
        ? (eventRecord.status as Record<string, unknown>)
        : undefined;

    const statusType =
      status?.type && typeof status.type === 'object'
        ? (status.type as Record<string, unknown>)
        : undefined;

    if (status?.completed === true || statusType?.completed === true) {
      return false;
    }

    const state = this.toStringValue(
      statusType?.state ?? status?.state,
    )?.toLowerCase();

    if (
      state &&
      ['post', 'final', 'completed', 'complete', 'finished'].includes(state)
    ) {
      return false;
    }

    return Boolean(
      state && ['in', 'live', 'inprogress', 'in_progress'].includes(state),
    );
  }

  /**
   * Builds the canonical league lookup from response.leagues[].
   */
  private buildLiveLeagueMap(response: unknown): Map<string, string> {
    const map = new Map<string, string>();

    if (!response || typeof response !== 'object') {
      return map;
    }

    const responseRecord = response as Record<string, unknown>;

    const leagues = Array.isArray(responseRecord.leagues)
      ? responseRecord.leagues
      : [];

    for (const league of leagues) {
      const leagueRecord = this.asRecord(league);

      if (!leagueRecord) {
        continue;
      }

      const id = this.toStringValue(leagueRecord.id);

      const slug = this.toStringValue(
        leagueRecord.slug ??
          this.getNestedString(leagueRecord, ['league', 'slug']),
      );

      const uid = this.toStringValue(leagueRecord.uid);

      const reference = this.toStringValue(leagueRecord.$ref);

      const referenceSlug = reference
        ? this.extractLeagueSlugFromReference(reference)
        : undefined;

      const canonicalSlug =
        slug?.trim().toLowerCase() ?? referenceSlug?.trim().toLowerCase();

      if (!canonicalSlug) {
        continue;
      }

      if (id) {
        map.set(id.trim().toLowerCase(), canonicalSlug);
      }

      map.set(canonicalSlug, canonicalSlug);

      if (uid) {
        map.set(uid.trim().toLowerCase(), canonicalSlug);
      }

      if (referenceSlug) {
        map.set(referenceSlug.trim().toLowerCase(), canonicalSlug);
      }
    }

    return map;
  }

  private resolveLiveEventLeagueId(
    event: unknown,
    leagueMap: Map<string, string>,
  ): string | undefined {
    const eventRecord = this.asRecord(event);

    if (!eventRecord) {
      return undefined;
    }

    const competition = this.getFirstCompetition(event);

    const directCandidates: unknown[] = [
      this.getNestedString(event, ['league', 'slug']),

      this.getNestedString(event, ['league', 'id']),

      this.getNestedString(competition, ['league', 'slug']),

      this.getNestedString(competition, ['league', 'id']),

      this.getNestedString(event, ['sport', 'league', 'slug']),

      this.getNestedString(event, ['sport', 'league', 'id']),

      this.getNestedString(event, ['leagueId']),

      this.getNestedString(competition, ['leagueId']),
    ];

    for (const candidate of directCandidates) {
      const value = this.toStringValue(candidate);

      if (!value) {
        continue;
      }

      const normalized = value.trim().toLowerCase();

      const mapped = leagueMap.get(normalized);

      if (mapped) {
        return mapped;
      }

      return normalized;
    }

    const uidCandidates = [
      this.toStringValue(eventRecord.uid),

      this.getNestedString(competition, ['uid']),
    ];

    for (const uid of uidCandidates) {
      if (!uid) {
        continue;
      }

      const leagueMatch = uid.match(/(?:^|~)l:([^~]+)/i);

      if (!leagueMatch?.[1]) {
        continue;
      }

      const encodedLeagueId = leagueMatch[1].trim().toLowerCase();

      const mappedLeague = leagueMap.get(encodedLeagueId);

      if (mappedLeague) {
        return mappedLeague;
      }

      return encodedLeagueId;
    }

    const referenceCandidates: unknown[] = [
      this.getNestedValue(event, ['league', '$ref']),

      this.getNestedValue(competition, ['league', '$ref']),

      this.getNestedValue(event, ['sport', 'league', '$ref']),
    ];

    for (const candidate of referenceCandidates) {
      const reference = this.toStringValue(candidate);

      if (!reference) {
        continue;
      }

      const leagueSlug = this.extractLeagueSlugFromReference(reference);

      if (!leagueSlug) {
        continue;
      }

      const mapped = leagueMap.get(leagueSlug);

      return mapped ?? leagueSlug;
    }

    return undefined;
  }

  private extractLeagueSlugFromReference(
    reference: string,
  ): string | undefined {
    try {
      const url = new URL(reference);

      const pathSegments = url.pathname.split('/').filter(Boolean);

      const leagueIndex = pathSegments.findIndex(
        (segment) => segment.toLowerCase() === 'leagues',
      );

      if (leagueIndex < 0) {
        return undefined;
      }

      const slug = pathSegments[leagueIndex + 1];

      if (!slug) {
        return undefined;
      }

      return decodeURIComponent(slug).trim().toLowerCase() || undefined;
    } catch {
      return undefined;
    }
  }

  private getUtcStartOfDay(date: Date): Date {
    const result = new Date(date);

    result.setUTCHours(0, 0, 0, 0);

    return result;
  }

  // ============================================================
  // ESPN — TEAMS FROM SCOREBOARD
  // ============================================================

  async collectEspnTeams(
    leagueId: string,
    competitors: unknown[],
  ): Promise<number> {
    const normalizedLeagueId = this.normalizeLeagueId(leagueId);

    const operations: Parameters<Model<EspnTeamDocument>['bulkWrite']>[0] = [];

    const collectedAt = new Date();

    for (const competitor of competitors) {
      const competitorRecord = this.asRecord(competitor);

      const team = this.asRecord(competitorRecord?.team);

      const teamId = this.toStringValue(team?.id ?? competitorRecord?.id);

      if (!teamId) {
        continue;
      }

      operations.push({
        updateOne: {
          filter: {
            teamId,

            leagueId: normalizedLeagueId,
          },

          update: {
            $set: {
              teamId,

              leagueId: normalizedLeagueId,

              name: team?.name ?? team?.displayName ?? `Team ${teamId}`,

              displayName: team?.displayName ?? team?.name ?? `Team ${teamId}`,

              shortDisplayName:
                team?.shortDisplayName ?? team?.name ?? `Team ${teamId}`,

              abbreviation: team?.abbreviation,

              location: team?.location,

              logo: this.getTeamLogo(team),

              colors: team?.color ?? team?.colors,

              active: team?.isActive ?? true,

              payload: team ?? competitor,

              collectedAt,
            },
          },

          upsert: true,
        },
      });
    }

    if (operations.length > 0) {
      await this.espnTeamModel.bulkWrite(operations, {
        ordered: false,
      });
    }

    return operations.length;
  }

  // ============================================================
  // ESPN — STANDINGS FALLBACK
  // ============================================================

  /**
   * Emergency/manual standings persistence only.
   *
   * Normal startup and queue operations do not call this method.
   */
  async collectEspnStandings(
    leagueId: string,
    response: unknown,
    season?: number,
  ): Promise<number> {
    const entries = this.extractStandingEntries(
      response as Record<string, unknown> | null | undefined,
    );

    if (!entries.length) {
      return 0;
    }

    const resolvedSeason =
      season ??
      this.toNumber(
        (
          response as {
            season?: {
              year?: unknown;
            };
          } | null
        )?.season?.year,
      ) ??
      new Date().getUTCFullYear();

    const normalizedLeagueId = this.normalizeLeagueId(leagueId);

    const activeTeamIds = new Set<string>();

    const operations: Parameters<Model<EspnStandingDocument>['bulkWrite']>[0] =
      [];

    const collectedAt = new Date();

    for (const entry of entries) {
      const entryRecord = this.asRecord(entry);

      const teamRecord = this.asRecord(entryRecord?.team);

      const teamId = this.toStringValue(teamRecord?.id ?? entryRecord?.teamId);

      if (!teamId) {
        continue;
      }

      activeTeamIds.add(teamId);

      const statistics = Array.isArray(entryRecord?.stats)
        ? (entryRecord.stats as unknown[])
        : [];

      const value = (name: string): number | undefined =>
        this.getStatisticNumber(statistics, name);

      const form = this.getStatisticDisplayValue(statistics, ['form']);

      operations.push({
        updateOne: {
          filter: {
            leagueId: normalizedLeagueId,

            season: resolvedSeason,

            teamId,
          },

          update: {
            $set: {
              leagueId: normalizedLeagueId,

              season: resolvedSeason,

              teamId,

              rank:
                value('rank') ??
                this.toNumber(entryRecord?.rank ?? entryRecord?.position) ??
                0,

              points: value('points'),

              played: value('gamesPlayed') ?? value('played'),

              wins: value('wins'),

              draws: value('ties') ?? value('draws'),

              losses: value('losses'),

              goalsFor: value('pointsFor') ?? value('goalsFor'),

              goalsAgainst: value('pointsAgainst') ?? value('goalsAgainst'),

              goalDifference: value('goalDifference'),

              form,

              description: this.getStatisticDisplayValue(statistics, [
                'description',
              ]),

              payload: entry,

              collectedAt,
            },
          },

          upsert: true,
        },
      });
    }

    if (operations.length > 0) {
      await this.espnStandingModel.bulkWrite(operations, {
        ordered: false,
      });
    }

    await this.espnStandingModel
      .deleteMany({
        leagueId: normalizedLeagueId,

        season: resolvedSeason,

        teamId: {
          $nin: [...activeTeamIds],
        },
      })
      .exec();

    return operations.length;
  }

  // ============================================================
  // ESPN — NEWS FALLBACK
  // ============================================================

  /**
   * Emergency/manual news persistence only.
   *
   * No scheduled job calls this method.
   */
  async collectEspnNews(response: EspnNewsResponse): Promise<{
    received: number;
    created: number;
    updated: number;
    skipped: number;
  }> {
    const articles = Array.isArray(response.headlines)
      ? response.headlines
      : [];

    let created = 0;

    let updated = 0;

    let skipped = 0;

    for (const article of articles) {
      const payload = article as Record<string, unknown>;

      const articleId = this.extractString(payload, 'id', 'articleId', 'uid');

      if (!articleId) {
        skipped++;
        continue;
      }

      const leagueId = this.extractNewsLeagueId(payload);

      if (!leagueId) {
        skipped++;
        continue;
      }

      const headline = this.extractString(payload, 'headline', 'title');

      const description = this.extractString(payload, 'description', 'summary');

      const published = this.parseDate(
        this.extractString(payload, 'published', 'publishedAt'),
      );

      const lastModified = this.parseDate(
        this.extractString(payload, 'lastModified', 'updated', 'updatedAt'),
      );

      const link = this.extractNewsLink(payload);

      const imageUrl = this.extractNewsImage(payload);

      const type = this.extractString(payload, 'type', 'contentType');

      const author = this.extractNewsAuthor(payload);

      const collectedAt = new Date();

      const existing = await this.espnNewsModel
        .findOne({
          articleId,
        })
        .select({
          _id: 1,
        })
        .lean()
        .exec();

      await this.espnNewsModel
        .updateOne(
          {
            articleId,
          },
          {
            $set: {
              articleId,

              leagueId,

              headline,

              description,

              published,

              lastModified,

              link,

              imageUrl,

              type,

              author,

              payload,

              collectedAt,
            },
          },
          {
            upsert: true,
          },
        )
        .exec();

      if (existing) {
        updated++;
      } else {
        created++;
      }
    }

    return {
      received: articles.length,

      created,

      updated,

      skipped,
    };
  }

  private extractNewsLeagueId(
    payload: Record<string, unknown>,
  ): string | undefined {
    const directLeagueId = this.extractString(payload, 'leagueId');

    if (directLeagueId) {
      return directLeagueId.trim().toLowerCase();
    }

    const league = payload['league'];

    if (league && typeof league === 'object' && !Array.isArray(league)) {
      const leagueObject = league as Record<string, unknown>;

      const leagueId = this.extractString(
        leagueObject,
        'slug',
        'abbreviation',
        'id',
      );

      if (leagueId) {
        return leagueId.trim().toLowerCase();
      }
    }

    const categories = payload['categories'];

    if (!Array.isArray(categories)) {
      return undefined;
    }

    for (const category of categories) {
      if (
        !category ||
        typeof category !== 'object' ||
        Array.isArray(category)
      ) {
        continue;
      }

      const categoryObject = category as Record<string, unknown>;

      if (
        this.extractString(categoryObject, 'type')?.toLowerCase() !== 'league'
      ) {
        continue;
      }

      const leagueObject = categoryObject['league'];

      if (
        leagueObject &&
        typeof leagueObject === 'object' &&
        !Array.isArray(leagueObject)
      ) {
        const leagueRecord = leagueObject as Record<string, unknown>;

        const leagueSlug = this.extractString(leagueRecord, 'slug');

        if (leagueSlug) {
          return leagueSlug.trim().toLowerCase();
        }

        const abbreviation = this.extractString(leagueRecord, 'abbreviation');

        if (abbreviation) {
          return abbreviation.trim().toLowerCase();
        }

        const leagueId = this.extractString(leagueRecord, 'id');

        if (leagueId) {
          return leagueId.trim().toLowerCase();
        }
      }

      const leagueId = this.extractString(categoryObject, 'leagueId');

      if (leagueId) {
        return leagueId.trim().toLowerCase();
      }
    }

    return undefined;
  }

  private extractNewsLink(
    payload: Record<string, unknown>,
  ): string | undefined {
    const directLink = this.extractString(payload, 'link', 'url');

    if (directLink) {
      return directLink;
    }

    const links = payload['links'];

    if (links && typeof links === 'object' && !Array.isArray(links)) {
      const linksObject = links as Record<string, unknown>;

      const web = linksObject['web'];

      if (web && typeof web === 'object' && !Array.isArray(web)) {
        return this.extractString(
          web as Record<string, unknown>,
          'href',
          'url',
        );
      }

      return this.extractString(linksObject, 'href', 'url');
    }

    return undefined;
  }

  private extractNewsImage(
    payload: Record<string, unknown>,
  ): string | undefined {
    const directImage = this.extractString(payload, 'imageUrl', 'image');

    if (directImage) {
      return directImage;
    }

    const images = payload['images'];

    if (!Array.isArray(images)) {
      return undefined;
    }

    for (const image of images) {
      if (!image || typeof image !== 'object' || Array.isArray(image)) {
        continue;
      }

      const imageObject = image as Record<string, unknown>;

      const url = imageObject['url'];

      if (typeof url === 'string' && url.trim()) {
        return url.trim();
      }

      if (Array.isArray(url)) {
        for (const item of url) {
          if (typeof item === 'string' && item.trim()) {
            return item.trim();
          }
        }
      }

      const href = imageObject['href'];

      if (typeof href === 'string' && href.trim()) {
        return href.trim();
      }
    }

    return undefined;
  }

  private extractNewsAuthor(
    payload: Record<string, unknown>,
  ): string | undefined {
    const directAuthor = this.extractString(payload, 'author', 'byline');

    if (directAuthor) {
      return directAuthor;
    }

    const authorObject = payload['author'];

    if (
      authorObject &&
      typeof authorObject === 'object' &&
      !Array.isArray(authorObject)
    ) {
      return this.extractString(
        authorObject as Record<string, unknown>,
        'name',
        'displayName',
      );
    }

    return undefined;
  }

  private extractString(
    payload: Record<string, unknown>,
    ...keys: string[]
  ): string | undefined {
    for (const key of keys) {
      const value = payload[key];

      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }

      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
    }

    return undefined;
  }

  // ============================================================
  // ESPN — MATCH DETAILS
  // ============================================================

  async collectEspnMatchDetails(params: {
    leagueId: string;
    event: unknown;
  }): Promise<void> {
    const event = this.asRecord(params.event) ?? {};

    const competition = this.asRecord(
      (Array.isArray(event.competitions) ? event.competitions : [])[0],
    );

    const eventId = this.toStringValue(event.id);

    const fixtureDate = this.parseDate(
      event.date ?? competition?.date ?? competition?.startDate,
    );

    if (!eventId || !fixtureDate) {
      throw new Error('Invalid ESPN match payload');
    }

    const competitors: unknown[] = Array.isArray(competition?.competitors)
      ? competition.competitors
      : [];

    const home =
      competitors.find((item) => {
        const competitor = this.asRecord(item);

        return competitor?.homeAway === 'home' || competitor?.isHome === true;
      }) ?? competitors[0];

    const away =
      competitors.find((item) => {
        const competitor = this.asRecord(item);

        return competitor?.homeAway === 'away' || competitor?.isAway === true;
      }) ?? competitors[1];

    const homeCompetitor = this.asRecord(home);

    const awayCompetitor = this.asRecord(away);

    const season =
      this.toNumber(this.getNestedString(event, ['season', 'year'])) ??
      this.toNumber(this.getNestedString(competition, ['season', 'year'])) ??
      fixtureDate.getUTCFullYear();

    const status = this.extractStatus(event);

    const completed = this.isCompleted(event);

    const existingFixture = await this.espnFixtureModel
      .findOne({
        eventId,
      })
      .select({
        'payload.summary': 1,
        'payload.summaryCollectedAt': 1,
      })
      .lean()
      .exec();

    const existingPayload =
      existingFixture?.payload && typeof existingFixture.payload === 'object'
        ? existingFixture.payload
        : undefined;

    const detailPayload: Record<string, unknown> = {
      ...event,
    };

    if (
      existingPayload &&
      Object.prototype.hasOwnProperty.call(existingPayload, 'summary')
    ) {
      detailPayload.summary = existingPayload.summary;

      if (existingPayload.summaryCollectedAt) {
        detailPayload.summaryCollectedAt = existingPayload.summaryCollectedAt;
      }
    }

    await this.espnFixtureModel
      .updateOne(
        {
          eventId,
        },
        {
          $set: {
            eventId,

            leagueId: this.normalizeLeagueId(params.leagueId),

            season,

            fixtureDate,

            status,

            statusDetail: this.getNestedString(competition, [
              'status',
              'type',
              'description',
            ]),

            statusShortDetail: this.getNestedString(competition, [
              'status',
              'type',
              'shortDetail',
            ]),

            period: this.toNumber(
              this.getNestedString(competition, ['status', 'period']),
            ),

            completed,

            live: this.isLiveEvent(event),

            homeTeamId: this.getTeamId(home),

            awayTeamId: this.getTeamId(away),

            homeScore: this.toNumber(homeCompetitor?.score),

            awayScore: this.toNumber(awayCompetitor?.score),

            venueId: this.getNestedString(competition, ['venue', 'id']),

            venueName:
              this.getNestedString(competition, ['venue', 'fullName']) ??
              this.getNestedString(competition, ['venue', 'name']),

            payload: detailPayload,

            collectedAt: new Date(),
          },
        },
        {
          upsert: true,
        },
      )
      .exec();

    await this.collectEspnTeams(params.leagueId, competitors);
  }

  // ============================================================
  // ESPN — CHECK STORED MATCH SUMMARY
  // ============================================================

  async hasEspnMatchSummary(eventId: string): Promise<boolean> {
    const fixture = await this.espnFixtureModel
      .findOne({
        eventId: eventId.trim(),
      })
      .select({
        'payload.summary': 1,
      })
      .lean()
      .exec();

    return Boolean(
      fixture?.payload &&
      typeof fixture.payload === 'object' &&
      fixture.payload.summary &&
      typeof fixture.payload.summary === 'object' &&
      Object.keys(fixture.payload.summary).length > 0,
    );
  }

  // ============================================================
  // ESPN — MATCH SUMMARY
  // ============================================================

  /**
   * Persist ESPN Summary inside the canonical fixture document.
   *
   * Canonical location:
   *
   * sports_espn_fixtures.payload.summary
   */
  async collectEspnMatchSummary(params: {
    leagueId: string;
    eventId: string;
    summary: unknown;
  }): Promise<void> {
    const fixture = await this.espnFixtureModel
      .findOne({
        eventId: params.eventId,
      })
      .lean()
      .exec();

    if (!fixture) {
      throw new Error(
        `ESPN fixture ${params.eventId} not found while storing Summary`,
      );
    }

    const existingPayload =
      fixture.payload && typeof fixture.payload === 'object'
        ? fixture.payload
        : {};

    await this.espnFixtureModel
      .updateOne(
        {
          eventId: params.eventId,
        },
        {
          $set: {
            leagueId: this.normalizeLeagueId(params.leagueId),

            payload: {
              ...existingPayload,

              summary: params.summary,

              summaryCollectedAt: new Date(),
            },

            collectedAt: new Date(),
          },
        },
      )
      .exec();
  }

  // ============================================================
  // ESPN — MATCH SUMMARY BULK PERSISTENCE
  // ============================================================

  /**
   * Persist multiple ESPN summaries into their existing canonical
   * fixture documents in one MongoDB bulkWrite operation.
   *
   * This method deliberately updates only:
   *
   *   payload.summary
   *   payload.summaryCollectedAt
   *   collectedAt
   *
   * Existing fixture payload fields are preserved.
   *
   * No fixture document is created here. Summary persistence must
   * belong to an already collected ESPN fixture.
   */
  async collectEspnMatchSummariesBulk(
    summaries: Array<{
      leagueId: string;
      eventId: string;
      summary: unknown;
    }>,
  ): Promise<{
    requested: number;
    matched: number;
    modified: number;
  }> {
    if (summaries.length === 0) {
      return {
        requested: 0,
        matched: 0,
        modified: 0,
      };
    }

    const collectedAt = new Date();

    const uniqueSummaries = new Map<
      string,
      {
        leagueId: string;
        eventId: string;
        summary: unknown;
      }
    >();

    for (const item of summaries) {
      const eventId = String(item.eventId ?? '').trim();

      if (!eventId) {
        continue;
      }

      uniqueSummaries.set(eventId, {
        leagueId: this.normalizeLeagueId(item.leagueId),

        eventId,

        summary: item.summary,
      });
    }

    const operations: Parameters<Model<EspnFixtureDocument>['bulkWrite']>[0] =
      [];

    for (const item of uniqueSummaries.values()) {
      operations.push({
        updateOne: {
          filter: {
            eventId: item.eventId,
          },

          update: {
            $set: {
              leagueId: item.leagueId,

              'payload.summary': item.summary,

              'payload.summaryCollectedAt': collectedAt,

              collectedAt,
            },
          },

          /*
           * The fixture must already exist.
           *
           * We deliberately do not use upsert here because a Summary
           * response must never create a fixture that was not already
           * collected by the fixture pipeline.
           */
          upsert: false,
        },
      });
    }

    if (operations.length === 0) {
      return {
        requested: summaries.length,

        matched: 0,

        modified: 0,
      };
    }

    /*
     * Unordered bulk writes allow MongoDB to process independent
     * fixture updates efficiently.
     *
     * A thrown BulkWriteError means the batch persistence did not
     * complete successfully. The caller is responsible for moving
     * the corresponding synchronization units back to FAILED.
     */
    const result = await this.espnFixtureModel.bulkWrite(operations, {
      ordered: false,
    });

    const matched =
      typeof result.matchedCount === 'number' ? result.matchedCount : 0;

    const modified =
      typeof result.modifiedCount === 'number' ? result.modifiedCount : 0;

    /*
     * Because upsert=false is intentional, every requested summary
     * must have matched an existing fixture.
     *
     * A mismatch means that at least one summary could not be
     * persisted to its canonical fixture document.
     */
    if (matched !== operations.length) {
      throw new Error(
        `ESPN summary bulk persistence matched ${matched} of ` +
          `${operations.length} requested fixtures`,
      );
    }

    return {
      requested: operations.length,

      matched,

      modified,
    };
  }

  // ============================================================
  // FOOTBALL-DATA — COMPETITION
  // ============================================================

  async collectFootballDataCompetition(
    competition: FootballDataCompetitionPayload,
  ): Promise<void> {
    if (typeof competition.id !== 'number' || !competition.code) {
      return;
    }

    await this.footballDataCompetitionModel
      .updateOne(
        {
          competitionId: competition.id,
        },
        {
          $set: {
            competitionId: competition.id,

            code: competition.code.trim().toUpperCase(),

            name: competition.name ?? '',

            type: competition.type,

            payload: competition as unknown as Record<string, unknown>,

            collectedAt: new Date(),
          },
        },
        {
          upsert: true,
        },
      )
      .exec();
  }

  // ============================================================
  // FOOTBALL-DATA — MATCHES
  // ============================================================

  async collectFootballDataMatches(
    matches: FootballDataMatchPayload[],
  ): Promise<number> {
    let collected = 0;

    for (const match of matches) {
      if (
        typeof match.id !== 'number' ||
        !match.utcDate ||
        typeof match.competition?.id !== 'number' ||
        typeof match.homeTeam?.id !== 'number' ||
        typeof match.awayTeam?.id !== 'number'
      ) {
        continue;
      }

      const utcDate = new Date(match.utcDate);

      if (Number.isNaN(utcDate.getTime())) {
        continue;
      }

      await this.footballDataMatchModel
        .updateOne(
          {
            matchId: match.id,
          },
          {
            $set: {
              matchId: match.id,

              competitionId: match.competition.id,

              competitionCode:
                match.competition.code?.trim().toUpperCase() ?? '',

              seasonId: match.season?.id ?? 0,

              status: match.status ?? '',

              utcDate,

              homeTeamId: match.homeTeam.id,

              awayTeamId: match.awayTeam.id,

              payload: match as unknown as Record<string, unknown>,

              collectedAt: new Date(),
            },
          },
          {
            upsert: true,
          },
        )
        .exec();

      collected += 1;
    }

    return collected;
  }

  // ============================================================
  // FOOTBALL-DATA — STANDINGS
  // ============================================================

  async collectFootballDataStandings(
    standings: FootballDataStandingTable[],
    competition: FootballDataCompetitionPayload,
    seasonId: number,
  ): Promise<number> {
    if (
      typeof competition.id !== 'number' ||
      !competition.code ||
      typeof seasonId !== 'number'
    ) {
      return 0;
    }

    const competitionCode = competition.code.trim().toUpperCase();

    let collected = 0;

    for (const standing of standings) {
      for (const row of standing.table ?? []) {
        if (typeof row.team?.id !== 'number') {
          continue;
        }

        await this.footballDataStandingModel
          .updateOne(
            {
              competitionId: competition.id,

              competitionCode,

              seasonId,

              stage: standing.stage ?? 'REGULAR_SEASON',

              type: standing.type ?? 'TOTAL',

              group: standing.group ?? null,

              teamId: row.team.id,
            },
            {
              $set: {
                competitionId: competition.id,

                competitionCode,

                seasonId,

                stage: standing.stage ?? 'REGULAR_SEASON',

                type: standing.type ?? 'TOTAL',

                group: standing.group ?? null,

                teamId: row.team.id,

                payload: row as unknown as Record<string, unknown>,

                collectedAt: new Date(),
              },
            },
            {
              upsert: true,
            },
          )
          .exec();

        collected += 1;
      }
    }

    return collected;
  }

  // ============================================================
  // FOOTBALL-DATA — TEAMS
  // ============================================================

  async collectFootballDataTeams(
    teams: FootballDataTeamPayload[],
    competitionId: number,
    competitionCode: string,
  ): Promise<number> {
    let collected = 0;

    for (const team of teams) {
      if (typeof team.id !== 'number' || !team.name) {
        continue;
      }

      await this.footballDataTeamModel
        .updateOne(
          {
            teamId: team.id,

            competitionId,
          },
          {
            $set: {
              teamId: team.id,

              competitionId,

              competitionCode: competitionCode.trim().toUpperCase(),

              name: team.name,

              payload: team as unknown as Record<string, unknown>,

              collectedAt: new Date(),
            },
          },
          {
            upsert: true,
          },
        )
        .exec();

      collected += 1;
    }

    return collected;
  }

  // ============================================================
  // ODDS API — SPORTS
  // ============================================================

  async collectOddsSports(sports: OddsApiSportPayload[]): Promise<number> {
    let collected = 0;

    for (const sport of sports) {
      if (!sport.key) {
        continue;
      }

      await this.oddsApiSportModel
        .updateOne(
          {
            sportKey: sport.key,
          },
          {
            $set: {
              sportKey: sport.key,

              title: sport.title ?? sport.key,

              active: Boolean(sport.active),

              hasOutrights: Boolean(sport.has_outrights),

              payload: sport as unknown as Record<string, unknown>,

              collectedAt: new Date(),
            },
          },
          {
            upsert: true,
          },
        )
        .exec();

      collected += 1;
    }

    return collected;
  }

  // ============================================================
  // ODDS API — EVENT ODDS
  // ============================================================

  async collectOdds(events: OddsApiEventOdds[]): Promise<number> {
    let collected = 0;

    for (const event of events) {
      if (
        !event.id ||
        !event.sport_key ||
        !event.home_team ||
        !event.away_team
      ) {
        continue;
      }

      const commenceTime = new Date(event.commence_time);

      if (Number.isNaN(commenceTime.getTime())) {
        continue;
      }

      await this.sportsOddsSnapshotModel
        .updateOne(
          {
            eventId: event.id,
          },
          {
            $set: {
              eventId: event.id,

              sportKey: event.sport_key,

              homeTeam: event.home_team,

              awayTeam: event.away_team,

              commenceTime,

              payload: event as unknown as Record<string, unknown>,

              collectedAt: new Date(),
            },
          },
          {
            upsert: true,
          },
        )
        .exec();

      collected += 1;
    }

    return collected;
  }

  // ============================================================
  // ESPN LEAGUE HELPERS
  // ============================================================

  private extractEspnLeagueSeason(league: EspnLeaguePayload): {
    season: number;
    startDate?: Date;
    endDate?: Date;
  } | null {
    const candidate = league.season;

    if (!candidate || typeof candidate !== 'object') {
      return null;
    }

    const seasonValue =
      typeof candidate.year === 'number'
        ? candidate.year
        : this.toNumber(candidate.year);

    if (seasonValue === undefined) {
      return null;
    }

    return {
      season: seasonValue,

      startDate: this.parseDate(candidate.startDate),

      endDate: this.parseDate(candidate.endDate),
    };
  }

  private isSeasonActive(
    startDate?: Date,
    endDate?: Date,
    now = new Date(),
  ): boolean {
    if (!startDate) {
      return false;
    }

    if (now.getTime() < startDate.getTime()) {
      return false;
    }

    if (endDate && now.getTime() > endDate.getTime()) {
      return false;
    }

    return true;
  }

  private findPriorityCompetition(...identifiers: string[]) {
    const normalizedIdentifiers = identifiers
      .map((value) => this.normalizeLeagueId(value))
      .filter(Boolean);

    if (normalizedIdentifiers.length === 0) {
      return undefined;
    }

    return this.priorityCompetitionService.getAll().find((competition) => {
      const competitionId = this.normalizeLeagueId(competition.id);

      const espnSlug = this.normalizeLeagueId(
        competition.providers?.espnLeagueSlug,
      );

      return (
        normalizedIdentifiers.includes(competitionId) ||
        normalizedIdentifiers.includes(espnSlug)
      );
    });
  }

  private getStoredPriority(league: unknown): CompetitionPriority {
    const value = this.asRecord(league)?.priority;

    if (
      Object.values(CompetitionPriority).includes(value as CompetitionPriority)
    ) {
      return value as CompetitionPriority;
    }

    return CompetitionPriority.SELECTIVE;
  }

  private extractCountryFromLeague(
    league: EspnLeaguePayload,
  ): string | undefined {
    const country: unknown = league.country;

    if (typeof country === 'string') {
      return this.getStringValue(country);
    }

    if (country && typeof country === 'object') {
      const value = country as Record<string, unknown>;

      return (
        this.getStringValue(value.name) ??
        this.getStringValue(value.displayName) ??
        this.getStringValue(value.abbreviation)
      );
    }

    return undefined;
  }

  private getDefaultCompetitionRegion(
    league: EspnLeaguePayload,
  ): CompetitionRegion {
    const country = this.extractCountryFromLeague(league);

    if (country && country.toLowerCase() === 'nigeria') {
      return CompetitionRegion.NIGERIA;
    }

    return CompetitionRegion.EUROPE;
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private appendEspnTeamOperations(
    operations: Parameters<Model<EspnTeamDocument>['bulkWrite']>[0],
    leagueId: string,
    competitors: unknown[],
    collectedAt: Date,
  ): void {
    for (const competitor of competitors) {
      const competitorRecord = this.asRecord(competitor);

      const team = this.asRecord(competitorRecord?.team);

      const teamId = this.toStringValue(team?.id ?? competitorRecord?.id);

      if (!teamId) {
        continue;
      }

      operations.push({
        updateOne: {
          filter: {
            teamId,

            leagueId,
          },

          update: {
            $set: {
              teamId,

              leagueId,

              name: team?.name ?? team?.displayName ?? `Team ${teamId}`,

              displayName: team?.displayName ?? team?.name ?? `Team ${teamId}`,

              shortDisplayName:
                team?.shortDisplayName ?? team?.name ?? `Team ${teamId}`,

              abbreviation: team?.abbreviation,

              location: team?.location,

              logo: this.getTeamLogo(team),

              colors: team?.color ?? team?.colors,

              active: team?.isActive ?? true,

              payload: team ?? competitor,

              collectedAt,
            },
          },

          upsert: true,
        },
      });
    }
  }

  private extractArray(value: unknown, keys: string[] = []): unknown[] {
    if (Array.isArray(value)) {
      return value;
    }

    if (!value || typeof value !== 'object') {
      return [];
    }

    const object = value as Record<string, unknown>;

    for (const key of keys) {
      if (Array.isArray(object[key])) {
        return object[key] as unknown[];
      }
    }

    return [];
  }

  private extractStandingEntries(
    response:
      EspnStandingsResponse | Record<string, unknown> | null | undefined,
  ): EspnStandingEntry[] {
    if (!response || typeof response !== 'object') {
      return [];
    }

    const root = this.asRecord(response);

    if (!root) {
      return [];
    }

    const directStandings = this.asRecord(root.standings);

    if (Array.isArray(directStandings?.entries)) {
      return directStandings.entries as EspnStandingEntry[];
    }

    const children = Array.isArray(root.children)
      ? (root.children as unknown[])
      : [];

    const entries: EspnStandingEntry[] = [];

    for (const child of children) {
      this.collectStandingEntriesFromGroup(child, entries);
    }

    if (entries.length > 0) {
      return entries;
    }

    if (Array.isArray(root.standings)) {
      for (const group of root.standings as unknown[]) {
        this.collectStandingEntriesFromGroup(group, entries);
      }

      if (entries.length > 0) {
        return entries;
      }
    }

    const groups = Array.isArray(root.groups) ? (root.groups as unknown[]) : [];

    for (const group of groups) {
      this.collectStandingEntriesFromGroup(group, entries);
    }

    return entries;
  }

  private collectStandingEntriesFromGroup(
    value: unknown,
    output: EspnStandingEntry[],
  ): void {
    const group = this.asRecord(value);

    if (!group) {
      return;
    }

    const standings = this.asRecord(group.standings);

    if (Array.isArray(standings?.entries)) {
      output.push(...(standings.entries as EspnStandingEntry[]));
    }

    if (Array.isArray(group.entries)) {
      output.push(...(group.entries as EspnStandingEntry[]));
    }

    if (Array.isArray(group.children)) {
      for (const child of group.children as unknown[]) {
        this.collectStandingEntriesFromGroup(child, output);
      }
    }
  }

  private getStatisticNumber(
    stats: unknown[],
    ...names: string[]
  ): number | undefined {
    for (const item of stats) {
      const statistic =
        item !== null && typeof item === 'object'
          ? (item as Record<string, unknown>)
          : undefined;

      const nameValue =
        statistic?.name ?? statistic?.type ?? statistic?.key ?? '';

      const name =
        typeof nameValue === 'string' || typeof nameValue === 'number'
          ? String(nameValue).toLowerCase()
          : '';

      if (names.some((candidate) => name === candidate.toLowerCase())) {
        return (
          this.toNumber(statistic?.value) ??
          this.toNumber(statistic?.displayValue)
        );
      }
    }

    return undefined;
  }

  private getStatisticDisplayValue(
    stats: unknown[],
    names: string[],
  ): string | undefined {
    for (const item of stats) {
      const statistic =
        item !== null && typeof item === 'object'
          ? (item as Record<string, unknown>)
          : undefined;

      const nameValue =
        statistic?.name ?? statistic?.type ?? statistic?.key ?? '';

      const name =
        typeof nameValue === 'string' || typeof nameValue === 'number'
          ? String(nameValue).toLowerCase()
          : '';

      if (names.some((candidate) => name === candidate.toLowerCase())) {
        return this.toStringValue(statistic?.displayValue ?? statistic?.value);
      }
    }

    return undefined;
  }

  private getNestedString(value: unknown, path: string[]): string | undefined {
    return this.toStringValue(this.getNestedValue(value, path));
  }

  private getNestedValue(value: unknown, path: string[]): unknown {
    let current: unknown = value;

    for (const key of path) {
      if (typeof current !== 'object' || current === null) {
        return undefined;
      }

      current = (current as Record<string, unknown>)[key];
    }

    return current;
  }

  private getTeamId(competitor: unknown): string {
    return (
      this.getNestedString(competitor, ['team', 'id']) ??
      this.getNestedString(competitor, ['id']) ??
      ''
    );
  }

  private getTeamLogo(team: unknown): string | undefined {
    if (typeof team !== 'object' || team === null) {
      return undefined;
    }

    const teamRecord = team as Record<string, unknown>;

    const logo = teamRecord.logo;

    if (typeof logo === 'string') {
      return logo;
    }

    const logos = teamRecord.logos;

    if (Array.isArray(logos)) {
      const firstLogo: unknown = logos[0];

      if (typeof firstLogo === 'object' && firstLogo !== null) {
        const href = (firstLogo as Record<string, unknown>).href;

        if (typeof href === 'string') {
          return href;
        }
      }
    }

    return undefined;
  }

  private getFirstCompetition(event: unknown): unknown {
    if (event === null || typeof event !== 'object') {
      return undefined;
    }

    const competitions = (event as Record<string, unknown>).competitions;

    return Array.isArray(competitions) ? competitions[0] : undefined;
  }

  private extractStatus(event: unknown): string {
    const competition = this.getFirstCompetition(event);

    return (
      this.getNestedString(competition, ['status', 'type', 'name']) ??
      this.getNestedString(competition, ['status', 'type', 'state']) ??
      this.getNestedString(event, ['status', 'type', 'name']) ??
      'UNKNOWN'
    );
  }

  private isCompleted(event: unknown): boolean {
    const competition = this.getFirstCompetition(event);

    const competitionRecord =
      competition !== null && typeof competition === 'object'
        ? (competition as Record<string, unknown>)
        : undefined;

    const eventRecord =
      event !== null && typeof event === 'object'
        ? (event as Record<string, unknown>)
        : undefined;

    const status = competitionRecord?.status ?? eventRecord?.status;

    const statusRecord =
      status !== null && typeof status === 'object'
        ? (status as Record<string, unknown>)
        : undefined;

    const statusType =
      statusRecord?.type !== null && typeof statusRecord?.type === 'object'
        ? (statusRecord.type as Record<string, unknown>)
        : undefined;

    if (statusType?.completed === true || statusRecord?.completed === true) {
      return true;
    }

    const rawState = statusType?.state ?? statusRecord?.state;

    const state =
      typeof rawState === 'string' || typeof rawState === 'number'
        ? String(rawState).toLowerCase()
        : '';

    return ['post', 'final', 'completed', 'complete', 'finished'].includes(
      state,
    );
  }

  private getSeasonFromFixtures(response: unknown): number | undefined {
    const events = this.extractArray(response, ['events', 'items']);

    for (const event of events) {
      const season = this.toNumber(
        this.getNestedString(event, ['season', 'year']),
      );

      if (season !== undefined) {
        return season;
      }
    }

    return undefined;
  }

  private parseDate(value: unknown): Date | undefined {
    if (typeof value !== 'string' && !(value instanceof Date)) {
      return undefined;
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  private toStringValue(value: unknown): string | undefined {
    if (
      value === null ||
      value === undefined ||
      (typeof value === 'object' && !(value instanceof Date))
    ) {
      return undefined;
    }

    const result =
      typeof value === 'string'
        ? value.trim()
        : value instanceof Date
          ? value.toString().trim()
          : typeof value === 'number' ||
              typeof value === 'boolean' ||
              typeof value === 'bigint' ||
              typeof value === 'symbol'
            ? value.toString().trim()
            : '';

    return result ? result : undefined;
  }

  private getStringValue(value: unknown): string | undefined {
    return this.toStringValue(value);
  }

  private normalizeLeagueId(value?: string): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }

    return value as Record<string, unknown>;
  }

  private toNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value !== 'string') {
      return undefined;
    }

    const cleaned = value.replace('%', '').trim();

    const result = Number(cleaned);

    return Number.isFinite(result) ? result : undefined;
  }

  /**
   * Converts a Date into the UTC calendar
   * date expected by ESPN's dates parameter.
   *
   * YYYY-MM-DD
   */
  private toUtcDateOnly(value: Date): string {
    const date = new Date(value);

    const year = date.getUTCFullYear();

    const month = String(date.getUTCMonth() + 1).padStart(2, '0');

    const day = String(date.getUTCDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  }
}
