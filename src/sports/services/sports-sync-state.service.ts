// backend/src/sports/services/sports-sync-state.service.ts

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  SportsSyncState,
  SportsSyncStateDocument,
  SportsSyncStateKind,
  SportsSyncStateStatus,
  SportsSyncUnitStatus,
  SportsSyncUnitType,
} from '../schemas/sports-sync-state.schema';

import {
  EspnFixture,
  EspnFixtureDocument,
} from '../schemas/espn/espn-fixture.schema';

import { EspnQueueJobType } from '../interfaces/espn-queue.interface';

import { SPORTS_DATA_COLLECTION_CONFIG } from '../config/sports-data-collection.config';

@Injectable()
export class SportsSyncStateService {
  /**
   * Maximum number of lightweight fixture records MongoDB streams into
   * Node during Summary-state reconciliation. The actual ESPN payload is
   * never projected into the application process.
   */
  private readonly summaryFixtureCursorBatchSize = 500;

  /** Initial startup attempt plus configured background retries. */
  private readonly summaryTotalAttempts =
    SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.maxAttempts + 1;

  /** One startup attempt plus the configured retry budget for fixture months. */
  private readonly fixtureTotalAttempts =
    SPORTS_DATA_COLLECTION_CONFIG.ESPN.queue.maxAttempts + 1;

  constructor(
    @InjectModel(SportsSyncState.name)
    private readonly syncStateModel: Model<SportsSyncStateDocument>,

    @InjectModel(EspnFixture.name)
    private readonly espnFixtureModel: Model<EspnFixtureDocument>,
  ) {}

  // ============================================================
  // STATE KEY
  // ============================================================

  getQueueStateKey(params: {
    jobType: string;
    leagueId: string;
    season?: number;
    eventId?: string;
    triggerEventId?: string;
    queueJobKey?: string;
  }): string {
    const leagueId = this.normalize(params.leagueId);

    /*
     * FIXTURE_REFRESH and SUMMARY_REFRESH are persistent
     * league/season synchronization ledgers.
     *
     * Operational queue triggers such as:
     *
     *   DAILY:2026-09-26
     *   STALE:2026-09-26
     *   FINISHED:401884783
     *
     * never create another synchronization state.
     */
    if (
      String(params.jobType) === String(EspnQueueJobType.FIXTURE_REFRESH) ||
      String(params.jobType) === String(EspnQueueJobType.SUMMARY_REFRESH)
    ) {
      return [
        'QUEUE',
        params.jobType,
        leagueId,
        params.season ?? 'current',
      ].join(':');
    }

    /*
     * Other operational event-specific jobs may still have their
     * own state identity when explicitly required.
     */
    if (params.eventId) {
      return ['QUEUE', params.jobType, leagueId, params.eventId.trim()].join(
        ':',
      );
    }

    if (params.queueJobKey?.trim()) {
      return ['QUEUE', params.jobType, params.queueJobKey.trim()].join(':');
    }

    return ['QUEUE', params.jobType, leagueId, params.season ?? 'current'].join(
      ':',
    );
  }

  getCronStateKey(taskKey: string): string {
    return `CRON:${taskKey}`;
  }

  // ============================================================
  // QUEUE STATE
  // ============================================================

  async ensureQueueState(params: {
    jobType: string;
    leagueId: string;
    season?: number;
    eventId?: string;
    priority: number;
    trackingMode: 'WINDOW' | 'HISTORY';
    queueJobKey?: string;
    triggerEventId?: string;
  }): Promise<SportsSyncStateDocument> {
    const stateKey = this.getQueueStateKey(params);

    const isPersistentLeagueSeasonState =
      String(params.jobType) === String(EspnQueueJobType.FIXTURE_REFRESH) ||
      String(params.jobType) === String(EspnQueueJobType.SUMMARY_REFRESH);

    return this.syncStateModel
      .findOneAndUpdate(
        {
          stateKey,
        },
        {
          $set: {
            kind: SportsSyncStateKind.QUEUE,

            jobType: params.jobType,

            leagueId: this.normalize(params.leagueId),

            season: params.season,

            priority: params.priority,

            trackingMode: params.trackingMode,

            ...(isPersistentLeagueSeasonState
              ? {}
              : {
                  eventId: params.eventId,
                }),

            ...(params.queueJobKey
              ? {
                  lastQueueJobKey: params.queueJobKey,
                }
              : {}),
          },

          ...(isPersistentLeagueSeasonState
            ? {
                $unset: {
                  eventId: 1,
                },
              }
            : {}),

          $setOnInsert: {
            stateKey,

            status: SportsSyncStateStatus.PENDING,

            units: [],

            consecutiveFailures: 0,
          },
        },
        {
          upsert: true,
          returnDocument: 'after',
          setDefaultsOnInsert: true,
        },
      )
      .exec();
  }

  // ============================================================
  // FIXTURE REFRESH STATE
  // ============================================================

  /**
   * Keeps one persistent FIXTURE_REFRESH state for a league/season.
   *
   * The queue owns operational windows and triggers.
   * This state owns the permanent record of synchronized fixture
   * dates.
   *
   * This method does not call ESPN.
   */
  async ensureFixtureRefreshState(params: {
    leagueId: string;
    season: number;
    priority: number;
    dateFrom: string;
    dateTo: string;
    trackingMode?: 'WINDOW' | 'HISTORY';
    granularity?: 'DAY' | 'MONTH';
  }): Promise<SportsSyncStateDocument> {
    const leagueId = this.normalize(params.leagueId);

    if (!leagueId) {
      throw new Error('Fixture refresh state requires a valid league ID');
    }

    if (typeof params.season !== 'number') {
      throw new Error(
        `Fixture refresh state for ${leagueId} requires a valid season`,
      );
    }

    const requestedDateFrom = this.normalizeDateOnly(params.dateFrom);
    const requestedDateTo = this.normalizeDateOnly(params.dateTo);

    if (requestedDateFrom > requestedDateTo) {
      throw new Error(
        `Invalid fixture synchronization range for ${leagueId}: ` +
          `${requestedDateFrom} -> ${requestedDateTo}`,
      );
    }

    const trackingMode = params.trackingMode ?? 'HISTORY';
    const granularity = params.granularity ?? 'DAY';

    const stateKey = this.getQueueStateKey({
      jobType: EspnQueueJobType.FIXTURE_REFRESH,
      leagueId,
      season: params.season,
    });

    await this.ensureQueueState({
      jobType: EspnQueueJobType.FIXTURE_REFRESH,
      leagueId,
      season: params.season,
      priority: params.priority,
      trackingMode,
    });

    let state = await this.requireState(stateKey);

    const effectiveDateFrom =
      trackingMode === 'HISTORY' && state.dateFrom
        ? this.minDateOnly(state.dateFrom, requestedDateFrom)
        : requestedDateFrom;

    const effectiveDateTo =
      trackingMode === 'HISTORY' && state.dateTo
        ? this.maxDateOnly(state.dateTo, requestedDateTo)
        : requestedDateTo;

    state.fixtureGranularity = granularity;

    if (granularity === 'MONTH') {
      await this.ensureMonthWindow({
        stateKey,
        dateFrom: effectiveDateFrom,
        dateTo: effectiveDateTo,
        trackingMode,
      });
    } else {
      await this.ensureDateWindow({
        stateKey,
        dateFrom: effectiveDateFrom,
        dateTo: effectiveDateTo,
        trackingMode,
      });

      state = await this.requireState(stateKey);

      /*
       * A runtime date refresh can safely infer SUCCESS from an
       * already-persisted fixture for the exact date. This optimization
       * is intentionally NOT used for MONTH units because an empty ESPN
       * month response is a valid successful synchronization.
       */
      const fixtureDateKeys = await this.getFixtureDateKeys({
        leagueId,
        season: params.season,
        dateFrom: effectiveDateFrom,
        dateTo: effectiveDateTo,
      });

      let changed = false;

      for (const unit of state.units) {
        if (
          unit.type !== SportsSyncUnitType.DATE ||
          !unit.dateKey ||
          !fixtureDateKeys.has(unit.dateKey)
        ) {
          continue;
        }

        if (unit.status === SportsSyncUnitStatus.SUCCESS) {
          continue;
        }

        unit.status = SportsSyncUnitStatus.SUCCESS;
        unit.completedAt = new Date();
        unit.startedAt = undefined;
        unit.nextAttemptAt = undefined;
        unit.lastError = undefined;
        changed = true;
      }

      const nextStatus = this.calculateOverallStatus(state);

      if (state.status !== nextStatus) {
        state.status = nextStatus;
        changed = true;
      }

      if (state.status === SportsSyncStateStatus.SUCCESS) {
        state.lastSuccessfulAt = new Date();
        state.lastCompletedAt = new Date();
        state.lastError = undefined;
        state.consecutiveFailures = 0;
      }

      if (changed) {
        state.markModified('units');
        await state.save();
      }
    }

    return this.requireState(stateKey);
  }

