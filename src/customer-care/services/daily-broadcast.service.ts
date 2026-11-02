import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { CuratedPredictionService } from '../../predictions-engine/services/curated-prediction.service';
import { PromosService } from '../../promos/promos.service';
import { TelegramService } from '../../telegram/telegram.service';
import { SupportActionAudit } from '../schemas/support-action-audit.schema';
import { CustomerCareBroadcast } from '../schemas/customer-care-broadcast.schema';
import { GroqAssistantService, CreativeCopy } from './groq-assistant.service';

@Injectable()
export class DailyBroadcastService {
  private readonly logger = new Logger(DailyBroadcastService.name);
  private readonly frontendUrl: string;
  private readonly predictionsUrl: string;
  private readonly promotionsUrl: string;
  private readonly maxOddsAgeHours: number;

  constructor(
    private readonly curatedPredictions: CuratedPredictionService,
    private readonly promos: PromosService,
    private readonly telegram: TelegramService,
    private readonly groq: GroqAssistantService,
    private readonly config: ConfigService,
    @InjectModel(CustomerCareBroadcast.name)
    private readonly broadcasts: Model<CustomerCareBroadcast>,
    @InjectModel(SupportActionAudit.name)
    private readonly audits: Model<SupportActionAudit>,
  ) {
    this.frontendUrl = (
      this.config.get<string>('FRONTEND_URL') || 'https://www.2xpredict.com'
    ).replace(/\/$/, '');
    this.predictionsUrl =
      this.config.get<string>('CUSTOMER_CARE_PREDICTIONS_URL') ||
      `${this.frontendUrl}/predictions`;
    this.promotionsUrl =
      this.config.get<string>('CUSTOMER_CARE_PROMOTIONS_URL') ||
      `${this.frontendUrl}/promos`;
    const oddsAge = Number(
      this.config.get<string>('CUSTOMER_CARE_MAX_ODDS_AGE_HOURS') ?? 12,
    );
    this.maxOddsAgeHours =
      Number.isFinite(oddsAge) && oddsAge > 0 ? Math.min(72, oddsAge) : 12;
  }

