import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentsService } from '../payments/payments.service';
import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import { ExchangeRateService } from './exchange-rate.service';
import { SystemMonitorService } from '../system-monitor/system-monitor.service';

const UNKNOWN_INITIALIZATION_RECOVERY_GRACE_MS = 30 * 60 * 1000;
const INITIALIZED_SESSION_RECHECK_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PaymentGatewaysService {
  private readonly logger = new Logger(PaymentGatewaysService.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly gatewayFactory: PaymentGatewayFactory,
    private readonly configService: ConfigService,
    private readonly exchangeRateService: ExchangeRateService,
    private readonly systemMonitor: SystemMonitorService,
  ) {}

  quotePayment(dto: {
    userId: string;
    type: 'subscription' | 'vip_upgrade' | 'premium_upgrade';
    target: string;
    promoCode?: string;
  }) {
    return this.systemMonitor.trackOperation(
      'payment-gateways',
      'payment-gateways.service',
      'quote-payment',
      () => this.quotePaymentInternal(dto),
      { isExpectedFailure: (error) => this.isClientError(error) },
    );
  }

  initializePayment(dto: {
    userId: string;
    email: string;
    gateway: 'paystack';
    type: 'subscription' | 'vip_upgrade' | 'premium_upgrade';
    target: string;
    promoCode?: string;
  }) {
    return this.systemMonitor.trackOperation(
      'payment-gateways',
      'payment-gateways.service',
      'initialize-payment',
      () => this.initializePaymentInternal(dto),
      { isExpectedFailure: (error) => this.isClientError(error) },
    );
  }

  verifyPayment(gatewayName: 'paystack', reference: string, userId: string) {
    return this.systemMonitor.trackOperation(
      'payment-gateways',
      'payment-gateways.service',
      'verify-payment',
      () => this.verifyPaymentInternal(gatewayName, reference, userId),
      { isExpectedFailure: (error) => this.isClientError(error) },
    );
  }

  getInitialization(reference: string, userId: string) {
    return this.paymentsService.getGatewayInitialization(reference, userId);
  }

  reconcilePayment(reference: string) {
    return this.systemMonitor.trackOperation(
      'payment-gateways',
      'payment-gateways.service',
      'admin-reconcile-payment',
      async () => {
        const payment = await this.paymentsService.findPaymentByReference(reference);
        if (!payment || payment.gateway !== 'paystack') {
          throw new BadRequestException('Paystack payment record not found.');
        }
        return this.verifyPaymentInternal('paystack', reference, payment.userId);
      },
      { isExpectedFailure: (error) => this.isClientError(error) },
    );
  }

  handleWebhook(
    payload: unknown,
    signature: string | undefined,
    rawBody: Buffer | undefined,
  ) {
    return this.systemMonitor.trackOperation(
      'payment-gateways',
      'payment-gateways.service',
      'process-paystack-webhook',
      () => this.handleWebhookInternal(payload, signature, rawBody),
      { isExpectedFailure: (error) => this.isClientError(error) },
    );
  }

  private isClientError(error: unknown): boolean {
    const status =
      typeof (error as any)?.getStatus === 'function'
        ? Number((error as any).getStatus())
        : 500;
    return status >= 400 && status < 500;
  }

  private errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 500);
  }

  private paymentInitializationAgeMs(payment: any): number {
    const start =
      payment.gatewayInitializationAttemptedAt ??
      payment.gatewayInitializedAt ??
      payment.createdAt;
    const timestamp = start ? new Date(start).getTime() : Date.now();
    return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : 0;
  }

  private isDefinitiveMissingReference(verification: {
    status: string;
    message?: string;
  }): boolean {
    return (
      verification.status === 'unknown' &&
      /transaction(?: reference)? not found/i.test(
        String(verification.message ?? ''),
      )
    );
  }

  private isDefinitiveInitializationFailure(error: unknown): boolean {
    const responseStatus = Number((error as any)?.response?.status ?? 0);
    const nestStatus =
      typeof (error as any)?.getStatus === 'function'
        ? Number((error as any).getStatus())
        : 0;
    const status = responseStatus || nestStatus;

    // Timeouts, conflicts and rate limits are treated as uncertain. The provider
    // may have accepted the transaction even though the response was lost.
    if ([408, 409, 425, 429].includes(status)) return false;
    return status >= 400 && status < 500;
  }

  private async quotePaymentInternal(dto: {
    userId: string;
    type: 'subscription' | 'vip_upgrade' | 'premium_upgrade';
    target: string;
    promoCode?: string;
  }) {
    return this.paymentsService.calculateGatewayPaymentAmount(dto);
  }

  private async initializePaymentInternal(dto: {
    userId: string;
    email: string;
    gateway: 'paystack';
    type: 'subscription' | 'vip_upgrade' | 'premium_upgrade';
    target: string;
    promoCode?: string;
  }) {
    // Return the existing active session instead of sending a second initialize
    // request for the same user/plan. Unknown results must be verified by reference.
    let activePayment = await this.paymentsService.findActivePaymentForUser(
      dto.userId,
    );

    if (activePayment) {
      const initializationAge = this.paymentInitializationAgeMs(activePayment);
      const shouldReconcile =
        activePayment.gateway === 'paystack' &&
        activePayment.status === 'pending' &&
        ((activePayment.gatewayInitializationStatus === 'unknown' ||
          activePayment.gatewayInitializationStatus === 'initializing') &&
          initializationAge >= UNKNOWN_INITIALIZATION_RECOVERY_GRACE_MS ||
          activePayment.gatewayInitializationStatus === 'initialized' &&
            initializationAge >= INITIALIZED_SESSION_RECHECK_MS);

      if (shouldReconcile) {
        const reconciliation = await this.verifyPaymentInternal(
          'paystack',
          activePayment.reference,
          dto.userId,
        );

        if (reconciliation.status === 'approved') {
          throw new ConflictException({
            message:
              'Your previous payment was successfully confirmed. Refresh your account before making another purchase.',
            reference: activePayment.reference,
            paymentStatus: 'approved',
          });
        }
        activePayment = await this.paymentsService.findActivePaymentForUser(
          dto.userId,
        );
      }

      if (activePayment) {
        if (
          activePayment.type === dto.type &&
          activePayment.target === dto.target &&
          activePayment.gateway === 'paystack' &&
          activePayment.gatewayInitializationStatus === 'initialized' &&
          activePayment.gatewayAuthorizationUrl &&
          this.paymentInitializationAgeMs(activePayment) <
            INITIALIZED_SESSION_RECHECK_MS
        ) {
          return {
            authorizationUrl: activePayment.gatewayAuthorizationUrl,
            reference: activePayment.reference,
          };
        }

        throw new ConflictException({
          message:
            'An active payment already exists. Verify its reference before starting another payment.',
          reference: activePayment.reference,
          paymentStatus: activePayment.status,
          initializationStatus: activePayment.gatewayInitializationStatus,
        });
      }
    }

    const pricing = await this.paymentsService.calculateGatewayPaymentAmount({
      userId: dto.userId,
      type: dto.type,
      target: dto.target,
      promoCode: dto.promoCode,
    });

    const originalAmount = pricing.amount;
    const originalCurrency = pricing.currency;
    let gatewayAmount = originalAmount;
    let exchangeRate: number | undefined;

    if (originalCurrency === 'USD') {
      const conversion =
        await this.exchangeRateService.convertUsdToNgn(originalAmount);
      gatewayAmount = conversion.amount;
      exchangeRate = conversion.rate;
    }

    let payment;
    try {
      payment = await this.paymentsService.createGatewayPaymentRecord({
        userId: dto.userId,
        email: dto.email,
        gateway: dto.gateway,
        type: dto.type,
        target: dto.target,
        amount: originalAmount,
        baseAmount: pricing.baseAmount,
        discountAmount: pricing.discountAmount,
        promoId: pricing.promoId,
        promoCode: pricing.promoCode,
        discountType: pricing.discountType,
        discountValue: pricing.discountValue,
        pointsReward: pricing.pointsReward,
        currency: originalCurrency,
        gatewayAmount,
        gatewayCurrency: 'NGN',
        exchangeRate,
      });
    } catch (error) {
      const racedPayment = await this.paymentsService.findActivePaymentForUser(
        dto.userId,
      );
      if (racedPayment) {
        throw new ConflictException({
          message:
            'An active payment already exists. Verify its reference before starting another payment.',
          reference: racedPayment.reference,
          paymentStatus: racedPayment.status,
          initializationStatus: racedPayment.gatewayInitializationStatus,
        });
      }
      throw error;
    }

    if (payment.gatewayAmount == null || !Number.isFinite(payment.gatewayAmount)) {
      await this.paymentsService.rejectGatewayPayment(
        payment.reference,
        { reason: 'gateway_amount_invalid' },
        true,
      );
      throw new BadRequestException(
        'Gateway payment amount could not be calculated.',
      );
    }

    const gateway = this.gatewayFactory.create(dto.gateway);
    try {
      const initialized = await gateway.initializePayment({
        email: dto.email,
        amount: payment.gatewayAmount,
        currency: 'NGN',
        reference: payment.reference,
        callbackUrl: `${this.configService.get<string>('FRONTEND_URL')}/pricing/callback?gateway=${dto.gateway}`,
      });

      if (
        !initialized.authorizationUrl ||
        initialized.reference !== payment.reference
      ) {
        throw new Error(
          'Gateway returned an incomplete or mismatched initialization response.',
        );
      }

      await this.paymentsService.markGatewayInitializationSucceeded(
        payment.reference,
        initialized.authorizationUrl,
      );

      return {
        ...initialized,
        reference: payment.reference,
      };
    } catch (error) {
      const message = this.errorMessage(error);
      if (this.isDefinitiveInitializationFailure(error)) {
        try {
          await this.paymentsService.rejectGatewayPayment(
            payment.reference,
            {
              reason: 'gateway_initialization_rejected',
              message,
            },
            true,
          );
        } catch (stateError) {
          this.logger.error(
            `Could not record definitive initialization failure for ${payment.reference}: ${this.errorMessage(stateError)}`,
          );
        }
        throw error;
      }

      try {
        await this.paymentsService.markGatewayInitializationUnknown(
          payment.reference,
          error,
        );
      } catch (stateError) {
        this.logger.error(
          `Could not mark gateway initialization ${payment.reference} as unknown: ${this.errorMessage(stateError)}`,
        );
      }

      throw new ServiceUnavailableException({
        message:
          'The gateway response could not be confirmed. Do not start another payment. Verify the existing reference or retrieve its initialization status.',
        reference: payment.reference,
        status: 'initialization_unknown',
      });
    }
  }

  private async rejectGatewayVerification(
    reference: string,
    gatewayResponse: Record<string, any>,
    message?: string,
    initializationFailed = false,
  ) {
    try {
      const rejected = await this.paymentsService.rejectGatewayPayment(
        reference,
        gatewayResponse,
        initializationFailed,
      );
      if (rejected.status === 'approved') {
        return this.verifiedPaymentResponse(rejected, true, 'approved');
      }
      return this.verifiedPaymentResponse(rejected, false, 'failed', {
        message: message ?? 'We could not confirm your payment.',
      });
    } catch (error) {
      // A success webhook or verification request may have claimed the payment
      // between the provider response and this rejection attempt.
      const latest = await this.paymentsService.findPaymentByReference(reference);
      if (latest?.status === 'approved') {
        return this.verifiedPaymentResponse(latest, true, 'approved');
      }
      if (latest?.status === 'processing') {
        return this.verifiedPaymentResponse(latest, false, 'processing');
      }
      throw error;
    }
  }

  private async verifyPaymentInternal(
    gatewayName: 'paystack',
    reference: string,
    userId: string,
  ) {
    if (!reference || reference.length > 120) {
      throw new BadRequestException('A valid payment reference is required.');
    }

    const paymentRecord = await this.paymentsService.findPaymentByReference(
      reference,
    );
    if (
      !paymentRecord ||
      paymentRecord.gateway !== gatewayName ||
      paymentRecord.userId !== userId
    ) {
      throw new BadRequestException('Paystack payment record not found.');
    }

    if (paymentRecord.status === 'approved') {
      return this.verifiedPaymentResponse(paymentRecord, true, 'approved');
    }
    if (paymentRecord.status === 'rejected') {
      return this.verifiedPaymentResponse(paymentRecord, false, 'failed');
    }
    if (paymentRecord.status === 'processing') {
      return this.verifiedPaymentResponse(paymentRecord, false, 'processing');
    }

    const gateway = this.gatewayFactory.create(gatewayName);
    const verification = await gateway.verifyPayment(reference);

    if (verification.status === 'success') {
      if (verification.reference !== reference) {
        throw new BadRequestException(
          'The verified gateway reference does not match this payment request.',
        );
      }
      if (
        verification.amountMinor == null ||
        verification.currency !== paymentRecord.gatewayCurrency ||
        verification.amountMinor !==
          Math.round(Number(paymentRecord.gatewayAmount) * 100)
      ) {
        throw new BadRequestException(
          'Verified payment amount or currency does not match the payment record.',
        );
      }
      if (!verification.transactionId) {
        throw new BadRequestException(
          'Payment was successful but no transaction ID was returned.',
        );
      }

      const payment = await this.paymentsService.approveGatewayPayment(
        reference,
        verification.transactionId,
        verification.raw,
      );

      if (payment.status === 'processing') {
        return this.verifiedPaymentResponse(payment, false, 'processing');
      }
      return this.verifiedPaymentResponse(payment, true, 'approved', {
        message:
          verification.message ??
          'Your payment has been successfully confirmed.',
        transactionId: verification.transactionId,
      });
    }

    if (verification.status === 'pending') {
      return {
        success: false,
        status: 'pending',
        message:
          verification.message ??
          'The gateway is still processing this payment. Check again shortly.',
        reference,
        transactionId: verification.transactionId ?? null,
      };
    }

    // A successfully initialized checkout URL can remain unused while the
    // customer is still deciding whether to pay. A provider lookup that says
    // "reference not found" must not reject that valid open payment session.
    // Apply the grace-period rejection only when initialization itself was
    // uncertain and no authorization URL was ever confirmed.
    const initializationWasUncertain = [
      'initializing',
      'unknown',
    ].includes(paymentRecord.gatewayInitializationStatus);
    const referenceNotFoundAfterGrace =
      initializationWasUncertain &&
      this.isDefinitiveMissingReference(verification) &&
      this.paymentInitializationAgeMs(paymentRecord) >=
        UNKNOWN_INITIALIZATION_RECOVERY_GRACE_MS;

    if (verification.status === 'unknown' && !referenceNotFoundAfterGrace) {
      return {
        success: false,
        status: 'pending',
        message:
          verification.message ??
          'The gateway has not provided a final result. Your payment remains open; check again shortly.',
        reference,
        transactionId: verification.transactionId ?? null,
      };
    }

    return this.rejectGatewayVerification(
      reference,
      verification.raw,
      referenceNotFoundAfterGrace
        ? 'The gateway confirmed that no transaction exists for this reference. You can start a new payment.'
        : verification.message ?? 'We could not confirm your payment.',
      referenceNotFoundAfterGrace,
    );
  }

  private verifiedPaymentResponse(
    payment: any,
    success: boolean,
    status: 'approved' | 'failed' | 'processing',
    extra: Record<string, unknown> = {},
  ) {
    return {
      success,
      status,
      message:
        typeof extra.message === 'string'
          ? extra.message
          : status === 'approved'
            ? 'Your payment has been successfully confirmed.'
            : status === 'processing'
              ? 'Your payment is verified and entitlement processing is still underway.'
              : 'We could not confirm your payment.',
      reference: payment.reference,
      transactionId:
        (extra.transactionId as string | undefined) ??
        payment.gatewayTransactionId ??
        null,
      payment: {
        id: String(payment._id),
        reference: payment.reference,
        status: payment.status,
        type: payment.type,
        target: payment.target,
        amount: payment.amount,
        currency: payment.currency,
        gateway: payment.gateway,
        processedAt: payment.processedAt,
      },
    };
  }

  private async handleWebhookInternal(
    payload: unknown,
    signature: string | undefined,
    rawBody: Buffer | undefined,
  ) {
    if (!rawBody?.length) {
      throw new BadRequestException('Raw webhook body is unavailable.');
    }

    const gateway = this.gatewayFactory.create('paystack');
    const valid = await gateway.validateWebhook(payload, signature, rawBody);
    if (!valid) throw new UnauthorizedException('Invalid Paystack webhook signature.');

    const event = await gateway.parseWebhook(payload);
    if (event.status !== 'success') return { received: true };

    const payment = await this.paymentsService.findPaymentByReference(
      event.reference,
    );
    if (!payment || payment.gateway !== 'paystack') {
      // Unknown references are acknowledged to avoid endless provider retries,
      // but they never produce an entitlement.
      return { received: true };
    }

    if (
      event.amountMinor == null ||
      event.currency !== payment.gatewayCurrency ||
      event.amountMinor !== Math.round(Number(payment.gatewayAmount) * 100)
    ) {
      throw new BadRequestException(
        'Webhook amount or currency does not match the payment record.',
      );
    }

    if (payment.status === 'rejected') {
      return { received: true, status: payment.status };
    }

    const approved = await this.paymentsService.approveGatewayPayment(
      event.reference,
      event.transactionId,
      event.raw,
    );

    return { received: true, status: approved.status };
  }
}
