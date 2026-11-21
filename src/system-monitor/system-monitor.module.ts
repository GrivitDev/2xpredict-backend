import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { SystemMonitorController } from './system-monitor.controller';
import { SystemMonitorHttpDeliveryController } from './system-monitor-http-delivery.controller';
import { SystemMonitorService } from './system-monitor.service';
import { SystemMonitorStorageService } from './system-monitor-storage.service';
import { SystemMonitorDatabaseTrackerService } from './system-monitor-database-tracker.service';
import { SystemMonitorHealthService } from './system-monitor-health.service';
import { SystemMonitorRuntimeService } from './system-monitor-runtime.service';
import { SystemMonitorPerformanceService } from './system-monitor-performance.service';
import { SystemMonitorHttpDeliveryService } from './system-monitor-http-delivery.service';
import { SystemMonitorInterceptor } from './system-monitor-interceptor';
import { SystemMonitorRequestContextService } from './system-monitor-request-context.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  SystemMonitorStorageSnapshot,
  SystemMonitorStorageSnapshotSchema,
} from './system-monitor-storage.schema';
import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: SystemMonitorStorageSnapshot.name,
        schema: SystemMonitorStorageSnapshotSchema,
      },
    ]),
  ],
  controllers: [SystemMonitorController, SystemMonitorHttpDeliveryController],
  providers: [
    adminRealtimeRegistrationProvider(
      'system-monitor',
      'System Monitor: health, runtime, database and application telemetry.',
    ),
    SystemMonitorService,
    SystemMonitorStorageService,
    SystemMonitorDatabaseTrackerService,
    SystemMonitorHealthService,
    SystemMonitorRuntimeService,
    SystemMonitorPerformanceService,
    SystemMonitorHttpDeliveryService,
    SystemMonitorRequestContextService,
    JwtAuthGuard,
    RolesGuard,
    { provide: APP_INTERCEPTOR, useClass: SystemMonitorInterceptor },
  ],
  exports: [
    SystemMonitorService,
    SystemMonitorStorageService,
    SystemMonitorDatabaseTrackerService,
    SystemMonitorPerformanceService,
    SystemMonitorHttpDeliveryService,
    SystemMonitorRequestContextService,
  ],
})
export class SystemMonitorModule {}