  async publishDailyPicks(dateKey: string): Promise<Record<string, unknown>> {
    const existing = await this.broadcasts
      .findOne({ kind: 'DAILY_PICKS', dateKey, sourceKey: 'daily' })
      .exec();
    if (existing?.status === 'SENT' || existing?.status === 'SKIPPED')
      return {
        skipped: true,
        reason: `ALREADY_${existing.status}`,
        broadcastId: String(existing._id),
      };
    if (existing?.manualReviewRequired)
      return {
        skipped: true,
        requiresAdminReview: true,
        reason: 'DELIVERY_OUTCOME_REQUIRES_ADMIN_CONFIRMATION',
        broadcastId: String(existing._id),
      };
    if (existing?.status === 'SENDING') {
      const ageMs = Date.now() - toDate((existing as any).updatedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs > 5 * 60_000) {
        existing.status = 'FAILED';
        existing.manualReviewRequired = true;
        existing.lastError =
          'A prior send was interrupted after Telegram delivery began. Check the public channel before retrying.';
        await existing.save();
        return {
          skipped: true,
          requiresAdminReview: true,
          reason: 'STALE_SEND_STATE',
          broadcastId: String(existing._id),
        };
      }
      return {
        deferred: true,
        reason: 'SEND_ALREADY_IN_PROGRESS',
        broadcastId: String(existing._id),
      };
    }
    const broadcast =
      existing ??
      (await this.broadcasts.create({
        kind: 'DAILY_PICKS',
        dateKey,
        sourceKey: 'daily',
        status: 'GENERATING',
        attempts: 0,
      }));
    const attempt = Number(broadcast.attempts || 0) + 1;
    broadcast.attempts = attempt;
    broadcast.status = 'GENERATING';
    broadcast.manualReviewRequired = false;
    broadcast.lastError = '';
    await broadcast.save();
    let telegramAccepted = false;

    try {
      const { start, end } = lagosDayRange(dateKey);
      const candidates =
        (await this.curatedPredictions.listPublishedForDateRange(
          start,
          end,
          200,
        )) as any[];
      const eligible = candidates.filter((item: any) =>
        isEligibleBroadcastPrediction(item, start, end),
      );

      // Reuse the ranking values already carried from Pick Center. This service
      // does not calculate a second prediction score or modify prediction records.
      eligible.sort(
        (a: any, b: any) =>
          existingRanking(b) - existingRanking(a) ||
          Number(b.confidence || 0) - Number(a.confidence || 0),
      );
      const picks = eligible
        .slice(0, 3)
        .map((item: any) =>
          normalizePick(item, this.predictionsUrl, this.maxOddsAgeHours),
        );
      if (!picks.length) {
        broadcast.sourceReferences = [];
        if (attempt < 8) {
          broadcast.status = 'GENERATING';
          broadcast.skipReason =
            'No eligible curated predictions are available yet; a bounded readiness retry is scheduled.';
          await broadcast.save();
          return {
            deferred: true,
            retryAfterMs: 30 * 60_000,
            reason: 'NO_ELIGIBLE_DAILY_PICKS',
            broadcastId: String(broadcast._id),
          };
        }
        broadcast.status = 'SKIPPED';
        broadcast.skipReason =
          'No published, unsettled curated predictions qualified for the Lagos calendar date after bounded readiness checks.';
        await broadcast.save();
        return { skipped: true, reason: broadcast.skipReason };
      }

      const recent = await this.recentExamples('DAILY_PICKS', dateKey);
      const copy = await this.generateUniqueCopy(
        'DAILY_PICKS',
        dateKey,
        { picks },
        recent,
      );
      const content = renderPicksMessage(copy, picks, this.frontendUrl);
      broadcast.content = content.slice(0, 3900);
      broadcast.styleTag = copy.styleTag;
      broadcast.sourceReferences = picks
        .map((pick) => pick.predictionCode)
        .filter(Boolean);
      broadcast.status = 'READY';
      await broadcast.save();

      broadcast.status = 'SENDING';
      await broadcast.save();
      const delivery = await this.telegram.sendPublicChannelMessage(
        broadcast.content,
      );
      if (!delivery.success && delivery.deliveryUnknown) {
        broadcast.status = 'FAILED';
        broadcast.manualReviewRequired = true;
        broadcast.lastError =
          'Telegram delivery outcome is unknown. Check the public channel before retrying.';
        await broadcast.save();
        await this.writeAudit(
          'daily_picks_broadcast',
          'FAILED',
          broadcast.lastError,
          { dateKey, attempt },
        ).catch(() => undefined);
        return {
          sent: false,
          requiresAdminReview: true,
          broadcastId: String(broadcast._id),
        };
      }
      if (!delivery.success)
        throw new Error(
          'Telegram public-channel delivery failed. Check TELEGRAM_INFO_GROUP_ID and bot channel permissions.',
        );
      telegramAccepted = true;
      broadcast.status = 'SENT';
      broadcast.manualReviewRequired = false;
      broadcast.sentAt = new Date();
      broadcast.telegramMessageId = delivery.messageId;
      broadcast.lastError = '';
      await broadcast.save();
      await this.writeAudit(
        'daily_picks_broadcast',
        'SUCCEEDED',
        `Published ${picks.length} curated picks to the public Telegram channel.`,
        { dateKey, sourceReferences: broadcast.sourceReferences },
      ).catch((error) =>
        this.logger.warn(
          `Prediction broadcast audit failed: ${safeError(error)}`,
        ),
      );
      return {
        sent: true,
        broadcastId: String(broadcast._id),
        count: picks.length,
        styleTag: copy.styleTag,
        telegramMessageId: delivery.messageId,
      };
    } catch (error) {
      if (telegramAccepted) {
        broadcast.status = 'FAILED';
        broadcast.manualReviewRequired = true;
        broadcast.lastError =
          'Telegram accepted the message, but the final delivery state could not be confirmed in MongoDB. Check the public channel before retrying.';
        await broadcast.save().catch(() => undefined);
        await this.writeAudit(
          'daily_picks_broadcast',
          'FAILED',
          broadcast.lastError,
          { dateKey, attempt },
        ).catch(() => undefined);
        return {
          sent: false,
          requiresAdminReview: true,
          broadcastId: String(broadcast._id),
        };
      }
      broadcast.status = 'FAILED';
      broadcast.lastError = safeError(error);
      await broadcast.save();
      await this.writeAudit(
        'daily_picks_broadcast',
        'FAILED',
        broadcast.lastError,
        { dateKey, attempt },
      );
      throw error;
    }
  }

