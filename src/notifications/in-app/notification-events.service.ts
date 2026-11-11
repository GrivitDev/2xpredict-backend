import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { NotificationCategory } from './enums/notification-category.enum';
import { NotificationType } from './enums/notification-type.enum';
import {
  NotificationEvent,
  NotificationEventDocument,
  NotificationEventStatus,
} from './schemas/notification-event.schema';
import { UserNotificationsService } from './user-notifications.service';
import { UsersService } from '../../users/users.service';
import { NotificationEmailDeliveryService } from '../email-delivery/email-delivery.service';

const RETENTION_MONTHS = 18;
const MAX_ATTEMPTS = 8;
const MAX_BATCH_SIZE = 20;
const IDLE_POLL_MS = 15_000;
const ACTIVE_POLL_MS = 250;
const LOCK_TIMEOUT_MS = 2 * 60 * 1000;

// Automatic email notifications are intentionally limited to successful payments
// and subscription lifecycle events. OTP, password-reset and welcome messages
// are queued directly by their authentication flows. Everything else is in-app only.
const EMAIL_NOTIFICATION_TYPES = new Set<NotificationType>([
  NotificationType.PAYMENT_SUCCESSFUL,
  NotificationType.SUBSCRIPTION_ACTIVATED,
  NotificationType.SUBSCRIPTION_RENEWED,
  NotificationType.SUBSCRIPTION_UPGRADED,
  NotificationType.SUBSCRIPTION_EXPIRING,
  NotificationType.SUBSCRIPTION_EXPIRED,
]);

export interface QueueNotificationInput {
  recipientId: string;
  type: NotificationType;
  category: NotificationCategory;
  title: string;
  message: string;
  actionUrl?: string | null;
  data?: Record<string, unknown>;
  /** Stable business event key, unique per recipient. */
  dedupeKey: string;
  /** Optional scheduled delivery time for a known future lifecycle event. */
  deliverAt?: Date;
}