  // ============================================================
  // SUMMARY REFRESH STATE
  // ============================================================

  /**
   * Keeps one persistent SUMMARY_REFRESH state for a league/season.
   *
   * MongoDB fixtures are the source of truth when reconciling the
   * persistent synchronization ledger.
   *
   * Every persisted ESPN fixture becomes:
   *
   *   STEP:SUMMARY:<eventId>
   *
   * Existing Summary:
   *
   *   SUCCESS
   *
   * Missing Summary:
   *
   *   PENDING / FAILED
   *
   * This method does not call ESPN.
   */
  async ensureSummaryRefreshState(params: {
    leagueId: string;
    season: number;
    priority: number;
    trackingMode?: 'WINDOW' | 'HISTORY';
    kickoffWindowStart?: Date;
    kickoffWindowEnd?: Date;
  }): Promise<SportsSyncStateDocument> {
    const leagueId = this.normalize(params.leagueId);

    if (!leagueId) {
      throw new Error('Summary refresh state requires a valid league ID');
    }

    if (typeof params.season !== 'number') {
      throw new Error(
        `Summary refresh state for ${leagueId} requires a valid season`,
      );
    }

    const trackingMode = params.trackingMode ?? 'HISTORY';

    const stateKey = this.getQueueStateKey({
      jobType: EspnQueueJobType.SUMMARY_REFRESH,

      leagueId,

      season: params.season,
    });

    await this.ensureQueueState({
      jobType: EspnQueueJobType.SUMMARY_REFRESH,

      leagueId,

      season: params.season,

      priority: params.priority,

      trackingMode,
    });

    const state = await this.requireState(stateKey);

    /*
     * Read every fixture for this league/season once.
     *
     * This is the source of truth for whether a Summary actually
     * exists in the canonical sports_espn_fixtures collection.
     */
    const fixtureCursor = this.espnFixtureModel
      .aggregate<{
        eventId?: string;
        hasSummary?: boolean;
      }>([
        {
          $match: {
            leagueId,
            season: params.season,
            ...(params.trackingMode === 'WINDOW' &&
            params.kickoffWindowStart &&
            params.kickoffWindowEnd
              ? {
                  fixtureDate: {
                    $gte: params.kickoffWindowStart,
                    $lte: params.kickoffWindowEnd,
                  },
                }
              : {}),
          },
        },
        {
          $project: {
            _id: 0,
            eventId: 1,
            hasSummary: {
              $cond: [
                { $eq: [{ $type: '$payload.summary' }, 'object'] },
                {
                  $gt: [
                    {
                      $size: {
                        $objectToArray: {
                          $ifNull: ['$payload.summary', {}],
                        },
                      },
                    },
                    0,
                  ],
                },
                false,
              ],
            },
          },
        },
      ])
      .cursor({
        batchSize: this.summaryFixtureCursorBatchSize,
      });

    /*
     * Existing synchronization units are indexed once so that
     * reconciling thousands of fixtures does not repeatedly scan
     * the entire state.units array.
     */
    const existingUnits = new Map(
      state.units
        .filter(
          (unit) =>
            unit.type === SportsSyncUnitType.STEP &&
            typeof unit.stepKey === 'string' &&
            unit.stepKey.startsWith('SUMMARY:'),
        )
        .map((unit) => [unit.stepKey as string, unit]),
    );

    let changed = false;

    for await (const fixture of fixtureCursor) {
      const rawEventId = (fixture as { eventId?: unknown }).eventId;
      const eventId =
        typeof rawEventId === 'string'
          ? rawEventId.trim()
          : typeof rawEventId === 'number' && Number.isFinite(rawEventId)
            ? String(rawEventId)
            : '';

      if (!eventId) {
        continue;
      }

      const stepKey = this.getSummaryStepKey(eventId);

      const hasSummary =
        (fixture as { hasSummary?: boolean }).hasSummary === true;

      const existing = existingUnits.get(stepKey);

      if (!existing) {
        const unit = {
          key: `STEP:${stepKey}`,

          type: SportsSyncUnitType.STEP,

          stepKey,

          status: hasSummary
            ? SportsSyncUnitStatus.SUCCESS
            : SportsSyncUnitStatus.PENDING,

          attempts: 0,

          ...(hasSummary
            ? {
                completedAt: new Date(),
              }
            : {}),
        };

        state.units.push(unit);

        existingUnits.set(stepKey, unit);

        changed = true;

        continue;
      }

      /*
       * MongoDB says the Summary exists.
       *
       * The state must agree with MongoDB regardless of the
       * previous state recorded for this event.
       */
      if (hasSummary) {
        if (existing.status !== SportsSyncUnitStatus.SUCCESS) {
          existing.status = SportsSyncUnitStatus.SUCCESS;

          existing.completedAt = new Date();

          existing.startedAt = undefined;

          existing.nextAttemptAt = undefined;

          existing.lastError = undefined;

          changed = true;
        }

        continue;
      }

      /*
       * MongoDB says the Summary does not exist.
       *
       * A previous SUCCESS can no longer remain SUCCESS.
       *
       * FAILED is preserved so the retry/error history remains
       * visible. PROCESSING is left for resetInterruptedUnits()
       * to recover immediately afterward.
       */
      if (existing.status === SportsSyncUnitStatus.SUCCESS) {
        existing.status = SportsSyncUnitStatus.PENDING;

        existing.startedAt = undefined;

        existing.completedAt = undefined;

        existing.nextAttemptAt = undefined;

        existing.lastError = undefined;

        changed = true;
      }
    }

    const nextStatus =
      state.units.filter(
        (unit) =>
          unit.type === SportsSyncUnitType.STEP &&
          typeof unit.stepKey === 'string' &&
          unit.stepKey.startsWith('SUMMARY:'),
      ).length === 0
        ? SportsSyncStateStatus.SUCCESS
        : this.calculateOverallStatus(state);

    if (state.status !== nextStatus) {
      state.status = nextStatus;
      changed = true;
    }

    if (nextStatus === SportsSyncStateStatus.SUCCESS) {
      state.lastSuccessfulAt = new Date();
      state.lastCompletedAt = new Date();
      state.lastError = undefined;
      state.consecutiveFailures = 0;
    }

    if (changed) {
      state.markModified('units');
      await state.save();
    }

    return state;
  }

  /**
   * Ensures one Summary event unit exists inside the persistent
   * league/season Summary state.
   *
   * This remains useful for normal queue processing when a specific
   * event is discovered independently of startup reconciliation.
   */
  async ensureSummaryEventState(params: {
    leagueId: string;
    season: number;
    eventId: string;
    priority: number;
    hasSummary?: boolean;
    trackingMode?: 'WINDOW' | 'HISTORY';
  }): Promise<SportsSyncStateDocument> {
    const leagueId = this.normalize(params.leagueId);
    const eventId = String(params.eventId).trim();

    if (!leagueId) {
      throw new Error('Summary event state requires a valid league ID');
    }
    if (typeof params.season !== 'number') {
      throw new Error('Summary event state requires a valid season');
    }
    if (!eventId) {
      throw new Error('Summary event state requires a valid event ID');
    }

    const stateKey = this.getQueueStateKey({
      jobType: EspnQueueJobType.SUMMARY_REFRESH,
      leagueId,
      season: params.season,
    });

    await this.ensureQueueState({
      jobType: EspnQueueJobType.SUMMARY_REFRESH,
      leagueId,
      season: params.season,
      priority: params.priority,
      trackingMode: params.trackingMode ?? 'HISTORY',
    });

    const stepKey = this.getSummaryStepKey(eventId);
    const unitKey = `STEP:${stepKey}`;
    let changed = false;

    // Insert only if another concurrent caller has not already created this unit.
    const initialUnitStatus =
      params.hasSummary === true
        ? SportsSyncUnitStatus.SUCCESS
        : SportsSyncUnitStatus.PENDING;
    const inserted = await this.syncStateModel
      .updateOne(
        {
          stateKey,
          units: { $not: { $elemMatch: { key: unitKey } } },
        },
        {
          $push: {
            units: {
              key: unitKey,
              type: SportsSyncUnitType.STEP,
              stepKey,
              status: initialUnitStatus,
              attempts: 0,
              ...(params.hasSummary === true
                ? { completedAt: new Date() }
                : {}),
            },
          },
        },
      )
      .exec();
    changed = inserted.modifiedCount > 0;

    if (params.hasSummary === true) {
      const result = await this.syncStateModel
        .updateOne(
          {
            stateKey,
            units: {
              $elemMatch: {
                key: unitKey,
                status: { $ne: SportsSyncUnitStatus.SUCCESS },
              },
            },
          },
          {
            $set: {
              'units.$.status': SportsSyncUnitStatus.SUCCESS,
              'units.$.completedAt': new Date(),
            },
            $unset: {
              'units.$.startedAt': 1,
              'units.$.nextAttemptAt': 1,
              'units.$.lastError': 1,
            },
          },
        )
        .exec();
      changed = changed || result.modifiedCount > 0;
    } else {
      // Do not reset a currently-running worker merely because a queue builder
      // observed that the Summary has not yet been persisted.
      const result = await this.syncStateModel
        .updateOne(
          {
            stateKey,
            units: {
              $elemMatch: {
                key: unitKey,
                status: SportsSyncUnitStatus.SUCCESS,
              },
            },
          },
          {
            $set: { 'units.$.status': SportsSyncUnitStatus.PENDING },
            $unset: {
              'units.$.startedAt': 1,
              'units.$.completedAt': 1,
              'units.$.nextAttemptAt': 1,
              'units.$.lastError': 1,
            },
          },
        )
        .exec();
      changed = changed || result.modifiedCount > 0;
    }

    if (changed) {
      await this.refreshOverallStatus(stateKey);
    }

    return this.requireState(stateKey);
  }

