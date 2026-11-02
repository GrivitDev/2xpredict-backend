// src/sports/services/espn-active-competition.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AnyBulkWriteOperation, Model } from 'mongoose';

import {
  EspnLeague,
  EspnLeagueDocument,
} from '../schemas/espn/espn-league.schema';
import {
  EspnFixture,
  EspnFixtureDocument,
} from '../schemas/espn/espn-fixture.schema';

import { EspnService } from '../providers/espn.service';
import { ActiveCompetitionService } from './active-competition.service';
import { PriorityCompetitionService } from './priority-competition.service';
import { EspnSeasonDataService } from './espn-season-data.service';

import { CompetitionPriority } from '../enums/competition-priority.enum';
import { CompetitionRegion } from '../enums/competition-region.enum';
import { CompetitionType } from '../enums/competition-type.enum';

import {
  EspnLeague as EspnLeaguePayload,
  EspnSeason,
} from '../providers/espn.interfaces';

interface LeagueSeasonData {
  season: number;
  startDate?: Date;
  endDate?: Date;
  payload: EspnSeason;
}

@Injectable()
export class EspnActiveCompetitionService {
  private readonly logger = new Logger(EspnActiveCompetitionService.name);

  constructor(
    private readonly espnService: EspnService,

    private readonly activeCompetitionService: ActiveCompetitionService,

    private readonly priorityCompetitionService: PriorityCompetitionService,

    private readonly espnSeasonDataService: EspnSeasonDataService,

    @InjectModel(EspnLeague.name)
    private readonly espnLeagueModel: Model<EspnLeagueDocument>,

    @InjectModel(EspnFixture.name)
    private readonly espnFixtureModel: Model<EspnFixtureDocument>,
  ) {}

  // ============================================================
  // CATALOGUE DISCOVERY
  // ============================================================

  async synchronizeLeagueCatalogue(): Promise<EspnLeagueDocument[]> {
    const leagues = await this.espnService.getLeagues();

    if (!Array.isArray(leagues)) {
      throw new Error('ESPN league catalogue response was not an array');
    }

    const now = new Date();

    const operations = leagues
      .map((league) => this.buildCatalogueOperation(league, now))
      .filter(
        (operation): operation is AnyBulkWriteOperation<EspnLeagueDocument> =>
          operation !== null,
      );

    if (operations.length > 0) {
      await this.espnLeagueModel.bulkWrite(operations, {
        ordered: false,
      });
    }

    this.logger.log(`ESPN catalogue stored: ${operations.length} leagues`);

    return this.getOrderedLeagues();
  }

  // ============================================================
  // LEAGUE DETAILS
  // ============================================================

