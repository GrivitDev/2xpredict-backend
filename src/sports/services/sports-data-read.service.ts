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

import { SportsDataFilter } from '../interfaces/sports-data-filter.interface';

import {
  SportsPredictionData,
  SportsSettlementData,
} from '../interfaces/prediction-data.interface';

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

export interface PaginatedResult<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export type FootballNewsFeedKind = 'NEWS' | 'VIDEO';

export interface FootballNewsFeedItem {
  kind: FootballNewsFeedKind;
  eventId: string;
  leagueId: string;
  fixtureDate: string;
  homeTeamId?: string;
  awayTeamId?: string;
  publishedAt?: string;
  payload: Record<string, unknown>;
}

const FOOTBALL_NEWS_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

interface FootballNewsPublicationWindow {
  start: Date;
  end: Date;
}

function createFootballNewsPublicationWindow(
  now = new Date(),
): FootballNewsPublicationWindow {
  return {
    start: new Date(now.getTime() - FOOTBALL_NEWS_LOOKBACK_MS),
    end: now,
  };
}

function parseDateValue(value: unknown): Date | undefined {
  if (
    !(value instanceof Date) &&
    typeof value !== 'string' &&
    typeof value !== 'number'
  ) {
    return undefined;
  }

  if (typeof value === 'string' && !value.trim()) return undefined;

  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
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
  // PUBLIC / APPLICATION SPORTS DATA
  // ============================================================

  async getLive(): Promise<unknown[]> {
    return this.getLiveFixtures();
  }

  async getFixtures(filters: SportsDataFilter = {}): Promise<unknown[]> {
    return this.getUpcomingFixtures(filters);
  }

  async getResults(filters: SportsDataFilter = {}): Promise<unknown[]> {
    return this.getFinishedFixtures(filters);
  }

  async getStandings(
    competitionId: string,
    teamId?: string,
    groupId?: string,
  ): Promise<unknown> {
    return this.getLeagueTable(competitionId, teamId, groupId);
  }

  async getTeams(competitionId: string, teamId?: string): Promise<unknown[]> {
    const normalizedCompetitionId = this.normalizeCompetitionId(competitionId);

    if (!normalizedCompetitionId) {
      return [];
    }

    const competition = await this.activeCompetitionModel
      .findOne({
        $or: [
          { competitionId: normalizedCompetitionId },
          { espnLeagueSlug: normalizedCompetitionId },
        ],
      })
      .select({ _id: 0, competitionId: 1, espnLeagueSlug: 1 })
      .lean()
      .exec();

    const canonicalLeagueId = this.normalizeCompetitionId(
      competition?.espnLeagueSlug ?? normalizedCompetitionId,
    );

    const filter: Record<string, unknown> = {
      leagueId: canonicalLeagueId,
    };

    const normalizedTeamId = this.normalizeTeamId(teamId);

    if (normalizedTeamId) {
      filter.teamId = normalizedTeamId;
    }

    return this.espnTeamModel
      .find(filter)
      .sort({
        name: 1,
      })
      .lean()
      .exec();
  }

  // ============================================================
  // COMPETITIONS
  // ============================================================

  // ESPN payload shapes vary by sport and are intentionally handled dynamically.
  /* eslint-disable
    @typescript-eslint/no-unsafe-argument,
    @typescript-eslint/no-unsafe-assignment,
    @typescript-eslint/no-unsafe-member-access,
    @typescript-eslint/no-unsafe-return
  */

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

    const leagueIds = [
      ...new Set(
        competitions
          .flatMap((competition: any) => [
            String(competition.competitionId ?? '')
              .trim()
              .toLowerCase(),
            String(competition.espnLeagueSlug ?? '')
              .trim()
              .toLowerCase(),
          ])
          .filter(Boolean),
      ),
    ];

    const leagueRecords = leagueIds.length
      ? await this.espnLeagueModel
          .find({
            $or: [
              { leagueId: { $in: leagueIds } },
              { slug: { $in: leagueIds } },
            ],
          })
          .select({
            _id: 0,
            leagueId: 1,
            slug: 1,
            name: 1,
            abbreviation: 1,
            country: 1,
            'payload.logo': 1,
            'payload.logos': 1,
            'payload.crest': 1,
            'payload.badge': 1,
            'payload.emblem': 1,
            'payload.image': 1,
            'payload.images': 1,
            'payload.league': 1,
            'payload.competition': 1,
          })
          .lean()
          .exec()
      : [];

    const leagueById = new Map<string, any>();
    for (const league of leagueRecords as any[]) {
      for (const id of [league.leagueId, league.slug]) {
        const key = String(id ?? '').toLowerCase();
        if (key && !leagueById.has(key)) leagueById.set(key, league);
      }
    }

    return competitions.map((competition: any) => {
      const league =
        leagueById.get(
          String(competition.espnLeagueSlug ?? '').toLowerCase(),
        ) ??
        leagueById.get(String(competition.competitionId ?? '').toLowerCase());

      const leagueName =
        this.firstSportsText(
          competition.leagueName,
          league?.name,
          league?.payload?.displayName,
          league?.payload?.name,
          competition.displayName,
          competition.name,
        ) ?? String(competition.competitionId ?? 'League');

      const leagueLogo = this.firstSportsLogo(
        competition.leagueLogo,
        competition.logo,
        competition.logos,
        competition.espnPayload,
        league?.leagueLogo,
        league?.logo,
        league?.logos,
        league?.payload,
      );

      return {
        ...competition,
        leagueName,
        leagueLogo,
        country: this.firstSportsText(
          league?.country,
          competition.country,
          league?.payload?.country?.name,
          typeof league?.payload?.country === 'string'
            ? league.payload.country
            : undefined,
        ) ?? null,
      };
    });
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
  ): Promise<ActiveCompetitionDocument | null> {
    const normalizedCompetitionId = this.normalizeCompetitionId(competitionId);
    if (!normalizedCompetitionId) return null;

    const competition = await this.activeCompetitionModel
      .findOne({
        $or: [
          { competitionId: normalizedCompetitionId },
          { espnLeagueSlug: normalizedCompetitionId },
        ],
      })
      .lean()
      .exec();

    if (!competition) return null;

    const leagueId = this.normalizeCompetitionId(
      (competition as any).espnLeagueSlug ?? normalizedCompetitionId,
    );
    const league = await this.espnLeagueModel
      .findOne({
        $or: [{ leagueId }, { slug: leagueId }],
      })
      .select({
        _id: 0,
        leagueId: 1,
        slug: 1,
        name: 1,
        'payload.logo': 1,
        'payload.logos': 1,
        'payload.crest': 1,
        'payload.badge': 1,
        'payload.emblem': 1,
        'payload.image': 1,
        'payload.images': 1,
        'payload.league': 1,
        'payload.competition': 1,
      })
      .lean()
      .exec();

    const enriched = {
      ...competition,
      leagueName:
        this.firstSportsText(
          (competition as any).leagueName,
          league?.name,
          league?.payload?.displayName,
          league?.payload?.name,
          (competition as any).displayName,
          (competition as any).name,
        ) ?? String((competition as any).competitionId ?? 'League'),
      leagueLogo: this.firstSportsLogo(
        (competition as any).leagueLogo,
        (competition as any).logo,
        (competition as any).logos,
        (competition as any).espnPayload,
        league?.payload,
      ),
    };

    return enriched as unknown as ActiveCompetitionDocument;
  }

  // ============================================================
  // FIXTURES
  // ============================================================

  private firstSportsText(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
      }
    }
    return undefined;
  }

  /** Extract only known logo/image properties; do not walk arbitrary payload children. */
  private firstSportsLogo(...values: unknown[]): string | null {
    const visit = (
      value: unknown,
      depth = 0,
      seen = new Set<object>(),
    ): string | null => {
      if (depth > 7 || value === null || value === undefined) return null;

      if (typeof value === 'string') {
        const candidate = value.trim().replace(/^http:\/\//i, 'https://');
        if (candidate.startsWith('//')) return `https:${candidate}`;
        return /^(https?:\/\/|\/|data:image\/)/i.test(candidate)
          ? candidate
          : null;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          const found = visit(item, depth + 1, seen);
          if (found) return found;
        }
        return null;
      }

      if (typeof value !== 'object' || seen.has(value)) return null;
      seen.add(value);

      const record = value as Record<string, unknown>;
      for (const key of [
        'href',
        'url',
        'src',
        'imageUrl',
        'imageURL',
        'logoUrl',
        'logoURL',
      ]) {
        const found = visit(record[key], depth + 1, seen);
        if (found) return found;
      }

      for (const key of [
        'logo',
        'logos',
        'crest',
        'badge',
        'emblem',
        'image',
        'images',
        'icon',
        'default',
        'transparent',
        'light',
        'dark',
        'league',
        'competition',
      ]) {
        const found = visit(record[key], depth + 1, seen);
        if (found) return found;
      }

      return null;
    };

    for (const value of values) {
      const found = visit(value);
      if (found) return found;
    }
    return null;
  }

  private fixtureCompetitionPayloads(payload: any): any[] {
    return [
      ...(Array.isArray(payload?.competitions) ? payload.competitions : []),
      ...(Array.isArray(payload?.header?.competitions)
        ? payload.header.competitions
        : []),
      ...(Array.isArray(payload?.event?.competitions)
        ? payload.event.competitions
        : []),
    ].filter((item) => item && typeof item === 'object');
  }

  private fixtureCompetitor(
    fixture: any,
    side: 'home' | 'away',
  ): Record<string, any> {
    const expectedId = String(
      side === 'home' ? (fixture.homeTeamId ?? '') : (fixture.awayTeamId ?? ''),
    );
    const competitors = [
      ...this.fixtureCompetitionPayloads(fixture.payload).flatMap((item) =>
        Array.isArray(item.competitors) ? item.competitors : [],
      ),
      ...(Array.isArray(fixture.payload?.competitors)
        ? fixture.payload.competitors
        : []),
    ];

    const bySide = competitors.find(
      (item: any) =>
        String(item?.homeAway ?? item?.side ?? '').toLowerCase() === side ||
        item?.[side === 'home' ? 'isHome' : 'isAway'] === true,
    );
    const byId = expectedId
      ? competitors.find((item: any) => {
          const team = item?.team ?? item?.competitor ?? {};
          return [item?.id, item?.teamId, team?.id, team?.teamId].some(
            (id) =>
              id !== undefined && id !== null && String(id) === expectedId,
          );
        })
      : undefined;

    const selected = bySide ?? byId ?? {};
    return selected && typeof selected === 'object' ? selected : {};
  }

  private fixturePresentationStatus(fixture: any): {
    presentationStatus: string;
    presentationStatusLabel: string;
  } {
    const competitions = this.fixtureCompetitionPayloads(fixture.payload);
    const statusRecords = competitions.map(
      (competition) => competition?.status ?? {},
    );
    const statusTypes = statusRecords.map((status) => status?.type ?? {});
    const statusText = [
      fixture.status,
      fixture.statusDetail,
      fixture.statusShortDetail,
      ...statusRecords.flatMap((status) => [
        status?.name,
        status?.state,
        status?.detail,
        status?.shortDetail,
      ]),
      ...statusTypes.flatMap((type) => [
        type?.name,
        type?.state,
        type?.description,
        type?.detail,
        type?.shortDetail,
      ]),
    ]
      .filter((value) => value !== undefined && value !== null)
      .map(String)
      .join(' ')
      .toUpperCase()
      .replace(/STATUS_/g, '')
      .replace(/[\s-]+/g, '_');

    const state = String(
      statusTypes.find((type) => type?.state)?.state ??
        statusRecords.find((status) => status?.state)?.state ??
        '',
    ).toLowerCase();

    // PST is a provider status code for Postponed. It must be checked before
    // ESPN's generic state="post", which otherwise looks like a finished game.
    const postponed = /\bPST\b|POSTPON(?:ED)?|DELAYED/.test(statusText);
    const cancelled =
      /\bCANC\b|\bCNL\b|CANCELLED|CANCELED|ABANDONED|WALKOVER|NO[_ ]?CONTEST/.test(
        statusText,
      );
    const suspended = /SUSPENDED|INTERRUPTED/.test(statusText);
    const live =
      fixture.live === true ||
      state === 'in' ||
      /\bLIVE\b|IN[_ ]?PLAY|IN[_ ]?PROGRESS|HALF[_ ]?TIME|FIRST[_ ]?HALF|SECOND[_ ]?HALF|EXTRA[_ ]?TIME|PENALT/.test(
        statusText,
      );
    const finished =
      fixture.completed === true ||
      statusRecords.some((status) => status?.completed === true) ||
      statusTypes.some((type) => type?.completed === true) ||
      state === 'post' ||
      /FULL[_ ]?TIME|FINISHED|COMPLETED|AFTER[_ ]EXTRA[_ ]TIME|AFTER[_ ]PENALTIES|\bFT\b|\bFINAL\b/.test(
        statusText,
      );

    const kickoff = new Date(fixture.fixtureDate ?? '').getTime();
    const kickoffPassed = Number.isFinite(kickoff) && kickoff <= Date.now();
    const explicitlyScheduled =
      state === 'pre' ||
      /SCHEDULED|NOT[_ ]?STARTED|UPCOMING|PRE[_ ]?GAME/.test(statusText);

    // Only a real provider live signal produces LIVE. Once kickoff has passed,
    // IN_PLAY is the safe fallback until the provider supplies a live or
    // terminal state. Do not continue displaying PRE/UPCOMING after kickoff.
    const presentationStatus = postponed
      ? 'POSTPONED'
      : cancelled
        ? 'CANCELLED'
        : suspended
          ? 'SUSPENDED'
          : finished
            ? 'FINISHED'
            : live
              ? 'LIVE'
              : kickoffPassed
                ? 'IN_PLAY'
                : Number.isFinite(kickoff) || explicitlyScheduled
                  ? 'UPCOMING'
                  : 'UNKNOWN';

    const presentationStatusLabel =
      presentationStatus === 'FINISHED'
        ? 'Finished'
        : presentationStatus === 'LIVE'
          ? 'Live'
          : presentationStatus === 'IN_PLAY'
            ? 'In Play'
            : presentationStatus === 'UPCOMING'
              ? 'Upcoming'
              : presentationStatus === 'POSTPONED'
                ? 'Postponed'
                : presentationStatus === 'CANCELLED'
                  ? 'Canceled'
                  : presentationStatus === 'SUSPENDED'
                    ? 'Suspended'
                    : 'Status unavailable';

    return { presentationStatus, presentationStatusLabel };
  }

  /**
   * Enrich a fixture batch from the canonical ESPN team/league collections.
   * All lookups are batched; no per-fixture database queries are performed.
   */
  private async enrichFixturePresentation(fixtures: any[]): Promise<any[]> {
    if (!fixtures.length) return [];

    const leagueIds = [
      ...new Set(
        fixtures
          .map((fixture) =>
            String(fixture.leagueId ?? '')
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean),
      ),
    ];
    const teamIds = [
      ...new Set(
        fixtures
          .flatMap((fixture) => [fixture.homeTeamId, fixture.awayTeamId])
          .map((teamId) => String(teamId ?? '').trim())
          .filter(Boolean),
      ),
    ];

    const [teams, leagues, activeCompetitions] = await Promise.all([
      teamIds.length
        ? this.espnTeamModel
            .find({ teamId: { $in: teamIds } })
            .select({
              _id: 0,
              teamId: 1,
              leagueId: 1,
              name: 1,
              displayName: 1,
              shortDisplayName: 1,
              abbreviation: 1,
              logo: 1,
              'payload.displayName': 1,
              'payload.fullName': 1,
              'payload.name': 1,
              'payload.shortDisplayName': 1,
              'payload.logo': 1,
              'payload.logos': 1,
              'payload.crest': 1,
              'payload.badge': 1,
              'payload.emblem': 1,
              'payload.image': 1,
              'payload.images': 1,
            })
            .lean()
            .exec()
        : Promise.resolve([]),
      leagueIds.length
        ? this.espnLeagueModel
            .find({
              $or: [
                { leagueId: { $in: leagueIds } },
                { slug: { $in: leagueIds } },
              ],
            })
            .select({
              _id: 0,
              leagueId: 1,
              slug: 1,
              name: 1,
              abbreviation: 1,
              country: 1,
              'payload.logo': 1,
              'payload.logos': 1,
              'payload.crest': 1,
              'payload.badge': 1,
              'payload.emblem': 1,
              'payload.image': 1,
              'payload.images': 1,
              'payload.league': 1,
              'payload.competition': 1,
            })
            .lean()
            .exec()
        : Promise.resolve([]),
      leagueIds.length
        ? this.activeCompetitionModel
            .find({
              $or: [
                { competitionId: { $in: leagueIds } },
                { espnLeagueSlug: { $in: leagueIds } },
              ],
            })
            .select({
              _id: 0,
              competitionId: 1,
              espnLeagueSlug: 1,
              name: 1,
              'espnPayload.logo': 1,
              'espnPayload.logos': 1,
              'espnPayload.crest': 1,
              'espnPayload.badge': 1,
              'espnPayload.emblem': 1,
              'espnPayload.image': 1,
              'espnPayload.images': 1,
              'espnPayload.league': 1,
              'espnPayload.competition': 1,
              priority: 1,
            })
            .lean()
            .exec()
        : Promise.resolve([]),
    ]);

    const teamByKey = new Map<string, any>();
    for (const team of teams as any[]) {
      const teamId = String(team.teamId ?? '');
      const leagueId = String(team.leagueId ?? '').toLowerCase();
      if (teamId && leagueId) teamByKey.set(`${leagueId}:${teamId}`, team);
      if (teamId && !teamByKey.has(teamId)) teamByKey.set(teamId, team);
    }

    const leagueById = new Map<string, any>();
    for (const league of leagues as any[]) {
      for (const id of [league.leagueId, league.slug]) {
        const key = String(id ?? '').toLowerCase();
        if (key && !leagueById.has(key)) leagueById.set(key, league);
      }
    }
    const competitionById = new Map<string, any>();
    for (const competition of activeCompetitions as any[]) {
      for (const id of [
        competition.competitionId,
        competition.espnLeagueSlug,
      ]) {
        const key = String(id ?? '').toLowerCase();
        if (key && !competitionById.has(key)) {
          competitionById.set(key, competition);
        }
      }
    }

    return fixtures.map((fixture) => {
      const leagueId = String(fixture.leagueId ?? '').toLowerCase();
      const homeCompetitor = this.fixtureCompetitor(fixture, 'home');
      const awayCompetitor = this.fixtureCompetitor(fixture, 'away');
      const embeddedHomeTeam =
        homeCompetitor.team ?? homeCompetitor.competitor ?? homeCompetitor;
      const embeddedAwayTeam =
        awayCompetitor.team ?? awayCompetitor.competitor ?? awayCompetitor;
      const homeTeamId = String(
        fixture.homeTeamId ?? homeCompetitor.id ?? embeddedHomeTeam.id ?? '',
      );
      const awayTeamId = String(
        fixture.awayTeamId ?? awayCompetitor.id ?? embeddedAwayTeam.id ?? '',
      );
      const homeTeam =
        teamByKey.get(`${leagueId}:${homeTeamId}`) ?? teamByKey.get(homeTeamId);
      const awayTeam =
        teamByKey.get(`${leagueId}:${awayTeamId}`) ?? teamByKey.get(awayTeamId);
      const league = leagueById.get(leagueId);
      const activeCompetition = competitionById.get(leagueId);
      const fixtureCompetitions = this.fixtureCompetitionPayloads(
        fixture.payload,
      );
      const fixtureLeagueObjects = [
        fixture.payload?.league,
        fixture.payload?.competition,
        fixture.payload?.header?.league,
        fixture.payload?.header?.competition,
        ...fixtureCompetitions.flatMap((competition) => [
          competition?.league,
          competition?.competition,
        ]),
      ];
      const status = this.fixturePresentationStatus(fixture);

      const homeTeamName = this.firstSportsText(
        embeddedHomeTeam.displayName,
        embeddedHomeTeam.fullName,
        embeddedHomeTeam.name,
        embeddedHomeTeam.shortDisplayName,
        homeCompetitor.displayName,
        homeTeam?.displayName,
        homeTeam?.name,
        homeTeam?.shortDisplayName,
        homeTeam?.payload?.displayName,
        homeTeam?.payload?.fullName,
        homeTeam?.payload?.name,
        homeTeam?.payload?.shortDisplayName,
      );
      const awayTeamName = this.firstSportsText(
        embeddedAwayTeam.displayName,
        embeddedAwayTeam.fullName,
        embeddedAwayTeam.name,
        embeddedAwayTeam.shortDisplayName,
        awayCompetitor.displayName,
        awayTeam?.displayName,
        awayTeam?.name,
        awayTeam?.shortDisplayName,
        awayTeam?.payload?.displayName,
        awayTeam?.payload?.fullName,
        awayTeam?.payload?.name,
        awayTeam?.payload?.shortDisplayName,
      );
      const leagueName = this.firstSportsText(
        league?.name,
        league?.payload?.displayName,
        league?.payload?.name,
        activeCompetition?.leagueName,
        activeCompetition?.displayName,
        activeCompetition?.name,
        fixture.leagueName,
      );
      const leagueLogo = this.firstSportsLogo(
        fixture.payload?.leagueLogo,
        fixture.payload?.competitionLogo,
        ...fixtureLeagueObjects,
        activeCompetition?.leagueLogo,
        activeCompetition?.logo,
        activeCompetition?.logos,
        activeCompetition?.espnPayload,
        league?.leagueLogo,
        league?.logo,
        league?.logos,
        league?.payload,
      );
      const homeTeamLogo = this.firstSportsLogo(
        embeddedHomeTeam.logo,
        embeddedHomeTeam.logos,
        embeddedHomeTeam.crest,
        embeddedHomeTeam.badge,
        embeddedHomeTeam.emblem,
        homeCompetitor.logo,
        homeTeam?.logo,
        homeTeam?.payload,
      );
      const awayTeamLogo = this.firstSportsLogo(
        embeddedAwayTeam.logo,
        embeddedAwayTeam.logos,
        embeddedAwayTeam.crest,
        embeddedAwayTeam.badge,
        embeddedAwayTeam.emblem,
        awayCompetitor.logo,
        awayTeam?.logo,
        awayTeam?.payload,
      );

      return {
        ...fixture,
        homeTeamName: homeTeamName ?? null,
        awayTeamName: awayTeamName ?? null,
        homeTeamLogo,
        awayTeamLogo,
        leagueName: leagueName ?? null,
        leagueLogo,
        presentationStatus: status.presentationStatus,
        presentationStatusLabel: status.presentationStatusLabel,
      };
    });
  }

  /* eslint-enable
    @typescript-eslint/no-unsafe-argument,
    @typescript-eslint/no-unsafe-assignment,
    @typescript-eslint/no-unsafe-member-access,
    @typescript-eslint/no-unsafe-return
  */

  async getUpcomingFixtures(
    filters: SportsDataFilter = {},
  ): Promise<unknown[]> {
    const mongoFilter: Record<string, unknown> = {};

    this.applyFixtureFilters(mongoFilter, filters);

    /*
     * Preserve the old public behavior:
     * upcoming fixtures without an explicit date/range start from "now".
     */
    if (!filters.date && !filters.from && !filters.to) {
      mongoFilter.fixtureDate = {
        $gte: new Date(),
      };
    }

    const fixtures = await this.espnFixtureModel
      .find(mongoFilter)
      .select({
        _id: 0,
        eventId: 1,
        leagueId: 1,
        season: 1,
        fixtureDate: 1,
        status: 1,
        statusDetail: 1,
        statusShortDetail: 1,
        period: 1,
        completed: 1,
        live: 1,
        displayClock: 1,
        homeTeamId: 1,
        awayTeamId: 1,
        homeScore: 1,
        awayScore: 1,
        venueId: 1,
        venueName: 1,
        collectedAt: 1,
        'payload.competitors': 1,
        'payload.header.competitions': 1,
        'payload.event.competitions': 1,
        'payload.competitions': 1,
        'payload.summary.lastFiveGames': 1,
      })
      .sort({ fixtureDate: 1 })
      .lean()
      .exec();

    return this.enrichFixturePresentation(fixtures as any[]);
  }

  async getLiveFixtures(filters: SportsDataFilter = {}): Promise<unknown[]> {
    const mongoFilter: Record<string, unknown> = {
      live: true,
    };

    this.applyFixtureFilters(mongoFilter, filters);

    const fixtures = await this.espnFixtureModel
      .find(mongoFilter)
      .select({
        _id: 0,
        eventId: 1,
        leagueId: 1,
        season: 1,
        fixtureDate: 1,
        status: 1,
        statusDetail: 1,
        statusShortDetail: 1,
        period: 1,
        completed: 1,
        live: 1,
        displayClock: 1,
        homeTeamId: 1,
        awayTeamId: 1,
        homeScore: 1,
        awayScore: 1,
        venueId: 1,
        venueName: 1,
        collectedAt: 1,
        'payload.competitors': 1,
        'payload.header.competitions': 1,
        'payload.event.competitions': 1,
        'payload.competitions': 1,
      })
      .sort({ fixtureDate: 1 })
      .lean()
      .exec();

    return this.enrichFixturePresentation(fixtures as any[]);
  }

  async getFinishedFixtures(
    filters: SportsDataFilter = {},
  ): Promise<unknown[]> {
    const mongoFilter: Record<string, unknown> = {
      completed: true,
    };

    this.applyFixtureFilters(mongoFilter, filters);

    const fixtures = await this.espnFixtureModel
      .find(mongoFilter)
      .select({
        _id: 0,
        eventId: 1,
        leagueId: 1,
        season: 1,
        fixtureDate: 1,
        status: 1,
        statusDetail: 1,
        statusShortDetail: 1,
        period: 1,
        completed: 1,
        live: 1,
        displayClock: 1,
        homeTeamId: 1,
        awayTeamId: 1,
        homeScore: 1,
        awayScore: 1,
        venueId: 1,
        venueName: 1,
        collectedAt: 1,
        'payload.competitors': 1,
        'payload.header.competitions': 1,
        'payload.event.competitions': 1,
        'payload.competitions': 1,
      })
      .sort({ fixtureDate: -1 })
      .lean()
      .exec();

    return this.enrichFixturePresentation(fixtures as any[]);
  }

  private buildFootballNewsFeedFilter(
    filters: SportsDataFilter = {},
  ): Record<string, unknown> {
    const window = createFootballNewsPublicationWindow();
    const clauses: Record<string, unknown>[] = [
      {
        feedPublishedAt: {
          $gte: window.start,
          $lte: window.end,
        },
      },
    ];

    const competitionId = this.normalizeCompetitionId(filters.competitionId);
    const teamId = this.normalizeTeamId(filters.teamId);

    if (competitionId) {
      clauses.push({
        $or: [{ leagueIds: competitionId }, { leagueId: competitionId }],
      });
    }

    if (teamId) {
      clauses.push({
        $or: [
          { teamIds: teamId },
          { homeTeamId: teamId },
          { awayTeamId: teamId },
        ],
      });
    }

    return clauses.length === 1 ? clauses[0] : { $and: clauses };
  }

  private mapEspnNewsDocumentToFeedItem(
    rawDocument: Record<string, unknown>,
  ): FootballNewsFeedItem | undefined {
    const eventIds = Array.isArray(rawDocument.eventIds)
      ? rawDocument.eventIds
      : [];
    const eventIdValue: unknown = rawDocument.eventId ?? eventIds[0];
    const eventId =
      typeof eventIdValue === 'string' || typeof eventIdValue === 'number'
        ? String(eventIdValue)
        : '';
    const leagueIdValue = rawDocument.leagueId;
    const leagueId =
      typeof leagueIdValue === 'string' || typeof leagueIdValue === 'number'
        ? String(leagueIdValue)
        : '';
    const kind = rawDocument.kind === 'VIDEO' ? 'VIDEO' : 'NEWS';
    const feedPublishedAt = parseDateValue(rawDocument.feedPublishedAt);
    const fixtureDate = parseDateValue(rawDocument.fixtureDate) ?? new Date(0);

    if (!eventId || !leagueId || !feedPublishedAt) return undefined;

    const sourcePayload =
      rawDocument.payload &&
      typeof rawDocument.payload === 'object' &&
      !Array.isArray(rawDocument.payload)
        ? (rawDocument.payload as Record<string, unknown>)
        : {};

    const payload: Record<string, unknown> = {
      ...sourcePayload,
      headline:
        (typeof rawDocument.headline === 'string' && rawDocument.headline) ||
        sourcePayload.headline ||
        sourcePayload.title,
      description:
        (typeof rawDocument.description === 'string' &&
          rawDocument.description) ||
        sourcePayload.description ||
        sourcePayload.summary,
      link: rawDocument.link ?? sourcePayload.link ?? sourcePayload.url,
      imageUrl: rawDocument.imageUrl ?? sourcePayload.imageUrl,
      published:
        parseDateValue(rawDocument.published)?.toISOString() ??
        sourcePayload.published,
      lastModified:
        parseDateValue(rawDocument.lastModified)?.toISOString() ??
        sourcePayload.lastModified,
    };

    const homeTeamId =
      typeof rawDocument.homeTeamId === 'string'
        ? rawDocument.homeTeamId
        : undefined;
    const awayTeamId =
      typeof rawDocument.awayTeamId === 'string'
        ? rawDocument.awayTeamId
        : undefined;

    return {
      kind,
      eventId,
      leagueId,
      fixtureDate: fixtureDate.toISOString(),
      homeTeamId,
      awayTeamId,
      publishedAt: feedPublishedAt.toISOString(),
      payload,
    };
  }

  async *streamFootballNews(
    filters: SportsDataFilter = {},
  ): AsyncGenerator<FootballNewsFeedItem, void, void> {
    const filter = this.buildFootballNewsFeedFilter(filters);

    const cursor = this.espnNewsModel
      .find(filter)
      .sort({ feedPublishedAt: -1, _id: 1 })
      .select({
        _id: 0,
        kind: 1,
        eventId: 1,
        eventIds: 1,
        leagueId: 1,
        fixtureDate: 1,
        homeTeamId: 1,
        awayTeamId: 1,
        headline: 1,
        description: 1,
        published: 1,
        lastModified: 1,
        feedPublishedAt: 1,
        link: 1,
        imageUrl: 1,
        payload: 1,
      })
      .lean()
      .cursor({ batchSize: 100 });

    try {
      for await (const rawDocument of cursor) {
        const item = this.mapEspnNewsDocumentToFeedItem(
          rawDocument as unknown as Record<string, unknown>,
        );
        if (item) yield item;
      }
    } finally {
      await cursor.close();
    }
  }

  async getFootballNews(
    filters: SportsDataFilter = {},
    page = 1,
    limit = 30,
  ): Promise<PaginatedResult<FootballNewsFeedItem>> {
    const safePage = Math.max(Math.floor(page || 1), 1);
    const safeLimit = Math.min(Math.max(Math.floor(limit || 30), 1), 100);
    const filter = this.buildFootballNewsFeedFilter(filters);
    const skip = (safePage - 1) * safeLimit;

    const [documents, total] = await Promise.all([
      this.espnNewsModel
        .find(filter)
        .sort({ feedPublishedAt: -1, _id: 1 })
        .skip(skip)
        .limit(safeLimit)
        .select({
          _id: 0,
          kind: 1,
          eventId: 1,
          eventIds: 1,
          leagueId: 1,
          fixtureDate: 1,
          homeTeamId: 1,
          awayTeamId: 1,
          headline: 1,
          description: 1,
          published: 1,
          lastModified: 1,
          feedPublishedAt: 1,
          link: 1,
          imageUrl: 1,
          payload: 1,
        })
        .lean()
        .exec(),
      this.espnNewsModel.countDocuments(filter).exec(),
    ]);

    const data = documents
      .map((document) =>
        this.mapEspnNewsDocumentToFeedItem(
          document as unknown as Record<string, unknown>,
        ),
      )
      .filter((item): item is FootballNewsFeedItem => item !== undefined);

    return {
      data,
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: total > 0 ? Math.ceil(total / safeLimit) : 0,
    };
  }

  // ============================================================
  // ESPN FIXTURE PAYLOAD — SINGULAR READS
  // ============================================================

  async getFixtureId(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.id': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.id ?? null;
  }

  async getFixtureUid(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.uid': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.uid ?? null;
  }

  async getFixtureDate(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.date': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.date ?? null;
  }

  async getFixtureName(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.name': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.name ?? null;
  }

  async getFixtureShortName(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.shortName': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.shortName ?? null;
  }

  async getFixtureTimeValid(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.timeValid': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.timeValid ?? null;
  }

  async getFixtureSeason(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.season': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.season ?? null;
  }

  async getFixtureSeasonType(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.seasonType': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.seasonType ?? null;
  }

  async getFixtureCompetitions(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.competitions': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.competitions ?? null;
  }

  async getFixtureLinks(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.links': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.links ?? null;
  }

  async getFixtureLeague(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.league': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.league ?? null;
  }

  async getFixtureStatus(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.status': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.status ?? null;
  }

  async getFixtureVenue(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.venue': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.venue ?? null;
  }

  // ============================================================
  // ESPN SUMMARY — SINGULAR READS
  // ============================================================

  async getFixtureSummaryBoxscore(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.summary.boxscore': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.summary?.boxscore ?? null;
  }

  async getFixtureSummaryFormat(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.summary.format': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.summary?.format ?? null;
  }

  async getFixtureSummaryGameInfo(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.summary.gameInfo': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.summary?.gameInfo ?? null;
  }

  async getFixtureSummaryLastFiveGames(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.summary.lastFiveGames': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.summary?.lastFiveGames ?? null;
  }

  async getFixtureSummaryBroadcasts(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.summary.broadcasts': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.summary?.broadcasts ?? null;
  }

  async getFixtureSummaryPickcenter(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.summary.pickcenter': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.summary?.pickcenter ?? null;
  }

  async getFixtureSummaryOdds(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.summary.odds': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.summary?.odds ?? null;
  }

  async getFixtureSummaryHasOdds(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.summary.hasOdds': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.summary?.hasOdds ?? null;
  }

  async getFixtureSummaryRosters(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.summary.rosters': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.summary?.rosters ?? null;
  }

  async getFixtureSummaryNews(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.summary.news': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.summary?.news ?? null;
  }

  async getFixtureSummarySeasonSeries(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.summary.seasonseries': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.summary?.seasonseries ?? null;
  }

  async getFixtureSummaryVideos(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.summary.videos': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.summary?.videos ?? null;
  }

  async getFixtureSummaryHeader(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.summary.header': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.summary?.header ?? null;
  }

  async getFixtureSummaryKeyEvents(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.summary.keyEvents': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.summary?.keyEvents ?? null;
  }

  async getFixtureSummaryCommentary(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.summary.commentary': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.summary?.commentary ?? null;
  }

  async getFixtureSummaryWallclockAvailable(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.summary.wallclockAvailable': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.summary?.wallclockAvailable ?? null;
  }

  async getFixtureSummaryMeta(eventId: string): Promise<unknown> {
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: eventId.trim() })
      .select({
        _id: 0,
        'payload.summary.meta': 1,
      })
      .lean()
      .exec();

    return fixture?.payload?.summary?.meta ?? null;
  }

  async getFixtureSummaryStandings(eventId: string): Promise<unknown> {
    const normalizedEventId = eventId.trim();
    if (!normalizedEventId) return null;

    // Standings are now stored as one complete ESPN response per league/season,
    // not embedded in an individual fixture Summary payload.
    const fixture = await this.espnFixtureModel
      .findOne({ eventId: normalizedEventId })
      .select({ _id: 0, leagueId: 1, season: 1 })
      .lean()
      .exec();

    if (!fixture) return null;

    const leagueId = this.normalizeCompetitionId(fixture.leagueId);
    const document = await this.espnStandingModel
      .findOne({ leagueId, season: fixture.season })
      .select({
        _id: 0,
        leagueId: 1,
        season: 1,
        leagueName: 1,
        payload: 1,
        fetchedAt: 1,
      })
      .lean()
      .exec();

    return document?.payload ?? null;
  }

  // ============================================================
  // LEAGUE TABLE — DIRECT STORED DATA
  // ============================================================

  async getLeagueTable(
    competitionId: string,
    teamId?: string,
    groupId?: string,
  ): Promise<unknown> {
    // The full provider table is returned; the optional filters are retained
    // for compatibility with the public read contract.
    void teamId;
    void groupId;
    const leagueId = this.normalizeCompetitionId(competitionId);
    if (!leagueId) return null;

    // The public/API identifier may be the internal competitionId or the ESPN
    // slug. Resolve it once, then use the canonical slug for standings storage.
    const competition = await this.activeCompetitionModel
      .findOne({
        $or: [{ competitionId: leagueId }, { espnLeagueSlug: leagueId }],
      })
      .select({ competitionId: 1, espnLeagueSlug: 1, season: 1 })
      .lean()
      .exec();

    const canonicalLeagueId = this.normalizeCompetitionId(
      competition?.espnLeagueSlug || leagueId,
    );

    const season =
      typeof competition?.season === 'number'
        ? competition.season
        : (
            await this.espnStandingModel
              .findOne({ leagueId: canonicalLeagueId })
              .sort({ season: -1 })
              .select({ season: 1 })
              .lean()
              .exec()
          )?.season;

    if (typeof season !== 'number') return null;

    const document = await this.espnStandingModel
      .findOne({ leagueId: canonicalLeagueId, season })
      .select({ _id: 0, payload: 1 })
      .lean()
      .exec();

    // Return the complete provider structure, including nested cup groups.
    return document?.payload ?? null;
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
  // STANDARD SPORTS FILTERS
  // ============================================================

  /**
   * Applies the standard public sports filter contract:
   *
   * - date OR from/to
   * - competitionId
   * - teamId
   *
   * The date filter is always applied against the canonical
   * fixtureDate field. Team matching includes either home or away.
   */
  private applyFixtureFilters(
    filter: Record<string, unknown>,
    filters: SportsDataFilter,
  ): void {
    const normalizedCompetitionId = this.normalizeCompetitionId(
      filters.competitionId,
    );

    if (normalizedCompetitionId) {
      filter.leagueId = normalizedCompetitionId;
    }

    const normalizedTeamId = this.normalizeTeamId(filters.teamId);

    if (normalizedTeamId) {
      filter.$or = [
        {
          homeTeamId: normalizedTeamId,
        },
        {
          awayTeamId: normalizedTeamId,
        },
      ];
    }

    const dateRange = this.resolveSportsDateRange(filters);

    if (dateRange) {
      filter.fixtureDate = dateRange;
    }
  }

  private resolveSportsDateRange(
    filters: SportsDataFilter,
  ): { $gte?: Date; $lt?: Date } | undefined {
    if (filters.date) {
      const start = this.startOfUtcDay(filters.date);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

      return {
        $gte: start,
        $lt: end,
      };
    }

    if (!filters.from && !filters.to) {
      return undefined;
    }

    const range: { $gte?: Date; $lt?: Date } = {};

    if (filters.from) {
      range.$gte = filters.from;
    }

    if (filters.to) {
      range.$lt = filters.to;
    }

    return range;
  }

  private startOfUtcDay(value: Date): Date {
    return new Date(
      Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
    );
  }

  private normalizeCompetitionId(value?: string): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  private normalizeTeamId(value?: string): string {
    return typeof value === 'string' ? value.trim() : '';
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

    const result = await this.paginateModel<SportsSyncStateDocument>(
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
    if (query.leagueId) filter.leagueId = query.leagueId.trim().toLowerCase();
    if (typeof query.season === 'number') filter.season = query.season;

    return this.paginateModel(
      this.espnStandingModel,
      {
        ...query,
        sortBy: query.sortBy ?? 'fetchedAt',
        sortOrder: query.sortOrder ?? 'desc',
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
  // PREDICTION READ CONTRACT
  // ============================================================

  /**
   * Returns the canonical Sports snapshot that Predictions are allowed
   * to consume. This method owns all Sports-side readiness checks.
   *
   * No caller in the Predictions module should reconstruct fixture,
   * Summary, team, or competition readiness independently.
   */
  async getPredictionData(
    eventId: string,
  ): Promise<SportsPredictionData | null> {
    const normalizedEventId = eventId.trim();

    if (!normalizedEventId) {
      return null;
    }

    /*
     * Prediction calculation must never hydrate the complete ESPN fixture
     * document or complete Summary payload.
     *
     * Only the fixture identity/state fields, prediction-relevant Summary
     * sections, active competition metadata, and the two participating teams
     * are loaded.
     */
    const fixture = await this.espnFixtureModel
      .findOne({
        eventId: normalizedEventId,
      })
      .select({
        _id: 0,
        eventId: 1,
        leagueId: 1,
        season: 1,
        fixtureDate: 1,
        live: 1,
        completed: 1,
        homeTeamId: 1,
        awayTeamId: 1,
        collectedAt: 1,
        'payload.summary.pickcenter': 1,
        'payload.summary.odds': 1,
        'payload.summary.seasonseries': 1,
        'payload.summary.lastFiveGames': 1,
        'payload.summaryCollectedAt': 1,
      })
      .lean()
      .exec();

    if (!fixture) {
      return null;
    }

    const [competition, teams, standingsDocument] = await Promise.all([
      this.activeCompetitionModel
        .findOne({
          competitionId: fixture.leagueId,
        })
        .select({
          _id: 0,
          competitionId: 1,
          name: 1,
          status: 1,
          season: 1,
          espnPayload: 1,
        })
        .lean()
        .exec(),

      this.espnTeamModel
        .find({
          leagueId: fixture.leagueId,
          teamId: {
            $in: [fixture.homeTeamId, fixture.awayTeamId],
          },
        })
        .select({
          _id: 0,
          teamId: 1,
          leagueId: 1,
          name: 1,
          displayName: 1,
          shortDisplayName: 1,
          logo: 1,
          collectedAt: 1,
        })
        .lean()
        .exec(),

      this.espnStandingModel
        .findOne({
          leagueId: this.normalizeCompetitionId(fixture.leagueId),
          season: fixture.season,
        })
        .select({ _id: 0, payload: 1, fetchedAt: 1 })
        .lean()
        .exec(),
    ]);

    const payload =
      fixture.payload && typeof fixture.payload === 'object'
        ? (fixture.payload as Record<string, unknown>)
        : {};

    const storedSummary =
      payload.summary && typeof payload.summary === 'object'
        ? (payload.summary as Record<string, unknown>)
        : {};

    const summary: SportsPredictionData['summary'] = {
      pickcenter: storedSummary.pickcenter,
      odds: storedSummary.odds,
      seasonseries: storedSummary.seasonseries,
      lastFiveGames: storedSummary.lastFiveGames,
    };

    const summaryAvailable = Object.values(summary).some(
      (section) => section !== undefined && section !== null,
    );

    const summaryCollectedAt = payload.summaryCollectedAt ?? null;

    const now = new Date();

    const fixtureIsFuture = fixture.fixtureDate > now;
    const fixtureIsNotLive = fixture.live !== true;
    const fixtureIsNotCompleted = fixture.completed !== true;
    const summaryTimestampAvailable = Boolean(summaryCollectedAt);
    const competitionAvailable = Boolean(competition);
    const competitionOperational = Boolean(
      competition &&
      [
        ActiveCompetitionStatus.ACTIVE,
        ActiveCompetitionStatus.UPCOMING,
      ].includes(competition.status),
    );
    const seasonMatches = Boolean(
      !competition?.season || competition.season === fixture.season,
    );
    const homeTeam = teams.find(
      (team) => String(team.teamId) === String(fixture.homeTeamId),
    );
    const awayTeam = teams.find(
      (team) => String(team.teamId) === String(fixture.awayTeamId),
    );
    const teamsAvailable = Boolean(homeTeam && awayTeam);

    const notReadyReasons: string[] = [];

    if (!fixtureIsFuture) {
      notReadyReasons.push('FIXTURE_NOT_FUTURE');
    }

    if (!fixtureIsNotLive) {
      notReadyReasons.push('FIXTURE_LIVE');
    }

    if (!fixtureIsNotCompleted) {
      notReadyReasons.push('FIXTURE_COMPLETED');
    }

    if (!summaryAvailable) {
      notReadyReasons.push('SUMMARY_MISSING');
    }

    if (!summaryTimestampAvailable) {
      notReadyReasons.push('SUMMARY_TIMESTAMP_MISSING');
    }

    if (!competitionAvailable) {
      notReadyReasons.push('COMPETITION_MISSING');
    } else if (!competitionOperational) {
      notReadyReasons.push('COMPETITION_NOT_OPERATIONAL');
    }

    if (!seasonMatches) {
      notReadyReasons.push('SEASON_MISMATCH');
    }

    if (!teamsAvailable) {
      notReadyReasons.push('TEAMS_MISSING');
    }

    const fixtureSnapshot: SportsPredictionData['fixture'] = {
      eventId: fixture.eventId,
      leagueId: fixture.leagueId,
      season: fixture.season,
      fixtureDate: fixture.fixtureDate,
      live: fixture.live,
      completed: fixture.completed,
      homeTeamId: fixture.homeTeamId,
      awayTeamId: fixture.awayTeamId,
      collectedAt: fixture.collectedAt,
    };

    const competitionSnapshot: SportsPredictionData['competition'] = competition
      ? {
          competitionId: competition.competitionId,
          name: competition.name,
          status: competition.status,
          season: competition.season,
          espnPayload: competition.espnPayload,
        }
      : null;

    return {
      ready: notReadyReasons.length === 0,
      reason: notReadyReasons[0] ?? null,
      reasons: notReadyReasons,

      fixture: fixtureSnapshot,

      summary,

      standingsPayload:
        standingsDocument?.payload &&
        typeof standingsDocument.payload === 'object'
          ? standingsDocument.payload
          : null,
      standingsFetchedAt: standingsDocument?.fetchedAt ?? null,

      competition: competitionSnapshot,

      homeTeam: homeTeam ?? null,
      awayTeam: awayTeam ?? null,

      fixtureCollectedAt: fixture.collectedAt,
      summaryCollectedAt,
    };
  }

  // ============================================================
  // SETTLEMENT READ CONTRACT
  // ============================================================

  async getSettlementData(
    eventId: string,
  ): Promise<SportsSettlementData | null> {
    const normalizedEventId = eventId.trim();

    if (!normalizedEventId) {
      return null;
    }

    const fixture = await this.espnFixtureModel
      .findOne({
        eventId: normalizedEventId,
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

    const summary =
      payload?.summary && typeof payload.summary === 'object'
        ? (payload.summary as Record<string, unknown>)
        : null;

    return {
      fixture,
      summary,
      summaryCollectedAt: payload?.summaryCollectedAt ?? null,
    };
  }

  async getSettlementDataByEventIds(
    eventIds: string[],
  ): Promise<SportsSettlementData[]> {
    const normalizedEventIds = [
      ...new Set(eventIds.map((id) => id.trim()).filter(Boolean)),
    ];

    if (!normalizedEventIds.length) {
      return [];
    }

    const fixtures = await this.espnFixtureModel
      .find({
        eventId: {
          $in: normalizedEventIds,
        },
      })
      .lean()
      .exec();

    return fixtures.map((fixture) => {
      const payload =
        fixture.payload && typeof fixture.payload === 'object'
          ? fixture.payload
          : undefined;

      const summary =
        payload?.summary && typeof payload.summary === 'object'
          ? (payload.summary as Record<string, unknown>)
          : null;

      return {
        fixture,
        summary,
        summaryCollectedAt: payload?.summaryCollectedAt ?? null,
      };
    });
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

