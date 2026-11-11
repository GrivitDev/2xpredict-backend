import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { NotificationEventsService } from './in-app/notification-events.service';
import { NotificationEmailDeliveryService } from './email-delivery/email-delivery.service';
import { ResendWebhookService } from './email-delivery/resend-webhook.service';

@Controller('admin/notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminNotificationsController {
  constructor(
    private readonly events: NotificationEventsService,
    private readonly email: NotificationEmailDeliveryService,
    private readonly resendWebhooks: ResendWebhookService,
  ) {}

  /** Queue and provider health only; no message bodies or recipient addresses are exposed. */
  @Get('monitor')
  async getMonitor() {
    const [inApp, email, providerWebhooks] = await Promise.all([
      this.events.getQueueHealth(),
      this.email.getQueueHealth(),
      this.resendWebhooks.getQueueHealth(),
    ]);
    return { inApp, email, providerWebhooks, checkedAt: new Date().toISOString() };
  }
}
