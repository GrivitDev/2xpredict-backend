import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersModule } from '../users/users.module';
import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';
import { UserSessionModule } from '../user-session/user-session.module';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { EmailModule } from './email.module';
import {
  UserNotification,
  UserNotificationSchema,
} from './in-app/schemas/user-notification.schema';
import { UserNotificationsController } from './in-app/user-notifications.controller';
import { UserNotificationsGateway } from './in-app/user-notifications.gateway';
import { UserNotificationsService } from './in-app/user-notifications.service';
import { NotificationEventsService } from './in-app/notification-events.service';
import {
  NotificationEvent,
  NotificationEventSchema,
} from './in-app/schemas/notification-event.schema';
import {
  EmailDelivery,
  EmailDeliverySchema,
} from './email-delivery/schemas/email-delivery.schema';
import { NotificationEmailDeliveryService } from './email-delivery/email-delivery.service';
import { ResendWebhookService } from './email-delivery/resend-webhook.service';
import {
  ResendEmailProviderEvent,
  ResendEmailProviderEventSchema,
} from './email-delivery/schemas/resend-email-provider-event.schema';
import {
  NotificationPreference,
  NotificationPreferenceSchema,
} from './preferences/schemas/notification-preference.schema';
import { NotificationPreferencesService } from './preferences/notification-preferences.service';
import { NotificationPreferencesController } from './preferences/notification-preferences.controller';
import { ResendWebhookController } from './email-delivery/resend-webhook.controller';
import { AdminNotificationsController } from './admin-notifications.controller';

/**
 * Global notification infrastructure. Business modules can inject the event
 * and email-delivery services without importing each other or adding cycles.
 * Telegram is deliberately excluded: it is reserved for AI public broadcasts.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    EmailModule,
    MongooseModule.forFeature([
      { name: UserNotification.name, schema: UserNotificationSchema },
      { name: NotificationEvent.name, schema: NotificationEventSchema },
      { name: EmailDelivery.name, schema: EmailDeliverySchema },
      {
        name: ResendEmailProviderEvent.name,
        schema: ResendEmailProviderEventSchema,
      },
      {
        name: NotificationPreference.name,
        schema: NotificationPreferenceSchema,
      },
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
    UsersModule,
    UserSessionModule,
  ],
  controllers: [
    UserNotificationsController,
    NotificationPreferencesController,
    ResendWebhookController,
    AdminNotificationsController,
  ],
  providers: [
    adminRealtimeRegistrationProvider(
      'notifications',
      'In-app notification events, preferences, durable email delivery and provider webhook reconciliation.',
    ),
    UserNotificationsService,
    NotificationEventsService,
    UserNotificationsGateway,
    NotificationPreferencesService,
    NotificationEmailDeliveryService,
    ResendWebhookService,
    JwtAuthGuard,
  ],
  exports: [
    UserNotificationsService,
    NotificationEventsService,
    NotificationPreferencesService,
    NotificationEmailDeliveryService,
    ResendWebhookService,
  ],
})
export class NotificationsModule {}

