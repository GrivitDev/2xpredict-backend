/* eslint-disable
  @typescript-eslint/no-base-to-string,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-enum-comparison,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return
*/
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { MarketPrediction } from '../predictions-engine/schemas/market-prediction.schema';
import { PickCenter } from '../predictions-engine/schemas/pick-center.schema';
import { PredictionSlip } from '../predictions-engine/schemas/prediction-slip.schema';
import { CuratedPrediction } from '../predictions-engine/schemas/curated-prediction.schema';
import { SportsDomainReadService } from '../sports/services/sports-domain-read.service';
import { PredictionStatus } from '../predictions-engine/enums/prediction-status.enum';
import { PredictionMarket } from '../predictions-engine/enums/prediction-market.enum';
import { isCanonicalPredictionMarketKey } from '../predictions-engine/catalog/football-market-catalog';
import { PREDICTION_ENGINE_CONFIG } from '../predictions-engine/config/prediction-engine.config';
import { PickStatus } from '../predictions-engine/enums/pick-status.enum';
import { SlipStatus } from '../predictions-engine/enums/slip-status.enum';
import {
  ENABLED_PREDICTION_MARKET_KEYS,
  PREDICTION_ACCESS_CONFIG,
  PREDICTION_MARKET_FAMILY_BY_KEY,
} from './config/prediction-access.config';
import { PredictionAccessPlan } from './enums/prediction-access-plan.enum';
import {
  PredictionProductType,
  SureOddsTier,
} from './enums/prediction-product-type.enum';
import {
  AccessRequestUser,
  PredictionReadFilters,
} from './interfaces/prediction-access.interface';

const SETTLED_OUTCOMES = new Set([
  'WON',
  'LOST',
  'VOID',
  'PUSH',
  'HALF_WON',
  'HALF_LOST',
]);
const REGISTERED_PLAN_VALUES = new Set(['free', 'regular', 'vip', 'premium']);

type DailyLeagueAccessAllocation = {
  scope: 'PICK_CENTER' | 'CURATED';
  percentage: number;
  totalByDate: Map<string, Set<string>>;
  accessibleByDate: Map<string, Set<string>>;
};

function aggregateSlipSettlement(
  outcomes: string[],
): 'PENDING' | 'WON' | 'LOST' | 'VOID' | 'PUSH' | 'HALF_WON' | 'HALF_LOST' {
  if (!outcomes.length) return 'PENDING';
  const normalized = outcomes.map((value) =>
    String(value ?? 'PENDING').toUpperCase(),
  );
  if (normalized.includes('LOST')) return 'LOST';
  const known = new Set(['WON', 'VOID', 'PUSH', 'HALF_WON', 'HALF_LOST']);
  if (normalized.some((value) => !known.has(value))) return 'PENDING';
  if (normalized.includes('HALF_LOST')) return 'HALF_LOST';
  if (normalized.includes('HALF_WON')) return 'HALF_WON';
  if (normalized.every((value) => value === 'VOID')) return 'VOID';
  if (normalized.every((value) => value === 'VOID' || value === 'PUSH'))
    return 'PUSH';
  return 'WON';
}

