import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash } from 'node:crypto';
import { AnalyticsVisitor, AnalyticsVisitorDocument, AnalyticsRecentSession } from './schemas/analytics-visitor.schema';
import { AnalyticsDailyAggregate, AnalyticsDailyDocument } from './schemas/analytics-daily.schema';
import { AnalyticsVisitorType } from './enums/analytics-visitor-type.enum';
import { TrackSessionDto } from './dto/track-session.dto';

const MAX_REMEMBERED_SESSIONS = 60;
const MAX_RECENT_SESSIONS = 20;
const MAX_ENDED_SESSIONS = 100;

@Injectable()
export class WebsiteAnalyticsSessionService {
  private readonly logger = new Logger(WebsiteAnalyticsSessionService.name);

  constructor(
    @InjectModel(AnalyticsVisitor.name)
    private readonly visitorModel: Model<AnalyticsVisitorDocument>,
    @InjectModel(AnalyticsDailyAggregate.name)
    private readonly dailyModel: Model<AnalyticsDailyDocument>,
  ) {}

  async trackSession(payload: TrackSessionDto, userId?: string) {
    const now = this.parseDate(payload.timestamp);
    const identity = this.identity(payload.visitorId, userId);
    const path = this.safePath(payload.path || payload.landingPage || payload.exitPage || '/');
    const sessionId = String(payload.sessionId).slice(0, 120);
    await this.ensureIdentity(identity.visitorId, identity.userId, identity.visitorType, payload, now);
    await this.markUniqueVisitorForDay(identity.visitorId, identity.visitorType, now);

    const initialSession: AnalyticsRecentSession = {
      sessionId,
      startedAt: now,
      lastActiveAt: now,
      endedAt: null,
      durationMs: this.nonNegative(payload.durationMs),
      activeTimeMs: this.nonNegative(payload.activeTimeMs),
      pageViews: this.nonNegative(payload.pageViews),
      eventCount: this.nonNegative(payload.eventCount),
      landingPage: this.safePath(payload.landingPage || path),
      exitPage: path,
      bounced: payload.bounced ?? this.nonNegative(payload.pageViews) <= 1,
      isActive: payload.isActive ?? true,
    };

    // A session id is counted once while it remains in the bounded idempotency window.
    const newSession = await this.visitorModel.updateOne(
      { visitorId: identity.visitorId, recentSessionIds: { $ne: sessionId } },
      {
        $inc: { totalSessions: 1 },
        $push: {
          recentSessionIds: { $each: [sessionId], $slice: -MAX_REMEMBERED_SESSIONS },
          recentSessions: { $each: [initialSession], $slice: -MAX_RECENT_SESSIONS },
        },
        $set: {
          userId: identity.userId,
          visitorType: identity.visitorType,
          lastSeenAt: now,
          lastPath: path,
          deviceType: payload.deviceType ?? '',
          browser: payload.browser ?? '',
          operatingSystem: payload.operatingSystem ?? '',
          screenWidth: this.nonNegative(payload.screenWidth),
          screenHeight: this.nonNegative(payload.screenHeight),
          country: payload.country ?? '',
          countryCode: payload.countryCode ?? '',
          region: payload.region ?? '',
          city: payload.city ?? '',
          lastReferrer: this.safeReferrer(payload.referrer),
          lastUtmSource: payload.utmSource ?? '',
          lastUtmMedium: payload.utmMedium ?? '',
          lastUtmCampaign: payload.utmCampaign ?? '',
        },
      },
    ).exec();

    if (newSession.matchedCount > 0) {
      await this.bumpDaily(now, { sessions: 1, entryPage: initialSession.landingPage });
    } else {
      // Existing session heartbeat/update; do not create another session record.
      const update = await this.visitorModel.updateOne(
        { visitorId: identity.visitorId, 'recentSessions.sessionId': sessionId },
        {
          $max: {
            'recentSessions.$.durationMs': this.nonNegative(payload.durationMs),
            'recentSessions.$.activeTimeMs': this.nonNegative(payload.activeTimeMs),
            'recentSessions.$.pageViews': this.nonNegative(payload.pageViews),
            'recentSessions.$.eventCount': this.nonNegative(payload.eventCount),
            lastSeenAt: now,
          },
          $set: {
            'recentSessions.$.lastActiveAt': now,
            'recentSessions.$.exitPage': path,
            'recentSessions.$.isActive': payload.isActive ?? true,
            'recentSessions.$.bounced': payload.bounced ?? this.nonNegative(payload.pageViews) <= 1,
            lastPath: path,
          },
        },
      ).exec();

      if (update.matchedCount === 0) {
        // Session detail may have rotated out of the bounded 20-session list.
        // Re-add its current summary without incrementing lifetime session count.
        await this.visitorModel.updateOne(
          { visitorId: identity.visitorId },
          { $push: { recentSessions: { $each: [initialSession], $slice: -MAX_RECENT_SESSIONS } } },
        ).exec();
      }
    }

    return {
      sessionId,
      created: newSession.matchedCount > 0,
      durationMs: initialSession.durationMs,
      activeTimeMs: initialSession.activeTimeMs,
    };
  }

