import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SystemMonitorService } from '../../system-monitor/system-monitor.service';
import { SupportIncident } from '../schemas/support-incident.schema';
import { SupportActionAudit } from '../schemas/support-action-audit.schema';

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
  constructor(
    @InjectModel(SupportIncident.name)
    private readonly incidentModel: Model<SupportIncident>,
    @InjectModel(SupportActionAudit.name)
    private readonly auditModel: Model<SupportActionAudit>,
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
      const severityIncreased = severityRank(severity) > severityRank(existing.severity);
      existing.occurrenceCount = Math.min(
        1000000,
        Number(existing.occurrenceCount || 1) + 1,
      );
      existing.lastSeenAt = new Date();
      if (severityIncreased) existing.severity = severity;
      // Technical incidents remain visible in the Customer Care admin workspace.
      // Telegram is intentionally reserved for AI-generated public broadcasts.
      existing.telegramNotificationStatus = 'NOT_REQUIRED';
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
      telegramNotificationStatus: 'NOT_REQUIRED',
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
      telegramNotificationStatus: 'NOT_REQUIRED',
    };
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
