import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CompetitionPriority } from '../enums/competition-priority.enum';

import {
  ActiveCompetitionStatus,
  ActiveCompetition,
} from '../interfaces/active-competition.interface';

import {
  ActiveCompetitionDocument,
  ActiveCompetition as ActiveCompetitionSchema,
} from '../schemas/active-competition.schema';

@Injectable()
export class ActiveCompetitionService {
  constructor(
    @InjectModel(ActiveCompetitionSchema.name)
    private readonly activeCompetitionModel: Model<ActiveCompetitionDocument>,
  ) {}

  // ============================================================
  // UPSERT
  // ============================================================

  async upsert(
    competition: Omit<ActiveCompetition, 'status' | 'lastUpdatedAt'>,
  ): Promise<ActiveCompetitionDocument> {
    const now = new Date();

    const normalizedCompetitionId = this.normalizeId(competition.competitionId);

    const normalizedEspnLeagueSlug = this.normalizeId(
      competition.espnLeagueSlug,
    );

    if (!normalizedCompetitionId) {
      throw new Error('competitionId is required');
    }

    if (!normalizedEspnLeagueSlug) {
      throw new Error('espnLeagueSlug is required');
    }

    const status = this.calculateStatus(
      competition.seasonStartDate,
      competition.seasonEndDate,
      competition.lastFixtureDate,
      competition.nextFixtureDate,
      now,
    );

    const update: Partial<ActiveCompetition> = {
      ...competition,

      competitionId: normalizedCompetitionId,

      espnLeagueSlug: normalizedEspnLeagueSlug,

      status,

      lastUpdatedAt: now,
    };

    return this.activeCompetitionModel
      .findOneAndUpdate(
        {
          competitionId: normalizedCompetitionId,
        },
        {
          $set: update,
        },
        {
          returnDocument: 'after',
          upsert: true,
          setDefaultsOnInsert: true,
        },
      )
      .exec();
  }

  // ============================================================
  // SYNC ESPN ACTIVE LEAGUE
  // ============================================================

  async syncLeague(params: {
    competitionId: string;
    espnLeagueSlug: string;
    name: string;
    type: ActiveCompetition['type'];
    region: ActiveCompetition['region'];
    priority: CompetitionPriority;
    footballDataCode?: string;
    oddsApiSportKey?: string;
    season?: number | null;
    seasonStartDate?: Date | null;
    seasonEndDate?: Date | null;
    lastFixtureDate?: Date | null;
    nextFixtureDate?: Date | null;
    espnPayload?: Record<string, unknown>;
  }): Promise<ActiveCompetitionDocument> {
    return this.upsert({
      competitionId: params.competitionId,

      espnLeagueSlug: params.espnLeagueSlug,

      name: params.name,

      type: params.type,

      region: params.region,

      priority: params.priority,

      footballDataCode: params.footballDataCode,

      oddsApiSportKey: params.oddsApiSportKey,

      season: params.season ?? undefined,

      seasonStartDate: params.seasonStartDate ?? undefined,

      seasonEndDate: params.seasonEndDate ?? undefined,

      lastFixtureDate: params.lastFixtureDate ?? undefined,

      nextFixtureDate: params.nextFixtureDate ?? undefined,

      espnPayload: params.espnPayload,
    });
  }

  // ============================================================
  // DELETE / REMOVE
  // ============================================================

  /**
   * Remove one competition from the operational active set.
   *
   * The complete ESPN catalogue remains untouched.
   */
  async removeByCompetitionId(competitionId: string): Promise<boolean> {
    const normalized = this.normalizeId(competitionId);

    if (!normalized) {
      return false;
    }

    const result = await this.activeCompetitionModel
      .deleteOne({
        competitionId: normalized,
      })
      .exec();

    return (result.deletedCount ?? 0) > 0;
  }

