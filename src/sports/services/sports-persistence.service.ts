import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { ClientSession } from 'mongoose';

import type { SportsMatchFactsWrite } from '../interfaces/sports-match-facts.interface';

import type {
  SportsCompetitionRecord,
  SportsFixtureRecord,
  SportsMatchOddsSnapshotRecord,
  SportsMatchTimelineEventRecord,
  SportsSeasonRecord,
  SportsTeamRecord,
} from '../interfaces/sports-domain.interface';
import {
  SportsCompetition,
  SportsFixture,
  SportsMatchOddsSnapshot,
  SportsMatchSummary,
  SportsMatchFacts,
  SportsMatchTimelineEvent,
  SportsSeason,
  SportsTeam,
  SportsQueue,
  SportsCollectionState,
  SportsYoutubeHighlight,
} from '../schemas';
import { SportsDataChangeEventService } from './sports-data-change-event.service';

/** Idempotent Mongo persistence for normalized ESPN provider facts. */
@Injectable()
export class SportsPersistenceService {
  constructor(
    @InjectModel(SportsCompetition.name)
    private readonly competitionModel: Model<any>,
    @InjectModel(SportsSeason.name) private readonly seasonModel: Model<any>,
    @InjectModel(SportsTeam.name) private readonly teamModel: Model<any>,
    @InjectModel(SportsFixture.name) private readonly fixtureModel: Model<any>,
    @InjectModel(SportsMatchTimelineEvent.name)
    private readonly timelineModel: Model<any>,
    @InjectModel(SportsMatchOddsSnapshot.name)
    private readonly oddsModel: Model<any>,
    @InjectModel(SportsMatchSummary.name)
    private readonly matchSummaryModel: Model<any>,
    @InjectModel(SportsMatchFacts.name)
    private readonly matchFactsModel: Model<any>,
    @InjectModel(SportsCollectionState.name)
    private readonly collectionStateModel: Model<any>,
    @InjectModel(SportsYoutubeHighlight.name)
    private readonly youtubeHighlightModel: Model<any>,
    @InjectModel(SportsQueue.name)
    private readonly queueModel: Model<any>,
    private readonly changeEvents: SportsDataChangeEventService,
  ) {}

  async saveCompetitions(items: SportsCompetitionRecord[]): Promise<number> {
    if (!items.length) return 0;

    const session = await this.competitionModel.db.startSession();
    let persistedCount = 0;
    let outboxChanged = false;

    try {
      await session.withTransaction(async () => {
        const ids = [...new Set(items.map((item) => String(item.id)))];
        const previousRows = (await this.competitionModel
          .find({ id: { $in: ids } })
          .select('-_id')
          .session(session)
          .lean()
          .exec()) as SportsCompetitionRecord[];
        const previousById = new Map(
          previousRows.map((row) => [String(row.id), row]),
        );

        const operations = items.map((item) => {
          const fields = this.stripUndefined(item) as unknown as Record<
            string,
            unknown
          >;
          delete fields.createdAt;
          return {
            updateOne: {
              filter: { id: item.id },
              update: {
                $set: fields,
                $setOnInsert: { createdAt: item.createdAt ?? new Date() },
              },
              upsert: true,
            },
          };
        });
        const result = await this.competitionModel.bulkWrite(operations, {
          ordered: false,
          session,
        });
        persistedCount =
          Number(result.upsertedCount ?? 0) + Number(result.modifiedCount ?? 0);

        for (const item of items) {
          const previous = previousById.get(String(item.id));
          const sourceFingerprint = this.entitySourceFingerprint(item);
          if (
            previous &&
            this.entitySourceFingerprint(previous) === sourceFingerprint
          )
            continue;

          const queued = await this.changeEvents.enqueueChanged(
            {
              entity: 'COMPETITION',
              entityId: String(item.id),
              competitionIds: [String(item.id)],
              changedAt: item.source?.collectedAt ?? new Date(),
              sourceFingerprint,
            },
            session,
          );
          outboxChanged = outboxChanged || queued;
        }
      });
    } finally {
      await session.endSession();
    }

    if (outboxChanged) this.changeEvents.notifyWorker();
    return persistedCount;
  }

  /**
   * Persist exactly one season per competition. Before retiring the previous
   * season catalogue rows, stamp every existing fixture with its own expiry:
   * kickoff + the season's inclusive month count + three grace months.
   */
  async saveCurrentSeason(item: SportsSeasonRecord): Promise<number> {
    const session = await this.seasonModel.db.startSession();
    let persistedCount = 0;
    let outboxChanged = false;

    try {
      await session.withTransaction(async () => {
        const existing = await this.seasonModel
          .find({ competitionId: item.competitionId })
          .select('-_id')
          .session(session)
          .lean()
          .exec();

        for (const season of [...existing, item]) {
          const durationMonths = this.seasonDurationMonths(
            season.startDate,
            season.endDate,
          );
          if (!durationMonths) continue;
          await this.fixtureModel
            .updateMany(
              {
                seasonId: String(season.id),
                $or: [
                  { retentionDurationMonths: { $ne: durationMonths + 3 } },
                  { retentionExpiresAt: { $exists: false } },
                ],
                kickoffAt: { $type: 'date' },
              },
              [
                {
                  $set: {
                    retentionDurationMonths: durationMonths + 3,
                    retentionExpiresAt: {
                      $dateAdd: {
                        startDate: '$kickoffAt',
                        unit: 'month',
                        amount: durationMonths + 3,
                      },
                    },
                  },
                },
              ],
              { updatePipeline: true, session },
            )
            .exec();
        }

        const current = { ...item, isCurrent: true };
        const currentFields = this.stripUndefined(current) as Record<
          string,
          unknown
        >;
        delete currentFields.createdAt;
        const previousCurrent = existing.find(
          (season) => String(season.id) === String(current.id),
        );
        const result = await this.seasonModel
          .updateOne(
            { id: current.id, competitionId: current.competitionId },
            {
              $set: currentFields,
              $setOnInsert: { createdAt: current.createdAt ?? new Date() },
            },
            { upsert: true, runValidators: true, session },
          )
          .exec();
        persistedCount =
          Number(result.upsertedCount ?? 0) + Number(result.modifiedCount ?? 0);

        await this.seasonModel
          .deleteMany({
            competitionId: current.competitionId,
            id: { $ne: current.id },
          })
          .session(session)
          .exec();

        const sourceFingerprint = this.entitySourceFingerprint(current);
        if (
          !previousCurrent ||
          this.entitySourceFingerprint(previousCurrent) !== sourceFingerprint
        ) {
          const queued = await this.changeEvents.enqueueChanged(
            {
              entity: 'SEASON',
              entityId: String(current.id),
              competitionIds: [String(current.competitionId)],
              seasonIds: [String(current.id)],
              changedAt: current.source?.collectedAt ?? new Date(),
              sourceFingerprint,
            },
            session,
          );
          outboxChanged = outboxChanged || queued;
        }
      });
    } finally {
      await session.endSession();
    }

    if (outboxChanged) this.changeEvents.notifyWorker();
    return persistedCount;
  }

