import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';

import { PredictionSlip } from '../schemas/prediction-slip.schema';
import { SlipCenterGenerationLock } from '../schemas/slip-center-generation-lock.schema';
import { MarketPrediction } from '../schemas/market-prediction.schema';
import { PickCenter } from '../schemas/pick-center.schema';
import { SlipStatus } from '../enums/slip-status.enum';
import { SlipProductType } from '../enums/slip-product-type.enum';
import {
  SlipBuildRequest,
  SlipLegInput,
} from '../interfaces/slip-center.interface';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { PredictionEngineMonitorService } from './prediction-engine-monitor.service';
import { PredictionMathUtil } from '../utils/prediction-math.util';
import { isOddsQuoteFresh } from '../../odds/config/odds.config';

/* eslint-disable prettier/prettier, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

type SureOddsProduct = 'SURE_2' | 'SURE_5' | 'SURE_7';
type CandidateGroups = SlipLegInput[][];

function configOddsMinimum(): number {
  return Math.max(
    PREDICTION_ENGINE_CONFIG.selectionEligibility.minimumDecimalOdds,
    PREDICTION_ENGINE_CONFIG.slipCenter.minimumLegDecimalOdds,
  );
}
function configOddsMaximum(): number { return PREDICTION_ENGINE_CONFIG.selectionEligibility.maximumDecimalOdds; }
function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string | number);
}

function publicationWindow(now = new Date()): { from: Date; to: Date } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  const todayKey = `${part('year')}-${part('month')}-${part('day')}`;
  // Nigeria uses UTC+01:00 year-round. The slip window is today plus tomorrow,
  // not an arbitrary 48-hour period that can accidentally include three dates.
  const startOfToday = new Date(`${todayKey}T00:00:00.000+01:00`);
  const endOfTomorrow = new Date(startOfToday.getTime() + 48 * 60 * 60 * 1000 - 1);
  return { from: now, to: endOfTomorrow };
}

function isInPublicationWindow(fixtureDateValue: unknown, live: boolean, now = new Date()): boolean {
  // Slip products are pre-match only. A legacy live flag must never bypass
  // the kickoff boundary, even when an old Pick Center row is still present.
  if (live) return false;
  const fixtureDate = asDate(fixtureDateValue);
  if (!Number.isFinite(fixtureDate.getTime())) return false;
  const { to } = publicationWindow(now);
  return fixtureDate.getTime() > now.getTime() && fixtureDate.getTime() <= to.getTime();
}

/** Product of stored Pick Center probabilities; never recalculate a leg prediction. */
function combinedSelectionProbability(legs: Array<{ probability: number }>): number {
  if (!legs.length) return 0;
  let result = 1;
  for (const leg of legs) {
    const probability = Number(leg.probability);
    if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) return 0;
    result *= probability;
  }
  return Math.max(0, Math.min(1, result));
}
/** Reject obvious contradictory result/double-chance or result/DNB legs from one fixture. */
function selectionsAreCompatible(
  left: Pick<SlipLegInput, 'eventId' | 'marketKey' | 'selectionKey'>,
  right: Pick<SlipLegInput, 'eventId' | 'marketKey' | 'selectionKey'>,
): boolean {
  if (String(left.eventId) !== String(right.eventId)) return true;
  const leftMarket = String(left.marketKey).toUpperCase();
  const rightMarket = String(right.marketKey).toUpperCase();
  const leftKey = String(left.selectionKey).toUpperCase();
  const rightKey = String(right.selectionKey).toUpperCase();
  const familyFor = (market: string): 'FT' | 'HT' | 'SH' | null => {
    if (market === 'MATCH_RESULT' || market === 'DOUBLE_CHANCE' || market === 'DRAW_NO_BET') return 'FT';
    if (market === 'HALF_TIME_RESULT' || market === 'FIRST_HALF_DOUBLE_CHANCE' || market === 'FIRST_HALF_DRAW_NO_BET') return 'HT';
    if (market === 'SECOND_HALF_RESULT') return 'SH';
    return null;
  };
  const resultOutcome = (market: string, key: string): string | null => {
    if (!['MATCH_RESULT', 'HALF_TIME_RESULT', 'SECOND_HALF_RESULT'].includes(market)) return null;
    if (['HOME_WIN', 'HOME', '1'].includes(key)) return 'HOME';
    if (['DRAW', 'X'].includes(key)) return 'DRAW';
    if (['AWAY_WIN', 'AWAY', '2'].includes(key)) return 'AWAY';
    return null;
  };
  const doubleChanceOutcomes = (market: string, key: string): Set<string> | null => {
    if (!['DOUBLE_CHANCE', 'FIRST_HALF_DOUBLE_CHANCE'].includes(market)) return null;
    if (['HOME_OR_DRAW', '1X', 'HOME_DRAW'].includes(key)) return new Set(['HOME', 'DRAW']);
    if (['DRAW_OR_AWAY', 'X2', 'DRAW_AWAY'].includes(key)) return new Set(['DRAW', 'AWAY']);
    if (['HOME_OR_AWAY', '12', 'HOME_AWAY'].includes(key)) return new Set(['HOME', 'AWAY']);
    return null;
  };
  const leftOutcome = resultOutcome(leftMarket, leftKey);
  const rightOutcome = resultOutcome(rightMarket, rightKey);
  const leftDoubleChance = doubleChanceOutcomes(leftMarket, leftKey);
  const rightDoubleChance = doubleChanceOutcomes(rightMarket, rightKey);
  if (leftOutcome && rightDoubleChance && familyFor(leftMarket) === familyFor(rightMarket)) return rightDoubleChance.has(leftOutcome);
  if (rightOutcome && leftDoubleChance && familyFor(rightMarket) === familyFor(leftMarket)) return leftDoubleChance.has(rightOutcome);
  const leftDnb = ['DRAW_NO_BET', 'FIRST_HALF_DRAW_NO_BET'].includes(leftMarket);
  const rightDnb = ['DRAW_NO_BET', 'FIRST_HALF_DRAW_NO_BET'].includes(rightMarket);
  if (leftOutcome && rightDnb && familyFor(leftMarket) === familyFor(rightMarket)) {
    return !(leftOutcome === 'HOME' && rightKey === 'AWAY_DNB')
      && !(leftOutcome === 'AWAY' && rightKey === 'HOME_DNB');
  }
  if (rightOutcome && leftDnb && familyFor(rightMarket) === familyFor(leftMarket)) {
    return !(rightOutcome === 'HOME' && leftKey === 'AWAY_DNB')
      && !(rightOutcome === 'AWAY' && leftKey === 'HOME_DNB');
  }
  return true;
}


@Injectable()
export class SlipCenterService {
  private readonly logger = new Logger(SlipCenterService.name);
  private automaticRefreshInProgress = false;

  constructor(
    @InjectModel(PredictionSlip.name) private readonly slipModel: Model<PredictionSlip>,
    @InjectModel(PickCenter.name) private readonly pickCenterModel: Model<PickCenter>,
    @InjectModel(MarketPrediction.name) private readonly marketPredictionModel: Model<MarketPrediction>,
    @InjectModel(SlipCenterGenerationLock.name) private readonly generationLockModel: Model<SlipCenterGenerationLock>,
    private readonly monitor: PredictionEngineMonitorService,
  ) {}

