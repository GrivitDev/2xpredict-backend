/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-enum-comparison */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { Ad, AdDocument } from './schemas/ad.schema';
import { AdEvent } from './schemas/ad-event.schema';
import { ExternalAdPolicyConfig } from './schemas/external-ad-policy.schema';
import { CreateAdDto } from './dto/create-ad.dto';
import { UpdateAdDto } from './dto/update-ad.dto';
import { TrackAdEventDto } from './dto/track-ad-event.dto';
import { ExternalAdPolicyDto } from './dto/external-ad-policy.dto';
import { AdDeliveryQueryDto } from './dto/ad-delivery-query.dto';
import { AdListQueryDto } from './dto/ad-list-query.dto';
import { AdAnalyticsQueryDto } from './dto/ad-analytics-query.dto';
import { AdEventQueryDto } from './dto/ad-event-query.dto';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { UploadsService } from '../uploads/uploads.service';
import { PlanConfigService } from '../plan-config/plan-config.service';
import { BET_LAB_CONFIG } from '../bet-lab/config/bet-lab.config';
import { AdDevice } from './enums/ad-device.enum';
import { AdAudience } from './enums/ad-audience.enum';
import { AdTrigger } from './enums/ad-trigger.enum';
import { AdTriggerEvent } from './enums/ad-trigger-event.enum';
import { AdEventType } from './enums/ad-event-type.enum';
import { AdType } from './enums/ad-type.enum';
import { AdContentSource } from './enums/ad-content-source.enum';
import { AdAutomationKey } from './enums/ad-automation-key.enum';
import { ExternalAdFrequency } from './enums/external-ad-frequency.enum';
import { MarketPrediction } from '../predictions-engine/schemas/market-prediction.schema';
import { PredictionSlip } from '../predictions-engine/schemas/prediction-slip.schema';
import { PredictionStatus } from '../predictions-engine/enums/prediction-status.enum';
import { SlipStatus } from '../predictions-engine/enums/slip-status.enum';
import { SlipProductType } from '../predictions-engine/enums/slip-product-type.enum';
import { Promo } from '../promos/schemas/promo.schema';
import { PromoPurpose } from '../promos/constants/promo-purpose';
import { PromoCampaignType } from '../promos/constants/promo-campaign-type';
import { PromoPromotionKind } from '../promos/constants/promo-promotion-kind';
import { RewardType } from '../promos/constants/reward-types';
import {
  AdAudienceKey,
  AdContentVisibility,
  AdTargeting,
} from './interfaces/ad-content-visibility.interface';

type AnyRecord = Record<string, any>;
type EventCounts = {
  impressions: number;
  clicks: number;
  conversions: number;
  dismissals: number;
};
type TriggerContext = {
  firstSeen: Set<string>;
  todayCounts: Map<string, number>;
  sessionSeen: Set<string>;
  hasIdentity: boolean;
};

const GUEST_VISIBILITY: AdContentVisibility = {
  showProbability: false,
  showConfidence: false,
  showMarketName: false,
  showMarketSelections: false,
  showFairOdds: false,
  showBookmakerOdds: false,
  showDecimalOdds: false,
  showCombinedOdds: false,
  showCombinedProbability: false,
  showLegCount: true,
  showTeams: true,
  showLeague: false,
  showFixtureDate: true,
  showProductName: true,
  showRewardValue: true,
  showPromoCode: false,
  showDescription: true,
  showSportyBetCode: false,
  showSelectionCount: true,
  showSubscriptionPricing: false,
  showWelcomePoints: true,
};

const PAID_VISIBILITY: AdContentVisibility = {
  showProbability: true,
  showConfidence: true,
  showMarketName: true,
  showMarketSelections: true,
  showFairOdds: true,
  showBookmakerOdds: true,
  showDecimalOdds: true,
  showCombinedOdds: true,
  showCombinedProbability: true,
  showLegCount: true,
  showTeams: true,
  showLeague: true,
  showFixtureDate: true,
  showProductName: true,
  showRewardValue: true,
  showPromoCode: true,
  showDescription: true,
  showSportyBetCode: true,
  showSelectionCount: true,
  showSubscriptionPricing: true,
  showWelcomePoints: true,
};

const FIELD_VISIBILITY: Record<string, keyof AdContentVisibility> = {
  probability: 'showProbability',
  probabilityPercent: 'showProbability',
  combinedProbability: 'showCombinedProbability',
  confidence: 'showConfidence',
  averageConfidence: 'showConfidence',
  generalConfidence: 'showConfidence',
  evidenceConfidence: 'showConfidence',
  marketName: 'showMarketName',
  marketAbbreviation: 'showMarketName',
  marketKey: 'showMarketName',
  marketJsonVariable: 'showMarketName',
  marketSelections: 'showMarketSelections',
  selections: 'showMarketSelections',
  selectedMarkets: 'showMarketSelections',
  featuredSelection: 'showMarketSelections',
  selectionName: 'showMarketName',
  selectionKey: 'showMarketSelections',
  selectionAbbreviation: 'showMarketName',
  subjectName: 'showMarketName',
  line: 'showMarketSelections',
  priceType: 'showMarketName',
  fullName: 'showMarketName',
  abbreviation: 'showMarketName',
  fairOdds: 'showFairOdds',
  combinedFairOdds: 'showFairOdds',
  bookmakerOdds: 'showBookmakerOdds',
  decimalOdds: 'showDecimalOdds',
  odds: 'showDecimalOdds',
  combinedOdds: 'showCombinedOdds',
  legCount: 'showLegCount',
  selectionCount: 'showSelectionCount',
  priceNGN: 'showSubscriptionPricing',
  priceUSD: 'showSubscriptionPricing',
  durationDays: 'showSubscriptionPricing',
  registrationBonus: 'showWelcomePoints',
  welcomePoints: 'showWelcomePoints',
  monthlyAllowanceByPlan: 'showRewardValue',
  minPurchaseAmount: 'showRewardValue',
  maxDiscountAmount: 'showRewardValue',
  homeTeamName: 'showTeams',
  awayTeamName: 'showTeams',
  homeTeamId: 'showTeams',
  awayTeamId: 'showTeams',
  leagueId: 'showLeague',
  leagueName: 'showLeague',
  fixtureDate: 'showFixtureDate',
  fixtureDateFrom: 'showFixtureDate',
  fixtureDateTo: 'showFixtureDate',
  subTitle: 'showProductName',
  productType: 'showProductName',
  sureOddsProduct: 'showProductName',
  sureOddsTier: 'showProductName',
  rewardType: 'showRewardValue',
  points: 'showRewardValue',
  pointsAmount: 'showRewardValue',
  rewardPlan: 'showRewardValue',
  rewardDurationDays: 'showRewardValue',
  discountValue: 'showRewardValue',
  promoCode: 'showPromoCode',
  description: 'showDescription',
  sportyBetSlipCode: 'showSportyBetCode',
  sportyBetSlipLink: 'showSportyBetCode',
  requiredPlan: 'showProductName',
  eligiblePlans: 'showRewardValue',
  plan: 'showProductName',
  label: 'showProductName',
  campaignName: 'showProductName',
  purpose: 'showProductName',
  campaignType: 'showProductName',
  promotionKind: 'showProductName',
  requirement: 'showDescription',
  discountType: 'showRewardValue',
  amountCurrency: 'showRewardValue',
  endDate: 'showDescription',
  startDate: 'showDescription',
  allowancePeriodDays: 'showWelcomePoints',
};

const DEFAULT_EXTERNAL_TYPES: Record<AdType, boolean> = {
  [AdType.BANNER]: true,
  [AdType.INTERSTITIAL]: true,
  [AdType.NATIVE]: true,
  [AdType.REWARDED]: false,
  [AdType.POPUP]: false,
  [AdType.STICKY]: true,
  [AdType.VIDEO]: false,
};

const AUTOMATION_SOURCE: Record<AdAutomationKey, AdContentSource> = {
  [AdAutomationKey.TOP_PREDICTION]: AdContentSource.PREDICTION,
  [AdAutomationKey.TODAYS_SURE_ODDS]: AdContentSource.SURE_ODDS,
  [AdAutomationKey.FEATURED_SLIP]: AdContentSource.SLIP,
  [AdAutomationKey.AVAILABLE_BONUS]: AdContentSource.BONUS,
  [AdAutomationKey.ACTIVE_PROMO]: AdContentSource.PROMO,
  [AdAutomationKey.REFERRAL_CAMPAIGN]: AdContentSource.REFERRAL,
  [AdAutomationKey.SUBSCRIPTION_OFFER]: AdContentSource.SUBSCRIPTION,
  [AdAutomationKey.BET_LAB_WELCOME_POINTS]: AdContentSource.BET_LAB,
};

@Injectable()
export class AdsService {
  constructor(
    @InjectModel(Ad.name) private readonly adModel: Model<AdDocument>,
    @InjectModel(AdEvent.name) private readonly eventModel: Model<any>,
    @InjectModel(ExternalAdPolicyConfig.name)
    private readonly policyModel: Model<any>,
    @InjectModel(MarketPrediction.name)
    private readonly marketModel: Model<any>,
    @InjectModel(PredictionSlip.name) private readonly slipModel: Model<any>,
    @InjectModel(Promo.name) private readonly promoModel: Model<any>,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly uploadsService: UploadsService,
    private readonly planConfigService: PlanConfigService,
  ) {}

  async create(dto: CreateAdDto, adminId: string) {
    this.assertObjectId(adminId, 'Invalid administrator ID.');
    this.validateAdPayload(dto);
    const payload: AnyRecord = {
      ...dto,
      createdBy: new Types.ObjectId(adminId),
      startDate: dto.startDate ? new Date(dto.startDate) : undefined,
      endDate: dto.endDate ? new Date(dto.endDate) : undefined,
    };
    return this.adModel.create(payload);
  }

