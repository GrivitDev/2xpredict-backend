import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  ActiveCompetition,
  ActiveCompetitionDocument,
} from '../schemas/active-competition.schema';
import {
  EspnStanding,
  EspnStandingDocument,
} from '../schemas/espn/espn-standing.schema';
import { EspnQueueService } from './espn-queue.service';
import { EspnService } from '../providers/espn.service';
import { CompetitionPriority } from '../enums/competition-priority.enum';
import { getEspnStandingsPolicy } from '../config/priority-competitions.config';
import {
  EspnStandingsCollectionState,
  EspnStandingsCollectionStateDocument,
  EspnStandingsCollectionStatus,
} from '../schemas/espn/espn-standings-collection-state.schema';

/** Queued ESPN-only standings refresh. The provider response is stored verbatim. */
@Injectable()
export class EspnStandingsService {
  private readonly logger = new Logger(EspnStandingsService.name);

  constructor(
    private readonly espnQueueService: EspnQueueService,
    private readonly espnService: EspnService,
    @InjectModel(ActiveCompetition.name)
    private readonly activeCompetitionModel: Model<ActiveCompetitionDocument>,
    @InjectModel(EspnStanding.name)
    private readonly espnStandingModel: Model<EspnStandingDocument>,
    @InjectModel(EspnStandingsCollectionState.name)
    private readonly collectionStateModel: Model<EspnStandingsCollectionStateDocument>,
  ) {
    this.processQueuedRefresh = this.processQueuedRefresh.bind(this);
  }

  /** Queue refresh work durably; provider requests happen only in the worker. */
  scheduleRefresh(params: { leagueId: string; season: number }): void {
    const leagueId = this.normalize(params.leagueId);
    if (!leagueId || !Number.isInteger(params.season)) return;

    if (getEspnStandingsPolicy(leagueId) === 'NONE') {
      void this.markNotApplicable(leagueId, params.season).catch((error: unknown) => {
        this.logger.warn(
          `Could not persist not-applicable standings state ${leagueId}/${params.season}: ${this.errorMessage(error)}`,
        );
      });
      return;
    }

    void this.enqueueRefresh(leagueId, params.season).catch((error: unknown) => {
      this.logger.error(
        `Could not persist standings refresh ${leagueId}/${params.season}: ${this.errorMessage(error)}`,
      );
    });
  }

  private async enqueueRefresh(leagueId: string, season: number): Promise<void> {
    const competition = await this.activeCompetitionModel
      .findOne({ competitionId: leagueId })
      .select({ priority: 1, season: 1 })
      .lean()
      .exec();

    if (
      typeof competition?.season === 'number' &&
      competition.season !== season
    ) {
      return;
    }

    await this.espnQueueService.addStandingsRefreshJob({
      leagueId,
      season,
      priority: this.queuePriority(competition?.priority),
      scheduledFor: new Date(),
    });
  }

  /** Record that this competition format does not have a standings table. */
  async markNotApplicable(leagueIdValue: string, season: number): Promise<void> {
    const leagueId = this.normalize(leagueIdValue);
    if (!leagueId || !Number.isInteger(season)) return;

    const reason = `Standings not applicable for competition format: ${leagueId}/${season}`;
    await this.updateCollectionState(leagueId, season, {
      status: 'SKIPPED',
      lastReason: reason,
      lastErrorCode: null,
      nextRetryAt: null,
    });
    this.logger.debug(`Standings skipped: league=${leagueId} season=${season} reason=not-applicable`);
  }

