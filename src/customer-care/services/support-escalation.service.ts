import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TelegramService } from '../../telegram/telegram.service';
import { SystemMonitorService } from '../../system-monitor/system-monitor.service';
import {
  SupportIncident,
  SupportIncidentDocument,
} from '../schemas/support-incident.schema';
import { SupportActionAudit } from '../schemas/support-action-audit.schema';
import { CustomerCareJob } from '../schemas/customer-care-job.schema';

export interface CreateSupportIncidentInput {
  userId?: string;
  conversationId?: string;
  category: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  summary: string;
  evidence?: string[];
  attemptedActions?: string[];
  fingerprint?: string;
}

@Injectable()
export class SupportEscalationService {
  private readonly logger = new Logger(SupportEscalationService.name);

  constructor(
    @InjectModel(SupportIncident.name)
    private readonly incidentModel: Model<SupportIncident>,
    @InjectModel(SupportActionAudit.name)
    private readonly auditModel: Model<SupportActionAudit>,
    @InjectModel(CustomerCareJob.name)
    private readonly jobs: Model<CustomerCareJob>,
    private readonly telegram: TelegramService,
    private readonly systemMonitor: SystemMonitorService,
  ) {}

  async createIncident(
    input: CreateSupportIncidentInput,
  ): Promise<Record<string, unknown>> {
    const category = cleanText(input.category, 100) || 'TECHNICAL';
    const summary =
      cleanText(input.summary, 3000) ||
      'Customer Care requested technical investigation.';
    const severity = input.severity;
    const fingerprintSource = redactSensitiveText(summary)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .slice(0, 110);
    const fingerprint = cleanText(
      input.fingerprint || `${category}:${fingerprintSource}`,
      160,
    );
    const userId =
      input.userId && Types.ObjectId.isValid(input.userId)
        ? new Types.ObjectId(input.userId)
        : undefined;
    const conversationId =
      input.conversationId && Types.ObjectId.isValid(input.conversationId)
        ? new Types.ObjectId(input.conversationId)
        : undefined;

    const existing = await this.incidentModel
      .findOne({ fingerprint, status: { $in: ['OPEN', 'IN_PROGRESS'] } })
      .exec();
    if (existing) {
      const severityIncreased =
        severityRank(severity) > severityRank(existing.severity);
      const shouldNotify = isAdminTelegramSeverity(
        severityIncreased ? severity : existing.severity,
      );
      existing.occurrenceCount = Math.min(
        1000000,
        Number(existing.occurrenceCount || 1) + 1,
      );
      existing.lastSeenAt = new Date();
      if (severityIncreased) {
        existing.severity = severity;
        existing.telegramNotificationStatus = shouldNotify
          ? 'PENDING'
          : 'NOT_REQUIRED';
      }
      existing.evidence = uniqueBounded(
        [
          ...existing.evidence,
          ...(input.evidence ?? []).map((item) =>
            redactSensitiveText(cleanText(item, 500)),
          ),
        ],
        20,
      );
      existing.attemptedActions = uniqueBounded(
        [
          ...existing.attemptedActions,
          ...(input.attemptedActions ?? []).map((item) =>
            redactSensitiveText(cleanText(item, 200)),
          ),
        ],
        20,
      );
      await existing.save();
      if (
        shouldNotify &&
        (severityIncreased ||
          existing.telegramNotificationStatus === 'FAILED' ||
          existing.telegramNotificationStatus === 'PENDING')
      ) {
        // Key the alert to the current severity. Severity escalation creates a
        // distinct notification, while failed notifications can be retried using
        // the same key without duplicating an already-delivered alert.
        await this.enqueueTelegramNotification(existing, existing.severity);
      }
      await this.auditModel.create({
        ...(conversationId ? { conversationId } : {}),
        ...(userId ? { userId } : {}),
        actorRole: 'AI',
        actionName: 'incident_deduplicated',
        actionType: 'ESCALATION',
        outcome: 'SUCCEEDED',
        summary: `Repeated incident grouped with ${String(existing._id)}.`,
        details: {
          incidentId: String(existing._id),
          fingerprint,
          severityIncreased,
        },
        durationMs: 0,
      });
      return {
        created: false,
        incidentId: String(existing._id),
        status: existing.status,
        occurrenceCount: existing.occurrenceCount,
        severityIncreased,
      };
    }

    const incident = await this.incidentModel.create({
      ...(userId ? { userId } : {}),
      ...(conversationId ? { conversationId } : {}),
      fingerprint,
      category,
      severity,
      status: 'OPEN',
      summary: redactSensitiveText(summary),
      evidence: uniqueBounded(
        (input.evidence ?? []).map((item) =>
          redactSensitiveText(cleanText(item, 500)),
        ),
        20,
      ),
      attemptedActions: uniqueBounded(
        (input.attemptedActions ?? []).map((item) =>
          redactSensitiveText(cleanText(item, 200)),
        ),
        20,
      ),
      occurrenceCount: 1,
      lastSeenAt: new Date(),
      telegramNotificationStatus: isAdminTelegramSeverity(severity)
        ? 'PENDING'
        : 'NOT_REQUIRED',
    });

    this.systemMonitor.reportActivity({
      module: 'customer-care',
      source: 'support-escalation',
      operation: 'incident-created',
      status: 'SUCCESS',
      message: `Customer Care incident ${String(incident._id)} opened (${severity}/${category}).`,
      occurredAt: new Date(),
      referenceKey: String(incident._id),
    });

    // All incidents appear in the admin dashboard. Send interruptive Telegram
    // alerts only for confirmed HIGH/CRITICAL technical cases; ordinary or uncertain
    // cases remain visible in the dashboard without flooding the admin channel.
    if (isAdminTelegramSeverity(severity)) {
      // Queue the admin Telegram alert durably before attempting network delivery.
      // The worker handles retries, so a process restart cannot lose the alert.
      incident.telegramNotificationStatus = 'PENDING';
      await incident.save();
      await this.enqueueTelegramNotification(incident, incident.severity);
    } else {
      incident.telegramNotificationStatus = 'NOT_REQUIRED';
      await incident.save();
    }

    await this.auditModel.create({
      ...(conversationId ? { conversationId } : {}),
      ...(userId ? { userId } : {}),
      actorRole: 'AI',
      actionName: 'incident_created',
      actionType: 'ESCALATION',
      outcome: 'SUCCEEDED',
      summary: `Created ${severity} support incident.`,
      details: { incidentId: String(incident._id), category, fingerprint },
      durationMs: 0,
    });

    return {
      created: true,
      incidentId: String(incident._id),
      severity,
      status: incident.status,
      telegramNotificationStatus: incident.telegramNotificationStatus,
    };
  }