  /**
   * Marks all summary events participating in the current startup
   * batch as PROCESSING in one state-document write.
   */
  async markSummaryEventsProcessing(
    stateKey: string,
    eventIds: string[],
  ): Promise<void> {
    const normalizedEventIds = [
      ...new Set(
        eventIds.map((eventId) => String(eventId).trim()).filter(Boolean),
      ),
    ];
    if (normalizedEventIds.length === 0) return;

    const stepKeys = normalizedEventIds.map((eventId) =>
      this.getSummaryStepKey(eventId),
    );
    const state = await this.syncStateModel
      .findOne({ stateKey })
      .select({
        stateKey: 1,
        'units.type': 1,
        'units.stepKey': 1,
        'units.status': 1,
      })
      .lean()
      .exec();

    if (!state) {
      throw new Error(`Sports synchronization state ${stateKey} was not found`);
    }

    const statusByStepKey = new Map<string, SportsSyncUnitStatus>();
    for (const unit of state.units ?? []) {
      if (unit.type === SportsSyncUnitType.STEP && unit.stepKey) {
        statusByStepKey.set(unit.stepKey, unit.status);
      }
    }

    for (const stepKey of stepKeys) {
      if (!statusByStepKey.has(stepKey)) {
        throw new Error(
          `Summary synchronization unit ${stepKey} does not exist in ${stateKey}`,
        );
      }
    }

    const pendingStepKeys = stepKeys.filter(
      (stepKey) =>
        statusByStepKey.get(stepKey) !== SportsSyncUnitStatus.SUCCESS,
    );
    if (pendingStepKeys.length === 0) return;

    const now = new Date();
    await this.syncStateModel
      .updateOne(
        {
          stateKey,
          units: {
            $elemMatch: {
              type: SportsSyncUnitType.STEP,
              stepKey: { $in: pendingStepKeys },
              status: { $ne: SportsSyncUnitStatus.SUCCESS },
            },
          },
        },
        {
          $set: {
            status: SportsSyncStateStatus.PROCESSING,
            'units.$[unit].status': SportsSyncUnitStatus.PROCESSING,
            'units.$[unit].startedAt': now,
          },
          $unset: {
            'units.$[unit].completedAt': 1,
            'units.$[unit].nextAttemptAt': 1,
            'units.$[unit].lastError': 1,
          },
          $inc: {
            'units.$[unit].attempts': 1,
          },
        },
        {
          arrayFilters: [
            {
              'unit.type': SportsSyncUnitType.STEP,
              'unit.stepKey': { $in: pendingStepKeys },
              'unit.status': { $ne: SportsSyncUnitStatus.SUCCESS },
            },
          ],
        },
      )
      .exec();
  }

  /**
   * Records that one individual ESPN Summary request completed
   * successfully.
   *
   * This write is intentionally immediate so the synchronization
   * ledger shows live progress while the actual fixture document
   * waits for the final league/season bulkWrite().
   *
   * SUCCESS here means:
   *
   *   ESPN request completed successfully.
   *
   * It does not mean:
   *
   *   fixture persistence completed.
   *
   * If the final bulkWrite fails, markSummaryBulkWriteFailed()
   * returns these successful fetch units to FAILED.
   */
  async markSummaryEventFetchSuccess(
    stateKey: string,
    eventId: string,
  ): Promise<void> {
    const stepKey = this.getSummaryStepKey(eventId);

    const now = new Date();

    const result = await this.syncStateModel
      .updateOne(
        {
          stateKey,

          'units.key': `STEP:${stepKey}`,
        },
        {
          $set: {
            'units.$.status': SportsSyncUnitStatus.SUCCESS,

            'units.$.completedAt': now,
          },

          $unset: {
            'units.$.startedAt': 1,

            'units.$.nextAttemptAt': 1,

            'units.$.lastError': 1,
          },
        },
      )
      .exec();

    if (result.matchedCount === 0) {
      throw new Error(
        `Summary synchronization unit ${stepKey} does not exist in ${stateKey}`,
      );
    }
  }

  /**
   * Records one individual ESPN Summary fetch failure immediately.
   */
  /**
   * Marks a bounded group of successfully persisted Summary events as
   * SUCCESS in one MongoDB update. The fixture payloads must already have
   * been persisted before this method is called.
   */
  async markSummaryEventFetchSuccessBatch(
    stateKey: string,
    eventIds: string[],
  ): Promise<void> {
    const normalizedEventIds = [
      ...new Set(
        eventIds.map((eventId) => String(eventId).trim()).filter(Boolean),
      ),
    ];

    if (normalizedEventIds.length === 0) {
      return;
    }

    const stepKeys = normalizedEventIds.map((eventId) =>
      this.getSummaryStepKey(eventId),
    );

    const now = new Date();

    const result = await this.syncStateModel
      .updateOne(
        { stateKey },
        {
          $set: {
            'units.$[unit].status': SportsSyncUnitStatus.SUCCESS,
            'units.$[unit].completedAt': now,
          },
          $unset: {
            'units.$[unit].startedAt': 1,
            'units.$[unit].nextAttemptAt': 1,
            'units.$[unit].lastError': 1,
          },
        },
        {
          arrayFilters: [
            {
              'unit.type': SportsSyncUnitType.STEP,
              'unit.stepKey': { $in: stepKeys },
            },
          ],
        },
      )
      .exec();

    if (result.matchedCount === 0) {
      throw new Error(
        `Summary synchronization state ${stateKey} was not found`,
      );
    }
  }

  async markSummaryEventFetchFailed(
    stateKey: string,
    eventId: string,
    error: unknown,
  ): Promise<void> {
    const stepKey = this.getSummaryStepKey(eventId);
    const unitKey = `STEP:${stepKey}`;
    const state = await this.syncStateModel
      .findOne({ stateKey, 'units.key': unitKey }, { 'units.$': 1 })
      .lean()
      .exec();
    const unit = state?.units?.[0];

    if (!unit) {
      throw new Error(
        `Summary synchronization unit ${stepKey} does not exist in ${stateKey}`,
      );
    }

    // Do not let a delayed failure overwrite a unit completed by another worker.
    if (unit.status !== SportsSyncUnitStatus.PROCESSING) return;

    const message = error instanceof Error ? error.message : String(error);
    const attemptNumber = Math.max(1, unit.attempts ?? 0);
    const terminal = attemptNumber >= this.summaryTotalAttempts;
    const nextAttemptAt = terminal
      ? undefined
      : new Date(Date.now() + this.getRetryDelay(attemptNumber));

    const set: Record<string, unknown> = {
      'units.$.status': SportsSyncUnitStatus.FAILED,
      'units.$.lastError': message,
      status: SportsSyncStateStatus.PARTIAL,
      lastError: message,
    };
    const unset: Record<string, 1> = {
      'units.$.startedAt': 1,
      'units.$.completedAt': 1,
    };
    if (nextAttemptAt) {
      set['units.$.nextAttemptAt'] = nextAttemptAt;
    } else {
      unset['units.$.nextAttemptAt'] = 1;
    }

    await this.syncStateModel
      .updateOne(
        {
          stateKey,
          units: {
            $elemMatch: {
              key: unitKey,
              status: SportsSyncUnitStatus.PROCESSING,
              attempts: unit.attempts ?? 0,
            },
          },
        },
        {
          $set: set,
          $unset: unset,
          $inc: { consecutiveFailures: 1 },
        },
      )
      .exec();
  }

