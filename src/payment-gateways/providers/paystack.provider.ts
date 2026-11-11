import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

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
  reference?: string;
  status?: string;
  amount?: number;
  currency?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}


// Bound outbound gateway requests. PaymentGatewaysService deliberately treats
// transport timeouts as uncertain outcomes and keeps the payment reference
// available for later verification/reconciliation.
const PAYSTACK_INITIALIZE_TIMEOUT_MS = 15_000;
const PAYSTACK_VERIFY_TIMEOUT_MS = 12_000;

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
          timeout: PAYSTACK_INITIALIZE_TIMEOUT_MS,
        },
      ),
    );

    if (!data.status || !data.data) {
      // A negative provider envelope is not enough to conclude that the
      // transaction was not created. Keep the payment reference recoverable.
      throw new ServiceUnavailableException(
        data.message ?? 'The gateway could not confirm payment initialization.',
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
    let data: PaystackResponse<PaystackTransaction>;
    try {
      const response = await firstValueFrom(
        this.http.get<PaystackResponse<PaystackTransaction>>(
          `${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
          {
            headers: {
              Authorization: `Bearer ${this.secretKey}`,
            },
            timeout: PAYSTACK_VERIFY_TIMEOUT_MS,
          },
        ),
      );
      data = response.data;
    } catch (error) {
      const responseStatus = Number((error as any)?.response?.status ?? 0);
      const responseBody = (error as any)?.response?.data;
      const message =
        typeof responseBody?.message === 'string'
          ? responseBody.message
          : error instanceof Error
            ? error.message
            : 'The gateway could not confirm the transaction state.';

      if ([401, 403].includes(responseStatus)) {
        throw new ServiceUnavailableException(
          'Paystack rejected the verification credentials. Check the configured secret key.',
        );
      }

      // Axios rejects HTTP 4xx/5xx responses before an API envelope can be
      // inspected. Normalize them to UNKNOWN rather than treating transport or
      // lookup errors as a failed charge. The payment service applies the
      // reference-not-found grace period before releasing a pending payment.
      return {
        success: false,
        status: 'unknown',
        message,
        raw: isRecord(responseBody)
          ? (responseBody as Record<string, any>)
          : { message, httpStatus: responseStatus || null },
      };
    }
    const payment = data.data;

    // ===================================================
    // PROVIDER RESPONSE IS NOT VALID
    // ===================================================

    if (!data.status || !payment) {
      return {
        success: false,

        // A negative verification API response is not proof that a transaction
        // failed. It can also represent a temporary or not-yet-indexed result.
        status: 'unknown',

        message: data.message ?? 'The gateway could not confirm the transaction state.',

        transactionId: payment?.id ? String(payment.id) : undefined,
        reference: payment?.reference,
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
        reference: payment.reference,
        amountMinor: typeof payment.amount === 'number' ? payment.amount : undefined,
        currency: payment.currency,
        raw: payment,
      };
    }

    // ===================================================
    // PENDING / PROCESSING
    // ===================================================

    if (['pending', 'ongoing', 'queued', 'processing'].includes(paymentStatus)) {
      return {
        success: false,

        status: 'pending',

        message: data.message ?? 'Your payment is still being processed.',

        transactionId: payment.id ? String(payment.id) : undefined,
        reference: payment.reference,
        amountMinor: typeof payment.amount === 'number' ? payment.amount : undefined,
        currency: payment.currency,
        raw: payment,
      };
    }

    // ===================================================
    // CONFIRMED FAILURE / UNKNOWN PROVIDER STATE
    // ===================================================

    const confirmedFailureStatuses = new Set(['failed', 'abandoned']);
    const confirmedFailure = confirmedFailureStatuses.has(paymentStatus);

    return {
      success: false,

      status: confirmedFailure ? 'failed' : 'unknown',

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