  async publishDailyPromotions(
    dateKey: string,
  ): Promise<Record<string, unknown>> {
    const existing = await this.broadcasts
      .findOne({ kind: 'PROMOTION', dateKey, sourceKey: 'daily' })
      .exec();
    if (existing?.status === 'SENT' || existing?.status === 'SKIPPED')
      return {
        skipped: true,
        reason: `ALREADY_${existing.status}`,
        broadcastId: String(existing._id),
      };
    if (existing?.manualReviewRequired)
      return {
        skipped: true,
        requiresAdminReview: true,
        reason: 'DELIVERY_OUTCOME_REQUIRES_ADMIN_CONFIRMATION',
        broadcastId: String(existing._id),
      };
    if (existing?.status === 'SENDING') {
      const ageMs = Date.now() - toDate((existing as any).updatedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs > 5 * 60_000) {
        existing.status = 'FAILED';
        existing.manualReviewRequired = true;
        existing.lastError =
          'A prior send was interrupted after Telegram delivery began. Check the public channel before retrying.';
        await existing.save();
        return {
          skipped: true,
          requiresAdminReview: true,
          reason: 'STALE_SEND_STATE',
          broadcastId: String(existing._id),
        };
      }
      return {
        deferred: true,
        reason: 'SEND_ALREADY_IN_PROGRESS',
        broadcastId: String(existing._id),
      };
    }
    const broadcast =
      existing ??
      (await this.broadcasts.create({
        kind: 'PROMOTION',
        dateKey,
        sourceKey: 'daily',
        status: 'GENERATING',
        attempts: 0,
      }));
    const attempt = Number(broadcast.attempts || 0) + 1;
    broadcast.attempts = attempt;
    broadcast.status = 'GENERATING';
    broadcast.manualReviewRequired = false;
    broadcast.lastError = '';
    await broadcast.save();
    let telegramAccepted = false;

    try {
      // Uses the existing promotion engine's active-promotion rules. This
      // broadcasting layer does not change eligibility, rewards, or redemption.
      const rawPromos = await this.promos.getActivePromos();
      const today = new Date();
      const promos = (Array.isArray(rawPromos) ? rawPromos : [])
        .map((value: any) => toPlain(value))
        .filter((promo: any) => {
          const start = toDate(promo.startDate);
          const end = toDate(promo.endDate);
          const totalLimit = Number(promo.totalRedemptionLimit) || 0;
          const reserved = Number(promo.reservedRedemptions) || 0;
          const redeemed = Number(promo.redemptionCount) || 0;
          const exhausted = totalLimit > 0 && redeemed + reserved >= totalLimit;
          return (
            promo.isActive === true &&
            !exhausted &&
            Number.isFinite(start.getTime()) &&
            Number.isFinite(end.getTime()) &&
            start <= today &&
            end >= today
          );
        })
        // Prefer campaigns that expire sooner so daily advertising helps users
        // notice real deadlines without changing the promotion engine's rules.
        .sort(
          (a: any, b: any) =>
            toDate(a.endDate).getTime() - toDate(b.endDate).getTime(),
        )
        .slice(0, 3)
        .map((promo: any) => normalizePromo(promo));

      if (!promos.length) {
        broadcast.sourceReferences = [];
        if (attempt < 8) {
          broadcast.status = 'GENERATING';
          broadcast.skipReason =
            'No public-eligible active promotion is available yet; a bounded readiness retry is scheduled.';
          await broadcast.save();
          return {
            deferred: true,
            retryAfterMs: 30 * 60_000,
            reason: 'NO_ACTIVE_PUBLIC_PROMOTIONS',
            broadcastId: String(broadcast._id),
          };
        }
        broadcast.status = 'SKIPPED';
        broadcast.skipReason =
          'No active promotion was returned by the existing promotion service after bounded readiness checks.';
        await broadcast.save();
        return { skipped: true, reason: broadcast.skipReason };
      }

      const recent = await this.recentExamples('PROMOTION', dateKey);
      const copy = await this.generateUniqueCopy(
        'PROMOTION',
        dateKey,
        { promotions: promos },
        recent,
      );
      const content = renderPromotionsMessage(
        copy,
        promos,
        this.promotionsUrl,
        this.frontendUrl,
      );
      broadcast.content = content.slice(0, 3900);
      broadcast.styleTag = copy.styleTag;
      broadcast.sourceReferences = promos
        .map((promo: any) => promo.id)
        .filter(Boolean);
      broadcast.status = 'READY';
      await broadcast.save();

      broadcast.status = 'SENDING';
      await broadcast.save();
      const delivery = await this.telegram.sendPublicChannelMessage(
        broadcast.content,
      );
      if (!delivery.success && delivery.deliveryUnknown) {
        broadcast.status = 'FAILED';
        broadcast.manualReviewRequired = true;
        broadcast.lastError =
          'Telegram delivery outcome is unknown. Check the public channel before retrying.';
        await broadcast.save();
        await this.writeAudit(
          'daily_promotion_broadcast',
          'FAILED',
          broadcast.lastError,
          { dateKey, attempt },
        ).catch(() => undefined);
        return {
          sent: false,
          requiresAdminReview: true,
          broadcastId: String(broadcast._id),
        };
      }
      if (!delivery.success)
        throw new Error(
          'Telegram public-channel delivery failed. Check TELEGRAM_INFO_GROUP_ID and bot channel permissions.',
        );
      telegramAccepted = true;
      broadcast.status = 'SENT';
      broadcast.manualReviewRequired = false;
      broadcast.sentAt = new Date();
      broadcast.telegramMessageId = delivery.messageId;
      broadcast.lastError = '';
      await broadcast.save();
      await this.writeAudit(
        'daily_promotion_broadcast',
        'SUCCEEDED',
        `Published ${promos.length} active promotion(s) to the public Telegram channel.`,
        { dateKey, sourceReferences: broadcast.sourceReferences },
      ).catch((error) =>
        this.logger.warn(
          `Promotion broadcast audit failed: ${safeError(error)}`,
        ),
      );
      return {
        sent: true,
        broadcastId: String(broadcast._id),
        count: promos.length,
        styleTag: copy.styleTag,
        telegramMessageId: delivery.messageId,
      };
    } catch (error) {
      if (telegramAccepted) {
        broadcast.status = 'FAILED';
        broadcast.manualReviewRequired = true;
        broadcast.lastError =
          'Telegram accepted the message, but the final delivery state could not be confirmed in MongoDB. Check the public channel before retrying.';
        await broadcast.save().catch(() => undefined);
        await this.writeAudit(
          'daily_promotion_broadcast',
          'FAILED',
          broadcast.lastError,
          { dateKey, attempt },
        ).catch(() => undefined);
        return {
          sent: false,
          requiresAdminReview: true,
          broadcastId: String(broadcast._id),
        };
      }
      broadcast.status = 'FAILED';
      broadcast.lastError = safeError(error);
      await broadcast.save();
      await this.writeAudit(
        'daily_promotion_broadcast',
        'FAILED',
        broadcast.lastError,
        { dateKey, attempt },
      );
      throw error;
    }
  }

