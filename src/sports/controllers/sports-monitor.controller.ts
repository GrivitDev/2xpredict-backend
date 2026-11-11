import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { SportsMonitorService } from '../services/sports-monitor.service';

/** Admin-only operational view for the ESPN Sports collection module. */
@Controller('admin/sports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class SportsMonitorController {
  constructor(private readonly monitor: SportsMonitorService) {}

  @Get('monitor')
  getMonitor(@Query('refresh') refresh?: string) {
    return this.monitor.getOverview(refresh === 'true');
  }
}