  /**
   * The ESPN calls may all have completed successfully while the
   * final fixture bulkWrite fails.
   *
   * Every fetched Summary belonging to that bulk batch is therefore
   * returned to FAILED.
   *
   * The next startup reconciliation checks the actual fixture
   * collection and restores SUCCESS for any Summary that really
   * exists in MongoDB.
   */
  async markSummaryBulkWriteFailed(
    stateKey: string,
    eventIds: string[],
    error: unknown,
  ): Promise<void> {
    const normalizedEventIds = [
      ...new Set(
        eventIds.map((eventId) => String(eventId).trim()).filter(Boolean),
      ),
    ];
    if (normalizedEventIds.length === 0) return;

    const state = await this.syncStateModel
      .findOne({ stateKey })
      .select({
        stateKey: 1,
        'units.key': 1,
        'units.stepKey': 1,
        'units.type': 1,
        'units.status': 1,
        'units.attempts': 1,
      })
      .lean()
      .exec();
    if (!state) {
      throw new Error(`Sports synchronization state ${stateKey} was not found`);
    }

    const unitByStepKey = new Map(
      (state.units ?? [])
        .filter(
          (unit) =>
            unit.type === SportsSyncUnitType.STEP &&
            typeof unit.stepKey === 'string',
        )
        .map((unit) => [unit.stepKey as string, unit]),
    );
    const message = error instanceof Error ? error.message : String(error);

    // The caller persists at most one configured persistence batch at a time.
    // Use targeted atomic writes so a large shared units array is never saved.
    await Promise.all(
      normalizedEventIds.map(async (eventId) => {
        const stepKey = this.getSummaryStepKey(eventId);
        const unit = unitByStepKey.get(stepKey);
        if (!unit) return;

        const attempts = unit.attempts ?? 0;
        const terminal = attempts >= this.summaryTotalAttempts;
        const nextAttemptAt = terminal
          ? undefined
          : new Date(Date.now() + this.getRetryDelay(Math.max(1, attempts)));
        const set: Record<string, unknown> = {
          status: SportsSyncStateStatus.PARTIAL,
          lastError: message,
          'units.$.status': SportsSyncUnitStatus.FAILED,
          'units.$.lastError': message,
        };
        const unset: Record<string, 1> = {
          'units.$.startedAt': 1,
          'units.$.completedAt': 1,
        };
        if (nextAttemptAt) {
          set['units.$.nextAttemptAt'] = nextAttemptAt;
        } else {
          unset['units.$.nextAttemptAt'] = 1;
        }

        await this.syncStateModel
          .updateOne(
            {
              stateKey,
              units: {
                $elemMatch: {
                  key: `STEP:${stepKey}`,
                  attempts,
                  status: {
                    $in: [
                      SportsSyncUnitStatus.PROCESSING,
                      SportsSyncUnitStatus.SUCCESS,
                    ],
                  },
                },
              },
            },
            {
              $set: set,
              $unset: unset,
              $inc: { consecutiveFailures: 1 },
            },
          )
          .exec();
      }),
    );
  }

  /**
   * Returns the synchronization unit key used for one Summary
   * event inside SUMMARY_REFRESH.
   *
   * Example:
   *
   *   SUMMARY:401884783
   */
  getSummaryStepKey(eventId: string): string {
    const normalizedEventId = String(eventId).trim();

    if (!normalizedEventId) {
      throw new Error('Summary synchronization requires an event ID');
    }

    return `SUMMARY:${normalizedEventId}`;
  }

  /**
   * Returns Summary event IDs that still require work and have not
   * exhausted the configured total-attempt budget.
   */
  async getIncompleteSummaryEvents(
    stateKey: string,
    limit?: number,
  ): Promise<string[]> {
    const state = await this.requireState(stateKey);

    const events = state.units
      .filter(
        (unit) =>
          unit.type === SportsSyncUnitType.STEP &&
          typeof unit.stepKey === 'string' &&
          unit.stepKey.startsWith('SUMMARY:') &&
          (unit.status === SportsSyncUnitStatus.PENDING ||
            unit.status === SportsSyncUnitStatus.FAILED) &&
          unit.attempts < this.summaryTotalAttempts,
      )
      .map((unit) => String(unit.stepKey).slice('SUMMARY:'.length))
      .filter(Boolean)
      .sort();

    return limit && limit > 0 ? events.slice(0, limit) : events;
  }

  /**
   * Returns Summary event IDs that have never been attempted.
   *
   * Startup uses this to guarantee exactly one initial attempt.
   */
  async getSummaryEventIdsInWindow(
    stateKey: string,
    kickoffWindowStart: Date,
    kickoffWindowEnd: Date,
  ): Promise<Set<string>> {
    const state = await this.requireState(stateKey);
    if (!state.leagueId || !Number.isInteger(state.season)) return new Set();

    const rows = await this.espnFixtureModel
      .find({
        leagueId: state.leagueId,
        season: state.season,
        // Startup callers pass season-start as the lower bound. Do not
        // exclude live or completed fixtures: the startup phase must reconcile
        // every fixture in the requested season-date range.
        fixtureDate: { $gte: kickoffWindowStart, $lte: kickoffWindowEnd },
      })
      .select({ _id: 0, eventId: 1 })
      .lean()
      .exec();

    return new Set(
      rows
        .map((row) =>
          String((row as { eventId?: unknown }).eventId ?? '').trim(),
        )
        .filter(Boolean),
    );
  }

  async getInitialSummaryEvents(
    stateKey: string,
    limit?: number,
    eligibleEventIds?: ReadonlySet<string>,
  ): Promise<string[]> {
    const state = await this.requireState(stateKey);

    const events = state.units
      .filter(
        (unit) =>
          unit.type === SportsSyncUnitType.STEP &&
          typeof unit.stepKey === 'string' &&
          unit.stepKey.startsWith('SUMMARY:') &&
          unit.status === SportsSyncUnitStatus.PENDING &&
          unit.attempts === 0,
      )
      .map((unit) => String(unit.stepKey).slice('SUMMARY:'.length))
      .filter(
        (eventId) =>
          Boolean(eventId) &&
          (!eligibleEventIds || eligibleEventIds.has(eventId)),
      )
      .sort();

    return limit && limit > 0 ? events.slice(0, limit) : events;
  }

  async getDueIncompleteSummaryEvents(
    stateKey: string,
    limit?: number,
  ): Promise<string[]> {
    const state = await this.requireState(stateKey);

    const now = Date.now();

    const events = state.units
      .filter(
        (unit) =>
          unit.type === SportsSyncUnitType.STEP &&
          typeof unit.stepKey === 'string' &&
          unit.stepKey.startsWith('SUMMARY:') &&
          (unit.status === SportsSyncUnitStatus.PENDING ||
            unit.status === SportsSyncUnitStatus.FAILED) &&
          unit.attempts < this.summaryTotalAttempts,
      )
      .filter((unit) => {
        if (!unit.nextAttemptAt) {
          return true;
        }

        return new Date(unit.nextAttemptAt).getTime() <= now;
      })
      .map((unit) => String(unit.stepKey).slice('SUMMARY:'.length))
      .filter(Boolean)
      .sort();

    return limit && limit > 0 ? events.slice(0, limit) : events;
  }

  async getNextIncompleteSummaryRetryAt(
    stateKey: string,
  ): Promise<Date | null> {
    const state = await this.requireState(stateKey);

    const now = Date.now();
    let earliest: number | null = null;

    for (const unit of state.units) {
      if (
        unit.type !== SportsSyncUnitType.STEP ||
        typeof unit.stepKey !== 'string' ||
        !unit.stepKey.startsWith('SUMMARY:') ||
        (unit.status !== SportsSyncUnitStatus.PENDING &&
          unit.status !== SportsSyncUnitStatus.FAILED) ||
        unit.attempts >= this.summaryTotalAttempts ||
        !unit.nextAttemptAt
      ) {
        continue;
      }

      const retryAt = new Date(unit.nextAttemptAt).getTime();

      if (retryAt <= now) {
        continue;
      }

      if (earliest === null || retryAt < earliest) {
        earliest = retryAt;
      }
    }

    return earliest === null ? null : new Date(earliest);
  }

  async isSummaryComplete(stateKey: string): Promise<boolean> {
    const state = await this.requireState(stateKey);

    const summaryUnits = state.units.filter(
      (unit) =>
        unit.type === SportsSyncUnitType.STEP &&
        typeof unit.stepKey === 'string' &&
        unit.stepKey.startsWith('SUMMARY:'),
    );

    return summaryUnits.every(
      (unit) =>
        unit.status === SportsSyncUnitStatus.SUCCESS ||
        (unit.status === SportsSyncUnitStatus.FAILED &&
          unit.attempts >= this.summaryTotalAttempts),
    );
  }

  async isSummaryEventComplete(
    stateKey: string,
    eventId: string,
  ): Promise<boolean> {
    const stepKey = this.getSummaryStepKey(eventId);

    const state = await this.syncStateModel
      .findOne(
        {
          stateKey,
          'units.key': `STEP:${stepKey}`,
        },
        {
          'units.$': 1,
        },
      )
      .lean()
      .exec();

    const unit = state?.units?.[0];

    return Boolean(
      unit &&
      (unit.status === SportsSyncUnitStatus.SUCCESS ||
        (unit.status === SportsSyncUnitStatus.FAILED &&
          unit.attempts >= this.summaryTotalAttempts)),
    );
  }

  // ============================================================
  // GENERAL STATE
  // ============================================================