  /**
   * Serialize refreshes both inside this process and across application instances.
   * The database lease expires automatically if a process dies during generation.
   */
  async refreshAutomaticSlips(): Promise<{ createdOrUpdated: number; skipped: number; inProgress?: boolean }> {
    if (this.automaticRefreshInProgress) {
      return { createdOrUpdated: 0, skipped: 1, inProgress: true };
    }

    this.automaticRefreshInProgress = true;
    const lockKey = 'GLOBAL';
    const lockToken = randomUUID();
    let acquired = false;

    try {
      const now = new Date();
      const lockExpiresAt = new Date(now.getTime() + 60 * 60 * 1000);
      const expiredLockFilter = {
        dateKey: lockKey,
        $or: [
          { lockExpiresAt: { $lte: now } },
          { lockExpiresAt: { $exists: false } },
          { lockExpiresAt: null },
        ],
      };

      // First, atomically claim an existing expired lease. Do not use upsert here:
      // an active GLOBAL lock would fail the expiry filter and cause a duplicate-key
      // insert attempt against the unique dateKey index.
      const reclaimed = await this.generationLockModel
        .findOneAndUpdate(
          expiredLockFilter,
          { $set: { lockToken, lockExpiresAt, ttlExpiresAt: lockExpiresAt } },
          { upsert: false, returnDocument: 'after' },
        )
        .lean()
        .exec() as any;

      if (reclaimed) {
        acquired = reclaimed.lockToken === lockToken;
      } else {
        // No expired lease matched. If a lock exists, another worker owns it.
        const existing = await this.generationLockModel
          .findOne({ dateKey: lockKey })
          .select({ _id: 1, lockExpiresAt: 1, lockToken: 1 })
          .lean()
          .exec() as any;

        if (existing && existing.lockExpiresAt && new Date(existing.lockExpiresAt).getTime() > now.getTime()) {
          return { createdOrUpdated: 0, skipped: 1, inProgress: true };
        }

        // There is no lock to reclaim. Concurrent instances may race to create it;
        // the unique index remains the final arbiter, and E11000 means another
        // instance won the race rather than a database outage.
        try {
          const created = await this.generationLockModel.create({
            dateKey: lockKey,
            lockToken,
            lockExpiresAt,
            ttlExpiresAt: lockExpiresAt,
          });
          acquired = created.lockToken === lockToken;
        } catch (error) {
          if ((error as any)?.code === 11000) {
            return { createdOrUpdated: 0, skipped: 1, inProgress: true };
          }
          throw error;
        }
      }

      if (!acquired) return { createdOrUpdated: 0, skipped: 1, inProgress: true };
      return await this.refreshAutomaticSlipsInternal();
    } finally {
      if (acquired) {
        await this.generationLockModel
          .deleteOne({ dateKey: lockKey, lockToken })
          .exec()
          .catch((error) => {
            this.logger.warn(
              `Could not release Slip Center generation lease for ${lockKey}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      }
      this.automaticRefreshInProgress = false;
    }
  }

  /**
   * Generate and publish up to one slip for each configured product per kickoff
   * date on every refresh. Today's and tomorrow's fixtures are allocated
   * independently so tomorrow's slips can never contain today's matches.
   */
  private async refreshAutomaticSlipsInternal(): Promise<{ createdOrUpdated: number; skipped: number }> {
    const config = PREDICTION_ENGINE_CONFIG.slipCenter;
    if (!config.enabled || !config.autoCreate) return { createdOrUpdated: 0, skipped: 0 };

    const now = new Date();
    const todayDateKey = this.nigeriaDateKey(now);
    const startOfToday = new Date(`${todayDateKey}T00:00:00.000+01:00`);
    const tomorrowDateKey = this.nigeriaDateKey(
      new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000),
    );
    const targetDateKeys = [todayDateKey, tomorrowDateKey];
    const window = publicationWindow(now);
    let skipped = 0;
    let createdOrUpdated = 0;

    const currentProductTypes = [
      SlipProductType.ODDS_10,
      SlipProductType.ODDS_25,
      SlipProductType.ODDS_50,
      SlipProductType.SURE_ODDS,
    ];

    // Automatic slips are published directly below. Legacy READY records are
    // not bulk-published, and all records still count toward their kickoff-date
    // quota even if they have since been cancelled or settled.
    const existingSlips = await this.slipModel.find({}).select({
      automatic: 1, legs: 1, productType: 1, status: 1, settlementStatus: 1,
      generatedDateKey: 1, targetDateKey: 1, sureOdds: 1, sureOddsTier: 1,
      sureOddsProduct: 1, matchSetFingerprint: 1, createdAt: 1,
    }).lean().exec() as any[];

    // Previously, automatic products could mix today's and tomorrow's fixtures.
    // Withdraw those still-published, unsettled automatic slips in the active
    // window so the new date-isolation rule also holds for already-visible items.
    const legacyMixedSlipIds = new Set<string>(
      existingSlips
        .filter((slip) => {
          if (
            slip.automatic !== true
            || slip.status !== SlipStatus.PUBLISHED
            || String(slip.settlementStatus ?? 'PENDING').toUpperCase() !== 'PENDING'
          ) return false;
          const legs = Array.isArray(slip.legs) ? slip.legs as SlipLegInput[] : [];
          if (legs.length < 2) return false;
          const fixtureDateKeys = legs.map((leg) => {
            const fixtureDate = asDate(leg.fixtureDate);
            return Number.isFinite(fixtureDate.getTime())
              ? this.nigeriaDateKey(fixtureDate)
              : '';
          });
          return fixtureDateKeys.every(Boolean)
            && new Set(fixtureDateKeys).size > 1
            && fixtureDateKeys.some((key) => targetDateKeys.includes(key));
        })
        .map((slip) => String(slip._id)),
    );
    // Existing PUBLISHED slips are immutable snapshots, including legacy
    // records created before the one-kickoff-date allocation rule. Preserve
    // those records and exclude mixed-date slips from date-specific quota and
    // event-coverage accounting instead of cancelling or rewriting them.
    const legacyMixedSlipsPreserved = legacyMixedSlipIds.size;

    const allQueriedPicks = await this.pickCenterModel.find({
      'selectedMarkets.0': { $exists: true },
      completed: { $ne: true },
      live: { $ne: true },
      fixtureDate: { $gt: window.from, $lte: window.to },
    }).sort({ fixtureDate: 1 }).lean().exec() as any[];

    // Keep the automatic allocation restricted to today's and tomorrow's
    // pre-match fixtures. The kickoff-time query above excludes started games.
    const picks = allQueriedPicks.filter((pick) => {
      const fixtureDate = asDate(pick.fixtureDate);
      return Number.isFinite(fixtureDate.getTime())
        && targetDateKeys.includes(this.nigeriaDateKey(fixtureDate));
    });

    const maximumCandidateMarketsPerFixture = config.maximumSelectionsPerMatch;
    const dayRuns = targetDateKeys.map((targetDateKey) => {
      const dayPicks = picks.filter(
        (pick) => this.nigeriaDateKey(asDate(pick.fixtureDate)) === targetDateKey,
      );
      const allEligibleGroups = dayPicks
        .map((pick) => this.pickLegCandidatesFromCenter(
          pick,
          config.minimumLegProbability,
          config.minimumLegConfidence,
          config.maximumSelectionsPerMatch,
        ))
        .filter((group): group is SlipLegInput[] => group.length > 0);
      const groups = allEligibleGroups.map((group) =>
        group.slice(0, maximumCandidateMarketsPerFixture),
      );
      return { targetDateKey, picks: dayPicks, allEligibleGroups, groups };
    });

    // Shared uniqueness sets prevent two refresh-day allocations from creating
    // duplicate match combinations, while each daily quota remains independent.
    const eventDateKey = new Map<string, string>();
    for (const dayRun of dayRuns) {
      for (const group of dayRun.allEligibleGroups) {
        const first = group[0];
        if (first?.eventId && Number.isFinite(asDate(first.fixtureDate).getTime())) {
          eventDateKey.set(String(first.eventId), dayRun.targetDateKey);
        }
      }
    }
    const eligibleEventIds = new Set(eventDateKey.keys());
    const eligibleDateKeys = new Set(eventDateKey.values());
    const eligibleEventIdsWithoutCandidateGroup = picks
      .map((pick) => String(pick.eventId ?? '').trim())
      .filter((eventId) => eventId && !eligibleEventIds.has(eventId));
    const coveredEventIds = new Set<string>();
    const coveredDateKeys = new Set<string>();
    const usedMatchSetFingerprints = new Set<string>();
    const usedEventIds = new Set<string>();

    for (const slip of existingSlips) {
      const legs = Array.isArray(slip.legs) ? slip.legs as SlipLegInput[] : [];
      if (legs.length) {
        usedMatchSetFingerprints.add(this.matchSetFingerprint(legs));
        for (const leg of legs) {
          const eventId = String(leg.eventId ?? '').trim();
          if (eventId) usedEventIds.add(eventId);
        }
      }
      if (
        !legacyMixedSlipIds.has(String(slip._id))
        && slip.status === SlipStatus.PUBLISHED
        && String(slip.settlementStatus ?? 'PENDING').toUpperCase() === 'PENDING'
      ) {
        for (const leg of legs) {
          const eventId = String(leg.eventId ?? '');
          if (eligibleEventIds.has(eventId)) {
            coveredEventIds.add(eventId);
            const dayKey = eventDateKey.get(eventId);
            if (dayKey) coveredDateKeys.add(dayKey);
          }
        }
      }
    }

    // Count an automatic slip against a date only when every leg belongs to
    // that Nigeria kickoff date. This also migrates quota interpretation safely
    // for older records whose generatedDateKey described creation day instead.
    const slipBelongsToTargetDate = (slip: any, targetDateKey: string): boolean => {
      const legs = Array.isArray(slip.legs) ? slip.legs as SlipLegInput[] : [];
      if (!legs.length) return false;
      const storedTargetDateKey = typeof slip.targetDateKey === 'string'
        ? slip.targetDateKey.trim()
        : '';
      if (storedTargetDateKey && storedTargetDateKey !== targetDateKey) return false;
      return legs.every((leg) => {
        const fixtureDate = asDate(leg.fixtureDate);
        return Number.isFinite(fixtureDate.getTime())
          && this.nigeriaDateKey(fixtureDate) === targetDateKey;
      });
    };

    const categories: Array<{
      type: SlipProductType;
      count: number;
      minOdds: number;
      maxOdds: number | null;
      requiredPlan: 'regular' | 'vip' | 'premium';
      candidateLimit: number;
    }> = [
      {
        type: SlipProductType.ODDS_10,
        count: config.categoryTargets.ODDS_10,
        minOdds: config.oddsBands.ODDS_10.minOdds,
        maxOdds: config.oddsBands.ODDS_10.maxOdds,
        requiredPlan: 'regular',
        candidateLimit: maximumCandidateMarketsPerFixture,
      },
      {
        type: SlipProductType.ODDS_25,
        count: config.categoryTargets.ODDS_25,
        minOdds: config.oddsBands.ODDS_25.minOdds,
        maxOdds: config.oddsBands.ODDS_25.maxOdds,
        requiredPlan: 'vip',
        candidateLimit: maximumCandidateMarketsPerFixture,
      },
      {
        type: SlipProductType.ODDS_50,
        count: config.categoryTargets.ODDS_50,
        minOdds: config.oddsBands.ODDS_50.minOdds,
        maxOdds: config.oddsBands.ODDS_50.maxOdds,
        requiredPlan: 'premium',
        candidateLimit: maximumCandidateMarketsPerFixture,
      },
    ];
    const sureProducts: Array<{ product: SureOddsProduct; count: number }> = [
      { product: 'SURE_2', count: config.sureOdds.products.SURE_2.dailyTarget },
      { product: 'SURE_5', count: config.sureOdds.products.SURE_5.dailyTarget },
      { product: 'SURE_7', count: config.sureOdds.products.SURE_7.dailyTarget },
    ];

    const targetDateProgress: Array<{
      dateKey: string;
      eligibleFixtures: number;
      createdThisRun: number;
      allocated: number;
      target: number;
      remaining: number;
    }> = [];

    for (const dayRun of dayRuns) {
      const { targetDateKey, picks: dayPicks, groups: dayGroups } = dayRun;
      const dayEligibleEventIds = new Set(
        [...eventDateKey.entries()]
          .filter(([, dateKey]) => dateKey === targetDateKey)
          .map(([eventId]) => eventId),
      );
      const existingForDate = existingSlips.filter((slip) =>
        slip.automatic === true
        && currentProductTypes.includes(slip.productType as SlipProductType)
        && slipBelongsToTargetDate(slip, targetDateKey),
      );
      let dailyExistingCount = existingForDate.length;
      let createdForDate = 0;
      const categoryExistingCount = (type: SlipProductType) =>
        existingForDate.filter(
          (slip) => slip.productType === type && slip.sureOdds !== true,
        ).length;
      const sureExistingCount = (product: SureOddsProduct) =>
        existingForDate.filter((slip) =>
          slip.productType === SlipProductType.SURE_ODDS
          && (slip.sureOddsProduct === product
            || (slip.sureOddsProduct === undefined && product === 'SURE_2'
              && slip.sureOdds === true && slip.sureOddsTier === 'VIP')),
        ).length;
      const preferredUnusedEventIds = new Set(
        [...dayEligibleEventIds].filter((eventId) => !usedEventIds.has(eventId)),
      );

      // Normal odds products: at most one candidate of each type for this date
      // during this refresh; subsequent refreshes fill any remaining quota.
      for (const category of categories) {
        if (dailyExistingCount >= config.maxAutoSlipsPerDate) break;
        const remainingForCategory = Math.max(
          0,
          category.count - categoryExistingCount(category.type),
        );
        if (remainingForCategory === 0) continue;

        const candidateGroups = dayGroups.map((group) =>
          group.slice(0, category.candidateLimit),
        );
        const searchAttempts = 8;
        const attemptedMatchSets = new Set<string>(usedMatchSetFingerprints);
        let bestLegs: SlipLegInput[] | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;

        for (let variant = 0; variant < searchAttempts; variant++) {
          const legs = await this.findCombinationInBand(
            candidateGroups,
            category.minOdds,
            category.maxOdds,
            variant,
            config.minimumLegs,
            config.maximumLegs,
            category.candidateLimit,
            config.maximumSelectionsPerMatch,
            new Set<string>(),
            new Set<string>(),
            attemptedMatchSets,
            preferredUnusedEventIds,
          );
          if (!legs) {
            skipped += 1;
            continue;
          }
          const matchSetFingerprint = this.matchSetFingerprint(legs);
          attemptedMatchSets.add(matchSetFingerprint);
          const score = this.combinationCandidateScore(
            legs,
            category.minOdds,
            category.maxOdds,
            preferredUnusedEventIds,
          );
          if (score > bestScore) {
            bestScore = score;
            bestLegs = legs;
          }
        }

        if (!bestLegs) continue;
        const signature = this.combinationSignature(bestLegs);
        const matchSetFingerprint = this.matchSetFingerprint(bestLegs);
        if (usedMatchSetFingerprints.has(matchSetFingerprint)) {
          skipped += 1;
          continue;
        }
        const fingerprint = this.combinationFingerprint(category.type, signature);
        const saved = await this.upsertAutomaticCandidate({
          legs: bestLegs,
          name: `2xPredict ${this.productLabel(category.type)} — ${targetDateKey} #${categoryExistingCount(category.type) + 1}`,
          automatic: true,
          fingerprint,
          createdBy: 'prediction-engine',
          generatedDateKey: todayDateKey,
          targetDateKey,
          productType: category.type,
          requiredPlan: category.requiredPlan,
          targetOddsMinimum: category.minOdds,
          targetOddsMaximum: category.maxOdds ?? undefined,
          publish: true,
        });
        if (saved) {
          usedMatchSetFingerprints.add(matchSetFingerprint);
          for (const leg of bestLegs) {
            const eventId = String(leg.eventId);
            usedEventIds.add(eventId);
            preferredUnusedEventIds.delete(eventId);
          }
          createdOrUpdated += 1;
          createdForDate += 1;
          dailyExistingCount += 1;
          for (const leg of bestLegs) {
            const eventId = String(leg.eventId);
            const legDateKey = eventDateKey.get(eventId);
            if (legDateKey) {
              coveredEventIds.add(eventId);
              coveredDateKeys.add(legDateKey);
            }
          }
        }
      }

      // Sure Odds products use the same per-date creation limit: at most one
      // SURE_2, one SURE_5 and one SURE_7 slip for this date per refresh.
      const sureGroups = dayPicks
        .map((pick) => this.pickLegCandidatesFromCenter(
          pick,
          config.sureOdds.minimumProbability,
          config.sureOdds.minimumConfidence,
          config.sureOdds.maximumSelectionsPerMatch,
        ))
        .filter((group): group is SlipLegInput[] => group.length > 0)
        .map((group) => group.slice(0, config.sureOdds.maximumSelectionsPerMatch));

      for (const productConfig of sureProducts) {
        if (dailyExistingCount >= config.maxAutoSlipsPerDate) break;
        const product = config.sureOdds.products[productConfig.product];
        const remainingForProduct = Math.max(
          0,
          productConfig.count - sureExistingCount(productConfig.product),
        );
        if (remainingForProduct === 0) continue;

        const searchAttempts = 8;
        const attemptedMatchSets = new Set<string>(usedMatchSetFingerprints);
        let bestLegs: SlipLegInput[] | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (let variant = 0; variant < searchAttempts; variant++) {
          const legs = await this.findSureOddsCombination(
            sureGroups,
            product.minOdds,
            product.maxOdds,
            variant,
            config.sureOdds.minimumLegs,
            config.sureOdds.maximumLegs,
            config.sureOdds.maximumSelectionsPerMatch,
            new Set<string>(),
            new Set<string>(),
            attemptedMatchSets,
            preferredUnusedEventIds,
          );
          if (!legs) {
            skipped += 1;
            continue;
          }
          const matchSetFingerprint = this.matchSetFingerprint(legs);
          attemptedMatchSets.add(matchSetFingerprint);
          const score = this.combinationCandidateScore(
            legs,
            product.minOdds,
            product.maxOdds,
            preferredUnusedEventIds,
          );
          if (score > bestScore) {
            bestScore = score;
            bestLegs = legs;
          }
        }

        if (!bestLegs) continue;
        const signature = this.combinationSignature(bestLegs);
        const matchSetFingerprint = this.matchSetFingerprint(bestLegs);
        if (usedMatchSetFingerprints.has(matchSetFingerprint)) {
          skipped += 1;
          continue;
        }
        const fingerprint = this.combinationFingerprint(productConfig.product, signature);
        const tier = product.requiredPlan === 'vip' ? 'VIP' : 'PREMIUM';
        const saved = await this.upsertAutomaticCandidate({
          legs: bestLegs,
          name: `2xPredict ${productConfig.product.replace('_', ' ')} — ${targetDateKey} #${sureExistingCount(productConfig.product) + 1}`,
          automatic: true,
          fingerprint,
          createdBy: 'prediction-engine',
          generatedDateKey: todayDateKey,
          targetDateKey,
          productType: SlipProductType.SURE_ODDS,
          requiredPlan: product.requiredPlan,
          sureOddsTier: tier,
          sureOddsProduct: productConfig.product,
          sureOdds: true,
          targetOddsMinimum: product.minOdds,
          targetOddsMaximum: product.maxOdds,
          publish: true,
        });
        if (saved) {
          usedMatchSetFingerprints.add(matchSetFingerprint);
          for (const leg of bestLegs) {
            const eventId = String(leg.eventId);
            usedEventIds.add(eventId);
            preferredUnusedEventIds.delete(eventId);
          }
          createdOrUpdated += 1;
          createdForDate += 1;
          dailyExistingCount += 1;
          for (const leg of bestLegs) {
            const eventId = String(leg.eventId);
            const legDateKey = eventDateKey.get(eventId);
            if (legDateKey) {
              coveredEventIds.add(eventId);
              coveredDateKeys.add(legDateKey);
            }
          }
        }
      }

      targetDateProgress.push({
        dateKey: targetDateKey,
        eligibleFixtures: dayPicks.length,
        createdThisRun: createdForDate,
        allocated: dailyExistingCount,
        target: config.dailySlipTarget,
        remaining: Math.max(0, config.dailySlipTarget - dailyExistingCount),
      });
    }

    const missingCoverageDates = [...eligibleDateKeys]
      .filter((key) => !coveredDateKeys.has(key))
      .sort();
    const missingCoverageEvents = [...eligibleEventIds]
      .filter((eventId) => !coveredEventIds.has(eventId))
      .sort((left, right) =>
        (eventDateKey.get(left) ?? '').localeCompare(eventDateKey.get(right) ?? '')
        || left.localeCompare(right),
      );

    const eligibleFixtureGroups = dayRuns.reduce(
      (total, dayRun) => total + dayRun.groups.length,
      0,
    );
    const eligibleFixtures = dayRuns.reduce(
      (total, dayRun) => total + dayRun.picks.length,
      0,
    );
    const todayProgress = targetDateProgress.find(
      (item) => item.dateKey === todayDateKey,
    );
    const tomorrowProgress = targetDateProgress.find(
      (item) => item.dateKey === tomorrowDateKey,
    );
    const dailyProgressText = targetDateProgress
      .map((item) => `${item.dateKey}=${item.allocated}/${item.target} (${item.remaining} remaining; ${item.createdThisRun} created this run)`)
      .join('; ');

    const refreshSummary = {
      durationMs: Math.max(0, Date.now() - now.getTime()),
      minimumProbability: config.minimumLegProbability,
      minimumConfidence: config.minimumLegConfidence,
      minimumDataQuality: config.minimumLegDataQuality,
      minimumSafetyScore: config.minimumSafetyScore,
      dataQualityAndSafetyAreHardGates: false,
      createdOrUpdated,
      skipped,
      legacyMixedSlipsPreserved,
      fixtureCandidates: eligibleFixtureGroups,
      eligibleFixtures,
      eligibleFixtureDays: eligibleDateKeys.size,
      eligibleEvents: eligibleEventIds.size,
      pickCenterEventsWithoutEligibleSelections: eligibleEventIdsWithoutCandidateGroup.length,
      pickCenterEventIdsWithoutEligibleSelections: eligibleEventIdsWithoutCandidateGroup.slice(0, 200),
      coveredEvents: coveredEventIds.size,
      coverageEventsRequired: eligibleEventIds.size,
      coverageEventsSatisfied: eligibleEventIds.size - missingCoverageEvents.length,
      coverageEventIdsMissing: missingCoverageEvents.slice(0, 200),
      coverageDatesRequired: eligibleDateKeys.size,
      coverageDatesSatisfied: coveredDateKeys.size,
      coverageDatesMissing: missingCoverageDates,
      coverageSlipsCreated: 0,
      sameDayFixtureCombinationProhibited: false,
      sameDayFixturesAllowed: true,
      crossDateCombinationsAllowed: false,
      maximumSelectionsPerMatch: config.maximumSelectionsPerMatch,
      generatedDateKey: todayDateKey,
      targetDateTodayKey: todayDateKey,
      targetDateTomorrowKey: tomorrowDateKey,
      publishedProductsToday: todayProgress?.allocated ?? 0,
      publishedProductsTomorrow: tomorrowProgress?.allocated ?? 0,
      todayTarget: config.dailySlipTarget,
      tomorrowTarget: config.dailySlipTarget,
      todayRemaining: todayProgress?.remaining ?? config.dailySlipTarget,
      tomorrowRemaining: tomorrowProgress?.remaining ?? config.dailySlipTarget,
      targetDateProgress,
      fixtureHorizonHours: 48,
      dailyTarget: config.dailySlipTarget,
      maximumAutomaticSlips: config.maxAutoSlipsPerDate,
    };
    this.logger.log(
      `Slip refresh completed in ${refreshSummary.durationMs}ms: ${createdOrUpdated} products created/updated; ${legacyMixedSlipsPreserved} legacy mixed-date published slips preserved; ${eligibleFixtureGroups} eligible fixture groups from ${eligibleFixtures} Pick Center fixtures. Per-kickoff-date quota: ${dailyProgressText}; one slip per product type per kickoff date per refresh; tomorrow's slips contain tomorrow-only fixtures; ${eligibleEventIdsWithoutCandidateGroup.length} fixtures had no eligible slip selections; event coverage ${coveredEventIds.size}/${eligibleEventIds.size}; ${skipped} combinations skipped${missingCoverageEvents.length ? `; ${missingCoverageEvents.length} eligible fixtures remain uncovered (first: ${missingCoverageEvents.slice(0, 12).join(', ')})` : ''}.`,
    );
    await this.monitor.recordSlipRefresh(refreshSummary);
    return refreshSummary;
  }

  async buildSlip(request: SlipBuildRequest = {}): Promise<any> {
    const config = PREDICTION_ENGINE_CONFIG.slipCenter;
    const productType = request.productType ?? SlipProductType.ODDS_10;
    const sureOdds = productType === SlipProductType.SURE_ODDS;
    const currentNormalProducts: SlipProductType[] = [SlipProductType.ODDS_10, SlipProductType.ODDS_25, SlipProductType.ODDS_50];
    if (!sureOdds && !currentNormalProducts.includes(productType)) {
      throw new BadRequestException('Legacy slip product types are retained for historical records only. Generate ODDS_10, ODDS_25, ODDS_50, or a configured Sure Odds product.');
    }
    const sureOddsProduct: SureOddsProduct | undefined = sureOdds
      ? request.sureOddsProduct ?? (request.sureOddsTier === 'PREMIUM' ? 'SURE_5' : 'SURE_2')
      : undefined;
    const sureProductConfig = sureOdds && sureOddsProduct ? config.sureOdds.products[sureOddsProduct] : undefined;
    if (sureOdds && !sureProductConfig) throw new BadRequestException('A valid Sure Odds product (SURE_2, SURE_5, or SURE_7) is required.');

    const sureOddsTier = sureOddsProduct === 'SURE_2' ? 'VIP' : sureOdds ? 'PREMIUM' : undefined;
    const requiredPlan: 'regular' | 'vip' | 'premium' = sureProductConfig?.requiredPlan
      ?? (productType === SlipProductType.ODDS_10 || productType === SlipProductType.EXTENDED_ODDS || productType === SlipProductType.UNLIMITED_ODDS ? 'regular' : productType === SlipProductType.ODDS_50 ? 'premium' : 'vip');
    const minimumProbability = Math.max(config.minimumLegProbability, request.minimumProbability ?? config.minimumLegProbability);
    const minimumConfidence = Math.max(config.minimumLegConfidence, request.minimumConfidence ?? config.minimumLegConfidence);

    const query: Record<string, any> = {
      'selectedMarkets.0': { $exists: true },
      completed: { $ne: true },
    };
    if (request.eventIds?.length) query.eventId = { $in: [...new Set(request.eventIds.map(String))] };
    else {
      const window = publicationWindow(new Date());
      const requestedFrom = request.fixtureFrom && request.fixtureFrom.getTime() > window.from.getTime() ? request.fixtureFrom : window.from;
      const requestedTo = request.fixtureTo && request.fixtureTo.getTime() < window.to.getTime() ? request.fixtureTo : window.to;
      if (requestedFrom.getTime() > requestedTo.getTime()) {
        throw new BadRequestException('The requested fixture range does not overlap current and next Nigeria calendar-date publication window.');
      }
      query.live = { $ne: true };
      query.fixtureDate = { $gt: requestedFrom, $lte: requestedTo };
    }
    const picks = await this.pickCenterModel.find(query).sort({ fixtureDate: 1 }).lean().exec() as any[];
    const candidateLimit = config.maximumSelectionsPerMatch;
    const groups = picks
      .map((pick) => this.pickLegCandidatesFromCenter(pick, minimumProbability, minimumConfidence, candidateLimit))
      .filter((group): group is SlipLegInput[] => group.length > 0);
    if (!groups.length) throw new BadRequestException('No eligible ranked market selections with valid stored prices are available.');

    let legs: SlipLegInput[] | null;
    let targetOddsMinimum: number;
    let targetOddsMaximum: number | undefined;
    if (sureOdds && sureProductConfig) {
      legs = await this.findSureOddsCombination(groups, sureProductConfig.minOdds, sureProductConfig.maxOdds, 0, config.sureOdds.minimumLegs, config.sureOdds.maximumLegs, config.sureOdds.maximumSelectionsPerMatch);
      targetOddsMinimum = sureProductConfig.minOdds;
      targetOddsMaximum = sureProductConfig.maxOdds;
    } else {
      const band = (config.oddsBands as any)[productType];
      if (!band) throw new BadRequestException(`Unsupported slip product type "${productType}".`);
      const requestedCount = Math.max(config.minimumLegs, Math.min(config.maximumLegs, Math.floor(request.selectionCount ?? config.defaultLegs)));
      const minCount = request.selectionCount === undefined ? config.minimumLegs : requestedCount;
      const maxCount = requestedCount;
      legs = await this.findCombinationInBand(groups, band.minOdds, band.maxOdds, 0, minCount, maxCount, candidateLimit, config.maximumSelectionsPerMatch);
      targetOddsMinimum = band.minOdds;
      targetOddsMaximum = band.maxOdds ?? undefined;
    }
    if (!legs?.length) throw new BadRequestException('No combination satisfies the requested product odds range and selection requirements.');

    return this.upsertSlip({
      legs,
      name: request.name?.trim() || `2xPredict ${sureOddsProduct ?? this.productLabel(productType)} — ${this.nigeriaDateKey(new Date())}`,
      automatic: false,
      createdBy: request.createdBy,
      publish: request.publish === true,
      productType,
      requiredPlan,
      sureOddsTier,
      sureOddsProduct,
      sureOdds,
      targetOddsMinimum,
      targetOddsMaximum,
      generatedDateKey: this.nigeriaDateKey(new Date()),
    });
  }

  async updateSportyBet(
    slipId: string,
    update: { sportyBetSlipCode?: string | null; sportyBetSlipLink?: string | null },
    adminId?: string,
  ): Promise<any> {
    const set: Record<string, any> = {};
    const unset: Record<string, 1> = {};
    if (update.sportyBetSlipCode !== undefined) {
      const value = update.sportyBetSlipCode?.trim();
      if (value) set.sportyBetSlipCode = value;
      else unset.sportyBetSlipCode = 1;
    }
    if (update.sportyBetSlipLink !== undefined) {
      const value = update.sportyBetSlipLink?.trim();
      if (value) set.sportyBetSlipLink = value;
      else unset.sportyBetSlipLink = 1;
    }
    if (adminId) set.createdBy = adminId;
    const updateDocument: Record<string, any> = {};
    if (Object.keys(set).length) updateDocument.$set = set;
    if (Object.keys(unset).length) updateDocument.$unset = unset;
    const slip = await this.slipModel.findByIdAndUpdate(slipId, updateDocument, { returnDocument: 'after', runValidators: true }).lean().exec();
    if (!slip) throw new NotFoundException('Slip was not found.');
    await this.monitor.recordEvent({ type: 'ADMIN_ACTION', level: 'INFO', message: `SportyBet metadata updated for slip ${slip.slipCode}.`, metadata: { slipId, hasCode: Boolean(slip.sportyBetSlipCode), hasLink: Boolean(slip.sportyBetSlipLink), adminId } });
    return slip;
  }

  /** Rebuilds a slip from explicitly selected stored Pick Center markets. Admin-only route. */
  async updateSlipLegs(
    slipId: string,
    selections: Array<{ eventId?: string; marketPredictionId?: string; marketKey?: string; selectionKey?: string }>,
  ): Promise<any> {
    const current = await this.slipModel.findById(slipId).lean().exec() as any;
    if (!current) throw new NotFoundException('Slip was not found.');
    const currentStatus = String(current.status ?? '').toUpperCase();
    const currentSettlementStatus = String(current.settlementStatus ?? 'PENDING').toUpperCase();
    if (
      ![SlipStatus.DRAFT, SlipStatus.READY].includes(currentStatus as SlipStatus)
      || currentSettlementStatus !== 'PENDING'
      || current.snapshotFrozenAt
    ) {
      throw new BadRequestException('Published, cancelled, or settled slips are immutable. Only an unsettled draft or READY slip can be edited.');
    }
    if (!Array.isArray(selections) || selections.length < PREDICTION_ENGINE_CONFIG.slipCenter.minimumLegs) throw new BadRequestException(`A slip must contain at least ${PREDICTION_ENGINE_CONFIG.slipCenter.minimumLegs} legs.`);

    const uniqueSelections = new Set<string>();
    const legs: SlipLegInput[] = [];
    for (const requested of selections) {
      const eventId = String(requested?.eventId ?? '').trim();
      const marketPredictionId = String(requested?.marketPredictionId ?? '').trim();
      const marketKey = String(requested?.marketKey ?? '').trim();
      const selectionKey = String(requested?.selectionKey ?? '').trim();
      if (!eventId || !marketPredictionId || !marketKey || !selectionKey) {
        throw new BadRequestException('Each slip match must identify its event, market prediction, market, and selection.');
      }
      const selectionIdentity = `${eventId}::${marketPredictionId}::${marketKey}::${selectionKey}`;
      if (uniqueSelections.has(selectionIdentity)) throw new BadRequestException('The same market selection cannot be added to a slip twice.');
      uniqueSelections.add(selectionIdentity);
      const window = publicationWindow(new Date());
      const pick = await this.pickCenterModel.findOne({
        eventId,
        'selectedMarkets.0': { $exists: true },
        completed: { $ne: true },
        live: { $ne: true },
        fixtureDate: { $gt: window.from, $lte: window.to },
      }).lean().exec() as any;
      if (!pick || !isInPublicationWindow(pick.fixtureDate, pick.live === true)) {
        throw new BadRequestException(`No current unfinished Pick Center prediction exists for match ${eventId} inside current and next Nigeria calendar-date publication window.`);
      }
      const selected = (pick.selectedMarkets ?? []).find((item: any) =>
        String(item.marketPredictionId) === marketPredictionId &&
        String(item.marketKey) === marketKey &&
        String(item.selectionKey) === selectionKey,
      );
      if (!selected) throw new BadRequestException(`The selected market is no longer available for match ${eventId}.`);
      const config = PREDICTION_ENGINE_CONFIG.slipCenter;
      const decimalOdds = Number(selected.decimalOdds);
      const priceType = selected.priceType === 'PROVIDER' || selected.priceType === 'ESTIMATED'
        ? selected.priceType
        : null;
      const probability = Number(selected.probability);
      const confidenceValue = Number(selected.confidence);
      const fairOddsInput = Number(selected.fairOdds);
      const fairOdds = Number.isFinite(fairOddsInput) && fairOddsInput > 1
        ? fairOddsInput
        : probability > 0 ? 1 / probability : Number.NaN;
      const rawDataQuality = Number(selected.dataQuality ?? 0);
      const dataQuality = Number.isFinite(rawDataQuality) ? Math.max(0, Math.min(1, rawDataQuality)) : 0;
      const oddsUpdatedAt = selected.oddsUpdatedAt instanceof Date
        ? selected.oddsUpdatedAt
        : new Date(selected.oddsUpdatedAt ?? '');
      const oddsBasisRaw = String(selected.oddsBasis ?? '');
      const oddsBasis = ['BOOKMAKER_ONLY', 'BOOKMAKER_PLUS_HISTORY', 'HISTORICAL_ONLY', 'PRIOR_ONLY'].includes(oddsBasisRaw)
        ? oddsBasisRaw as SlipLegInput['oddsBasis']
        : undefined;
      const oddsCalculationMethod = typeof selected.oddsCalculationMethod === 'string' && selected.oddsCalculationMethod.trim()
        ? selected.oddsCalculationMethod.trim()
        : undefined;
      if (!oddsBasis || !oddsCalculationMethod) continue;
      const settlementProfile = selected.settlementProfile && typeof selected.settlementProfile === 'object'
        ? selected.settlementProfile
        : undefined;
      const expectedValue = priceType === 'PROVIDER' && oddsBasis === 'BOOKMAKER_ONLY'
        ? PredictionMathUtil.expectedValue(probability, decimalOdds, settlementProfile)
        : null;
      if (!priceType || selected.isFinalSelection !== true || selected.oddsPredictionReady !== true
        || !oddsBasis || !oddsCalculationMethod || !isOddsQuoteFresh(oddsUpdatedAt)
        || !Number.isFinite(decimalOdds) || decimalOdds < configOddsMinimum() || decimalOdds > configOddsMaximum()
        || !Number.isFinite(probability) || probability < config.minimumLegProbability || probability >= 1
        || !Number.isFinite(confidenceValue) || confidenceValue < config.minimumLegConfidence || confidenceValue > PREDICTION_ENGINE_CONFIG.model.maximumConfidence
        || !Number.isFinite(fairOdds) || fairOdds <= 1) {
        throw new BadRequestException('The selected market must be the current final Odds-ready selection, have fresh stored odds, and meet the configured probability and confidence thresholds.');
      }
      legs.push({
        eventId,
        homeTeamName: String(pick.homeTeamName),
        awayTeamName: String(pick.awayTeamName),
        fixtureDate: new Date(pick.fixtureDate),
        retentionExpiresAt: Number.isFinite(asDate(pick.retentionExpiresAt).getTime())
          ? asDate(pick.retentionExpiresAt)
          : null,
        marketPredictionId,
        marketKey,
        marketName: String(selected.marketName ?? marketKey),
        selectionKey,
        selectionName: String(selected.selectionName ?? selectionKey),
        probability,
        confidence: Math.max(0, Math.min(98, confidenceValue)),
        fairOdds,
        decimalOdds,
        priceType,
        oddsPredictionReady: true,
        ...(Number.isFinite(oddsUpdatedAt.getTime()) ? { oddsUpdatedAt } : {}),
        ...(oddsBasis ? { oddsBasis } : {}),
        ...(oddsCalculationMethod ? { oddsCalculationMethod } : {}),
        ...(selected.oddsProvider === 'ESPN' || selected.oddsProvider === 'THE_ODDS_API' ? { oddsProvider: selected.oddsProvider } : {}),
        ...(selected.bookmaker ? { bookmaker: String(selected.bookmaker) } : {}),
        ...(expectedValue !== null ? { expectedValue, expectedValuePercent: expectedValue * 100 } : {}),
        dataQuality,
        modelVersion: String(pick.modelVersion ?? PREDICTION_ENGINE_CONFIG.modelVersion),
        ...(settlementProfile ? { settlementProfile } : {}),
        ...(priceType === 'PROVIDER' ? { bookmakerOdds: decimalOdds } : {}),
      });
    }

    const isSureSlip = current.sureOdds === true || current.productType === SlipProductType.SURE_ODDS;
    const perMatchLimit = isSureSlip
      ? PREDICTION_ENGINE_CONFIG.slipCenter.sureOdds.maximumSelectionsPerMatch
      : PREDICTION_ENGINE_CONFIG.slipCenter.maximumSelectionsPerMatch;
    const maximumLegs = isSureSlip
      ? PREDICTION_ENGINE_CONFIG.slipCenter.sureOdds.maximumLegs
      : PREDICTION_ENGINE_CONFIG.slipCenter.maximumLegs;
    if (legs.length < PREDICTION_ENGINE_CONFIG.slipCenter.minimumLegs || legs.length > maximumLegs) {
      throw new BadRequestException(`The updated slip must contain between ${PREDICTION_ENGINE_CONFIG.slipCenter.minimumLegs} and ${maximumLegs} valid legs.`);
    }
    const selectionsPerMatch = new Map<string, number>();
    const marketsPerMatch = new Set<string>();
    for (const leg of legs) {
      const count = (selectionsPerMatch.get(leg.eventId) ?? 0) + 1;
      if (count > perMatchLimit) throw new BadRequestException(`A ${isSureSlip ? 'Sure Odds' : 'normal'} slip cannot contain more than ${perMatchLimit} selections from the same match.`);
      selectionsPerMatch.set(leg.eventId, count);
      const marketIdentity = `${leg.eventId}::${leg.marketKey.toUpperCase()}`;
      if (marketsPerMatch.has(marketIdentity)) throw new BadRequestException('A slip may contain only one selection per market for each match.');
      marketsPerMatch.add(marketIdentity);
    }
    this.assertConsistentFixtureKickoffDates(legs);

    const combinedOdds = this.calculateCombinedOdds(legs);
    if (combinedOdds === null) throw new BadRequestException('Cannot save a slip without a valid stored price for every match.');
    if (isSureSlip) {
      const product = String(current.sureOddsProduct ?? 'SURE_2') as SureOddsProduct;
      const range = PREDICTION_ENGINE_CONFIG.slipCenter.sureOdds.products[product];
      if (!range || combinedOdds < range.minOdds || combinedOdds > range.maxOdds) {
        throw new BadRequestException('The updated legs do not satisfy the Sure Odds product range.');
      }
    } else {
      const band = (PREDICTION_ENGINE_CONFIG.slipCenter.oddsBands as any)[current.productType ?? SlipProductType.STANDARD];
      if (!band || combinedOdds < band.minOdds || (band.maxOdds !== null && combinedOdds > band.maxOdds)) {
        throw new BadRequestException('The updated legs do not satisfy the slip category odds range.');
      }
    }
    const combinedFairOdds = legs.reduce((value, leg) => value * Number(leg.fairOdds), 1);
    const combinedProbability = combinedSelectionProbability(legs);
    const averageConfidence = Math.max(0, Math.min(98, Math.round(legs.reduce((value, leg) => value + Number(leg.confidence), 0) / legs.length)));
    const sortedDates = legs.map((leg) => asDate(leg.fixtureDate).getTime()).sort((a, b) => a - b);
    const marketPredictionIds = [...new Set(legs.map((leg) => leg.marketPredictionId).filter(Boolean))];
    const marketPredictions = await this.marketPredictionModel.find({ _id: { $in: marketPredictionIds } }).select('_id selections').lean().exec() as any[];
    const outcomes = new Map<string, string>();
    for (const market of marketPredictions) {
      for (const selection of market.selections ?? []) {
        const outcome = String(selection.actualOutcome ?? '').toUpperCase();
        if (['WON', 'LOST', 'VOID', 'PUSH', 'HALF_WON', 'HALF_LOST'].includes(outcome)) outcomes.set(`${String(market._id)}::${String(selection.key)}`, outcome);
      }
    }
    const settledLegs = legs.map((leg) => ({ ...leg, settlementOutcome: outcomes.get(`${leg.marketPredictionId}::${leg.selectionKey}`) ?? 'PENDING', matchSettlementStatus: 'PENDING' }));
    const byEvent = new Map<string, typeof settledLegs>();
    for (const leg of settledLegs) {
      const group = byEvent.get(leg.eventId) ?? [];
      group.push(leg);
      byEvent.set(leg.eventId, group);
    }
    for (const group of byEvent.values()) {
      const matchStatus = this.aggregateSettlement(group.map((leg) => leg.settlementOutcome));
      group.forEach((leg) => { leg.matchSettlementStatus = matchStatus; });
    }
    const settlementStatus = this.aggregateSettlement(settledLegs.map((leg) => leg.settlementOutcome));
    const legRetentionDates = settledLegs.map((leg) => asDate(leg.retentionExpiresAt));
    const allLegsHaveRetention = legRetentionDates.length > 0
      && legRetentionDates.every((date) => Number.isFinite(date.getTime()));
    const slipRetentionExpiresAt = allLegsHaveRetention
      ? new Date(Math.max(...legRetentionDates.map((date) => date.getTime())))
      : null;
    const updated = await this.slipModel.findOneAndUpdate({
      _id: slipId,
      status: { $in: [SlipStatus.DRAFT, SlipStatus.READY] },
      settlementStatus: { $in: ['PENDING', null] },
      snapshotFrozenAt: { $in: [null] },
    }, {
      $set: {
        legs: settledLegs,
        settlementStatus,
        settledAt: settlementStatus === 'PENDING' ? undefined : new Date(),
        legCount: legs.length,
        combinedOdds: Number(combinedOdds.toFixed(4)),
        combinedFairOdds: Number(combinedFairOdds.toFixed(4)),
        combinedProbability: Number(combinedProbability.toFixed(8)),
        combinedProbabilityMethod: 'PRODUCT_OF_STORED_PICK_CENTER_SELECTION_PROBABILITIES',
        averageConfidence,
        generalConfidence: averageConfidence,
        minimumLegProbability: Math.min(...legs.map((leg) => leg.probability)),
        fixtureDateFrom: new Date(sortedDates[0]),
        fixtureDateTo: new Date(sortedDates[sortedDates.length - 1]),
        retentionExpiresAt: slipRetentionExpiresAt,
      },
      $unset: { fingerprint: 1 },
    }, { returnDocument: 'after', runValidators: true }).lean().exec();
    if (!updated) throw new BadRequestException('The slip was published, settled, or changed while the edit was being saved. Only an unsettled draft or READY slip can be edited.');
    await this.monitor.recordEvent({ type: 'ADMIN_ACTION', level: 'INFO', message: `Slip ${updated.slipCode} legs updated by admin.`, metadata: { slipId, legCount: legs.length, combinedOdds: updated.combinedOdds } });
    return updated;
  }

  private aggregateSettlement(outcomes: string[]): 'PENDING' | 'WON' | 'LOST' | 'VOID' | 'PUSH' | 'HALF_WON' | 'HALF_LOST' {
    if (!outcomes.length) return 'PENDING';
    const normalized = outcomes.map((value) => String(value ?? 'PENDING').toUpperCase());
    if (normalized.includes('LOST')) return 'LOST';
    const known = new Set(['WON', 'VOID', 'PUSH', 'HALF_WON', 'HALF_LOST']);
    if (normalized.some((value) => !known.has(value))) return 'PENDING';
    if (normalized.includes('HALF_LOST')) return 'HALF_LOST';
    if (normalized.includes('HALF_WON')) return 'HALF_WON';
    if (normalized.every((value) => value === 'VOID')) return 'VOID';
    if (normalized.every((value) => value === 'VOID' || value === 'PUSH')) return 'PUSH';
    return 'WON';
  }

  async publishSlip(slipId: string): Promise<any> {
    const slip = await this.slipModel.findById(slipId).lean().exec() as any;
    if (!slip) throw new NotFoundException('Slip was not found.');
    const slipStatus = String(slip.status ?? '').toUpperCase();
    if (slipStatus === SlipStatus.PUBLISHED) return slip;
    if (
      ![SlipStatus.DRAFT, SlipStatus.READY].includes(slipStatus as SlipStatus)
      || String(slip.settlementStatus ?? 'PENDING').toUpperCase() !== 'PENDING'
      || slip.snapshotFrozenAt
    ) {
      throw new BadRequestException('Only an unsettled draft or READY slip can be published. Published and settled slips cannot be republished or rewritten.');
    }
    const isSure = slip.productType === SlipProductType.SURE_ODDS || slip.sureOdds === true;
    const currentProductTypes: SlipProductType[] = [SlipProductType.ODDS_10, SlipProductType.ODDS_25, SlipProductType.ODDS_50, SlipProductType.SURE_ODDS];
    const isCurrentProduct = currentProductTypes.includes(slip.productType as SlipProductType);
    if (!isCurrentProduct && String(slip.status).toUpperCase() !== String(SlipStatus.PUBLISHED)) {
      throw new BadRequestException('Archived slip product types are preserved for historical records and cannot be newly published.');
    }
    if (isSure && slip.productType !== SlipProductType.SURE_ODDS && String(slip.status).toUpperCase() !== String(SlipStatus.PUBLISHED)) {
      throw new BadRequestException('New Sure Odds slips must use the SURE_ODDS product type and an explicit SURE_2, SURE_5, or SURE_7 product.');
    }
    const config = PREDICTION_ENGINE_CONFIG.slipCenter;
    const minimumLegs = isSure ? config.sureOdds.minimumLegs : config.minimumLegs;
    const maximumLegs = isSure ? config.sureOdds.maximumLegs : config.maximumLegs;
    if (!Array.isArray(slip.legs) || slip.legs.length < minimumLegs || slip.legs.length > maximumLegs) {
      throw new BadRequestException(`The slip must contain between ${minimumLegs} and ${maximumLegs} legs to publish.`);
    }
    if (new Set(slip.legs.map((leg: any) => `${String(leg.eventId)}::${String(leg.marketPredictionId)}::${String(leg.marketKey)}::${String(leg.selectionKey)}`)).size !== slip.legs.length) throw new BadRequestException('A slip cannot contain the same market selection more than once.');
    if (new Set(slip.legs.map((leg: any) => `${String(leg.eventId)}::${String(leg.marketKey).toUpperCase()}`)).size !== slip.legs.length) throw new BadRequestException('A slip may contain only one selection per market for each match.');
    this.assertConsistentFixtureKickoffDates(slip.legs);
    if (!this.fixtureDatesAreAllowed(slip.legs)) {
      throw new BadRequestException('A slip may combine fixtures from no more than two consecutive Nigeria calendar dates.');
    }
    const perMatchLimit = isSure ? config.sureOdds.maximumSelectionsPerMatch : config.maximumSelectionsPerMatch;
    const countsByEvent = new Map<string, number>();
    const nowMs = Date.now();
    const eventIds: string[] = [...new Set<string>(slip.legs.map((leg: any): string => String(leg.eventId)))];
    const window = publicationWindow(new Date(nowMs));
    const picks = await this.pickCenterModel.find({
      eventId: { $in: eventIds },
      'selectedMarkets.0': { $exists: true },
      completed: { $ne: true },
      live: { $ne: true },
      fixtureDate: { $gt: window.from, $lte: window.to },
    }).lean().exec() as any[];
    const pickByEvent = new Map(picks.map((pick) => [String(pick.eventId), pick]));
    for (const leg of slip.legs) {
      const eventId = String(leg.eventId);
      const count = (countsByEvent.get(eventId) ?? 0) + 1;
      if (count > perMatchLimit) {
        throw new BadRequestException(`A ${isSure ? 'Sure Odds' : 'normal'} slip cannot contain more than ${perMatchLimit} selections from the same match.`);
      }
      countsByEvent.set(eventId, count);
      const pick = pickByEvent.get(eventId);
      const fixtureDate = pick ? new Date(pick.fixtureDate) : new Date('');
      if (!pick || pick.completed === true || !Number.isFinite(fixtureDate.getTime())
        || !isInPublicationWindow(fixtureDate, pick.live === true, new Date(nowMs))) {
        throw new BadRequestException(`Slip leg ${eventId} is completed or outside current and next Nigeria calendar-date publication window.`);
      }
      const currentSelection = (pick.selectedMarkets ?? []).find((item: any) =>
        String(item.marketPredictionId) === String(leg.marketPredictionId)
        && String(item.marketKey) === String(leg.marketKey)
        && String(item.selectionKey) === String(leg.selectionKey)
      );
      const currentProbability = Number(currentSelection?.probability);
      const currentConfidence = Number(currentSelection?.confidence);
      const offeredOdds = Number(currentSelection?.decimalOdds);
      const currentOddsUpdatedAt = asDate(currentSelection?.oddsUpdatedAt);
      const storedOddsUpdatedAt = asDate(leg.oddsUpdatedAt);
      const sameSnapshot = currentSelection
        && Math.abs(currentProbability - Number(leg.probability)) <= 0.000001
        && Math.abs(currentConfidence - Number(leg.confidence)) <= 0.000001
        && Math.abs(offeredOdds - Number(leg.decimalOdds)) <= 0.000001
        && currentSelection.priceType === leg.priceType
        && String(currentSelection.oddsBasis ?? '') === String(leg.oddsBasis ?? '')
        && String(currentSelection.oddsCalculationMethod ?? '') === String(leg.oddsCalculationMethod ?? '')
        && String(currentSelection.oddsProvider ?? '') === String(leg.oddsProvider ?? '')
        && String(currentSelection.bookmaker ?? '') === String(leg.bookmaker ?? '')
        && Number.isFinite(currentOddsUpdatedAt.getTime())
        && currentOddsUpdatedAt.getTime() === storedOddsUpdatedAt.getTime();
      if (!currentSelection
        || currentSelection.isFinalSelection !== true
        || currentSelection.oddsPredictionReady !== true
        || (currentSelection.priceType !== 'PROVIDER' && currentSelection.priceType !== 'ESTIMATED')
        || !sameSnapshot
        || !isOddsQuoteFresh(currentOddsUpdatedAt, nowMs)
        || !isOddsQuoteFresh(storedOddsUpdatedAt, nowMs)
        || !Number.isFinite(currentProbability) || currentProbability < config.minimumLegProbability || currentProbability >= 1
        || !Number.isFinite(currentConfidence) || currentConfidence < config.minimumLegConfidence || currentConfidence > PREDICTION_ENGINE_CONFIG.model.maximumConfidence
        || !Number.isFinite(offeredOdds) || offeredOdds < configOddsMinimum() || offeredOdds > configOddsMaximum()
        || !currentSelection.oddsBasis || !currentSelection.oddsCalculationMethod) {
        throw new BadRequestException('A slip selection or its Odds quote changed, expired, or no longer meets the Slip Center rules after the draft was created. Rebuild the draft before publishing.');
      }
    }
    const odds = this.calculateCombinedOdds(slip.legs);
    if (odds === null) throw new BadRequestException('Cannot publish a slip without a valid stored Odds-module price for every leg.');
    const combinedProbability = combinedSelectionProbability(slip.legs ?? []);
    if (!Number.isFinite(combinedProbability) || combinedProbability <= 0 || combinedProbability > 1) {
      throw new BadRequestException('Slip combined probability cannot be calculated from the stored leg probabilities.');
    }

    if (isSure) {
      const product = (slip.sureOddsProduct ?? 'SURE_2') as SureOddsProduct;
      const range = config.sureOdds.products[product];
      if (!range || odds < range.minOdds || odds > range.maxOdds) throw new BadRequestException(`Sure Odds combined odds must be between ${range?.minOdds ?? 0} and ${range?.maxOdds ?? 0}.`);
    } else {
      const band = (config.oddsBands as any)[slip.productType ?? SlipProductType.STANDARD];
      if (!band || odds < band.minOdds || (band.maxOdds !== null && odds > band.maxOdds)) throw new BadRequestException('The slip combined odds do not satisfy its assigned product category. Regenerate or recategorize the slip.');
    }

    const requiredPlan = isSure
      ? (slip.sureOddsProduct === 'SURE_2' || slip.sureOddsTier === 'VIP' ? 'vip' : 'premium')
      : (slip.productType === SlipProductType.ODDS_10 || slip.productType === SlipProductType.EXTENDED_ODDS || slip.productType === SlipProductType.UNLIMITED_ODDS) ? 'regular'
        : (slip.productType === SlipProductType.ODDS_50 || slip.productType === SlipProductType.HIGH_ODDS) ? 'premium' : 'vip';
    const publishedAt = new Date(nowMs);
    const published = await this.slipModel.findOneAndUpdate(
      {
        _id: slipId,
        status: { $in: [SlipStatus.DRAFT, SlipStatus.READY] },
        settlementStatus: { $in: ['PENDING', null] },
        snapshotFrozenAt: { $in: [null] },
      },
      { $set: { status: SlipStatus.PUBLISHED, publishedAt, snapshotFrozenAt: publishedAt, combinedOdds: Number(odds.toFixed(4)), combinedProbability: Number(combinedProbability.toFixed(8)), combinedProbabilityMethod: 'PRODUCT_OF_STORED_PICK_CENTER_SELECTION_PROBABILITIES', requiredPlan, diagnostics: [
        'Combined probability is the product of probabilities stored in Pick Center. It is a model estimate, not a guaranteed win rate.',
        'Combined odds are the mathematical product of individual stored prices. A combined same-fixture bookmaker price is not claimed unless the bookmaker explicitly offers it.',
        ...(slip.legs.some((leg: any) => leg.priceType === 'ESTIMATED')
          ? ['Contains estimated Odds-module prices; combinedOdds is an indicative mathematical product, not a bookmaker-quoted accumulator price.']
          : ['Leg prices are provider-backed; combinedOdds is the mathematical product of leg prices and may differ from a bookmaker accumulator quote.']),
      ] } },
      { returnDocument: 'after', runValidators: true },
    ).lean().exec();
    if (!published) {
      throw new BadRequestException('The slip changed while publication was in progress. Reload it before trying again.');
    }
    return published;
  }

  async getSlip(slipId: string): Promise<Record<string, unknown>> {
    const slip = await this.slipModel.findById(slipId).lean().exec() as any;
    if (!slip) throw new NotFoundException('Slip was not found.');
    const marketPredictionIds = [...new Set((slip.legs ?? []).map((leg: any) => String(leg.marketPredictionId ?? '')).filter(Boolean))];
    const markets = marketPredictionIds.length
      ? await this.marketPredictionModel.find({ _id: { $in: marketPredictionIds } }).select('_id selections').lean().exec() as any[]
      : [];
    const outcomes = new Map<string, string>();
    for (const market of markets) {
      for (const selection of market.selections ?? []) {
        const outcome = String(selection.actualOutcome ?? '').toUpperCase();
        if (['WON', 'LOST', 'VOID', 'PUSH', 'HALF_WON', 'HALF_LOST'].includes(outcome)) outcomes.set(`${String(market._id)}::${String(selection.key)}`, outcome);
      }
    }
    const legs: Array<Record<string, unknown>> = (slip.legs ?? []).map((leg: Record<string, unknown>): Record<string, unknown> => ({
      ...leg,
      settlementOutcome: outcomes.get(`${String(leg.marketPredictionId)}::${String(leg.selectionKey)}`) ?? leg.settlementOutcome ?? 'PENDING',
    }));
    const byEvent = new Map<string, any[]>();
    for (const leg of legs) {
      const group = byEvent.get(String(leg.eventId)) ?? [];
      group.push(leg);
      byEvent.set(String(leg.eventId), group);
    }
    for (const group of byEvent.values()) {
      const matchStatus = this.aggregateSettlement(group.map((leg) => String(leg.settlementOutcome ?? 'PENDING')));
      group.forEach((leg) => { leg.matchSettlementStatus = matchStatus; });
    }
    const settlementStatus = this.aggregateSettlement(legs.map((leg: any) => String(leg.settlementOutcome ?? 'PENDING')));
    const result: Record<string, unknown> = {
      ...(slip as Record<string, unknown>),
      legs,
      settlementStatus,
      settledAt: slip.settledAt ?? (settlementStatus === 'PENDING' ? undefined : new Date()),
    };
    return result;
  }

  private pickLegCandidatesFromCenter(
    pick: any,
    minimumProbability: number,
    minimumConfidence: number,
    maximumMarkets: number,
  ): SlipLegInput[] {
    const fixtureDate = new Date(pick.fixtureDate);
    const config = PREDICTION_ENGINE_CONFIG.slipCenter;
    if (pick.completed === true || !Number.isFinite(fixtureDate.getTime())) return [];
    if (!isInPublicationWindow(fixtureDate, pick.live === true)) return [];

    // Probability and confidence determine eligibility. Ranking metadata breaks ties;
    // retain at most one selection per market, up to three selections per fixture.
    const marketOptions = Array.isArray(pick.selectedMarkets)
      ? [...pick.selectedMarkets].sort((a: any, b: any) =>
          Number(b.probability ?? 0) - Number(a.probability ?? 0)
          || Number(b.confidence ?? 0) - Number(a.confidence ?? 0)
          || Number(b.rankingScore ?? 0) - Number(a.rankingScore ?? 0)
          || Number(a.rank ?? Number.MAX_SAFE_INTEGER) - Number(b.rank ?? Number.MAX_SAFE_INTEGER))
      : [];
    const seenMarkets = new Set<string>();
    const eligible: SlipLegInput[] = [];

    for (const selected of marketOptions) {
      const marketKey = String(selected.marketKey ?? '').trim();
      const marketIdentity = marketKey.toUpperCase();
      const marketPredictionId = String(selected.marketPredictionId ?? '').trim();
      const selectionKey = String(selected.selectionKey ?? '').trim();
      if (!marketKey || !marketPredictionId || !selectionKey || seenMarkets.has(marketIdentity)) continue;
      if (selected.isFinalSelection !== true || selected.oddsPredictionReady !== true) continue;
      const priceType = selected.priceType === 'PROVIDER' || selected.priceType === 'ESTIMATED'
        ? selected.priceType
        : null;
      if (!priceType) continue;

      const probability = Number(selected.probability);
      const confidence = Number(selected.confidence ?? 0);
      const rawDataQuality = Number(selected.dataQuality ?? 0);
      const dataQuality = Number.isFinite(rawDataQuality) ? Math.max(0, Math.min(1, rawDataQuality)) : 0;
      const decimalOdds = Number(selected.decimalOdds);
      if (!Number.isFinite(probability) || probability < Math.max(minimumProbability, config.minimumLegProbability) || probability >= 1
        || !Number.isFinite(confidence) || confidence < Math.max(minimumConfidence, config.minimumLegConfidence) || confidence > PREDICTION_ENGINE_CONFIG.model.maximumConfidence
        || !Number.isFinite(decimalOdds) || decimalOdds < configOddsMinimum() || decimalOdds > configOddsMaximum()) continue;

      const fairOddsInput = Number(selected.fairOdds);
      const fairOdds = Number.isFinite(fairOddsInput) && fairOddsInput > 1 ? fairOddsInput : 1 / probability;
      const rawUpdatedAt = selected.oddsUpdatedAt instanceof Date
        ? selected.oddsUpdatedAt
        : new Date(selected.oddsUpdatedAt ?? '');
      const validUpdatedAt = isOddsQuoteFresh(rawUpdatedAt) ? rawUpdatedAt : undefined;
      if (!validUpdatedAt) continue;
      const oddsBasisRaw = String(selected.oddsBasis ?? '');
      const oddsBasis = ['BOOKMAKER_ONLY', 'BOOKMAKER_PLUS_HISTORY', 'HISTORICAL_ONLY', 'PRIOR_ONLY'].includes(oddsBasisRaw)
        ? oddsBasisRaw as SlipLegInput['oddsBasis']
        : undefined;
      const oddsCalculationMethod = typeof selected.oddsCalculationMethod === 'string' && selected.oddsCalculationMethod.trim()
        ? selected.oddsCalculationMethod.trim()
        : undefined;
      if (!oddsBasis || !oddsCalculationMethod) continue;
      const settlementProfile = selected.settlementProfile && typeof selected.settlementProfile === 'object'
        ? selected.settlementProfile
        : undefined;
      const expectedValue = priceType === 'PROVIDER' && oddsBasis === 'BOOKMAKER_ONLY'
        ? PredictionMathUtil.expectedValue(probability, decimalOdds, settlementProfile)
        : null;

      eligible.push({
        eventId: String(pick.eventId),
        homeTeamName: String(pick.homeTeamName ?? ''),
        awayTeamName: String(pick.awayTeamName ?? ''),
        fixtureDate,
        retentionExpiresAt: Number.isFinite(asDate(pick.retentionExpiresAt).getTime())
          ? asDate(pick.retentionExpiresAt)
          : null,
        marketPredictionId,
        marketKey,
        marketName: String(selected.marketName ?? marketKey),
        selectionKey,
        selectionName: String(selected.selectionName ?? selectionKey),
        probability,
        confidence: Math.max(0, Math.min(PREDICTION_ENGINE_CONFIG.model.maximumConfidence, confidence)),
        fairOdds,
        decimalOdds,
        priceType,
        oddsPredictionReady: true,
        ...(validUpdatedAt ? { oddsUpdatedAt: validUpdatedAt } : {}),
        ...(oddsBasis ? { oddsBasis } : {}),
        ...(oddsCalculationMethod ? { oddsCalculationMethod } : {}),
        ...(selected.oddsProvider === 'ESPN' || selected.oddsProvider === 'THE_ODDS_API' ? { oddsProvider: selected.oddsProvider } : {}),
        ...(selected.bookmaker ? { bookmaker: String(selected.bookmaker) } : {}),
        ...(expectedValue !== null ? { expectedValue, expectedValuePercent: expectedValue * 100 } : {}),
        dataQuality,
        modelVersion: String(pick.modelVersion ?? PREDICTION_ENGINE_CONFIG.modelVersion),
        ...(settlementProfile ? { settlementProfile } : {}),
        ...(priceType === 'PROVIDER' ? { bookmakerOdds: decimalOdds } : {}),
      });
      seenMarkets.add(marketIdentity);
      if (eligible.length >= Math.min(maximumMarkets, config.maximumSelectionsPerMatch)) break;
    }
    return eligible;
  }

  /**
   * A stale/invalid candidate should be skipped without aborting other valid
   * combinations or preventing later Sure Odds categories from running.
   * Database and unexpected failures still escape to the cycle-level handler.
   */
  private async upsertAutomaticCandidate(
    input: Parameters<SlipCenterService['upsertSlip']>[0],
  ): Promise<any> {
    try {
      return await this.upsertSlip(input);
    } catch (error) {
      if (error instanceof BadRequestException || (error as any)?.code === 11000) {
        this.logger.debug(
          `Skipping one invalid or duplicate automatic ${input.sureOddsProduct ?? input.productType} combination; continuing generation.`,
        );
        return null;
      }
      throw error;
    }
  }

  private async upsertSlip(input: {
    legs: SlipLegInput[];
    name: string;
    automatic: boolean;
    createdBy?: string;
    fingerprint?: string;
    fixtureDateFrom?: Date;
    fixtureDateTo?: Date;
    publish?: boolean;
    productType: SlipProductType;
    requiredPlan: 'regular' | 'vip' | 'premium';
    sureOddsTier?: 'VIP' | 'PREMIUM';
    sureOddsProduct?: SureOddsProduct;
    sureOdds?: boolean;
    generatedDateKey?: string;
    targetDateKey?: string;
    targetOddsMinimum?: number;
    targetOddsMaximum?: number;
  }): Promise<any> {
    if (!input.legs.length) return null;
    if (new Set(input.legs.map((leg) => `${leg.eventId}::${leg.marketPredictionId}::${leg.marketKey}::${leg.selectionKey}`)).size !== input.legs.length) throw new BadRequestException('A slip cannot contain the same market selection more than once.');
    if (new Set(input.legs.map((leg) => `${leg.eventId}::${leg.marketKey.toUpperCase()}`)).size !== input.legs.length) throw new BadRequestException('A slip may contain only one selection per market for each match.');
    this.assertConsistentFixtureKickoffDates(input.legs);
    const config = PREDICTION_ENGINE_CONFIG.slipCenter;
    const isSure = input.sureOdds === true || input.productType === SlipProductType.SURE_ODDS;
    if (!this.fixtureDatesAreAllowed(input.legs)) {
      throw new BadRequestException('A slip may combine fixtures from no more than two consecutive Nigeria calendar dates.');
    }
    if (input.automatic) {
      const automaticFixtureDates = new Set(
        input.legs.map((leg) => {
          const fixtureDate = asDate(leg.fixtureDate);
          return Number.isFinite(fixtureDate.getTime())
            ? this.nigeriaDateKey(fixtureDate)
            : 'INVALID_FIXTURE_DATE';
        }),
      );
      if (
        automaticFixtureDates.size !== 1
        || automaticFixtureDates.has('INVALID_FIXTURE_DATE')
      ) {
        throw new BadRequestException(
          'An automatic slip may contain valid fixtures from exactly one Nigeria calendar date.',
        );
      }
    }
    const matchSetFingerprint = input.automatic ? this.matchSetFingerprint(input.legs) : undefined;
    const perMatchLimit = isSure ? config.sureOdds.maximumSelectionsPerMatch : config.maximumSelectionsPerMatch;
    const eventCounts = new Map<string, number>();
    for (const leg of input.legs) {
      const count = (eventCounts.get(leg.eventId) ?? 0) + 1;
      if (count > perMatchLimit) throw new BadRequestException(`A ${isSure ? 'Sure Odds' : 'normal'} slip cannot contain more than ${perMatchLimit} selections from one fixture.`);
      eventCounts.set(leg.eventId, count);
      if ((leg.priceType !== 'PROVIDER' && leg.priceType !== 'ESTIMATED')
        || leg.oddsPredictionReady !== true
        || !leg.oddsBasis
        || !leg.oddsCalculationMethod
        || !isOddsQuoteFresh(leg.oddsUpdatedAt)
        || !Number.isFinite(leg.decimalOdds)
        || leg.decimalOdds < configOddsMinimum()
        || leg.decimalOdds > configOddsMaximum()
        || !Number.isFinite(leg.probability)
        || leg.probability < config.minimumLegProbability
        || leg.probability >= 1
        || !Number.isFinite(leg.fairOdds)
        || leg.fairOdds <= 1
        || !Number.isFinite(leg.confidence)
        || leg.confidence < config.minimumLegConfidence
        || leg.confidence > PREDICTION_ENGINE_CONFIG.model.maximumConfidence
        || !Number.isFinite(leg.dataQuality ?? 0)
        || Number(leg.dataQuality ?? 0) < 0
        || Number(leg.dataQuality ?? 0) > 1
) {
        throw new BadRequestException(`A slip leg must have valid stored odds and meet the configured probability and confidence thresholds.`);
      }
    }
    const minimumLegs = isSure ? config.sureOdds.minimumLegs : config.minimumLegs;
    const maximumLegs = isSure ? config.sureOdds.maximumLegs : config.maximumLegs;
    if (input.legs.length < minimumLegs || input.legs.length > maximumLegs) throw new BadRequestException(`The slip must contain between ${minimumLegs} and ${maximumLegs} legs.`);

    const combinedProbability = combinedSelectionProbability(input.legs);
    const combinedFairOdds = input.legs.reduce((product, leg) => product * leg.fairOdds, 1);
    const combinedOdds = this.calculateCombinedOdds(input.legs);
    if (isSure) {
      const product = input.sureOddsProduct ?? 'SURE_2';
      const range = config.sureOdds.products[product];
      if (!range || combinedOdds === null || combinedOdds < range.minOdds || combinedOdds > range.maxOdds) {
        throw new BadRequestException(`The ${product.replace('_', ' ')} combination must have combined odds inside its configured range.`);
      }
    } else {
      const band = (config.oddsBands as any)[input.productType];
      if (!band || combinedOdds === null || combinedOdds < band.minOdds || (band.maxOdds !== null && combinedOdds > band.maxOdds)) {
        throw new BadRequestException('The combination must have combined odds inside its configured category range.');
      }
    }
    const averageConfidence = Math.max(0, Math.min(98, Math.round(input.legs.reduce((sum, leg) => sum + leg.confidence, 0) / input.legs.length)));
    const legRetentionDates = input.legs.map((leg) => asDate(leg.retentionExpiresAt));
    const allLegsHaveRetention = legRetentionDates.every((date) => Number.isFinite(date.getTime()));
    const slipRetentionExpiresAt = allLegsHaveRetention
      ? new Date(Math.max(...legRetentionDates.map((date) => date.getTime())))
      : null;
    const legs = input.legs.map((leg) => ({
      eventId: leg.eventId, homeTeamName: leg.homeTeamName, awayTeamName: leg.awayTeamName,
      fixtureDate: leg.fixtureDate,
      retentionExpiresAt: Number.isFinite(asDate(leg.retentionExpiresAt).getTime())
        ? asDate(leg.retentionExpiresAt)
        : null,
      marketPredictionId: leg.marketPredictionId,
      marketKey: leg.marketKey, marketName: leg.marketName, selectionKey: leg.selectionKey,
      selectionName: leg.selectionName, probability: leg.probability, confidence: leg.confidence,
      fairOdds: leg.fairOdds, decimalOdds: leg.decimalOdds, priceType: leg.priceType,
      oddsPredictionReady: leg.oddsPredictionReady === true, oddsUpdatedAt: leg.oddsUpdatedAt,
      oddsBasis: leg.oddsBasis, oddsCalculationMethod: leg.oddsCalculationMethod, oddsProvider: leg.oddsProvider, bookmaker: leg.bookmaker,
      expectedValue: leg.expectedValue, expectedValuePercent: leg.expectedValuePercent, dataQuality: leg.dataQuality, modelVersion: leg.modelVersion, settlementProfile: leg.settlementProfile,
      ...(leg.bookmakerOdds !== undefined ? { bookmakerOdds: leg.bookmakerOdds } : {}),
    }));
    const status = input.publish ? SlipStatus.PUBLISHED : SlipStatus.READY;
    const publishedAt = input.publish ? new Date() : undefined;
    if (input.publish && combinedOdds === null) throw new BadRequestException('Cannot publish a slip without a valid Odds-module price for each leg.');
    const payload: Record<string, any> = {
      slipCode: `2XP-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: input.name,
      status,
      legs: legs.map((leg) => ({ ...leg, settlementOutcome: 'PENDING', matchSettlementStatus: 'PENDING' })),
      settlementStatus: 'PENDING',
      settledAt: undefined,
      legCount: legs.length,
      combinedProbability: Math.max(0, Math.min(1, combinedProbability)),
      combinedFairOdds: Number(combinedFairOdds.toFixed(4)),
      combinedOdds: combinedOdds === null ? undefined : Number(combinedOdds.toFixed(4)),
      averageConfidence,
      generalConfidence: averageConfidence,
      minimumLegProbability: Math.min(...legs.map((leg) => leg.probability)),
      fixtureDateFrom: input.fixtureDateFrom ?? new Date(Math.min(...legs.map((leg) => leg.fixtureDate.getTime()))),
      fixtureDateTo: input.fixtureDateTo ?? new Date(Math.max(...legs.map((leg) => leg.fixtureDate.getTime()))),
      retentionExpiresAt: slipRetentionExpiresAt,
      createdBy: input.createdBy,
      automatic: input.automatic,
      fingerprint: input.fingerprint,
      ...(matchSetFingerprint ? { matchSetFingerprint } : {}),
      combinedProbabilityMethod: 'PRODUCT_OF_STORED_PICK_CENTER_SELECTION_PROBABILITIES',
      productType: input.productType,
      requiredPlan: input.requiredPlan,
      sureOdds: isSure,
      sureOddsTier: input.sureOddsTier,
      sureOddsProduct: input.sureOddsProduct,
      generatedDateKey: input.generatedDateKey,
      targetDateKey: input.targetDateKey,
      targetOddsMinimum: input.targetOddsMinimum,
      targetOddsMaximum: input.targetOddsMaximum,
      diagnostics: [
        'Combined probability is the product of probabilities stored in Pick Center. It is a model estimate, not a guaranteed win rate.',
        'Combined odds multiply stored prices only as a mathematical product. Same-fixture combinations do not have a bookmaker-quoted combined price unless a provider explicitly supplies one; individual prices remain authoritative.',
        ...(input.legs.some((leg) => leg.priceType === 'ESTIMATED')
          ? ['Contains estimated Odds-module prices; combinedOdds is an indicative mathematical product, not a bookmaker-quoted accumulator price.']
          : ['Leg prices are provider-backed; combinedOdds is the mathematical product of leg prices and may differ from a bookmaker accumulator quote.']),
      ],
      publishedAt,
      snapshotFrozenAt: publishedAt,
    };

    let saved: any;
    if (input.fingerprint) {
      const fingerprintRecord = await this.slipModel.findOne({ fingerprint: input.fingerprint })
        .select({ _id: 1, status: 1, settlementStatus: 1, snapshotFrozenAt: 1 })
        .lean().exec() as any;
      if (matchSetFingerprint) {
        const duplicateMatchSet = await this.slipModel.findOne({
          matchSetFingerprint,
          ...(fingerprintRecord?._id ? { _id: { $ne: fingerprintRecord._id } } : {}),
        }).select({ _id: 1 }).lean().exec();
        if (duplicateMatchSet) return null;
      }
      if (fingerprintRecord) {
        const priorSettlement = String(fingerprintRecord.settlementStatus ?? 'PENDING').toUpperCase();
        const priorStatus = String(fingerprintRecord.status ?? '').toUpperCase();
        // Published snapshots, settled slips and manual cancellations are immutable.
        // A repeated automatic generation must never replace the published legs or prices.
        if (
          priorSettlement !== 'PENDING'
          || priorStatus === String(SlipStatus.CANCELLED).toUpperCase()
          || priorStatus === String(SlipStatus.PUBLISHED).toUpperCase()
          || Boolean(fingerprintRecord.snapshotFrozenAt)
        ) return null;
      }
      const { slipCode, ...updatePayload } = payload;
      saved = await this.slipModel.findOneAndUpdate(
        {
          fingerprint: input.fingerprint,
          settlementStatus: { $in: ['PENDING', null] },
          status: { $nin: [SlipStatus.CANCELLED, SlipStatus.PUBLISHED] },
          snapshotFrozenAt: { $in: [null] },
        },
        { $set: updatePayload, $setOnInsert: { slipCode } },
        { upsert: !fingerprintRecord, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true },
      ).lean().exec();
    } else {
      saved = await this.slipModel.create(payload);
      saved = saved.toObject();
    }
    if (!saved) return null;
    await this.monitor.recordEvent({
      type: 'SLIP_CREATED', level: combinedOdds === null ? 'WARNING' : 'INFO',
      message: `${input.automatic ? 'Automatic' : 'Manual'} ${input.sureOddsProduct ?? input.productType} slip ${saved.slipCode} saved (${legs.length} legs).`,
      metadata: { slipId: String(saved._id), legCount: legs.length, combinedProbability: saved.combinedProbability, combinedOdds: saved.combinedOdds ?? null, productType: input.productType, sureOddsProduct: input.sureOddsProduct, requiredPlan: input.requiredPlan, automatic: input.automatic },
    });
    return saved;
  }

  private async findCombinationInBand(
    groups: CandidateGroups,
    minimumOdds: number,
    maximumOdds: number | null,
    variant: number,
    minimumLegs: number,
    maximumLegs: number,
    candidateLimit: number,
    perMatchLimit: number,
    requiredDateKeys: Set<string> = new Set<string>(),
    requiredEventIds: Set<string> = new Set<string>(),
    excludedMatchSetFingerprints: Set<string> = new Set<string>(),
    preferredEventIds: Set<string> = new Set<string>(),
  ): Promise<SlipLegInput[] | null> {
    return this.findTargetDrivenCombination(
      groups,
      minimumOdds,
      maximumOdds,
      variant,
      minimumLegs,
      maximumLegs,
      candidateLimit,
      perMatchLimit,
      requiredDateKeys,
      requiredEventIds,
      excludedMatchSetFingerprints,
      preferredEventIds,
    );
  }

  private async findSureOddsCombination(
    groups: CandidateGroups,
    minimumOdds: number,
    maximumOdds: number,
    variant: number,
    minimumLegs: number,
    maximumLegs: number,
    perMatchLimit: number,
    requiredDateKeys: Set<string> = new Set<string>(),
    requiredEventIds: Set<string> = new Set<string>(),
    excludedMatchSetFingerprints: Set<string> = new Set<string>(),
    preferredEventIds: Set<string> = new Set<string>(),
  ): Promise<SlipLegInput[] | null> {
    return this.findTargetDrivenCombination(
      groups,
      minimumOdds,
      maximumOdds,
      variant,
      minimumLegs,
      maximumLegs,
      3,
      perMatchLimit,
      requiredDateKeys,
      requiredEventIds,
      excludedMatchSetFingerprints,
      preferredEventIds,
    );
  }

  /**
   * Build a slip toward its configured combined-odds target instead of
   * assembling an arbitrary leg count and rejecting the result afterwards.
   * Candidate quality is ranked by Pick Center probability and confidence;
   * odds determine whether a candidate combination reaches the product band.
   */
  private async findTargetDrivenCombination(
    groups: CandidateGroups,
    minimumOdds: number,
    maximumOdds: number | null,
    variant: number,
    minimumLegs: number,
    maximumLegs: number,
    candidateLimit: number,
    perMatchLimit: number,
    requiredDateKeys: Set<string> = new Set<string>(),
    requiredEventIds: Set<string> = new Set<string>(),
    excludedMatchSetFingerprints: Set<string> = new Set<string>(),
    preferredEventIds: Set<string> = new Set<string>(),
  ): Promise<SlipLegInput[] | null> {
    if (
      !Number.isFinite(minimumOdds)
      || minimumOdds <= 1
      || (maximumOdds !== null
        && (!Number.isFinite(maximumOdds) || maximumOdds < minimumOdds))
    ) {
      return null;
    }

    const usableGroups = groups
      .map((group) => group.slice(0, candidateLimit))
      .filter((group) => group.length > 0);
    if (!usableGroups.length) return null;

    const eventCount = new Set(
      usableGroups.map((group) => String(group[0]?.eventId ?? '')).filter(Boolean),
    ).size;
    const upperBound = Math.min(eventCount * perMatchLimit, maximumLegs);
    if (upperBound < minimumLegs) return null;

    const candidates: SlipLegInput[] = [];
    const seen = new Set<string>();
    for (const group of usableGroups) {
      for (const candidate of group) {
        const odds = Number(candidate.decimalOdds ?? candidate.bookmakerOdds);
        const probability = Number(candidate.probability);
        const confidence = Number(candidate.confidence);
        if (
          !Number.isFinite(odds)
          || odds < configOddsMinimum()
          || odds > configOddsMaximum()
          || !Number.isFinite(probability)
          || probability < PREDICTION_ENGINE_CONFIG.slipCenter.minimumLegProbability
          || probability >= 1
          || !Number.isFinite(confidence)
          || confidence < PREDICTION_ENGINE_CONFIG.slipCenter.minimumLegConfidence
          || confidence > PREDICTION_ENGINE_CONFIG.model.maximumConfidence
        ) continue;

        const identity = `${candidate.eventId}::${candidate.marketPredictionId}::${candidate.marketKey}::${candidate.selectionKey}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        candidates.push(candidate);
      }
    }
    if (!candidates.length) return null;

    // Price is deliberately not the primary sort key. Prefer stronger Pick Center
    // probability/confidence and use odds only when exploring target combinations.
    candidates.sort((a, b) =>
      Number(preferredEventIds.has(String(b.eventId))) - Number(preferredEventIds.has(String(a.eventId)))
      || Number(b.probability) - Number(a.probability)
      || Number(b.confidence) - Number(a.confidence)
      || Number(b.dataQuality ?? 0) - Number(a.dataQuality ?? 0),
    );

    const targetOdds = maximumOdds === null
      ? minimumOdds
      : Math.sqrt(minimumOdds * maximumOdds);
    const qualitySample = candidates.slice(0, Math.min(candidates.length, 20));
    const averageLogOdds = qualitySample.reduce(
      (sum, candidate) => sum + Math.log(Number(candidate.decimalOdds ?? candidate.bookmakerOdds)),
      0,
    ) / qualitySample.length;
    if (!Number.isFinite(averageLogOdds) || averageLogOdds <= 0) return null;

    const estimatedLegs = Math.max(
      minimumLegs,
      Math.min(upperBound, Math.ceil(Math.log(targetOdds) / averageLogOdds)),
    );
    const legCounts: number[] = [];
    for (let distance = 0; distance <= upperBound - minimumLegs; distance++) {
      const lower = estimatedLegs - distance;
      const higher = estimatedLegs + distance;
      if (lower >= minimumLegs && lower <= upperBound && !legCounts.includes(lower)) legCounts.push(lower);
      if (distance > 0 && higher >= minimumLegs && higher <= upperBound && !legCounts.includes(higher)) legCounts.push(higher);
    }
    if (legCounts.length > 1 && variant > 0) {
      const rotation = variant % legCounts.length;
      const rotated = [...legCounts.slice(rotation), ...legCounts.slice(0, rotation)];
      const estimatedIndex = rotated.indexOf(estimatedLegs);
      if (estimatedIndex > 0) {
        rotated.splice(estimatedIndex, 1);
        rotated.unshift(estimatedLegs);
      }
      legCounts.splice(0, legCounts.length, ...rotated);
    }

    type SearchState = {
      legs: SlipLegInput[];
      lastIndex: number;
      combinedOdds: number;
      quality: number;
    };
    const beamWidth = 350;
    const maximumExpansionsPerDepth = 100_000;

    const qualityOf = (legs: SlipLegInput[]): number => legs.reduce(
      (sum, leg) => sum + Number(leg.probability) * 0.7 + (Number(leg.confidence) / 100) * 0.3,
      0,
    ) / legs.length;

    for (const targetLegCount of legCounts) {
      await this.yieldToEventLoop();
      let states: SearchState[] = [{ legs: [], lastIndex: -1, combinedOdds: 1, quality: 0 }];
      let exhaustedBudget = false;

      for (let depth = 1; depth <= targetLegCount; depth++) {
        const nextStates: SearchState[] = [];
        let expansions = 0;

        for (const state of states) {
          for (let index = state.lastIndex + 1; index < candidates.length; index++) {
            if (++expansions > maximumExpansionsPerDepth) {
              exhaustedBudget = true;
              break;
            }
            const candidate = candidates[index];
            const eventId = String(candidate.eventId);
            const marketKey = String(candidate.marketKey).toUpperCase();
            const existingForEvent = state.legs.filter((leg) => String(leg.eventId) === eventId);
            if (existingForEvent.length >= perMatchLimit) continue;
            if (existingForEvent.some((leg) => String(leg.marketKey).toUpperCase() === marketKey)) continue;
            if (!state.legs.every((leg) => selectionsAreCompatible(leg, candidate))) continue;

            const legOdds = Number(candidate.decimalOdds ?? candidate.bookmakerOdds);
            const combinedOdds = state.combinedOdds * legOdds;
            if (!Number.isFinite(combinedOdds)) continue;
            if (maximumOdds !== null && combinedOdds > maximumOdds) continue;

            const legs = [...state.legs, candidate];
            if (!this.fixtureDatesAreAllowed(legs)) continue;
            const quality = qualityOf(legs);
            if (depth === targetLegCount) {
              if (
                combinedOdds < minimumOdds
                || (maximumOdds !== null && combinedOdds > maximumOdds)
                || !this.combinationIncludesDates(legs, requiredDateKeys)
                || !this.combinationIncludesEvents(legs, requiredEventIds)
                || excludedMatchSetFingerprints.has(this.matchSetFingerprint(legs))
              ) continue;
              this.assertConsistentFixtureKickoffDates(legs);
              return legs;
            }
            nextStates.push({ legs, lastIndex: index, combinedOdds, quality });
          }
          if (exhaustedBudget) break;
        }

        if (!nextStates.length) break;
        const distanceFromBand = (state: SearchState): number => {
          if (state.combinedOdds < minimumOdds) return Math.log(minimumOdds / state.combinedOdds);
          if (maximumOdds !== null && state.combinedOdds > maximumOdds) return Math.log(state.combinedOdds / maximumOdds);
          return 0;
        };
        nextStates.sort((a, b) =>
          distanceFromBand(a) - distanceFromBand(b)
          || b.quality - a.quality
          || b.combinedOdds - a.combinedOdds,
        );
        states = nextStates.slice(0, beamWidth);
        await this.yieldToEventLoop();
        if (exhaustedBudget) break;
      }
    }
    return null;
  }

