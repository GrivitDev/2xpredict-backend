import {
  Injectable,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';

import { InjectModel } from '@nestjs/mongoose';
import { QueryFilter, Model } from 'mongoose';
import { randomUUID } from 'crypto';

import { Payment, PaymentDocument } from './schemas/payment.schema';

import { SubscriptionsService } from '../subscriptions/subscriptions.service';

import { AdminGateway } from '../realtime/admin.gateway';
import { ReferralsService } from '../referrals/referrals.service';
import { PlanConfigService } from '../plan-config/plan-config.service';
import { UsersService } from '../users/users.service';
import { PromosService, PromoPricingResult } from '../promos/promos.service';
import { PromoEngineService } from '../promos/promo-engine.service';
import { NotificationEventsService } from '../notifications/in-app/notification-events.service';

const ACTIVE_PAYMENT_TYPES = [
  'subscription',
  'vip_upgrade',
  'premium_upgrade',
] as const satisfies readonly Payment['type'][];
type ActivePaymentType = (typeof ACTIVE_PAYMENT_TYPES)[number];
type PaidPlan = 'regular' | 'vip' | 'premium';

interface PaymentAdminSummaryGroup {
  _id?: {
    status?: string;
    currency?: string;
    type?: string;
    target?: string;
  };
  count?: number;
  amount?: number;
}

function isActivePaymentType(type: string): type is ActivePaymentType {
  return ACTIVE_PAYMENT_TYPES.some((activeType) => activeType === type);
}

@Injectable()
export class PaymentsService implements OnModuleInit {
  constructor(
    @InjectModel(Payment.name)
    private paymentModel: Model<Payment>,

    private usersService: UsersService,

    private subscriptionsService: SubscriptionsService,

    private adminGateway: AdminGateway,

    private referralsService: ReferralsService,
    private readonly promoEngineService: PromoEngineService,

    private readonly planConfigService: PlanConfigService,

    private readonly promosService: PromosService,
    private readonly notificationEvents: NotificationEventsService,
  ) {}

  private readonly logger = new Logger(PaymentsService.name);

  private static readonly PROCESSING_LEASE_MS = 2 * 60 * 1000;
  private static readonly PROCESSING_HEARTBEAT_MS = 30 * 1000;

  /** The active-request unique index is business-critical, not a best-effort index. */
  async onModuleInit(): Promise<void> {
    await this.paymentModel.collection.createIndex(
      { activeRequestKey: 1 },
      {
        unique: true,
        sparse: true,
        name: 'uniq_payment_active_request_key',
      },
    );
  }

  private activeRequestKey(userId: string): string {
    // A user may have only one unresolved subscription purchase/upgrade at a
    // time. Different pending targets must not race and create overlapping terms.
    return `v1|${String(userId).trim()}|paid-subscription-purchase`;
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 11000,
    );
  }

  private errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 1000);
  }

  private async createPaymentAndReservePromo(
    paymentData: Record<string, any>,
    promoReservation?: {
      promoId?: string;
      userId: string;
      paymentReference: string;
      baseAmount: number;
      discountAmount: number;
      finalAmount: number;
      pointsReward?: number;
      currency: 'NGN' | 'USD';
    },
  ): Promise<PaymentDocument> {
    const session = await this.paymentModel.db.startSession();
    let createdPayment: PaymentDocument | null = null;

    try {
      await session.withTransaction(async () => {
        const [payment] = await this.paymentModel.create([paymentData], {
          session,
        });
        createdPayment = payment;

        if (promoReservation?.promoId) {
          await this.promosService.reserveRedemption(promoReservation, session);
        }
      });
    } catch (error: unknown) {
      if (this.isDuplicateKeyError(error)) {
        throw new ConflictException(
          'You already have an active payment request for this plan. Complete or resolve it before starting another.',
        );
      }
      throw error;
    } finally {
      await session.endSession();
    }

    if (!createdPayment) {
      throw new InternalServerErrorException(
        'Payment request could not be created.',
      );
    }

    return createdPayment;
  }

  private emitPaymentUpdateSafely(payment: PaymentDocument): void {
    try {
      this.adminGateway.emitPaymentUpdate(payment);
    } catch (error: unknown) {
      this.logger.warn(
        `Payment ${payment.reference} was saved but its realtime update could not be emitted: ${this.errorMessage(error)}`,
      );
    }
  }

  /**
   * Payment rows act as a small durable outbox for payment notifications.
   * Events are uniquely keyed in NotificationEventsService, so retries are safe
   * even when the event was inserted but this payment row was not updated.
   */
  private async dispatchPaymentNotificationOutbox(
    paymentId: string,
  ): Promise<boolean> {
    try {
      let payment = await this.paymentModel.findById(paymentId).exec();
      if (!payment || !payment.notificationOutboxPending) return true;

      if (!payment.paymentSubmittedNotificationQueuedAt) {
        const queued = await this.notificationEvents.paymentSubmitted({
          userId: payment.userId,
          reference: payment.reference,
          amount: payment.amount,
          currency: payment.currency,
          paymentType: payment.type,
          target: payment.target,
        });
        if (!queued) return false;

        await this.paymentModel
          .updateOne(
            {
              _id: payment._id,
              $or: [
                { paymentSubmittedNotificationQueuedAt: null },
                { paymentSubmittedNotificationQueuedAt: { $exists: false } },
              ],
            },
            { $set: { paymentSubmittedNotificationQueuedAt: new Date() } },
          )
          .exec();
      }

      payment = await this.paymentModel.findById(paymentId).exec();
      if (!payment) return false;

      if (
        payment.status === 'approved' &&
        !payment.paymentSuccessfulNotificationQueuedAt
      ) {
        const subscription =
          await this.subscriptionsService.findBySourceReference(
            `payment:${String(payment._id)}`,
          );
        // Every approved payment in this flow must have its source-linked
        // subscription term. Do not mark the notification outbox complete when
        // that record cannot yet be read; the worker will retry instead.
        if (!subscription) return false;

        const queued = await this.notificationEvents.paymentSuccessful({
          userId: payment.userId,
          reference: payment.reference,
          amount: payment.amount,
          currency: payment.currency,
          paymentType: payment.type,
          target: payment.target,
          ...(subscription
            ? {
                subscription: {
                  plan: subscription.plan,
                  isActive: Boolean(subscription.isActive),
                  startDate: new Date(subscription.startDate),
                  expiryDate: new Date(subscription.expiryDate),
                },
              }
            : {}),
        });
        if (!queued) return false;

        await this.paymentModel
          .updateOne(
            {
              _id: payment._id,
              status: 'approved',
              $or: [
                { paymentSuccessfulNotificationQueuedAt: null },
                { paymentSuccessfulNotificationQueuedAt: { $exists: false } },
              ],
            },
            { $set: { paymentSuccessfulNotificationQueuedAt: new Date() } },
          )
          .exec();
      }

      if (
        payment.status === 'rejected' &&
        !payment.paymentRejectedNotificationQueuedAt
      ) {
        const gatewayReason =
          payment.gatewayResponse && typeof payment.gatewayResponse === 'object'
            ? String(
                payment.gatewayResponse.message ??
                  payment.gatewayResponse.reason ??
                  '',
              )
            : '';
        const queued = await this.notificationEvents.paymentRejected({
          userId: payment.userId,
          reference: payment.reference,
          amount: payment.amount,
          currency: payment.currency,
          paymentType: payment.type,
          target: payment.target,
          reason: payment.adminNote || gatewayReason || undefined,
        });
        if (!queued) return false;

        await this.paymentModel
          .updateOne(
            {
              _id: payment._id,
              status: 'rejected',
              $or: [
                { paymentRejectedNotificationQueuedAt: null },
                { paymentRejectedNotificationQueuedAt: { $exists: false } },
              ],
            },
            { $set: { paymentRejectedNotificationQueuedAt: new Date() } },
          )
          .exec();
      }

      const latest = await this.paymentModel
        .findById(paymentId)
        .select(
          'status paymentSubmittedNotificationQueuedAt paymentSuccessfulNotificationQueuedAt paymentRejectedNotificationQueuedAt',
        )
        .lean()
        .exec();
      if (!latest?.paymentSubmittedNotificationQueuedAt) return false;

      const terminalNotificationQueued =
        (latest.status !== 'approved' ||
          Boolean(latest.paymentSuccessfulNotificationQueuedAt)) &&
        (latest.status !== 'rejected' ||
          Boolean(latest.paymentRejectedNotificationQueuedAt));

      if (terminalNotificationQueued) {
        // Include the observed state in the update filter. If the payment
        // becomes approved/rejected after the snapshot above, this update will
        // no longer match and the next worker pass will enqueue its final event.
        await this.paymentModel
          .updateOne(
            {
              _id: paymentId,
              status: latest.status,
              notificationOutboxPending: true,
            },
            { $set: { notificationOutboxPending: false } },
          )
          .exec();
        return true;
      }

      return false;
    } catch (error: unknown) {
      this.logger.warn(
        `Payment notification outbox remains pending for ${paymentId}: ${this.errorMessage(error)}`,
      );
      return false;
    }
  }

  /** Retry notification events that were not persisted before a process failure. */
  async recoverPendingPaymentNotifications(limit = 20): Promise<number> {
    const batchSize = Math.max(
      1,
      Math.min(100, Math.floor(Number(limit) || 20)),
    );
    const pending = await this.paymentModel
      .find({ notificationOutboxPending: true })
      .sort({ updatedAt: 1, createdAt: 1 })
      .limit(batchSize)
      .select('_id')
      .lean()
      .exec();

    let completed = 0;
    for (const payment of pending) {
      if (await this.dispatchPaymentNotificationOutbox(String(payment._id))) {
        completed += 1;
      }
    }
    return completed;
  }

  private validatePaymentTypeAndTarget(type: string, target: string): void {
    if (
      !ACTIVE_PAYMENT_TYPES.includes(
        type as (typeof ACTIVE_PAYMENT_TYPES)[number],
      )
    ) {
      throw new BadRequestException('Unsupported payment type.');
    }

    if (type === 'subscription') {
      if (!['regular', 'vip', 'premium'].includes(target)) {
        throw new BadRequestException('Invalid subscription plan.');
      }
      return;
    }

    if (type === 'vip_upgrade' && target !== 'vip') {
      throw new BadRequestException('Invalid VIP upgrade target.');
    }

    if (type === 'premium_upgrade' && target !== 'premium') {
      throw new BadRequestException('Invalid Premium upgrade target.');
    }
  }

  private async getUserPricing(userId: string) {
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new BadRequestException('User not found');
    }

    const config = await this.planConfigService.get();

    return {
      currency: user.currency,
      pricing:
        user.currency === 'USD'
          ? {
              regular: config.regularPriceUSD,
              vip: config.vipPriceUSD,
              premium: config.premiumPriceUSD,
            }
          : {
              regular: config.regularPrice,
              vip: config.vipPrice,
              premium: config.premiumPrice,
            },
    };
  }

  // =====================================
  // CREATE MANUAL PAYMENT
  // =====================================
  async createPayment(dto: {
    userId: string;
    email: string;
    type: 'subscription' | 'vip_upgrade' | 'premium_upgrade';
    target: string;
    transferReference?: string;
    proofImageUrl?: string;
    proofPublicId?: string;
    proofMessage?: string;
    promoCode?: string;
  }) {
    this.validatePaymentTypeAndTarget(dto.type, dto.target);

    const activePayment = await this.findActivePaymentForUser(dto.userId);
    if (activePayment) {
      throw new ConflictException(
        'You already have an active payment request for this plan. Resolve it before submitting another.',
      );
    }

    const pricing = await this.calculateGatewayPaymentAmount({
      userId: dto.userId,
      type: dto.type,
      target: dto.target,
      promoCode: dto.promoCode,
    });
    const reference = randomUUID();

    const payment: PaymentDocument = await this.createPaymentAndReservePromo(
      {
        userId: dto.userId,
        email: dto.email,
        amount: pricing.amount,
        baseAmount: pricing.baseAmount,
        discountAmount: pricing.discountAmount,
        promoCode: pricing.promoCode,
        promoId: pricing.promoId,
        discountType: pricing.discountType,
        discountValue: pricing.discountValue,
        pointsReward: pricing.pointsReward,
        currency: pricing.currency,
        type: dto.type,
        target: dto.target,
        reference,
        status: 'pending',
        gateway: 'manual',
        gatewayInitializationStatus: 'not_applicable',
        activeRequestKey: this.activeRequestKey(dto.userId),
        notificationOutboxPending: true,
        transferReference: dto.transferReference || '',
        proofImageUrl: dto.proofImageUrl || '',
        proofPublicId: dto.proofPublicId || '',
        proofMessage: dto.proofMessage || '',
        processedAt: null,
        processedBy: null,
        adminNote: '',
      },
      {
        promoId: pricing.promoId,
        userId: dto.userId,
        paymentReference: reference,
        baseAmount: pricing.baseAmount,
        discountAmount: pricing.discountAmount,
        finalAmount: pricing.amount,
        pointsReward: pricing.pointsReward,
        currency: pricing.currency,
      },
    );

    await this.dispatchPaymentNotificationOutbox(String(payment._id));

    try {
      this.adminGateway.emitNewPayment(payment);
    } catch (error: unknown) {
      this.logger.warn(
        `Payment ${payment.reference} was created but its realtime event could not be emitted: ${this.errorMessage(error)}`,
      );
    }

    return {
      message: 'Payment submitted',
      reference,
      payment,
    };
  }

  // =====================================
  // CALCULATE GATEWAY PAYMENT AMOUNT
  // =====================================
  async calculateGatewayPaymentAmount(dto: {
    userId: string;

    type: 'subscription' | 'vip_upgrade' | 'premium_upgrade';

    target: string;
    promoCode?: string;
  }): Promise<PromoPricingResult & { currency: 'NGN' | 'USD' }> {
    this.validatePaymentTypeAndTarget(dto.type, dto.target);
    const { currency, pricing } = await this.getUserPricing(dto.userId);

    let amount = 0;

    const prices = {
      regular: pricing.regular,
      vip: pricing.vip,
      premium: pricing.premium,
    };

    if (dto.type === 'subscription') {
      if (!['regular', 'vip', 'premium'].includes(dto.target)) {
        throw new BadRequestException('Invalid subscription plan.');
      }
      amount = prices[dto.target as PaidPlan];
    } else {
      const targetPlan: PaidPlan =
        dto.type === 'vip_upgrade' ? 'vip' : 'premium';
      if (dto.target !== targetPlan) {
        throw new BadRequestException(`Invalid ${targetPlan} upgrade target.`);
      }

      const upgrade = await this.subscriptionsService.calculatePlanUpgradePrice(
        dto.userId,
        prices,
        targetPlan,
        30,
        currency,
      );

      if (!upgrade.canUpgrade) {
        throw new BadRequestException(
          `You are not eligible for a ${targetPlan} upgrade.`,
        );
      }
      amount = upgrade.amount;
    }

    const plan = dto.target as PaidPlan;
    const discounted = await this.promosService.calculateDiscount({
      userId: dto.userId,
      promoCode: dto.promoCode,
      plan,
      purchaseType: dto.type,
      baseAmount: amount,
      currency,
    });
    return { ...discounted, currency };
  }

  // =====================================
  // CREATE GATEWAY PAYMENT RECORD
  // =====================================
  async createGatewayPaymentRecord(dto: {
    userId: string;
    email: string;
    type: 'subscription' | 'vip_upgrade' | 'premium_upgrade';
    target: string;
    gateway: 'paystack';
    amount: number;
    baseAmount: number;
    discountAmount: number;
    promoId?: string;
    promoCode?: string;
    discountType?: 'percentage' | 'fixed_amount';
    discountValue?: number;
    pointsReward?: number;
    currency: 'NGN' | 'USD';
    gatewayAmount: number;
    gatewayCurrency: 'NGN';
    exchangeRate?: number;
  }) {
    this.validatePaymentTypeAndTarget(dto.type, dto.target);

    const activePayment = await this.findActivePaymentForUser(dto.userId);
    if (activePayment) {
      throw new ConflictException({
        message:
          'You already have an active payment request. Check its status before creating another.',
        reference: activePayment.reference,
        paymentStatus: activePayment.status,
        initializationStatus: String(activePayment.gatewayInitializationStatus),
      });
    }

    const reference = randomUUID();
    const payment = await this.createPaymentAndReservePromo(
      {
        userId: dto.userId,
        email: dto.email,
        amount: dto.amount,
        baseAmount: dto.baseAmount,
        discountAmount: dto.discountAmount,
        promoId: dto.promoId,
        promoCode: dto.promoCode,
        discountType: dto.discountType,
        discountValue: dto.discountValue,
        pointsReward: dto.pointsReward ?? 0,
        currency: dto.currency,
        gatewayAmount: dto.gatewayAmount,
        gatewayCurrency: dto.gatewayCurrency,
        exchangeRate: dto.exchangeRate,
        type: dto.type,
        target: dto.target,
        reference,
        gateway: dto.gateway,
        status: 'pending',
        gatewayInitializationStatus: 'initializing',
        gatewayInitializationAttemptedAt: new Date(),
        gatewayAuthorizationUrl: null,
        gatewayInitializationLastError: null,
        activeRequestKey: this.activeRequestKey(dto.userId),
        notificationOutboxPending: true,
        transferReference: '',
        proofImageUrl: '',
        proofPublicId: '',
        proofMessage: '',
        adminNote: '',
        gatewayResponse: null,
      },
      {
        promoId: dto.promoId,
        userId: dto.userId,
        paymentReference: reference,
        baseAmount: dto.baseAmount,
        discountAmount: dto.discountAmount,
        finalAmount: dto.amount,
        pointsReward: dto.pointsReward,
        currency: dto.currency,
      },
    );

    await this.dispatchPaymentNotificationOutbox(String(payment._id));

    try {
      this.adminGateway.emitNewPayment(payment);
    } catch (error: unknown) {
      this.logger.warn(
        `Gateway payment ${payment.reference} was created but its realtime event could not be emitted: ${this.errorMessage(error)}`,
      );
    }

    return payment;
  }

  async findActivePaymentForUser(userId: string) {
    return this.paymentModel
      .findOne({
        userId,
        status: { $in: ['pending', 'processing'] },
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  async getGatewayInitialization(reference: string, userId: string) {
    const payment = await this.paymentModel
      .findOne({ reference, userId })
      .exec();
    if (!payment || payment.gateway !== 'paystack') {
      throw new BadRequestException('Paystack payment record not found.');
    }

    const gatewayAuthorizationUrl: unknown = payment.gatewayAuthorizationUrl;

    return {
      reference: payment.reference,
      paymentStatus: payment.status,
      initializationStatus: String(payment.gatewayInitializationStatus),
      authorizationUrl:
        payment.gatewayInitializationStatus === 'initialized'
          ? typeof gatewayAuthorizationUrl === 'string'
            ? gatewayAuthorizationUrl
            : null
          : null,
      initializedAt: (payment.gatewayInitializedAt as Date | null) ?? null,
      message:
        payment.gatewayInitializationStatus === 'initialized'
          ? 'Continue with the existing payment session.'
          : payment.gatewayInitializationStatus === 'unknown' ||
              payment.gatewayInitializationStatus === 'initializing'
            ? 'The gateway initialization result is not yet confirmed. Verify this reference before starting another payment.'
            : 'This payment session is not available for continuation.',
    };
  }

  async markGatewayInitializationSucceeded(
    reference: string,
    authorizationUrl: string,
  ) {
    const payment = await this.paymentModel
      .findOneAndUpdate(
        {
          reference,
          status: 'pending',
          gateway: 'paystack',
          gatewayInitializationStatus: { $in: ['initializing', 'unknown'] },
        },
        {
          $set: {
            gatewayInitializationStatus: 'initialized',
            gatewayAuthorizationUrl: authorizationUrl,
            gatewayInitializedAt: new Date(),
            gatewayInitializationLastError: null,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();

    if (payment) return payment;

    const existing = await this.findPaymentByReference(reference);
    if (existing?.gatewayInitializationStatus === 'initialized')
      return existing;
    throw new ConflictException(
      'The payment state changed before gateway initialization could be saved.',
    );
  }

  async markGatewayInitializationUnknown(reference: string, error: unknown) {
    return this.paymentModel
      .findOneAndUpdate(
        { reference, status: 'pending', gateway: 'paystack' },
        {
          $set: {
            gatewayInitializationStatus: 'unknown',
            gatewayInitializationLastError: this.errorMessage(error).slice(
              0,
              500,
            ),
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
  }

  // =====================================
  // FIND PAYMENT
  // =====================================
  async findPaymentByReference(reference: string) {
    return this.paymentModel.findOne({
      reference,
    });
  }

  // =====================================
  // PAYMENT APPROVAL STATE MACHINE
  // =====================================
  private async processPaymentApproval(
    reference: string,
    source: 'manual' | 'paystack',
    details: {
      gatewayTransactionId?: string;
      gatewayResponse?: Record<string, any>;
      adminId?: string;
    } = {},
  ): Promise<PaymentDocument> {
    const beforeClaim = await this.paymentModel.findOne({ reference }).exec();
    if (!beforeClaim) throw new BadRequestException('Payment not found.');

    if (beforeClaim.status === 'approved') return beforeClaim;
    if (beforeClaim.status === 'rejected') {
      throw new ConflictException('This payment has already been rejected.');
    }
    this.validatePaymentTypeAndTarget(beforeClaim.type, beforeClaim.target);

    if (source === 'paystack' && !details.gatewayTransactionId) {
      throw new BadRequestException(
        'A verified gateway transaction ID is required to approve payment.',
      );
    }
    if (source === 'manual' && beforeClaim.gateway !== 'manual') {
      throw new ConflictException(
        'Gateway payments cannot be manually approved.',
      );
    }
    if (source === 'paystack' && beforeClaim.gateway !== 'paystack') {
      throw new ConflictException('This payment does not belong to Paystack.');
    }

    const now = new Date();
    const processingToken = randomUUID();
    const leaseExpiry = new Date(
      now.getTime() + PaymentsService.PROCESSING_LEASE_MS,
    );

    const claimFilter: QueryFilter<Payment> = {
      reference,
      $or: [
        { status: 'pending' },
        {
          status: 'processing',
          $or: [
            { processingLeaseExpiresAt: null },
            { processingLeaseExpiresAt: { $exists: false } },
            { processingLeaseExpiresAt: { $lte: now } },
          ],
        },
      ],
    };

    const claimUpdate: Record<string, any> = {
      $set: {
        status: 'processing',
        processingToken,
        processingLeaseExpiresAt: leaseExpiry,
        approvalSource: source,
        processingLastError: null,
        ...(source === 'manual' && details.adminId
          ? { processedBy: details.adminId }
          : {}),
        ...(source === 'paystack' && details.gatewayTransactionId
          ? { gatewayTransactionId: details.gatewayTransactionId }
          : {}),
        ...(details.gatewayResponse
          ? { gatewayResponse: details.gatewayResponse }
          : {}),
      },
      $inc: { processingAttempts: 1 },
    };

    const payment = await this.paymentModel
      .findOneAndUpdate(claimFilter, claimUpdate, {
        returnDocument: 'after',
      })
      .exec();

    if (!payment) {
      const current = await this.paymentModel.findOne({ reference }).exec();
      if (!current) throw new BadRequestException('Payment not found.');
      if (current.status === 'approved') return current;
      if (current.status === 'rejected') {
        throw new ConflictException('This payment has already been rejected.');
      }
      if (current.status === 'processing') return current;
      throw new ConflictException(
        'Payment state changed. Refresh the payment and retry.',
      );
    }

    const heartbeat = setInterval(() => {
      const nextLease = new Date(
        Date.now() + PaymentsService.PROCESSING_LEASE_MS,
      );
      void this.paymentModel
        .updateOne(
          {
            _id: payment._id,
            status: 'processing',
            processingToken,
          },
          { $set: { processingLeaseExpiresAt: nextLease } },
        )
        .exec()
        .catch((error) => {
          this.logger.error(
            `Could not renew payment processing lease for ${reference}: ${this.errorMessage(error)}`,
          );
        });
    }, PaymentsService.PROCESSING_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      let plan: PaidPlan;
      if (payment.type === 'subscription') {
        plan = payment.target.trim() as PaidPlan;
      } else {
        plan = payment.type === 'vip_upgrade' ? 'vip' : 'premium';
        if (payment.target !== plan) {
          throw new BadRequestException(`Invalid ${plan} upgrade target.`);
        }
      }

      const config = await this.planConfigService.get();
      const durationDays =
        payment.type === 'subscription' ? config.subscriptionDurationDays : 30;

      await this.subscriptionsService.activatePlan({
        userId: payment.userId,
        email: payment.email,
        plan,
        amount: payment.amount,
        durationDays,
        sourceReference: `payment:${String(payment._id)}`,
      });

      const referral =
        plan === 'regular'
          ? await this.referralsService.markRegularSubscription(payment.userId)
          : plan === 'vip'
            ? await this.referralsService.markVipSubscription(payment.userId)
            : await this.referralsService.markPremiumSubscription(
                payment.userId,
              );

      if (referral) {
        // Kept in the payment orchestration layer so ReferralsModule has no
        // reverse dependency on PromosModule. Payment retries safely repeat
        // this evaluation if a previous attempt stopped before completion.
        await this.promoEngineService.checkUserPromos(
          String(referral.referrerId),
        );
      }

      await this.promosService.completeSuccessfulRedemption({
        promoId: payment.promoId,
        userId: payment.userId,
        reference: payment.reference,
        pointsReward: payment.pointsReward,
      });

      const approved = await this.paymentModel
        .findOneAndUpdate(
          {
            _id: payment._id,
            status: 'processing',
            processingToken,
          },
          {
            $set: {
              status: 'approved',
              processedAt: new Date(),
              notificationOutboxPending: true,
              ...(source === 'manual' && details.adminId
                ? { processedBy: details.adminId }
                : {}),
            },
            $unset: {
              activeRequestKey: 1,
              processingToken: 1,
              processingLeaseExpiresAt: 1,
              processingLastError: 1,
            },
          },
          { returnDocument: 'after' },
        )
        .exec();

      if (!approved) {
        const latest = await this.paymentModel.findById(payment._id).exec();
        if (latest?.status === 'approved') return latest;
        throw new ConflictException(
          'Payment processing ownership changed before approval could be committed.',
        );
      }

      await this.dispatchPaymentNotificationOutbox(String(approved._id));
      this.emitPaymentUpdateSafely(approved);
      return approved;
    } catch (error: unknown) {
      const attempt = Number(payment.processingAttempts ?? 1);
      const retryDelayMs = Math.min(
        15 * 60 * 1000,
        15_000 * Math.max(1, Math.min(attempt, 60)),
      );
      try {
        await this.paymentModel
          .updateOne(
            {
              _id: payment._id,
              status: 'processing',
              processingToken,
            },
            {
              $set: {
                processingLastError: this.errorMessage(error),
                processingLeaseExpiresAt: new Date(Date.now() + retryDelayMs),
              },
            },
          )
          .exec();
      } catch (leaseError: unknown) {
        this.logger.error(
          `Could not schedule payment ${reference} for retry: ${this.errorMessage(leaseError)}`,
        );
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async approveGatewayPayment(
    reference: string,
    gatewayTransactionId: string,
    gatewayResponse: Record<string, any>,
  ) {
    return this.processPaymentApproval(reference, 'paystack', {
      gatewayTransactionId,
      gatewayResponse,
    });
  }

  private async rejectPaymentReference(
    reference: string,
    options: {
      source: 'manual' | 'paystack';
      adminId?: string;
      adminNote?: string;
      gatewayResponse?: Record<string, any>;
      initializationFailed?: boolean;
    },
  ) {
    const session = await this.paymentModel.db.startSession();
    let payment: PaymentDocument | null = null;

    try {
      payment = await session.withTransaction(
        async (): Promise<PaymentDocument> => {
          const current = await this.paymentModel
            .findOne({ reference })
            .session(session)
            .exec();
          if (!current) throw new BadRequestException('Payment not found.');
          if (current.status === 'rejected') {
            // Repair a pre-existing rejected record whose promo release may have
            // been interrupted before the transaction boundary was introduced.
            await this.promosService.releaseRedemption(reference, session);
            await this.paymentModel
              .updateOne(
                { _id: current._id, status: 'rejected' },
                { $set: { notificationOutboxPending: true } },
                { session },
              )
              .exec();
            return current;
          }
          if (current.status === 'approved') {
            return current;
          }
          if (current.status !== 'pending') {
            throw new ConflictException(
              'Payment approval is already being processed and cannot be rejected concurrently.',
            );
          }
          if (options.source === 'manual' && current.gateway !== 'manual') {
            throw new ConflictException(
              'Gateway payments cannot be manually rejected.',
            );
          }
          if (options.source === 'paystack' && current.gateway !== 'paystack') {
            throw new ConflictException(
              'This payment does not belong to Paystack.',
            );
          }

          const rejected = await this.paymentModel
            .findOneAndUpdate(
              { _id: current._id, status: 'pending' },
              {
                $set: {
                  status: 'rejected',
                  processedAt: new Date(),
                  notificationOutboxPending: true,
                  ...(options.adminId ? { processedBy: options.adminId } : {}),
                  ...(options.adminNote !== undefined
                    ? { adminNote: options.adminNote }
                    : {}),
                  ...(options.gatewayResponse !== undefined
                    ? { gatewayResponse: options.gatewayResponse }
                    : {}),
                  ...(options.initializationFailed
                    ? { gatewayInitializationStatus: 'failed' }
                    : {}),
                },
                $unset: {
                  activeRequestKey: 1,
                  processingToken: 1,
                  processingLeaseExpiresAt: 1,
                },
              },
              { returnDocument: 'after', session },
            )
            .exec();

          if (!rejected) {
            throw new ConflictException(
              'Payment state changed before rejection could be committed.',
            );
          }

          await this.promosService.releaseRedemption(reference, session);
          return rejected;
        },
      );
    } finally {
      await session.endSession();
    }

    if (!payment) {
      throw new InternalServerErrorException(
        'Payment rejection could not be completed.',
      );
    }

    if (payment.status === 'rejected') {
      await this.dispatchPaymentNotificationOutbox(String(payment._id));
      this.emitPaymentUpdateSafely(payment);
    }

    return payment;
  }

  async rejectGatewayPayment(
    reference: string,
    gatewayResponse?: Record<string, any>,
    initializationFailed = false,
  ) {
    return this.rejectPaymentReference(reference, {
      source: 'paystack',
      gatewayResponse,
      initializationFailed,
    });
  }

  // =====================================
  // APPROVE MANUAL PAYMENT
  // =====================================
  async approvePayment(paymentId: string, adminId: string) {
    const payment = await this.paymentModel.findById(paymentId).exec();
    if (!payment) throw new BadRequestException('Payment not found.');

    const approved = await this.processPaymentApproval(
      payment.reference,
      'manual',
      {
        adminId,
      },
    );

    return {
      message:
        approved.status === 'approved'
          ? 'Payment approved'
          : 'Payment approval is already being processed.',
      payment: approved,
    };
  }

  // =====================================
  // USER PAYMENTS
  // =====================================
  async getUserPayments(userId: string) {
    return this.paymentModel
      .find({
        userId,
        type: { $in: ACTIVE_PAYMENT_TYPES },
      })
      .sort({ createdAt: -1 });
  }

  // =====================================
  // REJECT MANUAL PAYMENT
  // =====================================
  async rejectPayment(paymentId: string, adminId: string, adminNote?: string) {
    const payment = await this.paymentModel.findById(paymentId).exec();
    if (!payment) throw new BadRequestException('Payment not found.');

    return this.rejectPaymentReference(payment.reference, {
      source: 'manual',
      adminId,
      adminNote: adminNote || '',
    });
  }

  // =====================================
  // ADMIN QUERIES
  // =====================================
  async getPendingPayments() {
    return this.paymentModel
      .find({
        status: { $in: ['pending', 'processing'] },
        type: { $in: ACTIVE_PAYMENT_TYPES },
      })
      .sort({
        createdAt: -1,
      });
  }

  async getAllPayments() {
    return this.paymentModel
      .find({ type: { $in: ACTIVE_PAYMENT_TYPES } })
      .sort({
        createdAt: -1,
      });
  }

  async getTotalRevenue() {
    const payments = await this.paymentModel.find({
      status: 'approved',
      type: { $in: ACTIVE_PAYMENT_TYPES },
    });

    return {
      NGN: payments
        .filter((p) => p.currency === 'NGN')
        .reduce((sum, p) => sum + p.amount, 0),

      USD: payments
        .filter((p) => p.currency === 'USD')
        .reduce((sum, p) => sum + p.amount, 0),
    };
  }

  // =====================================
  // USER PAYMENT SUMMARY
  // =====================================
  async getPaymentSummary(userId: string) {
    const payments = await this.paymentModel
      .find({ userId, type: { $in: ACTIVE_PAYMENT_TYPES } })
      .sort({ createdAt: -1 });

    const approved = payments.filter((p) => p.status === 'approved');
    const pending = payments.filter((p) => p.status === 'pending');
    const processing = payments.filter((p) => p.status === 'processing');
    const rejected = payments.filter((p) => p.status === 'rejected');

    const approvedNGN = approved.filter((p) => p.currency === 'NGN');
    const approvedUSD = approved.filter((p) => p.currency === 'USD');

    const subscriptionNGN = approvedNGN.filter(
      (p) =>
        p.type === 'subscription' ||
        p.type === 'vip_upgrade' ||
        p.type === 'premium_upgrade',
    );

    const subscriptionUSD = approvedUSD.filter(
      (p) =>
        p.type === 'subscription' ||
        p.type === 'vip_upgrade' ||
        p.type === 'premium_upgrade',
    );

    return {
      payments,

      latestPayments: payments.slice(0, 10),

      revenue: {
        total: {
          NGN: approvedNGN.reduce((sum, p) => sum + p.amount, 0),
          USD: approvedUSD.reduce((sum, p) => sum + p.amount, 0),
        },

        subscriptions: {
          NGN: subscriptionNGN.reduce((sum, p) => sum + p.amount, 0),
          USD: subscriptionUSD.reduce((sum, p) => sum + p.amount, 0),
        },

        plans: {
          regular: {
            NGN: approvedNGN
              .filter(
                (p) => p.type === 'subscription' && p.target === 'regular',
              )
              .reduce((sum, p) => sum + p.amount, 0),
            USD: approvedUSD
              .filter(
                (p) => p.type === 'subscription' && p.target === 'regular',
              )
              .reduce((sum, p) => sum + p.amount, 0),
          },
          vip: {
            NGN: approvedNGN
              .filter(
                (p) =>
                  (p.type === 'subscription' && p.target === 'vip') ||
                  p.type === 'vip_upgrade',
              )
              .reduce((sum, p) => sum + p.amount, 0),
            USD: approvedUSD
              .filter(
                (p) =>
                  (p.type === 'subscription' && p.target === 'vip') ||
                  p.type === 'vip_upgrade',
              )
              .reduce((sum, p) => sum + p.amount, 0),
          },
          premium: {
            NGN: approvedNGN
              .filter(
                (p) =>
                  (p.type === 'subscription' && p.target === 'premium') ||
                  p.type === 'premium_upgrade',
              )
              .reduce((sum, p) => sum + p.amount, 0),
            USD: approvedUSD
              .filter(
                (p) =>
                  (p.type === 'subscription' && p.target === 'premium') ||
                  p.type === 'premium_upgrade',
              )
              .reduce((sum, p) => sum + p.amount, 0),
          },
        },
      },

      totalPayments: payments.length,

      approvedPayments: approved.length,

      pendingPayments: pending.length + processing.length,
      processingPayments: processing.length,

      rejectedPayments: rejected.length,
    };
  }
  // =====================================
  // LATEST USER PAYMENTS
  // =====================================
  // Lightweight summary for the admin user profile. It aggregates in MongoDB
  // instead of loading the user's complete payment history into application memory.
  async getUserPaymentAdminSummary(userId: string) {
    const match = { userId, type: { $in: ACTIVE_PAYMENT_TYPES } };
    const [groups, latestPayments] = await Promise.all([
      this.paymentModel
        .aggregate<PaymentAdminSummaryGroup>([
          { $match: match },
          {
            $group: {
              _id: {
                status: '$status',
                currency: '$currency',
                type: '$type',
                target: '$target',
              },
              count: { $sum: 1 },
              amount: {
                $sum: {
                  $cond: [{ $eq: ['$status', 'approved'] }, '$amount', 0],
                },
              },
            },
          },
        ])
        .exec(),
      this.paymentModel
        .find(match)
        .sort({ createdAt: -1 })
        .limit(10)
        .lean()
        .exec(),
    ]);

    const counts = {
      total: 0,
      approved: 0,
      pending: 0,
      processing: 0,
      rejected: 0,
    };
    const totalRevenue = { NGN: 0, USD: 0 };
    const subscriptionRevenue = { NGN: 0, USD: 0 };
    const plans = {
      regular: { NGN: 0, USD: 0 },
      vip: { NGN: 0, USD: 0 },
      premium: { NGN: 0, USD: 0 },
    };
    for (const group of groups) {
      const status = String(group._id?.status ?? '').toLowerCase();
      const currency = String(group._id?.currency ?? '').toUpperCase();
      const type = String(group._id?.type ?? '');
      const target = String(group._id?.target ?? '').toLowerCase();
      const count = Number(group.count ?? 0);
      const amount = Number(group.amount ?? 0);
      counts.total += count;
      if (status === 'approved') counts.approved += count;
      if (status === 'pending') counts.pending += count;
      if (status === 'processing') {
        counts.processing += count;
        counts.pending += count;
      }
      if (status === 'rejected') counts.rejected += count;
      if (status !== 'approved' || (currency !== 'NGN' && currency !== 'USD')) {
        continue;
      }
      totalRevenue[currency] += amount;
      if (!isActivePaymentType(type)) continue;
      subscriptionRevenue[currency] += amount;
      if (type === 'subscription') {
        if (target === 'regular' || target === 'vip' || target === 'premium') {
          plans[target][currency] += amount;
        }
      } else if (type === 'vip_upgrade') {
        plans.vip[currency] += amount;
      } else if (type === 'premium_upgrade') {
        plans.premium[currency] += amount;
      }
    }
    return {
      latestPayments,
      totalPayments: counts.total,
      approvedPayments: counts.approved,
      pendingPayments: counts.pending,
      processingPayments: counts.processing,
      rejectedPayments: counts.rejected,
      revenue: {
        total: totalRevenue,
        subscriptions: subscriptionRevenue,
        plans,
      },
    };
  }

  // Paginated full payment history for the admin profile's History tab.
  async getUserPaymentHistory(userId: string, pageValue = 1, limitValue = 10) {
    const page = Math.max(1, Math.floor(Number(pageValue) || 1));
    const limit = Math.min(
      100,
      Math.max(1, Math.floor(Number(limitValue) || 10)),
    );
    const filter = { userId, type: { $in: ACTIVE_PAYMENT_TYPES } };
    const [items, total] = await Promise.all([
      this.paymentModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.paymentModel.countDocuments(filter).exec(),
    ]);
    return {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async getLatestUserPayments(userId: string, limit = 10) {
    return this.paymentModel
      .find({ userId, type: { $in: ACTIVE_PAYMENT_TYPES } })
      .sort({ createdAt: -1 })
      .limit(limit);
  }

  // =====================================
  // USER LIFETIME REVENUE
  // =====================================
  async getLifetimeRevenue(userId: string) {
    const payments = await this.paymentModel.find({
      userId,
      status: 'approved',
      type: { $in: ACTIVE_PAYMENT_TYPES },
    });

    return {
      NGN: payments
        .filter((p) => p.currency === 'NGN')
        .reduce((sum, p) => sum + p.amount, 0),

      USD: payments
        .filter((p) => p.currency === 'USD')
        .reduce((sum, p) => sum + p.amount, 0),
    };
  }

  // =====================================
  // COUNT PAYMENTS
  // =====================================
  async countPayments() {
    return this.paymentModel.countDocuments({
      type: { $in: ACTIVE_PAYMENT_TYPES },
    });
  }

  // =====================================
  // RECENT PAYMENTS
  // =====================================
  async getRecentPayments(limit = 10) {
    return this.paymentModel
      .find({ type: { $in: ACTIVE_PAYMENT_TYPES } })
      .sort({
        createdAt: -1,
      })
      .limit(limit);
  }

  // =====================================
  // MARK UNCERTAIN GATEWAY INITIALIZATIONS
  // =====================================
  // Kept under the old public method name for compatibility with any external
  // caller, but it never deletes a payment. An old Paystack request may have
  // succeeded even when the HTTP response was lost; its reference must remain
  // available for verification and recovery.
  async markExpiredGatewayInitializationsUnknown(): Promise<number> {
    const expirationTime = new Date(Date.now() - 30 * 60 * 1000);
    const result = await this.paymentModel
      .updateMany(
        {
          status: 'pending',
          gateway: 'paystack',
          gatewayInitializationStatus: 'initializing',
          createdAt: { $lt: expirationTime },
        },
        {
          $set: {
            gatewayInitializationStatus: 'unknown',
            gatewayInitializationLastError:
              'Initialization response was not recorded. Verify the existing reference before retrying.',
          },
        },
      )
      .exec();
    return result.modifiedCount ?? 0;
  }

  /** Backwards-compatible alias; stale gateway payments are never deleted. */
  async deleteExpiredPendingGatewayPayments(): Promise<number> {
    return this.markExpiredGatewayInitializationsUnknown();
  }

  /** Resume processing records whose worker lease expired after a crash. */
  async recoverStalePaymentProcessing(limit = 10): Promise<number> {
    const now = new Date();
    const stale = await this.paymentModel
      .find({
        status: 'processing',
        $or: [
          { processingLeaseExpiresAt: null },
          { processingLeaseExpiresAt: { $exists: false } },
          { processingLeaseExpiresAt: { $lte: now } },
        ],
      })
      .sort({ processingLeaseExpiresAt: 1, createdAt: 1 })
      .limit(Math.max(1, Math.min(50, Math.floor(limit))))
      .select(
        'reference approvalSource gateway gatewayTransactionId gatewayResponse processedBy',
      )
      .lean()
      .exec();

    let recovered = 0;
    for (const item of stale) {
      const approvalSource = item.approvalSource as unknown;
      const gateway = item.gateway as unknown;
      const source: 'manual' | 'paystack' =
        approvalSource === 'paystack' || approvalSource === 'manual'
          ? approvalSource
          : gateway === 'paystack'
            ? 'paystack'
            : 'manual';
      const gatewayResponse = item.gatewayResponse as unknown;
      const safeGatewayResponse =
        typeof gatewayResponse === 'object' &&
        gatewayResponse !== null &&
        !Array.isArray(gatewayResponse)
          ? (gatewayResponse as Record<string, any>)
          : undefined;
      try {
        const payment = await this.processPaymentApproval(
          item.reference,
          source,
          {
            ...(item.gatewayTransactionId
              ? { gatewayTransactionId: item.gatewayTransactionId }
              : {}),
            ...(safeGatewayResponse
              ? { gatewayResponse: safeGatewayResponse }
              : {}),
            ...(item.processedBy ? { adminId: item.processedBy } : {}),
          },
        );
        if (payment.status === 'approved') recovered += 1;
      } catch (error) {
        this.logger.error(
          `Could not recover payment ${item.reference}: ${this.errorMessage(error)}`,
        );
      }
    }
    return recovered;
  }
}