  async getState(stateKey: string): Promise<SportsSyncStateDocument | null> {
    return this.syncStateModel
      .findOne({
        stateKey,
      })
      .exec();
  }

  async requireState(stateKey: string): Promise<SportsSyncStateDocument> {
    const state = await this.getState(stateKey);

    if (!state) {
      throw new Error(`Sports synchronization state ${stateKey} was not found`);
    }

    return state;
  }

  async getIncompleteQueueStates(
    jobTypes?: string[],
  ): Promise<SportsSyncStateDocument[]> {
    const query: Record<string, unknown> = {
      kind: SportsSyncStateKind.QUEUE,

      status: {
        $ne: SportsSyncStateStatus.SUCCESS,
      },
    };

    if (jobTypes && jobTypes.length > 0) {
      query.jobType = {
        $in: jobTypes,
      };
    }

    return this.syncStateModel
      .find(query)
      .sort({
        priority: 1,
        updatedAt: 1,
      })
      .exec();
  }

  // ============================================================
  // DATE WINDOW
  // ============================================================

  async ensureDateWindow(params: {
    stateKey: string;
    dateFrom: string;
    dateTo: string;
    trackingMode: 'WINDOW' | 'HISTORY';
  }): Promise<SportsSyncStateDocument> {
    const state = await this.requireState(params.stateKey);

    const desiredDateFrom = this.normalizeDateOnly(params.dateFrom);
    const desiredDateTo = this.normalizeDateOnly(params.dateTo);

    if (desiredDateFrom > desiredDateTo) {
      throw new Error(
        `Invalid date window: ${desiredDateFrom} -> ${desiredDateTo}`,
      );
    }

    const existingDateUnits = new Map(
      state.units
        .filter((unit) => unit.type === SportsSyncUnitType.DATE)
        .map((unit) => [unit.dateKey ?? unit.key, unit]),
    );

    const existingMonthUnits = state.units.filter(
      (unit) => unit.type === SportsSyncUnitType.MONTH,
    );

    const existingStepUnits = state.units.filter(
      (unit) => unit.type === SportsSyncUnitType.STEP,
    );

    const effectiveDateFrom =
      params.trackingMode === 'HISTORY' && state.dateFrom
        ? this.minDateOnly(state.dateFrom, desiredDateFrom)
        : desiredDateFrom;

    const effectiveDateTo =
      params.trackingMode === 'HISTORY' && state.dateTo
        ? this.maxDateOnly(state.dateTo, desiredDateTo)
        : desiredDateTo;

    const effectiveDates = this.buildDateRange(
      effectiveDateFrom,
      effectiveDateTo,
    );

    const effectiveDateUnits = effectiveDates.map((dateKey) => {
      const existing = existingDateUnits.get(dateKey);

      if (existing) {
        return existing;
      }

      return {
        key: `DATE:${dateKey}`,
        type: SportsSyncUnitType.DATE,
        dateKey,
        status: SportsSyncUnitStatus.PENDING,
        attempts: 0,
      };
    });

    state.dateFrom = effectiveDateFrom;
    state.dateTo = effectiveDateTo;
    state.trackingMode = params.trackingMode;
    state.fixtureGranularity = 'DAY';

    if (params.trackingMode === 'HISTORY') {
      const desiredDateSet = new Set(effectiveDates);
      const historicalDateUnits = state.units.filter(
        (unit) =>
          unit.type === SportsSyncUnitType.DATE &&
          unit.dateKey &&
          !desiredDateSet.has(unit.dateKey),
      );

      state.units = [
        ...historicalDateUnits,
        ...effectiveDateUnits,
        ...existingMonthUnits,
        ...existingStepUnits,
      ];
    } else {
      state.units = [
        ...effectiveDateUnits,
        ...existingMonthUnits,
        ...existingStepUnits,
      ];
    }

    state.status = this.calculateOverallStatus(state);
    state.markModified('units');

    await state.save();

    return state;
  }

  // ============================================================
  // MONTH WINDOW
  // ============================================================

  async ensureMonthWindow(params: {
    stateKey: string;
    dateFrom: string;
    dateTo: string;
    trackingMode: 'WINDOW' | 'HISTORY';
  }): Promise<SportsSyncStateDocument> {
    const state = await this.requireState(params.stateKey);

    const desiredDateFrom = this.normalizeDateOnly(params.dateFrom);
    const desiredDateTo = this.normalizeDateOnly(params.dateTo);

    if (desiredDateFrom > desiredDateTo) {
      throw new Error(
        `Invalid month synchronization window: ${desiredDateFrom} -> ${desiredDateTo}`,
      );
    }

    const effectiveDateFrom =
      params.trackingMode === 'HISTORY' && state.dateFrom
        ? this.minDateOnly(state.dateFrom, desiredDateFrom)
        : desiredDateFrom;

    const effectiveDateTo =
      params.trackingMode === 'HISTORY' && state.dateTo
        ? this.maxDateOnly(state.dateTo, desiredDateTo)
        : desiredDateTo;

    const monthKeys = this.buildMonthRange(effectiveDateFrom, effectiveDateTo);

    const existingMonthUnits = new Map(
      state.units
        .filter((unit) => unit.type === SportsSyncUnitType.MONTH)
        .map((unit) => [unit.monthKey ?? unit.key, unit]),
    );

    const effectiveMonthUnits = monthKeys.map((monthKey) => {
      const existing = existingMonthUnits.get(monthKey);

      if (existing) {
        return existing;
      }

      return {
        key: `MONTH:${monthKey}`,
        type: SportsSyncUnitType.MONTH,
        monthKey,
        status: SportsSyncUnitStatus.PENDING,
        attempts: 0,
      };
    });

    const existingStepUnits = state.units.filter(
      (unit) => unit.type === SportsSyncUnitType.STEP,
    );

    /*
     * MONTH startup state deliberately drops legacy historical DATE units.
     * This is an intentional migration from the previous daily startup
     * ledger and prevents old season-sized DATE arrays from surviving the
     * new deployment.
     */
    state.units = [...effectiveMonthUnits, ...existingStepUnits];

    state.dateFrom = effectiveDateFrom;
    state.dateTo = effectiveDateTo;
    state.trackingMode = params.trackingMode;
    state.fixtureGranularity = 'MONTH';
    state.status = this.calculateOverallStatus(state);
    state.markModified('units');

    await state.save();

    return state;
  }

  // ============================================================
  // GENERIC STEP UNITS
  // ============================================================

  async ensureStepUnits(
    stateKey: string,
    stepKeys: string[],
  ): Promise<SportsSyncStateDocument> {
    const state = await this.requireState(stateKey);

    const existingSteps = new Map(
      state.units
        .filter((unit) => unit.type === SportsSyncUnitType.STEP)
        .map((unit) => [unit.stepKey ?? unit.key, unit]),
    );

    for (const stepKey of stepKeys) {
      if (existingSteps.has(stepKey)) {
        continue;
      }

      existingSteps.set(stepKey, {
        key: `STEP:${stepKey}`,

        type: SportsSyncUnitType.STEP,

        stepKey,

        status: SportsSyncUnitStatus.PENDING,

        attempts: 0,
      });
    }

    const dateUnits = state.units.filter(
      (unit) => unit.type === SportsSyncUnitType.DATE,
    );

    const monthUnits = state.units.filter(
      (unit) => unit.type === SportsSyncUnitType.MONTH,
    );

    state.units = [...monthUnits, ...dateUnits, ...existingSteps.values()];

    state.status = this.calculateOverallStatus(state);

    state.markModified('units');

    await state.save();

    return state;
  }

  /** Reopens a tracked step after a new source payload arrives. */
  async resetStepForRefresh(stateKey: string, stepKey: string): Promise<void> {
    const unitKey = `STEP:${stepKey}`;
    const state = await this.syncStateModel
      .findOne({ stateKey, 'units.key': unitKey }, { 'units.$': 1 })
      .lean()
      .exec();

    if (!state?.units?.length) {
      throw new Error(
        `Synchronization step ${stepKey} does not exist in ${stateKey}`,
      );
    }

    // Leave active work alone; a source refresh can re-open the step once the
    // current worker has finished or the stale-work recovery has released it.
    const result = await this.syncStateModel
      .updateOne(
        {
          stateKey,
          units: {
            $elemMatch: {
              key: unitKey,
              status: { $ne: SportsSyncUnitStatus.PROCESSING },
            },
          },
        },
        {
          $set: {
            status: SportsSyncStateStatus.PENDING,
            'units.$.status': SportsSyncUnitStatus.PENDING,
            consecutiveFailures: 0,
          },
          $unset: {
            lastError: 1,
            'units.$.startedAt': 1,
            'units.$.completedAt': 1,
            'units.$.nextAttemptAt': 1,
            'units.$.lastError': 1,
          },
        },
      )
      .exec();

    if (result.modifiedCount > 0) {
      await this.refreshOverallStatus(stateKey);
    }
  }

  // ============================================================
  // INTERRUPTED UNIT RECOVERY
  // ============================================================

