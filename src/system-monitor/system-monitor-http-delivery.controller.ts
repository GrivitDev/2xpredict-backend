import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { SystemMonitorHttpDeliveryService } from './system-monitor-http-delivery.service';

@Controller('admin/system-monitor/performance')
@Roles('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SystemMonitorHttpDeliveryController {
  constructor(private readonly deliveryMonitor: SystemMonitorHttpDeliveryService) {}

  @Get('http-delivery')
  getHttpDelivery(@Query('limit') limit?: string): unknown {
    return this.deliveryMonitor.getMetrics(
      limit ? Number(limit) : undefined,
    );
  }
}
