import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { QueryFilter } from 'mongoose';

import type { SportsDataProvider } from '../interfaces/sports-domain.interface';
import { SportsQueue } from '../schemas/operations/sports-queue.schema';
import type { SportsQueueDocument } from '../schemas/operations/sports-queue.schema';
import {
  SportsQueueJobStatus,
  SportsQueueJobType,
} from '../interfaces/sports-queue.interface';
import {
  SportsCollectionState,
  SportsCollectionStateDocument,
  SportsCollectionScopeType,
  SportsFixtureValidationResult,
} from '../schemas/operations/sports-collection-state.schema';

export interface SportsCollectionStateInput {
  collectionType: string;
  scopeType: SportsCollectionScopeType;
  scopeId: string;
  provider?: SportsDataProvider;
  endpoint: string;
  intervalMs?: number;
  enabled?: boolean;
}

interface StaleCollectionStateRow {
  collectionKey?: string;
  lastStartedAt?: Date;
  collectionType?: string;
  scopeId?: string;
}

@Injectable()
export class SportsCollectionStateService {
  constructor(
    @InjectModel(SportsCollectionState.name)
    private readonly stateModel: Model<SportsCollectionStateDocument>,
    @InjectModel(SportsQueue.name)
    private readonly queueModel: Model<SportsQueueDocument>,
  ) {}

  async markStarted(input: SportsCollectionStateInput): Promise<void> {
    const now = new Date();
    const collectionKey = this.collectionKey(input);
    await this.stateModel
      .updateOne(
        { collectionKey },
        {
          $set: {
            collectionType: input.collectionType,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            provider: input.provider ?? 'ESPN',
            endpoint: input.endpoint,
            intervalMs: Math.max(0, input.intervalMs ?? 0),
            enabled: input.enabled ?? true,
            status: input.enabled === false ? 'DISABLED' : 'PROCESSING',
            lastStartedAt: now,
          },
          $setOnInsert: { collectionKey, failureCount: 0, dataRevision: 0 },
        },
        { upsert: true, runValidators: true },
      )
      .exec();
  }

  async markSucceeded(
    input: SportsCollectionStateInput,
    rawResponse?: Record<string, unknown>,
    endpointOverride?: string,
  ): Promise<Date | undefined> {
    // Raw provider envelopes are intentionally not retained here. Durable
    // domain records keep only the specific compact fallback fields required
    // by downstream calculations.
    void rawResponse;
    const now = new Date();
    const intervalMs = Math.max(0, input.intervalMs ?? 0);
    const enabled = input.enabled ?? true;
    const nextRunAt =
      enabled && intervalMs > 0
        ? new Date(now.getTime() + intervalMs)
        : undefined;

    await this.stateModel
      .updateOne(
        { collectionKey: this.collectionKey(input) },
        {
          $set: {
            collectionType: input.collectionType,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            provider: input.provider ?? 'ESPN',
            endpoint: endpointOverride ?? input.endpoint,
            intervalMs,
            enabled,
            status: enabled ? 'SUCCEEDED' : 'DISABLED',
            lastSuccessfulAt: now,
            nextRunAt: nextRunAt ?? null,
            failureCount: 0,
          },
          $unset: {
            lastError: 1,
            lastRawResponse: 1,
            lastRawResponseAt: 1,
            resultSummary: 1,
          },
          // dataRevision is incremented by $inc. Do not also initialise it
          // through $setOnInsert: MongoDB rejects two update operators that
          // target the same path. On an upsert, $inc creates the field at 1.
          $setOnInsert: { collectionKey: this.collectionKey(input) },
          $inc: { dataRevision: 1 },
        },
        { upsert: true, runValidators: true },
      )
      .exec();

    return nextRunAt;
  }

  /**
   * Records a completed provider check that found no published odds yet.
   * This is not a collection failure: the next independently scheduled
   * pre-match checkpoint will check again. No dataRevision is incremented
   * because no new odds snapshot was persisted.
   */
  async markNoData(
    input: SportsCollectionStateInput,
    reason: string,
    endpointOverride?: string,
    outcome = 'NO_ODDS_AVAILABLE',
  ): Promise<void> {
    const now = new Date();
    await this.stateModel
      .updateOne(
        { collectionKey: this.collectionKey(input) },
        {
          $set: {
            collectionType: input.collectionType,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            provider: input.provider ?? 'ESPN',
            endpoint: endpointOverride ?? input.endpoint,
            intervalMs: Math.max(0, input.intervalMs ?? 0),
            enabled: input.enabled ?? true,
            status: 'NO_DATA',
            nextRunAt: null,
            failureCount: 0,
            resultSummary: {
              outcome,
              reason: reason.replace(/[\r\n]+/g, ' ').slice(0, 1_000),
              checkedAt: now.toISOString(),
            },
          },
          $unset: { lastError: 1, lastRawResponse: 1, lastRawResponseAt: 1 },
          $setOnInsert: {
            collectionKey: this.collectionKey(input),
            dataRevision: 0,
          },
        },
        { upsert: true, runValidators: true },
      )
      .exec();
  }