  async resetInterruptedUnits(
    stateKey: string,
    staleBefore?: Date,
  ): Promise<void> {
    const stateExists = await this.syncStateModel.exists({ stateKey });
    if (!stateExists) {
      throw new Error(`Sports synchronization state ${stateKey} was not found`);
    }

    const unitFilter: Record<string, unknown> = {
      'unit.status': SportsSyncUnitStatus.PROCESSING,
    };
    const unitMatch: Record<string, unknown> = {
      status: SportsSyncUnitStatus.PROCESSING,
    };
    if (staleBefore) {
      unitFilter.$or = [
        { 'unit.startedAt': { $lte: staleBefore } },
        { 'unit.startedAt': { $exists: false } },
      ];
      unitMatch.$or = [
        { startedAt: { $lte: staleBefore } },
        { startedAt: { $exists: false } },
      ];
    }

    await this.syncStateModel
      .updateOne(
        {
          stateKey,
          units: { $elemMatch: unitMatch },
        },
        {
          $set: {
            status: SportsSyncStateStatus.PARTIAL,
            'units.$[unit].status': SportsSyncUnitStatus.PENDING,
          },
          $unset: {
            'units.$[unit].startedAt': 1,
            'units.$[unit].nextAttemptAt': 1,
          },
        },
        { arrayFilters: [unitFilter] },
      )
      .exec();
  }

  // ============================================================
  // MONTH STATE
  // ============================================================

  async getIncompleteMonths(stateKey: string): Promise<string[]> {
    const state = await this.requireState(stateKey);

    return state.units
      .filter(
        (unit) =>
          unit.type === SportsSyncUnitType.MONTH &&
          (unit.status === SportsSyncUnitStatus.PENDING ||
            unit.status === SportsSyncUnitStatus.FAILED) &&
          unit.attempts < this.fixtureTotalAttempts,
      )
      .map((unit) => unit.monthKey)
      .filter((month): month is string => Boolean(month))
      .sort();
  }

  async getDueIncompleteMonths(
    stateKey: string,
    limit?: number,
  ): Promise<string[]> {
    const state = await this.requireState(stateKey);
    const now = Date.now();

    const months = state.units
      .filter(
        (unit) =>
          unit.type === SportsSyncUnitType.MONTH &&
          (unit.status === SportsSyncUnitStatus.PENDING ||
            unit.status === SportsSyncUnitStatus.FAILED) &&
          unit.attempts < this.fixtureTotalAttempts,
      )
      .filter((unit) => {
        if (!unit.nextAttemptAt) {
          return true;
        }

        return new Date(unit.nextAttemptAt).getTime() <= now;
      })
      .map((unit) => unit.monthKey)
      .filter((month): month is string => Boolean(month))
      .sort();

    return limit && limit > 0 ? months.slice(0, limit) : months;
  }

  async getNextIncompleteMonthRetryAt(stateKey: string): Promise<Date | null> {
    const state = await this.requireState(stateKey);
    const now = Date.now();
    let earliest: number | null = null;

    for (const unit of state.units) {
      if (
        unit.type !== SportsSyncUnitType.MONTH ||
        (unit.status !== SportsSyncUnitStatus.PENDING &&
          unit.status !== SportsSyncUnitStatus.FAILED) ||
        unit.attempts >= this.fixtureTotalAttempts ||
        !unit.nextAttemptAt
      ) {
        continue;
      }

      const retryAt = new Date(unit.nextAttemptAt).getTime();

      if (retryAt <= now) {
        continue;
      }

      if (earliest === null || retryAt < earliest) {
        earliest = retryAt;
      }
    }

    return earliest === null ? null : new Date(earliest);
  }

  async markMonthProcessing(stateKey: string, monthKey: string): Promise<void> {
    await this.markUnitProcessing(stateKey, `MONTH:${monthKey}`);
  }

  async markMonthSuccess(stateKey: string, monthKey: string): Promise<void> {
    await this.markUnitSuccess(stateKey, `MONTH:${monthKey}`);
  }

  async markMonthFailed(
    stateKey: string,
    monthKey: string,
    error: unknown,
  ): Promise<void> {
    await this.markUnitFailed(stateKey, `MONTH:${monthKey}`, error);
  }

  // ============================================================
  // DATE STATE
  // ============================================================

  async getIncompleteDates(stateKey: string): Promise<string[]> {
    const state = await this.requireState(stateKey);

    return state.units
      .filter(
        (unit) =>
          unit.type === SportsSyncUnitType.DATE &&
          (unit.status === SportsSyncUnitStatus.PENDING ||
            unit.status === SportsSyncUnitStatus.FAILED),
      )
      .map((unit) => unit.dateKey)
      .filter((date): date is string => Boolean(date))
      .sort((a, b) => a.localeCompare(b));
  }

  async getDueIncompleteDates(stateKey: string): Promise<string[]> {
    const state = await this.requireState(stateKey);

    const now = Date.now();

    return state.units
      .filter(
        (unit) =>
          unit.type === SportsSyncUnitType.DATE &&
          (unit.status === SportsSyncUnitStatus.PENDING ||
            unit.status === SportsSyncUnitStatus.FAILED),
      )
      .filter((unit) => {
        if (!unit.nextAttemptAt) {
          return true;
        }

        return new Date(unit.nextAttemptAt).getTime() <= now;
      })
      .map((unit) => unit.dateKey)
      .filter((date): date is string => Boolean(date))
      .sort((a, b) => a.localeCompare(b));
  }

  async getNextIncompleteDateRetryAt(stateKey: string): Promise<Date | null> {
    const state = await this.requireState(stateKey);

    const now = Date.now();

    const retryTimes = state.units
      .filter(
        (unit) =>
          unit.type === SportsSyncUnitType.DATE &&
          (unit.status === SportsSyncUnitStatus.PENDING ||
            unit.status === SportsSyncUnitStatus.FAILED) &&
          unit.nextAttemptAt,
      )
      .map((unit) => new Date(unit.nextAttemptAt as Date).getTime())
      .filter((time) => time > now)
      .sort((a, b) => a - b);

    if (retryTimes.length === 0) {
      return null;
    }

    return new Date(retryTimes[0]);
  }

  /**
   * Reopens all month units after ESPN reported a successful but empty
   * new-season catalogue. The lifecycle watcher retries the season later;
   * resetting the units prevents empty responses from permanently blocking
   * a season whose fixtures have not been published yet.
   */
  async resetMonthUnitsForRetry(stateKey: string): Promise<number> {
    const state = await this.requireState(stateKey);
    let resetCount = 0;

    for (const unit of state.units) {
      if (unit.type !== SportsSyncUnitType.MONTH) {
        continue;
      }

      unit.status = SportsSyncUnitStatus.PENDING;
      unit.startedAt = undefined;
      unit.completedAt = undefined;
      unit.nextAttemptAt = undefined;
      unit.lastError = undefined;
      unit.attempts = 0;
      resetCount += 1;
    }

    if (resetCount > 0) {
      state.status = SportsSyncStateStatus.PENDING;
      state.lastError = undefined;
      state.lastSuccessfulAt = undefined;
      state.lastCompletedAt = undefined;
      state.consecutiveFailures = 0;
      state.markModified('units');
      await state.save();
    }

    return resetCount;
  }

  /**
   * Forces a previously successful day back into the refresh queue.
   * Used when an event has just finished and the day-level scoreboard
   * must be re-read for the final score/status update.
   */
  async resetDateForRefresh(stateKey: string, dateKey: string): Promise<void> {
    const normalizedDate = this.normalizeDateOnly(dateKey);

    const result = await this.syncStateModel
      .updateOne(
        {
          stateKey,
          'units.type': SportsSyncUnitType.DATE,
          'units.dateKey': normalizedDate,
        },
        {
          $set: {
            status: SportsSyncStateStatus.PENDING,
            'units.$[unit].status': SportsSyncUnitStatus.PENDING,
          },
          $unset: {
            'units.$[unit].startedAt': 1,
            'units.$[unit].completedAt': 1,
            'units.$[unit].nextAttemptAt': 1,
            'units.$[unit].lastError': 1,
          },
        },
        {
          arrayFilters: [
            {
              'unit.type': SportsSyncUnitType.DATE,
              'unit.dateKey': normalizedDate,
            },
          ],
        },
      )
      .exec();

    if (result.matchedCount === 0) {
      throw new Error(
        `Fixture synchronization unit DATE:${normalizedDate} does not exist in ${stateKey}`,
      );
    }
  }

  async markDateProcessing(stateKey: string, dateKey: string): Promise<void> {
    await this.markUnitProcessing(stateKey, `DATE:${dateKey}`);
  }

  async markDateSuccess(stateKey: string, dateKey: string): Promise<void> {
    await this.markUnitSuccess(stateKey, `DATE:${dateKey}`);
  }

  async markDateFailed(
    stateKey: string,
    dateKey: string,
    error: unknown,
  ): Promise<void> {
    await this.markUnitFailed(stateKey, `DATE:${dateKey}`, error);
  }