@Injectable()
export class PredictionAccessService {
  constructor(
    @InjectModel(MarketPrediction.name)
    private readonly marketPredictionModel: Model<MarketPrediction>,
    @InjectModel(PickCenter.name)
    private readonly pickCenterModel: Model<PickCenter>,
    @InjectModel(PredictionSlip.name)
    private readonly slipModel: Model<PredictionSlip>,
    @InjectModel(CuratedPrediction.name)
    private readonly curatedPredictionModel: Model<CuratedPrediction>,
    private readonly sportsRead: SportsDomainReadService,
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Policy / subscription resolution
  // ---------------------------------------------------------------------------

  async getAccessPlan(
    user?: AccessRequestUser | null,
  ): Promise<PredictionAccessPlan> {
    const userId = this.getUserId(user);
    if (!userId) return PredictionAccessPlan.ANONYMOUS;

    const subscriptionPlan =
      await this.subscriptionsService.getUserPlan(userId);
    const normalized = String(subscriptionPlan ?? 'free').toLowerCase();
    return REGISTERED_PLAN_VALUES.has(normalized)
      ? (normalized as PredictionAccessPlan)
      : PredictionAccessPlan.FREE;
  }

  getPolicy(): Record<string, unknown> {
    const tierPolicy = (plan: PredictionAccessPlan) => ({
      settledPredictionHistory: true,
      browseFixturesAndLeagues: true,
      activePickCenter: {
        leagueAccessPercentage: PREDICTION_ACCESS_CONFIG.leagueVisibility[plan],
        allocationBasis:
          'DISTINCT_LEAGUES_WITH_ACTIVE_PREDICTIONS_PER_LAGOS_DATE',
        mode: 'DAILY_ACTIVE_LEAGUE_ALLOCATION',
        marketAccess: this.getMarketAccessSummary(plan),
      },
      curatedPredictionCenter: {
        allowed: PREDICTION_ACCESS_CONFIG.curatedLeagueVisibility[plan] > 0,
        settledPublic: true,
        leagueAccessPercentage:
          PREDICTION_ACCESS_CONFIG.curatedLeagueVisibility[plan],
        mode:
          PREDICTION_ACCESS_CONFIG.curatedLeagueVisibility[plan] === 0
            ? 'LOCKED_ACTIVE_PREDICTIONS_COUNTS_ONLY'
            : 'DAILY_ACTIVE_LEAGUE_ALLOCATION',
      },
      slipProducts:
        plan === PredictionAccessPlan.PREMIUM
          ? ['ODDS_10', 'ODDS_25', 'ODDS_50']
          : [],
      sureOdds:
        plan === PredictionAccessPlan.REGULAR
          ? ['SURE_2']
          : plan === PredictionAccessPlan.VIP ||
              plan === PredictionAccessPlan.PREMIUM
            ? ['SURE_2', 'SURE_5', 'SURE_7']
            : [],
      marketAccess: this.getMarketAccessSummary(plan),
    });

    return {
      ...PREDICTION_ACCESS_CONFIG,
      rules: {
        anonymous: tierPolicy(PredictionAccessPlan.ANONYMOUS),
        free: tierPolicy(PredictionAccessPlan.FREE),
        regular: tierPolicy(PredictionAccessPlan.REGULAR),
        vip: tierPolicy(PredictionAccessPlan.VIP),
        premium: tierPolicy(PredictionAccessPlan.PREMIUM),
        settledPredictionAccess: {
          public: true,
          sources: ['CURATED_PREDICTIONS', 'PICK_CENTER', 'MARKET_PREDICTIONS'],
          appliesTo: ['WON', 'LOST', 'VOID', 'PUSH', 'HALF_WON', 'HALF_LOST'],
        },
        slipAccess: {
          settledSlipsAreNotPublicBypass: true,
          contentsRequireProductEntitlement: true,
        },
        settlement: {
          selectionBySelection: true,
          matchLostWhenAnySelectionLost: true,
          slipLostWhenAnySelectionLost: true,
        },
      },
    };
  }

  async listCuratedPredictions(
    user?: AccessRequestUser | null,
    input: {
      from?: string;
      to?: string;
      page?: number;
      pageSize?: number;
      league?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const plan = await this.getAccessPlan(user);
    const pageInfo = this.pagination(input.page, input.pageSize, 20, 100);
    // Calculate the denominator before applying a league filter. The daily
    // population must include every active curated league for each requested date.
    const allocationRecords = await this.getCuratedRecordsForInput({
      from: input.from,
      to: input.to,
    });
    const records = this.filterCuratedRecordsByInput(allocationRecords, input);
    const active = records.filter((record) =>
      this.isCurrentPublishedCurated(record),
    );
    const settled = records.filter((record) => this.isCuratedSettled(record));
    const activeAllocationRecords = allocationRecords.filter((record) =>
      this.isCurrentPublishedCurated(record),
    );
    const curatedAllocation = this.buildCuratedLeagueAccessAllocation(
      activeAllocationRecords,
      plan,
    );
    const visibleActive = active
      .map((record) =>
        this.filterCuratedRecordForPlan(plan, record, curatedAllocation),
      )
      .filter((record): record is Record<string, any> => Boolean(record));
    const visible = [...visibleActive, ...settled].sort(
      (a, b) => this.curatedFixtureTime(a) - this.curatedFixtureTime(b),
    );
    const total = visible.length;
    const items = visible.slice(
      (pageInfo.page - 1) * pageInfo.pageSize,
      pageInfo.page * pageInfo.pageSize,
    );
    const leagueSummary = await this.buildCuratedLeagueSummary(
      active,
      plan,
      curatedAllocation,
    );

    return {
      items,
      pagination: {
        ...pageInfo,
        total,
        pages: Math.ceil(total / pageInfo.pageSize),
      },
      leagueSummary,
      accessPlan: plan,
      marketAccess: this.getMarketAccessSummary(plan),
      leagueAccess: this.getDailyLeagueAccessSummary(curatedAllocation),
      ...(plan === PredictionAccessPlan.ANONYMOUS ||
      plan === PredictionAccessPlan.FREE
        ? {
            activePredictionsLocked: true,
            message:
              'Published curated predictions are listed with counts. A qualifying subscription is required to view their selections.',
          }
        : {}),
    };
  }

  /**
   * Backwards-compatible route alias. Predictions now come from the Prediction
   * Engine Pick Center collection; this service intentionally does not read a
   * separate legacy `Prediction` model or collection.
   */
  /** Legacy Prediction Center route now returns the curated, endorsed prediction collection. */
  async listManualPredictions(
    user: AccessRequestUser | null | undefined,
    input: { league?: string; page?: number; pageSize?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.listCuratedPredictions(user, {
      page: input.page,
      pageSize: input.pageSize,
      league: input.league,
    });
  }

  async getManualPrediction(
    user: AccessRequestUser | null | undefined,
    predictionId: string,
  ): Promise<Record<string, unknown>> {
    const normalized = String(predictionId ?? '').trim();
    if (!normalized) throw new BadRequestException('predictionId is required.');
    const plan = await this.getAccessPlan(user);

    const alternatives: Record<string, any>[] = [
      { predictionCode: normalized },
    ];
    if (Types.ObjectId.isValid(normalized))
      alternatives.push({ _id: normalized });
    const prediction = (await this.curatedPredictionModel
      .findOne({ $or: alternatives, status: { $in: ['PUBLISHED', 'SETTLED'] } })
      .lean()
      .exec()) as any;
    if (!prediction) throw new NotFoundException('Prediction was not found.');

    const visibleRecords = await this.getVisibleCuratedRecords(plan, {
      predictionId: String(prediction._id),
    });
    const visiblePrediction = visibleRecords.find(
      (record: any) => String(record._id) === String(prediction._id),
    );
    if (!visiblePrediction) {
      throw new NotFoundException('Prediction was not found.');
    }
    // Return the filtered object, not the original database document. This
    // prevents a detail read from bypassing per-selection Curated entitlements.
    return {
      ...visiblePrediction,
      accessPlan: plan,
      marketAccess: this.getMarketAccessSummary(plan),
    };
  }

  // ---------------------------------------------------------------------------
  // Pick Center / automatic market predictions
  // ---------------------------------------------------------------------------

  async listMarkets(
    input: PredictionReadFilters = {},
    user?: AccessRequestUser | null,
  ): Promise<Record<string, unknown>> {
    const plan = await this.getAccessPlan(user);
    const pageInfo = this.pagination(
      input.page,
      input.pageSize,
      PREDICTION_ACCESS_CONFIG.marketPageSize,
      PREDICTION_ACCESS_CONFIG.maximumMarketPageSize,
    );
    this.validateActiveReadFilters(input);
    const marketAccess = this.getMarketAccessSummary(plan);

    // When a fixture/league filter is supplied, calculate the daily denominator
    // from the complete date scope, not from the filtered result. Otherwise a
    // one-league detail query would incorrectly grant access to every tier.
    const queryRecords = await this.findPickCenterRecords(
      input,
      input.includePast === true,
    );
    const allocationRecords =
      input.eventId?.trim() || input.leagueId?.trim()
        ? await this.findPickCenterRecords(
            { from: input.from, to: input.to },
            input.includePast === true,
          )
        : queryRecords;
    const [allPicks, allocationPicks] = await Promise.all([
      this.enrichPickCenterRecords(queryRecords),
      allocationRecords === queryRecords
        ? Promise.resolve(queryRecords)
        : this.enrichPickCenterRecords(allocationRecords),
    ]);
    const leagueAllocation = this.buildPickCenterLeagueAccessAllocation(
      allocationPicks,
      plan,
    );
    const picks = allPicks.filter((pick: any) =>
      this.canAccessActiveLeague(
        pick.leagueId,
        pick.fixtureDate,
        leagueAllocation,
      ),
    );
    const allowedEventIds = [
      ...new Set(picks.map((pick: any) => String(pick.eventId))),
    ];

    if (!allowedEventIds.length) {
      return {
        items: [],
        pagination: { ...pageInfo, total: 0, pages: 0 },
        accessPlan: plan,
        marketAccess,
        leagueAccess: this.getDailyLeagueAccessSummary(leagueAllocation),
      };
    }

    const marketQuery: Record<string, any> = {
      eventId: { $in: allowedEventIds },
      status: PredictionStatus.CALCULATED,
    };
    if (input.eventId?.trim()) marketQuery.eventId = input.eventId.trim();
    if (input.leagueId?.trim())
      marketQuery.leagueId = input.leagueId.trim().toLowerCase();
    if (input.marketKey?.trim()) {
      const requestedMarketKey = input.marketKey.trim().toUpperCase();
      if (!isCanonicalPredictionMarketKey(requestedMarketKey)) {
        throw new BadRequestException(
          `Unknown marketKey "${input.marketKey}".`,
        );
      }
      if (!ENABLED_PREDICTION_MARKET_KEYS.includes(requestedMarketKey)) {
        return {
          items: [],
          pagination: { ...pageInfo, total: 0, pages: 0 },
          accessPlan: plan,
          marketAccess,
          leagueAccess: this.getDailyLeagueAccessSummary(leagueAllocation),
          requestedMarketUnavailable: true,
        };
      }
      if (!this.canAccessActiveMarket(plan, requestedMarketKey)) {
        return {
          items: [],
          pagination: { ...pageInfo, total: 0, pages: 0 },
          accessPlan: plan,
          marketAccess,
          leagueAccess: this.getDailyLeagueAccessSummary(leagueAllocation),
          requestedMarketLocked: true,
        };
      }
      marketQuery.marketKey = requestedMarketKey;
    }
    if (
      input.minimumProbability !== undefined ||
      input.minimumConfidence !== undefined ||
      input.selectionKey?.trim()
    ) {
      const selectionMatch: Record<string, any> = {
        status: PredictionStatus.CALCULATED,
      };
      if (input.selectionKey?.trim())
        selectionMatch.key = input.selectionKey.trim();
      if (input.minimumProbability !== undefined) {
        const probability = Number(input.minimumProbability);
        if (
          !Number.isFinite(probability) ||
          probability < 0 ||
          probability > 1
        ) {
          throw new BadRequestException(
            'minimumProbability must be between 0 and 1.',
          );
        }
        selectionMatch.probability = { $gte: probability };
      }
      if (input.minimumConfidence !== undefined) {
        const confidence = Number(input.minimumConfidence);
        if (
          !Number.isFinite(confidence) ||
          confidence < 0 ||
          confidence > PREDICTION_ENGINE_CONFIG.model.maximumConfidence
        ) {
          throw new BadRequestException(
            `minimumConfidence must be between 0 and ${PREDICTION_ENGINE_CONFIG.model.maximumConfidence}.`,
          );
        }
        selectionMatch.confidence = { $gte: confidence };
      }
      marketQuery.selections = { $elemMatch: selectionMatch };
    }
    this.applyDateRange(
      marketQuery,
      'fixtureDate',
      input.from,
      input.to,
      input.includePast === true,
    );

    const rawMarkets: any[] = await this.marketPredictionModel
      .find(marketQuery)
      .sort({ fixtureDate: 1, marketName: 1 })
      .limit(100000)
      .lean()
      .exec();
    const picksByEvent = new Map(
      picks.map((pick: any) => [String(pick.eventId), pick]),
    );
    const visible = rawMarkets
      .map((market) =>
        this.filterActiveMarket(
          market,
          picksByEvent.get(String(market.eventId)),
          plan,
          input,
        ),
      )
      .filter((market): market is Record<string, any> => Boolean(market));
    const total = visible.length;
    return {
      items: visible.slice(
        (pageInfo.page - 1) * pageInfo.pageSize,
        pageInfo.page * pageInfo.pageSize,
      ),
      pagination: {
        ...pageInfo,
        total,
        pages: Math.ceil(total / pageInfo.pageSize),
      },
      accessPlan: plan,
      marketAccess,
      leagueAccess: this.getDailyLeagueAccessSummary(leagueAllocation),
    };
  }

  async getFixtureMarkets(
    eventId: string,
    user?: AccessRequestUser | null,
  ): Promise<Record<string, unknown>[]> {
    const normalizedEventId = String(eventId ?? '').trim();
    if (!normalizedEventId)
      throw new BadRequestException('eventId is required.');
    const result = await this.listMarkets(
      { eventId: normalizedEventId, page: 1, pageSize: 100 },
      user,
    );
    const activeItems = result.items as Record<string, unknown>[];
    if (activeItems.length) return activeItems;

    const settled = await this.listSettledMarkets(
      { eventId: normalizedEventId, page: 1, pageSize: 100 },
      user,
    );
    const settledItems = settled.items as Record<string, unknown>[];
    if (settledItems.length) return settledItems;
    throw new NotFoundException(
      `No accessible market predictions were found for event ${normalizedEventId}.`,
    );
  }

  async listPickCenter(
    input: PredictionReadFilters = {},
    user?: AccessRequestUser | null,
  ): Promise<Record<string, unknown>> {
    const plan = await this.getAccessPlan(user);
    const pageInfo = this.pagination(input.page, input.pageSize, 25, 100);
    this.validateActiveReadFilters(input);
    const settledOnly = input.settledOnly === true;

    // Both views are built from the Pick Center fixture record. The settled
    // view widens the time query to include completed fixtures but remains
    // strictly bounded by the requested from/to calendar range.
    const sourceRecords = settledOnly
      ? await this.findPickCenterRecords(input, true)
      : await this.findPickCenterRecords(input, input.includePast === true);
    const historicalRecords =
      !settledOnly && input.includePast !== true
        ? (await this.findPickCenterRecords(input, true, -1)).filter(
            (pick: any) => {
              const fixtureTime = new Date(pick.fixtureDate ?? '').getTime();
              return Number.isFinite(fixtureTime) && fixtureTime < Date.now();
            },
          )
        : [];

    const recordsByEvent = new Map<string, any>();
    for (const pick of [...sourceRecords, ...historicalRecords]) {
      recordsByEvent.set(String(pick.eventId), pick);
    }

    const enriched = await this.enrichPickCenterRecords([
      ...recordsByEvent.values(),
    ]);
    const allocationRecords =
      !settledOnly && (input.eventId?.trim() || input.leagueId?.trim())
        ? await this.findPickCenterRecords(
            { from: input.from, to: input.to },
            input.includePast === true,
          )
        : [...recordsByEvent.values()];
    const leagueAllocation = settledOnly
      ? null
      : this.buildPickCenterLeagueAccessAllocation(allocationRecords, plan);
    const visible: Record<string, any>[] = [];

    for (const pick of enriched) {
      const selectedMarkets = this.oneSelectionPerMarket(
        Array.isArray(pick.selectedMarkets) ? pick.selectedMarkets : [],
      );
      const targetSelections = selectedMarkets.filter((selection: any) => {
        const outcome = String(
          selection.actualOutcome ?? selection.settlementStatus ?? 'PENDING',
        ).toUpperCase();
        const isSettled = SETTLED_OUTCOMES.has(outcome);
        return settledOnly ? isSettled : !isSettled;
      });
      if (!targetSelections.length) continue;

      const leagueId = String(pick.leagueId ?? '')
        .trim()
        .toLowerCase();
      if (settledOnly) {
        // Settled Pick Center outcomes are public at every subscription level.
        // Keep the fixture and its original selected-market records intact so
        // the frontend can render the same card and full right-hand breakdown.
        visible.push({
          ...pick,
          selectedMarkets: targetSelections,
          visibleMarketCount: targetSelections.length,
          settled: true,
          access: {
            allowed: true,
            plan,
            leagueId,
            marketLimit: null,
            mode: 'SETTLED_PUBLIC',
          },
        });
        continue;
      }

      const activeLeagueAllowed = this.canAccessActiveLeague(
        leagueId,
        pick.fixtureDate,
        leagueAllocation!,
      );
      if (!activeLeagueAllowed) continue;
      const filteredPick = this.filterPickCenter(
        {
          ...pick,
          selectedMarkets: targetSelections,
          visibleMarketCount: targetSelections.length,
        },
        plan,
      );
      if ((filteredPick.selectedMarkets as any[]).length > 0) {
        visible.push(filteredPick);
      }
    }

    const total = visible.length;
    const pageItems = visible.slice(
      (pageInfo.page - 1) * pageInfo.pageSize,
      pageInfo.page * pageInfo.pageSize,
    );
    // Counts are derived from every Pick Center fixture in the selected date
    // range, before entitlement filtering. Settled outcomes are public; active
    // restricted competitions expose counts and lock state only.
    const leagueSummary =
      pageInfo.page === 1
        ? await this.buildPickCenterLeagueSummary(
            settledOnly ? enriched : allocationRecords,
            plan,
            settledOnly,
            leagueAllocation ?? undefined,
          )
        : undefined;

    return {
      items: pageItems,
      pagination: {
        ...pageInfo,
        total,
        pages: Math.ceil(total / pageInfo.pageSize),
      },
      ...(leagueSummary ? { leagueSummary } : {}),
      accessPlan: plan,
      marketAccess: settledOnly
        ? {
            mode: 'SETTLED_PUBLIC',
            marketLimit: null,
            allSettledMarketsPublic: true,
          }
        : this.getMarketAccessSummary(plan),
      leagueAccess: settledOnly
        ? { mode: 'SETTLED_PUBLIC', percentage: 100 }
        : this.getDailyLeagueAccessSummary(leagueAllocation!),
    };
  }

  /**
   * Date-scoped Pick Center league counts for the public country selector.
   * Restricted active leagues remain represented with counts and a lock flag.
   * Settled Pick Center predictions are public and therefore are not locked.
   */
  private async buildPickCenterLeagueSummary(
    records: any[],
    plan: PredictionAccessPlan,
    settledOnly = false,
    allocation?: DailyLeagueAccessAllocation,
  ): Promise<Record<string, any>> {
    const eligibleRecords = (records ?? []).filter((record) => {
      if (
        !String(record?.eventId ?? '').trim() ||
        !String(record?.leagueId ?? '').trim() ||
        !Array.isArray(record?.selectedMarkets)
      )
        return false;
      return record.selectedMarkets.some((selection: any) =>
        settledOnly
          ? this.isSelectionSettled(selection)
          : this.isActivePredictionSelection(selection),
      );
    });

    if (!eligibleRecords.length) {
      return {
        countries: [],
        totalLeagues: 0,
        totalPredictions: 0,
        access: settledOnly
          ? { mode: 'SETTLED_PUBLIC', percentage: 100 }
          : this.getDailyLeagueAccessSummary(
              allocation ??
                this.buildPickCenterLeagueAccessAllocation([], plan),
            ),
      };
    }

    const leagueAllocation = settledOnly
      ? null
      : (allocation ??
        this.buildPickCenterLeagueAccessAllocation(eligibleRecords, plan));
    const leagueIds = [
      ...new Set(
        eligibleRecords
          .map((record) =>
            String(record.leagueId ?? '')
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean),
      ),
    ];
    const leagueMap = await this.getSportsCompetitionMap(leagueIds);
    const countryMap = new Map<string, Map<string, any>>();

    for (const record of eligibleRecords) {
      const eventId = String(record.eventId);
      const leagueId = String(record.leagueId ?? '')
        .trim()
        .toLowerCase();
      const league = leagueMap.get(leagueId) ?? {};
      const rawLeagueName = String(record.leagueName ?? '').trim();
      const leagueName = this.resolveLeagueDisplayName(league, leagueId);
      const displayName =
        leagueName !== 'League name unavailable'
          ? leagueName
          : rawLeagueName && !this.isLeagueCode(rawLeagueName, leagueId)
            ? rawLeagueName
            : 'Football competition';
      const region = String(league.region ?? '').toUpperCase();
      const type = String(league.type ?? '').toUpperCase();
      const country = String(
        league.country ?? record.country ?? record.countryName ?? '',
      ).trim();
      const countryName = this.predictionCountryGroup(region, type, country);
      const dateKey = this.getLagosDateKey(record.fixtureDate);
      const accessible =
        settledOnly ||
        this.canAccessActiveLeague(
          leagueId,
          record.fixtureDate,
          leagueAllocation!,
        );

      if (!countryMap.has(countryName)) countryMap.set(countryName, new Map());
      const countryLeagues = countryMap.get(countryName)!;
      const current = countryLeagues.get(leagueId);
      if (current) {
        current.eventIds.add(eventId);
        if (accessible) current.accessibleEventIds.add(eventId);
        else current.lockedEventIds.add(eventId);
        if (dateKey) current.dateKeys.add(dateKey);
      } else {
        countryLeagues.set(leagueId, {
          id: leagueId,
          name: displayName,
          logo: this.logoUrl(league.logo),
          eventIds: new Set([eventId]),
          accessibleEventIds: new Set(accessible ? [eventId] : []),
          lockedEventIds: new Set(accessible ? [] : [eventId]),
          dateKeys: new Set(dateKey ? [dateKey] : []),
        });
      }
    }

    const countries = [...countryMap.entries()]
      .map(([name, leaguesForCountry]) => {
        const leagues = [...leaguesForCountry.values()]
          .map((league) => ({
            id: league.id,
            name: league.name,
            logo: league.logo,
            count: league.eventIds.size,
            accessiblePredictionCount: league.accessibleEventIds.size,
            lockedPredictionCount: league.lockedEventIds.size,
            dateCount: league.dateKeys.size,
            locked: league.accessibleEventIds.size === 0,
            partiallyLocked:
              league.accessibleEventIds.size > 0 &&
              league.lockedEventIds.size > 0,
            requiredPlan:
              league.accessibleEventIds.size === 0 && !settledOnly
                ? this.nextRequiredPlan(plan)
                : null,
          }))
          .filter((league) => league.count > 0)
          .sort((a, b) => a.name.localeCompare(b.name));
        const lockedLeagueCount = leagues.filter(
          (league) => league.locked,
        ).length;
        return {
          name,
          count: leagues.reduce((sum, league) => sum + league.count, 0),
          predictionLeagueCount: leagues.length,
          locked: leagues.length > 0 && lockedLeagueCount === leagues.length,
          lockedLeagueCount,
          requiredPlan:
            lockedLeagueCount > 0 && !settledOnly
              ? this.nextRequiredPlan(plan)
              : null,
          leagues,
        };
      })
      .filter((country) => country.leagues.length > 0)
      .sort((a, b) => {
        const rank = (name: string) =>
          name === 'International' ? 0 : name === 'Regional' ? 1 : 2;
        return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
      });

    return {
      countries,
      totalLeagues: countries.reduce(
        (sum, country) => sum + country.predictionLeagueCount,
        0,
      ),
      totalPredictions: countries.reduce(
        (sum, country) => sum + country.count,
        0,
      ),
      access: settledOnly
        ? { mode: 'SETTLED_PUBLIC', percentage: 100 }
        : this.getDailyLeagueAccessSummary(leagueAllocation!),
    };
  }

  /** Admin-only read: bypasses subscription league and ranked-market limits. */
  async listPickCenterAdmin(
    input: PredictionReadFilters = {},
  ): Promise<Record<string, unknown>> {
    const pageInfo = this.pagination(input.page, input.pageSize, 100, 500);
    const query: Record<string, any> = { status: PickStatus.SELECTED };
    if (input.eventId?.trim()) query.eventId = input.eventId.trim();
    if (input.leagueId?.trim())
      query.leagueId = input.leagueId.trim().toLowerCase();
    this.applyDateRange(
      query,
      'fixtureDate',
      input.from,
      input.to,
      input.includePast === true,
    );
    const [records, total] = await Promise.all([
      this.pickCenterModel
        .find(query)
        .sort({ fixtureDate: 1 })
        .skip((pageInfo.page - 1) * pageInfo.pageSize)
        .limit(pageInfo.pageSize)
        .lean()
        .exec() as Promise<any[]>,
      this.pickCenterModel.countDocuments(query).exec(),
    ]);
    return {
      items: await this.enrichPickCenterRecords(
        records.map((pick) => ({
          ...pick,
          visibleMarketCount: Array.isArray(pick.selectedMarkets)
            ? pick.selectedMarkets.length
            : 0,
          access: {
            allowed: true,
            plan: 'admin',
            marketLimit: null,
          },
        })),
      ),
      pagination: {
        ...pageInfo,
        total,
        pages: Math.ceil(total / pageInfo.pageSize),
      },
      accessPlan: 'admin',
    };
  }

  async getPickCenter(
    eventId: string,
    user?: AccessRequestUser | null,
  ): Promise<Record<string, unknown>> {
    const normalized = String(eventId ?? '').trim();
    if (!normalized) throw new BadRequestException('eventId is required.');
    const plan = await this.getAccessPlan(user);
    const pick: any = await this.pickCenterModel
      .findOne({ eventId: normalized, status: PickStatus.SELECTED })
      .lean()
      .exec();
    if (!pick) throw new NotFoundException('Pick Center record was not found.');

    const sourceSelections = this.oneSelectionPerMarket(
      Array.isArray(pick.selectedMarkets) ? pick.selectedMarkets : [],
    );
    const settledMarkets = sourceSelections.filter((selection: any) =>
      SETTLED_OUTCOMES.has(
        String(
          selection.actualOutcome ?? selection.settlementStatus ?? '',
        ).toUpperCase(),
      ),
    );
    const filtered = this.filterPickCenter(pick, plan);
    const enriched = (await this.enrichPickCenterRecords([filtered]))[0];
    const visibleActiveMarkets = (
      Array.isArray(enriched?.selectedMarkets) ? enriched.selectedMarkets : []
    ).filter(
      (selection: any) =>
        !SETTLED_OUTCOMES.has(
          String(
            selection.actualOutcome ?? selection.settlementStatus ?? '',
          ).toUpperCase(),
        ),
    );
    const fixtureDate = enriched?.fixtureDate ?? pick.fixtureDate;
    const fixtureTime = new Date(fixtureDate ?? '').getTime();
    const activeDateAllowed =
      Number.isFinite(fixtureTime) && fixtureTime >= Date.now();
    const dateKey = this.getLagosDateKey(fixtureDate);
    const dayStart = dateKey
      ? this.parseLagosDate(dateKey, false)
      : new Date(Number.NaN);
    const dayEnd = dateKey
      ? this.parseLagosDate(dateKey, true)
      : new Date(Number.NaN);
    const dayRecords = dateKey
      ? await this.pickCenterModel
          .find({
            status: PickStatus.SELECTED,
            fixtureDate: { $gte: dayStart, $lt: dayEnd },
          })
          .select({
            eventId: 1,
            leagueId: 1,
            fixtureDate: 1,
            selectedMarkets: 1,
          })
          .limit(PREDICTION_ACCESS_CONFIG.maximumPickCenterMatches)
          .lean()
          .exec()
      : [];
    const leagueAllocation = this.buildPickCenterLeagueAccessAllocation(
      dayRecords,
      plan,
    );
    const leagueId = String(pick.leagueId ?? '')
      .trim()
      .toLowerCase();
    const activeLeagueAllowed = this.canAccessActiveLeague(
      leagueId,
      fixtureDate,
      leagueAllocation,
    );

    if (
      activeDateAllowed &&
      activeLeagueAllowed &&
      (visibleActiveMarkets.length > 0 || settledMarkets.length > 0)
    ) {
      // Merge already-resolved outcomes from any market with active picks that
      // this subscription may currently view. Settled outcomes stay public.
      const selectedMarkets = [...settledMarkets, ...visibleActiveMarkets];
      return {
        ...enriched,
        selectedMarkets,
        visibleMarketCount: selectedMarkets.length,
        settledMarketCount: settledMarkets.length,
        access: {
          ...(enriched?.access ?? {}),
          settledOutcomesPublic: true,
        },
      };
    }

    if (settledMarkets.length) {
      return {
        ...enriched,
        selectedMarkets: settledMarkets,
        visibleMarketCount: settledMarkets.length,
        settled: true,
        access: {
          allowed: true,
          plan,
          leagueId,
          marketLimit: null,
          mode: 'SETTLED_PUBLIC',
          settledOutcomesPublic: true,
          allSettledMarketsPublic: true,
        },
      };
    }
    throw new NotFoundException('Pick Center record was not found.');
  }

  // ---------------------------------------------------------------------------
  // Public settled history
  // ---------------------------------------------------------------------------

  async listSettledMarkets(
    input: PredictionReadFilters = {},
    user?: AccessRequestUser | null,
  ): Promise<Record<string, unknown>> {
    const plan = await this.getAccessPlan(user);
    const pageInfo = this.pagination(input.page, input.pageSize, 25, 100);

    if (input.minimumProbability !== undefined) {
      const probability = Number(input.minimumProbability);
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new BadRequestException(
          'minimumProbability must be between 0 and 1.',
        );
      }
    }
    if (input.minimumConfidence !== undefined) {
      const confidence = Number(input.minimumConfidence);
      if (
        !Number.isFinite(confidence) ||
        confidence < 60 ||
        confidence > PREDICTION_ENGINE_CONFIG.model.maximumConfidence
      ) {
        throw new BadRequestException(
          `minimumConfidence must be between 60 and ${PREDICTION_ENGINE_CONFIG.model.maximumConfidence}.`,
        );
      }
    }
    const requestedMarketKey = input.marketKey?.trim().toUpperCase();
    if (
      requestedMarketKey &&
      !Object.values(PredictionMarket).includes(
        requestedMarketKey as PredictionMarket,
      )
    ) {
      throw new BadRequestException(`Unknown marketKey "${input.marketKey}".`);
    }

    // Build the settled history from the selections that were actually
    // published, not every possible outcome stored in a MarketPrediction.
    // A Pick Center row may hold up to its selected market set; Curated
    // Predictions contribute their own saved selection snapshots as well.
    const pickQuery: Record<string, any> = {};
    if (input.eventId?.trim()) pickQuery.eventId = input.eventId.trim();
    if (input.leagueId?.trim())
      pickQuery.leagueId = input.leagueId.trim().toLowerCase();
    this.applyDateRange(pickQuery, 'fixtureDate', input.from, input.to, true);

    const pickRecords = (await this.pickCenterModel
      .find(pickQuery)
      .sort({ fixtureDate: -1 })
      .limit(PREDICTION_ACCESS_CONFIG.maximumPickCenterMatches)
      .select('eventId selectedMarkets')
      .lean()
      .exec()) as any[];

    const curatedQuery: Record<string, any> = {
      status: { $in: ['PUBLISHED', 'SETTLED'] },
    };
    if (input.eventId?.trim())
      curatedQuery['selections.eventId'] = input.eventId.trim();
    if (input.leagueId?.trim())
      curatedQuery['selections.leagueId'] = input.leagueId.trim().toLowerCase();
    this.applyDateRange(
      curatedQuery,
      'selections.fixtureDate',
      input.from,
      input.to,
      true,
    );
    const curatedRecords = (await this.curatedPredictionModel
      .find(curatedQuery)
      .sort({ fixtureDateFrom: -1, updatedAt: -1 })
      .limit(PREDICTION_ACCESS_CONFIG.maximumPickCenterMatches)
      .select('selections')
      .lean()
      .exec()) as any[];

    const approvedSelections = new Map<string, any>();
    const addApprovedSelection = (eventIdValue: unknown, selection: any) => {
      const eventId = String(eventIdValue ?? '').trim();
      const marketPredictionId = String(
        selection?.marketPredictionId ?? '',
      ).trim();
      const selectionKey = String(selection?.selectionKey ?? '').trim();
      const marketKey = String(selection?.marketKey ?? '').trim();
      if (!eventId || !marketPredictionId || !selectionKey) return;
      if (
        input.selectionKey?.trim() &&
        selectionKey !== input.selectionKey.trim()
      )
        return;
      if (requestedMarketKey && marketKey.toUpperCase() !== requestedMarketKey)
        return;

      const probability = Number(selection?.probability);
      if (
        input.minimumProbability !== undefined &&
        (!Number.isFinite(probability) ||
          probability < Number(input.minimumProbability))
      )
        return;
      const confidence = Number(selection?.confidence);
      if (
        input.minimumConfidence !== undefined &&
        (!Number.isFinite(confidence) ||
          confidence < Number(input.minimumConfidence))
      )
        return;

      approvedSelections.set(
        `${eventId}::${marketPredictionId}::${selectionKey}`,
        selection,
      );
    };

    for (const pick of pickRecords) {
      for (const selected of pick.selectedMarkets ?? []) {
        addApprovedSelection(pick.eventId, selected);
      }
    }
    for (const curated of curatedRecords) {
      for (const selected of curated.selections ?? []) {
        addApprovedSelection(selected.eventId, selected);
      }
    }

    const marketPredictionIds = [
      ...new Set(
        [...approvedSelections.values()]
          .map((selection) => String(selection.marketPredictionId ?? '').trim())
          .filter(Boolean),
      ),
    ];
    if (!marketPredictionIds.length) {
      return {
        items: [],
        pagination: {
          ...pageInfo,
          total: 0,
          pages: 0,
        },
        accessPlan: plan,
        marketAccess: {
          mode: 'SETTLED_PUBLIC',
          marketLimit: null,
          allSettledMarketsPublic: true,
        },
      };
    }

    const marketQuery: Record<string, any> = {
      _id: { $in: marketPredictionIds },
      selections: {
        $elemMatch: {
          actualOutcome: { $in: Array.from(SETTLED_OUTCOMES) },
        },
      },
    };
    if (input.eventId?.trim()) marketQuery.eventId = input.eventId.trim();
    if (input.leagueId?.trim())
      marketQuery.leagueId = input.leagueId.trim().toLowerCase();
    if (requestedMarketKey) marketQuery.marketKey = requestedMarketKey;
    this.applyDateRange(marketQuery, 'fixtureDate', input.from, input.to, true);

    const engineMarkets = (await this.marketPredictionModel
      .find(marketQuery)
      .select(
        'eventId leagueId fixtureDate homeTeamName awayTeamName marketKey marketName selections',
      )
      .sort({ fixtureDate: -1, marketName: 1 })
      .lean()
      .exec()) as any[];

    const rawItems = engineMarkets
      .map((market) => {
        const eventId = String(market.eventId ?? '');
        const marketPredictionId = String(market._id ?? '');
        const selections = (market.selections ?? [])
          .filter((selection: any) => {
            const key = `${eventId}::${marketPredictionId}::${String(selection.key ?? '')}`;
            return (
              SETTLED_OUTCOMES.has(
                String(selection.actualOutcome ?? '').toUpperCase(),
              ) && approvedSelections.has(key)
            );
          })
          .map((selection: any) => {
            const selectionKey = String(selection.key ?? '');
            const snapshot =
              approvedSelections.get(
                `${eventId}::${marketPredictionId}::${selectionKey}`,
              ) ?? {};
            const outcome = String(selection.actualOutcome ?? '').toUpperCase();
            return {
              ...selection,
              ...snapshot,
              marketPredictionId,
              marketKey: String(market.marketKey ?? snapshot.marketKey ?? ''),
              marketName: String(
                market.marketName ?? snapshot.marketName ?? 'Market',
              ),
              selectionKey,
              selectionName: String(
                snapshot.selectionName ??
                  selection.fullName ??
                  selection.abbreviation ??
                  selectionKey,
              ),
              actualOutcome: outcome,
              settlementStatus: outcome,
            };
          });
        return {
          ...market,
          source: 'prediction-engine',
          selections,
          settled: selections.length > 0,
        };
      })
      .filter((market) => market.selections.length > 0);

    const total = rawItems.length;
    const pageItems = rawItems.slice(
      (pageInfo.page - 1) * pageInfo.pageSize,
      pageInfo.page * pageInfo.pageSize,
    );
    const fixtureMeta = await this.getFixturePresentationMap([
      ...new Set(
        pageItems.map((market) => String(market.eventId ?? '')).filter(Boolean),
      ),
    ]);
    const items = pageItems.map((market) => ({
      ...market,
      ...(fixtureMeta.get(String(market.eventId)) ?? {}),
    }));

    return {
      items,
      pagination: {
        ...pageInfo,
        total,
        pages: Math.ceil(total / pageInfo.pageSize),
      },
      accessPlan: plan,
      marketAccess: {
        mode: 'SETTLED_PUBLIC',
        marketLimit: null,
        allSettledMarketsPublic: true,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Slip Center / Sure Odds
  // ---------------------------------------------------------------------------

  async listSlips(
    input: {
      from?: string;
      to?: string;
      productType?: string;
      automatic?: boolean;
      page?: number;
      pageSize?: number;
    } = {},
    user?: AccessRequestUser | null,
  ): Promise<Record<string, unknown>> {
    const requestedType = input.productType?.trim().toUpperCase();
    if (
      requestedType &&
      !Object.values(PredictionProductType).includes(
        requestedType as PredictionProductType,
      )
    ) {
      throw new BadRequestException(
        `Unknown productType "${input.productType}".`,
      );
    }
    if (requestedType === PredictionProductType.SURE_ODDS) {
      return this.listSureOdds(input, user);
    }

    const plan = await this.getAccessPlan(user);
    const pageInfo = this.pagination(input.page, input.pageSize, 20, 100);
    const query: Record<string, any> = { status: SlipStatus.PUBLISHED };
    // Public Slip Center exposes only the current product families. Legacy
    // persisted product identifiers remain available to administrative reads.
    query.productType = requestedType ?? {
      $in: Object.keys(PREDICTION_ACCESS_CONFIG.slipProducts),
    };
    this.applyDateRange(query, 'fixtureDateFrom', input.from, input.to, true);

    const slips = (await this.slipModel
      .find(query)
      .sort({ fixtureDateFrom: 1, createdAt: -1 })
      .limit(10000)
      .lean()
      .exec()) as any[];

    const normalized = slips.map((slip) => ({
      ...slip,
      odds: this.numberOrNull(slip.combinedOdds),
      oddsBasis:
        this.numberOrNull(slip.combinedOdds) !== null
          ? (slip.legs ?? []).some((leg: any) => leg.priceType === 'ESTIMATED')
            ? 'ESTIMATED'
            : 'PROVIDER'
          : null,
    }));
    const allowed = normalized.filter((slip) => this.canAccessSlip(plan, slip));
    const enrichedAllowed = await this.enrichSlipRecords(allowed);
    const enrichedById = new Map(
      enrichedAllowed.map((slip: any) => [String(slip._id), slip]),
    );

    const visible = normalized.map((slip) => {
      const full = enrichedById.get(String(slip._id));
      if (full) {
        const requiredPlan = this.slipRequiredPlan(slip);
        return {
          ...full,
          locked: false,
          accessAllowed: true,
          requiredPlan,
          access: { allowed: true, plan, requiredPlan },
        };
      }
      return this.lockedSlipPreview(slip, plan);
    });

    const total = visible.length;
    const pageItems = visible.slice(
      (pageInfo.page - 1) * pageInfo.pageSize,
      pageInfo.page * pageInfo.pageSize,
    );
    return {
      items: pageItems,
      pagination: {
        ...pageInfo,
        total,
        pages: Math.ceil(total / pageInfo.pageSize),
      },
      accessPlan: plan,
      lockedCount: visible.filter((slip: any) => slip.locked).length,
    };
  }

  /** Admin-only read: includes every status and bypasses subscription and Sure Odds quotas. */
  async listSlipsAdmin(
    input: {
      from?: string;
      to?: string;
      productType?: string;
      automatic?: boolean;
      page?: number;
      pageSize?: number;
      status?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const pageInfo = this.pagination(input.page, input.pageSize, 100, 500);
    const query: Record<string, any> = {};
    if (input.productType?.trim())
      query.productType = input.productType.trim().toUpperCase();
    if (input.status?.trim()) query.status = input.status.trim().toUpperCase();
    if (input.automatic !== undefined) query.automatic = input.automatic;
    this.applyDateRange(query, 'fixtureDateFrom', input.from, input.to, true);
    const [records, total] = await Promise.all([
      this.slipModel
        .find(query)
        .sort({ fixtureDateFrom: 1, createdAt: -1 })
        .skip((pageInfo.page - 1) * pageInfo.pageSize)
        .limit(pageInfo.pageSize)
        .lean()
        .exec() as Promise<any[]>,
      this.slipModel.countDocuments(query).exec(),
    ]);
    const normalized = records.map((slip) => ({
      ...slip,
      odds: this.numberOrNull(slip.combinedOdds),
      oddsBasis:
        this.numberOrNull(slip.combinedOdds) !== null
          ? (slip.legs ?? []).some((leg: any) => leg.priceType === 'ESTIMATED')
            ? 'ESTIMATED'
            : 'PROVIDER'
          : null,
    }));
    return {
      items: await this.enrichSlipRecords(normalized),
      pagination: {
        ...pageInfo,
        total,
        pages: Math.ceil(total / pageInfo.pageSize),
      },
      accessPlan: 'admin',
    };
  }

  async getSlip(
    slipId: string,
    user?: AccessRequestUser | null,
  ): Promise<Record<string, unknown>> {
    const normalized = String(slipId ?? '').trim();
    if (!normalized) throw new BadRequestException('slipId is required.');
    const slip = (await this.slipModel
      .findOne({ _id: normalized, status: SlipStatus.PUBLISHED })
      .lean()
      .exec()) as any;
    if (!slip) throw new NotFoundException('Slip was not found.');

    const plan = await this.getAccessPlan(user);
    // Settlement status does not grant public access to a restricted slip.
    if (!this.canAccessSlip(plan, slip)) {
      throw new NotFoundException('Slip was not found.');
    }

    const odds = this.numberOrNull(slip.combinedOdds);
    const enriched = (
      await this.enrichSlipRecords([
        {
          ...slip,
          odds,
          oddsBasis:
            odds !== null
              ? (slip.legs ?? []).some(
                  (leg: any) => leg.priceType === 'ESTIMATED',
                )
                ? 'ESTIMATED'
                : 'PROVIDER'
              : null,
        },
      ])
    )[0];

    return {
      ...enriched,
      accessPlan: plan,
      access: {
        allowed: true,
        plan,
        requiredPlan: this.slipRequiredPlan(slip),
      },
    };
  }

  async listSureOdds(
    input: {
      from?: string;
      to?: string;
      page?: number;
      pageSize?: number;
    } = {},
    user?: AccessRequestUser | null,
  ): Promise<Record<string, unknown>> {
    const plan = await this.getAccessPlan(user);
    const pageInfo = this.pagination(input.page, input.pageSize, 20, 100);
    const query: Record<string, any> = {
      status: SlipStatus.PUBLISHED,
      productType: PredictionProductType.SURE_ODDS,
      sureOdds: true,
    };
    this.applyDateRange(query, 'fixtureDateFrom', input.from, input.to, true);

    const slips = (await this.slipModel
      .find(query)
      .sort({ generatedDateKey: -1, createdAt: 1 })
      .limit(10000)
      .lean()
      .exec()) as any[];
    const acceptedByDayAndProduct = new Map<string, number>();
    const accessible: any[] = [];
    const blockedReason = new Map<string, string>();

    for (const slip of slips) {
      const id = String(slip._id);
      if (!this.canAccessSlip(plan, slip)) {
        blockedReason.set(id, 'SUBSCRIPTION_REQUIRED');
        continue;
      }

      const settled = SETTLED_OUTCOMES.has(
        String(slip.settlementStatus ?? '').toUpperCase(),
      );
      if (!settled) {
        const product = String(
          slip.sureOddsProduct ??
            (slip.sureOddsTier === SureOddsTier.VIP ? 'SURE_2' : 'SURE_5'),
        ).toUpperCase();
        if (!['SURE_2', 'SURE_5', 'SURE_7'].includes(product)) {
          blockedReason.set(id, 'PRODUCT_UNAVAILABLE');
          continue;
        }
        const dailyTarget =
          (PREDICTION_ACCESS_CONFIG.sureOdds.products as any)[product]
            ?.dailyTarget ?? 0;
        const day = this.getDateKey(slip);
        const quotaKey = `${day}:${product}`;
        const current = acceptedByDayAndProduct.get(quotaKey) ?? 0;
        if (current >= dailyTarget) {
          blockedReason.set(id, 'DAILY_LIMIT');
          continue;
        }
        acceptedByDayAndProduct.set(quotaKey, current + 1);
      }
      accessible.push(slip);
    }

    const normalized = slips.map((slip) => {
      const odds = this.numberOrNull(slip.combinedOdds);
      return {
        ...slip,
        odds,
        oddsBasis: (slip.legs ?? []).some(
          (leg: any) => leg.priceType === 'ESTIMATED',
        )
          ? 'ESTIMATED'
          : 'PROVIDER',
      };
    });
    const accessibleIds = new Set(accessible.map((slip) => String(slip._id)));
    const enrichedAllowed = await this.enrichSlipRecords(
      normalized.filter((slip) => accessibleIds.has(String(slip._id))),
    );
    const enrichedById = new Map(
      enrichedAllowed.map((slip: any) => [String(slip._id), slip]),
    );

    const items = normalized.map((slip) => {
      const full = enrichedById.get(String(slip._id));
      if (full) {
        const requiredPlan = this.slipRequiredPlan(slip);
        return {
          ...full,
          locked: false,
          accessAllowed: true,
          requiredPlan,
          access: { allowed: true, plan, requiredPlan },
        };
      }
      return this.lockedSlipPreview(
        slip,
        plan,
        blockedReason.get(String(slip._id)) ?? 'SUBSCRIPTION_REQUIRED',
      );
    });

    const total = items.length;
    const start = (pageInfo.page - 1) * pageInfo.pageSize;
    return {
      items: items.slice(start, start + pageInfo.pageSize),
      pagination: {
        ...pageInfo,
        total,
        pages: Math.ceil(total / pageInfo.pageSize),
      },
      accessPlan: plan,
      lockedCount: items.filter((slip: any) => slip.locked).length,
      sureOddsPolicy: PREDICTION_ACCESS_CONFIG.sureOdds,
      dailySelectionTargets: {
        regular: PREDICTION_ACCESS_CONFIG.sureOdds.vipDailyTarget,
        vipAdditional: PREDICTION_ACCESS_CONFIG.sureOdds.premiumDailyTarget,
        premiumTotal:
          PREDICTION_ACCESS_CONFIG.sureOdds.vipDailyTarget +
          PREDICTION_ACCESS_CONFIG.sureOdds.premiumDailyTarget,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Fixture presentation metadata + settlement outcomes for the admin centers
  // ---------------------------------------------------------------------------

  private async enrichPickCenterRecords(records: any[]): Promise<any[]> {
    if (!records.length) return records;
    const eventIds = records
      .map((record) => String(record.eventId))
      .filter(Boolean);
    const fixtureMeta = await this.getFixturePresentationMap(eventIds);
    const marketPredictionIds = [
      ...new Set(
        records.flatMap((record) =>
          (record.selectedMarkets ?? [])
            .map((selection: any) => String(selection.marketPredictionId ?? ''))
            .filter(Boolean),
        ),
      ),
    ];
    const predictionDocs = marketPredictionIds.length
      ? ((await this.marketPredictionModel
          .find({ _id: { $in: marketPredictionIds } })
          .select('_id selections')
          .lean()
          .exec()) as any[])
      : [];
    const outcomes = new Map<string, string>();
    for (const prediction of predictionDocs) {
      for (const selection of prediction.selections ?? []) {
        const outcome = String(selection.actualOutcome ?? '')
          .trim()
          .toUpperCase();
        if (outcome)
          outcomes.set(
            `${String(prediction._id)}::${String(selection.key)}`,
            outcome,
          );
      }
    }
    return records.map((record) => ({
      ...record,
      ...(fixtureMeta.get(String(record.eventId)) ?? {}),
      selectedMarkets: (record.selectedMarkets ?? []).map((selection: any) => {
        const outcome =
          outcomes.get(
            `${String(selection.marketPredictionId)}::${String(selection.selectionKey)}`,
          ) ?? null;
        return {
          ...selection,
          settlementStatus: outcome ?? 'PENDING',
          actualOutcome: outcome,
        };
      }),
    }));
  }

  private async enrichSlipRecords(records: any[]): Promise<any[]> {
    if (!records.length) return records;
    const eventIds = [
      ...new Set(
        records.flatMap((record) =>
          (record.legs ?? [])
            .map((leg: any) => String(leg.eventId))
            .filter(Boolean),
        ),
      ),
    ];
    const marketPredictionIds = [
      ...new Set(
        records.flatMap((record) =>
          (record.legs ?? [])
            .map((leg: any) => String(leg.marketPredictionId ?? ''))
            .filter(Boolean),
        ),
      ),
    ];
    const [fixtureMeta, markets] = await Promise.all([
      this.getFixturePresentationMap(eventIds),
      marketPredictionIds.length
        ? (this.marketPredictionModel
            .find({ _id: { $in: marketPredictionIds } })
            .select('_id marketKey selections')
            .lean()
            .exec() as any)
        : [],
    ]);
    const outcomes = new Map<string, string>();
    const outcomesByMarketKey = new Map<string, string>();
    for (const market of markets as any[]) {
      for (const selection of market.selections ?? []) {
        const outcome = String(selection.actualOutcome ?? '')
          .trim()
          .toUpperCase();
        if (!SETTLED_OUTCOMES.has(outcome)) continue;
        const key = String(selection.key ?? '');
        outcomes.set(`${String(market._id)}::${key}`, outcome);
        outcomesByMarketKey.set(
          `${String(market.marketKey ?? '')}::${key}`,
          outcome,
        );
      }
    }

    return records.map((record) => {
      const legs = (record.legs ?? []).map((leg: any) => ({
        ...leg,
        ...(fixtureMeta.get(String(leg.eventId)) ?? {}),
        settlementOutcome:
          outcomes.get(
            `${String(leg.marketPredictionId)}::${String(leg.selectionKey)}`,
          ) ??
          outcomesByMarketKey.get(
            `${String(leg.marketKey ?? '')}::${String(leg.selectionKey)}`,
          ) ??
          leg.settlementOutcome ??
          'PENDING',
      }));
      const byEvent = new Map<string, any[]>();
      for (const leg of legs) {
        const group = byEvent.get(String(leg.eventId)) ?? [];
        group.push(leg);
        byEvent.set(String(leg.eventId), group);
      }
      for (const group of byEvent.values()) {
        const matchStatus = aggregateSlipSettlement(
          group.map((leg) => String(leg.settlementOutcome ?? 'PENDING')),
        );
        group.forEach((leg) => {
          leg.matchSettlementStatus = matchStatus;
        });
      }
      const settlementStatus = aggregateSlipSettlement(
        legs.map((leg: any) => String(leg.settlementOutcome ?? 'PENDING')),
      );
      return {
        ...record,
        legs,
        settlementStatus,
        settledAt:
          record.settledAt ??
          (settlementStatus === 'PENDING' ? undefined : new Date()),
      };
    });
  }

  private async getFixturePresentationMap(
    eventIds: string[],
  ): Promise<Map<string, Record<string, any>>> {
    const result = new Map<string, Record<string, any>>();
    const uniqueEventIds = [
      ...new Set(eventIds.map((id) => String(id).trim()).filter(Boolean)),
    ];
    if (!uniqueEventIds.length) return result;

    // Fetch only normalized fixture, team, and competition records. Avoid
    // getMatch() here because its richer statistics/lineup/timeline projection
    // is unnecessary for the list presentation and can create avoidable load.
    const fixtures = await this.mapConcurrent(uniqueEventIds, 12, (eventId) =>
      this.sportsRead.getFixture(eventId),
    );
    const validFixtures = fixtures.filter(
      (fixture): fixture is NonNullable<typeof fixture> => Boolean(fixture),
    );
    if (!validFixtures.length) return result;

    const teamIds = [
      ...new Set(
        validFixtures
          .flatMap((fixture) =>
            fixture.competitors.map((competitor) => String(competitor.teamId)),
          )
          .filter(Boolean),
      ),
    ];
    const competitionIds = [
      ...new Set(
        validFixtures
          .map((fixture) => String(fixture.competitionId))
          .filter(Boolean),
      ),
    ];
    const [teamRecords, competitionMap] = await Promise.all([
      this.mapConcurrent(teamIds, 12, (teamId) =>
        this.sportsRead.getTeam(teamId),
      ),
      this.getSportsCompetitionMap(competitionIds),
    ]);
    const teamMap = new Map<string, any>();
    for (const team of teamRecords) {
      if (!team) continue;
      for (const identifier of [team.id, team.espnId]) {
        const key = String(identifier ?? '').trim();
        if (key) teamMap.set(key, team);
      }
    }

    for (let index = 0; index < validFixtures.length; index += 1) {
      const fixture = validFixtures[index];
      const homeId = fixture.competitors.find(
        (item) => item.homeAway === 'HOME',
      )?.teamId;
      const awayId = fixture.competitors.find(
        (item) => item.homeAway === 'AWAY',
      )?.teamId;
      const home = homeId ? teamMap.get(String(homeId)) : null;
      const away = awayId ? teamMap.get(String(awayId)) : null;
      const leagueId = String(fixture.competitionId ?? '').toLowerCase();
      const league = competitionMap.get(leagueId) ?? {};
      const region = String(league.region ?? '').toUpperCase();
      const competitionType = String(league.type ?? '').toUpperCase();
      const country = league.country ?? null;
      const presentation = {
        leagueId,
        leagueName: this.resolveLeagueDisplayName(league, leagueId),
        leagueLogo: this.logoUrl(league.logo),
        country,
        predictionCountryGroup: this.predictionCountryGroup(
          region,
          competitionType,
          String(country ?? ''),
        ),
        competitionRegion: region || null,
        competitionType: competitionType || null,
        homeTeamLogo: this.logoUrl(home?.logo),
        awayTeamLogo: this.logoUrl(away?.logo),
      };
      const requestedId = uniqueEventIds.find(
        (eventId) => eventId === fixture.id || eventId === fixture.espnEventId,
      );
      for (const alias of [requestedId, fixture.id, fixture.espnEventId]) {
        if (alias) result.set(String(alias), presentation);
      }
    }
    return result;
  }

  private async mapConcurrent<T, R>(
    values: T[],
    concurrency: number,
    worker: (value: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    if (!values.length) return [];
    const results = new Array<R>(values.length);
    let nextIndex = 0;
    const workerCount = Math.max(
      1,
      Math.min(values.length, Math.floor(concurrency) || 1),
    );
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= values.length) return;
          results[index] = await worker(values[index], index);
        }
      }),
    );
    return results;
  }

  private async getSportsCompetitionMap(
    competitionIds: string[],
  ): Promise<Map<string, any>> {
    const uniqueIds = [
      ...new Set(competitionIds.map((id) => String(id).trim()).filter(Boolean)),
    ];
    const records = await this.mapConcurrent(uniqueIds, 12, (id) =>
      this.sportsRead.getCompetition(id),
    );
    const result = new Map<string, any>();
    for (const competition of records) {
      if (!competition) continue;
      for (const identifier of [
        competition.id,
        competition.espnId,
        competition.slug,
      ]) {
        const key = String(identifier ?? '')
          .trim()
          .toLowerCase();
        if (key) result.set(key, competition);
      }
    }
    return result;
  }

  private isLeagueCode(value: string, leagueId = ''): boolean {
    const normalized = value.trim();
    return (
      !normalized ||
      normalized.toLowerCase() === leagueId.trim().toLowerCase() ||
      /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/i.test(normalized)
    );
  }

  private resolveLeagueDisplayName(league: any, leagueId: string): string {
    const candidates = [
      league?.displayName,
      league?.fullName,
      league?.payload?.displayName,
      league?.payload?.fullName,
      league?.payload?.name,
      league?.name,
    ];
    for (const candidate of candidates) {
      const value = String(candidate ?? '').trim();
      if (value && !this.isLeagueCode(value, leagueId)) return value;
    }
    return 'League name unavailable';
  }

  private logoUrl(source: any): string | null {
    if (!source) return null;
    if (typeof source === 'string') return source.trim() || null;
    if (Array.isArray(source)) {
      for (const item of source) {
        const found = this.logoUrl(item);
        if (found) return found;
      }
      return null;
    }
    if (typeof source !== 'object') return null;
    for (const key of ['logo', 'href', 'url', 'src']) {
      if (typeof source[key] === 'string' && source[key].trim())
        return source[key].trim();
    }
    for (const key of ['logos', 'images', 'logo', 'payload']) {
      const found = this.logoUrl(source[key]);
      if (found) return found;
    }
    return null;
  }

  private predictionCountryGroup(
    region: string,
    type: string,
    country: string,
  ): string {
    const normalizedRegion = this.normalizeIdentifier(region);
    const normalizedType = this.normalizeIdentifier(type);

    // Keep international competitions grouped separately for presentation.
    // This is a display grouping only and does not grant or restrict access.
    if (normalizedRegion === 'world' || normalizedRegion.includes('world')) {
      return 'International';
    }
    if (
      normalizedType === 'international' ||
      normalizedRegion === 'international'
    ) {
      return 'Regional';
    }
    return country.trim() || 'Other competitions';
  }

  // ---------------------------------------------------------------------------
  // Internal policy helpers
  // ---------------------------------------------------------------------------

  private validateActiveReadFilters(input: PredictionReadFilters): void {
    const requestedMarketKey = input.marketKey?.trim().toUpperCase();
    if (
      requestedMarketKey &&
      !isCanonicalPredictionMarketKey(requestedMarketKey)
    ) {
      throw new BadRequestException(`Unknown marketKey "${input.marketKey}".`);
    }
    if (input.minimumProbability !== undefined) {
      const value = Number(input.minimumProbability);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new BadRequestException(
          'minimumProbability must be between 0 and 1.',
        );
      }
    }
    if (input.minimumConfidence !== undefined) {
      const value = Number(input.minimumConfidence);
      if (
        !Number.isFinite(value) ||
        value < 0 ||
        value > PREDICTION_ENGINE_CONFIG.model.maximumConfidence
      ) {
        throw new BadRequestException(
          `minimumConfidence must be between 0 and ${PREDICTION_ENGINE_CONFIG.model.maximumConfidence}.`,
        );
      }
    }
  }

  private async findPickCenterRecords(
    input: PredictionReadFilters,
    includePast: boolean,
    sortDirection: 1 | -1 = 1,
  ): Promise<any[]> {
    const query: Record<string, any> = { status: PickStatus.SELECTED };
    if (input.eventId?.trim()) query.eventId = input.eventId.trim();
    if (input.leagueId?.trim())
      query.leagueId = input.leagueId.trim().toLowerCase();
    this.applyDateRange(
      query,
      'fixtureDate',
      input.from,
      input.to,
      includePast,
    );
    return this.pickCenterModel
      .find(query)
      .sort({ fixtureDate: sortDirection })
      .limit(PREDICTION_ACCESS_CONFIG.maximumPickCenterMatches)
      .lean()
      .exec() as Promise<any[]>;
  }

  private filterActiveMarket(
    market: any,
    pick: any,
    plan: PredictionAccessPlan,
    input: PredictionReadFilters,
  ): Record<string, any> | null {
    if (!pick || !Array.isArray(market.selections)) return null;
    if (
      !this.canAccessActiveMarket(plan, String(market.marketKey ?? '').trim())
    )
      return null;
    const visibleRankedMarkets = this.filterPickCenter(pick, plan)
      .selectedMarkets as any[];
    const approved = new Set(
      visibleRankedMarkets.map(
        (entry: any) =>
          `${String(entry.marketPredictionId)}::${String(entry.selectionKey)}`,
      ),
    );
    const selections = market.selections.filter((selection: any) => {
      if (selection.status !== PredictionStatus.CALCULATED) return false;
      if (selection.actualOutcome) return false;
      const probability = Number(selection.probability);
      const confidence = Number(selection.confidence);
      if (!Number.isFinite(probability) || probability < 0 || probability > 1)
        return false;
      if (
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > PREDICTION_ENGINE_CONFIG.model.maximumConfidence
      )
        return false;
      if (
        input.selectionKey?.trim() &&
        String(selection.key) !== input.selectionKey.trim()
      )
        return false;
      if (
        input.minimumProbability !== undefined &&
        probability < Number(input.minimumProbability)
      )
        return false;
      if (
        input.minimumConfidence !== undefined &&
        confidence < Number(input.minimumConfidence)
      )
        return false;
      return approved.has(`${String(market._id)}::${String(selection.key)}`);
    });
    if (!selections.length) return null;
    return {
      ...market,
      selections,
      access: {
        allowed: true,
        plan,
        leagueId: String(market.leagueId ?? pick.leagueId ?? '')
          .trim()
          .toLowerCase(),
        ...this.getMarketAccessSummary(plan),
        mode: 'DAILY_LEAGUE_AND_MARKET_ENTITLEMENTS',
      },
    };
  }

  /**
   * Pick Center has one public recommendation per market. Older stored records
   * may contain every eligible outcome from a market; retain only the highest
   * ranked outcome for each market before returning/displaying the fixture.
   */
  private oneSelectionPerMarket(selections: any[]): any[] {
    const bestByMarket = new Map<string, any>();
    for (const selection of selections ?? []) {
      const marketKey = String(
        selection?.marketKey ?? selection?.marketCode ?? '',
      )
        .trim()
        .toUpperCase();
      if (!marketKey) continue;
      const current = bestByMarket.get(marketKey);
      if (!current) {
        bestByMarket.set(marketKey, selection);
        continue;
      }
      const score = Number(selection?.rankingScore ?? Number.NEGATIVE_INFINITY);
      const currentScore = Number(
        current?.rankingScore ?? Number.NEGATIVE_INFINITY,
      );
      const probability = Number(selection?.probability ?? 0);
      const currentProbability = Number(current?.probability ?? 0);
      const confidence = Number(selection?.confidence ?? 0);
      const currentConfidence = Number(current?.confidence ?? 0);
      if (
        score > currentScore ||
        (score === currentScore && probability > currentProbability) ||
        (score === currentScore &&
          probability === currentProbability &&
          confidence > currentConfidence)
      ) {
        bestByMarket.set(marketKey, selection);
      }
    }
    return [...bestByMarket.values()].sort((a, b) => {
      const rankA = Number(a?.rank ?? Number.MAX_SAFE_INTEGER);
      const rankB = Number(b?.rank ?? Number.MAX_SAFE_INTEGER);
      return (
        rankA - rankB ||
        String(a?.marketKey ?? '').localeCompare(String(b?.marketKey ?? ''))
      );
    });
  }

  private filterPickCenter(
    pick: any,
    plan: PredictionAccessPlan,
  ): Record<string, any> {
    const allSelectedMarkets = this.oneSelectionPerMarket(
      Array.isArray(pick.selectedMarkets) ? pick.selectedMarkets : [],
    );
    const selectedMarkets = allSelectedMarkets.filter((selection: any) =>
      this.canAccessActiveMarket(
        plan,
        String(selection?.marketKey ?? selection?.marketCode ?? '')
          .trim()
          .toUpperCase(),
      ),
    );
    const marketAccess = this.getMarketAccessSummary(plan);
    return {
      ...pick,
      selectedMarkets,
      visibleMarketCount: selectedMarkets.length,
      lockedMarketCount: Math.max(
        0,
        allSelectedMarkets.length - selectedMarkets.length,
      ),
      access: {
        allowed: true,
        plan,
        ...marketAccess,
        visiblePickCenterMarketCount: selectedMarkets.length,
        leagueAccessPercentage: PREDICTION_ACCESS_CONFIG.leagueVisibility[plan],
        mode: 'DAILY_LEAGUE_AND_MARKET_ENTITLEMENTS',
      },
    };
  }

  private canAccessActiveMarket(
    plan: PredictionAccessPlan,
    marketKey: string,
  ): boolean {
    const key = String(marketKey ?? '')
      .trim()
      .toUpperCase();
    if (!key) return false;
    const tier = PREDICTION_ACCESS_CONFIG.marketVisibility[plan];
    const visibleMarketKeys: readonly string[] = tier.marketKeys;
    const visibleFamilies = new Set(tier.families);
    const family = PREDICTION_MARKET_FAMILY_BY_KEY.get(key);
    return Boolean(
      family && visibleMarketKeys.includes(key) && visibleFamilies.has(family),
    );
  }

  private getMarketAccessSummary(
    plan: PredictionAccessPlan,
  ): Record<string, unknown> {
    const tier = PREDICTION_ACCESS_CONFIG.marketVisibility[plan];
    const visibleKeys = [...tier.marketKeys];
    const visibleFamilies = [...tier.families];
    const enabledFamilies = new Set(
      ENABLED_PREDICTION_MARKET_KEYS.map((key) =>
        PREDICTION_MARKET_FAMILY_BY_KEY.get(key),
      ).filter((family) => family !== undefined),
    );
    const lockedFamilies = [...enabledFamilies].filter(
      (family) => !visibleFamilies.includes(family),
    );
    return {
      mode:
        tier.limit === null
          ? 'ALL_PRICING_ENABLED_MARKETS'
          : 'TIERED_MARKET_ALLOWLIST',
      marketLimit: tier.limit,
      visibleMarketTypeCount: visibleKeys.length,
      totalPricingEnabledMarketTypes:
        PREDICTION_ACCESS_CONFIG.enabledMarketCount,
      lockedMarketTypeCount: Math.max(
        0,
        PREDICTION_ACCESS_CONFIG.enabledMarketCount - visibleKeys.length,
      ),
      marketSelectionDiversity: {
        level: tier.diversity,
        visibleFamilies,
        visibleFamilyCount: visibleFamilies.length,
        lockedFamilies,
        lockedFamilyCount: lockedFamilies.length,
        totalMarketFamilies: PREDICTION_ACCESS_CONFIG.enabledMarketFamilyCount,
      },
      visibleMarketKeys: visibleKeys,
      settledOutcomesPublic: true,
    };
  }

  private canAccessActiveLeague(
    leagueId: string,
    fixtureDate: unknown,
    allocation: DailyLeagueAccessAllocation,
  ): boolean {
    const normalizedLeagueId = String(leagueId ?? '')
      .trim()
      .toLowerCase();
    const dateKey = this.getLagosDateKey(fixtureDate);
    if (!normalizedLeagueId || !dateKey) return false;
    return (
      allocation.accessibleByDate.get(dateKey)?.has(normalizedLeagueId) ?? false
    );
  }

  private slipRequiredPlan(slip: any): 'regular' | 'vip' | 'premium' {
    const isSureOdds =
      slip?.sureOdds === true ||
      String(slip?.productType ?? '').toUpperCase() ===
        PredictionProductType.SURE_ODDS;
    if (isSureOdds) {
      const sureProduct = String(
        slip?.sureOddsProduct ??
          (slip?.sureOddsTier === SureOddsTier.VIP ? 'SURE_2' : 'SURE_5'),
      ).toUpperCase();
      return (
        (PREDICTION_ACCESS_CONFIG.sureOdds.products as any)[sureProduct]
          ?.requiredPlan ?? 'premium'
      );
    }
    const productType = String(slip?.productType ?? '').toUpperCase();
    return (
      (PREDICTION_ACCESS_CONFIG.slipProducts as any)[productType]
        ?.requiredPlan ?? 'premium'
    );
  }

  private lockedSlipPreview(
    slip: any,
    plan: PredictionAccessPlan,
    reason = 'SUBSCRIPTION_REQUIRED',
  ): Record<string, any> {
    const requiredPlan = this.slipRequiredPlan(slip);
    return {
      _id: String(slip?._id ?? ''),
      slipId: String(slip?._id ?? ''),
      productType: String(slip?.productType ?? '').toUpperCase(),
      sureOdds: slip?.sureOdds === true,
      sureOddsProduct: slip?.sureOddsProduct ?? null,
      sureOddsTier: slip?.sureOddsTier ?? null,
      fixtureDateFrom: slip?.fixtureDateFrom ?? null,
      generatedDateKey: slip?.generatedDateKey ?? null,
      createdAt: slip?.createdAt ?? null,
      status: slip?.status ?? SlipStatus.PUBLISHED,
      locked: true,
      accessAllowed: false,
      requiredPlan,
      access: {
        allowed: false,
        plan,
        requiredPlan,
        reason,
      },
    };
  }

  private canAccessSlip(plan: PredictionAccessPlan, slip: any): boolean {
    if (
      String(slip?.status ?? '').toUpperCase() !== String(SlipStatus.PUBLISHED)
    )
      return false;
    if (
      plan !== PredictionAccessPlan.REGULAR &&
      plan !== PredictionAccessPlan.VIP &&
      plan !== PredictionAccessPlan.PREMIUM
    )
      return false;
    const productType =
      slip.sureOdds === true
        ? PredictionProductType.SURE_ODDS
        : String(slip.productType ?? '').toUpperCase();
    const odds = this.numberOrNull(slip.combinedOdds);
    if (odds === null) return false;

    if (productType === PredictionProductType.SURE_ODDS) {
      const sureProduct = String(
        slip.sureOddsProduct ??
          (slip.sureOddsTier === SureOddsTier.VIP ? 'SURE_2' : 'SURE_5'),
      ).toUpperCase();
      const range = (PREDICTION_ACCESS_CONFIG.sureOdds.products as any)[
        sureProduct
      ];
      if (!range || odds < range.minOdds || odds > range.maxOdds) return false;
      const requiredPlan = range.requiredPlan as
        | PredictionAccessPlan
        | undefined;
      if (
        requiredPlan !== PredictionAccessPlan.REGULAR &&
        requiredPlan !== PredictionAccessPlan.VIP &&
        requiredPlan !== PredictionAccessPlan.PREMIUM
      )
        return false;
      const planRanks = PREDICTION_ACCESS_CONFIG.planRank as Record<
        string,
        number
      >;
      return planRanks[plan] >= planRanks[requiredPlan];
    }

    // Legacy product identifiers stay in the database/admin history but do not
    // inherit today's commercial entitlements merely because an old band matched.
    if (!['ODDS_10', 'ODDS_25', 'ODDS_50'].includes(productType)) return false;
    const band = (PREDICTION_ACCESS_CONFIG.slipProducts as any)[productType];
    if (!band || odds < band.minOdds || odds > band.maxOdds) return false;
    const planRanks = PREDICTION_ACCESS_CONFIG.planRank as Record<
      string,
      number
    >;
    return planRanks[plan] >= planRanks[band.requiredPlan];
  }

  private async getCuratedRecordsForInput(
    input: {
      from?: string;
      to?: string;
      league?: string;
      predictionId?: string;
    } = {},
  ): Promise<any[]> {
    const records = (await this.curatedPredictionModel
      .find({ status: { $in: ['PUBLISHED', 'SETTLED'] } })
      .sort({ fixtureDateFrom: 1, createdAt: -1 })
      .lean()
      .exec()) as any[];
    return this.filterCuratedRecordsByInput(records, input);
  }

  private async getVisibleCuratedRecords(
    plan: PredictionAccessPlan,
    input: {
      from?: string;
      to?: string;
      league?: string;
      predictionId?: string;
    } = {},
  ): Promise<any[]> {
    // Detail and league filters must never shrink the daily denominator.
    const allocationRecords = await this.getCuratedRecordsForInput({
      from: input.from,
      to: input.to,
    });
    const records = this.filterCuratedRecordsByInput(allocationRecords, input);
    const settled = records.filter((record) => this.isCuratedSettled(record));
    const active = records.filter((record) =>
      this.isCurrentPublishedCurated(record),
    );
    const activeAllocationRecords = allocationRecords.filter((record) =>
      this.isCurrentPublishedCurated(record),
    );
    const allocation = this.buildCuratedLeagueAccessAllocation(
      activeAllocationRecords,
      plan,
    );
    const visibleActive = active
      .map((record) =>
        this.filterCuratedRecordForPlan(plan, record, allocation),
      )
      .filter((record): record is Record<string, any> => Boolean(record));
    return [...visibleActive, ...settled].sort(
      (a, b) => this.curatedFixtureTime(a) - this.curatedFixtureTime(b),
    );
  }

  private filterCuratedRecordForPlan(
    plan: PredictionAccessPlan,
    record: any,
    allocation: DailyLeagueAccessAllocation,
  ): Record<string, any> | null {
    const selections = Array.isArray(record?.selections)
      ? record.selections
      : [];
    if (!selections.length) return null;

    const visibleSelections = selections.filter(
      (selection: any) =>
        this.isCuratedSelectionSettled(selection) ||
        this.canAccessCuratedSelection(plan, selection, record, allocation),
    );
    if (!visibleSelections.length) return null;
    if (visibleSelections.length === selections.length) return record;

    // The parent combined odds/probability include hidden selections. Remove
    // those aggregates rather than accidentally disclosing information about
    // the restricted legs. The visible selections remain their original data.
    const partial: Record<string, any> = {
      ...record,
      selections: visibleSelections,
      partialAccess: true,
      access: {
        allowed: true,
        plan,
        mode: 'PARTIAL_CURATED_LEAGUE_AND_MARKET_ACCESS',
        ...this.getMarketAccessSummary(plan),
        visibleSelectionCount: visibleSelections.length,
      },
    };
    delete partial.selectionCount;
    delete partial.combinedProbability;
    delete partial.combinedOdds;
    delete partial.confidence;
    delete partial.diagnostics;
    return partial;
  }

  private canAccessCuratedSelection(
    plan: PredictionAccessPlan,
    selection: any,
    record: any,
    allocation: DailyLeagueAccessAllocation,
  ): boolean {
    const marketKey = String(selection?.marketKey ?? '').trim();
    if (!this.canAccessActiveMarket(plan, marketKey)) return false;
    const leagueId = String(
      selection?.leagueId ?? selection?.competitionId ?? record?.leagueId ?? '',
    )
      .trim()
      .toLowerCase();
    const fixtureDate = selection?.fixtureDate ?? record?.fixtureDateFrom;
    return this.canAccessActiveLeague(leagueId, fixtureDate, allocation);
  }

  private isCuratedSelectionSettled(selection: any): boolean {
    return SETTLED_OUTCOMES.has(
      String(
        selection?.settlementOutcome ??
          selection?.actualOutcome ??
          selection?.settlementStatus ??
          selection?.matchSettlementStatus ??
          '',
      ).toUpperCase(),
    );
  }

  private buildCuratedLeagueAccessAllocation(
    records: any[],
    plan: PredictionAccessPlan,
  ): DailyLeagueAccessAllocation {
    const entries: Array<{ leagueId: string; date: unknown }> = [];
    for (const record of records ?? []) {
      if (!Array.isArray(record?.selections)) continue;
      for (const selection of record.selections) {
        if (this.isCuratedSelectionSettled(selection)) continue;
        const leagueId = String(
          selection?.leagueId ??
            selection?.competitionId ??
            record?.leagueId ??
            '',
        )
          .trim()
          .toLowerCase();
        const date = selection?.fixtureDate ?? record?.fixtureDateFrom;
        if (leagueId && this.getLagosDateKey(date))
          entries.push({ leagueId, date });
      }
    }
    return this.buildDailyLeagueAccessAllocation(entries, plan, 'CURATED');
  }

  private buildPickCenterLeagueAccessAllocation(
    records: any[],
    plan: PredictionAccessPlan,
  ): DailyLeagueAccessAllocation {
    const entries: Array<{ leagueId: string; date: unknown }> = [];
    for (const record of records ?? []) {
      const leagueId = String(record?.leagueId ?? '')
        .trim()
        .toLowerCase();
      if (!leagueId || !Array.isArray(record?.selectedMarkets)) continue;
      const hasActivePredictions = record.selectedMarkets.some(
        (selection: any) => this.isActivePredictionSelection(selection),
      );
      if (hasActivePredictions)
        entries.push({ leagueId, date: record.fixtureDate });
    }
    return this.buildDailyLeagueAccessAllocation(entries, plan, 'PICK_CENTER');
  }

  private isActivePredictionSelection(selection: any): boolean {
    if (!selection) return false;
    const selectionStatus = String(
      selection.status ?? PickStatus.SELECTED,
    ).toUpperCase();
    if (selectionStatus !== PickStatus.SELECTED) return false;
    const marketKey = String(selection.marketKey ?? selection.marketCode ?? '')
      .trim()
      .toUpperCase();
    return Boolean(
      marketKey &&
      ENABLED_PREDICTION_MARKET_KEYS.includes(marketKey) &&
      !this.isSelectionSettled(selection),
    );
  }

  private isSelectionSettled(selection: any): boolean {
    const outcome = String(
      selection?.actualOutcome ?? selection?.settlementStatus ?? 'PENDING',
    ).toUpperCase();
    return SETTLED_OUTCOMES.has(outcome);
  }

  private buildDailyLeagueAccessAllocation(
    entries: Array<{ leagueId: string; date: unknown }>,
    plan: PredictionAccessPlan,
    scope: 'PICK_CENTER' | 'CURATED',
  ): DailyLeagueAccessAllocation {
    const percentage =
      scope === 'CURATED'
        ? PREDICTION_ACCESS_CONFIG.curatedLeagueVisibility[plan]
        : PREDICTION_ACCESS_CONFIG.leagueVisibility[plan];
    const totalByDate = new Map<string, Set<string>>();
    for (const entry of entries) {
      const leagueId = String(entry.leagueId ?? '')
        .trim()
        .toLowerCase();
      const dateKey = this.getLagosDateKey(entry.date);
      if (!leagueId || !dateKey) continue;
      const leagues = totalByDate.get(dateKey) ?? new Set<string>();
      leagues.add(leagueId);
      totalByDate.set(dateKey, leagues);
    }

    const accessibleByDate = new Map<string, Set<string>>();
    for (const [dateKey, leagueSet] of totalByDate) {
      const ordered = [...leagueSet].sort(
        (a, b) =>
          this.stableDailyLeagueHash(dateKey, a) -
            this.stableDailyLeagueHash(dateKey, b) || a.localeCompare(b),
      );
      const count =
        percentage <= 0
          ? 0
          : percentage >= 100
            ? ordered.length
            : Math.ceil((ordered.length * percentage) / 100);
      accessibleByDate.set(dateKey, new Set(ordered.slice(0, count)));
    }

    return { scope, percentage, totalByDate, accessibleByDate };
  }

  private stableDailyLeagueHash(dateKey: string, leagueId: string): number {
    // FNV-1a gives a stable daily rotation without storing user-specific grants.
    const value = `${dateKey}:${leagueId}`;
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  private getDailyLeagueAccessSummary(
    allocation: DailyLeagueAccessAllocation,
  ): Record<string, unknown> {
    const days = [...allocation.totalByDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, leagues]) => {
        const accessible = allocation.accessibleByDate.get(date)?.size ?? 0;
        return {
          date,
          totalActiveLeagues: leagues.size,
          accessibleLeagues: accessible,
          lockedLeagues: Math.max(0, leagues.size - accessible),
        };
      });
    return {
      mode: 'DAILY_ACTIVE_LEAGUE_ALLOCATION',
      percentage: allocation.percentage,
      basis:
        allocation.scope === 'CURATED'
          ? 'DISTINCT_LEAGUES_WITH_ACTIVE_CURATED_PREDICTIONS_PER_LAGOS_FIXTURE_DATE'
          : 'DISTINCT_LEAGUES_WITH_ACTIVE_PREDICTIONS_PER_LAGOS_FIXTURE_DATE',
      totalActiveLeagueDays: days.reduce(
        (sum, day) => sum + day.totalActiveLeagues,
        0,
      ),
      accessibleLeagueDays: days.reduce(
        (sum, day) => sum + day.accessibleLeagues,
        0,
      ),
      days,
    };
  }

  private nextRequiredCuratedPlan(
    plan: PredictionAccessPlan,
  ): PredictionAccessPlan | null {
    switch (plan) {
      case PredictionAccessPlan.ANONYMOUS:
      case PredictionAccessPlan.FREE:
        return PredictionAccessPlan.REGULAR;
      case PredictionAccessPlan.REGULAR:
        return PredictionAccessPlan.VIP;
      case PredictionAccessPlan.VIP:
        return PredictionAccessPlan.PREMIUM;
      default:
        return null;
    }
  }

  private nextRequiredPlan(
    plan: PredictionAccessPlan,
  ): PredictionAccessPlan | null {
    switch (plan) {
      case PredictionAccessPlan.ANONYMOUS:
        return PredictionAccessPlan.FREE;
      case PredictionAccessPlan.FREE:
        return PredictionAccessPlan.REGULAR;
      case PredictionAccessPlan.REGULAR:
        return PredictionAccessPlan.VIP;
      case PredictionAccessPlan.VIP:
        return PredictionAccessPlan.PREMIUM;
      default:
        return null;
    }
  }

  private getLagosDateKey(value: unknown): string {
    const date = value instanceof Date ? value : new Date(String(value ?? ''));
    if (!Number.isFinite(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Lagos',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const part = (type: string) =>
      parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  private async buildCuratedLeagueSummary(
    records: any[],
    plan: PredictionAccessPlan,
    allocation: DailyLeagueAccessAllocation,
  ): Promise<Record<string, any>> {
    const entries: Array<{
      record: any;
      leagueId: string;
      leagueName: string;
      eventId: string;
      locked: boolean;
      requiredPlan: PredictionAccessPlan | null;
      uniqueSelectionId: string;
    }> = [];

    for (const record of records ?? []) {
      const selections =
        Array.isArray(record?.selections) && record.selections.length
          ? record.selections
          : [record];
      for (
        let selectionIndex = 0;
        selectionIndex < selections.length;
        selectionIndex += 1
      ) {
        const selection = selections[selectionIndex];
        const leagueId = String(
          selection?.leagueId ??
            selection?.competitionId ??
            record?.leagueId ??
            '',
        )
          .trim()
          .toLowerCase();
        if (!leagueId) continue;
        const leagueName = String(
          selection?.leagueName ??
            selection?.competitionName ??
            record?.leagueName ??
            leagueId,
        ).trim();
        const eventId = String(
          selection?.eventId ??
            selection?.fixtureId ??
            record?.eventId ??
            record?._id ??
            '',
        ).trim();
        if (!eventId) continue;

        const settled =
          this.isCuratedSettled(record) ||
          this.isCuratedSelectionSettled(selection);
        const locked =
          !settled &&
          !this.canAccessCuratedSelection(plan, selection, record, allocation);
        const requiredPlan = locked ? this.nextRequiredCuratedPlan(plan) : null;
        const recordId = String(
          record?._id ?? record?.predictionCode ?? 'curated',
        );
        const selectionId =
          [
            selection?.marketPredictionId,
            selection?.marketKey,
            selection?.selectionKey,
          ]
            .map((value) => String(value ?? ''))
            .join(':') || String(selectionIndex);
        entries.push({
          record,
          leagueId,
          leagueName,
          eventId,
          locked,
          requiredPlan,
          uniqueSelectionId: `${recordId}:${eventId}:${selectionId}`,
        });
      }
    }

    if (!entries.length) {
      return { countries: [], totalLeagues: 0, totalPredictions: 0 };
    }

    const leagueIds = [...new Set(entries.map((entry) => entry.leagueId))];
    const leagueMap = await this.getSportsCompetitionMap(leagueIds);

    const countryMap = new Map<string, Map<string, any>>();
    for (const entry of entries) {
      const league = leagueMap.get(entry.leagueId) ?? {};
      const region = String(league.region ?? '').toUpperCase();
      const type = String(league.type ?? '').toUpperCase();
      const country = String(
        league.country ?? entry.record?.country ?? '',
      ).trim();
      const countryName = this.predictionCountryGroup(region, type, country);
      const resolvedName = this.resolveLeagueDisplayName(
        league,
        entry.leagueId,
      );
      const leagueName =
        resolvedName !== 'League name unavailable'
          ? resolvedName
          : this.isLeagueCode(entry.leagueName, entry.leagueId)
            ? 'Football competition'
            : entry.leagueName;
      const leagueKey = entry.leagueId || this.normalizeIdentifier(leagueName);

      if (!countryMap.has(countryName)) countryMap.set(countryName, new Map());
      const countryLeagues = countryMap.get(countryName)!;
      let current = countryLeagues.get(leagueKey);
      if (!current) {
        current = {
          id: entry.leagueId || leagueKey,
          name: leagueName,
          logo: this.logoUrl(league.logo),
          eventIds: new Set<string>(),
          accessibleSelectionIds: new Set<string>(),
          lockedSelectionIds: new Set<string>(),
          lockedRequiredPlans: new Set<string>(),
        };
        countryLeagues.set(leagueKey, current);
      }
      current.eventIds.add(entry.eventId);
      if (entry.locked) {
        current.lockedSelectionIds.add(entry.uniqueSelectionId);
        if (entry.requiredPlan)
          current.lockedRequiredPlans.add(entry.requiredPlan);
      } else {
        current.accessibleSelectionIds.add(entry.uniqueSelectionId);
      }
    }

    const countries = [...countryMap.entries()]
      .map(([name, leagueMapForCountry]) => {
        const leagues = [...leagueMapForCountry.values()]
          .map((league) => ({
            id: league.id,
            name: league.name,
            logo: league.logo,
            count: league.eventIds.size,
            lockedCount: league.lockedSelectionIds.size,
            locked: league.accessibleSelectionIds.size === 0,
            requiredPlan:
              (['regular', 'vip', 'premium'] as const).find((requiredPlan) =>
                league.lockedRequiredPlans.has(requiredPlan),
              ) ?? null,
          }))
          .filter((league) => league.count > 0)
          .sort((a, b) => a.name.localeCompare(b.name));
        const lockedLeagueCount = leagues.filter(
          (league) => league.lockedCount > 0,
        ).length;
        const lockedRequiredPlans = leagues
          .filter((league) => league.lockedCount > 0)
          .map((league) => String(league.requiredPlan ?? 'regular'));
        const requiredPlan =
          (['regular', 'vip', 'premium'] as const).find((candidate) =>
            lockedRequiredPlans.includes(candidate),
          ) ?? null;
        return {
          name,
          count: leagues.reduce((sum, league) => sum + league.count, 0),
          predictionLeagueCount: leagues.length,
          locked:
            leagues.length > 0 && leagues.every((league) => league.locked),
          lockedLeagueCount,
          requiredPlan,
          leagues,
        };
      })
      .filter((country) => country.leagues.length > 0)
      .sort((a, b) => {
        const rank = (name: string) =>
          name === 'International' ? 0 : name === 'Regional' ? 1 : 2;
        return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
      });

    return {
      countries,
      totalLeagues: countries.reduce(
        (sum, country) => sum + country.predictionLeagueCount,
        0,
      ),
      totalPredictions: countries.reduce(
        (sum, country) => sum + country.count,
        0,
      ),
    };
  }

  private isCuratedSettled(record: any): boolean {
    if (String(record?.status ?? '').toUpperCase() === 'SETTLED') return true;
    if (
      SETTLED_OUTCOMES.has(String(record?.settlementStatus ?? '').toUpperCase())
    )
      return true;
    const selections = Array.isArray(record?.selections)
      ? record.selections
      : [];
    return (
      selections.length > 0 &&
      selections.every((selection: any) =>
        SETTLED_OUTCOMES.has(
          String(selection?.settlementOutcome ?? '').toUpperCase(),
        ),
      )
    );
  }

  private isCurrentPublishedCurated(record: any): boolean {
    if (
      String(record?.status ?? '').toUpperCase() !== 'PUBLISHED' ||
      this.isCuratedSettled(record)
    )
      return false;
    if (record?.completed === true) return false;
    const kickoff = this.curatedFixtureTime(record);
    // Kickoff time alone is not proof that a fixture finished or that settlement completed.
    // Keep this published pick visible until completion/settlement is confirmed.
    return Number.isFinite(kickoff);
  }

  private curatedFixtureTime(record: any): number {
    const date = new Date(
      record?.fixtureDateFrom ?? record?.selections?.[0]?.fixtureDate ?? '',
    ).getTime();
    return Number.isFinite(date) ? date : Number.NaN;
  }

  private filterCuratedRecordsByInput(
    records: any[],
    input: {
      from?: string;
      to?: string;
      league?: string;
      predictionId?: string;
    },
  ): any[] {
    const from = input.from ? this.parseLagosDate(input.from, false) : null;
    const toIsDateOnly = Boolean(
      input.to && /^\d{4}-\d{2}-\d{2}$/.test(input.to),
    );
    const to = input.to ? this.parseLagosDate(input.to, toIsDateOnly) : null;
    if (from && Number.isNaN(from.getTime()))
      throw new BadRequestException(`Invalid from date "${input.from}".`);
    if (to && Number.isNaN(to.getTime()))
      throw new BadRequestException(`Invalid to date "${input.to}".`);

    const normalizedLeague = input.league?.trim().toLowerCase();
    const matchesDate = (value: unknown): boolean => {
      if (!from && !to) return true;
      const fixtureTime =
        value instanceof Date
          ? value.getTime()
          : new Date(String(value ?? '')).getTime();
      if (!Number.isFinite(fixtureTime)) return false;
      if (from && fixtureTime < from.getTime()) return false;
      if (
        to &&
        (toIsDateOnly
          ? fixtureTime >= to.getTime()
          : fixtureTime > to.getTime())
      )
        return false;
      return true;
    };

    const matchesLeague = (selection: any, record: any): boolean =>
      !normalizedLeague ||
      [
        selection?.leagueId,
        selection?.leagueName,
        selection?.competitionId,
        selection?.competitionName,
        record?.leagueId,
        record?.leagueName,
      ].some(
        (value) =>
          String(value ?? '')
            .trim()
            .toLowerCase() === normalizedLeague,
      );

    const filtered: any[] = [];
    for (const record of records ?? []) {
      if (input.predictionId && String(record?._id) !== input.predictionId)
        continue;

      const selections = Array.isArray(record?.selections)
        ? record.selections
        : [];
      if (selections.length) {
        const visibleSelections = selections.filter(
          (selection: any) =>
            matchesDate(
              selection?.fixtureDate ??
                record?.fixtureDateFrom ??
                selections[0]?.fixtureDate,
            ) && matchesLeague(selection, record),
        );
        if (!visibleSelections.length) continue;
        filtered.push(
          visibleSelections.length === selections.length
            ? record
            : { ...record, selections: visibleSelections },
        );
        continue;
      }

      const recordDate = record?.fixtureDateFrom ?? record?.fixtureDate;
      if ((from || to) && !matchesDate(recordDate)) continue;
      if (!matchesLeague(record, record)) continue;
      filtered.push(record);
    }
    return filtered;
  }

  private normalizeIdentifier(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  private getUserId(user?: AccessRequestUser | null): string | null {
    if (!user) return null;
    for (const candidate of [user._id, user.id, user.userId, user.sub]) {
      if (candidate === null || candidate === undefined) continue;
      const value = String(candidate).trim();
      if (value && value !== '[object Object]') return value;
    }
    return null;
  }

  /** Convert YYYY-MM-DD to Lagos calendar boundaries; timestamps keep their timezone semantics. */
  private parseLagosDate(value: string, nextDay = false): Date {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [year, month, day] = value.split('-').map(Number);
      const calendarDate = new Date(Date.UTC(year, month - 1, day));
      // Date.UTC normalizes invalid dates (e.g. February 31); reject them.
      if (
        calendarDate.getUTCFullYear() !== year ||
        calendarDate.getUTCMonth() !== month - 1 ||
        calendarDate.getUTCDate() !== day
      )
        return new Date(Number.NaN);
      const lagosMidnight = calendarDate.getTime() - 60 * 60_000;
      return new Date(lagosMidnight + (nextDay ? 86_400_000 : 0));
    }
    return new Date(value);
  }

  private applyDateRange(
    query: Record<string, any>,
    field: string,
    from?: string,
    to?: string,
    includePast = false,
  ): void {
    const range: Record<string, Date> = {};
    if (from) {
      const value = this.parseLagosDate(from, false);
      if (Number.isNaN(value.getTime()))
        throw new BadRequestException(`Invalid from date "${from}".`);
      range.$gte = value;
    } else if (!includePast) {
      range.$gte = new Date();
    }
    if (to) {
      const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(to);
      const value = this.parseLagosDate(to, isDateOnly);
      if (Number.isNaN(value.getTime()))
        throw new BadRequestException(`Invalid to date "${to}".`);
      if (isDateOnly) range.$lt = value;
      else range.$lte = value;
    }
    if (range.$gte && !includePast && range.$gte.getTime() < Date.now())
      range.$gte = new Date();
    if (Object.keys(range).length)
      query[field] = {
        ...((query[field] as Record<string, unknown> | undefined) ?? {}),
        ...range,
      };
  }

  private pagination(
    pageValue: unknown,
    sizeValue: unknown,
    defaultSize: number,
    maximumSize: number,
  ): { page: number; pageSize: number } {
    const page = Number(pageValue ?? 1);
    const pageSize = Number(sizeValue ?? defaultSize);
    if (!Number.isInteger(page) || page < 1)
      throw new BadRequestException('page must be a positive integer.');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > maximumSize)
      throw new BadRequestException(
        `pageSize must be between 1 and ${maximumSize}.`,
      );
    return { page, pageSize };
  }

  private numberOrNull(value: unknown): number | null {
    const parsed = Number(value);
    return value !== null &&
      value !== undefined &&
      Number.isFinite(parsed) &&
      parsed >= 1
      ? parsed
      : null;
  }

  private getRecordDate(record: any): number {
    const candidates = [
      record.fixtureDateFrom,
      record.fixtureDate,
      record.kickoffTimestamp ? new Date(record.kickoffTimestamp) : null,
      record.matchDate ? new Date(record.matchDate) : null,
      record.createdAt,
    ];
    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined) continue;
      const date =
        candidate instanceof Date
          ? candidate.getTime()
          : new Date(candidate).getTime();
      if (Number.isFinite(date)) return date;
    }
    return 0;
  }

  private getDateKey(record: any): string {
    const explicit = String(record.generatedDateKey ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
    const timestamp = this.getRecordDate(record);
    return new Date(timestamp).toISOString().slice(0, 10);
  }
}