  /**
   * Repairs abandoned collection-state records after the owning process has
   * disappeared. Queue leases are recovered separately; this closes the
   * operational-state lifecycle so a crashed worker cannot leave PROCESSING
   * records stuck forever.
   */
  async recoverStaleProcessing(
    staleAfterMs = 20 * 60_000,
    limit = 200,
  ): Promise<number> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - Math.max(60_000, staleAfterMs));
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const staleRows = await this.stateModel
      .find({
        provider: 'ESPN',
        status: 'PROCESSING',
        lastStartedAt: { $lte: cutoff },
      })
      .select({
        collectionKey: 1,
        lastStartedAt: 1,
        collectionType: 1,
        scopeId: 1,
      })
      .sort({ lastStartedAt: 1 })
      .limit(safeLimit)
      .lean()
      .exec();

    let recovered = 0;
    for (const row of staleRows as unknown as StaleCollectionStateRow[]) {
      const collectionKey = String(row.collectionKey ?? '');
      const lastStartedAt = row.lastStartedAt;
      if (!collectionKey || !(lastStartedAt instanceof Date)) continue;

      const activeJobFilter = this.activeQueueFilterForState(row);
      if (activeJobFilter) {
        const activeJob = await this.queueModel
          .findOne({
            ...activeJobFilter,
            status: SportsQueueJobStatus.PROCESSING,
            leaseExpiresAt: { $gt: now },
          })
          .select({ jobKey: 1 })
          .lean()
          .exec();
        // A live queue lease proves that a worker still owns this operation.
        // Never overwrite its PROCESSING state just because the operation is
        // unusually slow.
        if (activeJob) continue;
      }

      const result = await this.stateModel
        .updateOne(
          {
            collectionKey,
            provider: 'ESPN',
            status: 'PROCESSING',
            lastStartedAt,
          },
          {
            $set: {
              status: 'FAILED',
              lastError: `Recovered abandoned ${String(row.collectionType ?? 'collection')} state for ${String(row.scopeId ?? 'unknown scope')}; no completion was recorded before the stale-state deadline.`,
            },
            $unset: { resultSummary: 1 },
            $inc: { failureCount: 1 },
          },
        )
        .exec();
      recovered += Number(result.modifiedCount ?? 0);
    }
    return recovered;
  }

  async markFailed(
    input: SportsCollectionStateInput,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.stateModel
      .updateOne(
        { collectionKey: this.collectionKey(input) },
        {
          $set: {
            collectionType: input.collectionType,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            provider: input.provider ?? 'ESPN',
            endpoint: input.endpoint,
            intervalMs: Math.max(0, input.intervalMs ?? 0),
            enabled: input.enabled ?? true,
            status: 'FAILED',
            lastError: message.replace(/[\r\n]+/g, ' ').slice(0, 1_000),
          },
          $unset: { resultSummary: 1 },
          $inc: { failureCount: 1 },
          $setOnInsert: {
            collectionKey: this.collectionKey(input),
            dataRevision: 0,
          },
        },
        { upsert: true, runValidators: true },
      )
      .exec();
  }

  async recordFixtureDayValidation(input: {
    competitionId: string;
    seasonId: string;
    leagueId: string;
    date: string;
    endpoint: string;
    result: SportsFixtureValidationResult;
    receivedCount: number;
    persistedCount: number;
    missingCount: number;
    resultSummary?: Record<string, unknown>;
  }): Promise<void> {
    const collectionType = 'FIXTURE_DAILY_VALIDATION';
    const collectionKey = `${collectionType}:COMPETITION:${input.competitionId}:${input.seasonId}:${input.date}`;
    const now = new Date();

    await this.stateModel
      .updateOne(
        { collectionKey },
        {
          $set: {
            collectionKey,
            collectionType,
            scopeType: 'COMPETITION',
            scopeId: `${input.competitionId}:${input.seasonId}:${input.date}`,
            provider: 'ESPN',
            endpoint: input.endpoint,
            intervalMs: 0,
            enabled: true,
            status: input.result === 'INCOMPLETE' ? 'FAILED' : 'SUCCEEDED',
            lastStartedAt: now,
            ...(input.result === 'INCOMPLETE' ? {} : { lastSuccessfulAt: now }),
            validatedAt: now,
            validationResult: input.result,
            receivedCount: Math.max(0, input.receivedCount),
            persistedCount: Math.max(0, input.persistedCount),
            missingCount: Math.max(0, input.missingCount),
            resultSummary: {
              leagueId: input.leagueId,
              competitionId: input.competitionId,
              seasonId: input.seasonId,
              date: input.date,
              ...(input.resultSummary ?? {}),
            },
          },
          // dataRevision is initialised by $inc on insert and incremented on
          // every subsequent validation update.
          $setOnInsert: { failureCount: 0 },
          $inc: { dataRevision: 1 },
        },
        { upsert: true, runValidators: true },
      )
      .exec();
  }

  async getState(
    collectionType: string,
    scopeType: SportsCollectionScopeType,
    scopeId: string,
  ) {
    return this.stateModel
      .findOne({
        collectionKey: `${collectionType}:${scopeType}:${scopeId}`,
      })
      .lean()
      .exec();
  }

  async getSeasonMonthlyBootstrapState(seasonId: string) {
    return this.stateModel
      .findOne({
        collectionKey: `FIXTURE_MONTHLY_BOOTSTRAP_COMPLETE:SEASON:${seasonId}`,
      })
      .lean()
      .exec();
  }

  async getFixtureDayValidation(
    competitionId: string,
    seasonId: string,
    date: string,
  ) {
    return this.stateModel
      .findOne({
        collectionKey: `FIXTURE_DAILY_VALIDATION:COMPETITION:${competitionId}:${seasonId}:${date}`,
      })
      .lean()
      .exec();
  }

  async getSeasonValidatedDates(
    competitionId: string,
    seasonId: string,
  ): Promise<string[]> {
    const rows = await this.stateModel
      .find({
        collectionType: 'FIXTURE_DAILY_VALIDATION',
        'resultSummary.competitionId': competitionId,
        'resultSummary.seasonId': seasonId,
        validationResult: {
          $in: [
            'FIXTURES_FOUND',
            'NO_FIXTURES_CONFIRMED',
            'RECOVERED_FROM_SUMMARY',
          ],
        },
      })
      .select({ 'resultSummary.date': 1 })
      .lean()
      .exec();

    return rows
      .map((row: any) => String(row.resultSummary?.date ?? ''))
      .filter(Boolean);
  }

  private activeQueueFilterForState(
    row: StaleCollectionStateRow,
  ): QueryFilter<SportsQueueDocument> | null {
    const collectionType = String(row.collectionType ?? '');
    const scopeId = String(row.scopeId ?? '');
    const scopeParts = scopeId.split(':');
    switch (collectionType) {
      case 'MATCH_PLAYS':
        return {
          type: SportsQueueJobType.MATCH_PLAYS_COLLECTION,
          'scope.fixtureId': scopeId,
        };
      case 'MATCH_ODDS':
        return {
          type: SportsQueueJobType.MATCH_ODDS_REFRESH,
          'scope.fixtureId': scopeId,
        };
      case 'LIVE_SCOREBOARD':
        return {
          type: SportsQueueJobType.LIVE_SCOREBOARD_REFRESH,
          'scope.competitionId': scopeParts[0],
          'scope.calendarDate': scopeParts[1] ?? 'CURRENT',
        };
      case 'FIXTURE_MONTHLY_BOOTSTRAP':
        return {
          type: SportsQueueJobType.FIXTURE_SEASON_BOOTSTRAP,
          'scope.seasonId': scopeParts[0],
        };
      case 'FIXTURE_DAILY_SCOREBOARD':
        return {
          type: SportsQueueJobType.FIXTURE_DAILY_REFRESH,
          'scope.competitionId': scopeParts[0],
          'scope.calendarDate': scopeParts[2],
        };
      case 'FIXTURE_DAILY_VALIDATION':
        return {
          type: SportsQueueJobType.FIXTURE_DAILY_VALIDATION,
          'scope.competitionId': scopeParts[0],
          'scope.calendarDate': scopeParts[2],
        };
      case 'LEAGUE_CATALOGUE':
        return { type: SportsQueueJobType.LEAGUE_CATALOGUE_REFRESH };
      case 'LEAGUE_DETAILS':
        return {
          type: SportsQueueJobType.LEAGUE_DETAIL_REFRESH,
          'scope.leagueId': scopeId,
        };
      case 'SEASON_CATALOGUE':
        return {
          type: SportsQueueJobType.SEASON_CATALOGUE_REFRESH,
          'scope.competitionId': scopeId,
        };
      case 'TEAM_CATALOGUE':
        return {
          type: SportsQueueJobType.TEAM_CATALOGUE_REFRESH,
          'scope.competitionId': scopeId,
        };
      case 'TEAM_DETAILS':
        return {
          type: SportsQueueJobType.TEAM_DETAIL_REFRESH,
          'scope.teamId': scopeId.replace(/^team:/, ''),
        };
      default:
        return null;
    }
  }

  private collectionKey(input: SportsCollectionStateInput): string {
    return `${input.collectionType}:${input.scopeType}:${input.scopeId}`;
  }
}