  // ============================================================
  // STEP STATE
  // ============================================================

  async getIncompleteSteps(stateKey: string): Promise<string[]> {
    const state = await this.requireState(stateKey);

    return state.units
      .filter(
        (unit) =>
          unit.type === SportsSyncUnitType.STEP &&
          (unit.status === SportsSyncUnitStatus.PENDING ||
            unit.status === SportsSyncUnitStatus.FAILED),
      )
      .map((unit) => unit.stepKey)
      .filter((step): step is string => Boolean(step));
  }

  async isUnitSuccessful(stateKey: string, unitKey: string): Promise<boolean> {
    const state = await this.syncStateModel
      .findOne(
        {
          stateKey,
          'units.key': unitKey,
        },
        {
          'units.$': 1,
        },
      )
      .lean()
      .exec();

    return state?.units?.[0]?.status === SportsSyncUnitStatus.SUCCESS;
  }

  async isUnitUnavailable(stateKey: string, unitKey: string): Promise<boolean> {
    const state = await this.syncStateModel
      .findOne({ stateKey, 'units.key': unitKey }, { 'units.$': 1 })
      .lean()
      .exec();

    return state?.units?.[0]?.status === SportsSyncUnitStatus.UNAVAILABLE;
  }

  async markStepUnavailable(
    stateKey: string,
    stepKey: string,
    reason: string,
  ): Promise<void> {
    await this.markUnitUnavailable(stateKey, `STEP:${stepKey}`, reason);
  }

  async markStepProcessing(stateKey: string, stepKey: string): Promise<void> {
    await this.markUnitProcessing(stateKey, `STEP:${stepKey}`);
  }

  async markStepSuccess(stateKey: string, stepKey: string): Promise<void> {
    await this.markUnitSuccess(stateKey, `STEP:${stepKey}`);
  }

  async markStepFailed(
    stateKey: string,
    stepKey: string,
    error: unknown,
  ): Promise<void> {
    await this.markUnitFailed(stateKey, `STEP:${stepKey}`, error);
  }

  // ============================================================
  // GENERIC UNIT STATE
  // ============================================================

  private async markUnitProcessing(
    stateKey: string,
    unitKey: string,
  ): Promise<void> {
    const now = new Date();

    const result = await this.syncStateModel
      .updateOne(
        {
          stateKey,
          'units.key': unitKey,
        },
        {
          $set: {
            status: SportsSyncStateStatus.PROCESSING,
            'units.$.status': SportsSyncUnitStatus.PROCESSING,
            'units.$.startedAt': now,
          },
          $unset: {
            'units.$.completedAt': 1,
            'units.$.nextAttemptAt': 1,
            'units.$.lastError': 1,
          },
          $inc: {
            'units.$.attempts': 1,
          },
        },
      )
      .exec();

    if (result.matchedCount === 0) {
      throw new Error(
        `Synchronization unit ${unitKey} does not exist in ${stateKey}`,
      );
    }
  }

  private async markUnitSuccess(
    stateKey: string,
    unitKey: string,
  ): Promise<void> {
    const now = new Date();

    const result = await this.syncStateModel
      .updateOne(
        {
          stateKey,
          'units.key': unitKey,
        },
        {
          $set: {
            'units.$.status': SportsSyncUnitStatus.SUCCESS,
            'units.$.completedAt': now,
            lastCompletedAt: now,
          },
          $unset: {
            'units.$.startedAt': 1,
            'units.$.nextAttemptAt': 1,
            'units.$.lastError': 1,
          },
        },
      )
      .exec();

    if (result.matchedCount === 0) {
      throw new Error(
        `Synchronization unit ${unitKey} does not exist in ${stateKey}`,
      );
    }
  }

  private async markUnitUnavailable(
    stateKey: string,
    unitKey: string,
    reason: string,
  ): Promise<void> {
    const now = new Date();
    const result = await this.syncStateModel
      .updateOne(
        { stateKey, 'units.key': unitKey },
        {
          $set: {
            status: SportsSyncStateStatus.PARTIAL,
            lastError: reason,
            'units.$.status': SportsSyncUnitStatus.UNAVAILABLE,
            'units.$.lastError': reason,
            'units.$.completedAt': now,
          },
          $unset: {
            'units.$.startedAt': 1,
            'units.$.nextAttemptAt': 1,
          },
        },
      )
      .exec();

    if (result.matchedCount === 0) {
      throw new Error(
        `Synchronization unit ${unitKey} does not exist in ${stateKey}`,
      );
    }
  }

  private async markUnitFailed(
    stateKey: string,
    unitKey: string,
    error: unknown,
  ): Promise<void> {
    const state = await this.syncStateModel
      .findOne({ stateKey, 'units.key': unitKey }, { 'units.$': 1 })
      .lean()
      .exec();
    const unit = state?.units?.[0];

    if (!unit) {
      throw new Error(
        `Synchronization unit ${unitKey} does not exist in ${stateKey}`,
      );
    }

    // Failure handling must not replace a newer success or retry attempt.
    if (unit.status !== SportsSyncUnitStatus.PROCESSING) return;

    const message = error instanceof Error ? error.message : String(error);
    const attempts = unit.attempts ?? 0;
    const exhaustedFixtureMonth =
      unit.type === SportsSyncUnitType.MONTH &&
      attempts >= this.fixtureTotalAttempts;
    const nextAttemptAt = exhaustedFixtureMonth
      ? undefined
      : new Date(Date.now() + this.getRetryDelay(attempts));

    const set: Record<string, unknown> = {
      status: SportsSyncStateStatus.PARTIAL,
      lastError: message,
      'units.$.status': SportsSyncUnitStatus.FAILED,
      'units.$.lastError': message,
    };
    const unset: Record<string, 1> = {
      'units.$.startedAt': 1,
      'units.$.completedAt': 1,
    };
    if (nextAttemptAt) {
      set['units.$.nextAttemptAt'] = nextAttemptAt;
    } else {
      unset['units.$.nextAttemptAt'] = 1;
    }

    await this.syncStateModel
      .updateOne(
        {
          stateKey,
          units: {
            $elemMatch: {
              key: unitKey,
              status: SportsSyncUnitStatus.PROCESSING,
              attempts,
            },
          },
        },
        {
          $set: set,
          $unset: unset,
          $inc: { consecutiveFailures: 1 },
        },
      )
      .exec();
  }

  // ============================================================
  // OVERALL STATE
  // ============================================================

  async refreshOverallStatus(stateKey: string): Promise<SportsSyncStateStatus> {
    // updatedAt acts as a compare-and-set token: if any other update changes
    // this state while status is calculated, retry against the newer snapshot.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const state = await this.syncStateModel
        .findOne({ stateKey })
        .select({
          stateKey: 1,
          status: 1,
          updatedAt: 1,
          'units.status': 1,
        })
        .exec();

      if (!state) {
        throw new Error(
          `Sports synchronization state ${stateKey} was not found`,
        );
      }

      const nextStatus = this.calculateOverallStatus(state);
      const filter: Record<string, unknown> = { stateKey };
      if (state.updatedAt) filter.updatedAt = state.updatedAt;

      const update =
        nextStatus === SportsSyncStateStatus.SUCCESS
          ? {
              $set: {
                status: nextStatus,
                lastSuccessfulAt: new Date(),
                lastCompletedAt: new Date(),
                consecutiveFailures: 0,
              },
              $unset: { lastError: 1 },
            }
          : { $set: { status: nextStatus } };

      const result = await this.syncStateModel.updateOne(filter, update).exec();
      if (result.matchedCount > 0) return nextStatus;
    }

