import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

import { RolesGuard } from '../common/guards/roles.guard';

import { Roles } from '../common/decorators/roles.decorator';

import { SystemMonitorService } from './system-monitor.service';

import { SystemMonitorStorageService } from './system-monitor-storage.service';

@Controller('admin/system-monitor')
@Roles('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SystemMonitorController {
  constructor(
    private readonly systemMonitorService: SystemMonitorService,

    private readonly systemMonitorStorageService: SystemMonitorStorageService,
  ) {}

  // ============================================================
  // LIVE DASHBOARD
  // ============================================================

  @Get()
  getDashboard(): unknown {
    return this.systemMonitorService.getDashboard();
  }

  // ============================================================
  // CRONS
  // ============================================================

  @Get('crons')
  getCrons(
    @Query('module')
    module?: string,

    @Query('status')
    status?: string,
  ): unknown {
    return this.systemMonitorService.getCrons({
      module,
      status,
    });
  }

  @Get('crons/:key')
  getCron(
    @Param('key')
    key: string,
  ): unknown {
    return this.systemMonitorService.getCron(key);
  }

  // ============================================================
  // ERRORS
  // ============================================================

  @Get('errors')
  getErrors(
    @Query('module')
    module?: string,

    @Query('limit')
    limit?: string,
  ): unknown {
    return this.systemMonitorService.getErrors({
      module,

      limit: limit ? Number(limit) : undefined,
    });
  }

  // ============================================================
  // LIVE ACTIVITY
  // ============================================================

  @Get('activity')
  getActivity(
    @Query('module')
    module?: string,

    @Query('status')
    status?: string,

    @Query('limit')
    limit?: string,
  ): unknown {
    return this.systemMonitorService.getActivity({
      module,

      status,

      limit: limit ? Number(limit) : undefined,
    });
  }

  // ============================================================
  // STORAGE
  // ============================================================

  @Get('storage')
  getStorage(): unknown {
    return this.systemMonitorStorageService.getStorageStats();
  }

  // ============================================================
  // STORAGE HISTORY
  // ============================================================

  @Get('storage/history')
  getStorageHistory(
    @Query('limit')
    limit?: string,
  ): unknown {
    return this.systemMonitorStorageService.getStorageHistory(
      limit ? Number(limit) : undefined,
    );
  }
}
