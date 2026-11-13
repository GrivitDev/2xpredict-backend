import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  FOOTBALL_MARKET_CATALOG,
  canonicalLineSlug,
  expandCanonicalSelections,
} from '../catalog/football-market-catalog';
import {
  isOddsQuoteFresh,
  ODDS_CONFIG,
  toValidDate,
} from '../config/odds.config';
import { FixtureOdds } from '../schemas/fixture-odds.schema';
import { SportsDomainReadService } from '../../sports/services/sports-domain-read.service';
import { SportsDataChangeEventService } from '../../sports/services/sports-data-change-event.service';
import { SportsReadinessService } from '../../sports/services/sports-readiness.service';
import type {
  SportsMatchOddsSnapshotRecord,
  SportsOddsMarket,
  SportsOddsOutcome,
} from '../../sports/interfaces/sports-domain.interface';
import type { SportsMatchReadModel } from '../../sports/interfaces/sports-read.interface';
import { OddsPricingEngineService } from './odds-pricing-engine.service';
import type { OddsPricingContext } from './odds-pricing-engine.service';

export type OddsBasis =
  | 'BOOKMAKER_ONLY'
  | 'BOOKMAKER_PLUS_HISTORY'
  | 'HISTORICAL_ONLY'
  | 'PRIOR_ONLY';
export type OddsProvider = 'ESPN';

type PlainRecord = Record<string, any>;
type ProviderQuote = {
  marketId: string;
  selectionKey: string;
  line?: number;
  decimalOdds: number;
  provider: OddsProvider;
  bookmaker: string;
  providerUpdatedAt: Date;
};

export interface OddsQuoteSnapshot {
  eventId: string;
  marketId: string;
  selectionKey: string;
  line?: number;
  decimalOdds: number;
  priceType: 'PROVIDER' | 'ESTIMATED';
  provider?: OddsProvider;
  bookmaker?: string;
  pricingSource?: 'GRIVIT_MODEL';
  externalBookmakerCount?: number;
  externalConsensusFairOdds?: number | null;
  externalConsensusProbability?: number | null;
  externalDeviationPercent?: number | null;
  externalValidatedAt?: Date | null;
  externalValidationStatus?: 'VALIDATED' | 'NO_EXTERNAL_REFERENCE' | 'REFERENCE_AVAILABLE_NO_CONSENSUS';
  fairOdds?: number | null;
  fairOddsBasis?: 'MODEL' | 'PRIOR';
  marketFairOdds?: number | null;
  impliedProbability?: number | null;
  fairProbability?: number | null;
  valuePercent?: number | null;
  oddsBasis?: OddsBasis;
  oddsCalculationMethod?: string;
  providerUpdatedAt?: Date | null;
  updatedAt?: Date;
  predictionReady: boolean;
  dataQuality?: number;
  sampleSize?: number;
  sourceRevision?: number;
  fixtureSourceRevision?: number;
  sourceDataUpdatedAt?: Date;
  calculationVersion?: string;
  oddsCapturedAt: Date | null;
  oddsFreshUntil: Date | null;
  isFresh: boolean;
}

const clean = (value: unknown): string =>
  typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
const normalized = (value: unknown): string =>
  clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
const round = (value: number, places = 4): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
const dateMs = (value: unknown): number => toValidDate(value)?.getTime() ?? 0;
const unique = <T>(values: T[]): T[] => [...new Set(values)];

/** Maximum fixture IDs and corresponding Odds rows held for one readiness pass. */
const PREDICTION_READINESS_LOOKUP_BATCH_SIZE = 100;

@Injectable()
export class OddsService {
  constructor(
    @InjectModel(FixtureOdds.name)
    private readonly oddsModel: Model<FixtureOdds>,
    private readonly sportsRead: SportsDomainReadService,
    private readonly sportsRevisions: SportsDataChangeEventService,
    private readonly sportsReadiness: SportsReadinessService,
    private readonly pricingEngine: OddsPricingEngineService,
  ) {}

