import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AdminGateway } from '../realtime/admin.gateway';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model, Types } from 'mongoose';
import {
  AnalyticsVisitor,
  AnalyticsVisitorDocument,
} from './schemas/analytics-visitor.schema';
import {
  AnalyticsDailyAggregate,
  AnalyticsDailyDocument,
} from './schemas/analytics-daily.schema';
import { TrackEventDto, TrackEventsDto } from './dto/track-events.dto';
import { AnalyticsVisitorType } from './enums/analytics-visitor-type.enum';

const MAX_RECENT_EVENTS = 20;
const MAX_REMEMBERED_EVENT_IDS = 200;
const MAX_TEXT = 160;
const MAX_VISITOR_PATH_KEYS = 100;
const MAX_VISITOR_EVENT_NAME_KEYS = 50;
const MAX_DAILY_EVENT_IDS = 200;
const CONVERSION_EVENT_TYPES = new Set([
  'registration',
  'subscription_purchase',
  'promo_claim',
  'community_post_create',
  'community_reply_create',
]);

interface NormalizedEvent {
  eventId: string;
  visitorId: string;
  sessionId: string;
  userId: Types.ObjectId | null;
  visitorType: AnalyticsVisitorType;
  eventType: string;
  eventName: string;
  path: string;
  occurredAt: Date;
  durationMs: number;
  properties: Record<string, unknown>;
  pageTitle: string;
  referrer: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  country: string;
  countryCode: string;
  region: string;
  city: string;
  deviceType: string;
  browser: string;
  operatingSystem: string;
  screenWidth: number;
  screenHeight: number;
}

interface AnalyticsAdminGateway {
  registerModule(
    name: string,
    details: { message: string; operationalStatus: string },
  ): void;
  publishModuleEvent(
    moduleName: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): void;
  emitAnalyticsUpdate(result: { accepted: number; duplicate: number }): void;
}

interface DailyAggregateSnapshot {
  dayKey: string;
  pageViewCounts?: unknown;
  eventTypeCounts?: unknown;
  eventNameCounts?: unknown;
  sourceCounts?: unknown;
  countryCounts?: unknown;
  cityCounts?: unknown;
  deviceCounts?: unknown;
  browserCounts?: unknown;
  operatingSystemCounts?: unknown;
}

@Injectable()
export class WebsiteAnalyticsService implements OnModuleInit {
  private readonly logger = new Logger(WebsiteAnalyticsService.name);

  private get analyticsGateway(): AnalyticsAdminGateway {
    return this.adminGateway as unknown as AnalyticsAdminGateway;
  }

  constructor(
    @InjectModel(AnalyticsVisitor.name)
    private readonly visitorModel: Model<AnalyticsVisitorDocument>,
    @InjectModel(AnalyticsDailyAggregate.name)
    private readonly dailyModel: Model<AnalyticsDailyDocument>,
    private readonly adminGateway: AdminGateway,
  ) {}

  onModuleInit(): void {
    this.analyticsGateway.registerModule('website-analytics', {
      message:
        'Website analytics ingestion and aggregation service initialized.',
      operationalStatus: 'READY',
    });
  }