  /** Called by the persistent queue worker. */
  async processQueuedRefresh(
    leagueIdValue: string,
    season: number,
  ): Promise<void> {
    const leagueId = this.normalize(leagueIdValue);
    if (!leagueId || !Number.isInteger(season)) return;

    if (getEspnStandingsPolicy(leagueId) === 'NONE') {
      await this.markNotApplicable(leagueId, season);
      const unavailable = new Error(
        `Standings are unavailable because ${leagueId} does not have a conventional standings table`,
      );
      unavailable.name = 'StandingsUnavailableError';
      throw unavailable;
    }

    const attemptedAt = new Date();
    await this.collectionStateModel.findOneAndUpdate(
      { leagueId, season },
      {
        $set: { status: 'COLLECTING', lastAttemptAt: attemptedAt, lastReason: null, lastErrorCode: null },
        $inc: { attempts: 1 },
        $setOnInsert: { leagueId, season, hasLastKnownSnapshot: false, discoveredStageIds: [], retrievedStageIds: [], missingStageIds: [], tableCount: 0, teamEntryCount: 0 },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).exec();

    try {
      const competition = await this.activeCompetitionModel
        .findOne({ competitionId: leagueId })
        .select({ season: 1 })
        .lean()
        .exec();
      if (typeof competition?.season === 'number' && competition.season !== season) {
        await this.updateCollectionState(leagueId, season, {
          status: 'SKIPPED',
          lastReason: `Inactive season; current season is ${competition.season}`,
          nextRetryAt: null,
        });
        this.logger.log(`Standings skipped: league=${leagueId} season=${season} reason=inactive-season`);
        return;
      }

      await this.refreshLeagueSeason(leagueId, season);
      const stored = await this.espnStandingModel
        .findOne({ leagueId, season, leagueName: { $exists: true }, fetchedAt: { $exists: true } })
        .select({ payload: 1, fetchedAt: 1 })
        .lean()
        .exec();
      if (!stored) {
        throw new Error(`ESPN standings refresh completed without a stored snapshot for ${leagueId}/${season}`);
      }

      const payload = stored.payload as Record<string, unknown> | undefined;
      const collectionMeta = payload?.standingsCollection && typeof payload.standingsCollection === 'object'
        ? payload.standingsCollection as Record<string, unknown>
        : {};
      const discoveredStageIds = this.stringArray(collectionMeta.discoveredStageIds);
      const retrievedStageIds = this.stringArray(collectionMeta.retrievedStageIds);
      const missingStageIds = this.stringArray(collectionMeta.missingStageIds);
      const tableCount = this.numberValue(collectionMeta.tableCount) ?? 0;
      const teamEntryCount = this.countTeamEntries(payload);
      const status: EspnStandingsCollectionStatus = missingStageIds.length > 0 ? 'PARTIAL' : 'AVAILABLE';
      const successAt = stored.fetchedAt instanceof Date ? stored.fetchedAt : new Date();

      const nextRetryAt = missingStageIds.length ? new Date(Date.now() + 15 * 60_000) : null;
      await this.updateCollectionState(leagueId, season, {
        status,
        lastSuccessAt: successAt,
        lastReason: missingStageIds.length
          ? `Some advertised standings stages were not retrieved: ${missingStageIds.join(', ')}`
          : null,
        lastErrorCode: null,
        nextRetryAt,
        discoveredStageIds,
        retrievedStageIds,
        missingStageIds,
        tableCount,
        teamEntryCount,
        hasLastKnownSnapshot: true,
      });
      if (missingStageIds.length > 0 && nextRetryAt) {
        const competitionForRetry = await this.activeCompetitionModel
          .findOne({ competitionId: leagueId })
          .select({ priority: 1 })
          .lean()
          .exec();
        const retryBucket = Math.floor(nextRetryAt.getTime() / (15 * 60_000));
        await this.espnQueueService.addStandingsRefreshJob({
          leagueId,
          season,
          priority: this.queuePriority(competitionForRetry?.priority),
          scheduledFor: nextRetryAt,
          triggerEventId: `STANDINGS_PARTIAL_RETRY:${season}:${retryBucket}`,
        });
        this.logger.warn(
          `Standings partial: league=${leagueId} season=${season} missing=${missingStageIds.join(',')} retryAt=${nextRetryAt.toISOString()}`,
        );
      }
      this.logger.log(
        `Standings stored: league=${leagueId} season=${season} status=${status} tables=${tableCount} entries=${teamEntryCount} stages=${retrievedStageIds.length}/${discoveredStageIds.length || 'unknown'} missing=${missingStageIds.length}`,
      );
    } catch (error) {
      const existing = await this.espnStandingModel
        .findOne({ leagueId, season })
        .select({ fetchedAt: 1, leagueName: 1 })
        .lean()
        .exec();
      const message = this.errorMessage(error).replace(/[\r\n]+/g, ' ').slice(0, 500);
      const noData = this.isConfirmedNoDataSignal(message);
      const policy = getEspnStandingsPolicy(leagueId);
      const hasSnapshot = Boolean(existing);
      const status: EspnStandingsCollectionStatus = hasSnapshot
        ? 'PARTIAL'
        : noData
          ? 'UNAVAILABLE'
          : 'FAILED';

      // An explicit no-table response is a data-availability outcome, not by
      // itself a provider outage. Preserve any previous snapshot and schedule
      // the next check at a cadence appropriate to this competition.
      const scheduledNoDataRetry = noData;
      const retryDelayMs = policy === 'REQUIRED' ? 60 * 60_000 : 12 * 60 * 60_000;
      const nextRetryAt = new Date(
        Date.now() + (scheduledNoDataRetry ? retryDelayMs : 15 * 60_000),
      );

      await this.updateCollectionState(leagueId, season, {
        status,
        lastReason: message,
        lastErrorCode: noData ? null : this.errorCode(error),
        nextRetryAt,
        hasLastKnownSnapshot: hasSnapshot,
      });

      if (scheduledNoDataRetry) {
        const competitionForRetry = await this.activeCompetitionModel
          .findOne({ competitionId: leagueId })
          .select({ priority: 1 })
          .lean()
          .exec();
        const retryBucket = Math.floor(nextRetryAt.getTime() / retryDelayMs);
        await this.espnQueueService.addStandingsRefreshJob({
          leagueId,
          season,
          priority: this.queuePriority(competitionForRetry?.priority),
          scheduledFor: nextRetryAt,
          triggerEventId: `STANDINGS_NO_DATA_RETRY:${season}:${retryBucket}`,
        });

        this.logger.warn(
          `Standings unavailable: league=${leagueId} season=${season} policy=${policy} snapshot=${hasSnapshot ? 'preserved' : 'none'} status=${status} retryAt=${nextRetryAt.toISOString()} reason=${message}`,
        );
        const unavailable = new Error(
          `Standings unavailable for ${leagueId}/${season}; ${hasSnapshot ? 'last known snapshot preserved; ' : ''}retry scheduled at ${nextRetryAt.toISOString()}`,
        );
        unavailable.name = 'StandingsUnavailableError';
        throw unavailable;
      }

      this.logger.warn(
        `Standings collection ${status.toLowerCase()}: league=${leagueId} season=${season} snapshot=${hasSnapshot ? 'preserved' : 'none'} retryAt=${nextRetryAt.toISOString()} reason=${message}`,
      );
      // Preserve the existing queue retry behaviour for genuine request failures
      // and for refreshes where a prior snapshot exists but could not be refreshed.
      throw error;
    }
  }

  private async updateCollectionState(
    leagueId: string,
    season: number,
    values: Partial<EspnStandingsCollectionState>,
  ): Promise<void> {
    await this.collectionStateModel.findOneAndUpdate(
      { leagueId, season },
      { $set: values },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).exec();
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
  }

  private numberValue(value: unknown): number | undefined {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private countTeamEntries(value: unknown): number {
    const visited = new Set<object>();
    const teams = new Set<string>();
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object' || visited.has(node as object)) return;
      visited.add(node as object);
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      const record = node as Record<string, unknown>;
      const standings = record.standings;
      if (standings && typeof standings === 'object' && !Array.isArray(standings)) {
        const entries = (standings as Record<string, unknown>).entries;
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue;
            const item = entry as Record<string, unknown>;
            const team = item.team && typeof item.team === 'object'
              ? item.team as Record<string, unknown>
              : undefined;
            const id = team?.id ?? item.id ?? item.uid;
            if (id !== undefined && id !== null) teams.add(String(id));
          }
        }
      }
      for (const [key, child] of Object.entries(record)) {
        if (key !== 'rawPayloads' && key !== 'standingsCollection') visit(child);
      }
    };
    visit(value);
    return teams.size;
  }

  private isConfirmedNoDataSignal(message: string): boolean {
    // Match explicit standings-data validation messages only. Generic 404/not
    // found responses can indicate a bad endpoint or provider failure and must
    // remain visible as real failures rather than being treated as empty data.
    return /ESPN standings unavailable: no usable table|ESPN returned an empty standings payload|empty response.*standings|no standings table/i.test(message);
  }

  private errorCode(error: unknown): string | null {
    if (!error || typeof error !== 'object') return null;
    const record = error as Record<string, unknown>;
    const response = record.response && typeof record.response === 'object'
      ? record.response as Record<string, unknown>
      : undefined;
    const status = response?.status ?? record.status;
    return status === undefined || status === null ? null : String(status).slice(0, 100);
  }

  private queuePriority(priority: unknown): number {
    switch (priority) {
      case CompetitionPriority.ELITE:
        return 1;
      case CompetitionPriority.HIGH:
        return 2;
      case CompetitionPriority.REGIONAL:
        return 3;
      default:
        return 4;
    }
  }

  /**
   * Settlement fallback: request standings directly only when no recent
   * canonical snapshot exists. The response is stored through the same path
   * used by the normal standings worker.
   */
  async refreshForSettlement(leagueIdValue: string, season: number, freshnessHours = 6): Promise<void> {
    const leagueId = this.normalize(leagueIdValue);
    if (!leagueId || !Number.isInteger(season)) return;
    if (getEspnStandingsPolicy(leagueId) === 'NONE') {
      await this.markNotApplicable(leagueId, season);
      return;
    }
    const freshAfter = new Date(
      Date.now() - Math.max(1, freshnessHours) * 60 * 60_000,
    );
    const cached = await this.espnStandingModel
      .findOne({ leagueId, season, fetchedAt: { $gte: freshAfter } })
      .select({ _id: 1 })
      .lean()
      .exec();
    if (cached) return;
    await this.refreshLeagueSeason(leagueId, season);
  }

  private async refreshLeagueSeason(
    leagueId: string,
    season: number,
  ): Promise<void> {
    const competition = await this.activeCompetitionModel
      .findOne({ competitionId: leagueId })
      .select({ competitionId: 1, name: 1, season: 1 })
      .lean()
      .exec();

    // Do not let a delayed job overwrite the active season with stale data.
    if (
      typeof competition?.season === 'number' &&
      competition.season !== season
    ) {
      this.logger.debug(
        `Skipped standings refresh for inactive season ${leagueId}/${season}`,
      );
      return;
    }

    // If ESPN fails or returns an unusable body, throw and leave the previous
    // successful document untouched. No Summary or fixture-results fallback.
    const response = await this.espnService.getStandings(leagueId, season);
    if (
      !response ||
      typeof response !== 'object' ||
      Array.isArray(response) ||
      Object.keys(response).length === 0
    ) {
      throw new Error(`ESPN returned an empty standings payload for ${leagueId}/${season}`);
    }

    const payload = response as Record<string, unknown>;
    const collectionMeta = payload.standingsCollection && typeof payload.standingsCollection === 'object'
      ? payload.standingsCollection as Record<string, unknown>
      : undefined;
    const tableCount = collectionMeta ? Number(collectionMeta.tableCount ?? 0) : this.countTeamEntries(payload);
    if (!Number.isFinite(tableCount) || tableCount <= 0) {
      throw new Error(`ESPN standings unavailable: no usable table for ${leagueId}/${season}`);
    }
    const providerName =
      typeof payload.name === 'string' && payload.name.trim()
        ? payload.name.trim()
        : undefined;
    const leagueName = providerName ?? competition?.name ?? leagueId;
    const fetchedAt = new Date();

    const update = {
      $set: { leagueId, season, leagueName, payload, fetchedAt },
    };

    // Prefer the new-format snapshot if one already exists. Otherwise upgrade
    // one legacy per-team row in place, or insert a fresh document.
    let stored = await this.espnStandingModel.findOneAndUpdate(
      { leagueId, season, leagueName: { $exists: true }, fetchedAt: { $exists: true } },
      update,
      { returnDocument: 'after', },
    ).exec();

    if (!stored) {
      const legacy = await this.espnStandingModel
        .findOne({ leagueId, season })
        .select({ _id: 1 })
        .lean()
        .exec();
      stored = legacy?._id
        ? await this.espnStandingModel.findOneAndUpdate(
            { _id: legacy._id },
            update,
            { returnDocument: 'after', },
          ).exec()
        : await this.espnStandingModel.findOneAndUpdate(
            { leagueId, season },
            update,
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
          ).exec();
    }

    // Remove legacy per-team fields/rows only after the complete ESPN payload
    // has been saved. Use the native collection for $unset because these legacy
    // fields are intentionally no longer part of the new Mongoose schema.
    // A failed provider request never deletes the last successful snapshot.
    if (stored?._id) {
      await this.espnStandingModel.collection.updateOne(
        { _id: stored._id },
        {
          $unset: {
            teamId: 1,
            groupId: 1,
            groupName: 1,
            stage: 1,
            sourceEventId: 1,
            sourceFixtureDate: 1,
            sourceSummaryCollectedAt: 1,
            sourceType: 1,
            lastFiveResults: 1,
            rank: 1,
            points: 1,
            played: 1,
            wins: 1,
            draws: 1,
            losses: 1,
            goalsFor: 1,
            goalsAgainst: 1,
            goalDifference: 1,
            form: 1,
            description: 1,
            collectedAt: 1,
          },
        },
      );
      await this.espnStandingModel.deleteMany({
        leagueId,
        season,
        _id: { $ne: stored._id },
      }).exec();
    }

    this.logger.debug(
      `ESPN standings snapshot persisted: league=${leagueId} season=${season} tables=${tableCount} rawStagePayloads=${Object.keys((payload.rawPayloads && typeof payload.rawPayloads === 'object') ? payload.rawPayloads as Record<string, unknown> : {}).length}`,
    );
  }

  private normalize(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}


