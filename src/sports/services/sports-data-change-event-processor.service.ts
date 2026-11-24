import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
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
import { ODDS_CONFIG } from '../../odds/config/odds.config';
import { PREDICTION_ENGINE_CONFIG } from '../../predictions-engine/config/prediction-engine.config';

type FixtureIdRow = { id: string };
type PredictionFixtureRow = {
  id: string;
  kickoffAt?: Date | string;
  status?: { state?: string; isFinal?: boolean };
  competitors?: Array<{ homeAway?: string; teamId?: string }>;
};

const TERMINAL_PREDICTION_FIXTURE_STATES = new Set([
  'COMPLETED', 'POSTPONED', 'CANCELLED', 'CANCELED', 'ABANDONED',
  'LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES', 'IN_PROGRESS', 'INPLAY',
  'IN_PLAY', 'PLAYING', 'SUSPENDED', 'INTERRUPTED',
]);

/**
 * Drains the durable Sports source-data outbox and fans relevant changes into
 * Settlement, Sports derived projections, Grivit pricing and Prediction Engine.
 * Odds and Prediction receive independent durable jobs from the same source event;
 * neither consumer waits for the other to succeed or become ready.
 */
@Injectable()
export class SportsDataChangeEventProcessorService {
  private readonly logger = new Logger(
    SportsDataChangeEventProcessorService.name,
  );
  private readonly fixturePageSize = 100;
  private readonly oddsEnqueueConcurrency = 2;
  private readonly predictionEnqueueConcurrency = 2;

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

    const downstreamJobs: Array<Promise<unknown>> = [];

    // A pre-match fixture update is a Prediction/Odds input change, not a
    // settlement trigger. Keep Settlement restricted to live and final facts.
    // Settlement and projection handoffs are isolated as well: one downstream
    // outage must not prevent either pricing or baseline prediction refresh.
    if (
      [
        'FIXTURE',
        'MATCH_TIMELINE',
        'MATCH_STATISTICS',
        'MATCH_LINEUP',
      ].includes(event.entity) &&
      fixtureIds.length > 0
    ) {
      downstreamJobs.push((async () => {
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
      })());
      downstreamJobs.push(
        this.enqueueAffectedSeasonProjections(fixtureIds, event.eventId),
      );
    }

    downstreamJobs.push(this.enqueueAffectedOddsPricing(event, fixtureIds));
    downstreamJobs.push(this.enqueueAffectedPredictionRecalculations(event, fixtureIds));