  /** Select up to the configured number of distinct market selections per fixture. */
  private async buildGroupedCombination(
    groups: CandidateGroups,
    count: number,
    variant: number,
    candidateLimit: number,
    perMatchLimit: number,
    requiredDateKeys: Set<string> = new Set<string>(),
    requiredEventIds: Set<string> = new Set<string>(),
  ): Promise<SlipLegInput[] | null> {
    if (!groups.length || count < 1) return null;
    const usableGroups = groups.map((group) => group.slice(0, candidateLimit)).filter((group) => group.length > 0);
    if (!usableGroups.length) return null;
    const prioritized = [...usableGroups].sort((left, right) => {
      const leftEvent = String(left[0]?.eventId ?? '');
      const rightEvent = String(right[0]?.eventId ?? '');
      const leftDate = this.nigeriaDateKey(left[0].fixtureDate);
      const rightDate = this.nigeriaDateKey(right[0].fixtureDate);
      const leftRequiredEvent = requiredEventIds.has(leftEvent) ? 0 : 1;
      const rightRequiredEvent = requiredEventIds.has(rightEvent) ? 0 : 1;
      const leftRequiredDate = requiredDateKeys.has(leftDate) ? 0 : 1;
      const rightRequiredDate = requiredDateKeys.has(rightDate) ? 0 : 1;
      return leftRequiredEvent - rightRequiredEvent
        || leftRequiredDate - rightRequiredDate
        || left[0].fixtureDate.getTime() - right[0].fixtureDate.getTime();
    });
    const start = requiredDateKeys.size || requiredEventIds.size
      ? 0
      : (variant * 7) % prioritized.length;
    const ordered = [...prioritized.slice(start), ...prioritized.slice(0, start)];
    const legs: SlipLegInput[] = [];
    const countsByEvent = new Map<string, number>();
    const kickoffByEvent = new Map<string, number>();
    const usedSelections = new Set<string>();
    const maxRounds = Math.min(perMatchLimit, candidateLimit);

    for (let round = 0; round < maxRounds && legs.length < count; round++) {
      let addedThisRound = false;
      for (let groupIndex = 0; groupIndex < ordered.length && legs.length < count; groupIndex++) {
        if (groupIndex > 0 && groupIndex % 12 === 0) await this.yieldToEventLoop();
        const group = ordered[groupIndex];
        if (!group.length) continue;
        const eventId = String(group[0].eventId);
        if ((countsByEvent.get(eventId) ?? 0) >= perMatchLimit) continue;
        const offset = round % group.length;
        const candidates = [...group.slice(offset), ...group.slice(0, offset)];
        const candidate = candidates.find((leg) => {
          const identity = `${leg.eventId}::${leg.marketPredictionId}::${leg.marketKey}::${leg.selectionKey}`;
          return !usedSelections.has(identity)
            && !legs.some((existing) => existing.eventId === leg.eventId
              && (existing.marketKey.toUpperCase() === leg.marketKey.toUpperCase()
                || (existing.marketPredictionId === leg.marketPredictionId
                  && existing.marketKey === leg.marketKey && existing.selectionKey === leg.selectionKey)))
            && legs.every((existing) => selectionsAreCompatible(existing, leg))
            && this.fixtureDatesAreAllowed([...legs, leg]);
        });
        if (!candidate) continue;
        const identity = `${candidate.eventId}::${candidate.marketPredictionId}::${candidate.marketKey}::${candidate.selectionKey}`;
        usedSelections.add(identity);
        legs.push(candidate);
        countsByEvent.set(eventId, (countsByEvent.get(eventId) ?? 0) + 1);
        const kickoffTime = candidate.fixtureDate.getTime();
        const priorKickoff = kickoffByEvent.get(eventId);
        if (priorKickoff !== undefined && priorKickoff !== kickoffTime) return null;
        kickoffByEvent.set(eventId, kickoffTime);
        addedThisRound = true;
      }
      if (!addedThisRound) break;
    }
    this.assertConsistentFixtureKickoffDates(legs);
    return legs.length === count ? legs : null;
  }