  /**
   * Ingest a batch into one identity summary and one daily aggregate. This
   * intentionally does not write documents to analytics_events.
   */
  async trackEvents(payload: TrackEventsDto, userId?: string) {
    const rawEvents: unknown = payload.events;
    const payloadEvents = Array.isArray(rawEvents)
      ? (rawEvents as TrackEventDto[]).slice(0, 50)
      : [];
    if (!payloadEvents.length) return { accepted: 0, duplicate: 0 };

    const normalized = payloadEvents
      .map((event) => this.normalizeEvent(event, userId))
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

    const identities = new Map<string, NormalizedEvent>();
    for (const event of normalized) {
      if (!identities.has(event.visitorId))
        identities.set(event.visitorId, event);
    }
    await Promise.all(
      [...identities.values()].map((event) => this.ensureIdentity(event)),
    );
    await this.markUniqueVisitors(normalized);

    const accepted: NormalizedEvent[] = [];
    let duplicate = 0;

    for (const event of normalized) {
      try {
        const changed = await this.applyEvent(event);
        if (changed) accepted.push(event);
        else duplicate += 1;
      } catch (error) {
        this.logger.error(
          `Could not update website activity (${event.eventType})`,
          this.errorStack(error),
        );
        throw error;
      }
    }

    // Aggregate every normalized event, including visitor-level duplicates. The
    // daily document has its own bounded idempotency window, so retries can repair
    // an interrupted visitor-write/daily-write sequence without double-counting.
    await this.updateDailyAggregates(normalized);

    const result = { accepted: accepted.length, duplicate };
    this.analyticsGateway.publishModuleEvent(
      'website-analytics',
      'analytics:ingestion-update',
      {
        ...result,
        batchSize: normalized.length,
        occurredAt: new Date().toISOString(),
      },
    );
    this.analyticsGateway.emitAnalyticsUpdate(result);
    return result;
  }

  private normalizeEvent(dto: TrackEventDto, userId?: string): NormalizedEvent {
    const id =
      userId && Types.ObjectId.isValid(userId)
        ? new Types.ObjectId(userId)
        : null;
    const visitorId = id
      ? `user:${id.toHexString()}`
      : this.canonicalAnonymousId(dto.visitorId);
    let occurredAt = new Date(dto.occurredAt);
    if (
      Number.isNaN(occurredAt.getTime()) ||
      occurredAt.getTime() > Date.now() + 5 * 60_000
    )
      occurredAt = new Date();
    // Very old client timestamps are retained as supplied, but do not affect the most-recent metadata.
    const eventType = this.safeIdentifier(
      String(dto.eventType ?? 'custom'),
      60,
    );
    return {
      eventId: this.safeIdentifier(dto.eventId, 120),
      visitorId,
      sessionId: this.safeIdentifier(dto.sessionId, 120),
      userId: id,
      visitorType: id
        ? AnalyticsVisitorType.REGISTERED
        : AnalyticsVisitorType.ANONYMOUS,
      eventType,
      eventName: this.safeIdentifier(dto.eventName || eventType, 100),
      path: this.safePath(dto.path),
      occurredAt,
      durationMs: this.nonNegative(dto.durationMs, 86_400_000),
      properties: this.safeProperties(dto.properties),
      pageTitle: this.safeText(dto.pageTitle, 160),
      referrer: this.safeReferrer(dto.referrer),
      utmSource: this.safeText(dto.utmSource, 100),
      utmMedium: this.safeText(dto.utmMedium, 100),
      utmCampaign: this.safeText(dto.utmCampaign, 140),
      country: this.safeText(dto.country, 100),
      countryCode: this.safeText(dto.countryCode, 8).toUpperCase(),
      region: this.safeText(dto.region, 100),
      city: this.safeText(dto.city, 100),
      deviceType: this.safeText(dto.deviceType, 40),
      browser: this.safeText(dto.browser, 60),
      operatingSystem: this.safeText(dto.operatingSystem, 60),
      screenWidth: this.nonNegative(dto.screenWidth, 20_000),
      screenHeight: this.nonNegative(dto.screenHeight, 20_000),
    };
  }

  private async ensureIdentity(event: NormalizedEvent): Promise<void> {
    await this.visitorModel
      .updateOne(
        { visitorId: event.visitorId },
        {
          $setOnInsert: {
            visitorId: event.visitorId,
            userId: event.userId,
            visitorType: event.visitorType,
            firstSeenAt: event.occurredAt,
            lastSeenAt: event.occurredAt,
            totalSessions: 0,
            totalPageViews: 0,
            totalEvents: 0,
            totalActiveTimeMs: 0,
            deviceType: event.deviceType,
            browser: event.browser,
            operatingSystem: event.operatingSystem,
            country: event.country,
            countryCode: event.countryCode,
            region: event.region,
            city: event.city,
            firstReferrer: event.referrer,
            firstUtmSource: event.utmSource,
            firstUtmMedium: event.utmMedium,
            firstUtmCampaign: event.utmCampaign,
            recentEventIds: [],
            recentSessionIds: [],
            endedSessionIds: [],
            recentActiveDayKeys: [],
            recentActivity: [],
            recentSessions: [],
          },
        },
        { upsert: true },
      )
      .exec();
  }