  /**
   * Full league-detail synchronization.
   *
   * This is an explicit/full synchronization path.
   * Startup uses synchronizeMissingLeagueDetails() instead so that
   * already-synchronized leagues do not consume unnecessary ESPN
   * league-detail requests.
   */
  async synchronizeLeagueDetails(): Promise<{
    processed: number;
    synchronized: number;
    active: number;
    inactive: number;
    skipped: number;
    failed: number;
  }> {
    const leagues = await this.getOrderedLeagues();

    let processed = 0;
    let synchronized = 0;
    let active = 0;
    let inactive = 0;
    let skipped = 0;
    let failed = 0;

    const activeCompetitionIds: string[] = [];

    for (const league of leagues) {
      processed += 1;

      try {
        const result = await this.synchronizeLeagueDetail(league);

        if (!result) {
          skipped += 1;
          continue;
        }

        synchronized += 1;

        if (result.isActive) {
          active += 1;

          const normalizedId = this.normalizeLeagueId(league.leagueId);

          if (normalizedId) {
            activeCompetitionIds.push(normalizedId);
          }
        } else {
          inactive += 1;
        }
      } catch (error) {
        failed += 1;

        this.logger.error(
          `Failed to synchronize ESPN league detail ${league.leagueId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    const removed =
      await this.activeCompetitionService.removeMissingCompetitions(
        activeCompetitionIds,
      );

    this.logger.log(
      `ESPN league details synchronized: ` +
        `processed=${processed}, ` +
        `synchronized=${synchronized}, ` +
        `active=${active}, ` +
        `inactive=${inactive}, ` +
        `skipped=${skipped}, ` +
        `failed=${failed}, ` +
        `removed=${removed}`,
    );

    return {
      processed,
      synchronized,
      active,
      inactive,
      skipped,
      failed,
    };
  }

  /**
   * Startup synchronization.
   *
   * Only leagues without a successful detail synchronization are sent
   * to ESPN. Existing ActiveCompetition documents are left untouched
   * for leagues that already have synchronized detail data.
   */
  async synchronizeMissingLeagueDetails(): Promise<{
    processed: number;
    synchronized: number;
    active: number;
    inactive: number;
    skipped: number;
    failed: number;
  }> {
    const leagues = await this.getOrderedLeagues();

    const missingDetails = leagues.filter(
      (league) => !league.detailLastSyncedAt,
    );

    let processed = 0;
    let synchronized = 0;
    let active = 0;
    let inactive = 0;
    let skipped = 0;
    let failed = 0;

    for (const league of missingDetails) {
      processed += 1;

      try {
        const result = await this.synchronizeLeagueDetail(league);

        if (!result) {
          skipped += 1;
          continue;
        }

        synchronized += 1;

        if (result.isActive) {
          active += 1;
        } else {
          inactive += 1;
        }
      } catch (error) {
        failed += 1;

        this.logger.error(
          `Failed to synchronize missing ESPN league detail ` +
            `${league.leagueId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    /*
     * ActiveCompetition remains the operational source of truth for
     * currently active competitions. Refresh its status after startup
     * detail synchronization so expired competitions are removed.
     */
    await this.activeCompetitionService.refreshStatuses();

    this.logger.log(
      `ESPN missing league details synchronized: ` +
        `catalogue=${leagues.length}, ` +
        `missing=${missingDetails.length}, ` +
        `processed=${processed}, ` +
        `synchronized=${synchronized}, ` +
        `active=${active}, ` +
        `inactive=${inactive}, ` +
        `skipped=${skipped}, ` +
        `failed=${failed}`,
    );

    return {
      processed,
      synchronized,
      active,
      inactive,
      skipped,
      failed,
    };
  }

  async synchronizeLeagueDetail(league: EspnLeagueDocument): Promise<{
    isActive: boolean;
    season?: number;
  } | null> {
    const leagueSlug =
      this.normalizeLeagueId(league.slug) ||
      this.normalizeLeagueId(league.leagueId);

    if (!leagueSlug) {
      this.logger.warn(
        `Skipping ESPN league without a usable slug/id: ${league.name}`,
      );

      return null;
    }

    const detail = await this.espnService.getLeague(leagueSlug);

    const season = this.extractLeagueSeason(detail);

    const priorityConfig = this.findPriorityCompetition(
      leagueSlug,
      league.leagueId,
    );

    const priority =
      priorityConfig?.priority ??
      this.getStoredPriority(league) ??
      CompetitionPriority.SELECTIVE;

    const region = priorityConfig?.region ?? this.getDefaultRegion(detail);

    const type = priorityConfig?.type ?? this.getDefaultCompetitionType();

    const normalizedSlug = this.normalizeLeagueId(detail.slug) || leagueSlug;

    const canonicalLeagueId =
      this.normalizeLeagueId(league.leagueId) || leagueSlug;

    const name =
      this.getString(detail.name) ||
      this.getString(detail.displayName) ||
      league.name;

    const abbreviation =
      this.getString(detail.abbreviation) || league.abbreviation;

    const country = this.extractCountry(detail) || league.country;

    const now = new Date();

    // Clean an ended season before replacing its current-season metadata.
    let previousSeasonCleaned = false;
    if (
      typeof league.previousSeason === 'number' &&
      league.previousSeason !== league.season &&
      league.previousSeasonEndDate
    ) {
      const previousCleanup =
        await this.espnSeasonDataService.cleanupLeagueSeason({
          leagueId: canonicalLeagueId,
          season: league.previousSeason,
          seasonEndDate: new Date(league.previousSeasonEndDate),
        });
      previousSeasonCleaned = previousCleanup.cleaned;
    }

    let currentSeasonCleaned = false;
    if (typeof league.season === 'number' && league.seasonEndDate) {
      const currentCleanup =
        await this.espnSeasonDataService.cleanupLeagueSeason({
          leagueId: canonicalLeagueId,
          season: league.season,
          seasonEndDate: new Date(league.seasonEndDate),
        });
      currentSeasonCleaned = currentCleanup.cleaned;
    }

    const seasonChanged =
      typeof league.season === 'number' &&
      typeof season?.season === 'number' &&
      league.season !== season.season;
    const previousSeasonStillPending =
      typeof league.previousSeason === 'number' &&
      Boolean(league.previousSeasonEndDate) &&
      league.lastCleanedSeason !== league.previousSeason &&
      !previousSeasonCleaned;
    const currentSeasonStillNeedsCleanup =
      typeof league.season === 'number' &&
      league.lastCleanedSeason !== league.season &&
      !currentSeasonCleaned;

    if (seasonChanged && previousSeasonStillPending) {
      this.logger.warn(
        `Deferring ESPN season switch for ${canonicalLeagueId}: previous season ${league.previousSeason} cleanup is still pending`,
      );
      return {
        isActive: league.isActive,
        season: league.season,
      };
    }

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
      payload: detail,
      detailLastSyncedAt: now,
    };

    if (
      seasonChanged &&
      currentSeasonStillNeedsCleanup &&
      !previousSeasonStillPending &&
      league.seasonEndDate
    ) {
      update.previousSeason = league.season;
      update.previousSeasonEndDate = league.seasonEndDate;
    }

    if (season) {
      update.season = season.season;
      update.seasonStartDate = season.startDate;
      update.seasonEndDate = season.endDate;
    } else {
      update.isActive = false;
    }

    await this.espnLeagueModel.updateOne(
      {
        _id: league._id,
      },
      {
        $set: update,
      },
    );

    if (!season) {
      await this.activeCompetitionService.removeByCompetitionId(
        canonicalLeagueId,
      );

      return {
        isActive: false,
      };
    }

    if (isActive) {
      await this.activeCompetitionService.syncLeague({
        competitionId: canonicalLeagueId,
        espnLeagueSlug: normalizedSlug,
        name,
        type,
        region,
        priority,
        footballDataCode: priorityConfig?.providers?.footballDataCode,
        oddsApiSportKey: priorityConfig?.providers?.oddsApiSportKey,
        season: season.season,
        seasonStartDate: season.startDate,
        seasonEndDate: season.endDate,
        espnPayload: detail,
      });
    } else {
      await this.activeCompetitionService.removeByCompetitionId(
        canonicalLeagueId,
      );
    }

    return {
      isActive,
      season: season.season,
    };
  }

  // ============================================================
  // SEASON FIXTURE-CATALOGUE STATE
  // ============================================================

  async markSeasonFixturesCollected(
    leagueId: string,
    season: number,
  ): Promise<boolean> {
    const normalizedLeagueId = this.normalizeLeagueId(leagueId);
    if (!normalizedLeagueId || !Number.isInteger(season)) {
      throw new Error(
        'Season fixture completion requires a valid league ID and season',
      );
    }

    const fixtureCount = await this.espnFixtureModel.countDocuments({
      leagueId: normalizedLeagueId,
      season,
    });

    if (fixtureCount === 0) {
      await this.espnLeagueModel
        .updateOne(
          {
            season,
            $or: [
              { leagueId: normalizedLeagueId },
              { slug: normalizedLeagueId },
            ],
          },
          {
            $unset: { fixturesCollectedSeason: 1 },
            $set: {
              fixtureCollectionAttemptSeason: season,
              fixtureCollectionAttemptedAt: new Date(),
            },
          },
        )
        .exec();

      this.logger.warn(
        `ESPN fixture catalogue remains incomplete for ${normalizedLeagueId}/${season}: no fixture documents are stored yet`,
      );
      return false;
    }

    const result = await this.espnLeagueModel
      .updateOne(
        {
          season,
          $or: [{ leagueId: normalizedLeagueId }, { slug: normalizedLeagueId }],
        },
        {
          $set: { fixturesCollectedSeason: season },
          $unset: {
            fixtureCollectionAttemptSeason: 1,
            fixtureCollectionAttemptedAt: 1,
          },
        },
      )
      .exec();

    if (result.matchedCount === 0) {
      throw new Error(
        `Cannot mark fixture catalogue complete for ${normalizedLeagueId}/${season}: league record not found`,
      );
    }

    return true;
  }

  // ============================================================
  // ACTIVE COMPETITIONS
  // ============================================================

  async syncActiveCompetitions(): Promise<void> {
    await this.synchronizeLeagueDetails();
  }

  async syncPriorityCompetition(leagueId: string): Promise<boolean> {
    const normalized = this.normalizeLeagueId(leagueId);

    if (!normalized) {
      return false;
    }

    let league = await this.getByLeagueId(normalized);

    if (!league) {
      league = await this.getBySlug(normalized);
    }

    if (!league) {
      return false;
    }

    const result = await this.synchronizeLeagueDetail(league);

    return Boolean(result?.isActive);
  }

  async refreshActiveCompetitionStatuses(): Promise<void> {
    await this.activeCompetitionService.refreshStatuses();
  }

  // ============================================================
  // LEAGUE READS
  // ============================================================

  async getActiveLeagues(): Promise<EspnLeagueDocument[]> {
    const leagues = await this.espnLeagueModel
      .find({
        isActive: true,
      })
      .lean()
      .exec();

    return this.sortLeaguesByPriority(leagues);
  }

  async getPriorityLeagues(): Promise<EspnLeagueDocument[]> {
    const leagues = await this.espnLeagueModel
      .find({
        isPriority: true,
        isActive: true,
      })
      .lean()
      .exec();

    return this.sortLeaguesByPriority(leagues);
  }

  async getOrderedLeagues(): Promise<EspnLeagueDocument[]> {
    const leagues = await this.espnLeagueModel.find().lean().exec();

    return this.sortLeaguesByPriority(leagues);
  }

  async getByLeagueId(leagueId: string): Promise<EspnLeagueDocument | null> {
    const normalized = this.normalizeLeagueId(leagueId);

    if (!normalized) {
      return null;
    }

    return this.espnLeagueModel
      .findOne({
        leagueId: normalized,
      })
      .lean()
      .exec();
  }

  async getBySlug(slug: string): Promise<EspnLeagueDocument | null> {
    const normalized = this.normalizeLeagueId(slug);

    if (!normalized) {
      return null;
    }

    return this.espnLeagueModel
      .findOne({
        slug: normalized,
      })
      .lean()
      .exec();
  }

  async updateLeagueActivity(
    leagueId: string,
    isActive: boolean,
  ): Promise<void> {
    const normalized = this.normalizeLeagueId(leagueId);

    if (!normalized) {
      return;
    }

    await this.espnLeagueModel.updateOne(
      {
        leagueId: normalized,
      },
      {
        $set: {
          isActive,
        },
      },
    );
  }

  // ============================================================
  // CATALOGUE OPERATION
  // ============================================================

  private buildCatalogueOperation(
    league: EspnLeaguePayload,
    now: Date,
  ): AnyBulkWriteOperation<EspnLeagueDocument> | null {
    const leagueId =
      this.normalizeLeagueId(league.id) || this.normalizeLeagueId(league.slug);

    const slug = this.normalizeLeagueId(league.slug) || leagueId;

    if (!leagueId || !slug) {
      return null;
    }

    const priorityConfig = this.findPriorityCompetition(slug, leagueId);

    const priority = priorityConfig?.priority ?? CompetitionPriority.SELECTIVE;

    const name =
      this.getString(league.name) ||
      this.getString(league.displayName) ||
      this.getString(league.shortName) ||
      leagueId;

    const country = this.extractCountry(league);

    return {
      updateOne: {
        filter: {
          leagueId,
        },

        update: {
          $set: {
            leagueId,
            slug,
            name,
            abbreviation: this.getString(league.abbreviation),
            country,
            priority,
            isPriority: Boolean(priorityConfig),

            /*
             * Catalogue synchronization must not overwrite the
             * authoritative league-detail payload.
             */
            lastSyncedAt: now,
          },

          $setOnInsert: {
            firstSeenAt: now,
            isActive: false,

            /*
             * Only the initial catalogue insert receives the
             * catalogue payload.
             */
            payload: league,
          },
        },

        upsert: true,
      },
    };
  }

  // ============================================================
  // SEASON EXTRACTION
  // ============================================================

  private extractLeagueSeason(
    league: EspnLeaguePayload,
  ): LeagueSeasonData | null {
    const candidate = (
      league as EspnLeaguePayload & {
        season?: EspnSeason;
      }
    ).season;

    if (!candidate || typeof candidate !== 'object') {
      return null;
    }

    const seasonValue =
      typeof candidate.year === 'number'
        ? candidate.year
        : Number((candidate as Record<string, unknown>).year);

    if (!Number.isFinite(seasonValue)) {
      return null;
    }

    return {
      season: seasonValue,
      startDate: this.parseDate(candidate.startDate),
      endDate: this.parseDate(candidate.endDate),
      payload: candidate,
    };
  }

  private isSeasonActive(
    startDate?: Date,
    endDate?: Date,
    now = new Date(),
  ): boolean {
    if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) {
      return false;
    }

    // ESPN season bounds are calendar dates; treat the end date as inclusive
    // in Africa/Lagos instead of expiring seasons at midnight UTC.
    const currentDateKey = this.getLagosDateKey(now);
    if (currentDateKey < this.getLagosDateKey(startDate)) {
      return false;
    }

    if (
      endDate instanceof Date &&
      !Number.isNaN(endDate.getTime()) &&
      currentDateKey > this.getLagosDateKey(endDate)
    ) {
      return false;
    }

    return true;
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

  // ============================================================
  // PRIORITY
  // ============================================================

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

  private getPriorityRank(priority: CompetitionPriority): number {
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

  private sortLeaguesByPriority<
    T extends { isActive?: unknown; name?: unknown; priority?: unknown },
  >(leagues: T[]): T[] {
    return [...leagues].sort((a, b) => {
      const priorityA = this.getPriorityRank(this.getStoredPriority(a));
      const priorityB = this.getPriorityRank(this.getStoredPriority(b));

      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }

      const activeA = a.isActive ? 0 : 1;
      const activeB = b.isActive ? 0 : 1;

      if (activeA !== activeB) {
        return activeA - activeB;
      }

      const nameA = typeof a.name === 'string' ? a.name : '';
      const nameB = typeof b.name === 'string' ? b.name : '';

      return nameA.localeCompare(nameB);
    });
  }

  private getStoredPriority(league: {
    priority?: unknown;
  }): CompetitionPriority {
    return (
      Object.values(CompetitionPriority).find(
        (priority) => priority === league.priority,
      ) ?? CompetitionPriority.SELECTIVE
    );
  }

  // ============================================================
  // DEFAULT CLASSIFICATION
  // ============================================================

  private getDefaultRegion(league: EspnLeaguePayload): CompetitionRegion {
    const country = this.extractCountry(league);

    if (country && country.toLowerCase() === 'nigeria') {
      return CompetitionRegion.NIGERIA;
    }

    return CompetitionRegion.EUROPE;
  }

  private getDefaultCompetitionType(): CompetitionType {
    return CompetitionType.LEAGUE;
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private extractCountry(league: EspnLeaguePayload): string | undefined {
    const country: unknown = (league as { country?: unknown }).country;

    if (typeof country === 'string') {
      return this.getString(country);
    }

    if (country && typeof country === 'object') {
      const value = country as Record<string, unknown>;

      return (
        this.getString(value.name) ??
        this.getString(value.displayName) ??
        this.getString(value.abbreviation)
      );
    }

    return undefined;
  }

  private getString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim();

    return normalized || undefined;
  }

  private parseDate(value: unknown): Date | undefined {
    if (typeof value !== 'string' && !(value instanceof Date)) {
      return undefined;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return undefined;
    }

    return date;
  }

  private normalizeLeagueId(value?: string): string {
    if (typeof value !== 'string') {
      return '';
    }

    const normalized = value.trim().toLowerCase();

    /*
     * ESPN's canonical slug for the UEFA Women's Nations League is
     * `uefa.w.nations`. Some previously stored catalogue records may
     * contain the malformed alias `uefa.wnations`, which ESPN rejects
     * with HTTP 400. Normalize that legacy value before API requests,
     * database updates, and active-competition synchronization.
     */
    if (normalized === 'uefa.wnations') {
      return 'uefa.w.nations';
    }

    return normalized;
  }

  // ============================================================
  // CATALOGUE STATE
  // ============================================================

  async isLeagueCatalogueEmpty(): Promise<boolean> {
    const league = await this.espnLeagueModel
      .findOne({})
      .select({ _id: 1 })
      .lean()
      .exec();

    return !league;
  }
}