  private combinationIncludesDates(legs: SlipLegInput[], requiredDateKeys: Set<string>): boolean {
    if (!requiredDateKeys.size) return true;
    const included = new Set(legs.map((leg) => this.nigeriaDateKey(leg.fixtureDate)));
    return [...requiredDateKeys].every((dateKey) => included.has(dateKey));
  }

  private combinationIncludesEvents(legs: SlipLegInput[], requiredEventIds: Set<string>): boolean {
    if (!requiredEventIds.size) return true;
    const included = new Set(legs.map((leg) => String(leg.eventId)));
    return [...requiredEventIds].every((eventId) => included.has(eventId));
  }

  private calculateCombinedOdds(legs: Array<{ decimalOdds?: number; bookmakerOdds?: number; priceType?: 'PROVIDER' | 'ESTIMATED' }>): number | null {
    if (!legs.length) return null;
    let result = 1;
    for (const leg of legs) {
      if (leg.priceType !== undefined && leg.priceType !== 'PROVIDER' && leg.priceType !== 'ESTIMATED') return null;
      const odds = Number(leg.decimalOdds ?? leg.bookmakerOdds);
      if (!Number.isFinite(odds) || odds < 1.01 || odds > 100000) return null;
      result *= odds;
      if (!Number.isFinite(result)) return null;
    }
    return result;
  }