  private async applyEvent(event: NormalizedEvent): Promise<boolean> {
    const pageKey = this.key('p', event.path);
    const typeKey = this.key('t', event.eventType);
    const nameKey = this.key('n', event.eventName);
    const isPageView = event.eventType === 'page_view';
    const newer = {
      $gt: [
        { $literal: event.occurredAt },
        { $ifNull: ['$lastSeenAt', { $literal: new Date(0) }] },
      ],
    };
    const eventIdHash = this.key('i', event.eventId);
    const activity = {
      eventId: eventIdHash,
      sessionId: event.sessionId,
      eventType: event.eventType,
      eventName: event.eventName,
      path: event.path,
      occurredAt: event.occurredAt,
      durationMs: event.durationMs,
      properties: event.properties,
    };

    const pageCounts = this.boundedCounterUpdate(
      '$pageViewsByPath',
      pageKey,
      MAX_VISITOR_PATH_KEYS,
    );
    const pageLabels = this.boundedLabelUpdate(
      '$pageViewsByPath',
      '$pagePathLabels',
      pageKey,
      event.path,
      MAX_VISITOR_PATH_KEYS,
    );
    const typeCounts = this.boundedCounterUpdate(
      '$eventCountsByType',
      typeKey,
      30,
    );
    const typeLabels = this.boundedLabelUpdate(
      '$eventCountsByType',
      '$eventTypeLabels',
      typeKey,
      event.eventType,
      30,
    );
    const nameCounts = this.boundedCounterUpdate(
      '$eventCountsByName',
      nameKey,
      MAX_VISITOR_EVENT_NAME_KEYS,
    );
    const nameLabels = this.boundedLabelUpdate(
      '$eventCountsByName',
      '$eventNameLabels',
      nameKey,
      event.eventName,
      MAX_VISITOR_EVENT_NAME_KEYS,
    );

    const updatePipeline: any[] = [
      {
        $set: {
          userId: { $literal: event.userId },
          visitorType: { $literal: event.visitorType },
          firstSeenAt: {
            $ifNull: ['$firstSeenAt', { $literal: event.occurredAt }],
          },
          lastSeenAt: {
            $cond: [newer, { $literal: event.occurredAt }, '$lastSeenAt'],
          },
          lastPath: { $cond: [newer, { $literal: event.path }, '$lastPath'] },
          deviceType: {
            $cond: [newer, { $literal: event.deviceType }, '$deviceType'],
          },
          browser: { $cond: [newer, { $literal: event.browser }, '$browser'] },
          operatingSystem: {
            $cond: [
              newer,
              { $literal: event.operatingSystem },
              '$operatingSystem',
            ],
          },
          screenWidth: {
            $cond: [newer, { $literal: event.screenWidth }, '$screenWidth'],
          },
          screenHeight: {
            $cond: [newer, { $literal: event.screenHeight }, '$screenHeight'],
          },
          country: { $cond: [newer, { $literal: event.country }, '$country'] },
          countryCode: {
            $cond: [newer, { $literal: event.countryCode }, '$countryCode'],
          },
          region: { $cond: [newer, { $literal: event.region }, '$region'] },
          city: { $cond: [newer, { $literal: event.city }, '$city'] },
          lastReferrer: {
            $cond: [newer, { $literal: event.referrer }, '$lastReferrer'],
          },
          lastUtmSource: {
            $cond: [newer, { $literal: event.utmSource }, '$lastUtmSource'],
          },
          lastUtmMedium: {
            $cond: [newer, { $literal: event.utmMedium }, '$lastUtmMedium'],
          },
          lastUtmCampaign: {
            $cond: [newer, { $literal: event.utmCampaign }, '$lastUtmCampaign'],
          },
          totalEvents: { $add: [{ $ifNull: ['$totalEvents', 0] }, 1] },
          totalPageViews: {
            $add: [{ $ifNull: ['$totalPageViews', 0] }, isPageView ? 1 : 0],
          },
          recentEventIds: {
            $slice: [
              {
                $concatArrays: [
                  { $ifNull: ['$recentEventIds', []] },
                  [{ $literal: eventIdHash }],
                ],
              },
              -MAX_REMEMBERED_EVENT_IDS,
            ],
          },
          recentActivity: {
            $slice: [
              {
                $concatArrays: [
                  { $ifNull: ['$recentActivity', []] },
                  [{ $literal: activity }],
                ],
              },
              -MAX_RECENT_EVENTS,
            ],
          },
          eventCountsByType: typeCounts,
          eventTypeLabels: typeLabels,
          eventCountsByName: nameCounts,
          eventNameLabels: nameLabels,
          pageViewsByPath: isPageView
            ? pageCounts
            : { $ifNull: ['$pageViewsByPath', {}] },
          pagePathLabels: isPageView
            ? pageLabels
            : { $ifNull: ['$pagePathLabels', {}] },
        },
      },
    ];

    const result = await this.visitorModel
      .updateOne(
        { visitorId: event.visitorId, recentEventIds: { $ne: eventIdHash } },
        updatePipeline,
        { updatePipeline: true, timestamps: false },
      )
      .exec();
    return result.matchedCount > 0 || result.modifiedCount > 0;
  }

