import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AnalyticsVisitor, AnalyticsVisitorDocument } from './schemas/analytics-visitor.schema';
import { AnalyticsDailyAggregate, AnalyticsDailyDocument } from './schemas/analytics-daily.schema';
import { AnalyticsVisitorType } from './enums/analytics-visitor-type.enum';

export interface AnalyticsDateQuery { from?: string; to?: string; }
type PlainRecord = Record<string, unknown>;

@Injectable()
export class WebsiteAnalyticsAggregationService {
  constructor(
    @InjectModel(AnalyticsVisitor.name)
    private readonly visitorModel: Model<AnalyticsVisitorDocument>,
    @InjectModel(AnalyticsDailyAggregate.name)
    private readonly dailyModel: Model<AnalyticsDailyDocument>,
  ) {}

  async getOverview(query: AnalyticsDateQuery = {}) {
    const [daily, activeSessions, visitors] = await Promise.all([
      this.loadDaily(query),
      this.countActiveSessions(),
      Object.keys(this.visitorFilter(query)).length
        ? this.visitorModel.countDocuments(this.visitorFilter(query)).exec()
        : this.visitorModel.estimatedDocumentCount().exec(),
    ]);
    const totals = this.sumDaily(daily);
    const sessionCount = totals.sessions;
    return {
      visitors,
      uniqueVisitorDays: totals.uniqueVisitors,
      registeredUniqueVisitorDays: totals.registeredUniqueVisitors,
      anonymousUniqueVisitorDays: totals.anonymousUniqueVisitors,
      sessions: sessionCount,
      activeSessions,
      pageViews: totals.pageViews,
      events: totals.events,
      totalTimeMs: totals.totalActiveTimeMs,
      totalActiveTimeMs: totals.totalActiveTimeMs,
      averageSessionDurationMs: totals.endedSessions > 0 ? Math.round(totals.totalActiveTimeMs / totals.endedSessions) : 0,
      averageActiveSessionTimeMs: sessionCount > 0 ? Math.round(totals.totalActiveTimeMs / sessionCount) : 0,
      bounceRate: totals.endedSessions > 0 ? Number(((totals.bouncedSessions / totals.endedSessions) * 100).toFixed(2)) : 0,
      bouncedSessions: totals.bouncedSessions,
      registeredEvents: totals.registeredEvents,
      anonymousEvents: totals.anonymousEvents,
      conversions: totals.conversions,
      reportingNotes: {
        visitors: 'Distinct users are counted from one compact summary per identity. Date-range identity filtering uses a bounded 400-active-day history and may undercount old ranges; daily uniqueVisitorDays are not the same as distinct visitors across the whole range.',
        activeSessions: 'Active sessions are based on bounded recent-session summaries seen in the last 30 minutes and are an approximate real-time metric.',
      },
    };
  }

  async getDashboardSummary(query: AnalyticsDateQuery = {}) {
    const [overview, visitors, pages, devices, browsers, operatingSystems, countries, sources, events] = await Promise.all([
      this.getOverview(query), this.getVisitorBreakdown(query), this.getTopPages(query, 10),
      this.getDevices(query), this.getBrowsers(query), this.getOperatingSystems(query),
      this.getCountries(query, 10), this.getTrafficSources(query, 10), this.getEventTypes(query, 10),
    ]);
    return { overview, visitors, pages, technology: { devices, browsers, operatingSystems }, geography: { countries }, traffic: { sources }, events };
  }

  async getVisitorBreakdown(query: AnalyticsDateQuery = {}) {
    const filter = this.visitorFilter(query);
    const [registered, anonymous] = await Promise.all([
      this.visitorModel.countDocuments({ ...filter, visitorType: AnalyticsVisitorType.REGISTERED }).exec(),
      this.visitorModel.countDocuments({ ...filter, visitorType: AnalyticsVisitorType.ANONYMOUS }).exec(),
    ]);
    return [
      { visitorType: 'registered', visitors: registered },
      { visitorType: 'anonymous', visitors: anonymous },
    ];
  }

