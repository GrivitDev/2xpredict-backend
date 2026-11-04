// backend/src/sports/services/sports-collection.service.ts

import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { SettlementTriggerService } from '../../settlement/services/settlement-trigger.service';
import {
  isFixtureRefreshConfirmedFinished,
  isFixtureRefreshExplicitlyNonFinal,
} from '../../settlement/utils/fixture-lifecycle.util';
import { createHash } from 'node:crypto';

import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { EspnService } from '../providers/espn.service';

import {
  EspnFixture,
  EspnFixtureDocument,
} from '../schemas/espn/espn-fixture.schema';

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

import { ActiveCompetitionService } from './active-competition.service';

import { EspnNews, EspnNewsDocument } from '../schemas/espn/espn-news.schema';
import {
  SportsSyncState,
  SportsSyncStateDocument,
  SportsSyncStateKind,
  SportsSyncStateStatus,
} from '../schemas/sports-sync-state.schema';

import { EspnStandingsService } from './espn-standings.service';
import { EspnQueueBuilderService } from './espn-queue-builder.service';
import { EspnQueueService } from './espn-queue.service';
import { EspnQueueJobType } from '../interfaces/espn-queue.interface';

interface SummaryNewsUpsert {
  contentId: string;
  articleId: string;
  normalizedHeadline: string;
  kind: 'NEWS' | 'VIDEO';
  leagueId: string;
  leagueIds: string[];
  eventIds: string[];
  teamIds: string[];
  eventId: string;
  homeTeamId?: string;
  awayTeamId?: string;
  fixtureDate?: Date;
  headline: string;
  description?: string;
  published?: Date;
  lastModified?: Date;
  feedPublishedAt: Date;
  link?: string;
  imageUrl?: string;
  type?: string;
  author?: string;
  sourceArticleId?: string;
  payload: Record<string, unknown>;
  collectedAt: Date;
}

function mergeSummaryRecords(
  existingValue: unknown,
  incomingValue: unknown,
): Record<string, unknown> {
  const asObject = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const existing = asObject(existingValue) ?? {};
  const incoming = asObject(incomingValue) ?? {};
  const merged: Record<string, unknown> = { ...existing };

  for (const [key, incomingValue] of Object.entries(incoming)) {
    if (incomingValue === undefined || incomingValue === null) continue;
    const currentValue = existing[key];
    const incomingObject = asObject(incomingValue);
    if (incomingObject) {
      const nested = mergeSummaryRecords(currentValue, incomingValue);
      if (Object.keys(nested).length > 0) merged[key] = nested;
      continue;
    }
    if (Array.isArray(incomingValue)) {
      // An empty partial response must not erase a previously collected section.
      if (incomingValue.length > 0 || currentValue === undefined)
        merged[key] = incomingValue;
      continue;
    }
    if (typeof incomingValue === 'string' && incomingValue.trim() === '')
      continue;
    merged[key] = incomingValue;
  }
  return merged;
}

interface SummaryNewsSource {
  leagueId: string;
  eventId: string;
  summary: unknown;
  fixtureDate?: unknown;
  homeTeamId?: unknown;
  awayTeamId?: unknown;
}

type EspnScoreSource =
  | 'SUMMARY_COMPETITORS'
  | 'SUMMARY_BOXSCORE'
  | 'FIXTURE_PAYLOAD'
  | 'ROOT_FIXTURE';

interface EspnScorePair {
  homeScore: number;
  awayScore: number;
}

interface EspnSummaryFinalResult {
  status: string;
  statusDetail?: string;
  statusShortDetail?: string;
  homeScore?: number;
  awayScore?: number;
  scoreSource?: 'SUMMARY_COMPETITORS' | 'SUMMARY_BOXSCORE';
  scoreConflict?: boolean;
}

interface StoredFixtureResultResolution {
  homeScore?: number;
  awayScore?: number;
  source?: EspnScoreSource;
  conflict?: boolean;
  shouldRefreshSummary: boolean;
}

export interface EspnSummaryReconciliationResult {
  isFinal: true;
  hasScores: boolean;
  homeScore?: number;
  awayScore?: number;
  rootChanged: boolean;
}

@Injectable()
export class SportsCollectionService {
  private readonly logger = new Logger(SportsCollectionService.name);

  /**
   * Keep Mongo write batches small and bounded when an ESPN scoreboard
   * response contains a large number of events.
   */
  // Keep batches bounded for the 1 GB application instance while halving
  // the write-round-trip count versus the previous 50-operation batches.
  private readonly mongoBulkChunkSize = 100;

  /**
   * Full-season startup fixture collection window.
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

    private readonly espnStandingsService: EspnStandingsService,

    private readonly espnQueueBuilderService: EspnQueueBuilderService,

    private readonly espnQueueService: EspnQueueService,

    // ----------------------------------------------------------
    // ESPN
    // ----------------------------------------------------------

    @InjectModel(EspnFixture.name)
    private readonly espnFixtureModel: Model<EspnFixtureDocument>,

    @InjectModel(EspnTeam.name)
    private readonly espnTeamModel: Model<EspnTeamDocument>,

    @InjectModel(EspnNews.name)
    private readonly espnNewsModel: Model<EspnNewsDocument>,

    @InjectModel(SportsSyncState.name)
    private readonly sportsSyncStateModel: Model<SportsSyncStateDocument>,

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

    // Fixture refresh discovers lifecycle; Summary can only add result evidence.
    @Inject(forwardRef(() => SettlementTriggerService))
    private readonly settlementTriggerService: SettlementTriggerService,
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
    options: { suppressFollowUpTriggers?: boolean; season?: number } = {},
  ): Promise<{
    fixtureIds: string[];
    collected: number;
  }> {
    const normalizedLeagueId = this.normalizeLeagueId(leagueId);

    const events = this.extractArray(response, ['events', 'items']);

    const fixtureIds: string[] = [];
    const confirmedFinishedFixtureIds: string[] = [];

    let fixtureOperations: Parameters<
      Model<EspnFixtureDocument>['bulkWrite']
    >[0] = [];

    let teamOperations: Parameters<Model<EspnTeamDocument>['bulkWrite']>[0] =
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
        options.season ??
        fixtureDate.getUTCFullYear();

      const status = this.extractStatus(event);

      const completed = this.isCompleted(event);
      const incomingLive = this.isLiveEvent(event);
      const incomingLifecycleBlocksSettlement =
        isFixtureRefreshExplicitlyNonFinal(event);
      // Scores are always handled as a complete home/away pair. Never update
      // only one side from a partial or malformed scoreboard snapshot.
      const incomingScorePair = this.scorePair(home?.score, away?.score);
      const incomingHomeScore = incomingScorePair?.homeScore;
      const incomingAwayScore = incomingScorePair?.awayScore;

      /*
       * Do not let a partial or conflicting scoreboard snapshot overwrite a
       * previously completed canonical result. A complete, matching pair may
       * still refresh the row; a missing side or changed score pair is held
       * until the detailed Summary can arbitrate it. Mongo evaluates this
       * expression against the pre-update row.
       */
      const incomingScorePairMissing =
        incomingHomeScore === undefined || incomingAwayScore === undefined;
      const incomingScorePairConflictsWithStored =
        incomingHomeScore !== undefined && incomingAwayScore !== undefined
          ? {
              $and: [
                { $isNumber: '$homeScore' },
                { $isNumber: '$awayScore' },
                {
                  $or: [
                    { $ne: ['$homeScore', { $literal: incomingHomeScore }] },
                    { $ne: ['$awayScore', { $literal: incomingAwayScore }] },
                  ],
                },
              ],
            }
          : false;
      const preserveCompletedFixture = {
        $and: [
          { $eq: ['$completed', true] },
          { $literal: !incomingLifecycleBlocksSettlement },
          {
            $or: [
              { $eq: [{ $literal: completed }, false] },
              { $eq: ['$payload.resultScoreUnresolved', true] },
              { $literal: incomingScorePairMissing },
              incomingScorePairConflictsWithStored,
            ],
          },
        ],
      };

      const eventPayload = event as Record<string, unknown>;

      /*
       * The incoming ESPN fixture event supplies canonical fixture fields.
       * Summary fields are excluded because they are collected independently.
       * Existing payload fields (including the latest stored Summary) are
       * preserved by MongoDB through $mergeObjects.
       * Node therefore never loads the existing Summary payload just to
       * merge it back into the fixture.
       */
      const payload: Record<string, unknown> = {
        ...eventPayload,
      };

      // Summary is collected independently. Do not let a scoreboard snapshot
      // replace a newer embedded summary during the atomic Mongo merge.
      delete payload.summary;
      delete payload.summaryCollectedAt;