  private async markUniqueVisitors(events: NormalizedEvent[]): Promise<void> {
    const unique = new Map<string, NormalizedEvent>();
    const days = new Set<string>();
    for (const event of events) {
      const dayKey = event.occurredAt.toISOString().slice(0, 10);
      days.add(dayKey);
      const composite = `${event.visitorId}:${dayKey}`;
      if (!unique.has(composite)) unique.set(composite, event);
    }
    if (!unique.size) return;
    const ensureOperations = [...days].map((dayKey) => ({
      updateOne: {
        filter: { dayKey },
        update: {
          $setOnInsert: { dayKey, date: new Date(`${dayKey}T00:00:00.000Z`) },
        },
        upsert: true,
      },
    }));
    await this.dailyModel.bulkWrite(ensureOperations, {
      ordered: false,
    });

    for (const event of unique.values()) {
      const dayKey = event.occurredAt.toISOString().slice(0, 10);
      const visitor = (await this.visitorModel
        .findOne({ visitorId: event.visitorId }, { recentActiveDayKeys: 1 })
        .lean()
        .exec()) as unknown as { recentActiveDayKeys?: string[] } | null;
      const alreadySeen =
        Array.isArray(visitor?.recentActiveDayKeys) &&
        visitor.recentActiveDayKeys.includes(dayKey);
      if (!alreadySeen) {
        const visitorKey = this.key('v', event.visitorId);
        await this.dailyModel
          .updateOne(
            { dayKey, recentUniqueVisitorIds: { $ne: visitorKey } },
            {
              $inc: {
                uniqueVisitors: 1,
                [event.visitorType === AnalyticsVisitorType.REGISTERED
                  ? 'registeredUniqueVisitors'
                  : 'anonymousUniqueVisitors']: 1,
              },
              $push: {
                recentUniqueVisitorIds: { $each: [visitorKey], $slice: -5_000 },
              },
            },
            { timestamps: false },
          )
          .exec();
      }
      await this.visitorModel
        .updateOne(
          { visitorId: event.visitorId, recentActiveDayKeys: { $ne: dayKey } },
          { $push: { recentActiveDayKeys: { $each: [dayKey], $slice: -400 } } },
          { timestamps: false },
        )
        .exec();
    }
  }