  async getTopPages(query: AnalyticsDateQuery = {}, limit = 20) {
    const daily = await this.loadDaily(query);
    const views = this.mergeCounts(daily, 'pageViewCounts', 'pageLabels');
    const visitorPageCounts = new Map<string, number>();
    // Stream the compact visitor collection so large collections do not need to be held in process memory.
    // These lifetime path counters cannot provide date-exact per-page visitor counts once raw events are removed.
    const pageVisitorFilter = this.visitorFilter(query);
    if (!Object.keys(pageVisitorFilter).length) {
      pageVisitorFilter.lastSeenAt = { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) };
    }
    const cursor = this.visitorModel.find(pageVisitorFilter, { pageViewsByPath: 1, pagePathLabels: 1 }).lean().cursor();
    for await (const visitor of cursor as any) {
      const values = this.toRecord((visitor as any).pageViewsByPath);
      const labels = this.toRecord((visitor as any).pagePathLabels);
      for (const [key, count] of Object.entries(values)) {
        const path = String(labels[key] ?? '');
        if (path && Number(count) > 0) visitorPageCounts.set(path, (visitorPageCounts.get(path) ?? 0) + 1);
      }
    }
    return this.sortCounts(views).slice(0, this.safeLimit(limit)).map(({ name: path, count: pageViews }) => ({
      path, views: pageViews, uniqueVisitors: visitorPageCounts.get(path) ?? 0,
    }));
  }

  async getEntryPages(query: AnalyticsDateQuery = {}, limit = 10) {
    const docs = await this.loadDaily(query);
    return this.sortCounts(this.mergeCounts(docs, 'entryPageCounts', 'entryPageLabels'))
      .slice(0, this.safeLimit(limit)).map(({ name: path, count: sessions }) => ({ path, views: sessions, sessions }));
  }

  async getExitPages(query: AnalyticsDateQuery = {}, limit = 10) {
    const docs = await this.loadDaily(query);
    return this.sortCounts(this.mergeCounts(docs, 'exitPageCounts', 'exitPageLabels'))
      .slice(0, this.safeLimit(limit)).map(({ name: path, count: sessions }) => ({ path, views: sessions, sessions }));
  }

  async getPageEngagement(query: AnalyticsDateQuery = {}, limit = 50) {
    const pages = await this.getTopPages(query, limit);
    const docs = await this.loadDaily(query);
    const durationTotals = this.mergeCounts(docs, 'pageDurationMsByPath', 'pageDurationLabels');
    const durationCounts = this.mergeCounts(docs, 'pageDurationCountByPath', 'pageDurationLabels');
    return pages.map((page) => {
      const durationCount = durationCounts.get(page.path) ?? 0;
      return {
        ...page,
        pageViews: page.views,
        averageTimeMs: durationCount > 0 ? Math.round((durationTotals.get(page.path) ?? 0) / durationCount) : 0,
      };
    });
  }

  async getNewVsReturningVisitors(query: AnalyticsDateQuery = {}) {
    const filter = this.visitorFilter(query);
    const from = this.parseDate(query.from, false);
    // Without a from-date the legacy response classifies the entire filtered
    // population as new. Keep that contract without an unnecessary aggregation.
    if (!from) {
      const totalVisitors = Object.keys(filter).length
        ? await this.visitorModel.countDocuments(filter).exec()
        : await this.visitorModel.estimatedDocumentCount().exec();
      return { newVisitors: totalVisitors, returningVisitors: 0, totalVisitors };
    }
    const [result] = await this.visitorModel.aggregate<{
      totalVisitors: number; newVisitors: number; returningVisitors: number;
    }>([
      { $match: filter },
      { $group: {
        _id: null,
        totalVisitors: { $sum: 1 },
        newVisitors: { $sum: { $cond: [{ $gte: ['$firstSeenAt', from] }, 1, 0] } },
        returningVisitors: { $sum: { $cond: [{ $lt: ['$firstSeenAt', from] }, 1, 0] } },
      } },
    ]).exec();
    return {
      newVisitors: Number(result?.newVisitors ?? 0),
      returningVisitors: Number(result?.returningVisitors ?? 0),
      totalVisitors: Number(result?.totalVisitors ?? 0),
    };
  }

  async getConversions(query: AnalyticsDateQuery = {}) {
    const totals = this.sumDaily(await this.loadDaily(query));
    const overview = await this.getOverview(query);
    return { conversions: totals.conversions, visitors: overview.visitors, conversionRate: overview.visitors ? Number(((totals.conversions / overview.visitors) * 100).toFixed(2)) : 0 };
  }

  async getTrafficSources(query: AnalyticsDateQuery = {}, limit = 20) { return this.getMapBreakdown(query, 'sourceCounts', 'sourceLabels', limit); }
  async getCountries(query: AnalyticsDateQuery = {}, limit = 20) { return this.getMapBreakdown(query, 'countryCounts', 'countryLabels', limit); }
  async getCities(query: AnalyticsDateQuery = {}, limit = 20) { return this.getMapBreakdown(query, 'cityCounts', 'cityLabels', limit); }
  async getDevices(query: AnalyticsDateQuery = {}) { return this.getMapBreakdown(query, 'deviceCounts', 'deviceLabels', 100); }
  async getBrowsers(query: AnalyticsDateQuery = {}) { return this.getMapBreakdown(query, 'browserCounts', 'browserLabels', 100); }
  async getOperatingSystems(query: AnalyticsDateQuery = {}) { return this.getMapBreakdown(query, 'operatingSystemCounts', 'operatingSystemLabels', 100); }
  async getEventTypes(query: AnalyticsDateQuery = {}, limit = 20) { return this.getMapBreakdown(query, 'eventTypeCounts', 'eventTypeLabels', limit); }
  async getEventNames(query: AnalyticsDateQuery = {}, limit = 20) { return this.getMapBreakdown(query, 'eventNameCounts', 'eventNameLabels', limit); }

  async getSearches(query: AnalyticsDateQuery = {}, limit = 20) {
    const all = await this.getEventNames(query, 100);
    return all.filter((item: any) => /search/i.test(String(item.name))).slice(0, this.safeLimit(limit));
  }
  async getFilters(query: AnalyticsDateQuery = {}, limit = 20) {
    const all = await this.getEventNames(query, 100);
    return all.filter((item: any) => /filter/i.test(String(item.name))).slice(0, this.safeLimit(limit));
  }

  async getHourlyTrend(query: AnalyticsDateQuery = {}) {
    const docs = await this.loadDaily(query);
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, events: 0 }));
    for (const doc of docs as any[]) {
      const counts = this.toRecord(doc.hourlyEventCounts);
      for (let hour = 0; hour < 24; hour++) hours[hour].events += Number(counts[`h_${String(hour).padStart(2, '0')}`] ?? 0);
    }
    return hours;
  }

  async getDailyTrend(query: AnalyticsDateQuery = {}) {
    const docs = await this.loadDaily(query);
    return docs.map((doc: any) => ({
      date: doc.dayKey,
      events: Number(doc.events ?? 0),
      pageViews: Number(doc.pageViews ?? 0),
      sessions: Number(doc.sessions ?? 0),
      endedSessions: Number(doc.endedSessions ?? 0),
      bouncedSessions: Number(doc.bouncedSessions ?? 0),
      uniqueVisitors: Number(doc.uniqueVisitors ?? 0),
      registeredUniqueVisitors: Number(doc.registeredUniqueVisitors ?? 0),
      anonymousUniqueVisitors: Number(doc.anonymousUniqueVisitors ?? 0),
      totalActiveTimeMs: Number(doc.totalActiveTimeMs ?? 0),
      conversions: Number(doc.conversions ?? 0),
    }));
  }

  async getMonthlyTrend(query: AnalyticsDateQuery = {}) {
    const docs = await this.loadDaily(query);
    const grouped = new Map<string, { month: string; events: number; pageViews: number; sessions: number; endedSessions: number; bouncedSessions: number; uniqueVisitors: number; registeredUniqueVisitors: number; anonymousUniqueVisitors: number; totalActiveTimeMs: number; conversions: number }>();
    for (const doc of docs as any[]) {
      const month = String(doc.dayKey).slice(0, 7);
      const current = grouped.get(month) ?? { month, events: 0, pageViews: 0, sessions: 0, endedSessions: 0, bouncedSessions: 0, uniqueVisitors: 0, registeredUniqueVisitors: 0, anonymousUniqueVisitors: 0, totalActiveTimeMs: 0, conversions: 0 };
      current.events += Number(doc.events ?? 0); current.pageViews += Number(doc.pageViews ?? 0);
      current.sessions += Number(doc.sessions ?? 0); current.endedSessions += Number(doc.endedSessions ?? 0);
      current.bouncedSessions += Number(doc.bouncedSessions ?? 0); current.uniqueVisitors += Number(doc.uniqueVisitors ?? 0);
      current.registeredUniqueVisitors += Number(doc.registeredUniqueVisitors ?? 0); current.anonymousUniqueVisitors += Number(doc.anonymousUniqueVisitors ?? 0);
      current.totalActiveTimeMs += Number(doc.totalActiveTimeMs ?? 0); current.conversions += Number(doc.conversions ?? 0);
      grouped.set(month, current);
    }
    return [...grouped.values()].sort((a, b) => a.month.localeCompare(b.month));
  }

  async getRealtime() {
    const since = new Date(Date.now() - 5 * 60_000);
    const visitors = await this.visitorModel.find({ lastSeenAt: { $gte: since } }, { visitorId: 1, userId: 1, visitorType: 1, lastSeenAt: 1, lastPath: 1, recentActivity: 1 }).sort({ lastSeenAt: -1 }).limit(100).lean().exec();
    const activity: any[] = [];
    for (const visitor of visitors as any[]) {
      for (const event of visitor.recentActivity ?? []) {
        if (new Date(event.occurredAt).getTime() >= since.getTime()) activity.push({ ...event, visitorId: visitor.visitorId, visitorType: visitor.visitorType });
      }
    }
    activity.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
    return {
      activeVisitors: visitors.length,
      registeredVisitors: visitors.filter((item: any) => item.visitorType === 'registered').length,
      anonymousVisitors: visitors.filter((item: any) => item.visitorType === 'anonymous').length,
      recentEvents: activity.slice(0, 100),
    };
  }

  async getUserAnalytics(userId: string) {
    if (!Types.ObjectId.isValid(userId)) return null;
    const visitor = await this.visitorModel.findOne({ userId: new Types.ObjectId(userId) }).lean().exec();
    return visitor ? this.formatVisitor(visitor as any) : null;
  }

  async getVisitorAnalytics(visitorId: string) {
    const visitor = await this.visitorModel.findOne({ visitorId }).lean().exec()
      ?? await this.visitorModel.findOne({ visitorId: `anon:${visitorId}` }).lean().exec();
    return visitor ? this.formatVisitor(visitor as any) : null;
  }

  // Helpers used by the reporting endpoints.
  private async getMapBreakdown(query: AnalyticsDateQuery, countsField: string, labelsField: string, limit: number) {
    return this.sortCounts(this.mergeCounts(await this.loadDaily(query), countsField, labelsField))
      .slice(0, this.safeLimit(limit)).map(({ name, count }) => ({ name, count }));
  }

  private async loadDaily(query: AnalyticsDateQuery) {
    const filter: Record<string, unknown> = {};
    const range: Record<string, Date> = {};
    const from = this.parseDate(query.from, false);
    const to = this.parseDate(query.to, true);
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    if (Object.keys(range).length) filter.date = range;
    return this.dailyModel.find(filter).sort({ date: 1 }).lean().exec();
  }

  private visitorFilter(query: AnalyticsDateQuery): Record<string, unknown> {
    const from = this.parseDate(query.from, false);
    const to = this.parseDate(query.to, true);
    const dayRange: Record<string, string> = {};
    if (from) dayRange.$gte = from.toISOString().slice(0, 10);
    if (to) dayRange.$lte = to.toISOString().slice(0, 10);
    if (!Object.keys(dayRange).length) return {};
    // YYYY-MM-DD strings sort lexicographically; each visitor has a bounded active-day history.
    return { recentActiveDayKeys: dayRange };
  }

  private async countActiveSessions(): Promise<number> {
    // Use lastSeenAt index to avoid loading every user summary for the admin dashboard.
    const since = new Date(Date.now() - 30 * 60_000);
    const cursor = this.visitorModel.find(
      { lastSeenAt: { $gte: since } },
      { recentSessions: 1 },
    ).lean().cursor();
    let count = 0;
    for await (const visitor of cursor as any) {
      for (const session of ((visitor as any).recentSessions ?? []) as any[]) {
        const activeAt = session.lastActiveAt ? new Date(session.lastActiveAt).getTime() : 0;
        if (session.isActive && !session.endedAt && activeAt >= since.getTime()) count += 1;
      }
    }
    return count;
  }

  private sumDaily(docs: any[]) {
    return docs.reduce((sum, row) => ({
      events: sum.events + Number(row.events ?? 0),
      pageViews: sum.pageViews + Number(row.pageViews ?? 0),
      sessions: sum.sessions + Number(row.sessions ?? 0),
      endedSessions: sum.endedSessions + Number(row.endedSessions ?? 0),
      bouncedSessions: sum.bouncedSessions + Number(row.bouncedSessions ?? 0),
      uniqueVisitors: sum.uniqueVisitors + Number(row.uniqueVisitors ?? 0),
      registeredUniqueVisitors: sum.registeredUniqueVisitors + Number(row.registeredUniqueVisitors ?? 0),
      anonymousUniqueVisitors: sum.anonymousUniqueVisitors + Number(row.anonymousUniqueVisitors ?? 0),
      totalActiveTimeMs: sum.totalActiveTimeMs + Number(row.totalActiveTimeMs ?? 0),
      registeredEvents: sum.registeredEvents + Number(row.registeredEvents ?? 0),
      anonymousEvents: sum.anonymousEvents + Number(row.anonymousEvents ?? 0),
      conversions: sum.conversions + Number(row.conversions ?? 0),
    }), { events: 0, pageViews: 0, sessions: 0, endedSessions: 0, bouncedSessions: 0, uniqueVisitors: 0, registeredUniqueVisitors: 0, anonymousUniqueVisitors: 0, totalActiveTimeMs: 0, registeredEvents: 0, anonymousEvents: 0, conversions: 0 });
  }

  private mergeCounts(docs: any[], countsField: string, labelsField: string): Map<string, number> {
    const result = new Map<string, number>();
    for (const row of docs) {
      const counts = this.toRecord(row[countsField]);
      const labels = this.toRecord(row[labelsField]);
      for (const [key, rawCount] of Object.entries(counts)) {
        const label = String(labels[key] ?? key);
        result.set(label, (result.get(label) ?? 0) + Number(rawCount ?? 0));
      }
    }
    return result;
  }

  private countBy(items: any[], getValue: (item: any) => string | undefined, limit: number, property: string) {
    const values = new Map<string, number>();
    for (const item of items) {
      const name = String(getValue(item) ?? '').trim();
      if (name) values.set(name, (values.get(name) ?? 0) + 1);
    }
    return this.sortCounts(values).slice(0, limit).map(({ name, count }) => ({ [property]: name, views: count, sessions: count }));
  }

  private sortCounts(map: Map<string, number>) { return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)); }
  private toRecord(value: unknown): PlainRecord {
    if (value instanceof Map) return Object.fromEntries(value.entries());
    if (value && typeof value === 'object') return value as PlainRecord;
    return {};
  }
  private formatVisitor(visitor: any) {
    return {
      visitorId: visitor.visitorId, userId: visitor.userId ?? null, visitorType: visitor.visitorType,
      totalSessions: visitor.totalSessions ?? 0, totalPageViews: visitor.totalPageViews ?? 0,
      totalEvents: visitor.totalEvents ?? 0, totalActiveTimeMs: visitor.totalActiveTimeMs ?? 0,
      firstSeenAt: visitor.firstSeenAt, lastSeenAt: visitor.lastSeenAt, lastPath: visitor.lastPath,
      device: { type: visitor.deviceType, browser: visitor.browser, operatingSystem: visitor.operatingSystem, screenWidth: visitor.screenWidth, screenHeight: visitor.screenHeight },
      location: { country: visitor.country, countryCode: visitor.countryCode, region: visitor.region, city: visitor.city },
      traffic: { firstReferrer: visitor.firstReferrer, firstUtmSource: visitor.firstUtmSource, firstUtmMedium: visitor.firstUtmMedium, firstUtmCampaign: visitor.firstUtmCampaign },
      recentSessions: visitor.recentSessions ?? [], recentActivity: visitor.recentActivity ?? [],
    };
  }
  private parseDate(value: string | undefined, end: boolean): Date | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return undefined;
    if (end && /^\d{4}-\d{2}-\d{2}$/.test(value)) date.setUTCHours(23, 59, 59, 999);
    return date;
  }
  private inRange(value: unknown, query: AnalyticsDateQuery): boolean {
    const time = value ? new Date(value as any).getTime() : 0;
    if (!Number.isFinite(time)) return false;
    const from = this.parseDate(query.from, false)?.getTime();
    const to = this.parseDate(query.to, true)?.getTime();
    return (from === undefined || time >= from) && (to === undefined || time <= to);
  }
  private safeLimit(value: number) { return Number.isFinite(value) ? Math.min(100, Math.max(1, Math.floor(value))) : 20; }
}

