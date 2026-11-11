import { Injectable, BadRequestException, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Model } from 'mongoose';
import { EmailDelivery, EmailDeliveryDocument, EmailDeliveryStatus } from './schemas/email-delivery.schema';
import {
  ResendEmailProviderEvent,
  ResendEmailProviderEventDocument,
  ResendEmailProviderEventStatus,
} from './schemas/resend-email-provider-event.schema';

const RETENTION_MONTHS = 18;
const SIGNATURE_TOLERANCE_SECONDS = 300;
interface ResendWebhookEnvelope { type?: string; created_at?: string; data?: { email_id?: string }; }

@Injectable()
export class ResendWebhookService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ResendWebhookService.name);
  private readonly secret: string;
  private reconcileTimer?: NodeJS.Timeout;
  private reconciling = false;
  constructor(
    @InjectModel(EmailDelivery.name) private readonly deliveryModel: Model<EmailDeliveryDocument>,
    @InjectModel(ResendEmailProviderEvent.name) private readonly providerEventModel: Model<ResendEmailProviderEventDocument>,
    config: ConfigService,
  ) { this.secret = config.get<string>('RESEND_WEBHOOK_SECRET')?.trim() ?? ''; }

  async onModuleInit(): Promise<void> {
    try {
      await this.providerEventModel.createIndexes();
    } catch (error) {
      this.logger.error(`Could not ensure Resend webhook indexes: ${errorMessage(error)}`);
    }
    this.scheduleReconciliation(10_000);
  }

  onModuleDestroy(): void {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
  }

  async receive(rawBody: Buffer | undefined, headers: { id?: string; timestamp?: string; signature?: string }): Promise<{ received: true; matched: boolean }> {
    if (!this.secret) throw new ServiceUnavailableException('Resend webhook signing secret is not configured.');
    if (!rawBody?.length) throw new BadRequestException('Missing raw webhook body.');
    const id = String(headers.id ?? '').trim();
    const timestamp = String(headers.timestamp ?? '').trim();
    const signature = String(headers.signature ?? '').trim();
    this.verifySignature(rawBody, id, timestamp, signature);

    let envelope: ResendWebhookEnvelope;
    try { envelope = JSON.parse(rawBody.toString('utf8')) as ResendWebhookEnvelope; }
    catch { throw new BadRequestException('Invalid Resend webhook JSON.'); }
    const eventType = String(envelope.type ?? '').trim();
    if (!eventType || eventType.length > 100) throw new BadRequestException('Invalid Resend event type.');
    const providerMessageId = String(envelope.data?.email_id ?? '').trim() || null;
    const occurredAt = parseDate(envelope.created_at) ?? new Date(Number(timestamp) * 1000);
    const eventStatus = providerMessageId && mapEventStatus(eventType)
      ? ResendEmailProviderEventStatus.PENDING : ResendEmailProviderEventStatus.IGNORED;

    let event: ResendEmailProviderEventDocument;
    try {
      event = await this.providerEventModel.create({
        eventId: id, eventType, providerMessageId, occurredAt, status: eventStatus,
        processedAt: eventStatus === ResendEmailProviderEventStatus.IGNORED ? new Date() : null,
        lastError: null, expiresAt: addCalendarMonths(new Date(), RETENTION_MONTHS),
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const existing = await this.providerEventModel.findOne({ eventId: id }).exec();
      if (!existing) throw error;
      event = existing;
    }
    if (event.status === ResendEmailProviderEventStatus.PROCESSED || event.status === ResendEmailProviderEventStatus.IGNORED) {
      return { received: true, matched: true };
    }
    return { received: true, matched: await this.applyProviderEvent(event) };
  }

  /** Reconcile a webhook that arrived before the send worker saved providerMessageId. */
  async reconcileMessage(providerMessageId: string): Promise<void> {
    const id = String(providerMessageId ?? '').trim();
    if (!id) return;
    const events = await this.providerEventModel.find({ providerMessageId: id, status: ResendEmailProviderEventStatus.PENDING }).sort({ occurredAt: 1 }).limit(20).exec();
    for (const event of events) await this.applyProviderEvent(event);
  }

  private scheduleReconciliation(delayMs: number): void {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      void this.processPendingReconciliation();
    }, delayMs);
    this.reconcileTimer.unref?.();
  }

  /** Retries webhook events that arrived before their delivery record was linked. */
  private async processPendingReconciliation(): Promise<void> {
    if (this.reconciling) {
      this.scheduleReconciliation(60_000);
      return;
    }
    this.reconciling = true;
    let batchSize = 0;
    try {
      const events = await this.providerEventModel.find({
        status: ResendEmailProviderEventStatus.PENDING,
        providerMessageId: { $type: 'string', $ne: '' },
      }).sort({ occurredAt: 1 }).limit(25).exec();
      batchSize = events.length;
      for (const event of events) {
        try {
          await this.applyProviderEvent(event);
        } catch (error) {
          this.logger.warn(`Resend webhook reconciliation failed for ${event.eventId}: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      this.logger.error(`Resend webhook reconciliation worker failed: ${errorMessage(error)}`);
    } finally {
      this.reconciling = false;
      this.scheduleReconciliation(batchSize >= 25 ? 500 : 60_000);
    }
  }

  async getQueueHealth() {
    const [pending, processed, ignored, oldestPending] = await Promise.all([
      this.providerEventModel.countDocuments({ status: ResendEmailProviderEventStatus.PENDING }).exec(),
      this.providerEventModel.countDocuments({ status: ResendEmailProviderEventStatus.PROCESSED }).exec(),
      this.providerEventModel.countDocuments({ status: ResendEmailProviderEventStatus.IGNORED }).exec(),
      this.providerEventModel.findOne({ status: ResendEmailProviderEventStatus.PENDING }).sort({ occurredAt: 1 }).select({ occurredAt: 1, eventType: 1 }).lean().exec(),
    ]);
    return { pendingUnmatched: pending, processed, ignored, oldestUnmatchedAt: oldestPending?.occurredAt ?? null, checkedAt: new Date().toISOString() };
  }

  private verifySignature(rawBody: Buffer, id: string, timestamp: string, signatureHeader: string): void {
    if (!id || !timestamp || !signatureHeader) throw new BadRequestException('Missing Resend webhook signature headers.');
    const timestampSeconds = Number(timestamp);
    if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > SIGNATURE_TOLERANCE_SECONDS) {
      throw new BadRequestException('Resend webhook timestamp is outside the accepted replay window.');
    }
    const encodedSecret = this.secret.startsWith('whsec_') ? this.secret.slice(6) : this.secret;
    const key = Buffer.from(encodedSecret, 'base64');
    if (!key.length) throw new ServiceUnavailableException('Resend webhook signing secret is invalid.');
    const signedContent = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), rawBody]);
    const expected = createHmac('sha256', key).update(signedContent).digest();
    const signatures = signatureHeader.split(/\s+/).flatMap((part) => {
      const match = /^v1,([A-Za-z0-9+/_=-]+)$/.exec(part.trim());
      return match ? [match[1]] : [];
    });
    const valid = signatures.some((candidate) => {
      try { const supplied = Buffer.from(candidate, 'base64'); return supplied.length === expected.length && timingSafeEqual(supplied, expected); }
      catch { return false; }
    });
    if (!valid) throw new BadRequestException('Invalid Resend webhook signature.');
  }

  private async applyProviderEvent(event: ResendEmailProviderEventDocument): Promise<boolean> {
    const messageId = String(event.providerMessageId ?? '').trim();
    const nextStatus = mapEventStatus(event.eventType);
    if (!messageId || !nextStatus) {
      event.status = ResendEmailProviderEventStatus.IGNORED; event.processedAt = new Date(); await event.save(); return true;
    }
    const delivery = await this.deliveryModel.findOne({ providerMessageId: messageId }).exec();
    if (!delivery) {
      event.lastError = 'Waiting for the matching email delivery record to persist its Resend message ID.';
      await event.save(); return false;
    }
    await this.deliveryModel.updateOne({
      _id: delivery._id,
      $or: [{ providerEventAt: null }, { providerEventAt: { $exists: false } }, { providerEventAt: { $lte: event.occurredAt } }],
    }, { $set: { status: nextStatus, providerEventAt: event.occurredAt, lastError: providerEventMessage(event.eventType) } }).exec();
    event.status = ResendEmailProviderEventStatus.PROCESSED;
    event.processedAt = new Date();
    event.lastError = null;
    await event.save();
    return true;
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function mapEventStatus(eventType: string): EmailDeliveryStatus | null {
  switch (eventType) {
    case 'email.sent': return EmailDeliveryStatus.SENT;
    case 'email.delivery_delayed': return EmailDeliveryStatus.DELAYED;
    case 'email.delivered': return EmailDeliveryStatus.DELIVERED;
    case 'email.bounced': return EmailDeliveryStatus.BOUNCED;
    case 'email.complained': return EmailDeliveryStatus.COMPLAINED;
    case 'email.failed': return EmailDeliveryStatus.FAILED;
    case 'email.suppressed': return EmailDeliveryStatus.SUPPRESSED;
    default: return null;
  }
}
function providerEventMessage(eventType: string): string | null { return eventType === 'email.delivered' ? null : `Resend reported ${eventType}.`; }
function parseDate(value?: string): Date | null { if (!value) return null; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed : null; }
function addCalendarMonths(date: Date, months: number): Date { const result = new Date(date); const day = result.getDate(); result.setDate(1); result.setMonth(result.getMonth() + months); const last = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate(); result.setDate(Math.min(day, last)); return result; }
function isDuplicateKeyError(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 11000); }