  /**
   * Multiple distinct fixtures may share a kickoff date, and a slip may span
   * several dates. Only require each fixture identity to retain one consistent
   * kickoff timestamp across all selections attached to that fixture.
   */
  private fixtureDatesAreAllowed(
    legs: Array<{ fixtureDate: Date | string | number }>,
  ): boolean {
    const dateKeys = [...new Set(legs.map((leg) => this.nigeriaDateKey(asDate(leg.fixtureDate))))].sort();
    if (dateKeys.length <= 1) return true;
    if (dateKeys.length !== 2) return false;
    const firstDay = new Date(`${dateKeys[0]}T00:00:00.000+01:00`).getTime();
    const secondDay = new Date(`${dateKeys[1]}T00:00:00.000+01:00`).getTime();
    return secondDay - firstDay === 24 * 60 * 60 * 1000;
  }

  private assertConsistentFixtureKickoffDates(
    legs: Array<{ eventId: string; fixtureDate: Date | string | number }>,
  ): void {
    const kickoffByEvent = new Map<string, number>();
    for (const leg of legs) {
      const eventId = String(leg.eventId ?? '').trim();
      const kickoff = asDate(leg.fixtureDate);
      if (!eventId || !Number.isFinite(kickoff.getTime())) {
        throw new BadRequestException('Every slip leg must have a valid fixture identity and kickoff date.');
      }
      const priorKickoff = kickoffByEvent.get(eventId);
      if (priorKickoff !== undefined && priorKickoff !== kickoff.getTime()) {
        throw new BadRequestException(`Fixture ${eventId} contains inconsistent kickoff timestamps in the same slip.`);
      }
      kickoffByEvent.set(eventId, kickoff.getTime());
    }
  }

