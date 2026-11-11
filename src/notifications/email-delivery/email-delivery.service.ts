import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { Model, Types } from 'mongoose';
import { EmailService } from '../email.service';
import { NotificationCategory } from '../in-app/enums/notification-category.enum';
import {
  EmailDelivery,
  EmailDeliveryDocument,
  EmailDeliveryStatus,
  EmailDeliveryTemplate,
} from './schemas/email-delivery.schema';
import { NotificationPreferencesService } from '../preferences/notification-preferences.service';
import { ResendWebhookService } from './resend-webhook.service';

const MAX_ATTEMPTS = 8;
const MAX_BATCH_SIZE = 10;
const IDLE_POLL_MS = 15_000;
const ACTIVE_POLL_MS = 300;
const LOCK_TIMEOUT_MS = 2 * 60 * 1000;
// Resend retains idempotency keys for 24 hours. An abandoned in-flight request
// older than this safety window is marked UNKNOWN rather than blindly resent.
const RESEND_IDEMPOTENCY_SAFETY_WINDOW_MS = 22 * 60 * 60 * 1000;
const RETENTION_MONTHS = 18;
const ENCRYPTION_CONTEXT = '2xpredict:notification-email-delivery:v1:';

interface EncryptedPayload {
  encryptedPayload: string;
  payloadIv: string;
  payloadAuthTag: string;
}

interface BaseEmailPayload {
  email: string;
}

interface NotificationEmailPayload extends BaseEmailPayload {
  title: string;
  message: string;
  actionUrl?: string | null;
  details?: Array<{ label: string; value: string }>;
}

interface OtpEmailPayload extends BaseEmailPayload {
  otp: string;
}

interface PasswordResetEmailPayload extends BaseEmailPayload {
  resetLink: string;
}

interface WelcomeEmailPayload extends BaseEmailPayload {
  fullName: string;
}

type EmailPayload =
  | NotificationEmailPayload
  | OtpEmailPayload
  | PasswordResetEmailPayload
  | WelcomeEmailPayload;