  async endSession(
    sessionId: string,
    payload?: {
      timestamp?: string;
      path?: string;
      durationMs?: number;
      activeTimeMs?: number;
      pageViews?: number;
      eventCount?: number;
      bounced?: boolean;
      visitorId?: string;
    },
    userId?: string,
    visitorId?: string,
  ) {
    const identity = this.identity(visitorId || payload?.visitorId || `session:${sessionId}`, userId);
    const endedAt = this.parseDate(payload?.timestamp);
    const durationMs = this.nonNegative(payload?.durationMs);
    const activeTimeMs = this.nonNegative(payload?.activeTimeMs);
    const path = payload?.path ? this.safePath(payload.path) : undefined;
    const priorVisitor = await this.visitorModel.findOne({ visitorId: identity.visitorId, 'recentSessions.sessionId': sessionId }, { 'recentSessions.$': 1 }).lean().exec() as any;
    const priorSession = priorVisitor?.recentSessions?.[0];
    const bounced = typeof payload?.bounced === 'boolean' ? payload.bounced : typeof payload?.pageViews === 'number' ? payload.pageViews <= 1 : Boolean(priorSession?.bounced);

    // The filter makes duplicate end-session calls idempotent within the retained window.
    const ended = await this.visitorModel.updateOne(
      { visitorId: identity.visitorId, endedSessionIds: { $ne: sessionId } },
      {
        $push: { endedSessionIds: { $each: [sessionId], $slice: -MAX_ENDED_SESSIONS } },
        $inc: { totalActiveTimeMs: activeTimeMs },
        $max: { lastSeenAt: endedAt },
        $set: {
          ...(path ? { lastPath: path } : {}),
          'recentSessions.$[session].endedAt': endedAt,
          'recentSessions.$[session].lastActiveAt': endedAt,
          'recentSessions.$[session].isActive': false,
          'recentSessions.$[session].bounced': bounced,
          'recentSessions.$[session].durationMs': durationMs,
          'recentSessions.$[session].activeTimeMs': activeTimeMs,
          ...(path ? { 'recentSessions.$[session].exitPage': path } : {}),
          ...(typeof payload?.pageViews === 'number' ? { 'recentSessions.$[session].pageViews': payload.pageViews } : {}),
          ...(typeof payload?.eventCount === 'number' ? { 'recentSessions.$[session].eventCount': payload.eventCount } : {}),
        },
      },
      { arrayFilters: [{ 'session.sessionId': sessionId }] },
    ).exec();

    if (ended.matchedCount > 0) {
      await this.bumpDaily(endedAt, { endedSessions: 1, totalActiveTimeMs: activeTimeMs, exitPage: path ?? priorSession?.exitPage, bouncedSessions: bounced ? 1 : 0 });
      await this.markUniqueVisitorForDay(identity.visitorId, identity.visitorType, endedAt);
    }

    const visitor = await this.visitorModel.findOne({ visitorId: identity.visitorId }).lean().exec();
    const session = visitor?.recentSessions?.find((item: any) => item.sessionId === sessionId);
    return session ? {
      sessionId,
      durationMs: session.durationMs,
      activeTimeMs: session.activeTimeMs,
      pageViews: session.pageViews,
      bounced: session.bounced,
    } : null;
  }

  private identity(visitorId: string, userId?: string) {
    const validUserId = userId && Types.ObjectId.isValid(userId) ? new Types.ObjectId(userId) : null;
    const safeVisitor = String(visitorId || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 150).replace(/^anon:/i, '') || 'invalid';
    return {
      visitorId: validUserId ? `user:${validUserId.toHexString()}` : `anon:${safeVisitor}`, 
      userId: validUserId,
      visitorType: validUserId ? AnalyticsVisitorType.REGISTERED : AnalyticsVisitorType.ANONYMOUS,
    };
  }

  private async ensureIdentity(visitorId: string, userId: Types.ObjectId | null, visitorType: AnalyticsVisitorType, payload: TrackSessionDto, now: Date) {
    await this.visitorModel.updateOne(
      { visitorId },
      { $setOnInsert: {
        visitorId, userId, visitorType, firstSeenAt: now, lastSeenAt: now,
        totalSessions: 0, totalPageViews: 0, totalEvents: 0, totalActiveTimeMs: 0,
        deviceType: payload.deviceType ?? '', browser: payload.browser ?? '', operatingSystem: payload.operatingSystem ?? '',
        country: payload.country ?? '', countryCode: payload.countryCode ?? '', region: payload.region ?? '', city: payload.city ?? '',
        firstReferrer: this.safeReferrer(payload.referrer), firstUtmSource: payload.utmSource ?? '',
        firstUtmMedium: payload.utmMedium ?? '', firstUtmCampaign: payload.utmCampaign ?? '',
        recentEventIds: [], recentSessionIds: [], endedSessionIds: [], recentActiveDayKeys: [], recentActivity: [], recentSessions: [],
      } },
      { upsert: true },
    ).exec();
  }