  private async updateDailyAggregates(
    events: NormalizedEvent[],
  ): Promise<void> {
    const byDay = new Map<string, NormalizedEvent[]>();
    for (const event of events) {
      const dayKey = event.occurredAt.toISOString().slice(0, 10);
      const items = byDay.get(dayKey) ?? [];
      items.push(event);
      byDay.set(dayKey, items);
    }
    if (!byDay.size) return;

    // Ensure each daily aggregate document exists, then process event counters
    // through idempotent updates in a single MongoDB bulk request. This allows
    // safe retries after a partial HTTP/database failure without raw event rows.
    const ensureOperations = [...byDay.keys()].map((dayKey) => ({
      updateOne: {
        filter: { dayKey },
        update: {
          $setOnInsert: { dayKey, date: new Date(`${dayKey}T00:00:00.000Z`) },
        },
        upsert: true,
      },
    }));
    await this.dailyModel.bulkWrite(ensureOperations, {
      ordered: false,
    });

    const existingDaily = (await this.dailyModel
      .find(
        { dayKey: { $in: [...byDay.keys()] } },
        {
          dayKey: 1,
          pageViewCounts: 1,
          eventTypeCounts: 1,
          eventNameCounts: 1,
          sourceCounts: 1,
          countryCounts: 1,
          cityCounts: 1,
          deviceCounts: 1,
          browserCounts: 1,
          operatingSystemCounts: 1,
        },
      )
      .lean()
      .exec()) as unknown as DailyAggregateSnapshot[];
    const existingByDay = new Map(
      existingDaily.map((doc) => [String(doc.dayKey), doc]),
    );
    const operations: unknown[] = [];

    for (const [dayKey, dayEvents] of byDay.entries()) {
      const existing: DailyAggregateSnapshot = existingByDay.get(dayKey) ?? {
        dayKey,
      };
      const allowed = new Map<string, Set<string>>([
        ['pages', new Set(Object.keys(this.toRecord(existing.pageViewCounts)))],
        [
          'types',
          new Set(Object.keys(this.toRecord(existing.eventTypeCounts))),
        ],
        [
          'names',
          new Set(Object.keys(this.toRecord(existing.eventNameCounts))),
        ],
        ['sources', new Set(Object.keys(this.toRecord(existing.sourceCounts)))],
        [
          'countries',
          new Set(Object.keys(this.toRecord(existing.countryCounts))),
        ],
        ['cities', new Set(Object.keys(this.toRecord(existing.cityCounts)))],
        ['devices', new Set(Object.keys(this.toRecord(existing.deviceCounts)))],
        [
          'browsers',
          new Set(Object.keys(this.toRecord(existing.browserCounts))),
        ],
        [
          'systems',
          new Set(Object.keys(this.toRecord(existing.operatingSystemCounts))),
        ],
      ]);
      const maximumByDimension: Record<string, number> = {
        pages: 500,
        types: 50,
        names: 500,
        sources: 100,
        countries: 100,
        cities: 200,
        devices: 30,
        browsers: 100,
        systems: 100,
      };
      const allow = (dimension: string, key: string) => {
        const keys = allowed.get(dimension)!;
        if (keys.has(key)) return true;
        if (keys.size >= maximumByDimension[dimension]) return false;
        keys.add(key);
        return true;
      };

      for (const event of dayEvents) {
        const inc: Record<string, number> = { events: 1 };
        const set: Record<string, string> = {};
        const bump = (field: string, amount = 1) => {
          inc[field] = (inc[field] ?? 0) + amount;
        };
        const hourKey = `h_${String(event.occurredAt.getUTCHours()).padStart(2, '0')}`;
        bump(`hourlyEventCounts.${hourKey}`);
        bump(
          event.visitorType === AnalyticsVisitorType.REGISTERED
            ? 'registeredEvents'
            : 'anonymousEvents',
        );

        const pageKey = this.key('p', event.path);
        if (event.eventType === 'page_view') {
          bump('pageViews');
          if (allow('pages', pageKey)) {
            bump(`pageViewCounts.${pageKey}`);
            set[`pageLabels.${pageKey}`] = event.path;
          }
        }
        if (
          event.eventType === 'page_exit' &&
          event.durationMs > 0 &&
          allow('pages', pageKey)
        ) {
          bump(`pageDurationMsByPath.${pageKey}`, event.durationMs);
          bump(`pageDurationCountByPath.${pageKey}`);
          set[`pageDurationLabels.${pageKey}`] = event.path;
        }
        const typeKey = this.key('t', event.eventType);
        if (allow('types', typeKey)) {
          bump(`eventTypeCounts.${typeKey}`);
          set[`eventTypeLabels.${typeKey}`] = event.eventType;
        }
        const nameKey = this.key('n', event.eventName);
        if (allow('names', nameKey)) {
          bump(`eventNameCounts.${nameKey}`);
          set[`eventNameLabels.${nameKey}`] = event.eventName;
        }
        if (CONVERSION_EVENT_TYPES.has(event.eventType)) bump('conversions');

        const source =
          event.utmSource || this.sourceFromReferrer(event.referrer);
        if (source) {
          const key = this.key('s', source);
          if (allow('sources', key)) {
            bump(`sourceCounts.${key}`);
            set[`sourceLabels.${key}`] = source;
          }
        }
        const country = event.countryCode || event.country;
        if (country) {
          const key = this.key('c', country);
          if (allow('countries', key)) {
            bump(`countryCounts.${key}`);
            set[`countryLabels.${key}`] = country;
          }
        }
        if (event.city) {
          const key = this.key('ci', event.city);
          if (allow('cities', key)) {
            bump(`cityCounts.${key}`);
            set[`cityLabels.${key}`] = event.city;
          }
        }
        if (event.deviceType) {
          const key = this.key('d', event.deviceType);
          if (allow('devices', key)) {
            bump(`deviceCounts.${key}`);
            set[`deviceLabels.${key}`] = event.deviceType;
          }
        }
        if (event.browser) {
          const key = this.key('b', event.browser);
          if (allow('browsers', key)) {
            bump(`browserCounts.${key}`);
            set[`browserLabels.${key}`] = event.browser;
          }
        }
        if (event.operatingSystem) {
          const key = this.key('os', event.operatingSystem);
          if (allow('systems', key)) {
            bump(`operatingSystemCounts.${key}`);
            set[`operatingSystemLabels.${key}`] = event.operatingSystem;
          }
        }

        operations.push({
          updateOne: {
            filter: {
              dayKey,
              recentEventIds: { $ne: this.key('i', event.eventId) },
            },
            update: {
              $inc: inc,
              ...(Object.keys(set).length ? { $set: set } : {}),
              $push: {
                recentEventIds: {
                  $each: [this.key('i', event.eventId)],
                  $slice: -MAX_DAILY_EVENT_IDS,
                },
              },
            },
            upsert: false,
          },
        });
      }
    }

    try {
      if (operations.length)
        await this.dailyModel.bulkWrite(
          operations as Parameters<typeof this.dailyModel.bulkWrite>[0],
          { ordered: false },
        );
    } catch (error) {
      this.logger.error(
        'Daily website analytics aggregation failed',
        this.errorStack(error),
      );
      throw error;
    }
  }

