import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Subscription } from './schemas/subscription.schema';

type MonitorCheck = { name: string; status: 'OK' | 'FAILED'; value?: unknown; error?: string };

@Injectable()
export class SubscriptionsMonitorService {
  constructor(
    @InjectModel(Subscription.name) private readonly subscriptionModel: Model<Subscription>,
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
    const now = new Date();
    const threeDaysAhead = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const checks: MonitorCheck[] = [];
    const databaseReady = this.subscriptionModel.db.readyState === 1;
    const activeWindow = { startDate: { $lte: now }, expiryDate: { $gt: now } };

    const [
      total, activeNow, inactive, expiredButActive, futureQueued, expiringWithinThreeDays,
      remindersDue, expiredNotificationsDue, createdLast24Hours, duplicateActiveUsers,
    ] = await Promise.all([
      this.safeQuery(checks, 'subscriptions.total', () => this.subscriptionModel.countDocuments({}).exec(), 0),
      this.safeQuery(checks, 'subscriptions.active-now', () => this.subscriptionModel.countDocuments({ isActive: true, ...activeWindow }).exec(), 0),
      this.safeQuery(checks, 'subscriptions.inactive', () => this.subscriptionModel.countDocuments({ isActive: false }).exec(), 0),
      this.safeQuery(checks, 'subscriptions.expired-but-active', () => this.subscriptionModel.countDocuments({ isActive: true, expiryDate: { $lte: now } }).exec(), 0),
      this.safeQuery(checks, 'subscriptions.future-queued', () => this.subscriptionModel.countDocuments({ isActive: false, startDate: { $gt: now }, expiryDate: { $gt: now } }).exec(), 0),
      this.safeQuery(checks, 'subscriptions.expiring-three-days', () => this.subscriptionModel.countDocuments({ isActive: true, startDate: { $lte: now }, expiryDate: { $gt: now, $lte: threeDaysAhead } }).exec(), 0),
      this.safeQuery(checks, 'subscriptions.reminders-due', () => this.subscriptionModel.countDocuments({ isActive: true, startDate: { $lte: now }, expiryDate: { $gt: now, $lte: threeDaysAhead }, expiringReminderSent: { $ne: true } }).exec(), 0),
      this.safeQuery(checks, 'subscriptions.expired-notifications-due', () => this.subscriptionModel.countDocuments({ expiryDate: { $lte: now }, expiredNotificationSent: { $ne: true } }).exec(), 0),
      this.safeQuery(checks, 'subscriptions.created-24-hours', () => this.subscriptionModel.countDocuments({ createdAt: { $gte: dayAgo } }).exec(), 0),
      this.safeQuery(checks, 'subscriptions.duplicate-active-users', async () => {
        const rows = await this.subscriptionModel.aggregate([
          { $match: { isActive: true, ...activeWindow } },
          { $group: { _id: '$userId', count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } },
          { $count: 'users' },
        ]).exec();
        return rows[0]?.users ?? 0;
      }, 0),
    ]);

    const warnings: string[] = [];
    if (!databaseReady) warnings.push('MongoDB connection is not ready.');
    if (expiredButActive > 0) warnings.push(`${expiredButActive} expired subscription(s) remain marked active.`);
    if (remindersDue > 0) warnings.push(`${remindersDue} active subscription(s) need an expiry reminder.`);
    if (expiredNotificationsDue > 0) warnings.push(`${expiredNotificationsDue} expired subscription(s) have not been marked as notified.`);
    if (duplicateActiveUsers > 0) warnings.push(`${duplicateActiveUsers} user(s) have multiple active subscriptions.`);
    if (checks.some((check) => check.status === 'FAILED')) warnings.push('One or more monitoring queries failed.');

    return {
      module: 'subscriptions',
      checkedAt,
      status: !databaseReady || warnings.length ? 'DEGRADED' : 'OK',
      database: { connected: databaseReady, readyState: this.subscriptionModel.db.readyState },
      metrics: {
        subscriptions: { total, activeNow, inactive, expiredButActive, futureQueued, expiringWithinThreeDays, createdLast24Hours },
        notifications: { expiryRemindersDue: remindersDue, expiredNotificationsDue },
        dataIntegrity: { usersWithMultipleActiveSubscriptions: duplicateActiveUsers },
      },
      checks,
      warnings,
    };
  }
}