  /**
   * Persist an idempotent Telegram notification for a human-support event.
   * It uses the existing Customer Care worker and Telegram destination so a
   * transient Telegram outage does not lose a handoff notification.
   */
  async enqueueSupportNotification(input: {
    kind: 'HANDOFF_REQUESTED' | 'CUSTOMER_MESSAGE';
    conversationId: string;
    eventKey: string;
    category?: string;
    summary?: string;
    assignedAdminId?: string;
  }): Promise<void> {
    if (!Types.ObjectId.isValid(input.conversationId))
      throw new Error('Invalid conversation ID for support notification.');
    const eventKey = cleanText(input.eventKey, 128);
    if (!eventKey) throw new Error('Support notification event key is required.');

    const now = new Date();
    const jobKey = `SUPPORT_NOTIFICATION:${input.kind}:${input.conversationId}:${eventKey}`;
    await this.jobs.updateOne(
      { jobKey },
      {
        $setOnInsert: {
          jobKey,
          type: 'SUPPORT_NOTIFICATION',
          dateKey: now.toISOString().slice(0, 10),
          sourceId: input.conversationId,
          payload: {
            kind: input.kind,
            category: redactSensitiveText(cleanText(input.category, 100) || 'GENERAL'),
            summary: redactSensitiveText(cleanText(input.summary, 600)),
            assignedAdminId: Types.ObjectId.isValid(String(input.assignedAdminId ?? ''))
              ? String(input.assignedAdminId)
              : '',
            eventKey,
          },
          status: 'PENDING',
          scheduledAt: now,
          attempts: 0,
          lastError: '',
        },
      },
      { upsert: true },
    ).exec();
  }

  /** Called by the durable worker; failed sends throw so normal retries apply. */
  async deliverSupportNotification(
    conversationId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const kind = String(payload.kind ?? 'HANDOFF_REQUESTED');
    const isCustomerMessage = kind === 'CUSTOMER_MESSAGE';
    const summary = redactSensitiveText(cleanText(payload.summary, 600));
    const assignedAdminId = cleanText(payload.assignedAdminId, 80);
    const message = [
      isCustomerMessage
        ? '2XPREDICT — NEW CUSTOMER SUPPORT MESSAGE'
        : '2XPREDICT — NEW HUMAN SUPPORT REQUEST',
      '',
      `Conversation: ${cleanText(conversationId, 80)}`,
      `Category: ${redactSensitiveText(cleanText(payload.category, 100) || 'GENERAL')}`,
      ...(assignedAdminId ? [`Assigned administrator ID: ${assignedAdminId}`] : []),
      ...(summary ? ['', `Summary: ${summary}`] : []),
      '',
      `Open Customer Care: ${(process.env.FRONTEND_URL || 'https://www.2xpredict.com').replace(/\/$/, '')}/admin/customer-care`,
    ].join('\n');

    const sent = await this.telegram.sendMessage(message);
    if (!sent) throw new Error('Telegram could not deliver the support notification.');
    return { sent: true, conversationId, kind };
  }