  /** Rank alternatives: unused fixtures first, then leg quality and odds-band fit. */
  private combinationCandidateScore(
    legs: SlipLegInput[],
    minimumOdds: number,
    maximumOdds: number | null,
    preferredUnusedEventIds: Set<string>,
  ): number {
    const eventIds = [...new Set(legs.map((leg) => String(leg.eventId)))];
    const unusedCount = eventIds.filter((eventId) => preferredUnusedEventIds.has(eventId)).length;
    const averageProbability = legs.reduce((sum, leg) => sum + Number(leg.probability || 0), 0) / Math.max(1, legs.length);
    const averageConfidence = legs.reduce((sum, leg) => sum + Number(leg.confidence || 0), 0) / Math.max(1, legs.length);
    const combinedOdds = legs.reduce((product, leg) => product * Number(leg.decimalOdds ?? leg.bookmakerOdds), 1);
    const targetOdds = maximumOdds !== null && maximumOdds > minimumOdds
      ? Math.sqrt(minimumOdds * maximumOdds)
      : minimumOdds;
    const oddsFit = Number.isFinite(combinedOdds) && combinedOdds > 1 && targetOdds > 1
      ? 1 / (1 + Math.abs(Math.log(combinedOdds / targetOdds)))
      : 0;
    // One additional unused fixture outweighs any probability/confidence tie-break.
    return unusedCount * 1000 + averageProbability * 100 + averageConfidence * 0.1 + oddsFit;
  }

