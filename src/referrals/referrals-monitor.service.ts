import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Referral } from './schemas/referral.schema';

type MonitorCheck = { name: string; status: 'OK' | 'FAILED'; value?: unknown; error?: string };

@Injectable()
export class ReferralsMonitorService {
  constructor(
    @InjectModel(Referral.name) private readonly referralModel: Model<Referral>,
  ) {}

  private async safeQuery<T>(checks: MonitorCheck[], name: string, query: () => Promise<T>, fallback: T): Promise<T> {
    try {
      const value = await query();
      checks.push({ name, status: 'OK', value });
      return value;
    } catch (error) {
      checks.push({ name, status: 'FAILED', error: error instanceof Error ? error.message : 'Query failed' });
      return fallback;
    }
  }

  async getOverview() {
    const checkedAt = new Date();
    const dayAgo = new Date(checkedAt.getTime() - 24 * 60 * 60 * 1000);
    const checks: MonitorCheck[] = [];
    const databaseReady = this.referralModel.db.readyState === 1;

    const [
      total, registered, regularSubscribers, vipSubscribers, premiumSubscribers,
      rewardsClaimed, createdLast24Hours, incompleteRegistrations, inconsistentSubscriptionFlags,
    ] = await Promise.all([
      this.safeQuery(checks, 'referrals.total', () => this.referralModel.countDocuments({}).exec(), 0),
      this.safeQuery(checks, 'referrals.registered', () => this.referralModel.countDocuments({ registered: true }).exec(), 0),
      this.safeQuery(checks, 'referrals.regular-subscribers', () => this.referralModel.countDocuments({ regularSubscription: true }).exec(), 0),
      this.safeQuery(checks, 'referrals.vip-subscribers', () => this.referralModel.countDocuments({ vipSubscription: true }).exec(), 0),
      this.safeQuery(checks, 'referrals.premium-subscribers', () => this.referralModel.countDocuments({ premiumSubscription: true }).exec(), 0),
      this.safeQuery(checks, 'referrals.rewards-claimed', () => this.referralModel.countDocuments({ rewardClaimed: true }).exec(), 0),
      this.safeQuery(checks, 'referrals.created-24-hours', () => this.referralModel.countDocuments({ createdAt: { $gte: dayAgo } }).exec(), 0),
      this.safeQuery(checks, 'referrals.unregistered-records', () => this.referralModel.countDocuments({ registered: false }).exec(), 0),
      this.safeQuery(checks, 'referrals.subscription-without-registration', () => this.referralModel.countDocuments({
        registered: { $ne: true },
        $or: [{ regularSubscription: true }, { vipSubscription: true }, { premiumSubscription: true }],
      }).exec(), 0),
    ]);

    const warnings: string[] = [];
    if (!databaseReady) warnings.push('MongoDB connection is not ready.');
    if (inconsistentSubscriptionFlags > 0) warnings.push(`${inconsistentSubscriptionFlags} referral record(s) show a subscription without registered=true.`);
    if (checks.some((check) => check.status === 'FAILED')) warnings.push('One or more monitoring queries failed.');

    return {
      module: 'referrals',
      checkedAt,
      status: !databaseReady || warnings.length ? 'DEGRADED' : 'OK',
      database: { connected: databaseReady, readyState: this.referralModel.db.readyState },
      metrics: {
        referrals: { total, registered, notMarkedRegistered: incompleteRegistrations, createdLast24Hours },
        convertedSubscribers: { regular: regularSubscribers, vip: vipSubscribers, premium: premiumSubscribers },
        rewards: { claimed: rewardsClaimed },
        dataIntegrity: { subscriptionsWithoutRegistration: inconsistentSubscriptionFlags },
      },
      checks,
      warnings,
    };
  }
}
