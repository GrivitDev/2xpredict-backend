import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { PaymentsService } from '../payments/payments.service';
import { TelegramService } from '../telegram/telegram.service';

import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import { UsersService } from '../users/users.service';
import { ExchangeRateService } from './exchange-rate.service';
import { SystemMonitorService } from '../system-monitor/system-monitor.service';

@Injectable()
export class PaymentGatewaysService {
  constructor(
    private readonly paymentsService: PaymentsService,

    private readonly gatewayFactory: PaymentGatewayFactory,

    private readonly configService: ConfigService,

    private readonly telegramService: TelegramService,

    private readonly usersService: UsersService,

    private readonly exchangeRateService: ExchangeRateService,
    private readonly systemMonitor: SystemMonitorService,
  ) {}

  quotePayment(dto: { userId: string; type: 'subscription' | 'vip_upgrade' | 'premium_upgrade'; target: string; promoCode?: string }) {
    return this.systemMonitor.trackOperation(
      'payment-gateways', 'payment-gateways.service', 'quote-payment',
      () => this.quotePaymentInternal(dto),
      { isExpectedFailure: (error) => this.isClientError(error) },
    );
  }

  initializePayment(dto: {
    userId: string; email: string; gateway: 'paystack';
    type: 'subscription' | 'vip_upgrade' | 'premium_upgrade'; target: string; promoCode?: string;
  }) {
    return this.systemMonitor.trackOperation(
      'payment-gateways', 'payment-gateways.service', 'initialize-payment',
      () => this.initializePaymentInternal(dto),
      { isExpectedFailure: (error) => this.isClientError(error) },
    );
  }

  verifyPayment(gatewayName: 'paystack', reference: string, userId: string) {
    return this.systemMonitor.trackOperation(
      'payment-gateways', 'payment-gateways.service', 'verify-payment',
      () => this.verifyPaymentInternal(gatewayName, reference, userId),
      { isExpectedFailure: (error) => this.isClientError(error) },
    );
  }

  handleWebhook(payload: unknown, signature: string | undefined, rawBody: Buffer | undefined) {
    return this.systemMonitor.trackOperation(
      'payment-gateways', 'payment-gateways.service', 'process-paystack-webhook',
      () => this.handleWebhookInternal(payload, signature, rawBody),
      { isExpectedFailure: (error) => this.isClientError(error) },
    );
  }

  private isClientError(error: unknown): boolean {
    const status = typeof (error as any)?.getStatus === 'function' ? Number((error as any).getStatus()) : 500;
    return status >= 400 && status < 500;
  }

  private async quotePaymentInternal(dto: { userId: string; type: 'subscription' | 'vip_upgrade' | 'premium_upgrade'; target: string; promoCode?: string }) {
    return this.paymentsService.calculateGatewayPaymentAmount(dto);
  }