  private combinationSignature(legs: SlipLegInput[]): string {
    return legs.map((leg) => `${leg.eventId}:${leg.marketKey}:${leg.selectionKey}`).sort().join('|');
  }

  private combinationFingerprint(prefix: string, signature: string): string {
    const digest = createHash('sha256').update(signature).digest('hex').slice(0, 24).toUpperCase();
    return `${prefix}_${digest}`;
  }

  /** Stable identity of the complete fixture set, independent of market choices. */
  private matchSetSignature(legs: Array<{ eventId: string }>): string {
    return [...new Set(legs.map((leg) => String(leg.eventId ?? '').trim()).filter(Boolean))]
      .sort()
      .join('|');
  }

  private matchSetFingerprint(legs: Array<{ eventId: string }>): string {
    const signature = this.matchSetSignature(legs);
    const digest = createHash('sha256').update(signature).digest('hex').slice(0, 32).toUpperCase();
    return `MATCHSET_${digest}`;
  }

  private nigeriaDateKey(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  private async yieldToEventLoop(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private productLabel(productType: SlipProductType): string {
    const labels: Record<SlipProductType, string> = {
      [SlipProductType.ODDS_10]: '10-Odds Slip',
      [SlipProductType.ODDS_25]: '25-Odds Slip',
      [SlipProductType.ODDS_50]: '50-Odds Slip',
      [SlipProductType.STANDARD]: 'Legacy Standard Slip',
      [SlipProductType.MEDIUM_ODDS]: '20–50 Odds Slip',
      [SlipProductType.HIGH_ODDS]: '50–100 Odds Slip',
      [SlipProductType.EXTENDED_ODDS]: '100–200 Odds Slip',
      [SlipProductType.UNLIMITED_ODDS]: '200+ Odds Slip',
      [SlipProductType.SURE_ODDS]: 'Sure Odds',
    };
    return labels[productType];
  }

  async publishAllUnpublishedSlips(): Promise<{
  total: number;
  published: number;
  skipped: number;
  errors: Array<{ slipId: string; reason: string }>;
}> {
  const unpublishedSlips = await this.slipModel
    .find({
      status: {
        $in: [SlipStatus.READY, SlipStatus.DRAFT],
      },
    })
    .select({ _id: 1, slipCode: 1 })
    .lean()
    .exec();

  let published = 0;
  const errors: Array<{ slipId: string; reason: string }> = [];

  for (const slip of unpublishedSlips) {
    const slipId = String(slip._id);

    try {
      await this.publishSlip(slipId);
      published++;
    } catch (error) {
      errors.push({
        slipId,
        reason:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  const result = {
    total: unpublishedSlips.length,
    published,
    skipped: errors.length,
    errors,
  };

  await this.monitor.recordEvent({
    type: 'ADMIN_ACTION',
    level: errors.length ? 'WARNING' : 'INFO',
    message: `Bulk slip publication completed: ${published}/${result.total} published; ${errors.length} skipped.`,
    metadata: result,
  });

  return result;
}
}


