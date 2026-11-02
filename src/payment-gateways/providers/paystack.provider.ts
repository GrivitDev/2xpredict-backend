import { BadRequestException, Injectable } from '@nestjs/common';

import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';

import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';

import {
  InitializePaymentInput,
  InitializePaymentResult,
  PaymentGateway,
  VerifyPaymentResult,
  WebhookEvent,
} from '../interfaces/payment-gateway.interface';

interface PaystackResponse<T> {
  status: boolean;
  message?: string;
  data?: T;
}

interface PaystackInitializationData {
  authorization_url: string;
  access_code: string;
  reference: string;
}

interface PaystackTransaction {
  id?: string | number;
  status?: string;
  amount?: number;
  currency?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

@Injectable()
export class PaystackProvider implements PaymentGateway {
  private readonly secretKey: string;

  private readonly baseUrl = 'https://api.paystack.co';

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.secretKey = this.config.getOrThrow<string>('PAYSTACK_SECRET_KEY');
  }

  // =====================================================
  // INITIALIZE PAYMENT
  // =====================================================
  async initializePayment(
    input: InitializePaymentInput,
  ): Promise<InitializePaymentResult> {
    const { data } = await firstValueFrom(
      this.http.post<PaystackResponse<PaystackInitializationData>>(
        `${this.baseUrl}/transaction/initialize`,
        {
          email: input.email,

          amount: Math.round(input.amount * 100),

          reference: input.reference,

          callback_url: input.callbackUrl,

          currency: 'NGN',
        },
        {
          headers: {
            Authorization: `Bearer ${this.secretKey}`,
          },
        },
      ),
    );

    if (!data.status || !data.data) {
      throw new BadRequestException(
        data.message ?? 'Unable to initialize payment.',
      );
    }

    return {
      authorizationUrl: data.data.authorization_url,

      accessCode: data.data.access_code,

      reference: data.data.reference,
    };
  }

  // =====================================================
  // VERIFY PAYMENT
  // =====================================================
  async verifyPayment(reference: string): Promise<VerifyPaymentResult> {
    const { data } = await firstValueFrom(
      this.http.get<PaystackResponse<PaystackTransaction>>(
        `${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
        {
          headers: {
            Authorization: `Bearer ${this.secretKey}`,
          },
        },
      ),
    );
    const payment = data.data;

    // ===================================================
    // PROVIDER RESPONSE IS NOT VALID
    // ===================================================

    if (!data.status || !payment) {
      return {
        success: false,

        status: 'failed',

        message: data.message ?? 'Unable to verify payment.',

        transactionId: payment?.id ? String(payment.id) : undefined,
        amountMinor: typeof payment?.amount === 'number' ? payment.amount : undefined,
        currency: payment?.currency,
        raw: data,
      };
    }

    // ===================================================
    // NORMALIZE PAYSTACK STATUS
    // ===================================================

    const paymentStatus = String(payment.status ?? '').toLowerCase();

    // ===================================================
    // SUCCESS
    // ===================================================

    if (paymentStatus === 'success') {
      return {
        success: true,

        status: 'success',

        message: data.message ?? 'Payment verified successfully.',

        transactionId: payment.id ? String(payment.id) : undefined,
        amountMinor: typeof payment.amount === 'number' ? payment.amount : undefined,
        currency: payment.currency,
        raw: payment,
      };
    }

    // ===================================================
    // PENDING / PROCESSING
    // ===================================================

    if (paymentStatus === 'pending' || paymentStatus === 'ongoing') {
      return {
        success: false,

        status: 'pending',

        message: data.message ?? 'Your payment is still being processed.',

        transactionId: payment.id ? String(payment.id) : undefined,
        amountMinor: typeof payment.amount === 'number' ? payment.amount : undefined,
        currency: payment.currency,
        raw: payment,
      };
    }

    // ===================================================
    // FAILED / ABANDONED / OTHER
    // ===================================================

    return {
      success: false,

      status: 'failed',

      message:
        data.message ?? `Payment status: ${payment.status ?? 'unknown'}.`,

      transactionId: payment.id ? String(payment.id) : undefined,
      amountMinor: typeof payment.amount === 'number' ? payment.amount : undefined,
      currency: payment.currency,
      raw: payment,
    };
  }

  // =====================================================
  // VALIDATE WEBHOOK
  // =====================================================
  validateWebhook(
    payload: unknown,
    signature?: string,
    rawBody?: Buffer,
  ): Promise<boolean> {
    if (!signature || !rawBody?.length) return Promise.resolve(false);
    if (!/^[a-f0-9]{128}$/i.test(signature)) return Promise.resolve(false);

    const expected = crypto
      .createHmac('sha512', this.secretKey)
      .update(rawBody)
      .digest();
    const received = Buffer.from(signature, 'hex');
    if (expected.length !== received.length) return Promise.resolve(false);
    return Promise.resolve(crypto.timingSafeEqual(expected, received));
  }

  // =====================================================
  // PARSE WEBHOOK
  // =====================================================
  parseWebhook(payload: unknown): Promise<WebhookEvent> {
    if (!isRecord(payload) || !isRecord(payload.data)) {
      throw new BadRequestException('Invalid Paystack webhook payload.');
    }

    const { reference, id, status, amount, currency } = payload.data;
    if (
      typeof reference !== 'string' ||
      (typeof id !== 'string' && typeof id !== 'number') ||
      typeof status !== 'string'
    ) {
      throw new BadRequestException('Invalid Paystack webhook payload.');
    }

    return Promise.resolve({
      reference,
      transactionId: String(id),
      status: status === 'success' ? 'success' : 'failed',
      amountMinor: typeof amount === 'number' ? amount : undefined,
      currency: typeof currency === 'string' ? currency : undefined,
      raw: payload as Record<string, any>,
    });
  }
}