  private async generateUniqueCopy(
    kind: 'DAILY_PICKS' | 'PROMOTION',
    dateKey: string,
    facts: Record<string, unknown>,
    recent: Array<{ headline: string; intro: string; styleTag: string }>,
  ): Promise<CreativeCopy> {
    try {
      const generated = await this.groq.generateCreativeCopy({
        kind,
        dateKey,
        verifiedFacts: facts,
        recentExamples: recent,
      });
      if (!isSafeCreativeCopy(generated))
        return fallbackCopy(kind, dateKey, recent);
      const normalizedIntro = normalizeText(generated.intro);
      const duplicate = recent.some(
        (item) =>
          normalizeText(item.intro) === normalizedIntro ||
          normalizeText(item.headline) === normalizeText(generated.headline),
      );
      if (!duplicate) return generated;
      // Do not publish obviously repeated copy. This deterministic fallback is
      // content-only; factual details are still rendered by this backend service.
      return fallbackCopy(kind, dateKey, recent);
    } catch (error) {
      this.logger.warn(
        `Groq broadcast copy generation failed; using verified-data fallback: ${safeError(error)}`,
      );
      return fallbackCopy(kind, dateKey, recent);
    }
  }

  private async recentExamples(
    kind: 'DAILY_PICKS' | 'PROMOTION',
    beforeDateKey: string,
  ): Promise<Array<{ headline: string; intro: string; styleTag: string }>> {
    const rows = await this.broadcasts
      .find({ kind, dateKey: { $lt: beforeDateKey }, status: 'SENT' })
      .sort({ dateKey: -1 })
      .limit(7)
      .select('content styleTag')
      .lean()
      .exec();
    return rows.map((row: any) => {
      const lines = String(row.content ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const headline = (lines[0] ?? '').replace(
        /^(?:⚽|🎁)\s*2XPREDICT\s*\|\s*/i,
        '',
      );
      return {
        headline,
        intro: lines[1] ?? '',
        styleTag: String(row.styleTag ?? ''),
      };
    });
  }

  private async writeAudit(
    actionName: string,
    outcome: 'SUCCEEDED' | 'FAILED',
    summary: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.audits.create({
      actionName,
      actionType: 'BROADCAST',
      outcome,
      summary: summary.slice(0, 2000),
      details,
      durationMs: 0,
    });
  }
}

interface NormalizedPick {
  predictionCode: string;
  title: string;
  fixtureDate: string;
  selections: Array<{
    marketName: string;
    selectionName: string;
    odds?: number;
    oddsSource?: string;
  }>;
  confidence: number;
  url: string;
}
function isEligibleBroadcastPrediction(
  item: any,
  start: Date,
  end: Date,
): boolean {
  if (!item || String(item.status ?? '').toUpperCase() !== 'PUBLISHED')
    return false;
  if (String(item.settlementStatus ?? 'PENDING').toUpperCase() !== 'PENDING')
    return false;
  if (item.completed === true || item.live === true) return false;
  const fixtureDate = toDate(item.fixtureDateFrom);
  if (
    !Number.isFinite(fixtureDate.getTime()) ||
    fixtureDate < start ||
    fixtureDate >= end ||
    fixtureDate < new Date()
  )
    return false;
  if (!Array.isArray(item.selections) || item.selections.length === 0)
    return false;
  return item.selections.some((selection: any) =>
    Boolean(
      String(selection?.marketPredictionId ?? '').trim() &&
      String(selection?.marketKey ?? '').trim() &&
      String(selection?.selectionKey ?? '').trim() &&
      String(selection?.selectionName ?? selection?.selectionKey ?? '').trim(),
    ),
  );
}

function normalizePick(
  item: any,
  predictionsUrl: string,
  maxOddsAgeHours: number,
): NormalizedPick {
  const selections = (Array.isArray(item.selections) ? item.selections : [])
    .slice(0, 3)
    .map((selection: any) => {
      const odds = Number(selection.decimalOdds);
      const oddsUpdatedAt = toDate(selection.oddsUpdatedAt);
      const oddsAgeMs = Date.now() - oddsUpdatedAt.getTime();
      const offered =
        selection.priceType === 'PROVIDER' &&
        Number.isFinite(odds) &&
        odds > 1 &&
        Number.isFinite(oddsUpdatedAt.getTime()) &&
        oddsAgeMs >= 0 &&
        oddsAgeMs <= maxOddsAgeHours * 60 * 60 * 1000;
      return {
        marketName: safeText(
          selection.marketName || selection.marketKey || 'Market',
          80,
        ),
        selectionName: safeText(
          selection.selectionName || selection.selectionKey || 'Selection',
          100,
        ),
        ...(offered ? { odds } : {}),
        ...(offered
          ? {
              oddsSource: safeText(
                selection.bookmaker || selection.oddsProvider || 'provider',
                50,
              ),
            }
          : {}),
      };
    });
  const code = safeText(item.predictionCode || item.eventId || '', 100);
  return {
    predictionCode: code,
    title: safeText(item.title || 'Curated match prediction', 150),
    fixtureDate: formatLagosDateTime(item.fixtureDateFrom),
    selections,
    confidence: Math.max(0, Math.min(98, Number(item.confidence) || 0)),
    url: predictionsUrl,
  };
}
function normalizePromo(promo: any): Record<string, unknown> {
  return {
    id: String(promo._id ?? ''),
    name: safeText(promo.name || 'Promotion', 120),
    description: safeText(promo.description || '', 300),
    promoCode: safeText(promo.promoCode || '', 50),
    startDate: toDate(promo.startDate).toISOString(),
    endDate: toDate(promo.endDate).toISOString(),
    requirement: safeText(promo.requirement || '', 100),
    targetCount: Number(promo.targetCount) || 1,
    promotionKind: safeText(promo.promotionKind || '', 50),
    campaignType: safeText(promo.campaignType || '', 50),
    purpose: safeText(promo.purpose || '', 50),
    eligibilityRules: normalizeEligibilityRules(promo.eligibilityRules),
    perUserRedemptionLimit: Number(promo.perUserRedemptionLimit) || 0,
    totalRedemptionLimit: Number(promo.totalRedemptionLimit) || 0,
    redemptionCount: Number(promo.redemptionCount) || 0,
    reservedRedemptions: Number(promo.reservedRedemptions) || 0,
    rewardType: safeText(promo.rewardType || '', 50),
    rewardPlan: safeText(promo.rewardPlan || '', 50),
    rewardDurationDays: Number(promo.rewardDurationDays) || undefined,
    pointsAmount: Number(promo.pointsAmount) || undefined,
    discountType: safeText(promo.discountType || '', 50),
    discountValue: Number(promo.discountValue) || undefined,
    amountCurrency: safeText(promo.amountCurrency || '', 10),
    minPurchaseAmount: Number(promo.minPurchaseAmount) || undefined,
    maxDiscountAmount: Number(promo.maxDiscountAmount) || undefined,
    eligiblePlans: Array.isArray(promo.eligiblePlans)
      ? promo.eligiblePlans
          .slice(0, 5)
          .map((item: unknown) => safeText(item, 30))
      : [],
  };
}
function normalizeEligibilityRules(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const rules = value as Record<string, unknown>;
  const result: string[] = [];
  const verification = String(rules.verificationStatus ?? '').toLowerCase();
  if (verification === 'verified') result.push('verified account required');
  if (verification === 'unverified')
    result.push('only for unverified accounts');
  const subscriptionStatus = String(
    rules.subscriptionStatus ?? '',
  ).toLowerCase();
  const subscriptionLabels: Record<string, string> = {
    never_subscribed: 'users who have never subscribed',
    active: 'active subscribers',
    renewal_due: 'subscriptions due for renewal',
    expired: 'users with expired subscriptions',
  };
  if (subscriptionLabels[subscriptionStatus])
    result.push(subscriptionLabels[subscriptionStatus]);
  if (rules.firstPurchaseOnly === true)
    result.push('first qualifying purchase only');
  if (typeof rules.previousPlan === 'string' && rules.previousPlan.trim())
    result.push(`previous plan: ${safeText(rules.previousPlan, 40)}`);
  if (
    rules.accountAge &&
    typeof rules.accountAge === 'object' &&
    !Array.isArray(rules.accountAge)
  ) {
    const age = rules.accountAge as Record<string, unknown>;
    const unit = ['days', 'months', 'years'].includes(String(age.unit))
      ? String(age.unit)
      : 'days';
    if (Number.isFinite(Number(age.min)) && age.min !== undefined)
      result.push(`account age at least ${Number(age.min)} ${unit}`);
    if (Number.isFinite(Number(age.max)) && age.max !== undefined)
      result.push(`account age at most ${Number(age.max)} ${unit}`);
  }
  if (
    rules.daysSinceExpiry &&
    typeof rules.daysSinceExpiry === 'object' &&
    !Array.isArray(rules.daysSinceExpiry)
  ) {
    const expiry = rules.daysSinceExpiry as Record<string, unknown>;
    if (Number.isFinite(Number(expiry.min)) && expiry.min !== undefined)
      result.push(`at least ${Number(expiry.min)} days since expiry`);
    if (Number.isFinite(Number(expiry.max)) && expiry.max !== undefined)
      result.push(`no more than ${Number(expiry.max)} days since expiry`);
  }
  return result.slice(0, 8);
}
function formatPromoRequirement(value: string): string {
  const labels: Record<string, string> = {
    register: 'registration',
    regular_subscription: 'Regular subscription',
    vip_subscription: 'VIP subscription',
    any_subscription: 'any paid subscription',
    premium_subscription: 'Premium subscription',
  };
  return labels[value] ?? safeText(value.replace(/_/g, ' '), 100);
}

function renderPicksMessage(
  copy: CreativeCopy,
  picks: NormalizedPick[],
  frontendUrl: string,
): string {
  const lines = [
    `⚽ 2XPREDICT | ${copy.headline.toUpperCase()}`,
    '',
    copy.intro,
    '',
  ];
  picks.forEach((pick, index) => {
    lines.push(`${index + 1}. ${pick.title}`);
    lines.push(`Kick-off: ${pick.fixtureDate}`);
    for (const selection of pick.selections) {
      const odds = selection.odds
        ? ` | Odds: ${selection.odds.toFixed(2)}${selection.oddsSource ? ` (${selection.oddsSource})` : ''}`
        : '';
      lines.push(
        `• ${selection.marketName}: ${selection.selectionName}${odds}`,
      );
    }
    lines.push(`View: ${pick.url}`);
    lines.push('');
  });
  lines.push(
    copy.closing,
    '',
    `Explore 2xPredict: ${frontendUrl}`,
    '',
    'Predictions are estimates, not guarantees. Check the current details before making betting decisions.',
  );
  return lines.join('\n').slice(0, 3900);
}
function renderPromotionsMessage(
  copy: CreativeCopy,
  promos: Record<string, unknown>[],
  promotionsUrl: string,
  frontendUrl: string,
): string {
  const header = [
    `🎁 2XPREDICT | ${copy.headline.toUpperCase()}`,
    '',
    copy.intro,
    '',
  ];
  const footer = [
    '',
    `Details and eligibility: ${promotionsUrl}`,
    copy.closing,
    '',
    `Visit 2xPredict: ${frontendUrl}`,
  ];
  const lines = [...header];
  let includedPromoCount = 0;

  for (const promo of promos) {
    const block: string[] = [
      `${includedPromoCount + 1}. ${String(promo.name)}`,
    ];
    if (promo.description) block.push(String(promo.description));
    if (promo.promotionKind === 'discount' && Number(promo.discountValue) > 0) {
      const discountType = String(promo.discountType ?? '');
      if (discountType === 'percentage') {
        block.push(`Discount: ${Number(promo.discountValue)}%`);
      } else if (
        discountType === 'fixed_amount' &&
        (promo.amountCurrency === 'NGN' || promo.amountCurrency === 'USD')
      ) {
        const symbol = promo.amountCurrency === 'USD' ? '$' : '₦';
        block.push(
          `Discount: ${symbol}${Number(promo.discountValue).toLocaleString()} off`,
        );
      }
      if (
        Number(promo.minPurchaseAmount) > 0 &&
        (promo.amountCurrency === 'NGN' || promo.amountCurrency === 'USD')
      ) {
        const symbol = promo.amountCurrency === 'USD' ? '$' : '₦';
        block.push(
          `Minimum purchase: ${symbol}${Number(promo.minPurchaseAmount).toLocaleString()}`,
        );
      }
      if (
        Number(promo.maxDiscountAmount) > 0 &&
        (promo.amountCurrency === 'NGN' || promo.amountCurrency === 'USD')
      ) {
        const symbol = promo.amountCurrency === 'USD' ? '$' : '₦';
        block.push(
          `Maximum discount: ${symbol}${Number(promo.maxDiscountAmount).toLocaleString()}`,
        );
      }
    }
    if (promo.rewardType === 'subscription' && promo.rewardPlan) {
      const duration = Number(promo.rewardDurationDays);
      block.push(
        `Reward: ${String(promo.rewardPlan).toUpperCase()} subscription${duration > 0 ? ` for ${duration} days` : ''}`,
      );
    }
    if (
      promo.rewardType === 'bet_lab_points' &&
      Number(promo.pointsAmount) > 0
    ) {
      block.push(
        `Reward: ${Number(promo.pointsAmount).toLocaleString()} Bet Lab points`,
      );
    }
    if (promo.promoCode) block.push(`Promo code: ${String(promo.promoCode)}`);
    block.push(`Valid until: ${formatLagosDateTime(promo.endDate)}`);
    if (Array.isArray(promo.eligiblePlans) && promo.eligiblePlans.length)
      block.push(`Eligible plans: ${promo.eligiblePlans.join(', ')}`);
    if (promo.requirement)
      block.push(
        `Requirement: ${formatPromoRequirement(String(promo.requirement))}`,
      );
    if (Array.isArray(promo.eligibilityRules) && promo.eligibilityRules.length)
      block.push(
        `Additional eligibility: ${promo.eligibilityRules.join('; ')}`,
      );
    if (promo.purpose === 'first_purchase')
      block.push('Eligibility: first qualifying purchase only');
    if (promo.purpose === 'referral' || promo.campaignType === 'referral')
      block.push('Eligibility: referred users only');
    if (Number(promo.perUserRedemptionLimit) > 0)
      block.push(`Limit per user: ${Number(promo.perUserRedemptionLimit)}`);
    if (Number(promo.totalRedemptionLimit) > 0)
      block.push(`Campaign limit: ${Number(promo.totalRedemptionLimit)}`);
    if (Number(promo.targetCount) > 1)
      block.push(`Target count: ${Number(promo.targetCount)}`);

    const separator = lines.length > header.length ? [''] : [];
    const candidate = [...lines, ...separator, ...block, ...footer].join('\n');
    // Keep each campaign's facts intact and preserve the public details link.
    // If the Telegram length budget is tight, omit whole lower-priority campaigns
    // rather than truncating conditions or the link at the end of the message.
    if (candidate.length > 3900) break;
    lines.push(...separator, ...block);
    includedPromoCount += 1;
  }
  lines.push(...footer);
  return lines.join('\n');
}
function isSafeCreativeCopy(copy: CreativeCopy): boolean {
  const text = `${copy.headline} ${copy.intro} ${copy.closing}`;
  return (
    !/(guaranteed|guarantee|sure win|risk[- ]free|100%|certain win|profit assured|guaranteed profit|double your money|easy money)/i.test(
      text,
    ) &&
    !/(https?:\/\/|www\.)/i.test(text) &&
    !/[₦$]\s*\d|\b\d+(?:\.\d+)?\s?%/i.test(text) &&
    !/\d/.test(text)
  );
}

function fallbackCopy(
  kind: 'DAILY_PICKS' | 'PROMOTION',
  dateKey: string,
  recent: Array<{ headline: string; intro: string; styleTag: string }>,
): CreativeCopy {
  const pickOpeners = [
    [
      'THE DAILY SHORTLIST',
      'A fresh look at the curated selections currently available today.',
      'Review each market and its details before deciding.',
      'editorial-shortlist',
    ],
    [
      'TODAY’S MATCH NOTES',
      'A concise look at fixtures from the published curated list, ordered using the engine’s existing rankings.',
      'Keep the full match context in view.',
      'match-notes',
    ],
    [
      'YOUR DAILY FIXTURE BRIEF',
      'Here is today’s compact guide to the curated selections that passed the current checks.',
      'Read the details carefully before taking action.',
      'fixture-brief',
    ],
    [
      'THE TODAY CARD',
      'A focused view of the eligible curated predictions for today.',
      'Use the links to review the latest information.',
      'daily-card',
    ],
    [
      'THE MATCHDAY EDIT',
      'Today’s curated picks, using the ranking already recorded by the prediction engine.',
      'No prediction is a guarantee.',
      'matchday-edit',
    ],
    [
      'A FEW TO REVIEW',
      'A quick route into today’s eligible curated predictions on 2xPredict.',
      'Check the market details on the website.',
      'few-to-review',
    ],
    [
      'TODAY’S CURATED VIEW',
      'Explore these eligible fixtures and the selected markets behind them.',
      'Make decisions only after reviewing the details.',
      'curated-view',
    ],
  ];
  const promoOpeners = [
    [
      'TODAY ON 2XPREDICT',
      'There are active promotions to review today. Check the terms before participating.',
      'Confirm your eligibility on the website.',
      'promo-daily',
    ],
    [
      'A FRESH PROMOTION CHECK',
      'Here is the current promotion information returned by the 2xPredict promotion system.',
      'Read the requirements and dates carefully.',
      'promo-check',
    ],
    [
      'WHAT’S AVAILABLE TODAY',
      'The promotion system has returned active campaigns for today.',
      'Use the link to review eligibility and full terms.',
      'available-today',
    ],
    [
      'YOUR DAILY PROMO BRIEF',
      'Take a look at the active campaign details below.',
      'Availability depends on each promotion’s stated rules.',
      'promo-brief',
    ],
    [
      'THE DAILY OFFER NOTE',
      'Current promotion details are listed here for easy reference.',
      'Check every condition before claiming or redeeming.',
      'offer-note',
    ],
    [
      'ACTIVE CAMPAIGN UPDATE',
      'These promotion details come from the existing 2xPredict promotion system.',
      'Review the official terms for the complete conditions.',
      'campaign-update',
    ],
    [
      'TODAY’S PROMOTION GUIDE',
      'Here is a short guide to the active promotions currently available for review.',
      'Check dates and eligibility before proceeding.',
      'promo-guide',
    ],
  ];
  const list = kind === 'DAILY_PICKS' ? pickOpeners : promoOpeners;
  const recentTags = new Set(recent.map((item) => item.styleTag));
  const start = Math.abs(hashString(dateKey)) % list.length;
  for (let offset = 0; offset < list.length; offset += 1) {
    const option = list[(start + offset) % list.length];
    if (!recentTags.has(option[3]))
      return {
        headline: option[0],
        intro: option[1],
        closing: option[2],
        styleTag: option[3],
      };
  }
  const option = list[start];
  const edition = new Intl.DateTimeFormat('en-NG', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'long',
  }).format(lagosDayRange(dateKey).start);
  return {
    headline: `${option[0]} · ${edition}`,
    intro: `${option[1]} Edition for ${edition}.`,
    closing: option[2],
    styleTag: `${option[3]}-${dateKey}`,
  };
}
function existingRanking(item: any): number {
  const values = (Array.isArray(item.selections) ? item.selections : [])
    .map((selection: any) => Number(selection.rankingScore))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : -1;
}
function lagosDayRange(dateKey: string): { start: Date; end: Date } {
  const start = new Date(`${dateKey}T00:00:00+01:00`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}
function toDate(value: unknown): Date {
  const result = value instanceof Date ? value : new Date(value as any);
  return result;
}
function formatLagosDateTime(value: unknown): string {
  const date = toDate(value);
  if (!Number.isFinite(date.getTime())) return 'Time to be confirmed';
  return new Intl.DateTimeFormat('en-NG', {
    timeZone: 'Africa/Lagos',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
function toPlain(value: any): any {
  return value && typeof value.toObject === 'function'
    ? value.toObject()
    : value;
}
function safeText(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1)
    hash = (Math.imul(hash, 31) + value.charCodeAt(i)) | 0;
  return hash;
}
function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .slice(0, 1000);
}
