import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { SportsMonitorService } from '../services/sports-monitor.service';
import { SportsQueueBootstrapService } from '../services/sports-queue-bootstrap.service';

/** Admin-only operational view for the ESPN Sports collection module. */
@Controller('admin/sports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class SportsMonitorController {
  constructor(
    private readonly monitor: SportsMonitorService,
    private readonly bootstrap: SportsQueueBootstrapService,
  ) {}

  @Get('monitor')
  getMonitor(@Query('refresh') refresh?: string) {
    return this.monitor.getOverview(refresh === 'true');
  }

  /** Retries only jobs recorded as failed by the most recent partial bootstrap. */
  @Post('bootstrap/retry-failed')
  retryFailedBootstrapJobs() {
    return this.bootstrap.retryFailedBootstrapJobs();
  }
}