  /**
   * Re-price one canonical Sports fixture. All factual inputs are read from
   * SportsDomainReadService; this service has no provider clients or API calls.
   */
  async refreshFixture(fixtureId: string): Promise<number> {
    const id = clean(fixtureId);
    if (!id) return 0;
    // Read the source revision before the fixture snapshot. A second check
    // before persistence prevents a calculation from being stamped with a
    // newer revision than the facts it actually consumed.
    const fixtureSourceRevision = await this.sportsRevisions.getCurrentRevision('FIXTURE', id);
    const match = await this.sportsRead.getMatch(id);
    if (!match) return 0;

    const fixture = match.fixture;
    const retentionExpiresAt = toValidDate((fixture as any).retentionExpiresAt);
    if (retentionExpiresAt && retentionExpiresAt.getTime() <= Date.now()) {
      await this.assertFixtureSourceRevisionUnchanged(fixture.id, fixtureSourceRevision);
      await this.removeFixturePrices(fixture.id, fixtureSourceRevision);
      return 0;
    }

    // Upcoming, live and completed fixtures are all priced. Only fixtures
    // that cannot produce a valid sporting result remain unpriced.
    const isUnavailable = ['POSTPONED', 'CANCELLED', 'ABANDONED'].includes(
      fixture.status.state,
    );
    if (isUnavailable) {
      await this.assertFixtureSourceRevisionUnchanged(fixture.id, fixtureSourceRevision);
      await this.removeFixturePrices(fixture.id, fixtureSourceRevision);
      return 0;
    }

    const home = fixture.competitors.find((item) => item.homeAway === 'HOME');
    const away = fixture.competitors.find((item) => item.homeAway === 'AWAY');
    if (!home || !away) {
      await this.assertFixtureSourceRevisionUnchanged(fixture.id, fixtureSourceRevision);
      await this.removeFixturePrices(fixture.id, fixtureSourceRevision);
      return 0;
    }

    const seasonId = fixture.seasonId;
    const hasSeason = Boolean(seasonId);
    // Keep a fixture pricing pass to at most two concurrent Sports reads.
    // These reads are independent, but launching all ten together creates a
    // short-lived MongoDB connection/query burst on the production instance.
    const [homeScoring, awayScoring] = hasSeason
      ? await Promise.all([
          this.sportsRead.getTeamScoringRecord(
            home.teamId,
            fixture.competitionId,
            seasonId!,
            'HOME',
          ),
          this.sportsRead.getTeamScoringRecord(
            away.teamId,
            fixture.competitionId,
            seasonId!,
            'AWAY',
          ),
        ])
      : [null, null];

    const [homeAwayRecord, awayAwayRecord] = hasSeason
      ? await Promise.all([
          this.sportsRead.getTeamHomeAwayRecord(
            home.teamId,
            fixture.competitionId,
            seasonId!,
          ),
          this.sportsRead.getTeamHomeAwayRecord(
            away.teamId,
            fixture.competitionId,
            seasonId!,
          ),
        ])
      : [null, null];

    const competitionScoring = hasSeason
      ? await this.sportsRead.getCompetitionScoringTotals(
          fixture.competitionId,
          seasonId!,
        )
      : null;

    const [homeStatistics, awayStatistics] = hasSeason
      ? await Promise.all([
          this.sportsRead.getTeamStatisticsAggregate(
            home.teamId,
            fixture.competitionId,
            seasonId!,
            'HOME',
          ),
          this.sportsRead.getTeamStatisticsAggregate(
            away.teamId,
            fixture.competitionId,
            seasonId!,
            'AWAY',
          ),
        ])
      : [null, null];

    const [homeTeamData, awayTeamData] = await Promise.all([
      this.sportsRead.getTeamData(home.teamId, 40, fixture.competitionId, seasonId),
      this.sportsRead.getTeamData(away.teamId, 40, fixture.competitionId, seasonId),
    ]);
    const headToHead = await this.sportsRead.getHeadToHead(
      home.teamId,
      away.teamId,
      fixture.competitionId,
    );

    // Evaluate coverage using the exact Sports records already loaded for this
    // pricing pass. This avoids a second set of reads and keeps readiness and
    // the actual Grivit calculation on the same source snapshot.
    const readiness = await this.sportsReadiness.getFixtureReadiness(id, {
      match,
      homeScoring,
      awayScoring,
      homeAway: homeAwayRecord,
      awayAway: awayAwayRecord,
      competitionScoring,
      homeStatistics,
      awayStatistics,
      homeTeamData,
      awayTeamData,
      headToHead,
    });
    if (!readiness) {
      throw new Error(`Sports readiness could not be evaluated for fixture ${id}.`);
    }

    // Sports owns every reusable football projection. Odds consumes those
    // projections as-is and does not reconstruct missing facts locally.
    const context: OddsPricingContext = {
      match,
      homeScoring,
      awayScoring,
      homeAwayRecord,
      awayAwayRecord,
      competitionScoring,
      homeStatistics,
      awayStatistics,
      homeTeamData,
      awayTeamData,
      headToHead,
      readiness,
    };

    const latestSourceDate = this.latestDate([
      fixture.updatedAt,
      fixture.source.collectedAt,
      fixture.source.providerUpdatedAt,
      homeScoring?.computedAt,
      awayScoring?.computedAt,
      homeAwayRecord?.computedAt,
      awayAwayRecord?.computedAt,
      competitionScoring?.computedAt,
      homeStatistics?.computedAt,
      awayStatistics?.computedAt,
      homeTeamData?.form[0]?.computedAt,
      awayTeamData?.form[0]?.computedAt,
      match.latestOdds?.collectedAt,
    ]);
    const sourceDataUpdatedAt =
      latestSourceDate.getTime() > 0 ? latestSourceDate : new Date();
    const sourceRevision = Math.max(
      homeScoring?.sourceRevision ?? 0,
      awayScoring?.sourceRevision ?? 0,
      homeAwayRecord?.sourceRevision ?? 0,
      awayAwayRecord?.sourceRevision ?? 0,
      competitionScoring?.sourceRevision ?? 0,
      homeStatistics?.sourceRevision ?? 0,
      awayStatistics?.sourceRevision ?? 0,
      0,
    );
    const sourceDataHash = this.createSourceHash(
      context,
      sourceRevision,
      fixtureSourceRevision,
    );

    // These counts are small, but keeping them sequential avoids adding two
    // more simultaneous database operations to the same pricing pass.
    const models = this.pricingEngine.calculate(context);
    if (!models.length) {
      await this.assertFixtureSourceRevisionUnchanged(fixture.id, fixtureSourceRevision);
      await this.removeFixturePrices(fixture.id, fixtureSourceRevision);
      return 0;
    }

    // Compare against the expected output size, not merely the number of rows
    // already stored. A previous batch may have committed before a later batch
    // failed; equal existing/current counts alone would incorrectly treat that
    // partial snapshot as complete on retry.
    const expectedDocumentCount = models.filter((model) => {
      const decimalOdds = model.fairOdds / (1 + ODDS_CONFIG.grivitOverroundPercent / 100);
      return Number.isFinite(decimalOdds)
        && decimalOdds >= 1.01
        && decimalOdds <= ODDS_CONFIG.maximumDecimalOdds
        && model.predictionReady;
    }).length;

    if (expectedDocumentCount > 0) {
      const existingCount = await this.oddsModel
        .countDocuments({ eventId: fixture.id })
        .exec();
      const currentCount = await this.oddsModel
        .countDocuments({
          eventId: fixture.id,
          sourceDataHash,
          fixtureSourceRevision,
          calculationVersion: ODDS_CONFIG.modelVersion,
        })
        .exec();
      if (
        existingCount === expectedDocumentCount
        && currentCount === expectedDocumentCount
      ) {
        await this.assertFixtureSourceRevisionUnchanged(fixture.id, fixtureSourceRevision);
        return existingCount;
      }
    }

    // External bookmaker snapshots are reference-only. They can add a market
    // validation benchmark, but can never create a price or make an unavailable
    // Grivit selection prediction-ready.
    const providerQuotes = this.extractProviderQuotes(match.latestOdds, match);
    const providerFairPrices = this.calculateProviderFairPrices(providerQuotes);
    const validationByKey = new Map(
      providerFairPrices.map((item) => [
        this.priceKey(item.marketId, item.selectionKey, item.line),
        item,
      ]),
    );
    const referenceKeys = new Set(
      providerQuotes.map((quote) => this.priceKey(quote.marketId, quote.selectionKey, quote.line)),
    );

    const now = new Date();
    const documents = models.flatMap((model) => {
      const decimalOdds = model.fairOdds / (1 + ODDS_CONFIG.grivitOverroundPercent / 100);
      if (
        !Number.isFinite(decimalOdds) ||
        decimalOdds < 1.01 ||
        decimalOdds > ODDS_CONFIG.maximumDecimalOdds ||
        !model.predictionReady
      ) return [];

      const key = this.priceKey(model.marketId, model.selectionKey, model.line);
      const validation = validationByKey.get(key);
      const externalBookmakerCount = validation?.bookmakerCount ?? 0;
      const externalConsensusFairOdds = validation?.marketFairOdds ?? null;
      const externalConsensusProbability = validation?.fairProbability ?? null;
      const externalDeviationPercent = externalConsensusFairOdds && externalConsensusFairOdds > 0
        ? round((decimalOdds / externalConsensusFairOdds - 1) * 100, 2)
        : null;
      const externalValidationStatus = validation
        ? 'VALIDATED' as const
        : referenceKeys.has(key)
          ? 'REFERENCE_AVAILABLE_NO_CONSENSUS' as const
          : 'NO_EXTERNAL_REFERENCE' as const;

      return [{
        eventId: fixture.id,
        marketId: model.marketId,
        selectionKey: model.selectionKey,
        ...(model.line !== undefined ? { line: model.line } : {}),
        decimalOdds: round(decimalOdds, 4),
        // ESTIMATED is kept for compatibility with existing Prediction and
        // Bet Lab contracts. bookmaker/pricingSource identify Grivit as the
        // bookmaker of record, not an external quote.
        priceType: 'ESTIMATED' as const,
        predictionReady: true,
        bookmaker: 'Grivit',
        pricingSource: 'GRIVIT_MODEL' as const,
        fairOdds: model.fairOdds,
        fairOddsBasis: 'MODEL' as const,
        oddsBasis: 'HISTORICAL_ONLY' as const,
        oddsCalculationMethod: model.calculationMethod,
        marketFairOdds: externalConsensusFairOdds,
        externalBookmakerCount,
        externalConsensusFairOdds,
        externalConsensusProbability,
        externalDeviationPercent,
        externalValidatedAt: validation?.validatedAt ?? null,
        externalValidationStatus,
        impliedProbability: round(1 / decimalOdds, 6),
        fairProbability: model.fairProbability,
        dataQuality: model.dataQuality,
        sampleSize: model.sampleSize,
        sourceRevision,
        fixtureSourceRevision,
        sourceDataHash,
        sourceDataUpdatedAt,
        calculationVersion: ODDS_CONFIG.modelVersion,
        ...(retentionExpiresAt ? { expiresAt: retentionExpiresAt } : {}),
        updatedAt: now,
        $unset: {
          ...(retentionExpiresAt ? {} : { expiresAt: true as const }),
          provider: true as const,
          providerUpdatedAt: true as const,
          valuePercent: true as const,
        },
      }];
    });

    if (!documents.length) {
      await this.assertFixtureSourceRevisionUnchanged(fixture.id, fixtureSourceRevision);
      await this.removeFixturePrices(fixture.id, fixtureSourceRevision);
      return 0;
    }

    // If Sports changed while this price set was being calculated, leave the
    // prior rows untouched and retry the durable pricing job against the new
    // source snapshot instead of persisting a stale calculation.
    await this.assertFixtureSourceRevisionUnchanged(fixture.id, fixtureSourceRevision);

    await this.writePriceDocuments(documents);

    const currentKeys = documents.map((document) => ({
      marketId: document.marketId,
      selectionKey: document.selectionKey,
      ...(document.line !== undefined
        ? { line: document.line }
        : { $or: [{ line: { $exists: false } }, { line: null }] }),
    }));
    // A source update may commit immediately after the pre-write check. Only
    // clean up obsolete rows at this calculation's revision; never let an
    // older pricing pass delete rows already written for a newer revision.
    await this.assertFixtureSourceRevisionUnchanged(fixture.id, fixtureSourceRevision);
    await this.oddsModel
      .deleteMany({
        eventId: fixture.id,
        $and: [
          { $nor: currentKeys },
          this.fixtureSourceRevisionAtMostFilter(fixtureSourceRevision),
        ],
      })
      .exec();
    return documents.length;
  }

