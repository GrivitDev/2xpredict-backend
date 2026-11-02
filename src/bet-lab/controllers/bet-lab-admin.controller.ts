import { Body, Controller, Get, Patch, Query, UseGuards } from '@nestjs/common';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { BetLabAdminEventsQueryDto } from '../dto/bet-lab-admin-query.dto';
import { BetLabMonitorService } from '../services/bet-lab-monitor.service';
import { BetLabSettingsService } from '../services/bet-lab-settings.service';
import { UpdateBetLabVirtualPointsSettingsDto } from '../dto/update-bet-lab-virtual-points-settings.dto';
import { authenticatedUserId } from '../utils/auth-user.util';

@Controller('bet-lab/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class BetLabAdminController {
  constructor(
    private readonly monitorService: BetLabMonitorService,
    private readonly settingsService: BetLabSettingsService,
  ) {}

  @Get('settings')
  getSettings() {
    return this.settingsService.getVirtualPointsSettings();
  }

  @Patch('settings')
  updateSettings(
    @GetUser() user: unknown,
    @Body() body: UpdateBetLabVirtualPointsSettingsDto,
  ) {
    return this.settingsService.updateVirtualPointsSettings(
      body,
      authenticatedUserId(user),
    );
  }

  @Get('monitor')
  getMonitor() {
    return this.monitorService.getOverview();
  }

  @Get('events')
  getRecentEvents(@Query() query: BetLabAdminEventsQueryDto) {
    return this.monitorService.getRecentEvents(query.limit);
  }
}