  async pruneExpiredFixtures(batchSize = 250): Promise<{
    deletedCount: number;
    affectedCompetitionIds: string[];
  }> {
    const now = new Date();
    const safeBatchSize = Math.max(1, Math.min(1_000, Math.floor(batchSize)));
    const expired = (await this.fixtureModel
      .find({ retentionExpiresAt: { $lte: now } })
      .select('id competitionId')
      .sort({ retentionExpiresAt: 1, kickoffAt: 1 })
      .limit(safeBatchSize)
      .lean()
      .exec()) as Array<{ id: string; competitionId: string }>;
    const fixtureIds = [
      ...new Set(expired.map((row) => String(row.id)).filter(Boolean)),
    ];
    if (!fixtureIds.length)
      return { deletedCount: 0, affectedCompetitionIds: [] };

    await Promise.all([
      this.timelineModel.deleteMany({ fixtureId: { $in: fixtureIds } }).exec(),
      this.oddsModel.deleteMany({ fixtureId: { $in: fixtureIds } }).exec(),
      this.collectionStateModel
        .deleteMany({
          scopeType: 'FIXTURE',
          scopeId: { $in: fixtureIds },
        })
        .exec(),
      this.youtubeHighlightModel
        .deleteMany({ fixtureId: { $in: fixtureIds } })
        .exec(),
      this.queueModel
        .deleteMany({
          status: { $in: ['PENDING', 'FAILED', 'QUARANTINED'] },
          $or: [
            { 'scope.fixtureId': { $in: fixtureIds } },
            { 'scope.fixtureIds': { $in: fixtureIds } },
          ],
        })
        .exec(),
    ]);
    const deleted = await this.fixtureModel
      .deleteMany({
        id: { $in: fixtureIds },
        retentionExpiresAt: { $lte: now },
      })
      .exec();

    return {
      deletedCount: deleted.deletedCount ?? 0,
      affectedCompetitionIds: [
        ...new Set(
          expired.map((row) => String(row.competitionId)).filter(Boolean),
        ),
      ],
    };
  }

  private seasonDurationMonths(
    startValue: unknown,
    endValue: unknown,
  ): number | null {
    const start =
      startValue instanceof Date
        ? startValue
        : typeof startValue === 'string' || typeof startValue === 'number'
          ? new Date(startValue)
          : new Date(Number.NaN);
    const end =
      endValue instanceof Date
        ? endValue
        : typeof endValue === 'string' || typeof endValue === 'number'
          ? new Date(endValue)
          : new Date(Number.NaN);
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      start > end
    )
      return null;
    return Math.max(
      1,
      (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
        end.getUTCMonth() -
        start.getUTCMonth() +
        1,
    );
  }

  private addUtcMonths(value: Date, months: number): Date {
    const yearMonth =
      value.getUTCFullYear() * 12 + value.getUTCMonth() + months;
    const year = Math.floor(yearMonth / 12);
    const month = yearMonth % 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(
      Date.UTC(
        year,
        month,
        Math.min(value.getUTCDate(), lastDay),
        value.getUTCHours(),
        value.getUTCMinutes(),
        value.getUTCSeconds(),
        value.getUTCMilliseconds(),
      ),
    );
  }

  /** Keep each team's competition membership aligned with the current-season catalogue. */
  async reconcileTeamsForLeague(
    leagueId: string,
    currentTeamIds: string[],
  ): Promise<number> {
    const normalizedLeagueId = String(leagueId ?? '')
      .trim()
      .toLowerCase();
    const teamIds = [
      ...new Set(
        currentTeamIds.map((id) => String(id ?? '').trim()).filter(Boolean),
      ),
    ];
    // An empty/invalid catalogue response must never erase existing team records.
    if (!normalizedLeagueId || !teamIds.length) return 0;

    await this.teamModel
      .updateMany(
        { leagueIds: normalizedLeagueId, id: { $nin: teamIds } },
        { $pull: { leagueIds: normalizedLeagueId } },
      )
      .exec();
    const deleted = await this.teamModel
      .deleteMany({ leagueIds: { $size: 0 } })
      .exec();
    return deleted.deletedCount ?? 0;
  }