  async retryTelegramAlert(
    incidentId: string,
  ): Promise<Record<string, unknown>> {
    if (!Types.ObjectId.isValid(incidentId))
      throw new Error('Invalid incident ID for Telegram retry.');
    const incident = await this.incidentModel.findById(incidentId).exec();
    if (!incident)
      throw new Error('Support incident was not found for Telegram retry.');
    if (incident.status === 'RESOLVED' || incident.status === 'CLOSED')
      return { skipped: true, reason: 'INCIDENT_ALREADY_CLOSED' };
    if (!isAdminTelegramSeverity(incident.severity)) {
      incident.telegramNotificationStatus = 'NOT_REQUIRED';
      await incident.save();
      return {
        skipped: true,
        reason: 'SEVERITY_DOES_NOT_REQUIRE_TELEGRAM_ALERT',
      };
    }
    const sent = await this.sendIncidentNotification(incident);
    incident.telegramNotificationStatus = sent ? 'SENT' : 'FAILED';
    await incident.save();
    if (!sent)
      throw new Error('Telegram notification delivery is still failing.');
    return { sent: true, incidentId: String(incident._id) };
  }

  private async sendIncidentNotification(
    incident: SupportIncidentDocument,
  ): Promise<boolean> {
    const telegramMessage = [
      '2XPREDICT — CUSTOMER CARE INCIDENT',
      '',
      `Incident: ${String(incident._id)}`,
      `Severity: ${incident.severity}`,
      `Category: ${incident.category}`,
      `Status: ${incident.status}`,
      `Occurrences: ${incident.occurrenceCount}`,
      '',
      redactSensitiveText(String(incident.summary ?? '')).slice(0, 900),
      '',
      `Dashboard: ${process.env.FRONTEND_URL || 'https://www.2xpredict.com'}`,
    ].join('\n');
    try {
      return await this.telegram.sendMessage(telegramMessage);
    } catch (error) {
      this.logger.error(
        `Telegram notification failed for support incident ${String(incident._id)}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private async enqueueTelegramNotification(
    incident: SupportIncidentDocument,
    severity: string,
  ): Promise<void> {
    const jobKey = `INCIDENT_ALERT:${String(incident._id)}:${severity}`;
    const now = new Date();
    const dateParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Lagos',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const get = (key: string) =>
      dateParts.find((part) => part.type === key)?.value ?? '';
    const dateKey = `${get('year')}-${get('month')}-${get('day')}`;
    await this.jobs
      .updateOne(
        { jobKey },
        {
          $setOnInsert: {
            jobKey,
            type: 'INCIDENT_ALERT',
            dateKey,
            sourceId: String(incident._id),
            payload: { severity },
            status: 'PENDING',
            scheduledAt: now,
            attempts: 0,
            lastError: '',
          },
        },
        { upsert: true },
      )
      .exec();

    // Recover a terminally failed notification with the same severity key. A
    // completed job is left untouched so repeated reports cannot duplicate alerts.
    await this.jobs
      .updateOne(
        { jobKey, status: 'FAILED' },
        {
          $set: {
            status: 'PENDING',
            scheduledAt: now,
            attempts: 0,
            lastError: '',
          },
          $unset: { leaseExpiresAt: 1, completedAt: 1 },
        },
      )
      .exec();
  }
}

function cleanText(value: unknown, max: number): string {
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' ||
          typeof value === 'boolean' ||
          typeof value === 'bigint'
        ? String(value)
        : '';
  return [...text]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function redactSensitiveText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]')
    .replace(/\b(bearer\s+)\S+/gi, '$1[redacted]')
    .replace(
      /\b(otp|verification code|one-time code)\s*[:=]?\s*\d{4,8}\b/gi,
      '$1 [redacted]',
    )
    .replace(/\b\d{6}\b/g, '[code redacted]')
    .replace(/\b\d{7,}\b/g, '[number redacted]');
}
function uniqueBounded(values: string[], max: number): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, max);
}
function severityRank(value: unknown): number {
  return (
    ({ LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 } as Record<string, number>)[
      String(value)
    ] ?? 0
  );
}
function isAdminTelegramSeverity(value: unknown): boolean {
  return value === 'HIGH' || value === 'CRITICAL';
}
