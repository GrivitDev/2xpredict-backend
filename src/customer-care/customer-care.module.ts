import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TelegramModule } from '../telegram/telegram.module';
import { OtpModule } from '../otp/otp.module';
import { UsersModule } from '../users/users.module';
import { PromosModule } from '../promos/promos.module';
import { PredictionsEngineModule } from '../predictions-engine/predictions-engine.module';
import { SystemMonitorModule } from '../system-monitor/system-monitor.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';
import { SupportConversation, SupportConversationSchema } from './schemas/support-conversation.schema';
import { SupportMessage, SupportMessageSchema } from './schemas/support-message.schema';
import { SupportActionAudit, SupportActionAuditSchema } from './schemas/support-action-audit.schema';
import { SupportIncident, SupportIncidentSchema } from './schemas/support-incident.schema';
import { CustomerCareBroadcast, CustomerCareBroadcastSchema } from './schemas/customer-care-broadcast.schema';
import { CustomerCareJob, CustomerCareJobSchema } from './schemas/customer-care-job.schema';
import { CustomerCareReplyJob, CustomerCareReplyJobSchema } from './schemas/customer-care-reply-job.schema';
import { SupportRateLimit, SupportRateLimitSchema } from './schemas/support-rate-limit.schema';
import { CustomerCareController } from './controllers/customer-care.controller';
import { CustomerCareAdminController } from './controllers/customer-care-admin.controller';
import { CustomerCareService } from './services/customer-care.service';
import { GroqAssistantService } from './services/groq-assistant.service';
import { SupportDiagnosticsService } from './services/support-diagnostics.service';
import { SupportActionService } from './services/support-action.service';
import { SupportEscalationService } from './services/support-escalation.service';
import { SupportRateLimitService } from './services/support-rate-limit.service';
import { CustomerCareMonitorService } from './services/customer-care-monitor.service';
import { DailyBroadcastService } from './services/daily-broadcast.service';
import { CustomerCareWorkerService } from './services/customer-care-worker.service';
import { CustomerCareReplyWorkerService } from './services/customer-care-reply-worker.service';
import { CustomerCareRetentionService } from './services/customer-care-retention.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SupportConversation.name, schema: SupportConversationSchema },
      { name: SupportMessage.name, schema: SupportMessageSchema },
      { name: SupportActionAudit.name, schema: SupportActionAuditSchema },
      { name: SupportIncident.name, schema: SupportIncidentSchema },
      { name: CustomerCareBroadcast.name, schema: CustomerCareBroadcastSchema },
      { name: CustomerCareJob.name, schema: CustomerCareJobSchema },
      { name: CustomerCareReplyJob.name, schema: CustomerCareReplyJobSchema },
      { name: SupportRateLimit.name, schema: SupportRateLimitSchema },
    ]),
    TelegramModule,
    OtpModule,
    UsersModule,
    PromosModule,
    PredictionsEngineModule,
    SystemMonitorModule,
    RealtimeModule,
    NotificationsModule,
  ],
  controllers: [CustomerCareController, CustomerCareAdminController],
  providers: [
    adminRealtimeRegistrationProvider('customer-care', '2xPredict Customer Care AI, diagnostic inspection, repair audits, incidents and AI public-channel broadcasts.'),
    CustomerCareService,
    GroqAssistantService,
    SupportDiagnosticsService,
    SupportActionService,
    SupportEscalationService,
    SupportRateLimitService,
    CustomerCareMonitorService,
    DailyBroadcastService,
    CustomerCareWorkerService,
    CustomerCareReplyWorkerService,
    CustomerCareRetentionService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [CustomerCareService, CustomerCareMonitorService],
})
export class CustomerCareModule {}