@Injectable()
export class NotificationEventsService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationEventsService.name);
  private workerTimer?: NodeJS.Timeout;
  private workerRunning = false;

  constructor(
    @InjectModel(NotificationEvent.name)
    private readonly eventModel: Model<NotificationEventDocument>,
    private readonly userNotifications: UserNotificationsService,
    private readonly usersService: UsersService,
    private readonly emailDelivery: NotificationEmailDeliveryService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.eventModel.createIndexes();
    } catch (error) {
      this.logger.error(
        `Could not ensure notification event indexes: ${errorMessage(error)}`,
      );
    }
    this.scheduleWorker(2000);
  }

  onModuleDestroy(): void {
    if (this.workerTimer) clearTimeout(this.workerTimer);
  }

  /**
   * Persists a business notification event before dispatch. Errors are logged
   * and swallowed so communication infrastructure cannot fail a business flow.
   * A duplicate key is an idempotent success.
   */
  async enqueue(input: QueueNotificationInput): Promise<boolean> {
    const recipientId = String(input.recipientId ?? '').trim();
    const dedupeKey = String(input.dedupeKey ?? '').trim();
    const title = String(input.title ?? '').trim();
    const message = String(input.message ?? '').trim();

    if (
      !Types.ObjectId.isValid(recipientId) ||
      !dedupeKey || dedupeKey.length > 180 ||
      !title || title.length > 120 ||
      !message || message.length > 1200
    ) {
      this.logger.warn('Skipped malformed notification event.');
      return false;
    }

    try {
      await this.eventModel.create({
        recipientId: new Types.ObjectId(recipientId),
        type: input.type,
        category: input.category,
        title,
        message,
        actionUrl: input.actionUrl ?? null,
        data: input.data ?? {},
        dedupeKey,
        status: NotificationEventStatus.PENDING,
        attempts: 0,
        nextAttemptAt: input.deliverAt && Number.isFinite(input.deliverAt.getTime())
          ? (input.deliverAt.getTime() > Date.now() ? input.deliverAt : new Date())
          : new Date(),
        lockedAt: null,
        lockToken: null,
        processedAt: null,
        lastError: null,
        expiresAt: addCalendarMonths(new Date(), RETENTION_MONTHS),
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) return true;
      this.logger.error(
        `Could not queue notification event ${dedupeKey}: ${errorMessage(error)}`,
      );
      return false;
    }

    return true;
  }

  async paymentSubmitted(input: {
    userId: string;
    reference: string;
    amount: number;
    currency: string;
    paymentType: string;
    target: string;
  }): Promise<boolean> {
    const paymentLabel = paymentTypeLabel(input.paymentType, input.target);
    return this.enqueue({
      recipientId: input.userId,
      type: NotificationType.PAYMENT_SUBMITTED,
      category: NotificationCategory.PAYMENTS,
      title: 'Payment Submitted',
      message: `Your ${paymentLabel} payment request has been submitted and is awaiting verification.`,
      actionUrl: '/payments',
      dedupeKey: `payment:${input.reference}:submitted`,
      data: {
        reference: input.reference,
        amount: input.amount,
        currency: input.currency,
        paymentType: input.paymentType,
        target: input.target,
        status: 'PENDING',
      },
    });
  }

  async paymentSuccessful(input: {
    userId: string;
    reference: string;
    amount: number;
    currency: string;
    paymentType: string;
    target: string;
    subscription?: {
      plan: string;
      isActive: boolean;
      startDate: Date;
      expiryDate: Date;
    };
  }): Promise<boolean> {
    const paymentLabel = paymentTypeLabel(input.paymentType, input.target);
    const paymentQueued = await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.PAYMENT_SUCCESSFUL,
      category: NotificationCategory.PAYMENTS,
      title: 'Payment Confirmed',
      message: `Your ${formatAmount(input.amount, input.currency)} payment for ${paymentLabel} has been confirmed.`,
      actionUrl: '/payments',
      dedupeKey: `payment:${input.reference}:successful`,
      data: {
        reference: input.reference,
        amount: input.amount,
        currency: input.currency,
        paymentType: input.paymentType,
        target: input.target,
        status: 'APPROVED',
      },
    });

    let subscriptionQueued = true;
    if (input.subscription) {
      const isUpgrade = input.paymentType === 'vip_upgrade' || input.paymentType === 'premium_upgrade';
      const plan = input.subscription.plan.toUpperCase();
      const isQueued = !input.subscription.isActive;
      const subscriptionType = isQueued
        ? NotificationType.SUBSCRIPTION_SCHEDULED
        : isUpgrade
          ? NotificationType.SUBSCRIPTION_UPGRADED
          : NotificationType.SUBSCRIPTION_ACTIVATED;
      const title = isQueued
        ? 'Subscription Term Scheduled'
        : isUpgrade
          ? 'Subscription Upgraded'
          : 'Subscription Activated';
      const message = isQueued
        ? `Your ${plan} subscription term has been added and is scheduled to begin on ${formatDate(input.subscription.startDate)}.`
        : isUpgrade
          ? `Your subscription has been upgraded to ${plan}.`
          : `Your ${plan} subscription is now active.`;

      subscriptionQueued = await this.enqueue({
        recipientId: input.userId,
        type: subscriptionType,
        category: NotificationCategory.SUBSCRIPTIONS,
        title,
        message,
        actionUrl: '/subscription',
        dedupeKey: `payment:${input.reference}:subscription`,
        data: {
          reference: input.reference,
          plan: input.subscription.plan,
          amount: input.amount,
          currency: input.currency,
          isActive: input.subscription.isActive,
          startDate: input.subscription.startDate.toISOString(),
          expiryDate: input.subscription.expiryDate.toISOString(),
        },
      });
    }
    return paymentQueued && subscriptionQueued;
  }

  async paymentRejected(input: {
    userId: string;
    reference: string;
    amount: number;
    currency: string;
    paymentType: string;
    target: string;
    reason?: string;
  }): Promise<boolean> {
    const paymentLabel = paymentTypeLabel(input.paymentType, input.target);
    return this.enqueue({
      recipientId: input.userId,
      type: NotificationType.PAYMENT_REJECTED,
      category: NotificationCategory.PAYMENTS,
      title: 'Payment Rejected',
      message: `Your ${paymentLabel} payment request could not be approved.${input.reason ? ` Reason: ${input.reason.slice(0, 500)}` : ''}`,
      actionUrl: '/payments',
      dedupeKey: `payment:${input.reference}:rejected`,
      data: {
        reference: input.reference,
        amount: input.amount,
        currency: input.currency,
        paymentType: input.paymentType,
        target: input.target,
        status: 'REJECTED',
      },
    });
  }

  async referralRegistered(input: {
    referrerId: string;
    referredUserId: string;
    referredName?: string;
  }): Promise<void> {
    const displayName = (String(input.referredName ?? '').trim().slice(0, 100)) || 'A new member';
    await this.enqueue({
      recipientId: input.referrerId,
      type: NotificationType.REFERRAL_REGISTERED,
      category: NotificationCategory.REFERRALS,
      title: 'New Referral',
      message: `${displayName} joined 2xPredict using your referral link.`,
      actionUrl: '/referrals',
      dedupeKey: `referral:${input.referredUserId}:registered`,
      data: { referredUserId: input.referredUserId },
    });
  }

  async referralSubscription(input: {
    referrerId: string;
    referredUserId: string;
    plan: 'regular' | 'vip' | 'premium';
  }): Promise<void> {
    const plan = input.plan.toUpperCase();
    await this.enqueue({
      recipientId: input.referrerId,
      type: NotificationType.REFERRAL_SUBSCRIPTION,
      category: NotificationCategory.REFERRALS,
      title: 'Referral Subscription Milestone',
      message: `A member you referred has activated a ${plan} subscription.`,
      actionUrl: '/referrals',
      dedupeKey: `referral:${input.referredUserId}:subscription:${input.plan}`,
      data: { referredUserId: input.referredUserId, plan: input.plan },
    });
  }

  async bonusGranted(input: {
    userId: string;
    grantId: string;
    kind: 'points' | 'subscription';
    points?: number;
    plan?: string;
    durationDays?: number;
    reason?: string;
  }): Promise<void> {
    const isPoints = input.kind === 'points';
    await this.enqueue({
      recipientId: input.userId,
      type: isPoints
        ? NotificationType.BONUS_POINTS_GRANTED
        : NotificationType.BONUS_SUBSCRIPTION_GRANTED,
      category: NotificationCategory.BONUSES,
      title: isPoints ? 'Bonus Points Added' : 'Subscription Bonus Granted',
      message: isPoints
        ? `${Number(input.points ?? 0).toLocaleString()} bonus points have been added to your Bet Lab wallet.`
        : `You have received a ${String(input.plan ?? '').toUpperCase()} subscription bonus${input.durationDays ? ` for ${input.durationDays} days` : ''}.`,
      actionUrl: isPoints ? '/bet-lab' : '/subscription',
      dedupeKey: `bonus:${input.grantId}:granted`,
      data: {
        grantId: input.grantId,
        kind: input.kind,
        ...(input.points !== undefined ? { points: input.points } : {}),
        ...(input.plan ? { plan: input.plan } : {}),
        ...(input.durationDays ? { durationDays: input.durationDays } : {}),
      },
    });
  }

  /** Schedules one in-app bonus-expiry notice at the actual entitlement end. */
  async bonusExpiryScheduled(input: {
    userId: string;
    grantId: string;
    plan: string;
    expiresAt: Date;
  }): Promise<void> {
    const expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) return;
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.BONUS_EXPIRED,
      category: NotificationCategory.BONUSES,
      title: 'Subscription Bonus Expired',
      message: `Your ${input.plan.toUpperCase()} subscription bonus has expired. Check your current subscription to see which access remains available.`,
      actionUrl: '/subscription',
      dedupeKey: `bonus:${input.grantId}:expired`,
      deliverAt: expiresAt,
      data: { grantId: input.grantId, plan: input.plan, expiresAt: expiresAt.toISOString() },
    });
  }

  async cancelPendingEvent(input: {
    recipientId: string;
    dedupeKey: string;
    reason: string;
  }): Promise<void> {
    if (!Types.ObjectId.isValid(input.recipientId)) return;
    try {
      await this.eventModel.updateOne(
        {
          recipientId: new Types.ObjectId(input.recipientId),
          dedupeKey: input.dedupeKey,
          status: { $in: [NotificationEventStatus.PENDING, NotificationEventStatus.RETRYING] },
        },
        {
          $set: {
            status: NotificationEventStatus.CANCELLED,
            processedAt: new Date(),
            lockedAt: null,
            lockToken: null,
            lastError: String(input.reason ?? 'Cancelled').slice(0, 1000),
          },
        },
      ).exec();
    } catch (error) {
      this.logger.warn(`Could not cancel scheduled notification ${input.dedupeKey}: ${errorMessage(error)}`);
    }
  }

  async bonusRevoked(input: {
    userId: string;
    grantId: string;
    reason?: string;
  }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.BONUS_REVOKED,
      category: NotificationCategory.BONUSES,
      title: 'Bonus Revoked',
      message: input.reason?.trim()
        ? `A bonus on your account has been revoked. Reason: ${input.reason.trim().slice(0, 500)}`
        : 'A bonus on your account has been revoked.',
      actionUrl: '/account/bonuses',
      dedupeKey: `bonus:${input.grantId}:revoked`,
      data: { grantId: input.grantId },
    });
  }

  async subscriptionExpiring(input: {
    userId: string;
    subscriptionId: string;
    plan: string;
    expiryDate: Date;
    daysRemaining: number;
  }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.SUBSCRIPTION_EXPIRING,
      category: NotificationCategory.SUBSCRIPTIONS,
      title: 'Subscription Expiring Soon',
      message: `Your ${input.plan.toUpperCase()} subscription expires in ${input.daysRemaining} days. Renew to keep your access active.`,
      actionUrl: '/subscription',
      dedupeKey: `subscription:${input.subscriptionId}:expiring`,
      data: {
        subscriptionId: input.subscriptionId,
        plan: input.plan,
        expiryDate: input.expiryDate.toISOString(),
        daysRemaining: input.daysRemaining,
      },
    });
  }

  async subscriptionExpired(input: {
    userId: string;
    subscriptionId: string;
    plan: string;
    expiryDate: Date;
  }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.SUBSCRIPTION_EXPIRED,
      category: NotificationCategory.SUBSCRIPTIONS,
      title: 'Subscription Expired',
      message: `Your ${input.plan.toUpperCase()} subscription has expired. Renew to restore subscription access.`,
      actionUrl: '/subscription',
      dedupeKey: `subscription:${input.subscriptionId}:expired`,
      data: {
        subscriptionId: input.subscriptionId,
        plan: input.plan,
        expiryDate: input.expiryDate.toISOString(),
      },
    });
  }

  async accountWelcome(input: { userId: string }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.ACCOUNT_WELCOME,
      category: NotificationCategory.ACCOUNT,
      title: 'Welcome to 2xPredict',
      message: 'Your account is verified and ready. Explore predictions, Bet Lab and the features available to your membership.',
      actionUrl: '/predictions',
      dedupeKey: `account:${input.userId}:welcome`,
    });
  }

  async accountEmailVerified(input: { userId: string }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.ACCOUNT_EMAIL_VERIFIED,
      category: NotificationCategory.ACCOUNT,
      title: 'Email Verified',
      message: 'Your email address has been verified successfully. Your 2xPredict account is ready.',
      actionUrl: '/account',
      dedupeKey: `account:${input.userId}:email-verified`,
    });
  }

  async accountEmailChanged(input: {
    userId: string;
    email: string;
  }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.ACCOUNT_EMAIL_CHANGED,
      category: NotificationCategory.ACCOUNT,
      title: 'Account Email Updated',
      message: 'The email address associated with your 2xPredict account has been changed.',
      actionUrl: '/account',
      dedupeKey: `account:${input.userId}:email-changed:${createStableKey(input.email)}`,
    });
  }

  async accountSecurityAlert(input: {
    userId: string;
    eventKey: string;
    title: string;
    message: string;
  }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.ACCOUNT_SECURITY_ALERT,
      category: NotificationCategory.ACCOUNT,
      title: input.title,
      message: input.message,
      actionUrl: '/account',
      dedupeKey: `account:security:${input.userId}:${input.eventKey}`,
    });
  }

  async accountPasswordChanged(input: {
    userId: string;
    source: 'PASSWORD_CHANGED' | 'PASSWORD_RESET';
  }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.ACCOUNT_PASSWORD_CHANGED,
      category: NotificationCategory.ACCOUNT,
      title: 'Password Updated',
      message: input.source === 'PASSWORD_RESET'
        ? 'Your account password was reset successfully. Other active sessions have been signed out.'
        : 'Your account password was changed successfully. Other active sessions have been signed out.',
      actionUrl: '/account/security',
      dedupeKey: `account:${input.userId}:password:${input.source}:${Date.now()}`,
    });
  }

  async accountSuspended(input: {
    userId: string;
    reason?: string;
    bannedUntil?: Date | null;
  }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.ACCOUNT_SUSPENDED,
      category: NotificationCategory.ACCOUNT,
      title: 'Account Restricted',
      message: input.reason?.trim()
        ? `Your 2xPredict account has been suspended. Reason: ${input.reason.trim().slice(0, 350)}`
        : 'Your 2xPredict account has been suspended. Contact support if you need assistance.',
      actionUrl: '/customer-care',
      dedupeKey: `account:${input.userId}:suspended:${input.bannedUntil?.toISOString() ?? 'indefinite'}:${Date.now()}`,
      data: input.bannedUntil ? { bannedUntil: input.bannedUntil.toISOString() } : {},
    });
  }

  async accountRestored(input: { userId: string }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.ACCOUNT_RESTORED,
      category: NotificationCategory.ACCOUNT,
      title: 'Account Restored',
      message: 'Your 2xPredict account access has been restored.',
      actionUrl: '/account',
      dedupeKey: `account:${input.userId}:restored:${Date.now()}`,
    });
  }

  async betLabTicketPlaced(input: {
    userId: string;
    ticketId: string;
    ticketNumber: string;
    ticketType: string;
    stake: number;
    combinedOdds: number;
    potentialReturn: number;
    selectionCount: number;
  }): Promise<void> {
    const ticketType = input.ticketType === 'ACCUMULATOR' ? 'accumulator' : 'single';
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.BET_LAB_TICKET_PLACED,
      category: NotificationCategory.BET_LAB,
      title: 'Bet Lab Ticket Placed',
      message: `Ticket #${input.ticketNumber} has been placed. Stake: ${formatPoints(input.stake)} points · Odds: ${Number(input.combinedOdds).toFixed(2)} · Potential return: ${formatPoints(input.potentialReturn)} points.`,
      actionUrl: `/bet-lab/tickets/${encodeURIComponent(input.ticketId)}`,
      dedupeKey: `bet-lab:ticket:${input.ticketId}:placed`,
      data: {
        ticketId: input.ticketId,
        ticketNumber: input.ticketNumber,
        ticketType,
        stake: input.stake,
        combinedOdds: input.combinedOdds,
        potentialReturn: input.potentialReturn,
        selectionCount: input.selectionCount,
      },
    });
  }

  async betLabTicketSettled(input: {
    userId: string;
    ticketId: string;
    ticketNumber: string;
    status: string;
    stake: number;
    grossReturn: number;
  }): Promise<void> {
    const status = String(input.status).toUpperCase();
    const type = status === 'WON'
      ? NotificationType.BET_LAB_TICKET_WON
      : status === 'LOST'
        ? NotificationType.BET_LAB_TICKET_LOST
        : status === 'VOID' || status === 'PUSH'
          ? NotificationType.BET_LAB_TICKET_VOIDED
          : status === 'PARTIALLY_WON'
            ? NotificationType.BET_LAB_TICKET_PARTIALLY_WON
            : status === 'PARTIALLY_LOST'
              ? NotificationType.BET_LAB_TICKET_PARTIALLY_LOST
              : NotificationType.BET_LAB_TICKET_SETTLED;
    const outcome = status.replace(/_/g, ' ').toLowerCase();
    const title = status === 'WON'
      ? 'Bet Lab Ticket Won'
      : status === 'LOST'
        ? 'Bet Lab Ticket Lost'
        : status === 'VOID' || status === 'PUSH'
          ? 'Bet Lab Ticket Returned'
          : status === 'PARTIALLY_WON'
            ? 'Bet Lab Ticket Partially Won'
            : status === 'PARTIALLY_LOST'
              ? 'Bet Lab Ticket Partially Lost'
              : 'Bet Lab Ticket Settled';
    const message = input.grossReturn > 0
      ? `Ticket #${input.ticketNumber} has been ${outcome}. ${formatPoints(input.grossReturn)} points have been returned to your wallet.`
      : `Ticket #${input.ticketNumber} has been ${outcome}. No points were returned.`;
    await this.enqueue({
      recipientId: input.userId,
      type,
      category: NotificationCategory.BET_LAB,
      title,
      message,
      actionUrl: `/bet-lab/tickets/${encodeURIComponent(input.ticketId)}`,
      dedupeKey: `bet-lab:ticket:${input.ticketId}:settled`,
      data: {
        ticketId: input.ticketId,
        ticketNumber: input.ticketNumber,
        status,
        stake: input.stake,
        grossReturn: input.grossReturn,
        netResult: input.grossReturn - input.stake,
      },
    });
  }

  async walletCredited(input: {
    userId: string;
    transactionId: string;
    amount: number;
    balanceAfter?: number;
    description: string;
    source: string;
  }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.WALLET_CREDITED,
      category: NotificationCategory.WALLET,
      title: 'Bet Lab Wallet Credited',
      message: `${formatPoints(input.amount)} virtual points were added to your Bet Lab wallet. ${input.description.slice(0, 180)}`,
      actionUrl: '/bet-lab/wallet',
      dedupeKey: `wallet:${input.transactionId}:credited`,
      data: {
        transactionId: input.transactionId,
        amount: input.amount,
        ...(input.balanceAfter !== undefined ? { balanceAfter: input.balanceAfter } : {}),
        source: input.source,
      },
    });
  }

  async walletDebited(input: {
    userId: string;
    transactionId: string;
    amount: number;
    balanceAfter?: number;
    description: string;
    source: string;
  }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.WALLET_DEBITED,
      category: NotificationCategory.WALLET,
      title: 'Bet Lab Wallet Debited',
      message: `${formatPoints(input.amount)} virtual points were used from your Bet Lab wallet. ${input.description.slice(0, 180)}`,
      actionUrl: '/bet-lab/wallet',
      dedupeKey: `wallet:${input.transactionId}:debited`,
      data: {
        transactionId: input.transactionId,
        amount: input.amount,
        ...(input.balanceAfter !== undefined ? { balanceAfter: input.balanceAfter } : {}),
        source: input.source,
      },
    });
  }

  async walletAllowanceExpired(input: {
    userId: string;
    transactionId: string;
    amount: number;
    expiredAt?: Date;
  }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.WALLET_ALLOWANCE_EXPIRED,
      category: NotificationCategory.WALLET,
      title: 'Monthly Bet Lab Allowance Expired',
      message: `${formatPoints(input.amount)} unused monthly virtual points have expired because the allowance period ended. Your other wallet balances are unaffected.`,
      actionUrl: '/bet-lab/wallet',
      dedupeKey: `wallet:${input.transactionId}:allowance-expired`,
      data: {
        transactionId: input.transactionId,
        amount: input.amount,
        ...(input.expiredAt ? { expiredAt: input.expiredAt.toISOString() } : {}),
      },
    });
  }

  async promotionJoined(input: {
    userId: string;
    promoId: string;
    promoName: string;
    promoCode?: string;
    expiresAt?: Date;
  }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.PROMOTION_JOINED,
      category: NotificationCategory.PROMOTIONS,
      title: 'Promotion Joined',
      message: `You have successfully joined ${input.promoName.slice(0, 120)}. Check the promotion details and eligibility requirements.`,
      actionUrl: '/promos',
      dedupeKey: `promotion:${input.promoId}:${input.userId}:joined`,
      data: {
        promoId: input.promoId,
        ...(input.promoCode ? { promoCode: input.promoCode } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt.toISOString() } : {}),
      },
    });
  }

  async promotionRewardGranted(input: {
    userId: string;
    promoId: string;
    rewardId: string;
    promoName: string;
    rewardType: 'points' | 'subscription' | 'discount';
    points?: number;
    plan?: string;
    durationDays?: number;
    claimNumber?: number;
  }): Promise<void> {
    const milestone = Number(input.claimNumber ?? 1) > 1;
    const details = input.rewardType === 'points'
      ? `${formatPoints(Number(input.points ?? 0))} Bet Lab points have been added to your wallet.`
      : input.rewardType === 'subscription'
        ? `You have received a ${String(input.plan ?? '').toUpperCase()} subscription reward${input.durationDays ? ` for ${input.durationDays} days` : ''}.`
        : 'Your promotion reward is ready to use.';
    await this.enqueue({
      recipientId: input.userId,
      type: milestone ? NotificationType.PROMOTION_MILESTONE : NotificationType.PROMOTION_REWARD_GRANTED,
      category: NotificationCategory.PROMOTIONS,
      title: milestone ? 'Promotion Milestone Reached' : 'Promotion Reward Granted',
      message: `${input.promoName.slice(0, 100)}: ${details}`,
      actionUrl: '/promos',
      dedupeKey: `promotion:${input.promoId}:${input.rewardId}:granted`,
      data: {
        promoId: input.promoId,
        rewardId: input.rewardId,
        rewardType: input.rewardType,
        claimNumber: input.claimNumber ?? 1,
        ...(input.points !== undefined ? { points: input.points } : {}),
        ...(input.plan ? { plan: input.plan } : {}),
        ...(input.durationDays ? { durationDays: input.durationDays } : {}),
      },
    });
  }

  async promotionCompleted(input: {
    userId: string;
    promoId: string;
    reference: string;
    promoName: string;
    pointsReward?: number;
  }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.PROMOTION_COMPLETED,
      category: NotificationCategory.PROMOTIONS,
      title: 'Promotion Applied',
      message: input.pointsReward && input.pointsReward > 0
        ? `${input.promoName.slice(0, 120)} was successfully applied. ${formatPoints(input.pointsReward)} reward points are included.`
        : `${input.promoName.slice(0, 120)} was successfully applied to your purchase.`,
      actionUrl: '/promos',
      dedupeKey: `promotion:redemption:${input.reference}:completed`,
      data: { promoId: input.promoId, reference: input.reference, pointsReward: input.pointsReward ?? 0 },
    });
  }

  async supportReply(input: {
    userId: string;
    conversationId: string;
    messageId: string;
    source: 'AI' | 'ADMIN';
  }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.SUPPORT_REPLY,
      category: NotificationCategory.CUSTOMER_CARE,
      title: input.source === 'ADMIN' ? 'Support Team Replied' : 'Customer Care Replied',
      message: input.source === 'ADMIN'
        ? 'A member of the 2xPredict support team has replied to your conversation.'
        : 'You have received a new response from 2xPredict Customer Care.',
      actionUrl: `/customer-care?conversationId=${encodeURIComponent(input.conversationId)}`,
      dedupeKey: `support:reply:${input.messageId}`,
      data: { conversationId: input.conversationId, messageId: input.messageId, source: input.source },
    });
  }

  async supportTicketUpdated(input: {
    userId: string;
    conversationId: string;
    eventKey: string;
    status: string;
    message: string;
  }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.SUPPORT_TICKET_UPDATED,
      category: NotificationCategory.CUSTOMER_CARE,
      title: 'Support Request Updated',
      message: input.message,
      actionUrl: `/customer-care?conversationId=${encodeURIComponent(input.conversationId)}`,
      dedupeKey: `support:${input.conversationId}:updated:${input.eventKey}`,
      data: { conversationId: input.conversationId, status: input.status },
    });
  }

  async supportTicketResolved(input: {
    userId: string;
    conversationId: string;
  }): Promise<void> {
    await this.enqueue({
      recipientId: input.userId,
      type: NotificationType.SUPPORT_TICKET_RESOLVED,
      category: NotificationCategory.CUSTOMER_CARE,
      title: 'Support Request Resolved',
      message: 'Your 2xPredict support conversation has been marked as resolved.',
      actionUrl: `/customer-care?conversationId=${encodeURIComponent(input.conversationId)}`,
      dedupeKey: `support:${input.conversationId}:resolved`,
      data: { conversationId: input.conversationId },
    });
  }

  async subscriptionActivated(input: {
    userId: string;
    reference: string;
    plan: string;
    startDate: Date;
    expiryDate: Date;
    isActive?: boolean;
    source?: string;
  }): Promise<void> {
    const isActive = input.isActive !== false;
    await this.enqueue({
      recipientId: input.userId,
      type: isActive ? NotificationType.SUBSCRIPTION_ACTIVATED : NotificationType.SUBSCRIPTION_SCHEDULED,
      category: NotificationCategory.SUBSCRIPTIONS,
      title: isActive ? 'Subscription Activated' : 'Subscription Term Scheduled',
      message: isActive
        ? `Your ${input.plan.toUpperCase()} subscription is now active.`
        : `Your ${input.plan.toUpperCase()} subscription term is scheduled to begin on ${formatDate(input.startDate)}.`,
      actionUrl: '/subscription',
      dedupeKey: `subscription:${input.reference}:${isActive ? 'activated' : 'scheduled'}`,
      data: {
        plan: input.plan,
        isActive,
        startDate: input.startDate.toISOString(),
        expiryDate: input.expiryDate.toISOString(),
        source: input.source ?? 'subscription',
      },
    });
  }

  async getQueueHealth() {
    const statuses = Object.values(NotificationEventStatus);
    const counts = await Promise.all(statuses.map(async (status) => ({
      status,
      count: await this.eventModel.countDocuments({ status }).exec(),
    })));
    const oldestPending = await this.eventModel
      .findOne({ status: { $in: [NotificationEventStatus.PENDING, NotificationEventStatus.RETRYING] }, nextAttemptAt: { $lte: new Date() } })
      .sort({ nextAttemptAt: 1, createdAt: 1 })
      .select({ createdAt: 1, nextAttemptAt: 1 })
      .lean()
      .exec();
    return {
      collection: 'notification_events',
      counts: Object.fromEntries(counts.map((item) => [item.status, item.count])),
      oldestDueEventAt: oldestPending?.createdAt ?? null,
      checkedAt: new Date().toISOString(),
    };
  }

  private scheduleWorker(delayMs: number): void {
    if (this.workerTimer) clearTimeout(this.workerTimer);
    this.workerTimer = setTimeout(() => {
      this.workerTimer = undefined;
      void this.processBatch();
    }, delayMs);
    this.workerTimer.unref?.();
  }

  private async processBatch(): Promise<void> {
    if (this.workerRunning) {
      this.scheduleWorker(IDLE_POLL_MS);
      return;
    }

    this.workerRunning = true;
    let processed = 0;
    let hadError = false;

    try {
      const now = new Date();
      const staleLock = new Date(now.getTime() - LOCK_TIMEOUT_MS);

      // A worker that crashed during its final permitted attempt is moved to
      // FAILED rather than being left PROCESSING forever.
      await this.eventModel.updateMany(
        {
          status: NotificationEventStatus.PROCESSING,
          lockedAt: { $lte: staleLock },
          attempts: { $gte: MAX_ATTEMPTS },
        },
        {
          $set: {
            status: NotificationEventStatus.FAILED,
            lockedAt: null,
            lockToken: null,
            lastError: 'Processing lease expired after the maximum retry attempts.',
          },
        },
      ).exec();

      while (processed < MAX_BATCH_SIZE) {
        const lockToken = randomUUID();
        const event = await this.eventModel.findOneAndUpdate(
          {
            attempts: { $lt: MAX_ATTEMPTS },
            $or: [
              {
                status: NotificationEventStatus.PENDING,
                nextAttemptAt: { $lte: now },
              },
              {
                status: NotificationEventStatus.RETRYING,
                nextAttemptAt: { $lte: now },
              },
              {
                status: NotificationEventStatus.PROCESSING,
                lockedAt: { $lte: staleLock },
              },
            ],
          },
          {
            $set: {
              status: NotificationEventStatus.PROCESSING,
              lockedAt: new Date(),
              lockToken,
              lastError: null,
            },
            $inc: { attempts: 1 },
          },
          {
            returnDocument: 'after',
            sort: { nextAttemptAt: 1, createdAt: 1 },
          },
        ).exec();

        if (!event) break;
        processed += 1;

        try {
          const recipientId = event.recipientId.toString();
          await this.userNotifications.create({
            recipientId,
            type: event.type,
            category: event.category,
            title: event.title,
            message: event.message,
            actionUrl: event.actionUrl,
            data: event.data,
            dedupeKey: event.dedupeKey,
          });

          // Email is reserved for successful payments and subscription lifecycle
          // notices. Account verification, password reset and welcome emails are
          // queued directly by their authentication flows. All other categories
          // are in-app only.
          if (EMAIL_NOTIFICATION_TYPES.has(event.type as NotificationType)) {
            const recipient = await this.usersService.findById(recipientId);
            if (recipient?.email) {
              await this.emailDelivery.enqueueNotification({
                recipientId,
                email: recipient.email,
                category: event.category,
                title: event.title,
                message: event.message,
                actionUrl: event.actionUrl,
                data: event.data,
                dedupeKey: event.dedupeKey,
              });
            }
          }

          await this.eventModel.updateOne(
            { _id: event._id, lockToken },
            {
              $set: {
                status: NotificationEventStatus.COMPLETED,
                processedAt: new Date(),
                lockedAt: null,
                lockToken: null,
                lastError: null,
              },
            },
          ).exec();
        } catch (error) {
          hadError = true;
          const message = errorMessage(error).slice(0, 1000);
          const attempts = Number(event.attempts ?? 1);
          const exhausted = attempts >= MAX_ATTEMPTS;
          const backoffMs = Math.min(
            60 * 60 * 1000,
            5000 * 2 ** Math.max(0, attempts - 1),
          );

          await this.eventModel.updateOne(
            { _id: event._id, lockToken },
            {
              $set: {
                status: exhausted
                  ? NotificationEventStatus.FAILED
                  : NotificationEventStatus.RETRYING,
                nextAttemptAt: new Date(Date.now() + backoffMs),
                lockedAt: null,
                lockToken: null,
                lastError: message,
              },
            },
          ).exec();

          this.logger.warn(
            `Notification event ${event.dedupeKey} ${exhausted ? 'failed permanently' : 'will retry'} (attempt ${attempts}/${MAX_ATTEMPTS}): ${message}`,
          );
        }
      }
    } catch (error) {
      hadError = true;
      this.logger.error(`Notification event worker failed: ${errorMessage(error)}`);
    } finally {
      this.workerRunning = false;
      this.scheduleWorker(
        processed >= MAX_BATCH_SIZE || (processed > 0 && hadError)
          ? ACTIVE_POLL_MS
          : IDLE_POLL_MS,
      );
    }
  }
}

function paymentTypeLabel(type: string, target: string): string {
  if (type === 'subscription') return `${target.toUpperCase()} subscription`;
  if (type === 'vip_upgrade') return 'VIP subscription upgrade';
  if (type === 'premium_upgrade') return 'Premium subscription upgrade';
  return 'account payment';
}

function formatAmount(amount: number, currency: string): string {
  const symbol = currency === 'USD' ? '$' : currency === 'NGN' ? '₦' : `${currency} `;
  return `${symbol}${Number(amount || 0).toLocaleString()}`;
}

function formatDate(value: Date): string {
  return value.toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function addCalendarMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const originalDay = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(
    result.getFullYear(),
    result.getMonth() + 1,
    0,
  ).getDate();
  result.setDate(Math.min(originalDay, lastDay));
  return result;
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 11000,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


function formatPoints(value: number): string {
  return `${Math.max(0, Math.floor(Number(value) || 0)).toLocaleString('en-NG')}`;
}

function createStableKey(value: string): string {
  return createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex').slice(0, 20);
}