@Injectable()
export class NotificationEmailDeliveryService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationEmailDeliveryService.name);
  private readonly encryptionKey: Buffer;
  private workerTimer?: NodeJS.Timeout;
  private workerRunning = false;

  constructor(
    @InjectModel(EmailDelivery.name)
    private readonly deliveryModel: Model<EmailDeliveryDocument>,
    private readonly emailService: EmailService,
    private readonly preferencesService: NotificationPreferencesService,
    configService: ConfigService,
    private readonly resendWebhookService: ResendWebhookService,
  ) {
    const jwtSecret = configService.getOrThrow<string>('JWT_SECRET');
    // Domain-separated key derivation avoids storing a second long-lived secret
    // in deployment configuration. Rotating JWT_SECRET requires draining this
    // queue first so already-enqueued payloads remain decryptable.
    this.encryptionKey = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(jwtSecret, 'utf8'),
        Buffer.from('2xpredict-notification-email', 'utf8'),
        Buffer.from(ENCRYPTION_CONTEXT, 'utf8'),
        32,
      ),
    );
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.deliveryModel.createIndexes();
    } catch (error) {
      this.logger.error(
        `Could not ensure email-delivery indexes: ${errorMessage(error)}`,
      );
    }
    this.scheduleWorker(2500);
  }

  onModuleDestroy(): void {
    if (this.workerTimer) clearTimeout(this.workerTimer);
  }

  async enqueueNotification(input: {
    recipientId: string;
    email: string;
    category: NotificationCategory;
    title: string;
    message: string;
    actionUrl?: string | null;
    data?: Record<string, unknown>;
    dedupeKey: string;
  }): Promise<boolean> {
    const essential = isEssentialCategory(input.category);
    return this.enqueue({
      recipientId: input.recipientId,
      email: input.email,
      category: input.category,
      dedupeKey: input.dedupeKey,
      template: EmailDeliveryTemplate.NOTIFICATION,
      essential,
      payload: {
        email: input.email,
        title: input.title,
        message: input.message,
        actionUrl: input.actionUrl ?? null,
        details: buildNotificationEmailDetails(input.data),
      },
    });
  }

  async enqueueOtp(input: {
    recipientId: string;
    email: string;
    otp: string;
    dedupeKey: string;
    scopeKey?: string;
  }): Promise<boolean> {
    return this.enqueue({
      recipientId: input.recipientId,
      email: input.email,
      dedupeKey: input.dedupeKey,
      scopeKey: input.scopeKey,
      category: NotificationCategory.ACCOUNT,
      template: EmailDeliveryTemplate.OTP,
      essential: true,
      payloadExpiresAt: new Date(Date.now() + 20 * 60 * 1000),
      payload: { email: input.email, otp: input.otp },
    });
  }

  async enqueuePasswordReset(input: {
    recipientId: string;
    email: string;
    resetLink: string;
    dedupeKey: string;
  }): Promise<boolean> {
    return this.enqueue({
      recipientId: input.recipientId,
      email: input.email,
      dedupeKey: input.dedupeKey,
      category: NotificationCategory.ACCOUNT,
      template: EmailDeliveryTemplate.PASSWORD_RESET,
      essential: true,
      payloadExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      payload: { email: input.email, resetLink: input.resetLink },
    });
  }

  async enqueueWelcome(input: {
    recipientId: string;
    email: string;
    fullName: string;
    dedupeKey: string;
  }): Promise<boolean> {
    return this.enqueue({
      recipientId: input.recipientId,
      email: input.email,
      dedupeKey: input.dedupeKey,
      category: NotificationCategory.ACCOUNT,
      template: EmailDeliveryTemplate.WELCOME,
      essential: true,
      payload: { email: input.email, fullName: input.fullName },
    });
  }

  async cancelPendingForUser(
    recipientId: string,
    template: EmailDeliveryTemplate,
    reason: string,
    scopeKey?: string,
  ): Promise<void> {
    if (!Types.ObjectId.isValid(recipientId)) return;
    await this.deliveryModel.updateMany(
      {
        recipientId: new Types.ObjectId(recipientId),
        template,
        ...(scopeKey ? { scopeKey } : {}),
        status: {
          $in: [
            EmailDeliveryStatus.PENDING,
            EmailDeliveryStatus.RETRYING,
            EmailDeliveryStatus.PROCESSING,
          ],
        },
      },
      {
        $set: {
          status: EmailDeliveryStatus.SKIPPED,
          lockedAt: null,
          lockToken: null,
          lastError: String(reason).slice(0, 1000),
        },
        $unset: { encryptedPayload: 1, payloadIv: 1, payloadAuthTag: 1 },
      },
    ).exec();
  }

  private async enqueue(input: {
    recipientId: string;
    email: string;
    category: NotificationCategory;
    template: EmailDeliveryTemplate;
    dedupeKey: string;
    scopeKey?: string;
    essential: boolean;
    payload: EmailPayload;
    payloadExpiresAt?: Date;
  }): Promise<boolean> {
    const recipientId = String(input.recipientId ?? '').trim();
    const email = normalizeEmail(input.email);
    const dedupeKey = String(input.dedupeKey ?? '').trim();

    if (
      !Types.ObjectId.isValid(recipientId) ||
      !isValidEmail(email) ||
      !dedupeKey ||
      dedupeKey.length > 180
    ) {
      this.logger.warn(`Skipped malformed ${input.template} email delivery.`);
      return false;
    }

    const allowed = await this.preferencesService.isEmailAllowed(
      recipientId,
      input.category,
      input.essential,
    );
    if (!allowed) return false;

    const encrypted = this.encryptPayload({ ...input.payload, email } as EmailPayload);

    try {
      await this.deliveryModel.create({
        recipientId: new Types.ObjectId(recipientId),
        channel: 'EMAIL',
        template: input.template,
        category: input.category,
        dedupeKey,
        scopeKey: input.scopeKey ?? null,
        recipientAddressFingerprint: this.fingerprintEmail(email),
        ...encrypted,
        essential: input.essential,
        payloadExpiresAt: input.payloadExpiresAt ?? null,
        status: EmailDeliveryStatus.PENDING,
        attempts: 0,
        firstAttemptAt: null,
        nextAttemptAt: new Date(),
        lockedAt: null,
        lockToken: null,
        providerMessageId: null,
        lastError: null,
        expiresAt: addCalendarMonths(new Date(), RETENTION_MONTHS),
      });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return true;
      this.logger.error(
        `Could not enqueue ${input.template} email (${dedupeKey}): ${errorMessage(error)}`,
      );
      throw error;
    }
  }

  /** HMAC fingerprint allows address-specific suppression without storing an email in plaintext. */
  private fingerprintEmail(email: string): string {
    return createHmac('sha256', this.encryptionKey)
      .update(`recipient-email:${normalizeEmail(email)}`, 'utf8')
      .digest('hex');
  }

  private encryptPayload(payload: EmailPayload): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(ENCRYPTION_CONTEXT));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);

    return {
      encryptedPayload: ciphertext.toString('base64'),
      payloadIv: iv.toString('base64'),
      payloadAuthTag: cipher.getAuthTag().toString('base64'),
    };
  }

  private decryptPayload(delivery: EmailDeliveryDocument): EmailPayload {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(delivery.payloadIv, 'base64'),
    );
    decipher.setAAD(Buffer.from(ENCRYPTION_CONTEXT));
    decipher.setAuthTag(Buffer.from(delivery.payloadAuthTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(delivery.encryptedPayload, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext) as EmailPayload;
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
      const idempotencySafetyCutoff = new Date(
        now.getTime() - RESEND_IDEMPOTENCY_SAFETY_WINDOW_MS,
      );

      // Never retry an abandoned in-flight request beyond Resend's documented
      // idempotency retention window: the provider may already have accepted it.
      await this.deliveryModel.updateMany(
        {
          status: { $in: [EmailDeliveryStatus.PROCESSING, EmailDeliveryStatus.RETRYING] },
          firstAttemptAt: { $lte: idempotencySafetyCutoff },
        },
        {
          $set: {
            status: EmailDeliveryStatus.UNKNOWN,
            lockedAt: null,
            lockToken: null,
            lastError:
              'Delivery outcome is unknown after the provider idempotency safety window; manual review is required.',
          },
          $unset: { encryptedPayload: 1, payloadIv: 1, payloadAuthTag: 1 },
        },
      ).exec();

      await this.deliveryModel.updateMany(
        {
          status: EmailDeliveryStatus.PROCESSING,
          lockedAt: { $lte: staleLock },
          attempts: { $gte: MAX_ATTEMPTS },
        },
        {
          $set: {
            status: EmailDeliveryStatus.FAILED,
            lockedAt: null,
            lockToken: null,
            lastError: 'Processing lease expired after the maximum retry attempts.',
          },
          $unset: { encryptedPayload: 1, payloadIv: 1, payloadAuthTag: 1 },
        },
      ).exec();

      while (processed < MAX_BATCH_SIZE) {
        const lockToken = randomUUID();
        const delivery = await this.deliveryModel.findOneAndUpdate(
          {
            attempts: { $lt: MAX_ATTEMPTS },
            $or: [
              {
                status: EmailDeliveryStatus.PENDING,
                nextAttemptAt: { $lte: now },
              },
              {
                status: EmailDeliveryStatus.RETRYING,
                nextAttemptAt: { $lte: now },
              },
              {
                status: EmailDeliveryStatus.PROCESSING,
                lockedAt: { $lte: staleLock },
                $or: [
                  { firstAttemptAt: null },
                  { firstAttemptAt: { $gt: idempotencySafetyCutoff } },
                ],
              },
            ],
          },
          {
            $set: {
              status: EmailDeliveryStatus.PROCESSING,
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

        if (!delivery) break;
        processed += 1;

        try {
          if (delivery.payloadExpiresAt && delivery.payloadExpiresAt.getTime() <= Date.now()) {
            await this.deliveryModel.updateOne(
              { _id: delivery._id, lockToken },
              {
                $set: {
                  status: EmailDeliveryStatus.SKIPPED,
                  lockedAt: null,
                  lockToken: null,
                  lastError: 'The one-time email content expired before dispatch.',
                },
                $unset: { encryptedPayload: 1, payloadIv: 1, payloadAuthTag: 1 },
              },
            ).exec();
            continue;
          }

          const suppressedRecipient = await this.deliveryModel.exists({
            recipientId: delivery.recipientId,
            _id: { $ne: delivery._id },
            recipientAddressFingerprint: delivery.recipientAddressFingerprint,
            status: { $in: [EmailDeliveryStatus.BOUNCED, EmailDeliveryStatus.COMPLAINED, EmailDeliveryStatus.SUPPRESSED] },
          });
          if (suppressedRecipient) {
            await this.deliveryModel.updateOne(
              { _id: delivery._id, lockToken },
              {
                $set: { status: EmailDeliveryStatus.SKIPPED, lockedAt: null, lockToken: null, lastError: 'Recipient has a previous permanent bounce, complaint, or Resend suppression.' },
                $unset: { encryptedPayload: 1, payloadIv: 1, payloadAuthTag: 1 },
              },
            ).exec();
            continue;
          }

          const allowed = await this.preferencesService.isEmailAllowed(
            delivery.recipientId.toString(),
            delivery.category,
            delivery.essential,
          );
          if (!allowed) {
            await this.deliveryModel.updateOne(
              { _id: delivery._id, lockToken },
              {
                $set: {
                  status: EmailDeliveryStatus.SKIPPED,
                  lockedAt: null,
                  lockToken: null,
                  lastError: 'Email delivery preference was disabled before dispatch.',
                },
                $unset: { encryptedPayload: 1, payloadIv: 1, payloadAuthTag: 1 },
              },
            ).exec();
            continue;
          }

          if (!delivery.firstAttemptAt) {
            const firstAttemptAt = new Date();
            await this.deliveryModel.updateOne(
              { _id: delivery._id, lockToken, firstAttemptAt: null },
              { $set: { firstAttemptAt } },
            ).exec();
            delivery.firstAttemptAt = firstAttemptAt;
          }

          const stillOwned = await this.deliveryModel.exists({
            _id: delivery._id,
            status: EmailDeliveryStatus.PROCESSING,
            lockToken,
          });
          if (!stillOwned) continue;

          const payload = this.decryptPayload(delivery);
          const response = await this.sendDelivery(
            delivery.template,
            payload,
            `2xp-notification-${delivery._id.toString()}`,
          );
          const providerError = (response as any)?.error;
          if (providerError) throw normalizeProviderError(providerError);

          const providerMessageId =
            (response as any)?.data?.id ?? (response as any)?.id ?? null;
          await this.deliveryModel.updateOne(
            { _id: delivery._id, lockToken },
            {
              $set: {
                status: EmailDeliveryStatus.SENT,
                providerMessageId: providerMessageId
                  ? String(providerMessageId).slice(0, 160)
                  : null,
                lockedAt: null,
                lockToken: null,
                lastError: null,
              },
              $unset: { encryptedPayload: 1, payloadIv: 1, payloadAuthTag: 1 },
            },
          ).exec();
          if (providerMessageId) {
            // Provider webhook reconciliation must never turn a successful send
            // into a retry. The delivery is already SENT and its encrypted
            // payload has been cleared; a reconciliation failure is monitored
            // separately and is picked up by the webhook reconciliation worker.
            try {
              await this.resendWebhookService.reconcileMessage(String(providerMessageId));
            } catch (reconcileError) {
              this.logger.warn(
                `Resend webhook reconciliation deferred for ${String(providerMessageId)}: ${errorMessage(reconcileError)}`,
              );
            }
          }
        } catch (error) {
          hadError = true;
          const providerError = getProviderError(error);
          const message = errorMessage(error).slice(0, 1000);
          const attempts = Number(delivery.attempts ?? 1);
          const permanent = isPermanentProviderFailure(providerError);
          const exhausted = attempts >= MAX_ATTEMPTS;
          const retryAt = new Date(Date.now() + retryDelayMs(attempts, providerError));

          await this.deliveryModel.updateOne(
            { _id: delivery._id, lockToken },
            {
              $set: {
                status:
                  permanent || exhausted
                    ? EmailDeliveryStatus.FAILED
                    : EmailDeliveryStatus.RETRYING,
                nextAttemptAt: retryAt,
                lockedAt: null,
                lockToken: null,
                lastError: message,
              },
              ...(permanent || exhausted
                ? { $unset: { encryptedPayload: 1, payloadIv: 1, payloadAuthTag: 1 } }
                : {}),
            },
          ).exec();

          this.logger.warn(
            `Email delivery ${delivery.dedupeKey} ${permanent || exhausted ? 'failed permanently' : 'will retry'} (attempt ${attempts}/${MAX_ATTEMPTS}): ${message}`,
          );
        }
      }
    } catch (error) {
      hadError = true;
      this.logger.error(`Email delivery worker failed: ${errorMessage(error)}`);
    } finally {
      this.workerRunning = false;
      this.scheduleWorker(
        processed >= MAX_BATCH_SIZE || (processed > 0 && hadError)
          ? ACTIVE_POLL_MS
          : IDLE_POLL_MS,
      );
    }
  }

  async getQueueHealth() {
    const statuses = Object.values(EmailDeliveryStatus);
    const counts = await Promise.all(statuses.map(async (status) => ({
      status,
      count: await this.deliveryModel.countDocuments({ status }).exec(),
    })));
    const oldestPending = await this.deliveryModel
      .findOne({ status: { $in: [EmailDeliveryStatus.PENDING, EmailDeliveryStatus.RETRYING] }, nextAttemptAt: { $lte: new Date() } })
      .sort({ nextAttemptAt: 1, createdAt: 1 })
      .select({ createdAt: 1, nextAttemptAt: 1 })
      .lean()
      .exec();
    return { collection: 'notification_deliveries', counts: Object.fromEntries(counts.map((item) => [item.status, item.count])), oldestDueDeliveryAt: oldestPending?.createdAt ?? null, checkedAt: new Date().toISOString() };
  }

  private sendDelivery(
    template: EmailDeliveryTemplate,
    payload: EmailPayload,
    idempotencyKey: string,
  ): Promise<unknown> {
    switch (template) {
      case EmailDeliveryTemplate.NOTIFICATION: {
        const data = payload as NotificationEmailPayload;
        return this.emailService.sendNotificationEmail(data, idempotencyKey);
      }
      case EmailDeliveryTemplate.OTP: {
        const data = payload as OtpEmailPayload;
        return this.emailService.sendOtpEmail(data.email, data.otp, idempotencyKey);
      }
      case EmailDeliveryTemplate.PASSWORD_RESET: {
        const data = payload as PasswordResetEmailPayload;
        return this.emailService.sendPasswordResetEmail(
          data.email,
          data.resetLink,
          idempotencyKey,
        );
      }
      case EmailDeliveryTemplate.WELCOME: {
        const data = payload as WelcomeEmailPayload;
        return this.emailService.sendWelcomeEmail(
          { email: data.email, fullName: data.fullName },
          idempotencyKey,
        );
      }
      default:
        throw new Error(`Unsupported email delivery template: ${String(template)}`);
    }
  }
}

function buildNotificationEmailDetails(
  data?: Record<string, unknown>,
): Array<{ label: string; value: string }> {
  if (!data || typeof data !== 'object') return [];

  const details: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    const formatted = String(value).trim().slice(0, 120);
    if (formatted) details.push({ label, value: formatted });
  };

  add('Reference', data.reference);

  if (typeof data.amount === 'number' && Number.isFinite(data.amount)) {
    const currency = String(data.currency ?? 'NGN').toUpperCase();
    const symbol = currency === 'USD' ? '$' : currency === 'NGN' ? '₦' : `${currency} `;
    add('Amount', `${symbol}${data.amount.toLocaleString('en-NG')}`);
  }

  if (data.paymentType) add('Payment Type', formatDetailLabel(data.paymentType));
  if (data.target) add('Target', formatDetailLabel(data.target));
  if (data.plan) add('Plan', formatDetailLabel(data.plan));
  if (data.status) add('Status', formatDetailLabel(data.status));
  if (typeof data.points === 'number' && Number.isFinite(data.points)) {
    add('Bonus Points', data.points.toLocaleString('en-NG'));
  }
  if (typeof data.durationDays === 'number' && Number.isFinite(data.durationDays)) {
    add('Duration', `${data.durationDays} days`);
  }
  if (typeof data.daysRemaining === 'number' && Number.isFinite(data.daysRemaining)) {
    add('Days Remaining', data.daysRemaining);
  }
  if (data.expiryDate) {
    const date = new Date(String(data.expiryDate));
    add(
      'Expiry Date',
      Number.isFinite(date.getTime())
        ? date.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' })
        : String(data.expiryDate),
    );
  }

  return details.slice(0, 8);
}

function formatDetailLabel(value: unknown): string {
  return String(value)
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .slice(0, 120);
}

function normalizeEmail(value: string): string {
  return String(value ?? '').trim().toLowerCase();
}

function isValidEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isEssentialCategory(category: NotificationCategory): boolean {
  return [
    NotificationCategory.ACCOUNT,
    NotificationCategory.PAYMENTS,
    NotificationCategory.SUBSCRIPTIONS,
  ].includes(category);
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

function getProviderError(error: unknown): any {
  return error && typeof error === 'object' ? error as any : {};
}

function normalizeProviderError(error: any): Error & { statusCode?: number; code?: string } {
  const normalized = new Error(String(error?.message ?? 'Resend returned an error')) as Error & {
    statusCode?: number;
    code?: string;
  };
  const providerStatus = error?.statusCode ?? error?.status;
  if (Number.isFinite(Number(providerStatus))) {
    normalized.statusCode = Number(providerStatus);
  }
  if (error?.name) normalized.code = String(error.name);
  else if (error?.code) normalized.code = String(error.code);
  return normalized;
}

function isPermanentProviderFailure(error: any): boolean {
  const statusCode = Number(error?.statusCode);
  const code = String(error?.code ?? '').toLowerCase();
  const message = String(error?.message ?? '').toLowerCase();

  if (statusCode === 429 || statusCode >= 500 || !Number.isFinite(statusCode) || statusCode <= 0) {
    return false;
  }
  if (statusCode === 409 && (code.includes('concurrent') || message.includes('concurrent'))) {
    return false;
  }
  if (statusCode === 409 || [400, 401, 403, 404, 422].includes(statusCode)) {
    return true;
  }
  return false;
}

function retryDelayMs(attempt: number, error: any): number {
  const retryAfter = Number(
    error?.retryAfter ?? error?.retry_after ?? error?.headers?.['retry-after'],
  );
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(60 * 60 * 1000, retryAfter * 1000);
  }
  return Math.min(60 * 60 * 1000, 5000 * 2 ** Math.max(0, attempt - 1));
}

function addCalendarMonths(date: Date, months: number): Date {
  const result = new Date(date);
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