    throw new Error(
      `Could not refresh synchronization status for ${stateKey} because it kept changing`,
    );
  }

  async isComplete(stateKey: string): Promise<boolean> {
    const state = await this.requireState(stateKey);

    return this.isStateComplete(state);
  }

  /**
   * Verifies that the persistent FIXTURE_REFRESH state for a
   * league/season is completely synchronized.
   *
   * This is the startup phase barrier used before SUMMARY_REFRESH
   * state reconciliation begins.
   *
   * It does not create or modify synchronization state.
   */
  async assertFixtureRefreshComplete(
    leagueId: string,
    season: number,
  ): Promise<void> {
    const stateKey = this.getQueueStateKey({
      jobType: EspnQueueJobType.FIXTURE_REFRESH,

      leagueId,

      season,
    });

    const complete = await this.isComplete(stateKey);

    if (!complete) {
      throw new Error(
        `Fixture synchronization state ${stateKey} is not complete`,
      );
    }
  }

  async assertFixtureStartupComplete(
    leagueId: string,
    season: number,
  ): Promise<void> {
    const stateKey = this.getQueueStateKey({
      jobType: EspnQueueJobType.FIXTURE_REFRESH,
      leagueId,
      season,
    });

    const state = await this.requireState(stateKey);
    const monthUnits = state.units.filter(
      (unit) => unit.type === SportsSyncUnitType.MONTH,
    );

    const complete =
      state.fixtureGranularity === 'MONTH' &&
      monthUnits.length > 0 &&
      monthUnits.every(
        (unit) =>
          unit.status === SportsSyncUnitStatus.SUCCESS ||
          (unit.status === SportsSyncUnitStatus.FAILED &&
            unit.attempts >= this.fixtureTotalAttempts),
      );

    if (!complete) {
      throw new Error(
        `Fixture startup synchronization state ${stateKey} is not complete`,
      );
    }
  }

  async getFixtureStartupProgress(stateKey: string): Promise<{
    totalMonths: number;
    successMonths: number;
    processingMonths: number;
    pendingMonths: number;
    failedMonths: number;
    terminalFailedMonths: number;
    completionPercent: number;
    complete: boolean;
  }> {
    const state = await this.requireState(stateKey);

    const monthUnits = state.units.filter(
      (unit) => unit.type === SportsSyncUnitType.MONTH,
    );

    const successMonths = monthUnits.filter(
      (unit) => unit.status === SportsSyncUnitStatus.SUCCESS,
    ).length;

    const processingMonths = monthUnits.filter(
      (unit) => unit.status === SportsSyncUnitStatus.PROCESSING,
    ).length;

    const pendingMonths = monthUnits.filter(
      (unit) => unit.status === SportsSyncUnitStatus.PENDING,
    ).length;

    const failedMonths = monthUnits.filter(
      (unit) => unit.status === SportsSyncUnitStatus.FAILED,
    ).length;

    const totalMonths = monthUnits.length;
    const terminalFailedMonths = monthUnits.filter(
      (unit) =>
        unit.status === SportsSyncUnitStatus.FAILED &&
        unit.attempts >= this.fixtureTotalAttempts,
    ).length;
    const completedUnits = successMonths + terminalFailedMonths;

    return {
      totalMonths,
      successMonths,
      processingMonths,
      pendingMonths,
      failedMonths,
      terminalFailedMonths,
      completionPercent:
        totalMonths > 0 ? (completedUnits / totalMonths) * 100 : 0,
      complete: totalMonths > 0 && completedUnits === totalMonths,
    };
  }

  // ============================================================
  // CRON STATE
  // ============================================================

  async ensureCronState(params: {
    taskKey: string;
    cronExpression: string;
    timeZone: string;
    nextRunAt?: Date;
  }): Promise<SportsSyncStateDocument> {
    const stateKey = this.getCronStateKey(params.taskKey);

    return this.syncStateModel
      .findOneAndUpdate(
        {
          stateKey,
        },
        {
          $set: {
            kind: SportsSyncStateKind.CRON,

            taskKey: params.taskKey,

            cronExpression: params.cronExpression,

            timeZone: params.timeZone,

            ...(params.nextRunAt
              ? {
                  nextRunAt: params.nextRunAt,
                }
              : {}),
          },

          $setOnInsert: {
            stateKey,

            status: SportsSyncStateStatus.PENDING,

            trackingMode: 'WINDOW',

            units: [],

            consecutiveFailures: 0,
          },
        },
        {
          upsert: true,
          returnDocument: 'after',
          setDefaultsOnInsert: true,
        },
      )
      .exec();
  }

  async markCronStarted(taskKey: string): Promise<void> {
    const state = await this.requireState(this.getCronStateKey(taskKey));

    state.status = SportsSyncStateStatus.PROCESSING;

    state.lastStartedAt = new Date();

    state.lastError = undefined;

    await state.save();
  }

  async markCronSuccess(params: {
    taskKey: string;
    nextRunAt?: Date;
  }): Promise<void> {
    const state = await this.requireState(this.getCronStateKey(params.taskKey));

    const now = new Date();

    state.status = SportsSyncStateStatus.SUCCESS;

    state.lastStartedAt ??= now;

    state.lastSuccessfulAt = now;

    state.lastCompletedAt = now;

    state.lastError = undefined;

    state.consecutiveFailures = 0;

    if (params.nextRunAt) {
      state.nextRunAt = params.nextRunAt;
    }

    await state.save();
  }

  async markCronFailure(params: {
    taskKey: string;
    error: unknown;
    nextRunAt?: Date;
  }): Promise<void> {
    const state = await this.requireState(this.getCronStateKey(params.taskKey));

    state.status = SportsSyncStateStatus.FAILED;

    state.lastError =
      params.error instanceof Error
        ? params.error.message
        : String(params.error);

    state.consecutiveFailures += 1;

    if (params.nextRunAt) {
      state.nextRunAt = params.nextRunAt;
    }

    await state.save();
  }

  async getCronState(taskKey: string): Promise<SportsSyncStateDocument | null> {
    return this.syncStateModel
      .findOne({
        stateKey: this.getCronStateKey(taskKey),
      })
      .exec();
  }

  // ============================================================
  // FIXTURE LOOKUP
  // ============================================================

  private async getFixtureDateKeys(params: {
    leagueId: string;
    season: number;
    dateFrom: string;
    dateTo: string;
  }): Promise<Set<string>> {
    const from = this.parseDateOnly(params.dateFrom);
    const toExclusive = this.addUtcDays(this.parseDateOnly(params.dateTo), 1);

    const fixtureDates = await this.espnFixtureModel.distinct('fixtureDate', {
      leagueId: this.normalize(params.leagueId),
      season: params.season,
      fixtureDate: {
        $gte: from,
        $lt: toExclusive,
      },
    });

    const dates = new Set<string>();

    for (const value of fixtureDates) {
      const fixtureDate = new Date(value);

      if (Number.isNaN(fixtureDate.getTime())) {
        continue;
      }

      dates.add(this.formatDateOnly(fixtureDate));
    }

    return dates;
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private isStateComplete(state: SportsSyncStateDocument): boolean {
    return (
      state.units.length > 0 &&
      state.units.every((unit) => unit.status === SportsSyncUnitStatus.SUCCESS)
    );
  }

  private buildMonthRange(dateFrom: string, dateTo: string): string[] {
    const start = this.parseDateOnly(dateFrom);
    const end = this.parseDateOnly(dateTo);

    const months: string[] = [];
    let cursor = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1),
    );
    const endMonth = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1);

    while (cursor.getTime() <= endMonth) {
      months.push(
        `${cursor.getUTCFullYear().toString().padStart(4, '0')}${(
          cursor.getUTCMonth() + 1
        )
          .toString()
          .padStart(2, '0')}`,
      );

      cursor = new Date(
        Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
      );
    }

    return months;
  }

  private buildDateRange(dateFrom: string, dateTo: string): string[] {
    if (dateFrom > dateTo) {
      throw new Error(
        `Invalid synchronization date range: ${dateFrom} -> ${dateTo}`,
      );
    }

    const dates: string[] = [];

    let current = this.parseDateOnly(dateFrom);

    const end = this.parseDateOnly(dateTo);

    while (current.getTime() <= end.getTime()) {
      dates.push(this.formatDateOnly(current));

      current = new Date(current);

      current.setUTCDate(current.getUTCDate() + 1);
    }

    return dates;
  }

  private parseDateOnly(value: string): Date {
    const date = new Date(`${value}T00:00:00.000Z`);

    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid synchronization date: ${value}`);
    }

    return date;
  }

  private formatDateOnly(value: Date): string {
    return value.toISOString().slice(0, 10);
  }

  private normalizeDateOnly(value: string): string {
    const normalized = String(value ?? '').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      throw new Error(`Invalid synchronization date: ${value}`);
    }

    this.parseDateOnly(normalized);

    return normalized;
  }

  private minDateOnly(first: string, second: string): string {
    return first <= second ? first : second;
  }

  private maxDateOnly(first: string, second: string): string {
    return first >= second ? first : second;
  }

  private calculateOverallStatus(
    state: SportsSyncStateDocument,
  ): SportsSyncStateStatus {
    if (state.units.length === 0) {
      return SportsSyncStateStatus.PENDING;
    }

    if (
      state.units.some(
        (unit) => unit.status === SportsSyncUnitStatus.PROCESSING,
      )
    ) {
      return SportsSyncStateStatus.PROCESSING;
    }

    if (
      state.units.every((unit) => unit.status === SportsSyncUnitStatus.SUCCESS)
    ) {
      return SportsSyncStateStatus.SUCCESS;
    }

    if (
      state.units.some(
        (unit) =>
          unit.status === SportsSyncUnitStatus.FAILED ||
          unit.status === SportsSyncUnitStatus.UNAVAILABLE,
      )
    ) {
      return SportsSyncStateStatus.PARTIAL;
    }

    return SportsSyncStateStatus.PENDING;
  }

  private getRetryDelay(attempts: number): number {
    return Math.min(15, Math.pow(2, Math.max(attempts - 1, 0))) * 60_000;
  }

  private normalize(value: string): string {
    return value.trim().toLowerCase();
  }

  private addUtcDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
  }
}