  /**
   * Synchronize the operational active set
   * against the authoritative current active IDs.
   *
   * When the supplied list is empty, every existing
   * active competition is removed.
   */
  async removeMissingCompetitions(
    existingCompetitionIds: string[],
  ): Promise<number> {
    const normalizedIds = [
      ...new Set(
        existingCompetitionIds
          .map((id) => this.normalizeId(id))
          .filter(Boolean),
      ),
    ];

    const filter =
      normalizedIds.length > 0
        ? {
            competitionId: {
              $nin: normalizedIds,
            },
          }
        : {};

    const result = await this.activeCompetitionModel.deleteMany(filter).exec();

    return result.deletedCount ?? 0;
  }

  // ============================================================
  // READS
  // ============================================================

  async getAll(): Promise<ActiveCompetitionDocument[]> {
    return this.activeCompetitionModel
      .find({})
      .sort({
        priority: 1,
        nextFixtureDate: 1,
        name: 1,
      })
      .exec();
  }

  async getActive(): Promise<ActiveCompetitionDocument[]> {
    return this.activeCompetitionModel
      .find({
        status: ActiveCompetitionStatus.ACTIVE,
      })
      .sort({
        priority: 1,
        nextFixtureDate: 1,
        name: 1,
      })
      .exec();
  }

  async getUpcoming(): Promise<ActiveCompetitionDocument[]> {
    return this.activeCompetitionModel
      .find({
        status: ActiveCompetitionStatus.UPCOMING,
      })
      .sort({
        priority: 1,
        nextFixtureDate: 1,
        name: 1,
      })
      .exec();
  }

  async getActiveOrUpcoming(): Promise<ActiveCompetitionDocument[]> {
    return this.activeCompetitionModel
      .find({
        status: {
          $in: [
            ActiveCompetitionStatus.ACTIVE,
            ActiveCompetitionStatus.UPCOMING,
          ],
        },
      })
      .sort({
        priority: 1,
        nextFixtureDate: 1,
        name: 1,
      })
      .exec();
  }

  async getPriorityActive(): Promise<ActiveCompetitionDocument[]> {
    return this.activeCompetitionModel
      .find({
        priority: {
          $in: [
            CompetitionPriority.ELITE,
            CompetitionPriority.HIGH,
            CompetitionPriority.REGIONAL,
          ],
        },

        status: ActiveCompetitionStatus.ACTIVE,
      })
      .sort({
        priority: 1,
        nextFixtureDate: 1,
        name: 1,
      })
      .exec();
  }

  async getFinished(): Promise<ActiveCompetitionDocument[]> {
    return this.activeCompetitionModel
      .find({
        status: ActiveCompetitionStatus.FINISHED,
      })
      .sort({
        priority: 1,
        name: 1,
      })
      .exec();
  }

  async getByCompetitionId(
    competitionId: string,
  ): Promise<ActiveCompetitionDocument | null> {
    const normalized = this.normalizeId(competitionId);

    if (!normalized) {
      return null;
    }

    return this.activeCompetitionModel
      .findOne({
        competitionId: normalized,
      })
      .exec();
  }

  async getByEspnLeagueSlug(
    espnLeagueSlug: string,
  ): Promise<ActiveCompetitionDocument | null> {
    const normalized = this.normalizeId(espnLeagueSlug);

    if (!normalized) {
      return null;
    }

    return this.activeCompetitionModel
      .findOne({
        espnLeagueSlug: normalized,
      })
      .exec();
  }

  // ============================================================
  // FIXTURE ACTIVITY
  // ============================================================

