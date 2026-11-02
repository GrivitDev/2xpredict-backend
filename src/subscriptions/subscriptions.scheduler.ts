import { Injectable } from '@nestjs/common';

import { Cron, CronExpression } from '@nestjs/schedule';

import { SubscriptionsService } from './subscriptions.service';
import { SystemMonitorService } from '../system-monitor/system-monitor.service';

@Injectable()
export class SubscriptionsScheduler {
  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    private readonly systemMonitor: SystemMonitorService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_8AM, {
    timeZone: 'Africa/Lagos',
  })
  async checkSubscriptions() {
    return this.systemMonitor.trackOperation('subscriptions', 'scheduler', 'daily-subscription-check', async () => {
      // Expiring subscriptions: notify users three days before expiry.
      const expiring = await this.subscriptionsService.getExpiringSubscriptions();
      for (const subscription of expiring) {
        await this.subscriptionsService.sendExpiringEmail(subscription);
      }

      // Expired subscriptions: send the existing expiry notification.
      const expired = await this.subscriptionsService.getSubscriptionsExpired();
      for (const subscription of expired) {
        await this.subscriptionsService.sendExpiredEmail(subscription);
      }
      return { expiring: expiring.length, expired: expired.length };
    }, { logSuccess: true });
  }
}