  private boundedCounterUpdate(
    field: string,
    key: string,
    maximum: number,
  ): Record<string, unknown> {
    const map = { $ifNull: [field, {}] };
    const existing = { $gt: [{ $ifNull: [`${field}.${key}`, 0] }, 0] };
    const hasRoom = { $lt: [{ $size: { $objectToArray: map } }, maximum] };
    return {
      $cond: [
        { $or: [existing, hasRoom] },
        {
          $mergeObjects: [
            map,
            { [key]: { $add: [{ $ifNull: [`${field}.${key}`, 0] }, 1] } },
          ],
        },
        map,
      ],
    };
  }

  private boundedLabelUpdate(
    countField: string,
    labelField: string,
    key: string,
    label: string,
    maximum: number,
  ): Record<string, unknown> {
    const counts = { $ifNull: [countField, {}] };
    const labels = { $ifNull: [labelField, {}] };
    const existing = { $gt: [{ $ifNull: [`${countField}.${key}`, 0] }, 0] };
    const hasRoom = { $lt: [{ $size: { $objectToArray: counts } }, maximum] };
    return {
      $cond: [
        { $or: [existing, hasRoom] },
        { $mergeObjects: [labels, { [key]: { $literal: label } }] },
        labels,
      ],
    };
  }

  private canonicalAnonymousId(value: unknown): string {
    let identity = this.safeIdentifier(
      typeof value === 'string' ? value : '',
      150,
    ).replace(/^anon:/i, '');
    if (!identity) identity = 'invalid';
    return `anon:${identity}`;
  }