  // ===================================================
  // INITIALIZE PAYMENT
  // ===================================================
  private async initializePaymentInternal(dto: {
    userId: string;
    email: string;
    gateway: 'paystack';
    type: 'subscription' | 'vip_upgrade' | 'premium_upgrade';
    target: string;
    promoCode?: string;
  }) {
    // =================================================
    // GET ORIGINAL PRICE FROM BACKEND
    // =================================================

    const pricing = await this.paymentsService.calculateGatewayPaymentAmount({
      userId: dto.userId,
      type: dto.type,
      target: dto.target,
      promoCode: dto.promoCode,
    });

    const originalAmount = pricing.amount;
    const originalCurrency = pricing.currency;

    // =================================================
    // CONVERT USD → NGN FOR GATEWAY
    // =================================================

    let gatewayAmount = originalAmount;
    let exchangeRate: number | undefined;

    if (originalCurrency === 'USD') {
      const conversion =
        await this.exchangeRateService.convertUsdToNgn(originalAmount);

      gatewayAmount = conversion.amount;
      exchangeRate = conversion.rate;
    }

    // =================================================
    // CREATE PAYMENT RECORD
    // =================================================

    const payment = await this.paymentsService.createGatewayPaymentRecord({
      userId: dto.userId,
      email: dto.email,
      gateway: dto.gateway,
      type: dto.type,
      target: dto.target,

      // What the customer actually purchased
      amount: originalAmount,
      baseAmount: pricing.baseAmount,
      discountAmount: pricing.discountAmount,
      promoId: pricing.promoId,
      promoCode: pricing.promoCode,
      discountType: pricing.discountType,
      discountValue: pricing.discountValue,
      pointsReward: pricing.pointsReward,
      currency: originalCurrency,

      // What Paystack receives
      gatewayAmount,
      gatewayCurrency: 'NGN',

      // Rate used for conversion
      exchangeRate,
    });

    // =================================================
    // CREATE GATEWAY
    // =================================================

    const gateway = this.gatewayFactory.create(dto.gateway);

    // =================================================
    // SEND ONLY NGN TO GATEWAY
    // =================================================

    if (payment.gatewayAmount == null) {
      throw new BadRequestException(
        'Gateway payment amount could not be calculated.',
      );
    }

    try {
      return await gateway.initializePayment({
        email: dto.email,
        amount: payment.gatewayAmount,
        currency: 'NGN',
        reference: payment.reference,
        callbackUrl: `${this.configService.get<string>('FRONTEND_URL')}/pricing/callback?gateway=${dto.gateway}`,
      });
    } catch (error) {
      await this.paymentsService.rejectGatewayPayment(payment.reference, {
        reason: 'gateway_initialization_failed',
      });
      throw error;
    }
  }

  // ===================================================
  // VERIFY PAYMENT
  // ===================================================

  private async verifyPaymentInternal(gatewayName: 'paystack', reference: string, userId: string) {
    if (!reference || reference.length > 120) {
      throw new BadRequestException('A valid payment reference is required.');
    }
    const paymentRecord = await this.paymentsService.findPaymentByReference(reference);
    if (!paymentRecord || paymentRecord.gateway !== 'paystack' || paymentRecord.userId !== userId) {
      throw new BadRequestException('Paystack payment record not found.');
    }

    const gateway = this.gatewayFactory.create(gatewayName);
    const verification = await gateway.verifyPayment(reference);

    if (verification.status === 'success') {
      if (
        verification.amountMinor == null ||
        verification.currency !== paymentRecord.gatewayCurrency ||
        verification.amountMinor !== Math.round(Number(paymentRecord.gatewayAmount) * 100)
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

      return {
        success: true,
        status: 'approved',

        message:
          verification.message ??
          'Your payment has been successfully confirmed.',

        reference,

        transactionId: verification.transactionId,

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

    if (verification.status === 'pending') {
      return {
        success: false,
        status: 'pending',

        message:
          verification.message ??
          'Your payment is still being processed. Please check again shortly.',

        reference,

        transactionId: verification.transactionId ?? null,
      };
    }

    await this.paymentsService.rejectGatewayPayment(
      reference,
      verification.raw,
    );

    return {
      success: false,
      status: 'failed',

      message: verification.message ?? 'We could not confirm your payment.',

      reference,

      transactionId: verification.transactionId ?? null,
    };
  }

  // ===================================================
  // WEBHOOK
  // ===================================================

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
    if (!valid) {
      throw new UnauthorizedException('Invalid webhook signature.');
    }

    const event = await gateway.parseWebhook(payload);
    if (event.status !== 'success') return { received: true };

    const payment = await this.paymentsService.findPaymentByReference(event.reference);
    if (!payment || payment.gateway !== 'paystack') {
      // Acknowledge unknown references to prevent endless retries, while never
      // granting an entitlement without a matching internal payment record.
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

    const shouldNotify = payment.status !== 'approved';
    const approved = await this.paymentsService.approveGatewayPayment(
      event.reference,
      event.transactionId,
      event.raw,
    );

    if (shouldNotify) {
      const user = await this.usersService.findById(payment.userId);
      if (user) {
        await this.telegramService.notifyGatewayPaymentReceived({
          gateway: 'paystack',
          fullName: user.fullName,
          email: user.email,
          amount: payment.amount,
          currency: payment.currency,
          type: payment.type,
          target: payment.target,
          reference: event.reference,
          transactionId: event.transactionId,
        });
      }
    }

    return { received: true, status: approved.status };
  }
}