  /** Persist a fixture's market rows in small, sequential, retry-safe batches. */
  private async writePriceDocuments(documents: PlainRecord[]): Promise<void> {
    const batchSize = 100;
    for (let offset = 0; offset < documents.length; offset += batchSize) {
      const batch = documents.slice(offset, offset + batchSize);
      await this.oddsModel.bulkWrite(
        batch.map((document) => ({
          updateOne: {
            filter: {
              eventId: document.eventId,
              marketId: document.marketId,
              selectionKey: document.selectionKey,
              ...(document.line !== undefined
                ? { line: document.line }
                : { $or: [{ line: { $exists: false } }, { line: null }] }),
            },
            update: {
              $set: Object.fromEntries(
                Object.entries(document).filter(([field]) => field !== '$unset'),
              ),
              $unset: document.$unset,
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
  }

  async getFixturePrices(eventId: string): Promise<OddsQuoteSnapshot[]> {
    const rows = await this.oddsModel
      .find(this.activeFilter(clean(eventId)))
      .select({ _id: 0, __v: 0 })
      .sort({ marketId: 1, line: 1, selectionKey: 1 })
      .lean()
      .exec();
    return this.attachCurrentFreshness(rows as PlainRecord[]);
  }

  async getPricesForFixtures(eventIds: string[]): Promise<OddsQuoteSnapshot[]> {
    const ids = unique(eventIds.map(clean).filter(Boolean));
    if (!ids.length) return [];
    const rows = await this.oddsModel
      .find({ ...this.activeModelFilter(), eventId: { $in: ids } })
      .select({ _id: 0, __v: 0 })
      .sort({ eventId: 1, marketId: 1, line: 1, selectionKey: 1 })
      .lean()
      .exec();
    return this.attachCurrentFreshness(rows as PlainRecord[]);
  }

  async getPricesForSelections(
    selections: Array<{
      eventId: string;
      marketId: string;
      selectionKey: string;
      line?: number;
    }>,
  ): Promise<OddsQuoteSnapshot[]> {
    const uniqueFilters = new Map<string, Record<string, unknown>>();
    for (const item of selections) {
      const eventId = clean(item.eventId);
      const marketId = clean(item.marketId);
      const selectionKey = clean(item.selectionKey);
      if (
        !eventId ||
        !marketId ||
        !selectionKey ||
        (item.line !== undefined && !Number.isFinite(item.line))
      )
        continue;
      const key = `${eventId}:${marketId}:${selectionKey}:${item.line === undefined ? '-' : item.line}`;
      uniqueFilters.set(key, {
        eventId,
        marketId,
        selectionKey,
        ...(item.line !== undefined
          ? { line: item.line }
          : { $or: [{ line: { $exists: false } }, { line: null }] }),
      });
    }
    const filters = [...uniqueFilters.values()];
    if (!filters.length) return [];
    const rows = await this.oddsModel
      .find({ $and: [this.activeModelFilter(), { $or: filters }] })
      .select({ _id: 0, __v: 0 })
      .lean()
      .exec();
    return this.attachCurrentFreshness(rows as PlainRecord[]);
  }

  async getPredictionReadinessForEvents(
    eventIds: string[],
  ): Promise<Map<string, any>> {
    const ids = unique(eventIds.map(clean).filter(Boolean));
    if (!ids.length) return new Map();

    // Process readiness lookups in bounded chunks. Callers may supply an entire
    // season of event IDs, but we should never materialize all Odds rows for that
    // season in one query.
    const result = new Map<string, any>();

    for (
      let offset = 0;
      offset < ids.length;
      offset += PREDICTION_READINESS_LOOKUP_BATCH_SIZE
    ) {
      const batchIds = ids.slice(
        offset,
        offset + PREDICTION_READINESS_LOOKUP_BATCH_SIZE,
      );

      // One superset projection replaces the old candidateRows + allRows
      // queries. Candidate readiness is derived from these same rows below,
      // avoiding duplicate documents and a second simultaneous result array.
      const allRows = await this.oddsModel
        .find({
          ...this.activeModelFilter(),
          eventId: { $in: batchIds },
        })
        .select({
          _id: 0,
          eventId: 1,
          marketId: 1,
          selectionKey: 1,
          line: 1,
          decimalOdds: 1,
          predictionReady: 1,
          calculationVersion: 1,
          priceType: 1,
          provider: 1,
          bookmaker: 1,
          pricingSource: 1,
          dataQuality: 1,
          sampleSize: 1,
          sourceDataHash: 1,
          fixtureSourceRevision: 1,
          oddsBasis: 1,
          fairOdds: 1,
          fairProbability: 1,
          externalBookmakerCount: 1,
          externalValidationStatus: 1,
          providerUpdatedAt: 1,
          sourceDataUpdatedAt: 1,
          updatedAt: 1,
        })
        .lean()
        .exec() as PlainRecord[];

      const currentFixtureRevisions =
        await this.sportsRevisions.getCurrentRevisions('FIXTURE', batchIds);

      const hasCurrentFixtureRevision = (row: PlainRecord): boolean => {
        const storedRevision = row.fixtureSourceRevision;
        if (storedRevision === undefined || storedRevision === null) return false;
        const expectedRevision = currentFixtureRevisions.get(String(row.eventId));
        const parsedRevision = Number(storedRevision);
        return expectedRevision !== undefined
          && Number.isSafeInteger(parsedRevision)
          && parsedRevision === expectedRevision;
      };

      const byEvent = new Map<string, PlainRecord[]>();
      const staleByEvent = new Map<string, number>();
      const readyByEvent = new Map<string, PlainRecord[]>();

      // Calculate priced, stale and ready counts in one pass over the single
      // bounded result set. This retains the existing market-specific rules.
      for (const row of allRows) {
        if (row.bookmaker !== 'Grivit' || row.pricingSource !== 'GRIVIT_MODEL') {
          continue;
        }

        const key = String(row.eventId);
        const pricedRows = byEvent.get(key) ?? [];
        pricedRows.push(row);
        byEvent.set(key, pricedRows);

        const currentFixtureRevision = hasCurrentFixtureRevision(row);
        if (!currentFixtureRevision) {
          staleByEvent.set(key, (staleByEvent.get(key) ?? 0) + 1);
        }

        // This reproduces the former candidate query predicates and validation:
        // active model row, current calculation version, current fixture revision,
        // valid decimal odds, and a sufficiently supported Grivit estimate.
        if (
          row.predictionReady !== true
          || row.calculationVersion !== ODDS_CONFIG.modelVersion
          || !currentFixtureRevision
        ) {
          continue;
        }

        const decimalOdds = Number(row.decimalOdds);
        if (
          !Number.isFinite(decimalOdds)
          || decimalOdds < 1.01
          || decimalOdds > ODDS_CONFIG.maximumDecimalOdds
        ) {
          continue;
        }

        // External bookmaker prices remain reference-only and never make a
        // fixture prediction-ready.
        if (row.priceType === 'PROVIDER') continue;

        if (
          row.priceType !== 'ESTIMATED'
          || row.bookmaker !== 'Grivit'
          || row.pricingSource !== 'GRIVIT_MODEL'
          || typeof row.sourceDataHash !== 'string'
          || row.sourceDataHash.length === 0
          || !Number.isFinite(Number(row.fairOdds))
          || Number(row.fairOdds) <= 1
          || !Number.isFinite(Number(row.fairProbability))
          || Number(row.fairProbability) <= 0
          || Number(row.fairProbability) >= 1
          || !(Number(row.dataQuality) >= ODDS_CONFIG.minimumPredictionDataQuality)
          || !(Number(row.sampleSize) >= ODDS_CONFIG.minimumHistoricalSampleSize)
        ) {
          continue;
        }

        const readyRows = readyByEvent.get(key) ?? [];
        readyRows.push(row);
        readyByEvent.set(key, readyRows);
      }

      for (const id of batchIds) {
        const priced = byEvent.get(id) ?? [];
        const staleSelections = staleByEvent.get(id) ?? 0;
        const ready = readyByEvent.get(id) ?? [];
        const providerCount = ready.filter(
          (row) => row.bookmaker === 'Grivit' && row.pricingSource === 'GRIVIT_MODEL',
        ).length;
        const estimates = ready.filter(
          (row) => row.priceType === 'ESTIMATED',
        ).length;
        const grouped = new Map<string, number>();
        for (const row of ready) {
          grouped.set(
            String(row.marketId),
            (grouped.get(String(row.marketId)) ?? 0) + 1,
          );
        }
        const latest = ready.reduce((max, row) => {
          // Queue reconciliation must see a regenerated Grivit price even when
          // the underlying Sports source timestamp itself did not change. The
          // Odds document's updatedAt is the authoritative calculation-change
          // timestamp for estimated prices; provider prices retain their feed time.
          const timestamp =
            row.priceType === 'PROVIDER'
              ? dateMs(row.providerUpdatedAt ?? row.updatedAt)
              : dateMs(row.updatedAt ?? row.sourceDataUpdatedAt);
          return Math.max(max, timestamp);
        }, 0);

        result.set(id, {
          eventId: id,
          ready: ready.length > 0,
          expectedSelections: priced.length,
          pricedSelections: priced.length,
          missingSelections: Math.max(0, priced.length - ready.length),
          notReadySelections: Math.max(0, priced.length - ready.length),
          latestOddsUpdatedAt: latest ? new Date(latest) : null,
          readySelections: ready.length,
          staleSelections,
          bookmakerSelections: providerCount,
          grivitSelections: providerCount,
          bookmakerInformedEstimates: 0,
          historicalEstimates: estimates,
          externalValidatedSelections: ready.filter((row) => Number(row.externalBookmakerCount ?? 0) > 0).length,
          priorOnlySelections: 0,
          marketCount: grouped.size,
          marketReadiness: [...grouped.entries()].map(
            ([marketId, selections]) => ({
              marketId,
              readySelections: selections,
            }),
          ),
          reason: ready.length
            ? null
            : staleSelections > 0
              ? 'Grivit prices are based on an older Sports fixture revision and are awaiting recalculation.'
              : priced.length
                ? 'Grivit prices exist, but none passed the current market-specific sample and data-quality requirements.'
                : 'No market currently has sufficient Sports historical data for a Grivit price.',
        });
      }
    }

    return result;
  }

  async removeFixturePrices(
    fixtureId: string,
    maximumFixtureSourceRevision?: number,
  ): Promise<number> {
    const filter: PlainRecord = { eventId: clean(fixtureId) };
    if (Number.isSafeInteger(maximumFixtureSourceRevision)
      && Number(maximumFixtureSourceRevision) >= 0) {
      filter.$and = [
        this.fixtureSourceRevisionAtMostFilter(Number(maximumFixtureSourceRevision)),
      ];
    }
    const result = await this.oddsModel.deleteMany(filter).exec();
    return result.deletedCount ?? 0;
  }

  /** Match rows at or behind a source revision, including legacy unversioned quotes. */
  private fixtureSourceRevisionAtMostFilter(revision: number): PlainRecord {
    return {
      $or: [
        { fixtureSourceRevision: { $lte: revision } },
        { fixtureSourceRevision: { $exists: false } },
        { fixtureSourceRevision: null },
      ],
    };
  }

  /** Delete a bounded batch of prices whose Sports fixture retention deadline passed. */
  async pruneExpiredPrices(batchSize = ODDS_CONFIG.expiredPriceCleanupBatchSize): Promise<number> {
    const safeBatchSize = Math.max(1, Math.min(5_000, Math.floor(batchSize)));
    const now = new Date();
    const expired = await this.oddsModel.find({ expiresAt: { $lte: now } })
      .select({ _id: 1 }).sort({ expiresAt: 1 }).limit(safeBatchSize).lean().exec() as Array<{ _id: unknown }>;
    if (!expired.length) return 0;
    const result = await this.oddsModel.deleteMany({
      _id: { $in: expired.map((item) => item._id) },
      expiresAt: { $lte: now },
    }).exec();
    return result.deletedCount ?? 0;
  }

  async getInventorySummary(): Promise<Record<string, unknown>> {
    const now = new Date();
    const [total, ready] = await Promise.all([
      this.oddsModel.countDocuments(this.activeModelFilter()).exec(),
      this.oddsModel
        .countDocuments({
          ...this.activeModelFilter(),
          predictionReady: true,
        })
        .exec(),
    ]);
    const [provider, estimated] = await Promise.all([
      this.oddsModel
        .countDocuments({ ...this.activeModelFilter(), priceType: 'PROVIDER' })
        .exec(),
      this.oddsModel
        .countDocuments({ ...this.activeModelFilter(), priceType: 'ESTIMATED' })
        .exec(),
    ]);
    const [grivit, externalValidated] = await Promise.all([
      this.oddsModel
        .countDocuments({
          ...this.activeModelFilter(),
          bookmaker: 'Grivit',
          pricingSource: 'GRIVIT_MODEL',
        })
        .exec(),
      this.oddsModel
        .countDocuments({
          ...this.activeModelFilter(),
          externalValidationStatus: 'VALIDATED',
        })
        .exec(),
    ]);
    const [marketGroups, latest] = await Promise.all([
      this.oddsModel
        .aggregate([
          { $match: this.activeModelFilter() },
          {
            $group: {
              _id: '$marketId',
              selections: { $sum: 1 },
              predictionReady: {
                $sum: { $cond: ['$predictionReady', 1, 0] },
              },
            },
          },
          { $sort: { selections: -1 } },
        ])
        .exec(),
      this.oddsModel
        .findOne(this.activeModelFilter())
        .sort({ updatedAt: -1 })
        .select({ updatedAt: 1 })
        .lean()
        .exec(),
    ]);
    return {
      generatedAt: now,
      totalSelections: total,
      predictionReadySelections: ready,
      providerSelections: provider,
      estimatedSelections: estimated,
      grivitSelections: grivit,
      externallyValidatedSelections: externalValidated,
      bookmakerOfRecord: 'Grivit',
      marketInventory: marketGroups,
      latestUpdatedAt:
        (latest as { updatedAt?: Date | null } | null)?.updatedAt ?? null,
    };
  }

  private extractProviderQuotes(
    snapshot: SportsMatchOddsSnapshotRecord | null,
    match: SportsMatchReadModel,
  ): ProviderQuote[] {
    if (
      !snapshot ||
      !isOddsQuoteFresh(
        snapshot.source.providerUpdatedAt ?? snapshot.collectedAt,
      )
    )
      return [];
    const homeName = normalized(
      match.homeTeam?.displayName ?? match.homeTeam?.name,
    );
    const awayName = normalized(
      match.awayTeam?.displayName ?? match.awayTeam?.name,
    );
    const byKey = new Map<string, ProviderQuote>();
    for (const bookmaker of snapshot.bookmakers ?? []) {
      for (const market of bookmaker.markets ?? []) {
        const marketId = this.resolveProviderMarket(market);
        if (!marketId) continue;
        const definition = FOOTBALL_MARKET_CATALOG.find(
          (item) => item.id === marketId,
        );
        if (!definition || !definition.pricingEnabled) continue;
        for (const outcome of market.outcomes ?? []) {
          if (outcome.isSuspended) continue;
          const mapped = this.mapProviderOutcome(
            definition.id,
            outcome,
            market,
            homeName,
            awayName,
          );
          if (!mapped) continue;
          if (
            !Number.isFinite(mapped.decimalOdds) ||
            mapped.decimalOdds < 1.01 ||
            mapped.decimalOdds > ODDS_CONFIG.maximumDecimalOdds
          )
            continue;
          const providerUpdatedAt =
            toValidDate(market.providerUpdatedAt) ??
            toValidDate(snapshot.source.providerUpdatedAt) ??
            snapshot.collectedAt;
          if (!isOddsQuoteFresh(providerUpdatedAt)) continue;
          const bookmakerName = clean(bookmaker.bookmakerName);
          if (!bookmakerName) continue;
          const quote: ProviderQuote = {
            marketId: definition.id,
            selectionKey: mapped.selectionKey,
            ...(mapped.line !== undefined ? { line: mapped.line } : {}),
            decimalOdds: mapped.decimalOdds,
            // Sports is the exclusive source of bookmaker snapshots. ESPN and
            // ESPN Summary are both represented as the canonical ESPN provider.
            provider: 'ESPN',
            bookmaker: bookmakerName,
            providerUpdatedAt,
          };
          const selectionKey = this.priceKey(
            quote.marketId,
            quote.selectionKey,
            quote.line,
          );
          const key = `${selectionKey}:${normalized(quote.bookmaker)}`;
          const old = byKey.get(key);
          if (
            !old ||
            quote.providerUpdatedAt.getTime() >
              old.providerUpdatedAt.getTime() ||
            (quote.providerUpdatedAt.getTime() ===
              old.providerUpdatedAt.getTime() &&
              quote.decimalOdds > old.decimalOdds)
          ) {
            byKey.set(key, quote);
          }
        }
      }
    }
    return [...byKey.values()];
  }

  private resolveProviderMarket(market: SportsOddsMarket): string | null {
    const fields = [market.marketId, market.marketKey, market.marketName]
      .map((value) => normalized(value))
      .filter(Boolean);
    const raw = fields.join(' ');

    // Prefer exact normalized market IDs/keys before interpreting provider labels.
    const exact = FOOTBALL_MARKET_CATALOG.find((item) =>
      fields.some((field) =>
        [
          item.id,
          item.predictionMarketKey,
          item.betLabMarketCode,
          item.fullName,
          item.abbreviation,
        ].some((candidate) => normalized(candidate) === field),
      ),
    );
    if (exact) return exact.id;

    const candidates: Array<[string, RegExp]> = [
      [
        'BOTH_TEAMS_TO_SCORE_AND_RESULT',
        /both teams to score.*(match )?result|btts.*(match )?result/,
      ],
      [
        'BOTH_TEAMS_TO_SCORE_AND_TOTAL_GOALS',
        /both teams to score.*(total )?goals|btts.*(total )?goals/,
      ],
      [
        'HALF_TIME_CORRECT_SCORE',
        /half.?time correct score|first half correct score|1st half correct score/,
      ],
      [
        'FIRST_HALF_DOUBLE_CHANCE',
        /half.?time double chance|first half double chance|1st half double chance/,
      ],
      [
        'HALF_TIME_RESULT',
        /half.?time result|first half result|1st half result|half.?time 1x2/,
      ],
      [
        'SECOND_HALF_RESULT',
        /second half result|2nd half result|second half 1x2/,
      ],
      ['HALF_TIME_FULL_TIME', /half.?time.?full.?time|ht.?ft/],
      ['MOST_GOALS_HALF', /highest scoring half|most goals half/],
      [
        'HALF_TIME_GOALS_ODD_EVEN',
        /half.?time goals odd even|first half goals odd even/,
      ],
      [
        'BOTH_TEAMS_TO_SCORE_FIRST_HALF',
        /both teams to score.*first half|first half.*both teams to score/,
      ],
      [
        'BOTH_TEAMS_TO_SCORE_SECOND_HALF',
        /both teams to score.*second half|second half.*both teams to score/,
      ],
      ['HOME_TEAM_TO_SCORE_IN_BOTH_HALVES', /home team.*score in both halves/],
      ['AWAY_TEAM_TO_SCORE_IN_BOTH_HALVES', /away team.*score in both halves/],
      ['GOAL_IN_BOTH_HALVES', /goal in both halves|goals in both halves/],
      ['HOME_TEAM_TO_WIN_TO_NIL', /home team.*win to nil|home win to nil/],
      ['AWAY_TEAM_TO_WIN_TO_NIL', /away team.*win to nil|away win to nil/],
      ['HOME_TEAM_CLEAN_SHEET', /home team clean sheet|home clean sheet/],
      ['AWAY_TEAM_CLEAN_SHEET', /away team clean sheet|away clean sheet/],
      ['HOME_TEAM_TO_SCORE', /home team to score|home team score/],
      ['AWAY_TEAM_TO_SCORE', /away team to score|away team score/],
      ['TOTAL_GOALS_ODD_EVEN', /total goals odd even|goals odd even/],
      ['TOTAL_CORNERS_ODD_EVEN', /corners odd even|corner.*odd.*even/],
      ['CORNER_MATCH_RESULT', /corner.*(match result|1x2)|corner match result/],
      ['TOTAL_CARDS_ODD_EVEN', /cards odd even|card.*odd.*even/],
      ['TOTAL_GOALS_RANGE', /total goals range|goals range/],
      ['EXACT_TOTAL_GOALS', /exact total goals|exact goals/],
      ['WINNING_MARGIN', /winning margin|win margin/],
      ['TEAM_TO_SCORE_FIRST', /first team to score|team to score first/],
      ['TEAM_TO_SCORE_LAST', /last team to score|team to score last/],
      ['EUROPEAN_HANDICAP', /european handicap/],
      ['ASIAN_TOTAL_GOALS', /asian total goals|asian goals over under/],
      ['MATCH_RESULT', /\b(h2h|moneyline|match winner|match result|1x2)\b/],
      ['DOUBLE_CHANCE', /double chance/],
      ['DRAW_NO_BET', /draw no bet/],
      ['ASIAN_HANDICAP', /asian handicap|\bspreads?\b|handicap/],
      [
        'FIRST_HALF_TOTAL_GOALS',
        /first half.*(total|goals)|1st half.*(total|goals)/,
      ],
      [
        'SECOND_HALF_TOTAL_GOALS',
        /second half.*(total|goals)|2nd half.*(total|goals)/,
      ],
      ['BOTH_TEAMS_TO_SCORE', /both teams to score|btts/],
      ['TOTAL_YELLOW_CARDS_OVER_UNDER', /yellow cards/],
      ['TOTAL_RED_CARDS_OVER_UNDER', /red cards/],
      ['HOME_TEAM_CORNERS_OVER_UNDER', /home team corners|home corners/],
      ['AWAY_TEAM_CORNERS_OVER_UNDER', /away team corners|away corners/],
      ['HOME_TEAM_CARDS_OVER_UNDER', /home team cards|home cards/],
      ['AWAY_TEAM_CARDS_OVER_UNDER', /away team cards|away cards/],
      [
        'HOME_SHOTS_ON_TARGET_OVER_UNDER',
        /home shots on target|home shots on goal/,
      ],
      [
        'AWAY_SHOTS_ON_TARGET_OVER_UNDER',
        /away shots on target|away shots on goal/,
      ],
      ['TOTAL_CORNERS_OVER_UNDER', /total corners|corners total/],
      ['TOTAL_CARDS_OVER_UNDER', /total cards|cards total/],
      ['TOTAL_SHOTS_ON_TARGET_OVER_UNDER', /shots on target|shots on goal/],
      ['TOTAL_SHOTS_OVER_UNDER', /total shots|shots total/],
      ['TOTAL_FOULS_OVER_UNDER', /total fouls|fouls total/],
      ['TOTAL_OFFSIDES_OVER_UNDER', /total offsides|offsides total/],
      ['HOME_TEAM_GOALS_OVER_UNDER', /home team goals|home goals over under/],
      ['AWAY_TEAM_GOALS_OVER_UNDER', /away team goals|away goals over under/],
      [
        'TOTAL_GOALS_OVER_UNDER',
        /total goals|goals total|over under goals|goal totals/,
      ],
      ['RED_CARD', /red card in match|red card/],
      ['PENALTY_AWARDED', /penalt(y|ies) awarded|penalty in match/],
      ['OWN_GOAL_SCORED', /own goal/],
      ['CORRECT_SCORE', /correct score/],
    ];
    for (const [id, expression] of candidates)
      if (expression.test(raw)) return id;
    return null;
  }

  private mapProviderOutcome(
    marketId: string,
    outcome: SportsOddsOutcome,
    market: SportsOddsMarket,
    homeName: string,
    awayName: string,
  ): { selectionKey: string; line?: number; decimalOdds: number } | null {
    const rawLabel = String(outcome.selection ?? '');
    const label = normalized(rawLabel);
    const price = Number(outcome.price);
    const point =
      typeof outcome.point === 'number' && Number.isFinite(outcome.point)
        ? outcome.point
        : this.parseLine(`${market.marketName} ${outcome.selection}`);
    const totalMarketIds = new Set([
      'TOTAL_GOALS_OVER_UNDER',
      'ASIAN_TOTAL_GOALS',
      'FIRST_HALF_TOTAL_GOALS',
      'SECOND_HALF_TOTAL_GOALS',
      'TOTAL_CORNERS_OVER_UNDER',
      'HOME_TEAM_CORNERS_OVER_UNDER',
      'AWAY_TEAM_CORNERS_OVER_UNDER',
      'TOTAL_CARDS_OVER_UNDER',
      'TOTAL_YELLOW_CARDS_OVER_UNDER',
      'TOTAL_RED_CARDS_OVER_UNDER',
      'HOME_TEAM_CARDS_OVER_UNDER',
      'AWAY_TEAM_CARDS_OVER_UNDER',
      'TOTAL_SHOTS_OVER_UNDER',
      'TOTAL_SHOTS_ON_TARGET_OVER_UNDER',
      'HOME_TEAM_GOALS_OVER_UNDER',
      'AWAY_TEAM_GOALS_OVER_UNDER',
      'HOME_SHOTS_ON_TARGET_OVER_UNDER',
      'AWAY_SHOTS_ON_TARGET_OVER_UNDER',
      'TOTAL_FOULS_OVER_UNDER',
      'TOTAL_OFFSIDES_OVER_UNDER',
    ]);
    if (totalMarketIds.has(marketId)) {
      if (point === null || point === undefined) return null;
      const side = /\bover\b/.test(label)
        ? 'OVER'
        : /\bunder\b/.test(label)
          ? 'UNDER'
          : null;
      if (!side) return null;
      const definition = FOOTBALL_MARKET_CATALOG.find(
        (item) => item.id === marketId,
      );
      if (!definition?.lines?.some((line) => Math.abs(line - point) < 0.001))
        return null;
      return {
        selectionKey: `${side}_${canonicalLineSlug(point)}`,
        line: point,
        decimalOdds: price,
      };
    }
    if (marketId === 'EUROPEAN_HANDICAP') {
      if (point === null || point === undefined) return null;
      const result = /draw|tie|level/.test(label)
        ? 'DRAW'
        : label === '1' || /^home\b/.test(label) || (homeName && label.includes(homeName))
          ? 'HOME_WIN'
          : label === '2' || /^away\b/.test(label) || (awayName && label.includes(awayName))
            ? 'AWAY_WIN'
            : null;
      if (!result) return null;
      const definition = FOOTBALL_MARKET_CATALOG.find(
        (item) => item.id === marketId,
      );
      const selectionKey = `${result}_${canonicalLineSlug(point)}`;
      return definition &&
        expandCanonicalSelections(definition).some(
          (item) => item.key === selectionKey,
        )
        ? { selectionKey, line: point, decimalOdds: price }
        : null;
    }
    if (marketId === 'ASIAN_HANDICAP') {
      if (point === null || point === undefined) return null;
      const side =
        label === '1' ||
        /^home\b/.test(label) ||
        label === homeName ||
        (homeName && label.includes(homeName))
          ? 'HOME'
          : label === '2' ||
              /^away\b/.test(label) ||
              label === awayName ||
              (awayName && label.includes(awayName))
            ? 'AWAY'
            : null;
      if (!side) return null;
      const definition = FOOTBALL_MARKET_CATALOG.find(
        (item) => item.id === 'ASIAN_HANDICAP',
      );
      if (!definition?.lines?.some((line) => Math.abs(line - point) < 0.001))
        return null;
      return {
        selectionKey: `${side}_${canonicalLineSlug(point)}`,
        line: point,
        decimalOdds: price,
      };
    }
    if (marketId === 'EXACT_TOTAL_GOALS') {
      const exact =
        label.match(/^(\d+)(?: goals?)?$/) ?? label.match(/^(\d+) plus$/);
      const key =
        /6\s*(?:\+|plus|or more)/i.test(rawLabel) ||
        /6 plus|6 or more/.test(label)
          ? 'GOALS_6_PLUS'
          : exact
            ? `GOALS_${exact[1]}`
            : null;
      const definition = FOOTBALL_MARKET_CATALOG.find(
        (item) => item.id === marketId,
      );
      return key && definition?.selections.some((item) => item.key === key)
        ? { selectionKey: key, decimalOdds: price }
        : null;
    }
    if (marketId === 'TOTAL_GOALS_RANGE') {
      const range = rawLabel.match(/(\d+)\s*(?:-|to)\s*(\d+)/i) ?? label.match(/(\d+)\s+(\d+)/);
      const key =
        /6\s*(?:\+|plus|or more)/i.test(rawLabel) ||
        /6 plus|6 or more/.test(label)
          ? 'GOALS_6_PLUS'
          : range
            ? `GOALS_${range[1]}_${range[2]}`
            : null;
      const definition = FOOTBALL_MARKET_CATALOG.find(
        (item) => item.id === marketId,
      );
      return key && definition?.selections.some((item) => item.key === key)
        ? { selectionKey: key, decimalOdds: price }
        : null;
    }
    if (
      marketId === 'CORRECT_SCORE' ||
      marketId === 'HALF_TIME_CORRECT_SCORE'
    ) {
      const other = /any other home|other home win/.test(label)
        ? 'ANY_OTHER_HOME'
        : /any other draw|other draw/.test(label)
          ? 'ANY_OTHER_DRAW'
          : /any other away|other away win/.test(label)
            ? 'ANY_OTHER_AWAY'
            : null;
      const score = rawLabel.match(/(\d+)\s*(?:-|:|to)\s*(\d+)/i) ?? label.match(/(\d+)\s+(\d+)/);
      const selectionKey =
        other ?? (score ? `SCORE_${score[1]}_${score[2]}` : null);
      const definition = FOOTBALL_MARKET_CATALOG.find(
        (item) => item.id === marketId,
      );
      return selectionKey &&
        definition?.selections.some((item) => item.key === selectionKey)
        ? { selectionKey, decimalOdds: price }
        : null;
    }
    if (marketId === 'MOST_GOALS_HALF') {
      const key = /first half|1st half/.test(label)
        ? 'FIRST_HALF'
        : /second half|2nd half/.test(label)
          ? 'SECOND_HALF'
          : /tie|equal|draw/.test(label)
            ? 'EQUAL'
            : null;
      return key ? { selectionKey: key, decimalOdds: price } : null;
    }
    if (marketId === 'HALF_TIME_FULL_TIME') {
      const tokens =
        String(outcome.selection ?? '')
          .toUpperCase()
          .match(/HOME|DRAW|AWAY|\b1\b|\bX\b|\b2\b/g) ?? [];
      if (tokens.length < 2) return null;
      const mapToken = (token: string) =>
        token === '1' || token === 'HOME'
          ? 'HOME'
          : token === 'X' || token === 'DRAW'
            ? 'DRAW'
            : 'AWAY';
      const selectionKey = `${mapToken(tokens[0]!)}_${mapToken(tokens[1])}`;
      const definition = FOOTBALL_MARKET_CATALOG.find(
        (item) => item.id === marketId,
      );
      return definition?.selections.some((item) => item.key === selectionKey)
        ? { selectionKey, decimalOdds: price }
        : null;
    }
    if (marketId === 'BOTH_TEAMS_TO_SCORE_AND_RESULT') {
      const result = /draw|tie/.test(label)
        ? 'DRAW'
        : label.includes(homeName) || /home win|\b1\b/.test(label)
          ? 'HOME'
          : label.includes(awayName) || /away win|\b2\b/.test(label)
            ? 'AWAY'
            : null;
      const btts = /\bno\b|ng/.test(label)
        ? 'NO'
        : /\byes\b|gg/.test(label)
          ? 'YES'
          : null;
      const selectionKey = result && btts ? `${result}_${btts}` : null;
      const definition = FOOTBALL_MARKET_CATALOG.find(
        (item) => item.id === marketId,
      );
      return selectionKey &&
        definition?.selections.some((item) => item.key === selectionKey)
        ? { selectionKey, decimalOdds: price }
        : null;
    }
    if (marketId === 'BOTH_TEAMS_TO_SCORE_AND_TOTAL_GOALS') {
      if (point === null || point === undefined) return null;
      const btts = /\bno\b|ng/.test(label)
        ? 'NO'
        : /\byes\b|gg/.test(label)
          ? 'YES'
          : null;
      const side = /\bover\b/.test(label)
        ? 'OVER'
        : /\bunder\b/.test(label)
          ? 'UNDER'
          : null;
      const selectionKey =
        btts && side ? `${btts}_${side}_${canonicalLineSlug(point)}` : null;
      const definition = FOOTBALL_MARKET_CATALOG.find(
        (item) => item.id === marketId,
      );
      return selectionKey &&
        definition?.selections.some((item) => item.key === selectionKey)
        ? { selectionKey, line: point, decimalOdds: price }
        : null;
    }
    if (marketId === 'WINNING_MARGIN') {
      const side = /\bhome\b/.test(label)
        ? 'HOME'
        : /\baway\b/.test(label)
          ? 'AWAY'
          : /\b1\b/.test(label)
            ? 'HOME'
            : /\b2\b/.test(label)
              ? 'AWAY'
              : null;
      const margin = /3 plus|3 or more|by 3/.test(label)
        ? '3_PLUS'
        : /by 2|2 goals/.test(label)
          ? '2'
          : /by 1|1 goal/.test(label)
            ? '1'
            : null;
      const key = /draw|tie|level/.test(label)
        ? 'DRAW'
        : side && margin
          ? `${side}_BY_${margin}`
          : null;
      const definition = FOOTBALL_MARKET_CATALOG.find(
        (item) => item.id === marketId,
      );
      return key && definition?.selections.some((item) => item.key === key)
        ? { selectionKey: key, decimalOdds: price }
        : null;
    }
    if (
      [
        'HOME_TEAM_TO_SCORE',
        'AWAY_TEAM_TO_SCORE',
        'HOME_TEAM_CLEAN_SHEET',
        'AWAY_TEAM_CLEAN_SHEET',
        'HOME_TEAM_TO_WIN_TO_NIL',
        'AWAY_TEAM_TO_WIN_TO_NIL',
        'BOTH_TEAMS_TO_SCORE',
        'BOTH_TEAMS_TO_SCORE_FIRST_HALF',
        'BOTH_TEAMS_TO_SCORE_SECOND_HALF',
        'GOAL_IN_BOTH_HALVES',
        'HOME_TEAM_TO_SCORE_IN_BOTH_HALVES',
        'AWAY_TEAM_TO_SCORE_IN_BOTH_HALVES',
        'RED_CARD',
        'PENALTY_AWARDED',
        'OWN_GOAL_SCORED',
      ].includes(marketId)
    ) {
      const key = /^(yes|gg|true)$/.test(label)
        ? 'YES'
        : /^(no|ng|false)$/.test(label)
          ? 'NO'
          : null;
      return key ? { selectionKey: key, decimalOdds: price } : null;
    }
    if (
      marketId === 'TEAM_TO_SCORE_FIRST' ||
      marketId === 'TEAM_TO_SCORE_LAST'
    ) {
      const key = /no goal|no team/.test(label)
        ? 'NO_GOAL'
        : label === '1' ||
            /^home\b/.test(label) ||
            label === homeName ||
            (homeName && label.includes(homeName))
          ? 'HOME'
          : label === '2' ||
              /^away\b/.test(label) ||
              label === awayName ||
              (awayName && label.includes(awayName))
            ? 'AWAY'
            : null;
      return key ? { selectionKey: key, decimalOdds: price } : null;
    }
    if (
      marketId === 'TOTAL_GOALS_ODD_EVEN' ||
      marketId === 'TOTAL_CORNERS_ODD_EVEN' ||
      marketId === 'TOTAL_CARDS_ODD_EVEN' ||
      marketId === 'HALF_TIME_GOALS_ODD_EVEN'
    ) {
      const key = /\bodd\b/.test(label)
        ? 'ODD'
        : /\beven\b/.test(label)
          ? 'EVEN'
          : null;
      return key ? { selectionKey: key, decimalOdds: price } : null;
    }
    if (
      marketId === 'MATCH_RESULT' ||
      marketId === 'CORNER_MATCH_RESULT' ||
      marketId === 'HALF_TIME_RESULT' ||
      marketId === 'SECOND_HALF_RESULT'
    ) {
      const key =
        label === 'draw' || label === 'tie' || label === 'x'
          ? 'DRAW'
          : label === '1' ||
              /^home\b/.test(label) ||
              label === homeName ||
              (homeName && label.includes(homeName))
            ? 'HOME_WIN'
            : label === '2' ||
                /^away\b/.test(label) ||
                label === awayName ||
                (awayName && label.includes(awayName))
              ? 'AWAY_WIN'
              : null;
      return key ? { selectionKey: key, decimalOdds: price } : null;
    }
    if (
      marketId === 'DOUBLE_CHANCE' ||
      marketId === 'FIRST_HALF_DOUBLE_CHANCE'
    ) {
      const key = /1x|home.*draw/.test(label)
        ? 'HOME_OR_DRAW'
        : /x2|draw.*away/.test(label)
          ? 'DRAW_OR_AWAY'
          : /12|home.*away/.test(label)
            ? 'HOME_OR_AWAY'
            : null;
      return key ? { selectionKey: key, decimalOdds: price } : null;
    }
    if (marketId === 'DRAW_NO_BET') {
      const key =
        label === 'home' || /^home\b/.test(label) || (homeName && label.includes(homeName))
          ? 'HOME_DNB'
          : label === 'away' || /^away\b/.test(label) || (awayName && label.includes(awayName))
            ? 'AWAY_DNB'
            : null;
      return key ? { selectionKey: key, decimalOdds: price } : null;
    }
    if (marketId === 'BOTH_TEAMS_TO_SCORE') {
      const key = /yes|gg/.test(label)
        ? 'YES'
        : /no|ng/.test(label)
          ? 'NO'
          : null;
      return key ? { selectionKey: key, decimalOdds: price } : null;
    }
    return null;
  }

  private calculateProviderFairPrices(quotes: ProviderQuote[]): Array<{
    marketId: string;
    selectionKey: string;
    line?: number;
    marketFairOdds: number;
    fairProbability: number;
    bookmakerCount: number;
    validatedAt: Date;
  }> {
    const byMarket = new Map<string, ProviderQuote[]>();
    for (const quote of quotes) {
      // Handicap sides commonly use opposite signed lines. Do not combine
      // unmatched handicaps into a false consensus; individual offers remain
      // available, while model fair odds remain the comparable benchmark.
      if (quote.marketId === 'ASIAN_HANDICAP') continue;
      const key = `${quote.marketId}:${quote.line ?? '-'}`;
      const values = byMarket.get(key) ?? [];
      values.push(quote);
      byMarket.set(key, values);
    }

    const result: Array<{
      marketId: string;
      selectionKey: string;
      line?: number;
      marketFairOdds: number;
      fairProbability: number;
      bookmakerCount: number;
      validatedAt: Date;
    }> = [];
    for (const values of byMarket.values()) {
      const marketId = values[0]?.marketId;
      if (!marketId) continue;
      const definition = FOOTBALL_MARKET_CATALOG.find(
        (item) => item.id === marketId,
      );
      if (!definition) continue;

      const expectedKeys =
        definition.selectionMode === 'OVER_UNDER'
          ? [
              `OVER_${canonicalLineSlug(values[0].line ?? 0)}`,
              `UNDER_${canonicalLineSlug(values[0].line ?? 0)}`,
            ]
          : expandCanonicalSelections(definition)
              .filter((selection) =>
                values[0].line === undefined
                  ? selection.line === undefined
                  : selection.line !== undefined &&
                    Math.abs(selection.line - values[0].line) < 0.001,
              )
              .map((selection) => selection.key);
      if (expectedKeys.length < 2) continue;

      const byBookmaker = new Map<string, ProviderQuote[]>();
      for (const quote of values) {
        const bookmakerKey = normalized(quote.bookmaker);
        const list = byBookmaker.get(bookmakerKey) ?? [];
        list.push(quote);
        byBookmaker.set(bookmakerKey, list);
      }

      const probabilityTotals = new Map<string, number>();
      const probabilitySamples = new Map<string, number>();
      let latestValidationTimestamp = 0;
      for (const bookmakerQuotes of byBookmaker.values()) {
        const quoteBySelection = new Map<string, ProviderQuote>();
        for (const quote of bookmakerQuotes) {
          const previous = quoteBySelection.get(quote.selectionKey);
          if (
            !previous ||
            quote.providerUpdatedAt.getTime() >
              previous.providerUpdatedAt.getTime() ||
            (quote.providerUpdatedAt.getTime() ===
              previous.providerUpdatedAt.getTime() &&
              quote.decimalOdds > previous.decimalOdds)
          ) {
            quoteBySelection.set(quote.selectionKey, quote);
          }
        }
        // Never remove vig from a partial market. Every canonical outcome must
        // be present from the same bookmaker before that bookmaker contributes.
        if (!expectedKeys.every((key) => quoteBySelection.has(key))) continue;
        const bookmakerLatestTimestamp = Math.max(
          ...expectedKeys.map((key) => quoteBySelection.get(key)!.providerUpdatedAt.getTime()),
        );
        latestValidationTimestamp = Math.max(latestValidationTimestamp, bookmakerLatestTimestamp);
        const implied = expectedKeys.map(
          (key) => 1 / quoteBySelection.get(key)!.decimalOdds,
        );
        const overround = implied.reduce((sum, value) => sum + value, 0);
        if (!Number.isFinite(overround) || overround <= 0) continue;
        expectedKeys.forEach((key, index) => {
          probabilityTotals.set(
            key,
            (probabilityTotals.get(key) ?? 0) + implied[index] / overround,
          );
          probabilitySamples.set(key, (probabilitySamples.get(key) ?? 0) + 1);
        });
      }

      for (const key of expectedKeys) {
        const samples = probabilitySamples.get(key) ?? 0;
        const total = probabilityTotals.get(key) ?? 0;
        if (!samples || total <= 0) continue;
        const fairProbability = total / samples;
        const quote = values.find((item) => item.selectionKey === key);
        if (!quote) continue;
        result.push({
          marketId,
          selectionKey: key,
          ...(quote.line !== undefined ? { line: quote.line } : {}),
          marketFairOdds: round(1 / fairProbability, 4),
          fairProbability: round(fairProbability, 8),
          bookmakerCount: samples,
          validatedAt: new Date(latestValidationTimestamp),
        });
      }
    }
    return result;
  }

  private priceKey(
    marketId: string,
    selectionKey: string,
    line?: number,
  ): string {
    return `${marketId}:${selectionKey}:${line === undefined ? '-' : round(line, 3)}`;
  }

  private parseLine(value: string): number | null {
    const match =
      value.match(
        /(?:over|under|total|handicap|spread)[^0-9-]*(-?\d+(?:\.\d+)?)/i,
      ) ?? value.match(/(-?\d+(?:\.\d+)?)/);
    if (!match) return null;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private activeFilter(eventId: string): Record<string, unknown> {
    return { eventId, ...this.activeModelFilter() };
  }

  /** Only the active model version is visible to Prediction, Bet Lab and monitors. */
  private activeModelFilter(): Record<string, unknown> {
    return { ...this.activeExpiryFilter(), calculationVersion: ODDS_CONFIG.modelVersion };
  }

  private activeExpiryFilter(): Record<string, unknown> {
    return {
      $or: [
        { expiresAt: { $exists: false } },
        { expiresAt: { $gt: new Date() } },
      ],
    };
  }

  private async attachCurrentFreshness(
    rows: PlainRecord[],
  ): Promise<OddsQuoteSnapshot[]> {
    if (!rows.length) return [];
    const eventIds = unique(rows.map((row) => clean(row.eventId)).filter(Boolean));
    const currentRevisions = await this.sportsRevisions.getCurrentRevisions(
      'FIXTURE',
      eventIds,
    );
    return rows.map((row) => this.attachFreshness(
      row,
      currentRevisions.get(clean(row.eventId)),
    ));
  }

  private attachFreshness(
    row: PlainRecord,
    currentFixtureRevision: number | undefined,
  ): OddsQuoteSnapshot {
    const capturedAt =
      toValidDate(row.providerUpdatedAt) ??
      toValidDate(row.sourceDataUpdatedAt) ??
      toValidDate(row.updatedAt);
    const storedFixtureRevision = row.fixtureSourceRevision;
    const fixtureRevisionIsCurrent = storedFixtureRevision !== undefined
      && storedFixtureRevision !== null
      && currentFixtureRevision !== undefined
      && Number.isSafeInteger(Number(storedFixtureRevision))
      && Number(storedFixtureRevision) === currentFixtureRevision;
    const isFresh =
      row.priceType === 'PROVIDER'
        ? false
        : row.priceType === 'ESTIMATED'
          ? row.bookmaker === 'Grivit' &&
            row.pricingSource === 'GRIVIT_MODEL' &&
            row.calculationVersion === ODDS_CONFIG.modelVersion &&
            typeof row.sourceDataHash === 'string' && row.sourceDataHash.length > 0 &&
            fixtureRevisionIsCurrent
          : false;
    const freshUntil = row.priceType === 'PROVIDER' && capturedAt
      ? new Date(capturedAt.getTime() + ODDS_CONFIG.maximumQuoteAgeHours * 3_600_000)
      : null;
    return {
      ...row,
      oddsCapturedAt: capturedAt,
      oddsFreshUntil: freshUntil,
      isFresh,
    } as OddsQuoteSnapshot;
  }

  private async assertFixtureSourceRevisionUnchanged(
    fixtureId: string,
    expectedRevision: number,
  ): Promise<void> {
    const currentRevision = await this.sportsRevisions.getCurrentRevision(
      'FIXTURE',
      fixtureId,
    );
    if (currentRevision === expectedRevision) return;

    const error = new Error(
      `Sports fixture ${fixtureId} changed during Grivit pricing (revision ${expectedRevision} -> ${currentRevision}); retry required.`,
    );
    Object.assign(error, { retryable: true });
    throw error;
  }

  private latestDate(values: unknown[]): Date {
    const dates = values
      .map(toValidDate)
      .filter((value): value is Date => Boolean(value));
    return dates.reduce(
      (latest, value) => (value.getTime() > latest.getTime() ? value : latest),
      new Date(0),
    );
  }

  private readinessSourceFingerprint(
    readiness: OddsPricingContext['readiness'],
  ): Record<string, unknown> {
    return {
      fixtureId: readiness.fixtureId,
      competitionId: readiness.competitionId,
      seasonId: readiness.seasonId,
      fixtureEligible: readiness.fixtureEligible,
      fixtureIneligibleReason: readiness.fixtureIneligibleReason,
      scoreMatrix: readiness.scoreMatrix,
      periodMatrix: readiness.periodMatrix,
      goalOrderMarkets: readiness.goalOrderMarkets,
      teamStatistics: readiness.teamStatistics,
      timeline: readiness.timeline,
      eventMarkets: readiness.eventMarkets,
      playerMarkets: readiness.playerMarkets,
      sourceComputedAt: readiness.sourceComputedAt,
    };
  }

  private createSourceHash(
    context: OddsPricingContext,
    revision: number,
    fixtureSourceRevision: number,
  ): string {
    const match = context.match;
    const payload = {
      fixtureId: match.fixture.id,
      kickoffAt: match.fixture.kickoffAt,
      fixtureStatus: match.fixture.status,
      fixtureRetentionExpiresAt: (match.fixture as any).retentionExpiresAt,
      fixtureUpdatedAt: match.fixture.updatedAt,
      fixtureCollectedAt: match.fixture.source.collectedAt,
      competitorScores: match.fixture.competitors.map((item) => [
        item.teamId,
        item.score,
      ]),
      periodScores: match.fixture.periodScores,
      latestOddsId: match.latestOdds?.id,
      latestOddsCollectedAt: match.latestOdds?.collectedAt,
      latestOddsBookmakers: match.latestOdds?.bookmakers,
      homeScoring: context.homeScoring,
      awayScoring: context.awayScoring,
      homeAway: context.homeAwayRecord,
      awayAway: context.awayAwayRecord,
      competitionScoring: context.competitionScoring,
      homeStatistics: context.homeStatistics,
      awayStatistics: context.awayStatistics,
      h2h: context.headToHead,
      recentHomeFixtures: context.homeTeamData?.recentFixtures?.map((item) => [
        item.id,
        item.updatedAt,
        item.competitors,
        item.periodScores,
      ]),
      recentAwayFixtures: context.awayTeamData?.recentFixtures?.map((item) => [
        item.id,
        item.updatedAt,
        item.competitors,
        item.periodScores,
      ]),
      homeForm: context.homeTeamData?.form,
      awayForm: context.awayTeamData?.form,
      // checkedAt is observation metadata, not source data. Excluding it keeps
      // unchanged source snapshots idempotent instead of forcing a repricing
      // every time the worker re-evaluates readiness.
      sportsReadiness: this.readinessSourceFingerprint(context.readiness),
      revision,
      fixtureSourceRevision,
      modelVersion: ODDS_CONFIG.modelVersion,
      grivitOverroundPercent: ODDS_CONFIG.grivitOverroundPercent,
    };
    return createHash('sha256')
      .update(
        JSON.stringify(payload, (_key: string, value: unknown) =>
          value instanceof Date ? value.toISOString() : value,
        ),
      )
      .digest('hex');
  }


}