  private toRecord(value: unknown): Record<string, unknown> {
    if (value instanceof Map) {
      const entries: [string, unknown][] = [];
      for (const [key, entry] of value as Map<unknown, unknown>) {
        if (typeof key === 'string') entries.push([key, entry]);
      }
      return Object.fromEntries(entries);
    }
    if (value && typeof value === 'object')
      return value as Record<string, unknown>;
    return {};
  }

  private safeProperties(
    properties?: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!properties || typeof properties !== 'object') return {};
    const result: Record<string, unknown> = {};
    for (const [rawKey, rawValue] of Object.entries(properties).slice(0, 10)) {
      const key = rawKey.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);
      if (
        !key ||
        /(password|token|secret|authorization|cookie|email|phone|address|fullname|username|credential)/i.test(
          key,
        )
      )
        continue;
      if (typeof rawValue === 'string') result[key] = rawValue.slice(0, 80);
      else if (typeof rawValue === 'number' && Number.isFinite(rawValue))
        result[key] = rawValue;
      else if (typeof rawValue === 'boolean') result[key] = rawValue;
    }
    return result;
  }

  private safePath(value?: string): string {
    const raw = (value ?? '/').slice(0, 500);
    try {
      return (
        new URL(raw, 'https://analytics.local').pathname.slice(0, 300) || '/'
      );
    } catch {
      return '/';
    }
  }

  private safeReferrer(value?: string): string {
    if (!value) return '';
    try {
      const parsed = new URL(value.slice(0, 1000));
      return `${parsed.origin}${parsed.pathname}`.slice(0, 300);
    } catch {
      return this.safeText(value, 200).split('?')[0].split('#')[0];
    }
  }

  private safeIdentifier(value: string, max: number): string {
    return String(value ?? '')
      .replace(/\p{Cc}/gu, '')
      .trim()
      .slice(0, max);
  }

  private safeText(value: unknown, max = MAX_TEXT): string {
    return typeof value === 'string'
      ? value
          .replace(/\p{Cc}/gu, '')
          .trim()
          .slice(0, max)
      : '';
  }

  private nonNegative(value: unknown, maximum: number): number {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.min(maximum, Math.max(0, Math.floor(number)))
      : 0;
  }

  private sourceFromReferrer(value: string): string {
    if (!value) return '';
    try {
      return new URL(value).hostname.replace(/^www\./, '').slice(0, 100);
    } catch {
      return '';
    }
  }

  private key(prefix: string, value: string): string {
    return `${prefix}_${createHash('sha1')
      .update(value || '')
      .digest('hex')
      .slice(0, 16)}`;
  }

  private errorStack(error: unknown): string | undefined {
    return error instanceof Error ? error.stack : undefined;
  }
}
