import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Ad } from './schemas/ad.schema';
import { AdEvent } from './schemas/ad-event.schema';
import { ExternalAdPolicyConfig } from './schemas/external-ad-policy.schema';
import { SystemMonitorService } from '../system-monitor/system-monitor.service';

type MonitorCheck = { name: string; status: 'OK' | 'FAILED'; value?: unknown; error?: string };

@Injectable()
export class AdsMonitorService implements OnModuleInit {
  onModuleInit(): void {
    this.systemMonitor.registerModule('ads');
  }

  constructor(
    @InjectModel(Ad.name) private readonly adModel: Model<Ad>,
    @InjectModel(AdEvent.name) private readonly eventModel: Model<AdEvent>,
    @InjectModel(ExternalAdPolicyConfig.name)
    private readonly policyModel: Model<ExternalAdPolicyConfig>,
    private readonly systemMonitor: SystemMonitorService,
  ) {}

  private async safeQuery<T>(
    checks: MonitorCheck[],
    name: string,
    query: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      const value = await query();
      checks.push({ name, status: 'OK', value });
      return value;
    } catch (error) {
      checks.push({
        name,
        status: 'FAILED',
        error: error instanceof Error ? error.message : 'Query failed',
      });
      return fallback;
    }
  }

  async getOverview() {
    try {
      return await this.buildOverview();
    } catch (error) {
      this.systemMonitor.reportMonitorSnapshot('ads', {
        status: 'FAILED',
        checkedAt: new Date(),
        checks: [{ name: 'getOverview', status: 'FAILED', error: error instanceof Error ? error.message : String(error) }],
      });
      throw error;
    }
  }

  private async buildOverview() {
    const checkedAt = new Date();
    const now = new Date();
    const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const checks: MonitorCheck[] = [];
    const databaseReady = this.adModel.db.readyState === 1;

    const [
      totalAds,
      activeAds,
      inactiveAds,
      currentlyDeliverableAds,
      scheduledAds,
      expiredActiveAds,
      automatedActiveAds,
      totalEvents,
      eventsLast24Hours,
      eventTypesLast24Hours,
      policyCount,
      enabledPolicies,
    ] = await Promise.all([
      this.safeQuery(checks, 'ads.total', () => this.adModel.countDocuments({}).exec(), 0),
      this.safeQuery(checks, 'ads.active', () => this.adModel.countDocuments({ isActive: true }).exec(), 0),
      this.safeQuery(checks, 'ads.inactive', () => this.adModel.countDocuments({ isActive: false }).exec(), 0),
      this.safeQuery(checks, 'ads.deliverable', () => this.adModel.countDocuments({
        isActive: true,
        $and: [
          { $or: [{ startDate: { $exists: false } }, { startDate: null }, { startDate: { $lte: now } }] },
          { $or: [{ endDate: { $exists: false } }, { endDate: null }, { endDate: { $gt: now } }] },
        ],
      }).exec(), 0),
      this.safeQuery(checks, 'ads.scheduled', () => this.adModel.countDocuments({
        isActive: true, startDate: { $gt: now },
      }).exec(), 0),
      this.safeQuery(checks, 'ads.expired-but-active', () => this.adModel.countDocuments({
        isActive: true, endDate: { $lte: now },
      }).exec(), 0),
      this.safeQuery(checks, 'ads.automated-active', () => this.adModel.countDocuments({
        isActive: true, automated: true,
      }).exec(), 0),
      this.safeQuery(checks, 'events.total', () => this.eventModel.countDocuments({}).exec(), 0),
      this.safeQuery(checks, 'events.last-24-hours', () => this.eventModel.countDocuments({
        createdAt: { $gte: last24Hours },
      }).exec(), 0),
      this.safeQuery(checks, 'events.breakdown-24-hours', () => this.eventModel.aggregate([
        { $match: { createdAt: { $gte: last24Hours } } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]).exec(), [] as Array<{ _id: string; count: number }>),
      this.safeQuery(checks, 'policy.total', () => this.policyModel.countDocuments({}).exec(), 0),
      this.safeQuery(checks, 'policy.enabled', () => this.policyModel.countDocuments({ enabled: true }).exec(), 0),
    ]);

    const warnings: string[] = [];
    if (!databaseReady) warnings.push('MongoDB connection is not ready.');
    if (expiredActiveAds > 0) warnings.push(`${expiredActiveAds} active ad(s) have passed their end date.`);
    if (policyCount === 0) warnings.push('No external-ad policy configuration record exists; runtime defaults may apply.');
    if (checks.some((check) => check.status === 'FAILED')) warnings.push('One or more monitoring queries failed.');

    const overview = {
      module: 'ads',
      checkedAt,
      status: !databaseReady || warnings.length ? 'DEGRADED' : 'OK',
      database: { connected: databaseReady, readyState: this.adModel.db.readyState },
      metrics: {
        ads: { total: totalAds, active: activeAds, inactive: inactiveAds, currentlyDeliverable: currentlyDeliverableAds, scheduled: scheduledAds, expiredButActive: expiredActiveAds, automatedActive: automatedActiveAds },
        events: { total: totalEvents, last24Hours: eventsLast24Hours, last24HoursByType: eventTypesLast24Hours },
        externalPolicy: { records: policyCount, enabled: enabledPolicies },
      },
      checks,
      warnings,
    };
    this.systemMonitor.reportMonitorSnapshot('ads', {
      status: overview.status,
      checkedAt,
      checks,
      warnings,
      details: {
        databaseConnected: databaseReady,
        activeAds,
        deliverableAds: currentlyDeliverableAds,
        expiredActiveAds,
        policyRecords: policyCount,
      },
    });
    return overview;
  }
}