  async saveTeams(items: SportsTeamRecord[]): Promise<number> {
    if (!items.length) return 0;

    const session = await this.teamModel.db.startSession();
    let persistedCount = 0;
    let outboxChanged = false;

    try {
      await session.withTransaction(async () => {
        const ids = [...new Set(items.map((item) => String(item.id)))];
        const previousRows = (await this.teamModel
          .find({ id: { $in: ids } })
          .select('-_id')
          .session(session)
          .lean()
          .exec()) as SportsTeamRecord[];
        const previousById = new Map(
          previousRows.map((row) => [String(row.id), row]),
        );

        const operations = items.map((item) => {
          const team = this.stripUndefined(item) as unknown as Record<
            string,
            unknown
          >;
          const { leagueIds, createdAt, ...fields } = team;
          delete fields.updatedAt;
          return {
            updateOne: {
              filter: { id: item.id },
              update: {
                $set: fields,
                $addToSet: {
                  leagueIds: { $each: (leagueIds ?? []) as unknown[] },
                },
                $setOnInsert: { createdAt: createdAt ?? new Date() },
              },
              upsert: true,
            },
          };
        });
        const result = await this.teamModel.bulkWrite(operations, {
          ordered: false,
          session,
        });
        persistedCount =
          Number(result.upsertedCount ?? 0) + Number(result.modifiedCount ?? 0);

        for (const item of items) {
          const previous = previousById.get(String(item.id));
          const merged = {
            ...item,
            leagueIds: [
              ...new Set([
                ...(previous?.leagueIds ?? []),
                ...(item.leagueIds ?? []),
              ]),
            ],
          };
          const sourceFingerprint = this.entitySourceFingerprint(merged);
          if (
            previous &&
            this.entitySourceFingerprint(previous) === sourceFingerprint
          )
            continue;

          const queued = await this.changeEvents.enqueueChanged(
            {
              entity: 'TEAM',
              entityId: String(item.id),
              teamIds: [String(item.id)],
              changedAt: item.source?.collectedAt ?? new Date(),
              sourceFingerprint,
            },
            session,
          );
          outboxChanged = outboxChanged || queued;
        }
      });
    } finally {
      await session.endSession();
    }

    if (outboxChanged) this.changeEvents.notifyWorker();
    return persistedCount;
  }