    // These are separate durable consumer lanes. Promise.allSettled ensures an
    // Odds, Settlement or projection queue outage cannot prevent baseline
    // predictions (or vice versa). The outbox remains retryable until every
    // downstream handoff is durable; existing jobs are idempotently coalesced.
    const handoffs = await Promise.allSettled(downstreamJobs);
    const failures = handoffs.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length) {
      throw new Error(
        `Sports source event ${event.eventId} downstream handoff failed: ${failures
          .map((failure) => failure.reason instanceof Error ? failure.reason.message : String(failure.reason))
          .join('; ')}`,
      );
    }
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
    const directFixtureIds = this.unique([
      ...knownFixtureIds,
      ...(event.entity === 'MATCH_ODDS' ? [event.entityId] : []),
    ]);
    if (directFixtureIds.length) {
      await this.enqueueOddsPricingForIds(directFixtureIds, event);
    }
    if (event.entity === 'MATCH_ODDS') return;

    const relatedScope = await this.getAffectedUpcomingFixtureScope(
      event,
      knownFixtureIds,
    );
    if (!relatedScope) return;

    const now = new Date();
    await this.enqueueOddsPricingForQuery({
      ...relatedScope,
      kickoffAt: {
        $gt: now,
        $lte: new Date(now.getTime() + ODDS_CONFIG.pricingLookaheadHours * 60 * 60_000),
      },
      'status.state': { $nin: ['COMPLETED'] },
    }, event);
  }

  /**
   * Fan out source changes directly into the Prediction-owned consumer lane.
   * This path is intentionally independent of Grivit price readiness. Odds
   * price updates can still enqueue a later supplemental prediction refresh.
   */
  private async enqueueAffectedPredictionRecalculations(
    event: SportsDataChangedEvent,
    knownFixtureIds: string[],
  ): Promise<void> {
    const directFixtureIds = this.unique([
      ...knownFixtureIds,
      ...(event.entity === 'MATCH_ODDS' ? [event.entityId] : []),
    ]);
    if (directFixtureIds.length) {
      await this.enqueuePredictionRecalculationsForIds(directFixtureIds, event);
    }
    if (event.entity === 'MATCH_ODDS') return;

    const relatedScope = await this.getAffectedUpcomingFixtureScope(
      event,
      knownFixtureIds,
    );
    if (!relatedScope) return;

    const now = new Date();
    const horizonEnd = new Date(
      now.getTime() + PREDICTION_ENGINE_CONFIG.queue.forwardWindowHours * 60 * 60_000,
    );
    await this.enqueuePredictionRecalculationsForQuery({
      ...relatedScope,
      kickoffAt: { $gt: now, $lte: horizonEnd },
      'status.state': { $nin: [...TERMINAL_PREDICTION_FIXTURE_STATES] },
      'status.isFinal': { $ne: true },
    }, event);
  }

  /**
   * Resolve the source scopes affected by a normalized Sports change. Historical
   * fixture/statistics corrections fan out to the teams and competition whose
   * rolling projections they feed. Ordinary upcoming fixture edits only refresh
   * that fixture, avoiding a whole-competition recalculation on every schedule
   * timestamp update.
   */
  private async getAffectedUpcomingFixtureScope(
    event: SportsDataChangedEvent,
    knownFixtureIds: string[],
  ): Promise<Record<string, any> | undefined> {
    const directScopeEntities = new Set([
      'TEAM', 'TEAM_ROSTER', 'ATHLETE', 'COMPETITION', 'SEASON',
    ]);
    const historicalSourceEntities = new Set([
      'FIXTURE', 'MATCH_STATISTICS', 'MATCH_LINEUP', 'MATCH_TIMELINE',
    ]);
    let shouldExpand = directScopeEntities.has(event.entity);

    if (!shouldExpand && historicalSourceEntities.has(event.entity)) {
      const sourceFixtureIds = this.unique([
        ...knownFixtureIds,
        ...(event.entity === 'FIXTURE' ? [event.entityId] : []),
      ]);
      if (sourceFixtureIds.length) {
        const completed = await this.fixtureModel
          .find({
            id: { $in: sourceFixtureIds },
            $or: [{ 'status.state': 'COMPLETED' }, { 'status.isFinal': true }],
          })
          .select('id')
          .lean()
          .exec() as FixtureIdRow[];
        shouldExpand = completed.length > 0;
      }
    }
    if (!shouldExpand) return undefined;

    const teamIds = this.unique([
      ...(event.teamIds ?? []),
      ...(event.entity === 'TEAM' ? [event.entityId] : []),
    ]);
    const competitionIds = this.unique([
      ...(event.competitionIds ?? []),
      ...(event.entity === 'COMPETITION' ? [event.entityId] : []),
    ]);
    const seasonIds = this.unique([
      ...(event.seasonIds ?? []),
      ...(event.entity === 'SEASON' ? [event.entityId] : []),
    ]);
    const scopes: Record<string, unknown>[] = [];
    if (teamIds.length) scopes.push({ 'competitors.teamId': { $in: teamIds } });
    if (competitionIds.length) scopes.push({ competitionId: { $in: competitionIds } });
    if (seasonIds.length) scopes.push({ seasonId: { $in: seasonIds } });
    return scopes.length ? { $or: scopes } : undefined;
  }

  private async enqueuePredictionRecalculationsForIds(
    fixtureIds: string[],
    event: SportsDataChangedEvent,
  ): Promise<void> {
    const ids = this.unique(fixtureIds);
    if (!ids.length) return;
    const now = new Date();
    const horizonEnd = new Date(
      now.getTime() + PREDICTION_ENGINE_CONFIG.queue.forwardWindowHours * 60 * 60_000,
    );
    const rows = await this.fixtureModel
      .find({
        $or: [
          { id: { $in: ids } },
          { espnEventId: { $in: ids } },
        ],
        kickoffAt: { $gt: now, $lte: horizonEnd },
        'status.state': { $nin: [...TERMINAL_PREDICTION_FIXTURE_STATES] },
        'status.isFinal': { $ne: true },
      } as any)
      .select('id kickoffAt status competitors')
      .sort({ id: 1 })
      .lean()
      .exec() as PredictionFixtureRow[];
    await this.enqueuePredictionFixtureRows(rows, event);
  }

  private async enqueuePredictionRecalculationsForQuery(
    baseQuery: Record<string, any>,
    event: SportsDataChangedEvent,
  ): Promise<void> {
    let cursor: string | undefined;
    let scanned = 0;
    while (true) {
      const page = await this.fixtureModel
        .find({ ...baseQuery, ...(cursor ? { id: { $gt: cursor } } : {}) })
        .select('id kickoffAt status competitors')
        .sort({ id: 1 })
        .limit(this.fixturePageSize)
        .lean()
        .exec() as PredictionFixtureRow[];
      if (!page.length) break;
      await this.enqueuePredictionFixtureRows(page, event);
      scanned += page.length;
      cursor = String(page[page.length - 1].id);
      if (page.length < this.fixturePageSize) break;
    }
    if (scanned > 0) {
      this.logger.log(
        `Sports source event ${event.eventId} queued independent prediction refreshes across ${scanned} affected upcoming fixture(s).`,
      );
    }
  }

  private async enqueuePredictionFixtureRows(
    rows: PredictionFixtureRow[],
    event: SportsDataChangedEvent,
  ): Promise<void> {
    const now = Date.now();
    const horizonEnd = now + PREDICTION_ENGINE_CONFIG.queue.forwardWindowHours * 60 * 60_000;
    const eligible = rows.filter((row) => {
      const kickoff = row.kickoffAt instanceof Date
        ? row.kickoffAt
        : new Date(String(row.kickoffAt ?? ''));
      const state = String(row.status?.state ?? 'UNKNOWN').toUpperCase();
      const home = row.competitors?.find((item) => item.homeAway === 'HOME');
      const away = row.competitors?.find((item) => item.homeAway === 'AWAY');
      return Number.isFinite(kickoff.getTime())
        && kickoff.getTime() > now
        && kickoff.getTime() <= horizonEnd
        && !TERMINAL_PREDICTION_FIXTURE_STATES.has(state)
        && row.status?.isFinal !== true
        && Boolean(home?.teamId && away?.teamId);
    });
    if (!eligible.length) return;

    const scheduledFor = event.changedAt instanceof Date && Number.isFinite(event.changedAt.getTime())
      ? event.changedAt
      : new Date();
    for (let offset = 0; offset < eligible.length; offset += this.predictionEnqueueConcurrency) {
      const batch = eligible.slice(offset, offset + this.predictionEnqueueConcurrency);
      const results = await Promise.all(batch.map((fixture) => {
        const fixtureId = String(fixture.id);
        const sourceFingerprint = createHash('sha256')
          .update(`prediction-source
${event.eventId}
${event.entity}
${event.revision}
${fixtureId}`)
          .digest('hex');
        return this.queue.enqueueIfMissing({
          type: SportsQueueJobType.PREDICTION_ENGINE_RECALCULATION,
          scope: { fixtureId, sourceFingerprint },
          priority: 75,
          scheduledFor,
          triggerEventId: `prediction:source:${event.eventId}:${fixtureId}`,
        });
      }));
      const created = results.filter((result) => result.created).length;
      if (created > 0) {
        this.logger.debug(
          `Queued ${created}/${batch.length} independent prediction triggers for Sports source event ${event.eventId}.`,
        );
      }
    }
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
      await this.enqueueOddsPricingForIds(ids, event, {
        alreadyWithinPricingWindow: true,
      });
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
    options: { alreadyWithinPricingWindow?: boolean } = {},
  ): Promise<void> {
    const requestedIds = this.unique(fixtureIds);
    if (!requestedIds.length) return;

    let ids = requestedIds;
    if (!options.alreadyWithinPricingWindow) {
      const now = new Date();
      const horizonEnd = new Date(
        now.getTime() + ODDS_CONFIG.pricingLookaheadHours * 60 * 60_000,
      );
      const eligibleRows = (await this.fixtureModel
        .find({
          $or: [
            { id: { $in: requestedIds } },
            { espnEventId: { $in: requestedIds } },
          ],
          kickoffAt: { $gt: now, $lte: horizonEnd },
        })
        .select('id')
        .lean()
        .exec()) as FixtureIdRow[];
      ids = this.unique(eligibleRows.map((row) => String(row.id)));
    }

    if (!ids.length) return;
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