  async updateFixtureActivity(params: {
    competitionId: string;
    lastFixtureDate?: Date | null;
    nextFixtureDate?: Date | null;
    season?: number | null;
    seasonStartDate?: Date | null;
    seasonEndDate?: Date | null;
    espnPayload?: Record<string, unknown>;
  }): Promise<ActiveCompetitionDocument | null> {
    const competition = await this.getByCompetitionId(params.competitionId);

    if (!competition) {
      return null;
    }

    const now = new Date();

    if (params.season !== undefined) {
      competition.season = params.season ?? undefined;
    }

    if (params.seasonStartDate !== undefined) {
      competition.seasonStartDate = params.seasonStartDate ?? undefined;
    }

    if (params.seasonEndDate !== undefined) {
      competition.seasonEndDate = params.seasonEndDate ?? undefined;
    }

    if (params.lastFixtureDate !== undefined) {
      competition.lastFixtureDate = params.lastFixtureDate ?? undefined;
    }

    if (params.nextFixtureDate !== undefined) {
      competition.nextFixtureDate = params.nextFixtureDate ?? undefined;
    }

    if (params.espnPayload !== undefined) {
      competition.espnPayload = params.espnPayload;
    }

    const nextStatus = this.calculateStatus(
      competition.seasonStartDate,
      competition.seasonEndDate,
      competition.lastFixtureDate,
      competition.nextFixtureDate,
      now,
    );

    /*
     * sports_active_competitions is the
     * operational season source of truth.
     *
     * Once ESPN says the season is no
     * longer operationally active, remove
     * the record. The ESPN catalogue remains
     * available separately.
     */
    if (nextStatus !== ActiveCompetitionStatus.ACTIVE) {
      await this.removeByCompetitionId(competition.competitionId);

      return null;
    }

    competition.status = ActiveCompetitionStatus.ACTIVE;

    competition.lastUpdatedAt = now;

    return competition.save();
  }

  // ============================================================
  // STATUS REFRESH
  // ============================================================

  async refreshStatuses(): Promise<number> {
    const competitions = await this.activeCompetitionModel.find({}).exec();

    const now = new Date();

    let updated = 0;

    for (const competition of competitions) {
      const nextStatus = this.calculateStatus(
        competition.seasonStartDate,
        competition.seasonEndDate,
        competition.lastFixtureDate,
        competition.nextFixtureDate,
        now,
      );

      if (nextStatus !== ActiveCompetitionStatus.ACTIVE) {
        await this.removeByCompetitionId(competition.competitionId);

        updated += 1;

        continue;
      }

      if (competition.status !== ActiveCompetitionStatus.ACTIVE) {
        competition.status = ActiveCompetitionStatus.ACTIVE;

        competition.lastUpdatedAt = now;

        await competition.save();

        updated += 1;
      }
    }

    return updated;
  }

  // ============================================================
  // STATUS CALCULATION
  // ============================================================

  calculateStatus(
    seasonStartDate?: Date,
    seasonEndDate?: Date,
    lastFixtureDate?: Date,
    nextFixtureDate?: Date,
    now = new Date(),
  ): ActiveCompetitionStatus {
    /*
     * Season has not started.
     */
    if (seasonStartDate && now < new Date(seasonStartDate)) {
      return ActiveCompetitionStatus.UPCOMING;
    }

    /*
     * ESPN gives an end date and the season
     * has ended without another future fixture.
     */
    if (seasonEndDate && now > new Date(seasonEndDate) && !nextFixtureDate) {
      return ActiveCompetitionStatus.FINISHED;
    }

    /*
     * A future fixture means the current
     * season remains operational.
     */
    if (nextFixtureDate && new Date(nextFixtureDate) >= now) {
      return ActiveCompetitionStatus.ACTIVE;
    }

    /*
     * Current season is inside its explicit
     * start/end window.
     */
    if (
      seasonStartDate &&
      seasonEndDate &&
      now >= new Date(seasonStartDate) &&
      now <= new Date(seasonEndDate)
    ) {
      return ActiveCompetitionStatus.ACTIVE;
    }

    /*
     * ESPN may omit the season end date.
     * Keep the league operational when there
     * has been recent fixture activity.
     */
    if (
      seasonStartDate &&
      now >= new Date(seasonStartDate) &&
      !seasonEndDate &&
      lastFixtureDate
    ) {
      const elapsed = now.getTime() - new Date(lastFixtureDate).getTime();

      if (elapsed <= 7 * 24 * 60 * 60 * 1000) {
        return ActiveCompetitionStatus.ACTIVE;
      }
    }

    return ActiveCompetitionStatus.INACTIVE;
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private normalizeId(value?: string): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }
}