  async saveFixtures(items: SportsFixtureRecord[]): Promise<{
    persistedCount: number;
    previousStates: Record<string, { state: string; completedAt?: Date }>;
  }> {
    if (!items.length) return { persistedCount: 0, previousStates: {} };
    const ids = [...new Set(items.map((item) => item.id))];
    const seasonIds = [
      ...new Set(
        items
          .map((item) => item.seasonId)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    const seasons = seasonIds.length
      ? await this.seasonModel
          .find({ id: { $in: seasonIds } })
          .select('id startDate endDate')
          .lean()
          .exec()
      : [];
    const durationBySeason = new Map<string, number>();
    for (const season of seasons) {
      const duration = this.seasonDurationMonths(
        season.startDate,
        season.endDate,
      );
      if (duration) durationBySeason.set(String(season.id), duration);
    }
    const enrichedItems = items.map((item) => {
      if (!item.seasonId) return item;
      const seasonDuration = durationBySeason.get(item.seasonId);
      const retentionDurationMonths =
        item.retentionDurationMonths ??
        (seasonDuration ? seasonDuration + 3 : undefined);
      if (!retentionDurationMonths) return item;
      return {
        ...item,
        retentionDurationMonths,
        retentionExpiresAt: this.addUtcMonths(
          new Date(item.kickoffAt.getTime()),
          retentionDurationMonths,
        ),
      };
    });
    const session = await this.fixtureModel.db.startSession();
    const settlementSourceChanges = new Map<
      string,
      { fixture: SportsFixtureRecord; fingerprint: string }
    >();
    let settlementOutboxChanged = false;
    let persistedCount = 0;
    const previousStates: Record<
      string,
      { state: string; completedAt?: Date }
    > = {};

    try {
      // Retry transient MongoDB WriteConflict errors against a fresh snapshot.
      // The complete read/fingerprint/outbox decision is rerun on each attempt.
      await this.withWriteConflictRetry(session, async () => {
        settlementSourceChanges.clear();
        settlementOutboxChanged = false;
        persistedCount = 0;
        for (const key of Object.keys(previousStates)) delete previousStates[key];

        const previousRows = (await this.fixtureModel
          .find({ id: { $in: ids } })
          .select(
            'id competitionId seasonId seasonYear kickoffAt venueId neutralSite status completedAt competitors periodScores rawPayload source retentionDurationMonths retentionExpiresAt',
          )
          .session(session)
          .lean()
          .exec()) as unknown as Array<
          Partial<SportsFixtureRecord> & { id: string; rawPayload?: unknown }
        >;
        const previousById = new Map<
          string,
          Partial<SportsFixtureRecord> & { rawPayload?: unknown }
        >(previousRows.map((row) => [String(row.id), row]));
        for (const row of previousRows) {
          if (row.status?.state) {
            previousStates[String(row.id)] = {
              state: row.status.state,
              ...(row.completedAt
                ? { completedAt: new Date(row.completedAt) }
                : {}),
            };
          }
        }
        const operations = enrichedItems.map((incoming) => {
          const previous = previousById.get(incoming.id);
          const safeIncoming = this.preventFixtureRegression(
            incoming,
            previous,
          );
          const retentionDurationMonths = Number(
            incoming.retentionDurationMonths ??
              previous?.retentionDurationMonths ??
              0,
          );
          const item =
            Number.isInteger(retentionDurationMonths) &&
            retentionDurationMonths > 0
              ? {
                  ...safeIncoming,
                  retentionDurationMonths,
                  retentionExpiresAt: this.addUtcMonths(
                    new Date(safeIncoming.kickoffAt.getTime()),
                    retentionDurationMonths,
                  ),
                }
              : safeIncoming;
          const incomingRaw = this.stripUndefined(item);
          const previousRaw = this.asRecord(previous?.rawPayload);
          // Keep only the summary extract consumed by downstream odds and
          // projection fallbacks. Full scoreboard event payloads are discarded
          // after normalization rather than duplicated on every fixture.
          const legacyPreviousSummary = this.isSummarySource(
            previous?.source?.endpoint,
          )
            ? previousRaw
            : undefined;
          const summaryPayload = this.isSummarySource(item.source?.endpoint)
            ? incomingRaw.rawPayload
            : (previousRaw?.summaryFallback ?? legacyPreviousSummary);
          if (summaryPayload !== undefined) {
            incomingRaw.rawPayload = { summaryFallback: summaryPayload };
          } else {
            delete incomingRaw.rawPayload;
          }

          const fingerprint = this.fixtureSourceFingerprint(incomingRaw);
          const previousFingerprint = previous
            ? this.fixtureSourceFingerprint(previous as SportsFixtureRecord)
            : undefined;

          // New live/recently discovered final fixtures and changed existing
          // facts enter the outbox. Bulk monthly bootstrap rows are excluded;
          // the post-bootstrap baseline handles that bounded initial import.
          const endpoint = String(incomingRaw.source?.endpoint ?? '');
          const isMonthlyBootstrapRow =
            /\/scoreboard\?dates=\d{6}(?:$|[&#])/i.test(endpoint);
          // All material fixture changes must fan out to Odds before predictions,
          // including pre-match schedule, competitor and summary updates. The
          // initial monthly season bootstrap remains intentionally quiet because
          // Stage 1's full-retention queue and Odds backfill cover that baseline.
          const isChanged = previous
            ? previousFingerprint !== fingerprint
            : !isMonthlyBootstrapRow;
          if (isChanged) {
            settlementSourceChanges.set(incomingRaw.id, {
              fixture: incomingRaw,
              fingerprint,
            });
          }

          const { id, createdAt, ...fields } = incomingRaw;
          const update: Record<string, unknown> = {
            $set: fields,
            $setOnInsert: { id, createdAt: createdAt ?? new Date() },
          };
          if (summaryPayload === undefined) update.$unset = { rawPayload: 1 };
          return {
            updateOne: {
              filter: { id },
              update,
              upsert: true,
            },
          };
        });

        const result = await this.fixtureModel.bulkWrite(operations, {
          ordered: false,
          session,
        });
        persistedCount =
          Number(result.upsertedCount ?? 0) + Number(result.modifiedCount ?? 0);

        for (const change of settlementSourceChanges.values()) {
          const queued = await this.changeEvents.enqueueChanged(
            {
              entity: 'FIXTURE',
              entityId: change.fixture.id,
              competitionIds: [change.fixture.competitionId],
              seasonIds: change.fixture.seasonId
                ? [change.fixture.seasonId]
                : [],
              teamIds: change.fixture.competitors.map((item) => item.teamId),
              fixtureIds: [change.fixture.id],
              changedAt: change.fixture.source?.collectedAt ?? new Date(),
              sourceFingerprint: change.fingerprint,
            },
            session,
          );
          settlementOutboxChanged = settlementOutboxChanged || queued;
        }
      });
    } finally {
      await session.endSession();
    }

    // Never wake a consumer before the transaction commits; otherwise it could
    // claim an event that is not yet visible outside this session.
    if (settlementOutboxChanged) this.changeEvents.notifyWorker();

    return { persistedCount, previousStates };
  }

  async saveTimelineEvents(
    items: SportsMatchTimelineEventRecord[],
  ): Promise<number> {
    if (!items.length) return 0;
    const fixtureIds = [...new Set(items.map((item) => item.fixtureId))];
    return this.persistTimelineEvents(items, fixtureIds, false);
  }

  /**
   * Core Plays is a complete, paginated snapshot. Replace the fixture timeline
   * so events removed or corrected by ESPN do not remain as stale facts.
   * Summary fallback is deliberately persisted with saveTimelineEvents only;
   * its keyEvents list is not guaranteed to be a complete timeline.
   */
  async replaceTimelineEvents(
    fixtureId: string,
    items: SportsMatchTimelineEventRecord[],
  ): Promise<number> {
    const matching = items.filter((item) => item.fixtureId === fixtureId);
    return this.persistTimelineEvents(matching, [fixtureId], true);
  }

  private async persistTimelineEvents(
    items: SportsMatchTimelineEventRecord[],
    fixtureIds: string[],
    replaceFixtureSnapshot: boolean,
  ): Promise<number> {
    if (!fixtureIds.length) return 0;
    const session = await this.timelineModel.db.startSession();
    let settlementOutboxChanged = false;
    let saved = 0;

    try {
      await session.withTransaction(async () => {
        settlementOutboxChanged = false;

        const previousRows = (await this.timelineModel
          .find({ fixtureId: { $in: fixtureIds } })
          .select('-_id')
          .session(session)
          .lean()
          .exec()) as unknown as SportsMatchTimelineEventRecord[];
        const previousByFixture = new Map<
          string,
          SportsMatchTimelineEventRecord[]
        >();
        for (const row of previousRows) {
          const rows = previousByFixture.get(String(row.fixtureId)) ?? [];
          rows.push(row);
          previousByFixture.set(String(row.fixtureId), rows);
        }

        if (items.length) {
          const operations = items.map((item) => {
            const { id, createdAt, ...fields } = this.stripUndefined(item);
            return {
              updateOne: {
                filter: { id },
                update: {
                  $set: fields,
                  $setOnInsert: { id, createdAt: createdAt ?? new Date() },
                },
                upsert: true,
              },
            };
          });
          const result = await this.timelineModel.bulkWrite(operations, {
            ordered: false,
            session,
          });
          saved =
            Number(result.upsertedCount ?? 0) +
            Number(result.modifiedCount ?? 0);
        }

        if (replaceFixtureSnapshot) {
          for (const fixtureId of fixtureIds) {
            const ids = items
              .filter((item) => item.fixtureId === fixtureId)
              .map((item) => item.id);
            await this.timelineModel
              .deleteMany({
                fixtureId,
                ...(ids.length ? { id: { $nin: ids } } : {}),
              })
              .session(session)
              .exec();
          }
        }

        const [currentResult, fixtureResult] = await Promise.all([
          this.timelineModel
            .find({ fixtureId: { $in: fixtureIds } })
            .select('-_id')
            .session(session)
            .lean()
            .exec(),
          this.fixtureModel
            .find({ id: { $in: fixtureIds } })
            .select('-_id')
            .session(session)
            .lean()
            .exec(),
        ]);
        const currentRows =
          currentResult as unknown as SportsMatchTimelineEventRecord[];
        const fixtureRows = fixtureResult as unknown as SportsFixtureRecord[];
        const currentByFixture = new Map<
          string,
          SportsMatchTimelineEventRecord[]
        >();
        for (const row of currentRows) {
          const rows = currentByFixture.get(String(row.fixtureId)) ?? [];
          rows.push(row);
          currentByFixture.set(String(row.fixtureId), rows);
        }
        const fixtureById = new Map<string, SportsFixtureRecord>(
          fixtureRows.map((fixture) => [fixture.id, fixture]),
        );

        for (const fixtureId of fixtureIds) {
          const before = previousByFixture.get(fixtureId) ?? [];
          const after = currentByFixture.get(fixtureId) ?? [];
          const beforeFingerprint = this.timelineSourceFingerprint(before);
          const afterFingerprint = this.timelineSourceFingerprint(after);
          const fixture = fixtureById.get(fixtureId);
          if (!fixture) continue;

          if (
            beforeFingerprint !== afterFingerprint &&
            this.isSportsFixtureSettleable(fixture)
          ) {
            const queued = await this.changeEvents.enqueueChanged(
              {
                entity: 'MATCH_TIMELINE',
                entityId: fixture.id,
                competitionIds: [fixture.competitionId],
                seasonIds: fixture.seasonId ? [fixture.seasonId] : [],
                teamIds: fixture.competitors.map((item) => item.teamId),
                fixtureIds: [fixture.id],
                changedAt: new Date(),
                sourceFingerprint: afterFingerprint,
              },
              session,
            );
            settlementOutboxChanged = settlementOutboxChanged || queued;
          }
        }
      });
    } finally {
      await session.endSession();
    }

    if (settlementOutboxChanged) this.changeEvents.notifyWorker();
    return saved;
  }

  async saveMatchSummary(input: {
    fixtureId: string;
    espnEventId: string;
    competitionId: string;
    seasonId?: string;
    seasonYear?: number;
    endpoint: string;
    rawPayload: Record<string, unknown>;
    collectedAt?: Date;
  }): Promise<{ revision: number; payloadHash: string; changed: boolean }> {
    const serialized = JSON.stringify(input.rawPayload);
    if (!serialized) throw new Error(`ESPN Summary for ${input.fixtureId} is not serializable.`);
    const payloadSizeBytes = Buffer.byteLength(serialized, 'utf8');
    // MongoDB's BSON document limit is 16 MiB. Leave headroom for document metadata.
    if (payloadSizeBytes > 15 * 1024 * 1024) {
      throw new Error(`ESPN Summary for ${input.fixtureId} is too large to persist safely (${payloadSizeBytes} bytes).`);
    }

    const payloadHash = createHash('sha256').update(serialized).digest('hex');
    const now = input.collectedAt ?? new Date();
    const existing = await this.matchSummaryModel
      .findOne({ fixtureId: input.fixtureId })
      .select({ payloadHash: 1, revision: 1, firstCollectedAt: 1 })
      .lean()
      .exec() as { payloadHash?: string; revision?: number; firstCollectedAt?: Date } | null;
    const changed = existing?.payloadHash !== payloadHash;
    const revision = existing
      ? Math.max(1, Number(existing.revision ?? 1) + (changed ? 1 : 0))
      : 1;

    await this.matchSummaryModel.updateOne(
      { fixtureId: input.fixtureId },
      {
        $set: {
          espnEventId: input.espnEventId,
          competitionId: input.competitionId,
          seasonId: input.seasonId,
          seasonYear: input.seasonYear,
          provider: 'ESPN',
          endpoint: input.endpoint,
          rawPayload: input.rawPayload,
          payloadHash,
          revision,
          payloadSizeBytes,
          lastCollectedAt: now,
        },
        $setOnInsert: { fixtureId: input.fixtureId, firstCollectedAt: now },
      },
      { upsert: true, runValidators: true },
    ).exec();

    return { revision, payloadHash, changed };
  }

  async getMatchSummaryByFixtureId(fixtureId: string): Promise<any | null> {
    return this.matchSummaryModel
      .findOne({ fixtureId })
      .select('-_id -__v')
      .lean()
      .exec();
  }

  async getMatchSummaryByEventId(eventId: string): Promise<any | null> {
    return this.matchSummaryModel
      .findOne({ espnEventId: eventId })
      .select('-_id -__v')
      .lean()
      .exec();
  }

  async saveMatchFacts(input: SportsMatchFactsWrite): Promise<{ revision: number; changed: boolean }> {
    const session = await this.matchFactsModel.db.startSession();
    let revision = 0;
    let changed = false;
    let outboxChanged = false;

    try {
      await session.withTransaction(async () => {
        const existing = await this.matchFactsModel
          .findOne({ fixtureId: input.fixtureId })
          .select({ normalizationHash: 1, sourcePayloadHash: 1, sourceCollectedAt: 1, normalizationVersion: 1, revision: 1 })
          .session(session)
          .lean()
          .exec() as {
            normalizationHash?: string;
            sourcePayloadHash?: string;
            sourceCollectedAt?: Date;
            normalizationVersion?: string;
            revision?: number;
          } | null;

        const previousCollectedAt = existing?.sourceCollectedAt instanceof Date
          ? existing.sourceCollectedAt.getTime()
          : existing?.sourceCollectedAt
            ? new Date(existing.sourceCollectedAt).getTime()
            : 0;
        const incomingCollectedAt = input.sourceCollectedAt.getTime();

        // An older in-flight Summary request must never overwrite a newer
        // normalized snapshot that has already committed for this fixture.
        if (existing && Number.isFinite(previousCollectedAt) && previousCollectedAt > incomingCollectedAt) {
          revision = Math.max(1, Number(existing.revision ?? 1));
          changed = false;
          outboxChanged = false;
          return;
        }

        changed = !existing
          || existing.normalizationHash !== input.normalizationHash
          || existing.sourcePayloadHash !== input.sourcePayloadHash
          || existing.normalizationVersion !== input.normalizationVersion
          || incomingCollectedAt > previousCollectedAt;
        revision = existing
          ? Math.max(1, Number(existing.revision ?? 1) + (changed ? 1 : 0))
          : 1;

        const fields = this.stripUndefined({ ...input, revision } as unknown as Record<string, any>);
        delete fields.fixtureId;
        await this.matchFactsModel.updateOne(
          { fixtureId: input.fixtureId },
          {
            $set: fields,
            $setOnInsert: { fixtureId: input.fixtureId },
          },
          { upsert: true, runValidators: true, session },
        ).exec();

        if (changed) {
          const teamIds = [...new Set([
            ...(input.teamStatistics ?? []).map((team) => String(team.teamId ?? '').trim()),
            String(input.matchResult.homeTeamId ?? '').trim(),
            String(input.matchResult.awayTeamId ?? '').trim(),
          ].filter(Boolean))];
          const athleteIds = [...new Set(
            (input.playerAppearances ?? []).map((player) => String(player.playerId ?? '').trim()).filter(Boolean),
          )];
          const sourceFingerprint = createHash('sha256')
            .update([
              input.sourcePayloadHash,
              input.normalizationHash,
              input.normalizationVersion,
              String(incomingCollectedAt),
              String(revision),
            ].join('\n'))
            .digest('hex');
          outboxChanged = await this.changeEvents.enqueueChanged(
            {
              entity: 'MATCH_STATISTICS',
              entityId: input.fixtureId,
              competitionIds: [input.competitionId],
              seasonIds: input.seasonId ? [input.seasonId] : [],
              teamIds,
              athleteIds,
              fixtureIds: [input.fixtureId],
              changedAt: input.sourceCollectedAt,
              sourceFingerprint,
            },
            session,
          );
        }
      });
    } finally {
      await session.endSession();
    }

    // The outbox event is invisible until the facts transaction commits.
    if (outboxChanged) this.changeEvents.notifyWorker();
    return { revision, changed };
  }

  async getMatchFactsByFixtureId(fixtureId: string): Promise<any | null> {
    return this.matchFactsModel
      .findOne({ fixtureId })
      .select('-_id -__v')
      .lean()
      .exec();
  }

  async getMatchFactsByEventId(eventId: string): Promise<any | null> {
    return this.matchFactsModel
      .findOne({ espnEventId: eventId })
      .select('-_id -__v')
      .lean()
      .exec();
  }

  async saveOddsSnapshot(item: SportsMatchOddsSnapshotRecord): Promise<void> {
    const normalized = this.stripUndefined(item);
    delete normalized.rawPayload;
    const { id, createdAt, ...fields } = normalized;
    await this.oddsModel
      .updateOne(
        { id },
        {
          $set: fields,
          $setOnInsert: { id, createdAt: createdAt ?? new Date() },
        },
        { upsert: true, runValidators: true },
      )
      .exec();
  }

  async getFixtureById(fixtureId: string): Promise<SportsFixtureRecord | null> {
    const record = (await this.fixtureModel
      .findOne({ $or: [{ id: fixtureId }, { espnEventId: fixtureId }] })
      .select('-_id')
      .lean()
      .exec()) as unknown as SportsFixtureRecord | null;
    return record ?? null;
  }

  async getCompetitionById(
    competitionId: string,
  ): Promise<SportsCompetitionRecord | null> {
    const record = (await this.competitionModel
      .findOne({ id: competitionId })
      .select('-_id')
      .lean()
      .exec()) as unknown as SportsCompetitionRecord | null;
    return record ?? null;
  }

  async getSeasonById(seasonId: string): Promise<SportsSeasonRecord | null> {
    const record = (await this.seasonModel
      .findOne({ id: seasonId })
      .select('-_id')
      .lean()
      .exec()) as unknown as SportsSeasonRecord | null;
    return record ?? null;
  }

  async getTeamById(teamId: string): Promise<SportsTeamRecord | null> {
    const record = (await this.teamModel
      .findOne({ $or: [{ id: teamId }, { espnId: teamId }] })
      .select('-_id')
      .lean()
      .exec()) as unknown as SportsTeamRecord | null;
    return record ?? null;
  }

  async getFixturesByIds(fixtureIds: string[]): Promise<SportsFixtureRecord[]> {
    if (!fixtureIds.length) return [];
    const rows = (await this.fixtureModel
      .find({ id: { $in: [...new Set(fixtureIds)] } })
      .select('-_id')
      .lean()
      .exec()) as unknown as SportsFixtureRecord[];
    return rows;
  }

  async getAllSeasons(): Promise<SportsSeasonRecord[]> {
    const rows = (await this.seasonModel
      .find({})
      .sort({ competitionId: 1, year: 1 })
      .select('-_id')
      .lean()
      .exec()) as unknown as SportsSeasonRecord[];
    return rows;
  }

  async getAllTeams(): Promise<SportsTeamRecord[]> {
    const rows = (await this.teamModel
      .find({})
      .sort({ id: 1 })
      .select('-_id')
      .lean()
      .exec()) as unknown as SportsTeamRecord[];
    return rows;
  }

  async getFixturesForCompetitionDate(
    competitionId: string,
    date: string,
  ): Promise<SportsFixtureRecord[]> {
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60_000);
    const records = (await this.fixtureModel
      .find({ competitionId, kickoffAt: { $gte: start, $lt: end } })
      .sort({ kickoffAt: 1, id: 1 })
      .select('-_id')
      .lean()
      .exec()) as unknown as SportsFixtureRecord[];
    return records;
  }

  async getFixtureDateKeysForSeason(
    competitionId: string,
    seasonId: string,
  ): Promise<string[]> {
    const rows = await this.fixtureModel
      .aggregate([
        { $match: { competitionId, seasonId } },
        {
          $project: {
            dateKey: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$kickoffAt',
                timezone: 'UTC',
              },
            },
          },
        },
        { $group: { _id: '$dateKey' } },
      ])
      .exec();
    return rows
      .map((row: { _id?: unknown }) => String(row._id ?? ''))
      .filter(Boolean);
  }

  /**
   * Reads a bounded keyset page of completed fixtures still inside the Sports
   * retention window. Summary and normalized-facts metadata are fetched in two
   * batched lookups, avoiding an N+1 query while keeping raw Summary payloads
   * out of the page scan.
   */
  async getSummaryBackfillPage(input: {
    competitionId: string;
    cursorKickoffAt?: string;
    cursorFixtureId?: string;
    limit: number;
    now?: Date;
  }): Promise<Array<{
    fixture: SportsFixtureRecord;
    summaryPayloadHash?: string;
    factsPayloadHash?: string;
  }>> {
    const now = input.now ?? new Date();
    const safeLimit = Math.max(1, Math.min(200, Math.floor(input.limit)));
    const and: Record<string, unknown>[] = [
      { $or: [{ 'status.state': 'COMPLETED' }, { 'status.isFinal': true }] },
      { kickoffAt: { $lte: now } },
      { espnEventId: { $exists: true, $ne: '' } },
      {
        $or: [
          { retentionExpiresAt: { $gt: now } },
          { retentionExpiresAt: { $exists: false } },
          { retentionExpiresAt: null },
        ],
      },
    ];

    if (input.cursorKickoffAt && input.cursorFixtureId) {
      const cursorDate = new Date(input.cursorKickoffAt);
      if (Number.isFinite(cursorDate.getTime())) {
        and.push({
          $or: [
            { kickoffAt: { $gt: cursorDate } },
            { kickoffAt: cursorDate, id: { $gt: input.cursorFixtureId } },
          ],
        });
      }
    }

    const fixtures = (await this.fixtureModel
      .find({ competitionId: input.competitionId, $and: and })
      .sort({ kickoffAt: 1, id: 1 })
      .limit(safeLimit)
      .select('id espnEventId competitionId seasonId seasonYear name shortName kickoffAt status competitors periodScores completedAt retentionExpiresAt neutralSite source')
      .lean()
      .exec()) as unknown as SportsFixtureRecord[];

    if (!fixtures.length) return [];
    const fixtureIds = fixtures.map((fixture) => String(fixture.id));
    const [summaryRows, factsRows] = await Promise.all([
      this.matchSummaryModel
        .find({ fixtureId: { $in: fixtureIds } })
        .select({ fixtureId: 1, payloadHash: 1 })
        .lean()
        .exec(),
      this.matchFactsModel
        .find({ fixtureId: { $in: fixtureIds } })
        .select({ fixtureId: 1, sourcePayloadHash: 1 })
        .lean()
        .exec(),
    ]);
    const summaries = summaryRows as Array<{ fixtureId: string; payloadHash?: string }>;
    const facts = factsRows as Array<{ fixtureId: string; sourcePayloadHash?: string }>;

    const summaryByFixture = new Map(summaries.map((item) => [String(item.fixtureId), item.payloadHash]));
    const factsByFixture = new Map(facts.map((item) => [String(item.fixtureId), item.sourcePayloadHash]));
    return fixtures.map((fixture) => ({
      fixture,
      summaryPayloadHash: summaryByFixture.get(String(fixture.id)),
      factsPayloadHash: factsByFixture.get(String(fixture.id)),
    }));
  }

  async getCurrentSeasonFixtures(
    competitionId: string,
    seasonId: string,
  ): Promise<SportsFixtureRecord[]> {
    const records = (await this.fixtureModel
      .find({ competitionId, seasonId })
      .sort({ kickoffAt: 1 })
      .select('-_id')
      .lean()
      .exec()) as unknown as SportsFixtureRecord[];
    return records;
  }

  async getCurrentSeasonCompetitions(): Promise<SportsCompetitionRecord[]> {
    const records = (await this.competitionModel
      .find({ isActive: true, currentSeasonYear: { $exists: true, $ne: null } })
      .select('-_id')
      .lean()
      .exec()) as unknown as SportsCompetitionRecord[];
    return records;
  }

  async getAllCompetitions(): Promise<SportsCompetitionRecord[]> {
    const records = (await this.competitionModel
      .find({})
      .sort({ slug: 1 })
      .select('-_id')
      .lean()
      .exec()) as unknown as SportsCompetitionRecord[];
    return records;
  }

  async getAllSeasonsForCompetition(
    competitionId: string,
  ): Promise<SportsSeasonRecord[]> {
    const records = (await this.seasonModel
      .find({ competitionId })
      .sort({ year: 1 })
      .select('-_id')
      .lean()
      .exec()) as unknown as SportsSeasonRecord[];
    return records;
  }

  async getSeasonByYear(
    competitionId: string,
    year: number,
  ): Promise<SportsSeasonRecord | null> {
    const record = (await this.seasonModel
      .findOne({ competitionId, year })
      .select('-_id')
      .lean()
      .exec()) as unknown as SportsSeasonRecord | null;
    return record ?? null;
  }

  async getTeamsForLeague(leagueId: string): Promise<SportsTeamRecord[]> {
    const records = (await this.teamModel
      .find({ leagueIds: leagueId.toLowerCase() })
      .sort({ name: 1, id: 1 })
      .select('-_id')
      .lean()
      .exec()) as unknown as SportsTeamRecord[];
    return records;
  }

  async getAllCompletedFixtures(): Promise<SportsFixtureRecord[]> {
    const records = (await this.fixtureModel
      .find({
        $and: [
          {
            $or: [{ 'status.state': 'COMPLETED' }, { 'status.isFinal': true }],
          },
          {
            $or: [
              { retentionExpiresAt: { $gt: new Date() } },
              { retentionExpiresAt: { $exists: false } },
            ],
          },
        ],
      })
      .sort({ kickoffAt: -1 })
      .select('-_id')
      .lean()
      .exec()) as unknown as SportsFixtureRecord[];
    return records;
  }

  private isSportsFixtureInProgress(fixture: SportsFixtureRecord): boolean {
    return ['LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES'].includes(
      String(fixture.status?.state ?? ''),
    );
  }

  private isSportsFixtureSettleable(fixture: SportsFixtureRecord): boolean {
    const state = String(fixture.status?.state ?? 'UNKNOWN');
    if (
      ['SCHEDULED', 'POSTPONED', 'CANCELLED', 'ABANDONED', 'UNKNOWN'].includes(
        state,
      )
    ) {
      return false;
    }
    return (
      fixture.status?.isFinal === true ||
      ['LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES', 'COMPLETED'].includes(
        state,
      )
    );
  }

  private preventFixtureRegression(
    incoming: SportsFixtureRecord,
    previous?: Partial<SportsFixtureRecord>,
  ): SportsFixtureRecord {
    if (!previous) {
      const isCompleted =
        incoming.status?.state === 'COMPLETED' || incoming.status?.isFinal;
      const observedAt = incoming.source?.collectedAt ?? new Date();
      const kickoffAt = new Date(incoming.kickoffAt).getTime();
      const observedAtMs = new Date(observedAt).getTime();
      // Do not invent completion timestamps for old fixtures during historical
      // bootstrap. For a recently completed fixture first discovered by a
      // routine scoreboard/live pass, persist the first-observed final time so
      // the post-match verification job is still scheduled.
      if (
        isCompleted &&
        Number.isFinite(kickoffAt) &&
        Number.isFinite(observedAtMs) &&
        observedAtMs >= kickoffAt &&
        observedAtMs - kickoffAt <= 48 * 60 * 60_000 &&
        !incoming.completedAt
      ) {
        return { ...incoming, completedAt: new Date(observedAtMs) };
      }
      return incoming;
    }
    const oldState = String(previous.status?.state ?? 'UNKNOWN');
    const newState = incoming.status.state;
    // A postponed fixture may be rescheduled by ESPN and must be allowed to
    // return to SCHEDULED with a corrected kickoff. Completed/cancelled/abandoned
    // records are protected from stale scoreboard regressions.
    const terminal = ['COMPLETED', 'CANCELLED', 'ABANDONED'].includes(oldState);
    const newTerminal = ['COMPLETED', 'CANCELLED', 'ABANDONED'].includes(
      newState,
    );
    const staleRegression = terminal && !newTerminal;
    if (staleRegression) {
      return {
        ...incoming,
        status: previous.status ?? incoming.status,
        completedAt: previous.completedAt ?? incoming.completedAt,
        competitors: incoming.competitors?.every(
          (item) => item.score === null || item.score === undefined,
        )
          ? (previous.competitors ?? incoming.competitors)
          : incoming.competitors,
        periodScores: incoming.periodScores?.length
          ? incoming.periodScores
          : (previous.periodScores ?? incoming.periodScores),
      };
    }

    // Capture the first time the provider confirms a previously non-terminal
    // fixture as final. Historical fixtures arriving during first bootstrap do
    // not receive an invented completion timestamp.
    if (
      newState === 'COMPLETED' &&
      oldState !== 'COMPLETED' &&
      !incoming.completedAt
    ) {
      return { ...incoming, completedAt: new Date() };
    }
    if (
      newState === 'COMPLETED' &&
      previous.completedAt &&
      !incoming.completedAt
    ) {
      return { ...incoming, completedAt: new Date(previous.completedAt) };
    }
    return incoming;
  }

  private fixtureSourceFingerprint(fixture: SportsFixtureRecord): string {
    const rawPayload = this.asRecord(fixture.rawPayload);
    const summary =
      rawPayload?.summaryFallback ??
      (this.isSummarySource(fixture.source?.endpoint) ? rawPayload : undefined);
    const summaryRecord = this.asRecord(summary);
    const boxscore = this.asRecord(summaryRecord?.boxscore);
    const teams = Array.isArray(boxscore?.teams) ? boxscore.teams : [];
    const value = {
      competitionId: fixture.competitionId,
      seasonId: fixture.seasonId,
      seasonYear: fixture.seasonYear,
      kickoffAt: fixture.kickoffAt,
      venueId: fixture.venueId,
      neutralSite: fixture.neutralSite,
      status: {
        state: fixture.status?.state,
        isFinal: fixture.status?.isFinal,
        period: fixture.status?.period,
        clock: fixture.status?.clock,
      },
      completedAt: fixture.completedAt
        ? new Date(fixture.completedAt).toISOString()
        : null,
      competitors: (fixture.competitors ?? []).map((item) => ({
        teamId: item.teamId,
        homeAway: item.homeAway,
        score: item.score,
        winner: item.winner,
        form: item.form,
        records: item.records ?? [],
        statistics: item.statistics ?? [],
        leaders: item.leaders ?? [],
      })),
      periodScores: fixture.periodScores ?? [],
      summaryRosters: summaryRecord?.rosters ?? boxscore?.rosters ?? [],
      summaryTeamStatistics: teams.map((entry: unknown) => {
        const team = this.asRecord(entry) ?? {};
        const teamInfo = this.asRecord(team.team);
        return {
          team: teamInfo?.id ?? team.id,
          statistics: team.statistics ?? [],
        };
      }),
    };
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private timelineSourceFingerprint(
    rows: SportsMatchTimelineEventRecord[],
  ): string {
    const ordered = [...rows].sort(
      (a, b) =>
        Number(a.sequence ?? 0) - Number(b.sequence ?? 0) ||
        String(a.id).localeCompare(String(b.id)),
    );
    return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
  }

  private entitySourceFingerprint(value: unknown): string {
    const normalize = (input: unknown): unknown => {
      if (input instanceof Date) return input.toISOString();
      if (Array.isArray(input)) return input.map(normalize);
      if (typeof input !== 'object' || input === null) return input;
      const record = input as Record<string, unknown>;
      const ignored = new Set([
        '_id',
        '__v',
        'createdAt',
        'updatedAt',
        'source',
        'rawPayload',
      ]);
      return Object.fromEntries(
        Object.keys(record)
          .filter((key) => !ignored.has(key))
          .sort((left, right) => left.localeCompare(right))
          .map((key) => [key, normalize(record[key])]),
      );
    };
    return createHash('sha256')
      .update(JSON.stringify(normalize(value)))
      .digest('hex');
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  }

  private isSummarySource(endpoint?: string): boolean {
    return Boolean(endpoint && endpoint.includes('/summary?event='));
  }

  private async withWriteConflictRetry<T>(
    session: ClientSession,
    operation: () => Promise<T>,
    maximumAttempts = 4,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return (await session.withTransaction(operation)) as T;
      } catch (error) {
        if (!this.isRetryableWriteConflict(error) || attempt >= maximumAttempts)
          throw error;
        const delayMs = 50 * attempt + Math.floor(Math.random() * 75);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private isRetryableWriteConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const value = error as {
      code?: number;
      codeName?: string;
      errorLabels?: string[];
      hasErrorLabel?: (label: string) => boolean;
    };
    const labels = Array.isArray(value.errorLabels) ? value.errorLabels : [];
    const transientTransaction = labels.includes('TransientTransactionError') ||
      value.hasErrorLabel?.('TransientTransactionError') === true;
    return value.code === 112 ||
      value.code === 251 ||
      value.codeName === 'WriteConflict' ||
      value.codeName === 'NoSuchTransaction' ||
      transientTransaction;
  }

  private stripUndefined<T extends Record<string, any>>(value: T): T {
    return Object.fromEntries(
      Object.entries(value).filter(([, child]) => child !== undefined),
    ) as T;
  }
}


