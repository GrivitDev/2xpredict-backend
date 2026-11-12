import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import type { SportsDataChangedEvent } from '../interfaces/sports-derived-data.interface';
import { SPORTS_COLLECTION_SCHEDULE } from '../config/sports-collection-schedule.config';
import { SportsDataChangeEventService } from './sports-data-change-event.service';
import { SettlementTriggerService } from '../../settlement/services/settlement-trigger.service';
import { SportsFixture } from '../schemas/domain/fixture.schema';
import { SportsSeason } from '../schemas/domain/season.schema';
import { SportsQueueJobType } from '../interfaces/sports-queue.interface';
import { SportsQueueService } from './sports-queue.service';

type FixtureIdRow = { id: string };

/**
 * Drains the durable Sports source-data outbox and fans relevant changes into
 * Settlement, Sports derived projections and Grivit pricing. Prediction Engine
 * is deliberately not called here: the Odds worker releases a durable
 * prediction-recalculation job only after the affected Grivit prices are ready.
 */
@Injectable()
export class SportsDataChangeEventProcessorService {
  private readonly logger = new Logger(
    SportsDataChangeEventProcessorService.name,
  );
  private readonly fixturePageSize = 100;
  private readonly oddsEnqueueConcurrency = 2;

  constructor(
    private readonly changeEvents: SportsDataChangeEventService,
    private readonly queue: SportsQueueService,
    @InjectModel(SportsFixture.name)
    private readonly fixtureModel: Model<SportsFixture>,
    @InjectModel(SportsSeason.name)
    private readonly seasonModel: Model<SportsSeason>,
    @Inject(forwardRef(() => SettlementTriggerService))
    private readonly settlementTrigger: SettlementTriggerService,
  ) {}

