export interface InitializePaymentInput {
  email: string;

  amount: number;

  reference: string;

  callbackUrl: string;

  currency: 'NGN';
}

export interface InitializePaymentResult {
  authorizationUrl: string;

  accessCode?: string;

  reference: string;
}

export type PaymentVerificationStatus =
  | 'success'
  | 'pending'
  | 'failed'
  | 'unknown';

export interface VerifyPaymentResult {
  success: boolean;

  status: PaymentVerificationStatus;

  transactionId?: string;

  /** Reference returned by the provider; required before approval. */
  reference?: string;

  message?: string;

  raw: Record<string, any>;
  /** Amount in the provider's smallest currency unit (kobo for NGN). */
  amountMinor?: number;
  currency?: string;
}

export interface WebhookEvent {
  reference: string;

  transactionId: string;

  status: 'success' | 'failed';

  raw: Record<string, any>;
  amountMinor?: number;
  currency?: string;
}

export interface PaymentGateway {
  /**
   * Create a payment session.
   */
  initializePayment(
    input: InitializePaymentInput,
  ): Promise<InitializePaymentResult>;

  /**
   * Verify payment by our internal reference.
   *
   * The provider implementation must normalize
   * Paystack responses into the common
   * application status:
   *
   * success
   * pending
   * failed
   * unknown (the provider did not return a conclusive transaction state)
   */
  verifyPayment(reference: string): Promise<VerifyPaymentResult>;

  /**
   * Validate webhook signature.
   */
  validateWebhook(payload: unknown, signature?: string, rawBody?: Buffer): Promise<boolean>;

  /**
   * Convert the provider's webhook payload
   * into a common application event.
   */
  parseWebhook(payload: any): Promise<WebhookEvent>;
}


