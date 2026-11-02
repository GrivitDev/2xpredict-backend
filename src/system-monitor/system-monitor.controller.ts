import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { SystemMonitorService } from './system-monitor.service';
import { SystemMonitorStorageService } from './system-monitor-storage.service';
import { SystemMonitorDatabaseTrackerService } from './system-monitor-database-tracker.service';

@Controller('admin/system-monitor')
@Roles('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SystemMonitorController {
  constructor(
    private readonly systemMonitorService: SystemMonitorService,
    private readonly storageService: SystemMonitorStorageService,
    private readonly databaseTracker: SystemMonitorDatabaseTrackerService,
  ) {}

  @Get() async getDashboard(): Promise<unknown> {
    const [systemResult, database, storage] = await Promise.all([
      this.systemMonitorService.getDashboard(),
      this.storageService.getDatabaseHealth(),
      this.storageService.getStorageStats().catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      })),
    ]);
    const system = systemResult as Record<string, any>;
    const databaseStatus = String((database as any)?.status ?? 'UNKNOWN');
    const currentStatus = String(system.system?.status ?? 'ONLINE');
    const overallStatus = databaseStatus === 'FAILED'
      ? 'FAILED'
      : databaseStatus === 'DEGRADED' || currentStatus === 'DEGRADED'
        ? 'DEGRADED'
        : currentStatus;
    return {
      ...system,
      system: { ...(system.system ?? {}), status: overallStatus },
      database: {
        ...(database as Record<string, unknown>),
        storage: storage && !('error' in storage) ? storage : undefined,
        storageError: storage && 'error' in storage ? storage.error : undefined,
      },
    };
  }
  @Get('modules') getModules(@Query('status') status?: string, @Query('level') level?: 'deep' | 'health', @Query('critical') critical?: string) {
    const flag = critical === undefined ? undefined : critical === 'true';
    return this.systemMonitorService.getModules({ status, level, critical: flag });
  }
  @Get('modules/:name') getModule(@Param('name') name: string) { return this.systemMonitorService.getModuleHealth(name); }
  @Get('crons') getCrons(@Query('module') module?: string, @Query('status') status?: string) { return this.systemMonitorService.getCrons({ module, status }); }
  @Get('crons/:key') getCron(@Param('key') key: string) { return this.systemMonitorService.getCron(key); }
  @Get('errors') getErrors(@Query('module') module?: string, @Query('limit') limit?: string) { return this.systemMonitorService.getErrors({ module, limit: limit ? Number(limit) : undefined }); }
  @Get('activity') getActivity(@Query('module') module?: string, @Query('status') status?: string, @Query('limit') limit?: string) {
    return this.systemMonitorService.getActivity({ module, status, limit: limit ? Number(limit) : undefined });
  }
  @Get('storage') getStorage(): unknown { return this.storageService.getStorageStats(); }
  @Get('storage/history') getStorageHistory(@Query('limit') limit?: string): unknown { return this.storageService.getStorageHistory(limit ? Number(limit) : undefined); }
  @Get('database') getDatabaseHealth(): unknown { return this.storageService.getDatabaseHealth(); }
  @Get('database/collections/:name') getCollection(@Param('name') name: string): unknown { return this.storageService.getCollectionDetail(name); }
  @Get('database/operations') getDatabaseOperations(@Query('limit') limit?: string, @Query('status') status?: string): unknown {
    return this.databaseTracker.getOperations({ limit: limit ? Number(limit) : undefined, status });
  }
  @Get('database/collections/:name/operations') getCollectionOperations(@Param('name') name: string, @Query('limit') limit?: string): unknown {
    return this.databaseTracker.getOperations({ collection: name, limit: limit ? Number(limit) : undefined });
  }
}