  /**
   * The outbox is acknowledged only after all downstream jobs have been
   * durably queued. A failed handoff remains retryable.
   */
  async drain(limit = 20, workerId = 'sports-outbox-worker'): Promise<number> {
    const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : 20;
    const boundedLimit = Math.max(1, Math.min(20, requestedLimit));
    await this.changeEvents.recoverExpiredProcessing(boundedLimit);
    const pending = await this.changeEvents.getPendingEvents(boundedLimit);
    const events = pending as unknown as SportsDataChangedEvent[];
    let processed = 0;

    // Keep outbox work sequential. The event is claimed immediately before it
    // is dispatched, so a slow event does not leave a large set of records in
    // PROCESSING while they wait for execution.
    for (const event of events) {
      const claimed = await this.changeEvents.markProcessing(
        event.eventId,
        workerId,
      );
      if (!claimed) continue;

      const heartbeat = setInterval(() => {
        void this.changeEvents
          .markHeartbeat(event.eventId, workerId, 120_000)
          .then((renewed) => {
            if (!renewed)
              this.logger.warn(
                `Outbox lease for ${event.eventId} is no longer owned by ${workerId}.`,
              );
          })
          .catch((error: unknown) => {
            this.logger.warn(
              `Could not renew outbox lease ${event.eventId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }, 30_000);
      (heartbeat as unknown as { unref?: () => void }).unref?.();

      try {
        await this.dispatch(event);
        await this.changeEvents.markCompleted(event.eventId, workerId);
        processed += 1;
      } catch (error) {
        const outcome = await this.changeEvents.markFailed(
          event.eventId,
          error,
          workerId,
        );
        this.logger.error(
          `Sports data-change event ${event.eventId} dispatch failed (${outcome}).`,
          error instanceof Error ? error.stack : undefined,
        );
      } finally {
        clearInterval(heartbeat);
      }
    }

    return processed;
  }

  private async dispatch(event: SportsDataChangedEvent): Promise<void> {
    const fixtureIds = this.unique([
      ...(event.fixtureIds ?? []),
      ...(event.entity === 'FIXTURE' ? [event.entityId] : []),
    ]);

    // A pre-match fixture update is a Prediction/Odds input change, not a
    // settlement trigger. Keep Settlement restricted to live and final facts.
    if (
      [
        'FIXTURE',
        'MATCH_TIMELINE',
        'MATCH_STATISTICS',
        'MATCH_LINEUP',
      ].includes(event.entity) &&
      fixtureIds.length > 0
    ) {
      const settleableIds = await this.getSettleableFixtureIds(fixtureIds);
      if (settleableIds.length > 0) {
        await this.settlementTrigger.onSportsDataChanged(
          settleableIds,
          event.entity as
            | 'FIXTURE'
            | 'MATCH_TIMELINE'
            | 'MATCH_STATISTICS'
            | 'MATCH_LINEUP',
        );
      }
      await this.enqueueAffectedSeasonProjections(fixtureIds, event.eventId);
    }

    // Grivit is repriced for every affected fixture. Its worker will then
    // publish a prediction trigger only if the resulting prices pass readiness.
    await this.enqueueAffectedOddsPricing(event, fixtureIds);
  }

  private async getSettleableFixtureIds(
    fixtureIds: string[],
  ): Promise<string[]> {
    const rows = (await this.fixtureModel
      .find({
        id: { $in: fixtureIds },
        $or: [
          {
            'status.state': {
              $in: ['LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES', 'COMPLETED'],
            },
          },
          { 'status.isFinal': true },
        ],
      })
      .select('id')
      .lean()
      .exec()) as FixtureIdRow[];
    return this.unique(rows.map((row) => row.id));
  }

  private async enqueueAffectedOddsPricing(
    event: SportsDataChangedEvent,
    knownFixtureIds: string[],
  ): Promise<void> {
    if (knownFixtureIds.length > 0) {
      await this.enqueueOddsPricingForIds(knownFixtureIds, event);
      return;
    }

    let query: Record<string, any> | undefined;
    if (
      event.entity === 'TEAM' ||
      event.entity === 'TEAM_ROSTER' ||
      event.entity === 'ATHLETE'
    ) {
      const teamIds = this.unique([
        ...(event.teamIds ?? []),
        ...(event.entity === 'TEAM' ? [event.entityId] : []),
      ]);
      if (!teamIds.length) {
        this.logger.warn(
          `Sports ${event.entity} event ${event.eventId} has no teamIds or fixtureIds; affected fixtures cannot be resolved.`,
        );
        return;
      }
      query = {
        'competitors.teamId': { $in: teamIds },
        kickoffAt: { $gte: new Date() },
        'status.state': {
          $nin: ['COMPLETED', 'POSTPONED', 'CANCELLED', 'ABANDONED'],
        },
      };
    } else if (event.entity === 'MATCH_ODDS') {
      const targetIds = this.unique([
        ...(event.fixtureIds ?? []),
        event.entityId,
      ]);
      await this.enqueueOddsPricingForIds(targetIds, event);
      return;
    } else if (event.entity === 'COMPETITION' || event.entity === 'SEASON') {
      const competitionIds = this.unique([
        ...(event.competitionIds ?? []),
        ...(event.entity === 'COMPETITION' ? [event.entityId] : []),
      ]);
      const seasonIds = this.unique([
        ...(event.seasonIds ?? []),
        ...(event.entity === 'SEASON' ? [event.entityId] : []),
      ]);
      const scopes: Record<string, unknown>[] = [];
      if (competitionIds.length)
        scopes.push({ competitionId: { $in: competitionIds } });
      if (seasonIds.length) scopes.push({ seasonId: { $in: seasonIds } });
      if (!scopes.length) return;
      query = {
        $or: scopes,
        kickoffAt: { $gte: new Date() },
        'status.state': {
          $nin: ['COMPLETED', 'POSTPONED', 'CANCELLED', 'ABANDONED'],
        },
      };
    }

    if (!query) return;
    await this.enqueueOddsPricingForQuery(query, event);
  }

  private async enqueueOddsPricingForQuery(
    baseQuery: Record<string, any>,
    event: SportsDataChangedEvent,
  ): Promise<void> {
    let cursor: string | undefined;
    let scanned = 0;

    while (true) {
      const page = (await this.fixtureModel
        .find({
          ...baseQuery,
          ...(cursor ? { id: { $gt: cursor } } : {}),
        })
        .select('id')
        .sort({ id: 1 })
        .limit(this.fixturePageSize)
        .lean()
        .exec()) as FixtureIdRow[];

      if (!page.length) break;
      const ids = page.map((row) => String(row.id));
      scanned += ids.length;
      await this.enqueueOddsPricingForIds(ids, event);
      cursor = ids[ids.length - 1];
      if (page.length < this.fixturePageSize) break;
    }

    if (scanned > 0) {
      this.logger.log(
        `Sports source event ${event.eventId} queued Grivit repricing for ${scanned} affected fixtures.`,
      );
    }
  }

  private async enqueueOddsPricingForIds(
    fixtureIds: string[],
    event: SportsDataChangedEvent,
  ): Promise<void> {
    const ids = this.unique(fixtureIds);
    for (
      let offset = 0;
      offset < ids.length;
      offset += this.oddsEnqueueConcurrency
    ) {
      const batch = ids.slice(offset, offset + this.oddsEnqueueConcurrency);
      const results = await Promise.all(
        batch.map((fixtureId) =>
          this.queue.enqueueIfNoActiveFixtureJob({
            type: SportsQueueJobType.ODDS_PRICING_RECALCULATION,
            scope: { fixtureId },
            priority: 65,
            scheduledFor: event.changedAt,
            triggerEventId: `odds:source:${event.eventId}:${fixtureId}`,
          }),
        ),
      );
      const created = results.filter((result) => result.created).length;
      if (created > 0) {
        this.logger.debug(
          `Queued ${created}/${batch.length} Grivit source-change jobs for ${event.eventId}.`,
        );
      }
    }
  }

  private async enqueueAffectedSeasonProjections(
    fixtureIds: string[],
    sourceEventId: string,
  ): Promise<void> {
    const fixtures = (await this.fixtureModel
      .find({
        id: { $in: fixtureIds },
        $or: [{ 'status.state': 'COMPLETED' }, { 'status.isFinal': true }],
      })
      .select('id competitionId seasonId')
      .lean()
      .exec()) as Array<{
      id: string;
      competitionId: string;
      seasonId?: string;
    }>;

    const competitionIds = [
      ...new Set(
        fixtures.map((fixture) => fixture.competitionId).filter(Boolean),
      ),
    ];
    if (!competitionIds.length) return;
    const currentSeasons = (await this.seasonModel
      .find({
        competitionId: { $in: competitionIds },
        isCurrent: true,
      })
      .select('competitionId id')
      .lean()
      .exec()) as Array<{
      competitionId: string;
      id: string;
    }>;
    const window = String(
      Math.floor(
        Date.now() / SPORTS_COLLECTION_SCHEDULE.derivedData.coalesceWindowMs,
      ),
    );
    const scopes = new Map<
      string,
      { competitionId: string; seasonId: string }
    >();

    // Rebuild the exact season containing each corrected/completed fixture.
    // Historical projections are retained and feed the rolling team history;
    // updating only the current season would leave those records stale.
    for (const fixture of fixtures) {
      if (!fixture.seasonId) continue;
      const key = `${fixture.competitionId}:${fixture.seasonId}`;
      scopes.set(key, {
        competitionId: fixture.competitionId,
        seasonId: fixture.seasonId,
      });
    }
    for (const season of currentSeasons) {
      const key = `${season.competitionId}:${season.id}`;
      scopes.set(key, {
        competitionId: season.competitionId,
        seasonId: season.id,
      });
    }

    for (const scope of scopes.values()) {
      await this.queue.enqueueIfMissing({
        type: SportsQueueJobType.DERIVED_DATA_RECALCULATION,
        scope: { ...scope, projectionWindow: window },
        priority: 55,
        scheduledFor: new Date(),
        triggerEventId: `derived:source:${sourceEventId}:${scope.competitionId}:${scope.seasonId}`,
      });
    }
  }

  private unique(values: string[]): string[] {
    return [
      ...new Set(
        values.map((value) => String(value ?? '').trim()).filter(Boolean),
      ),
    ];
  }
}