      fixtureOperations.push({
        updateOne: {
          filter: {
            eventId,
          },

          update: [
            {
              $set: {
                eventId,

                leagueId: normalizedLeagueId,

                season,

                fixtureDate,

                status: {
                  $cond: [
                    preserveCompletedFixture,
                    '$status',
                    { $literal: status },
                  ],
                },

                statusDetail: {
                  $cond: [
                    preserveCompletedFixture,
                    '$statusDetail',
                    {
                      $literal: this.getNestedString(competition, [
                        'status',
                        'type',
                        'description',
                      ]),
                    },
                  ],
                },

                statusShortDetail: {
                  $cond: [
                    preserveCompletedFixture,
                    '$statusShortDetail',
                    {
                      $literal: this.getNestedString(competition, [
                        'status',
                        'type',
                        'shortDetail',
                      ]),
                    },
                  ],
                },

                period: {
                  $cond: [
                    preserveCompletedFixture,
                    '$period',
                    { $literal: this.toNumber(competition?.status?.period) },
                  ],
                },

                completed: {
                  $cond: [
                    { $literal: incomingLifecycleBlocksSettlement },
                    false,
                    { $or: ['$completed', { $literal: completed }] },
                  ],
                },

                live: {
                  $cond: [
                    { $literal: incomingLifecycleBlocksSettlement },
                    false,
                    {
                      $cond: [
                        { $eq: ['$completed', true] },
                        false,
                        { $literal: incomingLive },
                      ],
                    },
                  ],
                },

                displayClock: {
                  $cond: [
                    preserveCompletedFixture,
                    '$displayClock',
                    {
                      $literal:
                        this.getNestedString(event, [
                          'status',
                          'displayClock',
                        ]) ??
                        this.getNestedString(competition, [
                          'status',
                          'displayClock',
                        ]),
                    },
                  ],
                },

                homeTeamId: {
                  $ifNull: [
                    { $literal: this.getTeamId(home) || null },
                    '$homeTeamId',
                  ],
                },

                awayTeamId: {
                  $ifNull: [
                    { $literal: this.getTeamId(away) || null },
                    '$awayTeamId',
                  ],
                },

                homeScore: {
                  $cond: [
                    { $literal: incomingLifecycleBlocksSettlement },
                    '$$REMOVE',
                    incomingHomeScore === undefined
                      ? '$homeScore'
                      : {
                          $cond: [
                            preserveCompletedFixture,
                            '$homeScore',
                            { $literal: incomingHomeScore },
                          ],
                        },
                  ],
                },

                awayScore: {
                  $cond: [
                    { $literal: incomingLifecycleBlocksSettlement },
                    '$$REMOVE',
                    incomingAwayScore === undefined
                      ? '$awayScore'
                      : {
                          $cond: [
                            preserveCompletedFixture,
                            '$awayScore',
                            { $literal: incomingAwayScore },
                          ],
                        },
                  ],
                },

                venueId: this.toStringValue(competition?.venue?.id),

                venueName:
                  this.getNestedString(competition, ['venue', 'fullName']) ??
                  this.getNestedString(competition, ['venue', 'name']),

                payload: {
                  $cond: [
                    preserveCompletedFixture,
                    { $ifNull: ['$payload', {}] },
                    {
                      $mergeObjects: [
                        { $ifNull: ['$payload', {}] },
                        { $literal: payload },
                      ],
                    },
                  ],
                },

                fixtureCollectedAt: collectedAt,
                // Capture the transition to completed, not the kickoff age.
                // This lets a delayed post-match scoreboard confirm completion
                // after 48 hours while avoiding reclassifying legacy completed
                // fixtures as newly finished on every subsequent refresh.
                completedAt: {
                  $cond: [
                    { $literal: incomingLifecycleBlocksSettlement },
                    '$$REMOVE',
                    {
                      $cond: [
                        { $or: ['$completed', { $literal: completed }] },
                        {
                          $ifNull: ['$completedAt', { $literal: collectedAt }],
                        },
                        '$completedAt',
                      ],
                    },
                  ],
                },
                collectedAt,
              },
            },
          ],

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
      if (
        isFixtureRefreshConfirmedFinished({
          completed,
          live: incomingLive,
          payload: eventPayload,
        })
      ) {
        confirmedFinishedFixtureIds.push(eventId);
      }

      /*
       * Flush completed Mongo batches immediately. We deliberately do not
       * retain all operations for the entire month in Node memory.
       */
      if (fixtureOperations.length >= this.mongoBulkChunkSize) {
        await this.bulkWriteFixtureChunks(fixtureOperations);
        fixtureOperations = [];
      }

      if (teamOperations.length >= this.mongoBulkChunkSize) {
        await this.bulkWriteTeamChunks(teamOperations);
        teamOperations = [];
      }
    }

    if (fixtureOperations.length > 0) {
      await this.bulkWriteFixtureChunks(fixtureOperations);
    }

    if (teamOperations.length > 0) {
      await this.bulkWriteTeamChunks(teamOperations);
    }

    // Do not mark the enclosing fixture-refresh job successful until the
    // durable follow-up jobs have been written. If Mongo queue insertion fails,
    // the fixture-refresh job itself retries; event keys make the replay safe.
    if (!options.suppressFollowUpTriggers) {
      const queueBuilder = this.espnQueueBuilderService as Pick<
        EspnQueueBuilderService,
        'onFixturesCollected'
      >;
      await queueBuilder.onFixturesCollected(fixtureIds);
    }

    // Fixture writes are durable at this point. Settlement independently reads
    // each event and verifies the fixture-feed lifecycle status before enqueueing.
    if (!options.suppressFollowUpTriggers && confirmedFinishedFixtureIds.length > 0) {
      const settlementTrigger = this.settlementTriggerService as Pick<
        SettlementTriggerService,
        'onFixturesRefreshed'
      >;
      await settlementTrigger.onFixturesRefreshed(confirmedFinishedFixtureIds);
    }

    return {
      fixtureIds,
      collected: fixtureIds.length,
    };
  }

  /**
   * Verifies every event ID returned by an ESPN month request is present in
   * the canonical fixture collection for the expected league and season.
   * Uses small $in batches so verification remains memory-safe.
   */
  /**
   * Confirms that a Summary refresh actually reached the canonical fixture
   * document and contains a usable ESPN section. Queue/sync success alone is
   * not accepted as proof of persistence.
   */
  async assertEspnSummaryPersisted(
    leagueId: string,
    season: number,
    eventId: string,
  ): Promise<void> {
    const normalizedLeagueId = this.normalizeLeagueId(leagueId);
    const normalizedEventId = String(eventId ?? '').trim();
    if (!normalizedLeagueId || !Number.isInteger(season) || !normalizedEventId) {
      throw new Error('Summary persistence verification requires leagueId, season and eventId');
    }

    const fixture = await this.espnFixtureModel
      .findOne({
        leagueId: normalizedLeagueId,
        season,
        eventId: normalizedEventId,
      })
      .select({ 'payload.summary': 1 })
      .lean()
      .exec();

    const payload = fixture?.payload as Record<string, unknown> | undefined;
    if (!this.hasUsableSummaryForHash(payload?.summary)) {
      throw new Error(
        `Summary persistence verification failed for ${normalizedLeagueId}/${season}/${normalizedEventId}`,
      );
    }
  }

  async assertEspnFixtureIdsPersisted(
    leagueId: string,
    season: number,
    fixtureIds: string[],
  ): Promise<void> {
    const normalizedLeagueId = this.normalizeLeagueId(leagueId);
    const uniqueIds = [...new Set(fixtureIds.map((id) => String(id).trim()).filter(Boolean))];
    if (!normalizedLeagueId || !Number.isInteger(season)) {
      throw new Error('Fixture persistence verification requires leagueId and season');
    }

    for (let offset = 0; offset < uniqueIds.length; offset += 100) {
      const batch = uniqueIds.slice(offset, offset + 100);
      const persisted = await this.espnFixtureModel.countDocuments({
        leagueId: normalizedLeagueId,
        season,
        eventId: { $in: batch },
      });
      if (persisted !== batch.length) {
        throw new Error(
          `Fixture persistence verification failed for ${normalizedLeagueId}/${season}: expected ${batch.length} event documents in batch, found ${persisted}`,
        );
      }
    }
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
   * newlyFinished so the event-triggered queue can immediately trigger:
   *
   * 1. affected-league fixture refresh;
   * 2. event Summary refresh.
   *
   * This method does not directly collect Summary or derived table data.
   * Persisted fixture updates only schedule background standings work.
   */
  /**
   * Synchronize ESPN's global live scoreboard against fixtures already
   * collected by the canonical league/day fixture pipeline.
   *
   * This is deliberately an update-only path:
   * - It never discovers leagues or refreshes the full league catalogue.
   * - It never creates an unknown event/league from the global scoreboard.
   * - A finished event is processed only when its stored fixture was
   *   previously marked live, so stale completed events in ESPN's global
   *   scoreboard are not treated as newly discovered matches.
   *
   * Regular fixture and catalogue synchronization remain responsible for
   * discovering new events and leagues.
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

    const liveEventIds = new Set<string>();

    const newlyFinished: Array<{
      eventId: string;
      leagueId: string;
      season: number;
    }> = [];

    const affectedLeagueIds = new Set<string>();

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
      const incomingLifecycleBlocksSettlement =
        isFixtureRefreshExplicitlyNonFinal(eventRecord);

      if (!isLive && !completed && !incomingLifecycleBlocksSettlement) {
        continue;
      }

      /*
       * For active events, find the canonical fixture by event ID.
       * For completed events, only fetch a row that was previously live
       * and has not already been marked completed. The latter condition is
       * crucial because ESPN's global scoreboard can also include older
       * completed events on every poll.
       */
      const storedFixture = await this.espnFixtureModel
        .findOne(
          completed
            ? {
                eventId,
                live: true,
                completed: { $ne: true },
              }
            : {
                eventId,
              },
        )
        .select({
          leagueId: 1,
          season: 1,
          completed: 1,
          live: 1,
          completedAt: 1,
          fixtureDate: 1,
          homeScore: 1,
          awayScore: 1,
          homeTeamId: 1,
          awayTeamId: 1,
          'payload.summary': 1,
        })
        .lean()
        .exec();

      /*
       * The global live scoreboard is not the source of truth for league
       * discovery. If the regular fixture collector has not stored the
       * event, leave it for that pipeline rather than trying to interpret
       * ESPN's numeric league UID and downloading the complete catalogue.
       */
      if (!storedFixture?.leagueId) {
        continue;
      }

      // The global live board can temporarily contain a stale in-progress
      // snapshot for an event already stored as final. Never downgrade that
      // canonical completed result from the live path.
      if (
        storedFixture.completed === true &&
        !completed &&
        !incomingLifecycleBlocksSettlement
      ) {
        continue;
      }

      const normalizedLeagueId = this.normalizeLeagueId(storedFixture.leagueId);

      if (!normalizedLeagueId) {
        continue;
      }

      const fixtureDate =
        this.parseDate(eventRecord.date) ??
        this.parseDate(storedFixture.fixtureDate);

      if (!fixtureDate) {
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
        storedFixture.season ??
        fixtureDate.getUTCFullYear();

      const status = this.extractStatus(event);

      const displayClock =
        this.getNestedString(event, ['status', 'displayClock']) ??
        this.getNestedString(competition, ['status', 'displayClock']);

      affectedLeagueIds.add(normalizedLeagueId);

      const wasCompleted = Boolean(storedFixture.completed);
      const wasLive = Boolean(storedFixture.live);
      const completedAt =
        storedFixture.completedAt ??
        (completed && !wasCompleted && wasLive ? new Date() : undefined);

      const incomingScorePair = this.extractCompetitorScorePair(competition);
      const storedPayload = this.asRecord(storedFixture.payload) ?? {};
      const storedSummaryResult = this.extractSummaryFinalResult(
        storedPayload.summary,
        {
          homeTeamId: storedFixture.homeTeamId,
          awayTeamId: storedFixture.awayTeamId,
        },
      );
      const storedSummaryPair =
        storedSummaryResult &&
        storedSummaryResult.homeScore !== undefined &&
        storedSummaryResult.awayScore !== undefined
          ? this.scorePair(
              storedSummaryResult.homeScore,
              storedSummaryResult.awayScore,
            )
          : undefined;
      const summaryHasScoreConflict =
        storedSummaryResult?.scoreConflict === true;
      const existingScorePair = this.scorePair(
        storedFixture.homeScore,
        storedFixture.awayScore,
      );
      const resolvedScorePair = incomingLifecycleBlocksSettlement
        ? undefined
        : completed
          ? summaryHasScoreConflict
            ? undefined
            : (storedSummaryPair ?? incomingScorePair)
          : (incomingScorePair ?? existingScorePair);
      const clearFinalScores =
        incomingLifecycleBlocksSettlement || (completed && !resolvedScorePair);

      const livePayload: Record<string, unknown> = {
        ...eventRecord,
      };

      // Summary is owned by the summary collector. Omitting these properties
      // lets the Mongo update pipeline preserve the latest stored values.
      delete livePayload.summary;
      delete livePayload.summaryCollectedAt;

      await this.espnFixtureModel
        .updateOne(
          {
            eventId,
          },
          [
            {
              $set: {
                eventId,

                // Keep the canonical league ID from the stored fixture.
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

                completedAt: incomingLifecycleBlocksSettlement
                  ? '$$REMOVE'
                  : completedAt
                    ? { $ifNull: ['$completedAt', { $literal: completedAt }] }
                    : '$completedAt',

                live: incomingLifecycleBlocksSettlement ? false : isLive,

                homeTeamId: this.getTeamId(home),

                awayTeamId: this.getTeamId(away),

                homeScore: clearFinalScores
                  ? '$$REMOVE'
                  : resolvedScorePair
                    ? { $literal: resolvedScorePair.homeScore }
                    : '$homeScore',

                awayScore: clearFinalScores
                  ? '$$REMOVE'
                  : resolvedScorePair
                    ? { $literal: resolvedScorePair.awayScore }
                    : '$awayScore',

                venueId: this.getNestedString(competition, ['venue', 'id']),

                venueName:
                  this.getNestedString(competition, ['venue', 'fullName']) ??
                  this.getNestedString(competition, ['venue', 'name']),

                payload: {
                  $mergeObjects: [
                    { $ifNull: ['$payload', {}] },
                    { $literal: livePayload },
                  ],
                },

                collectedAt: new Date(),
              },
            },
            ...(clearFinalScores
              ? [{ $unset: ['homeScore', 'awayScore'] }]
              : []),
          ],
          {
            upsert: false,
            updatePipeline: true,
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

    // Derived standings refreshes are background work, never startup gates.
    for (const affectedLeagueId of affectedLeagueIds) {
      void this.scheduleDerivedRefreshForLeague(affectedLeagueId);
    }

    if (newlyFinished.length > 0) {
      const settlementTrigger = this.settlementTriggerService as Pick<
        SettlementTriggerService,
        'onFixturesRefreshed'
      >;
      await settlementTrigger.onFixturesRefreshed(
        newlyFinished.map((fixture) => fixture.eventId),
      );
    }

    return {
      received: events.length,
      updated,
      cleared: clearedResult.modifiedCount,
      newlyFinished,
    };
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

  /**
   * Extract news and videos from saved ESPN Summary payloads and persist them
   * into sports_espn_news. The feed never needs to reopen fixture summaries.
   *
   * Content is deduplicated by normalized headline plus kind. A deterministic
   * hash is used as the unique content ID, so duplicate titles arriving from
   * different fixtures or concurrent Summary jobs upsert the same document.
   */
  private async persistSummaryNewsBatch(
    sources: SummaryNewsSource[],
  ): Promise<{ examined: number; upserted: number }> {
    if (sources.length === 0) return { examined: 0, upserted: 0 };

    const eventIds = [
      ...new Set(
        sources
          .filter(
            (source) =>
              source.fixtureDate === undefined ||
              source.homeTeamId === undefined ||
              source.awayTeamId === undefined,
          )
          .map((source) => String(source.eventId ?? '').trim())
          .filter(Boolean),
      ),
    ];

    const fixtures = eventIds.length
      ? await this.espnFixtureModel
          .find({ eventId: { $in: eventIds } })
          .select({
            _id: 0,
            eventId: 1,
            fixtureDate: 1,
            homeTeamId: 1,
            awayTeamId: 1,
          })
          .lean()
          .exec()
      : [];

    const fixtureByEventId = new Map(
      fixtures.map((fixture) => [String(fixture.eventId), fixture]),
    );

    const now = new Date();
    const cutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const deduplicated = new Map<string, SummaryNewsUpsert>();
    let examined = 0;

    const readString = (
      record: Record<string, unknown>,
      ...keys: string[]
    ): string | undefined => {
      for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number' && Number.isFinite(value)) {
          return String(value);
        }
      }
      return undefined;
    };

    const normalizeHeadline = (headline: string): string =>
      headline
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');

    const extractLink = (item: Record<string, unknown>): string | undefined => {
      const direct = readString(item, 'link', 'url', 'href');
      if (direct) return direct;
      const links = this.asRecord(item.links);
      const web = this.asRecord(links?.web);
      return readString(web ?? links ?? {}, 'href', 'url');
    };

    const extractImage = (
      item: Record<string, unknown>,
    ): string | undefined => {
      const direct = readString(item, 'imageUrl', 'image');
      if (direct) return direct;

      for (const rawImage of Array.isArray(item.images) ? item.images : []) {
        const image = this.asRecord(rawImage);
        if (!image) continue;
        const url = image.url;
        if (typeof url === 'string' && url.trim()) return url.trim();
        if (Array.isArray(url)) {
          const candidate = url.find(
            (value: unknown): value is string =>
              typeof value === 'string' && value.trim().length > 0,
          );
          if (typeof candidate === 'string') return candidate.trim();
        }
        const href = readString(image, 'href');
        if (href) return href;
      }

      const thumbnail = this.asRecord(item.thumbnail);
      return readString(thumbnail ?? {}, 'href', 'url');
    };

    const addItem = (
      rawItem: unknown,
      kind: 'NEWS' | 'VIDEO',
      source: SummaryNewsSource,
    ): void => {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        return;
      }

      examined += 1;
      const item = rawItem as Record<string, unknown>;
      const headline = readString(item, 'headline', 'title', 'name');
      if (!headline) return;

      const normalizedHeadline = normalizeHeadline(headline);
      if (!normalizedHeadline) return;

      const rawPublished =
        kind === 'VIDEO'
          ? (item.originalPublishDate ?? item.published)
          : (item.published ?? item.originalPublishDate);
      const published = this.parseDate(rawPublished);
      const lastModified = this.parseDate(item.lastModified);
      const hasOriginalPublication =
        rawPublished !== undefined &&
        rawPublished !== null &&
        !(typeof rawPublished === 'string' && !rawPublished.trim());
      const feedPublishedAt = hasOriginalPublication ? published : lastModified;

      if (
        !feedPublishedAt ||
        feedPublishedAt.getTime() < cutoff.getTime() ||
        feedPublishedAt.getTime() > now.getTime()
      ) {
        return;
      }

      const eventId = String(source.eventId ?? '').trim();
      const leagueId = this.normalizeLeagueId(source.leagueId);
      if (!eventId || !leagueId) return;

      const fixture = fixtureByEventId.get(eventId);
      const fixtureDate =
        this.parseDate(source.fixtureDate) ??
        this.parseDate(fixture?.fixtureDate);
      const homeTeamId =
        this.toStringValue(source.homeTeamId) ??
        this.toStringValue(fixture?.homeTeamId);
      const awayTeamId =
        this.toStringValue(source.awayTeamId) ??
        this.toStringValue(fixture?.awayTeamId);
      const teamIds = [homeTeamId, awayTeamId].filter(
        (value): value is string => Boolean(value),
      );

      const contentId = createHash('sha256')
        .update(`${kind}:${normalizedHeadline}`)
        .digest('hex');
      const description = readString(item, 'description', 'summary');
      const authorValue = item.author ?? item.byline;
      const author =
        typeof authorValue === 'string'
          ? authorValue.trim() || undefined
          : readString(this.asRecord(authorValue) ?? {}, 'name', 'displayName');

      const candidate: SummaryNewsUpsert = {
        contentId,
        articleId: contentId,
        normalizedHeadline,
        kind,
        leagueId,
        leagueIds: [leagueId],
        eventIds: [eventId],
        teamIds,
        eventId,
        homeTeamId,
        awayTeamId,
        fixtureDate,
        headline,
        description,
        published,
        lastModified,
        feedPublishedAt,
        link: extractLink(item),
        imageUrl: extractImage(item),
        type: readString(item, 'type', 'contentType') ?? kind,
        author,
        sourceArticleId: readString(item, 'id', 'articleId', 'uid'),
        payload: item,
        collectedAt: now,
      };

      const existing = deduplicated.get(contentId);
      if (!existing) {
        deduplicated.set(contentId, candidate);
        return;
      }

      existing.eventIds = [...new Set([...existing.eventIds, eventId])];
      existing.leagueIds = [...new Set([...existing.leagueIds, leagueId])];
      existing.teamIds = [...new Set([...existing.teamIds, ...teamIds])];

      if (feedPublishedAt.getTime() > existing.feedPublishedAt.getTime()) {
        candidate.eventIds = existing.eventIds;
        candidate.leagueIds = existing.leagueIds;
        candidate.teamIds = existing.teamIds;
        deduplicated.set(contentId, candidate);
      }
    };

    for (const source of sources) {
      const summary = this.asRecord(source.summary);
      if (!summary) continue;

      const news = this.asRecord(summary.news);
      const nestedNews = this.asRecord(news?.news);

      for (const article of [
        ...(Array.isArray(news?.articles) ? (news.articles as unknown[]) : []),
        ...(Array.isArray(nestedNews?.articles)
          ? (nestedNews.articles as unknown[])
          : []),
      ]) {
        addItem(article, 'NEWS', source);
      }

      for (const video of Array.isArray(summary.videos) ? summary.videos : []) {
        addItem(video, 'VIDEO', source);
      }
    }

    if (deduplicated.size === 0) return { examined, upserted: 0 };

    const operations: Parameters<Model<EspnNewsDocument>['bulkWrite']>[0] = [];
    const contentIds = [...deduplicated.keys()];
    const existingDocuments = await this.espnNewsModel
      .find({ contentId: { $in: contentIds } })
      .select({ _id: 0, contentId: 1, feedPublishedAt: 1 })
      .lean()
      .exec();
    const existingPublishedAt = new Map(
      existingDocuments.map((document) => [
        String(document.contentId),
        this.parseDate(document.feedPublishedAt),
      ]),
    );

    for (const item of deduplicated.values()) {
      const existingDate = existingPublishedAt.get(item.contentId);
      const shouldUpdateContent =
        !existingDate ||
        existingDate.getTime() <= item.feedPublishedAt.getTime();

      const update = {
        $addToSet: {
          leagueIds: { $each: item.leagueIds },
          eventIds: { $each: item.eventIds },
          teamIds: { $each: item.teamIds },
        },
        ...(shouldUpdateContent
          ? {
              $set: {
                contentId: item.contentId,
                articleId: item.articleId,
                normalizedHeadline: item.normalizedHeadline,
                kind: item.kind,
                leagueId: item.leagueId,
                eventId: item.eventId,
                homeTeamId: item.homeTeamId,
                awayTeamId: item.awayTeamId,
                fixtureDate: item.fixtureDate,
                headline: item.headline,
                description: item.description,
                published: item.published,
                lastModified: item.lastModified,
                feedPublishedAt: item.feedPublishedAt,
                link: item.link,
                imageUrl: item.imageUrl,
                type: item.type,
                author: item.author,
                sourceArticleId: item.sourceArticleId,
                payload: item.payload,
                collectedAt: item.collectedAt,
              },
            }
          : {}),
      };

      operations.push({
        updateOne: {
          filter: { contentId: item.contentId },
          update,
          upsert: true,
        },
      });
    }

    let upserted = 0;
    for (const chunk of this.chunkOperations(
      operations,
      this.mongoBulkChunkSize,
    )) {
      const result = await this.espnNewsModel.bulkWrite(chunk, {
        ordered: false,
      });
      upserted += result.upsertedCount ?? 0;
    }

    return { examined, upserted };
  }

  /**
   * One-time backfill for installations that already have ESPN Summary payloads.
   * It is skipped after normalized content has been stored at least once.
   */
  async backfillSummaryNewsFromStoredFixtures(): Promise<{
    skipped: boolean;
    scanned: number;
    upserted: number;
  }> {
    const stateKey = 'MAINTENANCE:ESPN_SUMMARY_NEWS_BACKFILL_V1';
    const existingState = await this.sportsSyncStateModel
      .findOne({ stateKey })
      .select({ status: 1 })
      .lean()
      .exec();

    if (existingState?.status === SportsSyncStateStatus.SUCCESS) {
      return { skipped: true, scanned: 0, upserted: 0 };
    }

    const startedAt = new Date();
    await this.sportsSyncStateModel
      .updateOne(
        { stateKey },
        {
          $set: {
            stateKey,
            kind: SportsSyncStateKind.CRON,
            status: SportsSyncStateStatus.PROCESSING,
            trackingMode: 'WINDOW',
            fixtureGranularity: 'DAY',
            jobType: 'NEWS_SUMMARY_BACKFILL',
            lastStartedAt: startedAt,
            lastError: undefined,
          },
          $setOnInsert: {
            units: [],
            consecutiveFailures: 0,
          },
        },
        { upsert: true },
      )
      .exec();

    const cursor = this.espnFixtureModel
      .find({ 'payload.summary': { $type: 'object' } })
      .select({
        _id: 0,
        eventId: 1,
        leagueId: 1,
        fixtureDate: 1,
        homeTeamId: 1,
        awayTeamId: 1,
        'payload.summary': 1,
      })
      .lean()
      .cursor({ batchSize: 50 });

    let scanned = 0;
    let upserted = 0;
    let batch: SummaryNewsSource[] = [];

    try {
      for await (const rawFixture of cursor) {
        const fixture = rawFixture as {
          eventId?: unknown;
          leagueId?: unknown;
          fixtureDate?: unknown;
          homeTeamId?: unknown;
          awayTeamId?: unknown;
          payload?: { summary?: unknown };
        };

        const eventId = this.toStringValue(fixture.eventId);
        const leagueId = this.toStringValue(fixture.leagueId);
        if (!eventId || !leagueId) continue;

        scanned += 1;
        batch.push({
          eventId,
          leagueId,
          summary: fixture.payload?.summary,
          fixtureDate: fixture.fixtureDate,
          homeTeamId: fixture.homeTeamId,
          awayTeamId: fixture.awayTeamId,
        });

        if (batch.length >= 50) {
          const result = await this.persistSummaryNewsBatch(batch);
          upserted += result.upserted;
          batch = [];
        }
      }

      if (batch.length > 0) {
        const result = await this.persistSummaryNewsBatch(batch);
        upserted += result.upserted;
      }

      await this.sportsSyncStateModel
        .updateOne(
          { stateKey },
          {
            $set: {
              status: SportsSyncStateStatus.SUCCESS,
              lastSuccessfulAt: new Date(),
              consecutiveFailures: 0,
            },
            $unset: {
              lastError: 1,
            },
          },
        )
        .exec();

      return { skipped: false, scanned, upserted };
    } catch (error) {
      await this.sportsSyncStateModel
        .updateOne(
          { stateKey },
          {
            $set: {
              status: SportsSyncStateStatus.FAILED,
              lastError: error instanceof Error ? error.message : String(error),
              consecutiveFailures: 1,
            },
          },
        )
        .exec();

      throw error;
    } finally {
      await cursor.close();
    }
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

    const season =
      this.toNumber(this.getNestedString(event, ['season', 'year'])) ??
      this.toNumber(this.getNestedString(competition, ['season', 'year'])) ??
      fixtureDate.getUTCFullYear();

    const status = this.extractStatus(event);

    const completed = this.isCompleted(event);
    const incomingLifecycleBlocksSettlement =
      isFixtureRefreshExplicitlyNonFinal(event);

    const normalizedLeagueId = this.normalizeLeagueId(params.leagueId);
    const existingFixture = await this.espnFixtureModel
      .findOne({ eventId })
      .select({
        status: 1,
        statusDetail: 1,
        statusShortDetail: 1,
        completed: 1,
        live: 1,
        completedAt: 1,
        fixtureDate: 1,
        homeScore: 1,
        awayScore: 1,
        homeTeamId: 1,
        awayTeamId: 1,
        payload: 1,
      })
      .lean()
      .exec();

    const existingPayload = this.asRecord(existingFixture?.payload) ?? {};
    const existingSummaryResult = this.extractSummaryFinalResult(
      existingPayload.summary,
      {
        homeTeamId: existingFixture?.homeTeamId,
        awayTeamId: existingFixture?.awayTeamId,
      },
    );
    const summaryScorePair =
      existingSummaryResult &&
      existingSummaryResult.homeScore !== undefined &&
      existingSummaryResult.awayScore !== undefined
        ? this.scorePair(
            existingSummaryResult.homeScore,
            existingSummaryResult.awayScore,
          )
        : undefined;
    const incomingScorePair = this.extractCompetitorScorePair(competition);
    const existingScorePair = this.scorePair(
      existingFixture?.homeScore,
      existingFixture?.awayScore,
    );
    const summaryHasScoreConflict =
      existingSummaryResult?.scoreConflict === true;
    const incomingConflictsWithExisting = Boolean(
      incomingScorePair &&
      existingScorePair &&
      (incomingScorePair.homeScore !== existingScorePair.homeScore ||
        incomingScorePair.awayScore !== existingScorePair.awayScore),
    );
    const existingOrIncomingZeroZero = Boolean(
      (existingScorePair?.homeScore === 0 &&
        existingScorePair.awayScore === 0) ||
      (incomingScorePair?.homeScore === 0 && incomingScorePair.awayScore === 0),
    );
    const unresolvedFinalResult =
      completed &&
      !summaryScorePair &&
      (summaryHasScoreConflict ||
        existingPayload.resultScoreUnresolved === true ||
        incomingConflictsWithExisting ||
        existingOrIncomingZeroZero ||
        (!existingScorePair && !incomingScorePair));
    const preserveCompletedFixture =
      existingFixture?.completed === true &&
      !incomingLifecycleBlocksSettlement &&
      (!completed ||
        existingPayload.resultScoreUnresolved === true ||
        summaryHasScoreConflict ||
        (!summaryScorePair &&
          (!incomingScorePair || incomingConflictsWithExisting)));
    const resolvedScorePair =
      incomingLifecycleBlocksSettlement || unresolvedFinalResult
        ? undefined
        : (summaryScorePair ??
          (preserveCompletedFixture
            ? existingScorePair
            : (incomingScorePair ??
              (completed ? undefined : existingScorePair))));
    const clearCompletedScores =
      incomingLifecycleBlocksSettlement || (completed && !resolvedScorePair);

    const detailPayload: Record<string, unknown> = preserveCompletedFixture
      ? { ...existingPayload }
      : { ...event };

    // Summary is stored independently and must survive every fixture/detail refresh.
    if (Object.prototype.hasOwnProperty.call(existingPayload, 'summary')) {
      detailPayload.summary = existingPayload.summary;
      if (existingPayload.summaryCollectedAt) {
        detailPayload.summaryCollectedAt = existingPayload.summaryCollectedAt;
      }
    }
    if (unresolvedFinalResult) {
      detailPayload.resultScoreUnresolved = true;
    } else if (resolvedScorePair) {
      delete detailPayload.resultScoreUnresolved;
    }

    const now = new Date();
    const effectiveCompleted =
      !incomingLifecycleBlocksSettlement &&
      (preserveCompletedFixture || completed);
    const set: Record<string, unknown> = {
      eventId,
      leagueId: normalizedLeagueId,
      season,
      fixtureDate: preserveCompletedFixture
        ? (existingFixture?.fixtureDate ?? fixtureDate)
        : fixtureDate,
      status: preserveCompletedFixture
        ? (existingFixture?.status ?? status)
        : status,
      statusDetail: preserveCompletedFixture
        ? existingFixture?.statusDetail
        : this.getNestedString(competition, ['status', 'type', 'description']),
      statusShortDetail: preserveCompletedFixture
        ? existingFixture?.statusShortDetail
        : this.getNestedString(competition, ['status', 'type', 'shortDetail']),
      period: preserveCompletedFixture
        ? undefined
        : this.toNumber(
            this.getNestedString(competition, ['status', 'period']),
          ),
      completed: effectiveCompleted,
      live:
        effectiveCompleted || incomingLifecycleBlocksSettlement
          ? false
          : this.isLiveEvent(event),
      homeTeamId: this.getTeamId(home) ?? existingFixture?.homeTeamId,
      awayTeamId: this.getTeamId(away) ?? existingFixture?.awayTeamId,
      venueId: this.getNestedString(competition, ['venue', 'id']),
      venueName:
        this.getNestedString(competition, ['venue', 'fullName']) ??
        this.getNestedString(competition, ['venue', 'name']),
      payload: detailPayload,
      collectedAt: now,
    };
    if (resolvedScorePair) {
      set.homeScore = resolvedScorePair.homeScore;
      set.awayScore = resolvedScorePair.awayScore;
    }
    if (effectiveCompleted) {
      set.completedAt = existingFixture?.completedAt ?? now;
    }
    for (const [key, value] of Object.entries(set)) {
      if (value === undefined) delete set[key];
    }

    await this.espnFixtureModel
      .updateOne(
        { eventId },
        {
          $set: set,
          ...(clearCompletedScores || incomingLifecycleBlocksSettlement
            ? {
                $unset: {
                  ...(clearCompletedScores
                    ? { homeScore: 1, awayScore: 1 }
                    : {}),
                  ...(incomingLifecycleBlocksSettlement
                    ? { completedAt: 1 }
                    : {}),
                },
              }
            : {}),
        },
        { upsert: true },
      )
      .exec();

    // If the stored final record conflicts with the fresh event snapshot, let
    // the event-specific Summary queue arbitrate instead of overwriting either
    // score with the numerically larger value.
    if (
      effectiveCompleted &&
      (!summaryScorePair ||
        summaryHasScoreConflict ||
        incomingConflictsWithExisting)
    ) {
      try {
        await this.espnQueueService.addSummaryRefreshJob({
          leagueId: normalizedLeagueId,
          eventId,
          season,
          priority: 4,
          scheduledFor: new Date(),
        });
      } catch (error) {
        this.logger.warn(
          `Could not queue Summary verification for fixture details ${eventId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await this.collectEspnTeams(params.leagueId, competitors);
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
  }): Promise<Record<string, unknown>> {
    const leagueId = this.normalizeLeagueId(params.leagueId);
    const eventId = String(params.eventId ?? '').trim();
    if (!eventId) throw new Error('ESPN Summary eventId cannot be empty');

    const existing = await this.espnFixtureModel
      .findOne({ eventId, leagueId })
      .select({
        eventId: 1,
        payload: 1,
        homeTeamId: 1,
        awayTeamId: 1,
        homeScore: 1,
        awayScore: 1,
        status: 1,
        statusDetail: 1,
        statusShortDetail: 1,
        completed: 1,
        live: 1,
      })
      .lean()
      .exec();
    if (!existing) {
      throw new Error(
        `ESPN fixture ${eventId} not found while storing Summary`,
      );
    }

    const existingPayload = this.asRecord(existing.payload) ?? {};
    const storedSummary = existingPayload.summary;
    const mergedSummary = this.mergeSummaryPreservingFinalResult(
      storedSummary,
      params.summary,
    );
    const summaryHash = this.summaryContentHash(mergedSummary);
    const storedHash = this.toStringValue(existingPayload.summaryContentHash);
    const unchanged =
      storedHash === summaryHash ||
      (!storedHash &&
        this.hasUsableSummaryForHash(storedSummary) &&
        this.summaryContentHash(storedSummary) === summaryHash);
    const collectedAt = new Date();

    const set: Record<string, unknown> = {
      'payload.summaryCollectedAt': collectedAt,
      'payload.summaryContentHash': summaryHash,
      collectedAt,
    };
    if (!unchanged) set['payload.summary'] = mergedSummary;

    const result = await this.espnFixtureModel
      .updateOne({ eventId, leagueId }, { $set: set })
      .exec();
    if (result.matchedCount === 0) {
      throw new Error(
        `ESPN fixture ${eventId} not found while storing Summary`,
      );
    }

    // ESPN Summary supplies detailed score evidence. It is reconciled only when
    // the fixture feed's own stored status already confirms the match as finished;
    // Summary never writes the lifecycle fields.
    const reconciliation = await this.reconcileFixtureResultFromSummary({
      leagueId,
      eventId,
      summary: mergedSummary,
      homeTeamId: existing.homeTeamId,
      awayTeamId: existing.awayTeamId,
      homeScore: existing.homeScore,
      awayScore: existing.awayScore,
      resultScoreUnresolved: existingPayload.resultScoreUnresolved === true,
      fixturePayload: existingPayload,
      status: existing.status,
      statusDetail: existing.statusDetail,
      statusShortDetail: existing.statusShortDetail,
      completed: existing.completed,
      live: existing.live,
    });

    // News normalization, deduplication and feed writes only run when the
    // canonical Summary content actually changes.
    if (!unchanged) {
      await this.persistSummaryNewsBatch([
        { leagueId, eventId, summary: mergedSummary },
      ]);
    }

    if (!unchanged || reconciliation?.rootChanged) {
      void this.scheduleDerivedRefreshForLeague(leagueId);
    }

    // Only a meaningful Summary or canonical-result change should trigger an immediate follow-up.
    // Unchanged refreshes must not mark an active settlement job for a redundant
    // rerun. Fixture refresh is responsible for lifecycle discovery; Summary only
    // requests a new pass when it changes evidence for an already-finished match.
    if (
      reconciliation?.hasScores &&
      (!unchanged || reconciliation.rootChanged)
    ) {
      try {
        await this.settlementTriggerService.onSummaryUpdated(eventId, leagueId);
      } catch (error) {
        this.logger.warn(
          `Could not enqueue settlement for Summary ${eventId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return mergedSummary;
  }

  /**
   * Reconciles score evidence from an already-stored ESPN Summary without another
   * provider request. The fixture feed must already have confirmed the finished
   * lifecycle; this method never changes status, completed, live, or completedAt.
   */
  async reconcileFixtureResultFromSummary(params: {
    leagueId: string;
    eventId: string;
    summary: unknown;
    homeTeamId?: unknown;
    awayTeamId?: unknown;
    homeScore?: unknown;
    awayScore?: unknown;
    resultScoreUnresolved?: boolean;
    fixturePayload?: unknown;
    status?: unknown;
    statusDetail?: unknown;
    statusShortDetail?: unknown;
    completed?: unknown;
    live?: unknown;
  }): Promise<EspnSummaryReconciliationResult | undefined> {
    const leagueId = this.normalizeLeagueId(params.leagueId);
    const eventId = String(params.eventId ?? '').trim();
    if (!leagueId || !eventId) return undefined;

    // Summary is result evidence only. It cannot create a finished state; only
    // the stored status from an ESPN fixture/scoreboard refresh can authorize it.
    if (
      !isFixtureRefreshConfirmedFinished({
        completed: params.completed,
        live: params.live,
        payload: params.fixturePayload,
      })
    ) {
      return undefined;
    }

    const finalResult = this.extractSummaryFinalResult(params.summary, {
      homeTeamId: params.homeTeamId,
      awayTeamId: params.awayTeamId,
    });
    if (!finalResult) return undefined;

    // Resolve all three stored representations as a complete score pair. A
    // terminal Summary pair wins when internally consistent. If Summary has no
    // score, root and fixture-payload pairs can still recover it, but conflicting
    // pairs and an unverified 0-0 are quarantined instead of being settled.
    const fixturePayload = this.asRecord(params.fixturePayload) ?? {};
    const normalizedPayload: Record<string, unknown> = {
      ...fixturePayload,
      summary: params.summary,
      ...(params.resultScoreUnresolved === true
        ? { resultScoreUnresolved: true }
        : {}),
    };
    const resolution = this.resolveStoredFixtureResult({
      completed: true,
      status: finalResult.status,
      statusDetail: finalResult.statusDetail,
      statusShortDetail: finalResult.statusShortDetail,
      homeScore: params.homeScore,
      awayScore: params.awayScore,
      homeTeamId: params.homeTeamId,
      awayTeamId: params.awayTeamId,
      payload: normalizedPayload,
    });
    const hasScores =
      !resolution.conflict &&
      !resolution.shouldRefreshSummary &&
      typeof resolution.homeScore === 'number' &&
      Number.isInteger(resolution.homeScore) &&
      resolution.homeScore >= 0 &&
      typeof resolution.awayScore === 'number' &&
      Number.isInteger(resolution.awayScore) &&
      resolution.awayScore >= 0;
    const quarantineScores = !hasScores;
    const existingRootPair = this.scorePair(params.homeScore, params.awayScore);
    const collectedAt = new Date();
    const scoreChanged = hasScores
      ? !existingRootPair ||
        existingRootPair.homeScore !== resolution.homeScore ||
        existingRootPair.awayScore !== resolution.awayScore
      : Boolean(quarantineScores && existingRootPair);
    const markerChanged = hasScores
      ? params.resultScoreUnresolved === true
      : quarantineScores && params.resultScoreUnresolved !== true;
    const payloadScoreUpdates = hasScores
      ? this.buildPayloadScoreNormalizationUpdates(params.fixturePayload, {
          homeScore: resolution.homeScore!,
          awayScore: resolution.awayScore!,
        })
      : {};
    const rootChanged =
      scoreChanged ||
      markerChanged ||
      Object.keys(payloadScoreUpdates).length > 0;
    // Summary may reconcile verified score evidence, never fixture lifecycle fields.
    const set: Record<string, unknown> = {
      collectedAt: { $literal: collectedAt },
    };
    if (hasScores) {
      set.homeScore = { $literal: resolution.homeScore };
      set.awayScore = { $literal: resolution.awayScore };
      for (const [path, value] of Object.entries(payloadScoreUpdates)) {
        set[path] = { $literal: value };
      }
    }
    if (quarantineScores) {
      set['payload.resultScoreUnresolved'] = true;
    }

    const updatePipeline: Array<Record<string, unknown>> = [{ $set: set }];
    if (quarantineScores) {
      // An unverified 0-0 or internally conflicting Summary must not remain a
      // numeric final result that another consumer can settle against.
      updatePipeline.push({ $unset: ['homeScore', 'awayScore'] });
    } else if (hasScores) {
      updatePipeline.push({ $unset: ['payload.resultScoreUnresolved'] });
    }

    const update = await this.espnFixtureModel
      .updateOne({ eventId, leagueId }, updatePipeline, {
        updatePipeline: true,
      })
      .exec();
    if (update.matchedCount === 0) return undefined;

    return {
      isFinal: true,
      hasScores,
      homeScore: hasScores ? resolution.homeScore : undefined,
      awayScore: hasScores ? resolution.awayScore : undefined,
      rootChanged,
    };
  }

  private mergeSummaryPreservingFinalResult(
    existingValue: unknown,
    incomingValue: unknown,
  ): Record<string, unknown> {
    const existing = this.asRecord(existingValue) ?? {};
    const incoming = this.asRecord(incomingValue) ?? {};
    const merged = mergeSummaryRecords(existing, incoming);
    const existingFinal = this.extractSummaryFinalResult(existing);
    const incomingFinal = this.extractSummaryFinalResult(incoming);

    // Summary sections such as header.competitions are arrays, and a shallow
    // replacement with an empty/stale PRE response can erase the final score.
    // Preserve only the existing sections that demonstrably contain the final
    // result; other Summary sections continue to merge normally.
    if (existingFinal && !incomingFinal) {
      for (const key of ['header', 'competitions', 'event']) {
        const existingSection = existing[key];
        const incomingSection = incoming[key];
        if (
          existingSection !== undefined &&
          this.extractSummaryFinalResult({ [key]: existingSection }) &&
          !this.extractSummaryFinalResult({ [key]: incomingSection })
        ) {
          merged[key] = existingSection;
        }
      }
    }

    return merged;
  }

  private extractSummaryFinalResult(
    value: unknown,
    teamIds: { homeTeamId?: unknown; awayTeamId?: unknown } = {},
  ): EspnSummaryFinalResult | undefined {
    const summary = this.asRecord(value);
    if (!summary) return undefined;

    const header = this.asRecord(summary.header);
    const event = this.asRecord(summary.event);
    const asUnknownArray = (candidate: unknown): unknown[] =>
      Array.isArray(candidate) ? (candidate as unknown[]) : [];
    const competitions = [
      ...asUnknownArray(header?.competitions),
      ...asUnknownArray(summary.competitions),
      ...asUnknownArray(event?.competitions),
    ]
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item));

    // Prefer a competition that explicitly reports a final state rather than
    // assuming the first array entry is always the relevant/final competition.
    const competition =
      competitions.find((item) =>
        this.isTerminalStatusRecord(item.status ?? item),
      ) ?? competitions[0];

    const status =
      this.asRecord(competition?.status) ??
      this.asRecord(header?.status) ??
      this.asRecord(summary.status) ??
      this.asRecord(event?.status);
    const statusType = this.asRecord(status?.type);
    const statusName = (
      this.toStringValue(statusType?.name ?? status?.name) ?? ''
    ).toUpperCase();
    const statusState = (
      this.toStringValue(statusType?.state ?? status?.state) ?? ''
    ).toLowerCase();
    const statusDetail =
      this.toStringValue(statusType?.detail ?? status?.detail) ??
      this.toStringValue(statusType?.description ?? status?.description) ??
      undefined;
    const statusShortDetail =
      this.toStringValue(statusType?.shortDetail ?? status?.shortDetail) ??
      this.toStringValue(statusType?.detail ?? status?.detail) ??
      undefined;
    const statusAbbreviation = (
      this.toStringValue(statusType?.abbreviation) ?? ''
    ).toUpperCase();
    const allStatusText = `${statusName} ${statusState} ${statusDetail ?? ''} ${statusShortDetail ?? ''} ${statusAbbreviation}`;
    if (/CANCEL|POSTPON|ABANDON|VOID|NO[_ ]?CONTEST/.test(allStatusText)) {
      return undefined;
    }

    const explicitlyCompleted =
      competition?.isFinal === true ||
      statusType?.completed === true ||
      status?.completed === true;
    const finalStatusName =
      /(^|_)FINAL($|_)|FULL[_ ]?TIME|FINISHED|COMPLETED/.test(statusName);
    const finalAbbreviation = ['FT', 'AET', 'PEN'].includes(statusAbbreviation);
    const finalStatusDetail = /\bFT\b|AFTER EXTRA TIME|AFTER PENALTIES/.test(
      allStatusText,
    );
    const finalState = [
      'post',
      'final',
      'complete',
      'completed',
      'finished',
    ].includes(statusState);
    if (
      !explicitlyCompleted &&
      !finalStatusName &&
      !finalAbbreviation &&
      !finalStatusDetail &&
      !finalState
    ) {
      return undefined;
    }

    // Primary score source: the completed competition's explicit home/away
    // competitors. Score orientation is always based on ESPN's homeAway marker.
    const competitorPair = this.extractCompetitorScorePair(competition);
    const boxscorePair = this.extractSummaryBoxscoreScorePair(
      summary,
      competition,
      teamIds,
    );
    const scoreConflict = Boolean(
      competitorPair &&
      boxscorePair &&
      (competitorPair.homeScore !== boxscorePair.homeScore ||
        competitorPair.awayScore !== boxscorePair.awayScore),
    );
    // The Summary's own result header and its team goal totals should agree.
    // If they do not, do not settle from either value; let the refresh/recovery
    // path retry rather than selecting a numerically larger score.
    const scorePair = scoreConflict
      ? undefined
      : (competitorPair ?? boxscorePair);

    return {
      status: statusName || 'STATUS_FINAL',
      statusDetail,
      statusShortDetail,
      ...(scoreConflict ? { scoreConflict: true } : {}),
      ...(scorePair
        ? {
            homeScore: scorePair.homeScore,
            awayScore: scorePair.awayScore,
            scoreSource: competitorPair
              ? ('SUMMARY_COMPETITORS' as const)
              : ('SUMMARY_BOXSCORE' as const),
          }
        : {}),
    };
  }

  private isTerminalStatusRecord(value: unknown): boolean {
    const record = this.asRecord(value);
    if (!record) return false;
    const statusType = this.asRecord(record.type);
    const name = this.toStringValue(statusType?.name ?? record.name) ?? '';
    const state = this.toStringValue(statusType?.state ?? record.state) ?? '';
    const detail =
      this.toStringValue(
        statusType?.detail ??
          statusType?.shortDetail ??
          record.detail ??
          record.shortDetail,
      ) ?? '';
    const abbreviation = this.toStringValue(statusType?.abbreviation) ?? '';
    const all = `${name} ${state} ${detail} ${abbreviation}`.toUpperCase();
    if (/CANCEL|POSTPON|ABANDON|VOID|NO[_ ]?CONTEST/.test(all)) return false;
    return Boolean(
      statusType?.completed === true ||
      record.completed === true ||
      /(^|_)FINAL($|_)|FULL[_ ]?TIME|FINISHED|COMPLETED/.test(
        name.toUpperCase(),
      ) ||
      ['post', 'final', 'complete', 'completed', 'finished'].includes(
        state.toLowerCase(),
      ) ||
      ['FT', 'AET', 'PEN'].includes(abbreviation.toUpperCase()) ||
      /\bFT\b|AFTER EXTRA TIME|AFTER PENALTIES/.test(all),
    );
  }

  private validScore(value: unknown): number | undefined {
    const number = this.toNumber(value);
    return number !== undefined && Number.isInteger(number) && number >= 0
      ? number
      : undefined;
  }

  private scorePair(
    homeValue: unknown,
    awayValue: unknown,
  ): EspnScorePair | undefined {
    const homeScore = this.validScore(homeValue);
    const awayScore = this.validScore(awayValue);
    if (homeScore === undefined || awayScore === undefined) return undefined;
    return { homeScore, awayScore };
  }

  /**
   * Rewrite only explicit ESPN home/away competitor score fields from a
   * verified final score pair. The embedded Summary itself remains untouched
   * so the original provider response is retained as source evidence.
   */
  private normalizeCompetitorScoreArray(
    value: unknown,
    scores: EspnScorePair,
  ): unknown[] | undefined {
    if (!Array.isArray(value)) return undefined;
    let changed = false;
    const normalized = (value as unknown[]).map((item: unknown) => {
      const competitor = this.asRecord(item);
      if (!competitor) return item;
      const homeAway = (
        this.toStringValue(competitor.homeAway) ?? ''
      ).toLowerCase();
      const isHome = homeAway === 'home' || competitor.isHome === true;
      const isAway = homeAway === 'away' || competitor.isAway === true;
      if (!isHome && !isAway) return item;
      const score = isHome ? scores.homeScore : scores.awayScore;
      const existingScore = this.validScore(competitor.score);
      if (existingScore === score) return item;
      changed = true;
      return {
        ...competitor,
        // ESPN competitor scores are usually strings. Preserve the existing
        // field's primitive representation where possible.
        score: typeof competitor.score === 'string' ? String(score) : score,
      };
    });
    return changed ? normalized : undefined;
  }

  /** Returns field-level updates; never replaces the whole payload document. */
  private buildPayloadScoreNormalizationUpdates(
    payloadValue: unknown,
    scores: EspnScorePair,
  ): Record<string, unknown> {
    const payload = this.asRecord(payloadValue) ?? {};
    const updates: Record<string, unknown> = {};
    const rootCompetitions = this.normalizeCompetitionArrayScores(
      payload.competitions,
      scores,
    );
    if (rootCompetitions) updates['payload.competitions'] = rootCompetitions;

    for (const [homeKey, awayKey] of [
      ['homeScore', 'awayScore'],
      ['homeTeamScore', 'awayTeamScore'],
    ] as const) {
      if (
        Object.prototype.hasOwnProperty.call(payload, homeKey) ||
        Object.prototype.hasOwnProperty.call(payload, awayKey)
      ) {
        const homeCurrent = this.validScore(payload[homeKey]);
        const awayCurrent = this.validScore(payload[awayKey]);
        if (
          homeCurrent !== scores.homeScore ||
          awayCurrent !== scores.awayScore
        ) {
          updates[`payload.${homeKey}`] =
            typeof payload[homeKey] === 'string'
              ? String(scores.homeScore)
              : scores.homeScore;
          updates[`payload.${awayKey}`] =
            typeof payload[awayKey] === 'string'
              ? String(scores.awayScore)
              : scores.awayScore;
        }
      }
    }

    const rootCompetitors = this.normalizeCompetitorScoreArray(
      payload.competitors,
      scores,
    );
    if (rootCompetitors) updates['payload.competitors'] = rootCompetitors;

    const header = this.asRecord(payload.header) ?? {};
    const headerCompetitions = this.normalizeCompetitionArrayScores(
      header.competitions,
      scores,
    );
    if (headerCompetitions)
      updates['payload.header.competitions'] = headerCompetitions;

    const event = this.asRecord(payload.event) ?? {};
    const eventCompetitions = this.normalizeCompetitionArrayScores(
      event.competitions,
      scores,
    );
    if (eventCompetitions)
      updates['payload.event.competitions'] = eventCompetitions;
    return updates;
  }

  private normalizeCompetitionArrayScores(
    value: unknown,
    scores: EspnScorePair,
  ): unknown[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const values: unknown[] = value;
    let changed = false;
    const normalized = values.map((item) => {
      const competition = this.asRecord(item);
      if (!competition) return item;
      const competitors = this.normalizeCompetitorScoreArray(
        competition.competitors,
        scores,
      );
      if (!competitors) return item;
      changed = true;
      return { ...competition, competitors };
    });
    return changed ? normalized : undefined;
  }

  private extractCompetitorScorePair(
    competitionValue: unknown,
  ): EspnScorePair | undefined {
    const competition = this.asRecord(competitionValue);
    if (!competition) return undefined;
    const competitors: unknown[] = Array.isArray(competition.competitors)
      ? (competition.competitors as unknown[])
      : [];
    const home = competitors.find((item) => {
      const record = this.asRecord(item);
      return record?.homeAway === 'home' || record?.isHome === true;
    });
    const away = competitors.find((item) => {
      const record = this.asRecord(item);
      return record?.homeAway === 'away' || record?.isAway === true;
    });
    const homeRecord = this.asRecord(home);
    const awayRecord = this.asRecord(away);
    return this.scorePair(homeRecord?.score, awayRecord?.score);
  }

  private extractSummaryBoxscoreScorePair(
    summaryValue: unknown,
    competitionValue: unknown,
    teamIds: { homeTeamId?: unknown; awayTeamId?: unknown } = {},
  ): EspnScorePair | undefined {
    const summary = this.asRecord(summaryValue);
    const boxscore = this.asRecord(summary?.boxscore);
    const teams: unknown[] = Array.isArray(boxscore?.teams)
      ? (boxscore.teams as unknown[])
      : [];
    if (teams.length < 2) return undefined;

    const competition = this.asRecord(competitionValue);
    const competitors: unknown[] = Array.isArray(competition?.competitors)
      ? (competition.competitors as unknown[])
      : [];
    const homeCompetitor = competitors.find((item) => {
      const competitor = this.asRecord(item);
      return competitor?.homeAway === 'home' || competitor?.isHome === true;
    });
    const awayCompetitor = competitors.find((item) => {
      const competitor = this.asRecord(item);
      return competitor?.homeAway === 'away' || competitor?.isAway === true;
    });
    const teamIdsOf = (value: unknown): string[] => {
      const record = this.asRecord(value);
      const nested = this.asRecord(record?.team);
      return [record?.id, record?.teamId, nested?.id, nested?.teamId]
        .map((id) => this.toStringValue(id))
        .filter((id): id is string => id !== undefined);
    };
    const expectedHomeIds = new Set(
      [teamIds.homeTeamId, ...teamIdsOf(homeCompetitor)]
        .map((id) => this.toStringValue(id))
        .filter((id): id is string => id !== undefined),
    );
    const expectedAwayIds = new Set(
      [teamIds.awayTeamId, ...teamIdsOf(awayCompetitor)]
        .map((id) => this.toStringValue(id))
        .filter((id): id is string => id !== undefined),
    );

    const goalTotal = (teamValue: unknown): number | undefined => {
      const teamRecord = this.asRecord(teamValue);
      if (!teamRecord) return undefined;
      const statistics: unknown[] = Array.isArray(teamRecord.statistics)
        ? (teamRecord.statistics as unknown[])
        : [];
      for (const rawStat of statistics) {
        const stat = this.asRecord(rawStat);
        if (!stat) continue;
        const normalizedName = (
          this.toStringValue(
            stat.name ?? stat.abbreviation ?? stat.displayName,
          ) ?? ''
        )
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '');
        if (normalizedName !== 'totalgoals') continue;
        const score =
          this.validScore(stat.value) ?? this.validScore(stat.displayValue);
        if (score !== undefined) return score;
      }
      const nestedTeam = this.asRecord(teamRecord.team);
      return this.validScore(teamRecord.score ?? nestedTeam?.score);
    };

    let homeTeam: Record<string, unknown> | undefined;
    let awayTeam: Record<string, unknown> | undefined;
    for (const item of teams) {
      const entry = this.asRecord(item);
      if (!entry) continue;
      const nestedTeam = this.asRecord(entry.team);
      const homeAway = (
        this.toStringValue(entry.homeAway ?? nestedTeam?.homeAway) ?? ''
      ).toLowerCase();
      const ids = teamIdsOf(entry);
      if (
        homeAway === 'home' ||
        entry.isHome === true ||
        ids.some((id) => expectedHomeIds.has(id))
      )
        homeTeam = entry;
      if (
        homeAway === 'away' ||
        entry.isAway === true ||
        ids.some((id) => expectedAwayIds.has(id))
      )
        awayTeam = entry;
    }

    return this.scorePair(goalTotal(homeTeam), goalTotal(awayTeam));
  }

  private extractStoredPayloadFinalResult(
    fixtureValue: unknown,
    teamIds: { homeTeamId?: unknown; awayTeamId?: unknown } = {},
  ): EspnSummaryFinalResult | undefined {
    const fixture = this.asRecord(fixtureValue);
    const payload = this.asRecord(fixture?.payload);
    return this.extractSummaryFinalResult(payload, teamIds);
  }

  private isCompletedFixtureRecord(fixtureValue: unknown): boolean {
    const fixture = this.asRecord(fixtureValue);
    if (!fixture) return false;
    const text = [
      fixture.status,
      fixture.statusDetail,
      fixture.statusShortDetail,
    ]
      .map((value) => this.toStringValue(value) ?? '')
      .join(' ')
      .toUpperCase();
    if (/CANCEL|POSTPON|ABANDON|VOID|NO[_ ]?CONTEST/.test(text)) return false;
    return (
      fixture.completed === true ||
      this.isTerminalStatusRecord({
        name: fixture.status,
        detail: fixture.statusDetail,
        shortDetail: fixture.statusShortDetail,
        completed: fixture.completed,
      })
    );
  }

  private resolveStoredFixtureResult(
    fixtureValue: unknown,
  ): StoredFixtureResultResolution {
    const fixture = this.asRecord(fixtureValue);
    if (!fixture) return { shouldRefreshSummary: false };
    const teamIds = {
      homeTeamId: fixture.homeTeamId,
      awayTeamId: fixture.awayTeamId,
    };
    const summary = this.asRecord(fixture.payload)?.summary;
    const payloadRecord = this.asRecord(fixture.payload) ?? {};
    const summaryResult = this.extractSummaryFinalResult(summary, teamIds);
    const payloadResult = this.extractStoredPayloadFinalResult(
      fixture,
      teamIds,
    );
    const rootPair = this.scorePair(fixture.homeScore, fixture.awayScore);

    const isFinal =
      this.isCompletedFixtureRecord(fixture) ||
      Boolean(summaryResult) ||
      Boolean(payloadResult);
    if (!isFinal) return { shouldRefreshSummary: false };

    if (
      summaryResult?.homeScore !== undefined &&
      summaryResult.awayScore !== undefined
    ) {
      return {
        homeScore: summaryResult.homeScore,
        awayScore: summaryResult.awayScore,
        source: summaryResult.scoreSource ?? 'SUMMARY_COMPETITORS',
        shouldRefreshSummary: false,
      };
    }

    if (
      summaryResult?.scoreConflict === true ||
      payloadRecord.resultScoreUnresolved === true
    ) {
      return { conflict: true, shouldRefreshSummary: true };
    }

    const payloadPair =
      payloadResult &&
      payloadResult.homeScore !== undefined &&
      payloadResult.awayScore !== undefined
        ? this.scorePair(payloadResult.homeScore, payloadResult.awayScore)
        : undefined;
    const summaryHasScores = Boolean(
      summaryResult &&
      summaryResult.homeScore !== undefined &&
      summaryResult.awayScore !== undefined,
    );
    // Historical 0-0 rows deserve an explicit Summary verification when there
    // is no complete Summary score pair. Root and fixture payload are usually
    // derived from the same scoreboard response, so their agreement alone is
    // not enough to rule out a stale/defaulted 0-0 result.
    const suspiciousZeroZero =
      !summaryHasScores &&
      Boolean(
        (rootPair?.homeScore === 0 && rootPair.awayScore === 0) ||
        (payloadPair?.homeScore === 0 && payloadPair.awayScore === 0),
      );

    if (payloadPair && rootPair) {
      if (
        payloadPair.homeScore !== rootPair.homeScore ||
        payloadPair.awayScore !== rootPair.awayScore
      ) {
        // Do not choose the numerically larger score. The two stored ESPN
        // representations disagree, so ask Summary to arbitrate the pair.
        return {
          homeScore: rootPair.homeScore,
          awayScore: rootPair.awayScore,
          source: 'ROOT_FIXTURE',
          conflict: true,
          shouldRefreshSummary: true,
        };
      }
      if (suspiciousZeroZero) {
        return { conflict: true, shouldRefreshSummary: true };
      }
      return {
        homeScore: payloadPair.homeScore,
        awayScore: payloadPair.awayScore,
        source: 'FIXTURE_PAYLOAD',
        shouldRefreshSummary: false,
      };
    }

    if (payloadPair) {
      if (suspiciousZeroZero) {
        return { conflict: true, shouldRefreshSummary: true };
      }
      return {
        homeScore: payloadPair.homeScore,
        awayScore: payloadPair.awayScore,
        source: 'FIXTURE_PAYLOAD',
        shouldRefreshSummary: false,
      };
    }

    if (rootPair) {
      if (suspiciousZeroZero) {
        return { conflict: true, shouldRefreshSummary: true };
      }
      return {
        homeScore: rootPair.homeScore,
        awayScore: rootPair.awayScore,
        source: 'ROOT_FIXTURE',
        shouldRefreshSummary: false,
      };
    }

    return {
      conflict: true,
      shouldRefreshSummary: true,
    };
  }

  /**
   * One-time, resumable-style historical reconciliation. The scan is idempotent:
   * score pairs are only changed when a higher-quality complete source exists,
   * and unresolved finished fixtures are put back onto the durable Summary queue.
   */
  async repairHistoricalFixtureResults(): Promise<{
    skipped: boolean;
    scanned: number;
    repaired: number;
    summaryRefreshQueued: number;
    conflicts: number;
  }> {
    const stateKey = 'MAINTENANCE:ESPN_FIXTURE_RESULT_RECONCILIATION_V3';
    const existingState = await this.sportsSyncStateModel
      .findOne({ stateKey })
      .select({ status: 1 })
      .lean()
      .exec();
    if (existingState?.status === SportsSyncStateStatus.SUCCESS) {
      return {
        skipped: true,
        scanned: 0,
        repaired: 0,
        summaryRefreshQueued: 0,
        conflicts: 0,
      };
    }

    const startedAt = new Date();
    await this.sportsSyncStateModel
      .updateOne(
        { stateKey },
        {
          $set: {
            stateKey,
            kind: SportsSyncStateKind.QUEUE,
            status: SportsSyncStateStatus.PROCESSING,
            trackingMode: 'HISTORY',
            fixtureGranularity: 'MONTH',
            jobType: 'FIXTURE_RESULT_RECONCILIATION',
            lastStartedAt: startedAt,
            consecutiveFailures: 0,
          },
          $setOnInsert: { units: [] },
          $unset: { lastError: 1 },
        },
        { upsert: true },
      )
      .exec();

    const cursor = this.espnFixtureModel
      .find({})
      .select({
        eventId: 1,
        leagueId: 1,
        season: 1,
        fixtureDate: 1,
        status: 1,
        statusDetail: 1,
        statusShortDetail: 1,
        completed: 1,
        live: 1,
        homeScore: 1,
        awayScore: 1,
        homeTeamId: 1,
        awayTeamId: 1,
        completedAt: 1,
        collectedAt: 1,
        'payload.header': 1,
        'payload.competitions': 1,
        'payload.competitors': 1,
        'payload.status': 1,
        'payload.event': 1,
        'payload.summary.header': 1,
        'payload.summary.competitions': 1,
        'payload.summary.status': 1,
        'payload.summary.event': 1,
        'payload.summary.boxscore.teams': 1,
        'payload.resultScoreUnresolved': 1,
      })
      .lean()
      .cursor({ batchSize: 50 });

    let scanned = 0;
    let repaired = 0;
    let summaryRefreshQueued = 0;
    let conflicts = 0;
    const operations: Parameters<Model<EspnFixtureDocument>['bulkWrite']>[0] =
      [];
    const summaryRequests: Array<{
      eventId: string;
      leagueId: string;
      season: number;
    }> = [];

    const flushWrites = async (): Promise<void> => {
      if (operations.length === 0) return;
      const chunk = operations.splice(0, operations.length);
      const writeResult = await this.espnFixtureModel.bulkWrite(chunk, {
        ordered: false,
      });
      repaired +=
        typeof writeResult.modifiedCount === 'number'
          ? writeResult.modifiedCount
          : 0;
    };

    // Historical fixtures may belong to seasons no longer listed as active.
    // Queue their Summary refresh directly through the existing durable queue;
    // the worker still enforces lifecycle confirmation and the retry protocol.
    const queueHistoricalSummaryRequests = async (): Promise<void> => {
      const requests = summaryRequests.splice(0, summaryRequests.length);
      for (const request of requests) {
        const triggerEventId = `HISTORICAL_RESULT_REPAIR:${request.eventId}`;
        const jobParams = {
          jobType: EspnQueueJobType.SUMMARY_REFRESH,
          leagueId: request.leagueId,
          eventId: request.eventId,
          season: request.season,
          triggerEventId,
        };
        if (await this.espnQueueService.hasJob(jobParams)) continue;
        await this.espnQueueService.addSummaryRefreshJob({
          leagueId: request.leagueId,
          eventId: request.eventId,
          season: request.season,
          priority: 4,
          scheduledFor: new Date(),
          triggerEventId,
        });
        summaryRefreshQueued += 1;
      }
    };

    try {
      for await (const raw of cursor) {
        const fixture = raw as unknown as Record<string, unknown>;
        scanned += 1;
        const eventId = this.toStringValue(fixture.eventId);
        const leagueId = this.normalizeLeagueId(
          this.toStringValue(fixture.leagueId),
        );
        const season = this.toNumber(fixture.season);
        if (!eventId || !leagueId) continue;

        // The persisted fixture-feed lifecycle snapshot is the only authority
        // for deciding whether result reconciliation is allowed.
        if (!isFixtureRefreshConfirmedFinished(fixture)) continue;

        const resolution = this.resolveStoredFixtureResult(fixture);
        const snapshotCollectedAt = fixture.collectedAt;
        const snapshotFilter: Record<string, unknown> = {
          eventId,
          leagueId,
          ...(snapshotCollectedAt !== undefined && snapshotCollectedAt !== null
            ? { collectedAt: snapshotCollectedAt }
            : {}),
        };
        const isFinal = this.isCompletedFixtureRecord(fixture);
        if (resolution.conflict) conflicts += 1;
        if (
          resolution.shouldRefreshSummary &&
          season !== undefined &&
          Number.isInteger(season)
        ) {
          summaryRequests.push({ eventId, leagueId, season });
        }

        if (
          resolution.homeScore === undefined ||
          resolution.awayScore === undefined ||
          resolution.conflict
        ) {
          if (
            isFinal &&
            (resolution.conflict || resolution.shouldRefreshSummary)
          ) {
            const rootPair = this.scorePair(
              fixture.homeScore,
              fixture.awayScore,
            );
            const payloadRecord = this.asRecord(fixture.payload) ?? {};
            if (rootPair || payloadRecord.resultScoreUnresolved !== true) {
              operations.push({
                updateOne: {
                  filter: snapshotFilter,
                  update: {
                    $set: {
                      'payload.resultScoreUnresolved': true,
                      collectedAt: new Date(),
                    },
                    $unset: { homeScore: 1, awayScore: 1 },
                  },
                  upsert: false,
                },
              });
            }
          }
          if (operations.length >= this.mongoBulkChunkSize) await flushWrites();
          if (summaryRequests.length >= 25) {
            await flushWrites();
            await queueHistoricalSummaryRequests();
          }
          continue;
        }

        const rootPair = this.scorePair(fixture.homeScore, fixture.awayScore);
        const storedPayload = this.asRecord(fixture.payload) ?? {};
        const hasUnresolvedMarker =
          storedPayload.resultScoreUnresolved === true;
        const shouldUpdateScores =
          hasUnresolvedMarker ||
          !rootPair ||
          rootPair.homeScore !== resolution.homeScore ||
          rootPair.awayScore !== resolution.awayScore;
        const payloadScoreUpdates = this.buildPayloadScoreNormalizationUpdates(
          fixture.payload,
          { homeScore: resolution.homeScore, awayScore: resolution.awayScore },
        );
        const shouldUpdatePayloadScores =
          Object.keys(payloadScoreUpdates).length > 0;

        if (shouldUpdateScores || shouldUpdatePayloadScores) {
          const collectedAt = new Date();
          const set: Record<string, unknown> = {
            collectedAt,
            ...payloadScoreUpdates,
          };
          if (shouldUpdateScores) {
            set.homeScore = resolution.homeScore;
            set.awayScore = resolution.awayScore;
          }
          operations.push({
            updateOne: {
              filter: snapshotFilter,
              update: {
                $set: set,
                $unset: { 'payload.resultScoreUnresolved': 1 },
              },
              upsert: false,
            },
          });
        }

        if (operations.length >= this.mongoBulkChunkSize) await flushWrites();
        if (summaryRequests.length >= 25) {
          await queueHistoricalSummaryRequests();
        }
      }

      await flushWrites();
      if (summaryRequests.length > 0) {
        await queueHistoricalSummaryRequests();
      }
      await this.sportsSyncStateModel
        .updateOne(
          { stateKey },
          {
            $set: {
              status: SportsSyncStateStatus.SUCCESS,
              lastSuccessfulAt: new Date(),
              consecutiveFailures: 0,
            },
            $unset: { lastError: 1 },
          },
        )
        .exec();

      this.logger.log(
        `Historical ESPN result reconciliation completed: scanned=${scanned}, repaired=${repaired}, summaryRefreshQueued=${summaryRefreshQueued}, conflicts=${conflicts}`,
      );
      return {
        skipped: false,
        scanned,
        repaired,
        summaryRefreshQueued,
        conflicts,
      };
    } catch (error) {
      await this.sportsSyncStateModel
        .updateOne(
          { stateKey },
          {
            $set: {
              status: SportsSyncStateStatus.FAILED,
              lastError: error instanceof Error ? error.message : String(error),
              consecutiveFailures: 1,
            },
          },
        )
        .exec();
      throw error;
    } finally {
      await cursor.close();
    }
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
    summaries: Array<{ leagueId: string; eventId: string; summary: unknown }>,
  ): Promise<{ requested: number; matched: number; modified: number }> {
    if (summaries.length === 0)
      return { requested: 0, matched: 0, modified: 0 };

    const uniqueSummaries = new Map<
      string,
      { leagueId: string; eventId: string; summary: unknown }
    >();
    for (const item of summaries) {
      const eventId = String(item.eventId ?? '').trim();
      if (!eventId) continue;
      uniqueSummaries.set(eventId, {
        leagueId: this.normalizeLeagueId(item.leagueId),
        eventId,
        summary: item.summary,
      });
    }
    if (uniqueSummaries.size === 0)
      return { requested: summaries.length, matched: 0, modified: 0 };

    const existingFixtures = await this.espnFixtureModel
      .find({ eventId: { $in: [...uniqueSummaries.keys()] } })
      .select({
        eventId: 1,
        leagueId: 1,
        payload: 1,
        homeTeamId: 1,
        awayTeamId: 1,
        homeScore: 1,
        awayScore: 1,
        status: 1,
        statusDetail: 1,
        statusShortDetail: 1,
        completed: 1,
        live: 1,
      })
      .lean()
      .exec();
    const existingByEventId = new Map<string, Record<string, unknown>>();
    for (const fixture of existingFixtures as unknown as Array<
      Record<string, unknown>
    >) {
      const id = this.toStringValue(fixture.eventId) ?? '';
      if (id) existingByEventId.set(id, fixture);
    }

    const collectedAt = new Date();
    const operations: Parameters<Model<EspnFixtureDocument>['bulkWrite']>[0] =
      [];
    const changedSummaries: Array<{
      leagueId: string;
      eventId: string;
      summary: unknown;
      homeTeamId?: unknown;
      awayTeamId?: unknown;
      homeScore?: unknown;
      awayScore?: unknown;
      resultScoreUnresolved?: boolean;
      fixturePayload?: unknown;
      status?: unknown;
      statusDetail?: unknown;
      statusShortDetail?: unknown;
      completed?: unknown;
      live?: unknown;
    }> = [];
    const persistedSummaries: Array<{
      leagueId: string;
      eventId: string;
      summary: unknown;
      homeTeamId?: unknown;
      awayTeamId?: unknown;
      homeScore?: unknown;
      awayScore?: unknown;
      resultScoreUnresolved?: boolean;
      fixturePayload?: unknown;
      status?: unknown;
      statusDetail?: unknown;
      statusShortDetail?: unknown;
      completed?: unknown;
      live?: unknown;
    }> = [];

    for (const item of uniqueSummaries.values()) {
      const existing = existingByEventId.get(item.eventId);
      if (!existing) continue;
      const payload = this.asRecord(existing.payload) ?? {};
      const oldSummary = payload.summary;
      const mergedSummary = this.mergeSummaryPreservingFinalResult(
        oldSummary,
        item.summary,
      );
      const hash = this.summaryContentHash(mergedSummary);
      const oldHash = this.toStringValue(payload.summaryContentHash);
      const unchanged =
        oldHash === hash ||
        (!oldHash &&
          this.hasUsableSummaryForHash(oldSummary) &&
          this.summaryContentHash(oldSummary) === hash);
      const set: Record<string, unknown> = {
        leagueId: item.leagueId,
        'payload.summaryCollectedAt': collectedAt,
        'payload.summaryContentHash': hash,
        collectedAt,
      };
      if (!unchanged) {
        set['payload.summary'] = mergedSummary;
        changedSummaries.push({
          ...item,
          summary: mergedSummary,
          homeTeamId: existing.homeTeamId,
          awayTeamId: existing.awayTeamId,
          homeScore: existing.homeScore,
          awayScore: existing.awayScore,
          resultScoreUnresolved: payload.resultScoreUnresolved === true,
          fixturePayload: payload,
          status: existing.status,
          statusDetail: existing.statusDetail,
          statusShortDetail: existing.statusShortDetail,
          completed: existing.completed,
          live: existing.live,
        });
      }
      persistedSummaries.push({
        ...item,
        summary: mergedSummary,
        homeTeamId: existing.homeTeamId,
        awayTeamId: existing.awayTeamId,
        homeScore: existing.homeScore,
        awayScore: existing.awayScore,
        resultScoreUnresolved: payload.resultScoreUnresolved === true,
        fixturePayload: payload,
        status: existing.status,
        statusDetail: existing.statusDetail,
        statusShortDetail: existing.statusShortDetail,
        completed: existing.completed,
        live: existing.live,
      });
      operations.push({
        updateOne: {
          filter: { eventId: item.eventId, leagueId: item.leagueId },
          update: { $set: set },
          upsert: false,
        },
      });
    }

    if (operations.length === 0) {
      return { requested: summaries.length, matched: 0, modified: 0 };
    }
    let matched = 0;
    let modified = 0;
    for (const chunk of this.chunkOperations(
      operations,
      this.mongoBulkChunkSize,
    )) {
      const result = await this.espnFixtureModel.bulkWrite(chunk, {
        ordered: false,
      });
      matched +=
        typeof result.matchedCount === 'number' ? result.matchedCount : 0;
      modified +=
        typeof result.modifiedCount === 'number' ? result.modifiedCount : 0;
    }
    if (matched !== operations.length) {
      throw new Error(
        `ESPN summary bulk persistence matched ${matched} of ${operations.length} requested fixtures`,
      );
    }

    if (changedSummaries.length > 0) {
      await this.persistSummaryNewsBatch(changedSummaries);
    }

    // Reconcile canonical result fields for every persisted Summary, including
    // unchanged content whose root fixture status or score may still be stale.
    const reconciliations = await Promise.all(
      persistedSummaries.map(async (item) => ({
        item,
        result: await this.reconcileFixtureResultFromSummary(item),
      })),
    );
    const settlementItems = new Map<
      string,
      { leagueId: string; eventId: string }
    >();
    for (const item of changedSummaries) {
      settlementItems.set(item.eventId, {
        leagueId: item.leagueId,
        eventId: item.eventId,
      });
    }
    for (const entry of reconciliations) {
      if (entry.result?.rootChanged) {
        settlementItems.set(entry.item.eventId, {
          leagueId: entry.item.leagueId,
          eventId: entry.item.eventId,
        });
      }
    }

    for (const leagueId of new Set([
      ...changedSummaries.map((item) => item.leagueId),
      ...reconciliations
        .filter((entry) => entry.result?.rootChanged)
        .map((entry) => entry.item.leagueId),
    ])) {
      void this.scheduleDerivedRefreshForLeague(leagueId);
    }

    // Unchanged Summary refreshes do not trigger settlement unless result
    // reconciliation actually changed the canonical fixture fields.
    await Promise.all(
      [...settlementItems.values()].map(async (item) => {
        try {
          await this.settlementTriggerService.onSummaryUpdated(
            item.eventId,
            item.leagueId,
          );
        } catch (error) {
          this.logger.warn(
            `Could not enqueue settlement for Summary ${item.eventId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );

    return { requested: operations.length, matched, modified };
  }

  private summaryContentHash(value: unknown): string {
    const canonicalize = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map(canonicalize);
      if (input !== null && typeof input === 'object') {
        const record = input as Record<string, unknown>;
        return Object.fromEntries(
          Object.keys(record)
            .sort()
            .map((key) => [key, canonicalize(record[key])]),
        );
      }
      return input;
    };
    return createHash('sha256')
      .update(JSON.stringify(canonicalize(value)) ?? 'null')
      .digest('hex');
  }

  private hasUsableSummaryForHash(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }

    // Keep this list aligned with SportsSyncStateService's Mongo expression.
    // A non-empty object alone is not enough: ESPN can return an envelope with
    // empty sections, which must not be recorded as a collected Summary.
    const knownSections = [
      'header', 'event', 'competitions', 'boxscore', 'plays', 'leaders',
      'team', 'teams', 'rosters', 'roster', 'injuries', 'standings', 'odds',
      'pickcenter', 'news', 'videos', 'articles', 'gameInfo', 'format',
      'broadcasts', 'predictor', 'againstTheSpread', 'winprobability',
      'drives', 'scoringPlays', 'statistics', 'headToHead', 'venue',
      'weather', 'rankings', 'situation', 'commentary', 'recent', 'previews',
    ];
    const summary = value as Record<string, unknown>;

    return knownSections.some((key) => {
      if (!(key in summary)) return false;
      const section = summary[key];
      if (section === null || section === undefined) return false;
      if (typeof section === 'string') return section.trim().length > 0;
      if (Array.isArray(section)) return section.length > 0;
      if (typeof section === 'object') return Object.keys(section).length > 0;
      return typeof section === 'boolean' || typeof section === 'number';
    });
  }

  /**
   * Trigger summary-derived data refreshes for the currently active season.
   * The refreshers coalesce requests and run in the background; their failures
   * cannot fail fixture or Summary persistence or delay the startup barrier.
   */
  private async scheduleDerivedRefreshForLeague(
    leagueIdValue: string,
  ): Promise<void> {
    const leagueId = this.normalizeLeagueId(leagueIdValue);
    if (!leagueId) return;

    try {
      const activeCompetition =
        await this.activeCompetitionService.getByCompetitionId(leagueId);
      let season =
        typeof activeCompetition?.season === 'number'
          ? activeCompetition.season
          : undefined;

      if (season === undefined) {
        const latestCompleted = await this.espnFixtureModel
          .findOne({
            leagueId,
            completed: true,
            'payload.summary': { $type: 'object' },
          })
          .sort({ fixtureDate: -1 })
          .select({ season: 1 })
          .lean()
          .exec();
        season =
          typeof latestCompleted?.season === 'number'
            ? latestCompleted.season
            : undefined;
      }
      if (season === undefined) return;

      // The persistent queue rebuilds standings from stored Summary snapshots
      // or completed fixture results, including before a Summary exists.
      this.espnStandingsService.scheduleRefresh({ leagueId, season });
    } catch (error) {
      this.logger.warn(
        `Unable to schedule standings refresh for ${leagueId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
    const competitionRecord = this.asRecord(competition);
    const eventRecord = this.asRecord(event);
    const statusRecord = this.asRecord(
      competitionRecord?.status ?? eventRecord?.status,
    );
    const statusType = this.asRecord(statusRecord?.type);

    const name =
      this.toStringValue(statusType?.name ?? statusRecord?.name) ?? '';
    const state =
      this.toStringValue(statusType?.state ?? statusRecord?.state) ?? '';
    const detail =
      this.toStringValue(
        statusType?.detail ?? statusType?.description ?? statusRecord?.detail,
      ) ?? '';
    const shortDetail =
      this.toStringValue(
        statusType?.shortDetail ?? statusRecord?.shortDetail,
      ) ?? '';
    const abbreviation = this.toStringValue(statusType?.abbreviation) ?? '';
    const statusText =
      `${name} ${state} ${detail} ${shortDetail} ${abbreviation}`
        .replace(/[_-]+/g, ' ')
        .toUpperCase();

    if (
      /CANCEL|POSTPON|ABANDON|SUSPEND|INTERRUPT|VOID|NO\s*CONTEST/.test(
        statusText,
      )
    ) {
      return false;
    }
    if (statusType?.completed === true || statusRecord?.completed === true) {
      return true;
    }

    return (
      ['post', 'final', 'completed', 'complete', 'finished'].includes(
        state.trim().toLowerCase(),
      ) ||
      ['FT', 'AET', 'PEN'].includes(abbreviation.trim().toUpperCase()) ||
      /STATUS FINAL|FULL TIME|FINISHED|COMPLETED|AFTER EXTRA TIME|AFTER PENALTIES|\bFT\b|\bAET\b|\bPEN\b/.test(
        statusText,
      )
    );
  }

  /**
   * Returns true only while ESPN reports the event as in progress.
   * Completed and post-match states must not be treated as live.
   */
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

  /** Returns midnight UTC for date-window queries. */
  private getUtcStartOfDay(date: Date): Date {
    const result = new Date(date);
    result.setUTCHours(0, 0, 0, 0);
    return result;
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
  private chunkOperations<T>(operations: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let index = 0; index < operations.length; index += size) {
      chunks.push(operations.slice(index, index + size));
    }

    return chunks;
  }

  private async bulkWriteFixtureChunks(
    operations: Parameters<Model<EspnFixtureDocument>['bulkWrite']>[0],
  ): Promise<void> {
    for (const chunk of this.chunkOperations(
      operations,
      this.mongoBulkChunkSize,
    )) {
      await this.espnFixtureModel.bulkWrite(chunk, {
        ordered: false,
      });
    }
  }

  private async bulkWriteTeamChunks(
    operations: Parameters<Model<EspnTeamDocument>['bulkWrite']>[0],
  ): Promise<void> {
    for (const chunk of this.chunkOperations(
      operations,
      this.mongoBulkChunkSize,
    )) {
      await this.espnTeamModel.bulkWrite(chunk, {
        ordered: false,
      });
    }
  }

  private toUtcDateOnly(value: Date): string {
    const date = new Date(value);

    const year = date.getUTCFullYear();

    const month = String(date.getUTCMonth() + 1).padStart(2, '0');

    const day = String(date.getUTCDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  }
}