  private async markUniqueVisitorForDay(visitorId: string, visitorType: AnalyticsVisitorType, date: Date): Promise<void> {
    const dayKey = date.toISOString().slice(0, 10);
    const visitor = await this.visitorModel.findOne({ visitorId }, { recentActiveDayKeys: 1 }).lean().exec() as any;
    const alreadySeen = Array.isArray(visitor?.recentActiveDayKeys) && visitor.recentActiveDayKeys.includes(dayKey);
    await this.dailyModel.updateOne(
      { dayKey },
      { $setOnInsert: { dayKey, date: new Date(`${dayKey}T00:00:00.000Z`) } },
      { upsert: true, timestamps: false },
    ).exec();
    if (!alreadySeen) {
      const visitorHash = createHash('sha1').update(visitorId).digest('hex').slice(0, 16);
      await this.dailyModel.updateOne(
        { dayKey, recentUniqueVisitorIds: { $ne: `v_${visitorHash}` } },
        { $inc: { uniqueVisitors: 1, [visitorType === AnalyticsVisitorType.REGISTERED ? 'registeredUniqueVisitors' : 'anonymousUniqueVisitors']: 1 },
          $push: { recentUniqueVisitorIds: { $each: [`v_${visitorHash}`], $slice: -5_000 } } },
        { timestamps: false },
      ).exec();
    }
    await this.visitorModel.updateOne(
      { visitorId, recentActiveDayKeys: { $ne: dayKey } },
      { $push: { recentActiveDayKeys: { $each: [dayKey], $slice: -400 } } },
      { timestamps: false },
    ).exec();
  }

  private async bumpDaily(date: Date, amounts: { sessions?: number; endedSessions?: number; totalActiveTimeMs?: number; entryPage?: string; exitPage?: string; bouncedSessions?: number }) {
    const dayKey = date.toISOString().slice(0, 10);
    const inc: Record<string, number> = {};
    if (amounts.sessions) inc.sessions = amounts.sessions;
    if (amounts.endedSessions) inc.endedSessions = amounts.endedSessions;
    if (amounts.totalActiveTimeMs) inc.totalActiveTimeMs = amounts.totalActiveTimeMs;
    if (amounts.bouncedSessions) inc.bouncedSessions = amounts.bouncedSessions;
    const set: Record<string, string> = {};
    if (amounts.entryPage) { const k = this.dailyKey('p', amounts.entryPage); inc[`entryPageCounts.${k}`] = (inc[`entryPageCounts.${k}`] ?? 0) + 1; set[`entryPageLabels.${k}`] = amounts.entryPage; }
    if (amounts.exitPage) { const k = this.dailyKey('p', amounts.exitPage); inc[`exitPageCounts.${k}`] = (inc[`exitPageCounts.${k}`] ?? 0) + 1; set[`exitPageLabels.${k}`] = amounts.exitPage; }
    if (!Object.keys(inc).length && !Object.keys(set).length) return;
    try {
      await this.dailyModel.updateOne(
        { dayKey },
        { $setOnInsert: { dayKey, date: new Date(`${dayKey}T00:00:00.000Z`) }, $inc: inc, ...(Object.keys(set).length ? { $set: set } : {}) },
        { upsert: true },
      ).exec();
    } catch (error) {
      this.logger.error('Daily session aggregate update failed', error instanceof Error ? error.stack : undefined);
      throw error;
    }
  }

  private dailyKey(prefix: string, label: string): string {
    return `${prefix}_${createHash('sha1').update(label || '').digest('hex').slice(0, 16)}`;
  }

  private parseDate(value?: string): Date {
    const date = value ? new Date(value) : new Date();
    return Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 5 * 60_000 ? new Date() : date;
  }
  private nonNegative(value?: number): number {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? Math.min(86_400_000, Math.max(0, Math.floor(number))) : 0;
  }
  private safePath(value: string): string {
    try { return new URL(String(value).slice(0, 500), 'https://analytics.local').pathname.slice(0, 300) || '/'; }
    catch { return '/'; }
  }
  private safeReferrer(value?: string): string {
    if (!value) return '';
    try { const url = new URL(value.slice(0, 1000)); return `${url.origin}${url.pathname}`.slice(0, 300); }
    catch { return ''; }
  }
}