  async findAll(query?: AdListQueryDto) {
    const filter = this.buildAdFilter(query);
    const hasQuery = Boolean(
      query?.search ||
      query?.active !== undefined ||
      query?.type ||
      query?.contentSource ||
      query?.audience ||
      query?.page !== undefined ||
      query?.displayPage !== undefined ||
      query?.position !== undefined ||
      query?.device !== undefined ||
      query?.limit !== undefined,
    );
    if (!hasQuery) {
      return this.adModel
        .find(filter)
        .populate('createdBy', 'fullName username email')
        .sort({ priority: -1, createdAt: -1 })
        .lean()
        .exec();
    }
    const page = Math.max(1, Number(query?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query?.limit) || 20));
    const [items, total] = await Promise.all([
      this.adModel
        .find(filter)
        .populate('createdBy', 'fullName username email')
        .sort({ priority: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.adModel.countDocuments(filter).exec(),
    ]);
    return {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string) {
    this.assertId(id);
    const ad = await this.adModel
      .findById(id)
      .populate('createdBy', 'fullName username email')
      .populate('updatedBy', 'fullName username email')
      .lean()
      .exec();
    if (!ad) throw new NotFoundException('Advertisement not found.');
    return ad;
  }

  async update(id: string, dto: UpdateAdDto, adminId?: string) {
    this.assertId(id);
    if (adminId) this.assertObjectId(adminId, 'Invalid administrator ID.');
    const existing = await this.adModel.findById(id).exec();
    if (!existing) throw new NotFoundException('Advertisement not found.');

    const existingRecord = existing.toObject() as AnyRecord;
    const update: AnyRecord = { ...dto };
    const sourceChanged =
      dto.contentSource !== undefined &&
      dto.contentSource !== existingRecord.contentSource;
    const automationDisabled = dto.automated === false;

    // Clear dependent fields when an ad changes mode/source so stale linkage cannot
    // silently keep resolving old content or make a legitimate edit impossible.
    if (sourceChanged) {
      if (dto.sourceId === undefined) update.sourceId = null;
      if (dto.automationKey === undefined) update.automationKey = null;
      if (dto.automated === undefined) update.automated = false;
    }
    if (automationDisabled && dto.automationKey === undefined)
      update.automationKey = null;
    if (
      dto.automated === true &&
      dto.sourceId === undefined &&
      existingRecord.sourceId
    )
      update.sourceId = null;

    const merged = { ...existingRecord, ...update } as CreateAdDto;
    this.validateAdPayload(merged);
    const nextStart =
      dto.startDate !== undefined ? dto.startDate : existing.startDate;
    const nextEnd = dto.endDate !== undefined ? dto.endDate : existing.endDate;
    this.validateDates(nextStart, nextEnd);

    if (dto.startDate !== undefined)
      update.startDate = dto.startDate ? new Date(dto.startDate) : null;
    if (dto.endDate !== undefined)
      update.endDate = dto.endDate ? new Date(dto.endDate) : null;
    if (adminId) update.updatedBy = new Types.ObjectId(adminId);

    const updated = await this.adModel
      .findByIdAndUpdate(
        id,
        { $set: update },
        { returnDocument: 'after', runValidators: true },
      )
      .lean()
      .exec();
    if (!updated) throw new NotFoundException('Advertisement not found.');

    const nextImagePublicId = dto.image?.publicId;
    const oldImagePublicId = existing.image?.publicId;
    if (
      oldImagePublicId &&
      nextImagePublicId &&
      oldImagePublicId !== nextImagePublicId
    ) {
      await this.safeDeleteImage(oldImagePublicId);
    }
    const nextMediaPublicId = dto.media?.publicId;
    const oldMediaPublicId = existing.media?.publicId;
    if (
      oldMediaPublicId &&
      nextMediaPublicId &&
      oldMediaPublicId !== nextMediaPublicId
    ) {
      await this.safeDeleteImage(oldMediaPublicId);
    }
    return updated;
  }

  async remove(id: string) {
    this.assertId(id);
    const ad = await this.adModel.findByIdAndDelete(id).exec();
    if (!ad) throw new NotFoundException('Advertisement not found.');
    if (ad.image?.publicId) await this.safeDeleteImage(ad.image.publicId);
    if (ad.media?.publicId) await this.safeDeleteImage(ad.media.publicId);
    return { success: true, message: 'Advertisement deleted.' };
  }

  async toggleStatus(id: string, adminId?: string) {
    this.assertId(id);
    if (adminId) this.assertObjectId(adminId, 'Invalid administrator ID.');
    const ad = await this.adModel.findById(id).exec();
    if (!ad) throw new NotFoundException('Advertisement not found.');
    ad.isActive = !ad.isActive;
    if (adminId) ad.updatedBy = new Types.ObjectId(adminId);
    await ad.save();
    return { success: true, isActive: ad.isActive };
  }

  /** This is the in-app campaign feed. External provider policy is deliberately not consulted here. */
  async getPageAds(query: AdDeliveryQueryDto, userId?: string) {
    const now = new Date();
    const audience = await this.resolveAudience(userId);
    const ads = await this.adModel
      .find({
        isActive: true,
        audience: { $in: [AdAudience.ALL, audience as AdAudience] },
        $and: [
          {
            $or: [
              { startDate: { $exists: false } },
              { startDate: null },
              { startDate: { $lte: now } },
            ],
          },
          {
            $or: [
              { endDate: { $exists: false } },
              { endDate: null },
              { endDate: { $gte: now } },
            ],
          },
        ],
      })
      .sort({ priority: -1, createdAt: -1 })
      .limit(100)
      .lean()
      .exec();

    const visitorKeyHash = this.hashKey(query.visitorKey);
    const sessionKeyHash = this.hashKey(query.sessionKey);
    const device = query.device;
    const triggerEvent = query.triggerEvent ?? AdTriggerEvent.VISIT;

    const candidates: AnyRecord[] = [];
    for (const ad of ads as AnyRecord[]) {
      if (
        !this.matchesTargeting(
          ad.targeting as AdTargeting | undefined,
          audience,
          Boolean(userId),
        )
      )
        continue;
      const displays = (ad.displays ?? []).filter(
        (display: AnyRecord) =>
          display.page === query.page &&
          (!device ||
            display.device === AdDevice.ALL ||
            display.device === device) &&
          (!query.position || display.position === query.position) &&
          this.isTriggerEventCompatible(
            display.trigger as AdTrigger,
            triggerEvent,
          ),
      );
      if (displays.length)
        candidates.push({ ...ad, matchingDisplays: displays });
    }
    if (!candidates.length) return [];

    const ids = candidates.map((ad) => ad._id);
    const identity: AnyRecord[] = [];
    if (userId) identity.push({ userId });
    if (visitorKeyHash) identity.push({ visitorKeyHash });
    const eventRows: AnyRecord[] = identity.length
      ? await this.eventModel
          .find({
            adId: { $in: ids },
            type: AdEventType.IMPRESSION,
            $or: identity,
          })
          .select({ adId: 1, createdAt: 1, sessionKeyHash: 1 })
          .lean()
          .exec()
      : [];
    const context = this.buildTriggerContext(
      eventRows,
      sessionKeyHash,
      now,
      identity.length > 0,
    );

    const eligible: AnyRecord[] = [];
    for (const ad of candidates) {
      const adId = String(ad._id);
      const cap = Number(ad.maxImpressionsPerVisitorPerDay ?? 0);
      const todayCount = context.todayCounts.get(adId) ?? 0;
      if (cap > 0 && !userId && !visitorKeyHash) continue; // fail closed when a per-visitor cap cannot be enforced
      if (cap > 0 && todayCount >= cap) continue;
      const displays = (ad.matchingDisplays as AnyRecord[]).filter((display) =>
        this.isTriggerSatisfied(
          display.trigger as AdTrigger,
          triggerEvent,
          adId,
          context,
          sessionKeyHash,
        ),
      );
      if (displays.length) eligible.push({ ...ad, matchingDisplays: displays });
    }

    const resolved = await Promise.all(
      eligible.map(async (ad) => {
        const dynamic = await this.resolveLinkedContent(ad);
        if (!dynamic) return null;
        const visibility = this.visibilityFor(ad, audience);
        const content = this.projectContent(dynamic, visibility);
        const display = (ad.matchingDisplays as AnyRecord[]).sort(
          (a, b) => Number(a.displayOrder ?? 1) - Number(b.displayOrder ?? 1),
        );
        return { ...this.publicAd(ad, visibility), display, content };
      }),
    );
    return resolved.filter((item) => item !== null) as AnyRecord[];
  }

  async discoverContent(kind?: string) {
    const now = new Date();
    const normalized = kind?.trim().toUpperCase();
    const supported = new Set(Object.values(AdContentSource));
    if (normalized && !supported.has(normalized as AdContentSource)) {
      throw new BadRequestException(
        `Unsupported content source. Supported values: ${[...supported].join(', ')}.`,
      );
    }

    const output: AnyRecord[] = [];
    const include = (source: AdContentSource) =>
      !normalized || normalized === source;

    if (include(AdContentSource.PREDICTION)) {
      const predictions = await this.marketModel
        .find({
          fixtureDate: { $gte: now },
          status: {
            $in: [PredictionStatus.CALCULATED, PredictionStatus.PARTIAL],
          },
          'selections.0': { $exists: true },
        })
        .sort({ fixtureDate: 1, generatedAt: -1 })
        .limit(150)
        .lean()
        .exec();
      for (const prediction of predictions as AnyRecord[]) {
        output.push(this.predictionDiscoveryItem(prediction));
      }
    }

    if (include(AdContentSource.SLIP) || include(AdContentSource.SURE_ODDS)) {
      const slips = await this.slipModel
        .find({
          status: SlipStatus.PUBLISHED,
          $or: [
            { fixtureDateTo: { $gte: now } },
            { fixtureDateTo: { $exists: false } },
            { fixtureDateTo: null },
          ],
        })
        .sort({ publishedAt: -1, createdAt: -1 })
        .limit(150)
        .lean()
        .exec();
      for (const slip of slips as AnyRecord[]) {
        const isSureOdds = this.isSureOdds(slip);
        const source = isSureOdds
          ? AdContentSource.SURE_ODDS
          : AdContentSource.SLIP;
        if (!include(source)) continue;
        output.push(this.slipDiscoveryItem(slip, source));
      }
    }

    if (
      include(AdContentSource.PROMO) ||
      include(AdContentSource.REFERRAL) ||
      include(AdContentSource.BONUS)
    ) {
      const promos = await this.promoModel
        .find({
          isActive: true,
          startDate: { $lte: now },
          endDate: { $gte: now },
        })
        .sort({ endDate: 1, createdAt: -1 })
        .limit(150)
        .lean()
        .exec();
      for (const promo of promos as AnyRecord[]) {
        for (const source of [
          AdContentSource.PROMO,
          AdContentSource.REFERRAL,
          AdContentSource.BONUS,
        ]) {
          if (include(source) && this.promoMatchesSource(promo, source)) {
            output.push(this.promoDiscoveryItem(promo, source));
          }
        }
      }
    }

    if (include(AdContentSource.SUBSCRIPTION)) {
      output.push(await this.getSubscriptionOfferContent());
    }
    if (include(AdContentSource.BET_LAB)) {
      output.push(this.getBetLabContent());
    }

    return {
      items: output,
      total: output.length,
      generatedAt: now.toISOString(),
      automationOptions: this.getAutomationOptions(),
    };
  }

  getAutomationOptions() {
    return [
      {
        key: AdAutomationKey.TOP_PREDICTION,
        source: AdContentSource.PREDICTION,
        title: 'Top prediction',
        resolves: 'Highest-ranked eligible stored market selection.',
      },
      {
        key: AdAutomationKey.TODAYS_SURE_ODDS,
        source: AdContentSource.SURE_ODDS,
        title: "Today's Sure Odds",
        resolves:
          'A published Sure Odds slip generated for the current WAT calendar day.',
      },
      {
        key: AdAutomationKey.FEATURED_SLIP,
        source: AdContentSource.SLIP,
        title: 'Featured prediction slip',
        resolves: 'Latest published future slip.',
      },
      {
        key: AdAutomationKey.AVAILABLE_BONUS,
        source: AdContentSource.BONUS,
        title: 'Available bonus',
        resolves:
          'Active public bonus/promo campaign; never a personal bonus grant.',
      },
      {
        key: AdAutomationKey.ACTIVE_PROMO,
        source: AdContentSource.PROMO,
        title: 'Active promotion',
        resolves: 'Active general promotion.',
      },
      {
        key: AdAutomationKey.REFERRAL_CAMPAIGN,
        source: AdContentSource.REFERRAL,
        title: 'Referral campaign',
        resolves: 'Active referral campaign.',
      },
      {
        key: AdAutomationKey.SUBSCRIPTION_OFFER,
        source: AdContentSource.SUBSCRIPTION,
        title: 'Subscription offer',
        resolves: 'Current prices and plan labels from plan configuration.',
      },
      {
        key: AdAutomationKey.BET_LAB_WELCOME_POINTS,
        source: AdContentSource.BET_LAB,
        title: 'Bet Lab welcome points',
        resolves:
          'Current registration bonus and plan allowances from Bet Lab configuration.',
      },
    ];
  }

  async preview(id: string, audienceInput: AdAudienceKey) {
    this.assertId(id);
    if (
      !['GUEST', 'FREE', 'REGULAR', 'VIP', 'PREMIUM'].includes(audienceInput)
    ) {
      throw new BadRequestException('Invalid preview audience.');
    }
    const ad = await this.adModel.findById(id).lean().exec();
    if (!ad) throw new NotFoundException('Advertisement not found.');
    const dynamic = await this.resolveLinkedContent(ad);
    if (!dynamic)
      return { available: false, audience: audienceInput, content: null };
    const visibility = this.visibilityFor(ad, audienceInput);
    return {
      available: true,
      audience: audienceInput,
      ad: this.publicAd(ad, visibility),
      content: this.projectContent(dynamic, visibility),
    };
  }

  async getPolicy(userId?: string) {
    const policy = this.normalizeExternalPolicy(await this.getOrCreatePolicy());
    const audience = await this.resolveAudience(userId);
    const audienceAllowed = policy.audiences[audience] === true;
    const enabledForCurrentAudience =
      policy.enabled &&
      audienceAllowed &&
      policy.frequency !== ExternalAdFrequency.NONE;
    return {
      external: {
        enabled: enabledForCurrentAudience,
        configuredEnabled: policy.enabled,
        enabledForCurrentAudience,
        audience,
        audiences: policy.audiences,
        frequency: policy.frequency,
        refreshIntervalSeconds: policy.refreshIntervalSeconds,
        maxImpressionsPerSession: policy.maxImpressionsPerSession,
        maxImpressionsPerDay: policy.maxImpressionsPerDay,
        allowedTypes: policy.allowedTypes,
        allowBanner: policy.allowBanner,
        allowNative: policy.allowNative,
        allowInterstitial: policy.allowInterstitial,
        allowPopup: policy.allowPopup,
        allowRewarded: policy.allowRewarded,
        allowSticky: policy.allowSticky,
        allowVideo: policy.allowVideo,
      },
    };
  }

  async getExternalPolicyAdmin() {
    return this.normalizeExternalPolicy(await this.getOrCreatePolicy());
  }

  async updateExternalPolicy(dto: ExternalAdPolicyDto, adminId: string) {
    this.assertObjectId(adminId, 'Invalid administrator ID.');
    this.validateExternalPolicy(dto);
    const current = this.normalizeExternalPolicy(
      await this.getOrCreatePolicy(),
    );
    const audiences = { ...current.audiences, ...(dto.audiences ?? {}) };
    const allowedTypes: Record<AdType, boolean> = {
      ...current.allowedTypes,
      ...(dto.allowedTypes ?? {}),
    };

    const legacyTypeFields: Array<[keyof ExternalAdPolicyDto, AdType]> = [
      ['allowBanner', AdType.BANNER],
      ['allowNative', AdType.NATIVE],
      ['allowInterstitial', AdType.INTERSTITIAL],
      ['allowPopup', AdType.POPUP],
      ['allowRewarded', AdType.REWARDED],
      ['allowSticky', AdType.STICKY],
      ['allowVideo', AdType.VIDEO],
    ];
    for (const [field, type] of legacyTypeFields) {
      const value = dto[field];
      if (typeof value === 'boolean') allowedTypes[type] = value;
    }

    const next: AnyRecord = {
      enabled: dto.enabled ?? current.enabled,
      audiences,
      frequency: dto.frequency ?? current.frequency,
      refreshIntervalSeconds: this.normalizeExternalRefreshInterval(
        dto.refreshIntervalSeconds ?? current.refreshIntervalSeconds,
      ),
      maxImpressionsPerSession:
        dto.maxImpressionsPerSession ?? current.maxImpressionsPerSession,
      maxImpressionsPerDay:
        dto.maxImpressionsPerDay ?? current.maxImpressionsPerDay,
      allowedTypes,
      allowBanner: allowedTypes[AdType.BANNER],
      allowNative: allowedTypes[AdType.NATIVE],
      allowInterstitial: allowedTypes[AdType.INTERSTITIAL],
      allowPopup: allowedTypes[AdType.POPUP],
      allowRewarded: allowedTypes[AdType.REWARDED],
      allowSticky: allowedTypes[AdType.STICKY],
      allowVideo: allowedTypes[AdType.VIDEO],
      updatedBy: adminId,
    };
    return this.normalizeExternalPolicy(
      await this.policyModel
        .findOneAndUpdate(
          { key: 'global' },
          { $set: next, $setOnInsert: { key: 'global' } },
          {
            upsert: true,
            returnDocument: 'after',
            setDefaultsOnInsert: true,
            runValidators: true,
          },
        )
        .lean()
        .exec(),
    );
  }

  async trackEvent(id: string, dto: TrackAdEventDto, userId?: string) {
    this.assertId(id);
    const ad = await this.adModel.findById(id).lean().exec();
    if (!ad) throw new NotFoundException('Advertisement not found.');
    if (
      dto.position &&
      !(ad.displays ?? []).some(
        (display: AnyRecord) => display.position === dto.position,
      )
    ) {
      throw new BadRequestException(
        'The event position is not configured for this advertisement.',
      );
    }
    if (
      dto.page &&
      !(ad.displays ?? []).some(
        (display: AnyRecord) => display.page === dto.page,
      )
    ) {
      throw new BadRequestException(
        'The event page is not configured for this advertisement.',
      );
    }
    const now = Date.now();
    const startsAt = ad.startDate
      ? new Date(ad.startDate).getTime()
      : Number.NEGATIVE_INFINITY;
    const endsAt = ad.endDate
      ? new Date(ad.endDate).getTime()
      : Number.POSITIVE_INFINITY;
    if (
      [AdEventType.IMPRESSION, AdEventType.CLICK, AdEventType.DISMISS].includes(
        dto.type,
      ) &&
      (!ad.isActive || startsAt > now || endsAt < now)
    ) {
      throw new NotFoundException('Advertisement is not currently active.');
    }
    if (dto.type === AdEventType.CONVERSION && !dto.conversionType) {
      throw new BadRequestException(
        'conversionType is required for conversion events.',
      );
    }
    const audience = await this.resolveAudience(userId);
    const visitorKeyHash = this.hashKey(dto.visitorKey);
    const sessionKeyHash = this.hashKey(dto.sessionKey);
    const event: AnyRecord = {
      adId: new Types.ObjectId(id),
      type: dto.type,
      eventKey: dto.eventKey,
      visitorKeyHash,
      sessionKeyHash,
      userId,
      placement: dto.placement ?? dto.position,
      page: dto.page,
      position: dto.position,
      device: dto.device,
      audience,
      conversionType: dto.conversionType,
      conversionValue: dto.conversionValue,
      currency: dto.currency,
      metadata: this.safeEventMetadata(dto.metadata),
    };
    try {
      await this.eventModel.create(event);
    } catch (error: any) {
      if (error?.code === 11000) return { success: true, duplicate: true };
      throw error;
    }

    const counter: Record<AdEventType, string | null> = {
      [AdEventType.IMPRESSION]: 'impressions',
      [AdEventType.CLICK]: 'clicks',
      [AdEventType.CONVERSION]: 'conversions',
      [AdEventType.DISMISS]: null,
    };
    const field = counter[dto.type];
    if (field)
      await this.adModel
        .updateOne({ _id: id }, { $inc: { [field]: 1 } })
        .exec();
    return { success: true, duplicate: false };
  }

  async recordImpression(
    id: string,
    eventKey?: string,
    visitorKey?: string,
    userId?: string,
    sessionKey?: string,
  ) {
    return this.trackEvent(
      id,
      {
        type: AdEventType.IMPRESSION,
        eventKey: eventKey || randomUUID(),
        visitorKey,
        sessionKey,
      },
      userId,
    );
  }

  async recordClick(
    id: string,
    eventKey?: string,
    visitorKey?: string,
    userId?: string,
    sessionKey?: string,
  ) {
    return this.trackEvent(
      id,
      {
        type: AdEventType.CLICK,
        eventKey: eventKey || randomUUID(),
        visitorKey,
        sessionKey,
      },
      userId,
    );
  }

  async getAnalytics(query: AdAnalyticsQueryDto = {}) {
    const match = this.buildEventDateMatch(query);
    const [
      totalAds,
      activeAds,
      grouped,
      conversionValueByCurrency,
      byDay,
      byPosition,
      byAudience,
      byPage,
      byDevice,
      topAds,
    ] = await Promise.all([
      this.adModel.countDocuments({}).exec(),
      this.adModel.countDocuments({ isActive: true }).exec(),
      this.eventModel
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: '$type',
              count: { $sum: 1 },
              conversionValue: { $sum: { $ifNull: ['$conversionValue', 0] } },
            },
          },
        ])
        .exec(),
      this.eventModel
        .aggregate([
          { $match: { ...match, type: AdEventType.CONVERSION } },
          {
            $group: {
              _id: { $ifNull: ['$currency', 'UNKNOWN'] },
              events: { $sum: 1 },
              value: { $sum: { $ifNull: ['$conversionValue', 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .exec(),
      this.eventModel
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$createdAt',
                  timezone: 'Africa/Lagos',
                },
              },
              impressions: {
                $sum: {
                  $cond: [{ $eq: ['$type', AdEventType.IMPRESSION] }, 1, 0],
                },
              },
              clicks: {
                $sum: { $cond: [{ $eq: ['$type', AdEventType.CLICK] }, 1, 0] },
              },
              conversions: {
                $sum: {
                  $cond: [{ $eq: ['$type', AdEventType.CONVERSION] }, 1, 0],
                },
              },
              dismissals: {
                $sum: {
                  $cond: [{ $eq: ['$type', AdEventType.DISMISS] }, 1, 0],
                },
              },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .exec(),
      this.eventModel
        .aggregate([
          { $match: { ...match, position: { $exists: true } } },
          {
            $group: {
              _id: '$position',
              events: { $sum: 1 },
              impressions: {
                $sum: {
                  $cond: [{ $eq: ['$type', AdEventType.IMPRESSION] }, 1, 0],
                },
              },
              clicks: {
                $sum: { $cond: [{ $eq: ['$type', AdEventType.CLICK] }, 1, 0] },
              },
              conversions: {
                $sum: {
                  $cond: [{ $eq: ['$type', AdEventType.CONVERSION] }, 1, 0],
                },
              },
            },
          },
          { $sort: { events: -1 } },
        ])
        .exec(),
      this.eventModel
        .aggregate([
          { $match: { ...match, audience: { $exists: true } } },
          {
            $group: {
              _id: '$audience',
              events: { $sum: 1 },
              impressions: {
                $sum: {
                  $cond: [{ $eq: ['$type', AdEventType.IMPRESSION] }, 1, 0],
                },
              },
              clicks: {
                $sum: { $cond: [{ $eq: ['$type', AdEventType.CLICK] }, 1, 0] },
              },
              conversions: {
                $sum: {
                  $cond: [{ $eq: ['$type', AdEventType.CONVERSION] }, 1, 0],
                },
              },
            },
          },
          { $sort: { events: -1 } },
        ])
        .exec(),
      this.eventModel
        .aggregate([
          { $match: { ...match, page: { $exists: true } } },
          {
            $group: {
              _id: '$page',
              events: { $sum: 1 },
              impressions: {
                $sum: {
                  $cond: [{ $eq: ['$type', AdEventType.IMPRESSION] }, 1, 0],
                },
              },
              clicks: {
                $sum: { $cond: [{ $eq: ['$type', AdEventType.CLICK] }, 1, 0] },
              },
              conversions: {
                $sum: {
                  $cond: [{ $eq: ['$type', AdEventType.CONVERSION] }, 1, 0],
                },
              },
            },
          },
          { $sort: { events: -1 } },
        ])
        .exec(),
      this.eventModel
        .aggregate([
          { $match: { ...match, device: { $exists: true } } },
          {
            $group: {
              _id: '$device',
              events: { $sum: 1 },
              impressions: {
                $sum: {
                  $cond: [{ $eq: ['$type', AdEventType.IMPRESSION] }, 1, 0],
                },
              },
              clicks: {
                $sum: { $cond: [{ $eq: ['$type', AdEventType.CLICK] }, 1, 0] },
              },
              conversions: {
                $sum: {
                  $cond: [{ $eq: ['$type', AdEventType.CONVERSION] }, 1, 0],
                },
              },
            },
          },
          { $sort: { events: -1 } },
        ])
        .exec(),
      this.eventModel
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: '$adId',
              impressions: {
                $sum: {
                  $cond: [{ $eq: ['$type', AdEventType.IMPRESSION] }, 1, 0],
                },
              },
              clicks: {
                $sum: { $cond: [{ $eq: ['$type', AdEventType.CLICK] }, 1, 0] },
              },
              conversions: {
                $sum: {
                  $cond: [{ $eq: ['$type', AdEventType.CONVERSION] }, 1, 0],
                },
              },
            },
          },
          { $sort: { impressions: -1, clicks: -1 } },
          { $limit: 10 },
          {
            $lookup: {
              from: 'ads',
              localField: '_id',
              foreignField: '_id',
              as: 'ad',
            },
          },
          { $unwind: { path: '$ad', preserveNullAndEmptyArrays: true } },
          {
            $project: {
              adId: { $toString: '$_id' },
              title: '$ad.title',
              type: '$ad.type',
              impressions: 1,
              clicks: 1,
              conversions: 1,
            },
          },
        ])
        .exec(),
    ]);
    const counts: EventCounts = {
      impressions: 0,
      clicks: 0,
      conversions: 0,
      dismissals: 0,
    };
    for (const row of grouped as AnyRecord[]) {
      if (row._id === AdEventType.IMPRESSION)
        counts.impressions = Number(row.count ?? 0);
      if (row._id === AdEventType.CLICK) counts.clicks = Number(row.count ?? 0);
      if (row._id === AdEventType.CONVERSION)
        counts.conversions = Number(row.count ?? 0);
      if (row._id === AdEventType.DISMISS)
        counts.dismissals = Number(row.count ?? 0);
    }
    return {
      totalAds,
      activeAds,
      ...counts,
      ctr: this.percentage(counts.clicks, counts.impressions),
      conversionRate: this.percentage(counts.conversions, counts.clicks),
      // Currency-separated values avoid summing NGN and USD as though they were interchangeable.
      conversionValueByCurrency,
      events: grouped,
      byType: grouped,
      byDay,
      byPosition,
      byAudience,
      byPage,
      byDevice,
      topAds,
      range: this.rangeDescription(query),
    };
  }

  async getAdAnalytics(id: string, query: AdAnalyticsQueryDto = {}) {
    this.assertId(id);
    const ad = await this.adModel
      .findById(id)
      .select({
        title: 1,
        type: 1,
        contentSource: 1,
        createdAt: 1,
        impressions: 1,
        clicks: 1,
        conversions: 1,
      })
      .lean()
      .exec();
    if (!ad) throw new NotFoundException('Advertisement not found.');
    const match = {
      ...this.buildEventDateMatch(query),
      adId: new Types.ObjectId(id),
    };
    const [
      grouped,
      conversionValueByCurrency,
      byDay,
      byAudience,
      byPosition,
      byPage,
      byDevice,
    ] = await Promise.all([
      this.eventModel
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: '$type',
              count: { $sum: 1 },
              conversionValue: { $sum: { $ifNull: ['$conversionValue', 0] } },
            },
          },
        ])
        .exec(),
      this.eventModel
        .aggregate([
          { $match: { ...match, type: AdEventType.CONVERSION } },
          {
            $group: {
              _id: { $ifNull: ['$currency', 'UNKNOWN'] },
              events: { $sum: 1 },
              value: { $sum: { $ifNull: ['$conversionValue', 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .exec(),
      this.eventModel
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$createdAt',
                  timezone: 'Africa/Lagos',
                },
              },
              impressions: {
                $sum: {
                  $cond: [{ $eq: ['$type', AdEventType.IMPRESSION] }, 1, 0],
                },
              },
              clicks: {
                $sum: { $cond: [{ $eq: ['$type', AdEventType.CLICK] }, 1, 0] },
              },
              conversions: {
                $sum: {
                  $cond: [{ $eq: ['$type', AdEventType.CONVERSION] }, 1, 0],
                },
              },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .exec(),
      this.eventModel
        .aggregate([
          { $match: match },
          { $group: { _id: '$audience', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ])
        .exec(),
      this.eventModel
        .aggregate([
          { $match: match },
          { $group: { _id: '$position', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ])
        .exec(),
      this.eventModel
        .aggregate([
          { $match: { ...match, page: { $exists: true } } },
          { $group: { _id: '$page', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ])
        .exec(),
      this.eventModel
        .aggregate([
          { $match: { ...match, device: { $exists: true } } },
          { $group: { _id: '$device', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ])
        .exec(),
    ]);
    const counts: EventCounts = {
      impressions: 0,
      clicks: 0,
      conversions: 0,
      dismissals: 0,
    };
    for (const row of grouped as AnyRecord[]) {
      if (row._id === AdEventType.IMPRESSION)
        counts.impressions = Number(row.count ?? 0);
      if (row._id === AdEventType.CLICK) counts.clicks = Number(row.count ?? 0);
      if (row._id === AdEventType.CONVERSION)
        counts.conversions = Number(row.count ?? 0);
      if (row._id === AdEventType.DISMISS)
        counts.dismissals = Number(row.count ?? 0);
    }
    return {
      ad,
      ...counts,
      adId: id,
      ctr: this.percentage(counts.clicks, counts.impressions),
      conversionRate: this.percentage(counts.conversions, counts.clicks),
      conversionValueByCurrency,
      events: grouped,
      byType: grouped,
      byDay,
      byAudience,
      byPosition,
      byPage,
      byDevice,
      range: this.rangeDescription(query),
    };
  }

  async getAdminEvents(query: AdEventQueryDto) {
    const filter: AnyRecord = {};
    if (query.type) filter.type = query.type;
    if (query.audience) filter.audience = query.audience;
    if (query.adPage) filter.page = query.adPage;
    if (query.position) filter.position = query.position;
    if (query.device) filter.device = query.device;
    if (query.conversionType) filter.conversionType = query.conversionType;
    if (query.adId) {
      this.assertId(query.adId);
      filter.adId = new Types.ObjectId(query.adId);
    }
    if (query.startDate || query.endDate) {
      filter.createdAt = {};
      if (query.startDate)
        filter.createdAt.$gte = this.parseDateBoundary(query.startDate, false);
      if (query.endDate)
        filter.createdAt.$lte = this.parseDateBoundary(query.endDate, true);
      if (
        query.startDate &&
        query.endDate &&
        this.parseDateBoundary(query.startDate, false) >
          this.parseDateBoundary(query.endDate, true)
      ) {
        throw new BadRequestException(
          'startDate must be before or equal to endDate.',
        );
      }
    }
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
    const [items, total] = await Promise.all([
      this.eventModel
        .find(filter)
        .populate('adId', 'title type contentSource')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.eventModel.countDocuments(filter).exec(),
    ]);
    return {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  private async resolveAudience(userId?: string): Promise<AdAudienceKey> {
    if (!userId) return 'GUEST';
    const plan = String(
      (await this.subscriptionsService.getUserPlan(userId)) || 'free',
    ).toLowerCase();
    if (plan === 'vip') return 'VIP';
    if (plan === 'premium') return 'PREMIUM';
    if (plan === 'regular') return 'REGULAR';
    return 'FREE';
  }

  private visibilityFor(
    ad: AnyRecord,
    audience: AdAudienceKey,
  ): AdContentVisibility {
    const defaults =
      audience === 'GUEST' || audience === 'FREE'
        ? GUEST_VISIBILITY
        : PAID_VISIBILITY;
    const configured = ad.contentVisibility?.[audience] as
      | AdContentVisibility
      | undefined;
    return { ...defaults, ...(configured ?? {}) };
  }

  private projectContent(
    source: AnyRecord,
    visibility: AdContentVisibility,
  ): AnyRecord {
    const out: AnyRecord = {};
    const hiddenNestedCollections = new Set([
      'legs',
      'marketSelections',
      'selections',
      'selectedMarkets',
    ]);
    for (const [key, value] of Object.entries(source ?? {})) {
      const requiredVisibility = FIELD_VISIBILITY[key];
      if (requiredVisibility && visibility[requiredVisibility] !== true)
        continue;
      if (
        hiddenNestedCollections.has(key) &&
        visibility.showMarketSelections !== true
      )
        continue;
      if (key === 'plans' && visibility.showSubscriptionPricing !== true)
        continue;
      if (
        key === 'monthlyAllowanceByPlan' &&
        visibility.showRewardValue !== true
      )
        continue;
      if (key === 'description' && visibility.showDescription !== true)
        continue;
      if (key === 'sportyBetSlipCode' && visibility.showSportyBetCode !== true)
        continue;
      if (Array.isArray(value)) {
        out[key] = value.map((item) =>
          this.isRecord(item) ? this.projectContent(item, visibility) : item,
        );
      } else if (this.isRecord(value)) {
        out[key] = this.projectContent(value, visibility);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  private async resolveLinkedContent(ad: AnyRecord): Promise<AnyRecord | null> {
    const sourceType = ad.contentSource as AdContentSource | undefined;
    if (!sourceType || sourceType === AdContentSource.CUSTOM) {
      return {
        title: ad.title,
        subTitle: ad.subTitle,
        description: ad.description,
        instructions: ad.instructions,
        image: ad.image,
        media: ad.media,
        actions: ad.actions,
      };
    }
    if (sourceType === AdContentSource.SUBSCRIPTION) {
      const content = await this.getSubscriptionOfferContent();
      return {
        ...content,
        title: ad.title || content.title,
        subTitle: ad.subTitle || content.subTitle,
        description: ad.description || content.description,
        image: ad.image,
        media: ad.media,
        actions: this.actionsForAd(ad, sourceType),
      };
    }
    if (sourceType === AdContentSource.BET_LAB) {
      const content = this.getBetLabContent();
      return {
        ...content,
        title: ad.title || content.title,
        subTitle: ad.subTitle || content.subTitle,
        description: ad.description || content.description,
        image: ad.image,
        media: ad.media,
        actions: this.actionsForAd(ad, sourceType),
      };
    }

    const id = String(ad.sourceId ?? '');
    const now = new Date();
    let source: AnyRecord | null = null;

    if (sourceType === AdContentSource.PREDICTION) {
      if (ad.automated && !id) {
        source =
          ad.automationKey === AdAutomationKey.TOP_PREDICTION
            ? await this.getTopPrediction(now)
            : await this.getNearestPrediction(now);
      } else if (id && Types.ObjectId.isValid(id)) {
        source = await this.marketModel
          .findOne({
            _id: id,
            fixtureDate: { $gte: now },
            status: {
              $in: [PredictionStatus.CALCULATED, PredictionStatus.PARTIAL],
            },
          })
          .lean()
          .exec();
      }
      if (!source) return null;
      const featuredSelection = this.selectFeaturedSelection(
        source.selections ?? [],
      );
      return {
        title: ad.title,
        subTitle: ad.subTitle,
        description: ad.description,
        homeTeamName: source.homeTeamName,
        awayTeamName: source.awayTeamName,
        leagueId: source.leagueId,
        fixtureDate: source.fixtureDate,
        marketName: source.marketName,
        marketKey: source.marketKey,
        featuredSelection: featuredSelection
          ? this.mapSelection(featuredSelection)
          : undefined,
        selectionCount: Array.isArray(source.selections)
          ? source.selections.length
          : 0,
        selections: (source.selections ?? []).map((selection: AnyRecord) =>
          this.mapSelection(selection),
        ),
        actions: this.actionsForAd(
          ad,
          sourceType,
          source.eventId,
          source.marketKey,
        ),
      };
    }

    if (
      sourceType === AdContentSource.SLIP ||
      sourceType === AdContentSource.SURE_ODDS
    ) {
      if (ad.automated && !id) {
        if (ad.automationKey === AdAutomationKey.TODAYS_SURE_ODDS) {
          source = await this.getTodaysSureOdds(now);
        } else {
          source = await this.getFeaturedSlip(
            now,
            sourceType === AdContentSource.SURE_ODDS,
          );
        }
      } else if (id && Types.ObjectId.isValid(id)) {
        source = await this.slipModel
          .findOne({ _id: id, status: SlipStatus.PUBLISHED })
          .lean()
          .exec();
        if (source && !this.slipHasFutureFixture(source, now)) source = null;
        if (
          source &&
          sourceType === AdContentSource.SURE_ODDS &&
          !this.isSureOdds(source)
        )
          source = null;
        if (
          source &&
          sourceType === AdContentSource.SLIP &&
          this.isSureOdds(source)
        )
          source = null;
      }
      if (!source || !this.slipHasFutureFixture(source, now)) return null;
      return {
        title: ad.title,
        subTitle: ad.subTitle || source.name,
        description: ad.description,
        productType: source.productType,
        sureOddsProduct: source.sureOddsProduct,
        sureOddsTier: source.sureOddsTier,
        combinedProbability: source.combinedProbability,
        averageConfidence: source.averageConfidence,
        generalConfidence: source.generalConfidence,
        combinedOdds: source.combinedOdds,
        combinedFairOdds: source.combinedFairOdds,
        legCount: source.legCount ?? source.legs?.length ?? 0,
        selectionCount: source.legs?.length ?? 0,
        requiredPlan: source.requiredPlan,
        fixtureDateFrom: source.fixtureDateFrom,
        fixtureDateTo: source.fixtureDateTo,
        sportyBetSlipCode: source.sportyBetSlipCode,
        sportyBetSlipLink: source.sportyBetSlipLink,
        legs: (source.legs ?? []).map((leg: AnyRecord) => ({
          eventId: leg.eventId,
          homeTeamName: leg.homeTeamName,
          awayTeamName: leg.awayTeamName,
          fixtureDate: leg.fixtureDate,
          marketKey: leg.marketKey,
          marketName: leg.marketName,
          selectionKey: leg.selectionKey,
          selectionName: leg.selectionName,
          probability: leg.probability,
          confidence: leg.confidence,
          fairOdds: leg.fairOdds,
          decimalOdds: leg.decimalOdds,
          bookmakerOdds: leg.bookmakerOdds,
        })),
        actions: this.actionsForAd(ad, sourceType, source._id),
      };
    }

    if (
      [
        AdContentSource.PROMO,
        AdContentSource.REFERRAL,
        AdContentSource.BONUS,
      ].includes(sourceType)
    ) {
      if (ad.automated && !id) {
        source = await this.getFeaturedPromo(sourceType, now);
      } else if (id && Types.ObjectId.isValid(id)) {
        source = await this.promoModel
          .findOne({
            _id: id,
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now },
          })
          .lean()
          .exec();
        if (source && !this.promoMatchesSource(source, sourceType))
          source = null;
      }
      if (!source) return null;
      return {
        title: ad.title,
        subTitle: ad.subTitle || source.name,
        description: ad.description || source.description,
        campaignName: source.name,
        purpose: source.purpose,
        campaignType: source.campaignType,
        promotionKind: source.promotionKind,
        requirement: source.requirement,
        rewardType: source.rewardType,
        rewardPlan: source.rewardPlan,
        rewardDurationDays: source.rewardDurationDays,
        pointsAmount: source.pointsAmount,
        discountType: source.discountType,
        discountValue: source.discountValue,
        minPurchaseAmount: source.minPurchaseAmount,
        maxDiscountAmount: source.maxDiscountAmount,
        amountCurrency: source.amountCurrency,
        eligiblePlans: source.eligiblePlans,
        promoCode: source.promoCode,
        endDate: source.endDate,
        actions: this.actionsForAd(ad, sourceType, source._id),
      };
    }
    return null;
  }

  private async getNearestPrediction(now: Date): Promise<AnyRecord | null> {
    return this.marketModel
      .findOne({
        fixtureDate: { $gte: now },
        status: {
          $in: [PredictionStatus.CALCULATED, PredictionStatus.PARTIAL],
        },
        'selections.0': { $exists: true },
      })
      .sort({ fixtureDate: 1, generatedAt: -1 })
      .lean()
      .exec();
  }

  private async getTopPrediction(now: Date): Promise<AnyRecord | null> {
    // Rank every eligible stored selection in MongoDB instead of only ranking a
    // small sample of the nearest fixtures. Ads does not recalculate predictions.
    const rows = await this.marketModel
      .aggregate([
        {
          $match: {
            fixtureDate: { $gte: now },
            status: {
              $in: [PredictionStatus.CALCULATED, PredictionStatus.PARTIAL],
            },
            'selections.0': { $exists: true },
          },
        },
        { $unwind: '$selections' },
        {
          $addFields: {
            _adsProbability: {
              $cond: [
                { $gt: [{ $ifNull: ['$selections.probability', 0] }, 0] },
                '$selections.probability',
                {
                  $divide: [
                    { $ifNull: ['$selections.probabilityPercent', 0] },
                    100,
                  ],
                },
              ],
            },
            _adsConfidence: { $ifNull: ['$selections.confidence', 0] },
          },
        },
        {
          $match: {
            _adsProbability: { $gt: 0, $lte: 1 },
            _adsConfidence: { $gt: 0 },
          },
        },
        {
          $addFields: {
            _adsRankScore: {
              $multiply: ['$_adsProbability', '$_adsConfidence'],
            },
          },
        },
        { $sort: { _adsRankScore: -1, fixtureDate: 1, generatedAt: -1 } },
        { $limit: 1 },
        {
          $project: { _adsProbability: 0, _adsConfidence: 0, _adsRankScore: 0 },
        },
      ])
      .exec();

    const best = (rows as AnyRecord[])[0];
    if (!best || !this.isRecord(best.selections)) return null;
    return { ...best, selections: [best.selections] };
  }

  private async getFeaturedSlip(
    now: Date,
    sureOnly: boolean,
  ): Promise<AnyRecord | null> {
    const rows = await this.slipModel
      .find({
        status: SlipStatus.PUBLISHED,
        $and: [
          {
            $or: [
              { fixtureDateTo: { $gte: now } },
              { fixtureDateTo: { $exists: false } },
              { fixtureDateTo: null },
            ],
          },
          ...(sureOnly
            ? [
                {
                  $or: [
                    { sureOdds: true },
                    { productType: SlipProductType.SURE_ODDS },
                  ],
                },
              ]
            : []),
        ],
      })
      .sort({ publishedAt: -1, createdAt: -1 })
      .limit(100)
      .lean()
      .exec();
    return (
      (rows as AnyRecord[]).find(
        (slip) =>
          this.slipHasFutureFixture(slip, now) &&
          (sureOnly ? this.isSureOdds(slip) : !this.isSureOdds(slip)),
      ) ?? null
    );
  }

  private async getTodaysSureOdds(now: Date): Promise<AnyRecord | null> {
    const dateKey = this.watDateKey(now);
    const rows = await this.slipModel
      .find({
        status: SlipStatus.PUBLISHED,
        $and: [
          {
            $or: [
              { fixtureDateTo: { $gte: now } },
              { fixtureDateTo: { $exists: false } },
              { fixtureDateTo: null },
            ],
          },
          {
            $or: [
              { sureOdds: true },
              { productType: SlipProductType.SURE_ODDS },
            ],
          },
        ],
        generatedDateKey: dateKey,
      })
      .sort({ publishedAt: -1, createdAt: -1 })
      .limit(20)
      .lean()
      .exec();
    return (
      (rows as AnyRecord[]).find(
        (slip) => this.isSureOdds(slip) && this.slipHasFutureFixture(slip, now),
      ) ?? null
    );
  }

  private async getFeaturedPromo(
    sourceType: AdContentSource,
    now: Date,
  ): Promise<AnyRecord | null> {
    const rows = await this.promoModel
      .find({
        isActive: true,
        startDate: { $lte: now },
        endDate: { $gte: now },
      })
      .sort({ endDate: 1, createdAt: -1 })
      .limit(100)
      .lean()
      .exec();
    return (
      (rows as AnyRecord[]).find((promo) =>
        this.promoMatchesSource(promo, sourceType),
      ) ?? null
    );
  }

  private async getSubscriptionOfferContent(): Promise<AnyRecord> {
    const config = await this.planConfigService.get();
    const labels = (config.planLabels ?? {}) as Record<string, string>;
    return {
      source: AdContentSource.SUBSCRIPTION,
      title: 'Explore subscription plans',
      description:
        'Compare plans and unlock the features available to each subscription tier.',
      plans: [
        {
          plan: 'regular',
          label: labels.regular || 'Regular Plan',
          priceNGN: config.regularPrice,
          priceUSD: config.regularPriceUSD,
          durationDays: 30,
        },
        {
          plan: 'vip',
          label: labels.vip || 'VIP Plan',
          priceNGN: config.vipPrice,
          priceUSD: config.vipPriceUSD,
          durationDays: 30,
        },
        {
          plan: 'premium',
          label: labels.premium || 'Premium Plan',
          priceNGN: config.premiumPrice,
          priceUSD: config.premiumPriceUSD,
          durationDays: 30,
        },
      ],
      destination: '/pricing',
      destinationUrl: '/pricing',
      defaultActionLabel: 'View Plans',
    };
  }

  private getBetLabContent(): AnyRecord {
    const config = BET_LAB_CONFIG.virtualPoints;
    return {
      source: AdContentSource.BET_LAB,
      title: 'Explore Bet Lab',
      description:
        'Try virtual football bets using points. Virtual points have no cash value.',
      welcomePoints: config.registrationBonus,
      monthlyAllowanceByPlan: { ...config.monthlyAllowanceByPlan },
      allowancePeriodDays: config.allowancePeriodDays,
      destination: '/bet-lab',
      destinationUrl: '/bet-lab',
      defaultActionLabel: 'Explore Bet Lab',
    };
  }

  private predictionDiscoveryItem(prediction: AnyRecord): AnyRecord {
    const selection = this.selectFeaturedSelection(prediction.selections ?? []);
    return {
      source: AdContentSource.PREDICTION,
      sourceId: String(prediction._id),
      destinationUrl: this.destinationFor(
        AdContentSource.PREDICTION,
        String(prediction.eventId),
        String(prediction.marketKey ?? ''),
      ),
      defaultActionLabel: 'View Prediction',
      title: `${prediction.homeTeamName} vs ${prediction.awayTeamName}`,
      subTitle: prediction.marketName,
      homeTeamName: prediction.homeTeamName,
      awayTeamName: prediction.awayTeamName,
      leagueId: prediction.leagueId,
      fixtureDate: prediction.fixtureDate,
      marketName: prediction.marketName,
      marketKey: prediction.marketKey,
      featuredSelection: selection ? this.mapSelection(selection) : undefined,
      selectionCount: Array.isArray(prediction.selections)
        ? prediction.selections.length
        : 0,
      eligibleForPromotion: true,
    };
  }

  private slipDiscoveryItem(
    slip: AnyRecord,
    source: AdContentSource,
  ): AnyRecord {
    return {
      source,
      sourceId: String(slip._id),
      destinationUrl: this.destinationFor(source, String(slip._id)),
      defaultActionLabel:
        source === AdContentSource.SURE_ODDS ? 'View Sure Odds' : 'View Slip',
      title: slip.name,
      subTitle: slip.sureOddsProduct || slip.productType,
      productType: slip.productType,
      sureOddsProduct: slip.sureOddsProduct,
      sureOddsTier: slip.sureOddsTier,
      fixtureDateFrom: slip.fixtureDateFrom,
      fixtureDateTo: slip.fixtureDateTo,
      combinedProbability: slip.combinedProbability,
      averageConfidence: slip.averageConfidence,
      generalConfidence: slip.generalConfidence,
      combinedOdds: slip.combinedOdds,
      combinedFairOdds: slip.combinedFairOdds,
      legCount: slip.legCount,
      selectionCount: slip.legs?.length ?? 0,
      requiredPlan: slip.requiredPlan,
      eligibleForPromotion: true,
    };
  }

  private promoDiscoveryItem(
    promo: AnyRecord,
    source: AdContentSource,
  ): AnyRecord {
    return {
      source,
      sourceId: String(promo._id),
      destinationUrl: this.destinationFor(source, String(promo._id)),
      defaultActionLabel:
        source === AdContentSource.REFERRAL
          ? 'Refer & Earn'
          : source === AdContentSource.BONUS
            ? 'Get Bonus'
            : 'View Promotion',
      title: promo.name,
      description: promo.description,
      purpose: promo.purpose,
      campaignType: promo.campaignType,
      promotionKind: promo.promotionKind,
      requirement: promo.requirement,
      rewardType: promo.rewardType,
      rewardPlan: promo.rewardPlan,
      rewardDurationDays: promo.rewardDurationDays,
      pointsAmount: promo.pointsAmount,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      eligiblePlans: promo.eligiblePlans,
      startDate: promo.startDate,
      endDate: promo.endDate,
      promoCode: promo.promoCode,
      eligibleForPromotion: true,
    };
  }

  private actionsForAd(
    ad: AnyRecord,
    source: AdContentSource,
    sourceId?: string,
    marketKey?: string,
  ): AnyRecord[] {
    if (Array.isArray(ad.actions) && ad.actions.length > 0) return ad.actions;
    const labelBySource: Record<AdContentSource, string> = {
      [AdContentSource.CUSTOM]: 'Learn More',
      [AdContentSource.PREDICTION]: 'View Prediction',
      [AdContentSource.SLIP]: 'View Slip',
      [AdContentSource.SURE_ODDS]: 'View Sure Odds',
      [AdContentSource.PROMO]: 'View Promotion',
      [AdContentSource.BONUS]: 'Get Bonus',
      [AdContentSource.REFERRAL]: 'Refer & Earn',
      [AdContentSource.SUBSCRIPTION]: 'View Plans',
      [AdContentSource.BET_LAB]: 'Explore Bet Lab',
    };
    return [
      {
        label: labelBySource[source] ?? 'Learn More',
        url: this.destinationFor(source, sourceId, marketKey),
      },
    ];
  }

  private destinationFor(
    source: AdContentSource,
    sourceId?: string,
    marketKey?: string,
  ): string {
    const rawId = sourceId ? String(sourceId) : undefined;
    const id = rawId ? encodeURIComponent(rawId) : undefined;
    switch (source) {
      case AdContentSource.PREDICTION: {
        const query = new URLSearchParams();
        // URLSearchParams performs encoding itself; pre-encoding would double-encode IDs.
        if (rawId) query.set('eventId', rawId);
        if (marketKey) query.set('marketKey', marketKey);
        const params = query.toString();
        return params ? `/pick-center?${params}` : '/pick-center';
      }
      case AdContentSource.SLIP:
      case AdContentSource.SURE_ODDS:
        return id ? `/slip-center?slipId=${id}` : '/slip-center';
      case AdContentSource.PROMO:
        return id ? `/promos?promoId=${id}` : '/promos';
      case AdContentSource.BONUS:
        return id ? `/bonuses?promoId=${id}` : '/bonuses';
      case AdContentSource.REFERRAL:
        return id ? `/referrals?campaignId=${id}` : '/referrals';
      case AdContentSource.SUBSCRIPTION:
        return '/pricing';
      case AdContentSource.BET_LAB:
        return '/bet-lab';
      case AdContentSource.CUSTOM:
      default:
        return '/';
    }
  }

  private selectFeaturedSelection(selections: AnyRecord[]): AnyRecord | null {
    if (!Array.isArray(selections) || !selections.length) return null;
    const valid = selections.filter((selection) => {
      const p = Number(
        selection.probability ?? Number(selection.probabilityPercent) / 100,
      );
      const confidence = Number(selection.confidence ?? 0);
      return (
        Number.isFinite(p) &&
        p > 0 &&
        p <= 1 &&
        Number.isFinite(confidence) &&
        confidence > 0
      );
    });
    valid.sort((a, b) => {
      const ap = Number(a.probability ?? Number(a.probabilityPercent) / 100);
      const bp = Number(b.probability ?? Number(b.probabilityPercent) / 100);
      return bp * Number(b.confidence ?? 0) - ap * Number(a.confidence ?? 0);
    });
    return valid[0] ?? null;
  }

  private mapSelection(selection: AnyRecord): AnyRecord {
    return {
      selectionKey: selection.key,
      selectionName: selection.fullName,
      selectionAbbreviation: selection.abbreviation,
      line: selection.line,
      subjectName: selection.subjectName,
      probability: selection.probability,
      probabilityPercent: selection.probabilityPercent,
      confidence: selection.confidence,
      fairOdds: selection.fairOdds,
      bookmakerOdds: selection.bookmakerOdds,
      decimalOdds: selection.decimalOdds,
      priceType: selection.priceType,
    };
  }

  private promoMatchesSource(
    promo: AnyRecord,
    source: AdContentSource,
  ): boolean {
    const referral =
      String(promo.campaignType).toLowerCase() === PromoCampaignType.REFERRAL ||
      String(promo.purpose).toLowerCase() === PromoPurpose.REFERRAL;
    const bonus =
      String(promo.rewardType).toLowerCase() === RewardType.BET_LAB_POINTS ||
      (String(promo.promotionKind).toLowerCase() ===
        PromoPromotionKind.REWARD &&
        !referral);
    if (source === AdContentSource.REFERRAL) return referral;
    if (source === AdContentSource.BONUS) return bonus;
    if (source === AdContentSource.PROMO) return !referral && !bonus;
    return false;
  }

  private isSureOdds(slip: AnyRecord): boolean {
    return (
      Boolean(slip.sureOdds) || slip.productType === SlipProductType.SURE_ODDS
    );
  }

  private slipHasFutureFixture(slip: AnyRecord, now: Date): boolean {
    const endDate = slip.fixtureDateTo ? new Date(slip.fixtureDateTo) : null;
    if (endDate && Number.isFinite(endDate.getTime()))
      return endDate.getTime() >= now.getTime();
    return (
      Array.isArray(slip.legs) &&
      slip.legs.some((leg: AnyRecord) => {
        const date = new Date(leg.fixtureDate);
        return (
          Number.isFinite(date.getTime()) && date.getTime() >= now.getTime()
        );
      })
    );
  }

  private matchesTargeting(
    targeting: AdTargeting | undefined,
    audience: AdAudienceKey,
    authenticated: boolean,
  ): boolean {
    if (!targeting) return true;
    if (targeting.requireAuthenticated && !authenticated) return false;
    if (targeting.guestsOnly && audience !== 'GUEST') return false;
    if (
      targeting.allowedPlans?.length &&
      !targeting.allowedPlans.includes(audience)
    )
      return false;
    if (targeting.excludedPlans?.includes(audience)) return false;
    return true;
  }

  private isTriggerEventCompatible(
    trigger: AdTrigger,
    event: AdTriggerEvent,
  ): boolean {
    if (trigger === AdTrigger.ON_LOGIN) return event === AdTriggerEvent.LOGIN;
    if (trigger === AdTrigger.ON_REFRESH)
      return event === AdTriggerEvent.REFRESH;
    if (trigger === AdTrigger.EVERY_VISIT)
      return event === AdTriggerEvent.VISIT;
    return true;
  }

  private isTriggerSatisfied(
    trigger: AdTrigger,
    event: AdTriggerEvent,
    adId: string,
    context: TriggerContext,
    sessionKeyHash?: string,
  ): boolean {
    if (trigger === AdTrigger.ON_LOGIN) return event === AdTriggerEvent.LOGIN;
    if (trigger === AdTrigger.ON_REFRESH)
      return event === AdTriggerEvent.REFRESH;
    if (trigger === AdTrigger.EVERY_VISIT)
      return event === AdTriggerEvent.VISIT;
    if (trigger === AdTrigger.FIRST_VISIT)
      return context.hasIdentity && !context.firstSeen.has(adId);
    if (trigger === AdTrigger.ONCE_PER_DAY)
      return context.hasIdentity && (context.todayCounts.get(adId) ?? 0) === 0;
    if (trigger === AdTrigger.ONCE_PER_SESSION) {
      if (!context.hasIdentity || !sessionKeyHash) return false;
      return !context.sessionSeen.has(`${adId}:${sessionKeyHash}`);
    }
    return true;
  }

  private buildAdFilter(query?: AdListQueryDto): AnyRecord {
    const filter: AnyRecord = {};
    if (!query) return filter;
    if (query.active !== undefined) filter.isActive = query.active;
    if (query.type) filter.type = query.type;
    if (query.contentSource) filter.contentSource = query.contentSource;
    if (query.audience) filter.audience = query.audience;
    const displayFilter: AnyRecord = {};
    if (query.displayPage) displayFilter.page = query.displayPage;
    if (query.position) displayFilter.position = query.position;
    if (query.device) displayFilter.device = query.device;
    if (Object.keys(displayFilter).length)
      filter.displays = { $elemMatch: displayFilter };
    if (query.search?.trim()) {
      const regex = new RegExp(this.escapeRegex(query.search.trim()), 'i');
      filter.$or = [
        { title: regex },
        { subTitle: regex },
        { description: regex },
      ];
    }
    return filter;
  }

  private buildEventDateMatch(query: AdAnalyticsQueryDto): AnyRecord {
    const dateRange: AnyRecord = {};
    const now = new Date();
    if (query.startDate)
      dateRange.$gte = this.parseDateBoundary(query.startDate, false);
    else {
      const days = Math.min(365, Math.max(1, Number(query.days) || 30));
      dateRange.$gte = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    }
    if (query.endDate)
      dateRange.$lte = this.parseDateBoundary(query.endDate, true);
    if (
      query.startDate &&
      query.endDate &&
      this.parseDateBoundary(query.startDate, false) >
        this.parseDateBoundary(query.endDate, true)
    ) {
      throw new BadRequestException(
        'startDate must be before or equal to endDate.',
      );
    }
    return { createdAt: dateRange };
  }

  /** Date-only filters represent WAT calendar days; timestamp filters keep their supplied instant. */
  private parseDateBoundary(value: string, endOfDay: boolean): Date {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const utcMidnight = Date.parse(`${value}T00:00:00.000Z`);
      if (!Number.isFinite(utcMidnight)) return new Date(value);
      const watMidnightUtc = utcMidnight - 60 * 60 * 1000;
      return new Date(
        watMidnightUtc + (endOfDay ? 24 * 60 * 60 * 1000 - 1 : 0),
      );
    }
    return new Date(value);
  }

  private rangeDescription(query: AdAnalyticsQueryDto) {
    return {
      startDate:
        query.startDate ??
        new Date(
          Date.now() -
            Math.min(365, Math.max(1, Number(query.days) || 30)) * 86400000,
        ).toISOString(),
      endDate: query.endDate ?? new Date().toISOString(),
      timezone: 'Africa/Lagos',
    };
  }

  private normalizeExternalRefreshInterval(value: unknown): number {
    const configured = Number(value ?? 300);
    // Zero explicitly disables timed refresh. Any positive interval is at least five minutes.
    if (configured === 0) return 0;
    if (!Number.isFinite(configured)) return 300;
    return Math.min(3600, Math.max(300, Math.floor(configured)));
  }

  private normalizeExternalPolicy(policy: AnyRecord): AnyRecord {
    const allowedTypes: Record<AdType, boolean> = {
      ...DEFAULT_EXTERNAL_TYPES,
      ...(policy?.allowedTypes ?? {}),
    };
    // Honor legacy per-format switches while normalizing documents created before allowedTypes existed.
    if (
      typeof policy?.allowBanner === 'boolean' &&
      policy?.allowedTypes?.[AdType.BANNER] === undefined
    )
      allowedTypes[AdType.BANNER] = policy.allowBanner;
    if (
      typeof policy?.allowNative === 'boolean' &&
      policy?.allowedTypes?.[AdType.NATIVE] === undefined
    )
      allowedTypes[AdType.NATIVE] = policy.allowNative;
    if (
      typeof policy?.allowInterstitial === 'boolean' &&
      policy?.allowedTypes?.[AdType.INTERSTITIAL] === undefined
    )
      allowedTypes[AdType.INTERSTITIAL] = policy.allowInterstitial;
    if (
      typeof policy?.allowPopup === 'boolean' &&
      policy?.allowedTypes?.[AdType.POPUP] === undefined
    )
      allowedTypes[AdType.POPUP] = policy.allowPopup;
    if (
      typeof policy?.allowRewarded === 'boolean' &&
      policy?.allowedTypes?.[AdType.REWARDED] === undefined
    )
      allowedTypes[AdType.REWARDED] = policy.allowRewarded;
    if (
      typeof policy?.allowSticky === 'boolean' &&
      policy?.allowedTypes?.[AdType.STICKY] === undefined
    )
      allowedTypes[AdType.STICKY] = policy.allowSticky;
    if (
      typeof policy?.allowVideo === 'boolean' &&
      policy?.allowedTypes?.[AdType.VIDEO] === undefined
    )
      allowedTypes[AdType.VIDEO] = policy.allowVideo;
    return {
      key: 'global',
      enabled: policy?.enabled ?? true,
      audiences: {
        GUEST: true,
        FREE: true,
        REGULAR: true,
        VIP: false,
        PREMIUM: false,
        ...(policy?.audiences ?? {}),
      },
      frequency: policy?.frequency ?? ExternalAdFrequency.NORMAL,
      refreshIntervalSeconds: this.normalizeExternalRefreshInterval(policy?.refreshIntervalSeconds),
      maxImpressionsPerSession: policy?.maxImpressionsPerSession ?? 3,
      maxImpressionsPerDay: policy?.maxImpressionsPerDay ?? 20,
      allowedTypes,
      allowBanner: allowedTypes[AdType.BANNER],
      allowNative: allowedTypes[AdType.NATIVE],
      allowInterstitial: allowedTypes[AdType.INTERSTITIAL],
      allowPopup: allowedTypes[AdType.POPUP],
      allowRewarded: allowedTypes[AdType.REWARDED],
      allowSticky: allowedTypes[AdType.STICKY],
      allowVideo: allowedTypes[AdType.VIDEO],
      updatedBy: policy?.updatedBy,
      updatedAt: policy?.updatedAt,
    };
  }

  private async getOrCreatePolicy(): Promise<AnyRecord> {
    return this.policyModel
      .findOneAndUpdate(
        { key: 'global' },
        { $setOnInsert: { key: 'global' } },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      )
      .lean()
      .exec();
  }

  private validateExternalPolicy(dto: ExternalAdPolicyDto): void {
    const allowedAudienceKeys = new Set([
      'GUEST',
      'FREE',
      'REGULAR',
      'VIP',
      'PREMIUM',
    ]);
    if (dto.audiences) {
      for (const [key, value] of Object.entries(dto.audiences)) {
        if (!allowedAudienceKeys.has(key) || typeof value !== 'boolean') {
          throw new BadRequestException(
            `Invalid external ad audience setting: ${key}.`,
          );
        }
      }
    }
    if (dto.allowedTypes) {
      for (const [key, value] of Object.entries(dto.allowedTypes)) {
        if (
          !Object.values(AdType).includes(key as AdType) ||
          typeof value !== 'boolean'
        ) {
          throw new BadRequestException(
            `Invalid external ad type setting: ${key}.`,
          );
        }
      }
    }
  }

  private validateAdPayload(dto: CreateAdDto, existing?: AnyRecord): void {
    this.validateDates(dto.startDate, dto.endDate);
    const source =
      dto.contentSource ?? existing?.contentSource ?? AdContentSource.CUSTOM;
    const automated = dto.automated ?? existing?.automated ?? false;
    const sourceId = dto.sourceId ?? existing?.sourceId;
    const automationKey = dto.automationKey ?? existing?.automationKey;
    const type = dto.type ?? existing?.type ?? AdType.BANNER;
    const media = dto.media ?? existing?.media;

    if (
      source === AdContentSource.CUSTOM &&
      (sourceId || automated || automationKey)
    ) {
      throw new BadRequestException(
        'Custom ads cannot specify a linked source, automation key, or automated delivery.',
      );
    }
    if (
      ![
        AdContentSource.CUSTOM,
        AdContentSource.SUBSCRIPTION,
        AdContentSource.BET_LAB,
      ].includes(source) &&
      !sourceId &&
      !automated
    ) {
      throw new BadRequestException(
        'A sourceId is required for a manually linked content ad.',
      );
    }
    if (automated && !automationKey) {
      throw new BadRequestException(
        'Select an automationKey for an automated advertisement.',
      );
    }
    if (!automated && automationKey) {
      throw new BadRequestException(
        'automationKey can only be used when automated delivery is enabled.',
      );
    }
    if (
      [AdContentSource.SUBSCRIPTION, AdContentSource.BET_LAB].includes(
        source,
      ) &&
      sourceId
    ) {
      throw new BadRequestException(
        'Subscription and Bet Lab content resolve from current configuration and do not accept sourceId.',
      );
    }
    if (automated && sourceId) {
      throw new BadRequestException(
        'Automated ads resolve their source dynamically; omit sourceId.',
      );
    }
    if (
      sourceId &&
      ![AdContentSource.SUBSCRIPTION, AdContentSource.BET_LAB].includes(
        source,
      ) &&
      !Types.ObjectId.isValid(String(sourceId))
    ) {
      throw new BadRequestException(
        'sourceId must be a valid ID for the selected content source.',
      );
    }
    if (
      automationKey &&
      AUTOMATION_SOURCE[automationKey as AdAutomationKey] !== source
    ) {
      throw new BadRequestException(
        `Automation key ${automationKey} must use content source ${AUTOMATION_SOURCE[automationKey as AdAutomationKey]}.`,
      );
    }
    if (
      type === AdType.VIDEO &&
      (!media || String(media.type).toUpperCase() !== 'VIDEO')
    ) {
      throw new BadRequestException(
        'Video ads require a media object with type VIDEO and a video URL.',
      );
    }
    if (media && String(media.type).toUpperCase() === 'VIDEO' && !media.url) {
      throw new BadRequestException('Video media requires a URL.');
    }
    this.validateContentVisibility(
      dto.contentVisibility ?? existing?.contentVisibility,
    );
    this.validateTargeting(dto.targeting ?? existing?.targeting);
  }

  private validateContentVisibility(value: unknown): void {
    if (value === undefined || value === null) return;
    if (!this.isRecord(value))
      throw new BadRequestException(
        'contentVisibility must be an audience-to-visibility object.',
      );
    const audiences = new Set(['GUEST', 'FREE', 'REGULAR', 'VIP', 'PREMIUM']);
    const fields = new Set(Object.keys(PAID_VISIBILITY));
    for (const [audience, settings] of Object.entries(value)) {
      if (!audiences.has(audience) || !this.isRecord(settings))
        throw new BadRequestException(
          `Invalid contentVisibility audience: ${audience}.`,
        );
      for (const [field, enabled] of Object.entries(settings)) {
        if (!fields.has(field) || typeof enabled !== 'boolean') {
          throw new BadRequestException(
            `Invalid content visibility field or value: ${audience}.${field}.`,
          );
        }
      }
    }
  }

  private validateTargeting(value: unknown): void {
    if (value === undefined || value === null) return;
    if (!this.isRecord(value))
      throw new BadRequestException('targeting must be an object.');
    const plans = new Set(['GUEST', 'FREE', 'REGULAR', 'VIP', 'PREMIUM']);
    for (const field of ['allowedPlans', 'excludedPlans']) {
      const list = value[field];
      if (
        list !== undefined &&
        (!Array.isArray(list) || list.some((plan) => !plans.has(plan)))
      ) {
        throw new BadRequestException(
          `targeting.${field} must contain only known audience tiers.`,
        );
      }
    }
    for (const field of ['requireAuthenticated', 'guestsOnly']) {
      if (value[field] !== undefined && typeof value[field] !== 'boolean') {
        throw new BadRequestException(`targeting.${field} must be a boolean.`);
      }
    }
  }

  private publicAd(ad: AnyRecord, visibility: AdContentVisibility): AnyRecord {
    const publicSafe: AnyRecord = { ...ad };
    for (const key of [
      'createdBy',
      'updatedBy',
      'sourceId',
      'contentVisibility',
      'targeting',
      'automationKey',
      'audience',
      'impressions',
      'clicks',
      'conversions',
      'maxImpressionsPerVisitorPerDay',
      'isActive',
      'startDate',
      'endDate',
      'priority',
      'automated',
      'contentSource',
    ])
      delete publicSafe[key];
    if (visibility.showDescription !== true) delete publicSafe.description;
    return publicSafe;
  }

  private buildTriggerContext(
    events: AnyRecord[],
    currentSessionHash: string | undefined,
    now: Date,
    hasIdentity: boolean,
  ): TriggerContext {
    const firstSeen = new Set<string>();
    const todayCounts = new Map<string, number>();
    const sessionSeen = new Set<string>();
    const startOfDay = this.watDayStartUtc(now).getTime();
    for (const event of events) {
      const id = String(event.adId);
      firstSeen.add(id);
      const createdAt = event.createdAt
        ? new Date(event.createdAt).getTime()
        : 0;
      if (createdAt >= startOfDay)
        todayCounts.set(id, (todayCounts.get(id) ?? 0) + 1);
      if (currentSessionHash && event.sessionKeyHash === currentSessionHash)
        sessionSeen.add(`${id}:${currentSessionHash}`);
    }
    return { firstSeen, todayCounts, sessionSeen, hasIdentity };
  }

  private watDayStartUtc(date: Date): Date {
    const local = new Date(date.getTime() + 60 * 60 * 1000);
    return new Date(
      Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate(),
      ) -
        60 * 60 * 1000,
    );
  }

  private watDateKey(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Lagos',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (type: string) =>
      parts.find((part) => part.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  private hashKey(value?: string): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    return createHash('sha256').update(trimmed).digest('hex');
  }

  private safeEventMetadata(
    metadata?: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!metadata) return {};
    const allowed = new Set([
      'campaignId',
      'experimentId',
      'variant',
      'source',
      'destination',
      'clientTimestamp',
    ]);
    return Object.fromEntries(
      Object.entries(metadata)
        .filter(
          ([key, value]) =>
            allowed.has(key) &&
            ['string', 'number', 'boolean'].includes(typeof value),
        )
        .slice(0, 10),
    );
  }

  private async safeDeleteImage(publicId: string): Promise<void> {
    try {
      await this.uploadsService.deleteImage(publicId);
    } catch {
      // The database mutation has already succeeded. A failed Cloudinary cleanup must not undo it.
    }
  }

  private validateDates(
    start?: string | Date | null,
    end?: string | Date | null,
  ): void {
    if (start && Number.isNaN(new Date(start).getTime()))
      throw new BadRequestException('Invalid startDate.');
    if (end && Number.isNaN(new Date(end).getTime()))
      throw new BadRequestException('Invalid endDate.');
    if (start && end && new Date(start).getTime() > new Date(end).getTime()) {
      throw new BadRequestException(
        'startDate must be before or equal to endDate.',
      );
    }
  }

  private assertId(id: string): void {
    this.assertObjectId(id, 'Invalid advertisement ID.');
  }

  private assertObjectId(id: string, message: string): void {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException(message);
  }

  private isRecord(value: unknown): value is AnyRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private percentage(numerator: number, denominator: number): number {
    return denominator > 0
      ? Number(((numerator / denominator) * 100).toFixed(2))
      : 0;
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
