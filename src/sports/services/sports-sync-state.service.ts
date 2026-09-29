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

@Injectable()
export class SportsSyncStateService {
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

    const trackingMode = params.trackingMode ?? 'HISTORY';

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

    const effectiveDateFrom = state.dateFrom
      ? this.minDateOnly(state.dateFrom, requestedDateFrom)
      : requestedDateFrom;

    const effectiveDateTo = state.dateTo
      ? this.maxDateOnly(state.dateTo, requestedDateTo)
      : requestedDateTo;

    await this.ensureDateWindow({
      stateKey,

      dateFrom: effectiveDateFrom,

      dateTo: effectiveDateTo,

      trackingMode,
    });

    state = await this.requireState(stateKey);

    /*
     * A date with at least one persisted fixture is already
     * synchronized and therefore does not need another ESPN call.
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

    return state;
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
    const fixtures = await this.espnFixtureModel
      .find({
        leagueId,

        season: params.season,
      })
      .select({
        eventId: 1,

        payload: 1,
      })
      .lean()
      .exec();

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

    for (const fixture of fixtures) {
      const eventId = String(fixture.eventId ?? '').trim();

      if (!eventId) {
        continue;
      }

      const stepKey = this.getSummaryStepKey(eventId);

      const hasSummary = this.hasSummaryPayload(fixture.payload);

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

    const nextStatus = this.calculateOverallStatus(state);

    if (state.status !== nextStatus) {
      state.status = nextStatus;

      changed = true;
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

    const state = await this.requireState(stateKey);

    const stepKey = this.getSummaryStepKey(eventId);

    const existing = state.units.find(
      (unit) =>
        unit.type === SportsSyncUnitType.STEP && unit.stepKey === stepKey,
    );

    let changed = false;

    if (!existing) {
      state.units.push({
        key: `STEP:${stepKey}`,

        type: SportsSyncUnitType.STEP,

        stepKey,

        status:
          params.hasSummary === true
            ? SportsSyncUnitStatus.SUCCESS
            : SportsSyncUnitStatus.PENDING,

        attempts: 0,

        ...(params.hasSummary === true
          ? {
              completedAt: new Date(),
            }
          : {}),
      });

      changed = true;
    } else if (params.hasSummary === true) {
      if (existing.status !== SportsSyncUnitStatus.SUCCESS) {
        existing.status = SportsSyncUnitStatus.SUCCESS;

        existing.completedAt = new Date();

        existing.startedAt = undefined;

        existing.nextAttemptAt = undefined;

        existing.lastError = undefined;

        changed = true;
      }
    } else if (
      existing.status === SportsSyncUnitStatus.SUCCESS ||
      existing.status === SportsSyncUnitStatus.PROCESSING
    ) {
      existing.status = SportsSyncUnitStatus.PENDING;

      existing.startedAt = undefined;

      existing.completedAt = undefined;

      existing.nextAttemptAt = undefined;

      existing.lastError = undefined;

      changed = true;
    }

    if (changed) {
      state.status = this.calculateOverallStatus(state);

      state.markModified('units');

      await state.save();
    }

    return state;
  }

  /**
   * Marks all summary events participating in the current startup
   * batch as PROCESSING in one state-document write.
   */
  async markSummaryEventsProcessing(
    stateKey: string,
    eventIds: string[],
  ): Promise<void> {
    const state = await this.requireState(stateKey);

    const eventIdSet = new Set(
      eventIds.map((eventId) => String(eventId).trim()).filter(Boolean),
    );

    if (eventIdSet.size === 0) {
      return;
    }

    const unitsByStepKey = new Map(
      state.units
        .filter(
          (unit) =>
            unit.type === SportsSyncUnitType.STEP &&
            typeof unit.stepKey === 'string',
        )
        .map((unit) => [unit.stepKey as string, unit]),
    );

    const now = new Date();

    let changed = false;

    for (const eventId of eventIdSet) {
      const stepKey = this.getSummaryStepKey(eventId);

      const unit = unitsByStepKey.get(stepKey);

      if (!unit) {
        throw new Error(
          `Summary synchronization unit ${stepKey} does not exist in ${stateKey}`,
        );
      }

      if (unit.status === SportsSyncUnitStatus.SUCCESS) {
        continue;
      }

      unit.status = SportsSyncUnitStatus.PROCESSING;

      unit.attempts += 1;

      unit.startedAt = now;

      unit.completedAt = undefined;

      unit.nextAttemptAt = undefined;

      unit.lastError = undefined;

      changed = true;
    }

    if (!changed) {
      return;
    }

    state.status = SportsSyncStateStatus.PROCESSING;

    state.markModified('units');

    await state.save();
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
  async markSummaryEventFetchFailed(
    stateKey: string,
    eventId: string,
    error: unknown,
  ): Promise<void> {
    const stepKey = this.getSummaryStepKey(eventId);

    const message = error instanceof Error ? error.message : String(error);

    const nextAttemptAt = new Date(Date.now() + this.getRetryDelay(1));

    const result = await this.syncStateModel
      .updateOne(
        {
          stateKey,

          'units.key': `STEP:${stepKey}`,
        },
        {
          $set: {
            'units.$.status': SportsSyncUnitStatus.FAILED,

            'units.$.nextAttemptAt': nextAttemptAt,

            'units.$.lastError': message,

            status: SportsSyncStateStatus.PARTIAL,

            lastError: message,
          },

          $unset: {
            'units.$.startedAt': 1,

            'units.$.completedAt': 1,
          },

          $inc: {
            consecutiveFailures: 1,
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
    const state = await this.requireState(stateKey);

    const unitsByStepKey = new Map(
      state.units
        .filter(
          (unit) =>
            unit.type === SportsSyncUnitType.STEP &&
            typeof unit.stepKey === 'string',
        )
        .map((unit) => [unit.stepKey as string, unit]),
    );

    const message = error instanceof Error ? error.message : String(error);

    const now = new Date();

    const nextAttemptAt = new Date(now.getTime() + this.getRetryDelay(1));

    let changed = false;

    let failuresAdded = 0;

    for (const eventId of eventIds) {
      const normalizedEventId = String(eventId).trim();

      if (!normalizedEventId) {
        continue;
      }

      const stepKey = this.getSummaryStepKey(normalizedEventId);

      const unit = unitsByStepKey.get(stepKey);

      if (!unit) {
        continue;
      }

      unit.status = SportsSyncUnitStatus.FAILED;

      unit.startedAt = undefined;

      unit.completedAt = undefined;

      unit.nextAttemptAt = nextAttemptAt;

      unit.lastError = message;

      failuresAdded += 1;

      changed = true;
    }

    if (!changed) {
      return;
    }

    state.status = SportsSyncStateStatus.PARTIAL;

    state.lastError = message;

    state.consecutiveFailures += failuresAdded;

    state.markModified('units');

    await state.save();
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
   * Returns incomplete Summary event IDs from a persistent
   * SUMMARY_REFRESH state.
   */
  async getIncompleteSummaryEvents(stateKey: string): Promise<string[]> {
    const state = await this.requireState(stateKey);

    return state.units
      .filter(
        (unit) =>
          unit.type === SportsSyncUnitType.STEP &&
          typeof unit.stepKey === 'string' &&
          unit.stepKey.startsWith('SUMMARY:') &&
          (unit.status === SportsSyncUnitStatus.PENDING ||
            unit.status === SportsSyncUnitStatus.FAILED),
      )
      .map((unit) => String(unit.stepKey).slice('SUMMARY:'.length))
      .filter(Boolean)
      .sort();
  }

  async isSummaryEventSuccessful(
    stateKey: string,
    eventId: string,
  ): Promise<boolean> {
    const state = await this.requireState(stateKey);

    const stepKey = this.getSummaryStepKey(eventId);

    const unit = state.units.find(
      (candidate) =>
        candidate.type === SportsSyncUnitType.STEP &&
        candidate.key === `STEP:${stepKey}`,
    );

    return unit?.status === SportsSyncUnitStatus.SUCCESS;
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

    const existingDateUnits = new Map(
      state.units
        .filter((unit) => unit.type === SportsSyncUnitType.DATE)
        .map((unit) => [unit.dateKey ?? unit.key, unit]),
    );

    const existingStepUnits = state.units.filter(
      (unit) => unit.type === SportsSyncUnitType.STEP,
    );

    let effectiveDateFrom = desiredDateFrom;

    let effectiveDateTo = desiredDateTo;

    if (state.dateFrom) {
      effectiveDateFrom = this.minDateOnly(state.dateFrom, desiredDateFrom);
    }

    if (state.dateTo) {
      effectiveDateTo = this.maxDateOnly(state.dateTo, desiredDateTo);
    }

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

    if (params.trackingMode === 'HISTORY') {
      const desiredDateSet = new Set(effectiveDates);

      const historicalUnits = state.units.filter(
        (unit) =>
          unit.type === SportsSyncUnitType.DATE &&
          unit.dateKey &&
          !desiredDateSet.has(unit.dateKey),
      );

      state.units = [
        ...historicalUnits,
        ...effectiveDateUnits,
        ...existingStepUnits,
      ];
    } else {
      state.units = [...effectiveDateUnits, ...existingStepUnits];
    }

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

    state.units = [...dateUnits, ...existingSteps.values()];

    state.status = this.calculateOverallStatus(state);

    state.markModified('units');

    await state.save();

    return state;
  }

  // ============================================================
  // INTERRUPTED UNIT RECOVERY
  // ============================================================

  async resetInterruptedUnits(stateKey: string): Promise<void> {
    const state = await this.requireState(stateKey);

    let changed = false;

    for (const unit of state.units) {
      if (unit.status !== SportsSyncUnitStatus.PROCESSING) {
        continue;
      }

      unit.status = SportsSyncUnitStatus.PENDING;

      unit.nextAttemptAt = undefined;

      unit.startedAt = undefined;

      changed = true;
    }

    if (!changed) {
      return;
    }

    state.status = SportsSyncStateStatus.PARTIAL;

    state.markModified('units');

    await state.save();
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
    const state = await this.requireState(stateKey);

    const unit = state.units.find((candidate) => candidate.key === unitKey);

    return unit?.status === SportsSyncUnitStatus.SUCCESS;
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
    const state = await this.requireState(stateKey);

    const unit = state.units.find((candidate) => candidate.key === unitKey);

    if (!unit) {
      throw new Error(
        `Synchronization unit ${unitKey} does not exist in ${stateKey}`,
      );
    }

    unit.status = SportsSyncUnitStatus.PROCESSING;

    unit.attempts += 1;

    unit.startedAt = new Date();

    unit.completedAt = undefined;

    unit.nextAttemptAt = undefined;

    unit.lastError = undefined;

    state.status = SportsSyncStateStatus.PROCESSING;

    state.markModified('units');

    await state.save();
  }

  private async markUnitSuccess(
    stateKey: string,
    unitKey: string,
  ): Promise<void> {
    const state = await this.requireState(stateKey);

    const unit = state.units.find((candidate) => candidate.key === unitKey);

    if (!unit) {
      throw new Error(
        `Synchronization unit ${unitKey} does not exist in ${stateKey}`,
      );
    }

    unit.status = SportsSyncUnitStatus.SUCCESS;

    unit.completedAt = new Date();

    unit.nextAttemptAt = undefined;

    unit.lastError = undefined;

    state.lastCompletedAt = new Date();

    state.status = this.calculateOverallStatus(state);

    if (state.status === SportsSyncStateStatus.SUCCESS) {
      state.lastSuccessfulAt = new Date();

      state.lastError = undefined;

      state.consecutiveFailures = 0;
    }

    state.markModified('units');

    await state.save();
  }

  private async markUnitFailed(
    stateKey: string,
    unitKey: string,
    error: unknown,
  ): Promise<void> {
    const state = await this.requireState(stateKey);

    const unit = state.units.find((candidate) => candidate.key === unitKey);

    if (!unit) {
      throw new Error(
        `Synchronization unit ${unitKey} does not exist in ${stateKey}`,
      );
    }

    const message = error instanceof Error ? error.message : String(error);

    unit.status = SportsSyncUnitStatus.FAILED;

    unit.startedAt = undefined;

    unit.completedAt = undefined;

    unit.nextAttemptAt = new Date(
      Date.now() + this.getRetryDelay(unit.attempts),
    );

    unit.lastError = message;

    state.status = SportsSyncStateStatus.PARTIAL;

    state.lastError = message;

    state.consecutiveFailures += 1;

    state.markModified('units');

    await state.save();
  }

  // ============================================================
  // OVERALL STATE
  // ============================================================

  async refreshOverallStatus(stateKey: string): Promise<SportsSyncStateStatus> {
    const state = await this.requireState(stateKey);

    state.status = this.calculateOverallStatus(state);

    if (state.status === SportsSyncStateStatus.SUCCESS) {
      state.lastSuccessfulAt = new Date();

      state.lastCompletedAt = new Date();

      state.lastError = undefined;

      state.consecutiveFailures = 0;
    }

    state.markModified('units');

    await state.save();

    return state.status;
  }

  async isComplete(stateKey: string): Promise<boolean> {
    const state = await this.requireState(stateKey);

    return this.isStateComplete(state);
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

    const fixtures = await this.espnFixtureModel
      .find({
        leagueId: this.normalize(params.leagueId),

        season: params.season,

        fixtureDate: {
          $gte: from,

          $lt: toExclusive,
        },
      })
      .select({
        fixtureDate: 1,
      })
      .lean()
      .exec();

    const dates = new Set<string>();

    for (const fixture of fixtures) {
      if (!fixture.fixtureDate) {
        continue;
      }

      const fixtureDate = new Date(fixture.fixtureDate);

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

  private hasSummaryPayload(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') {
      return false;
    }

    const payloadRecord = payload as Record<string, unknown>;

    const summary = payloadRecord.summary;

    return Boolean(
      summary &&
      typeof summary === 'object' &&
      Object.keys(summary as Record<string, unknown>).length > 0,
    );
  }

  private isStateComplete(state: SportsSyncStateDocument): boolean {
    return (
      state.units.length > 0 &&
      state.units.every((unit) => unit.status === SportsSyncUnitStatus.SUCCESS)
    );
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
      state.units.some((unit) => unit.status === SportsSyncUnitStatus.FAILED)
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
