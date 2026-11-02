import { Controller, Get, UseGuards } from '@nestjs/common';

import { AnalyticsService } from './analytics.service';
import type { PublicAnalyticsStats } from './analytics.service';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';

import { Roles } from '../common/decorators/roles.decorator';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  // Public aggregate statistics used by the homepage. This endpoint returns counts only.
  // Keep it separate from the administrator-only dashboard response.
  @Get('public-stats')
  async getPublicStats(): Promise<PublicAnalyticsStats> {
    return this.analyticsService.getPublicStats();
  }

  // =====================================================
  // ADMIN DASHBOARD ANALYTICS
  // =====================================================

  @Get('dashboard')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getDashboard() {
    return this.analyticsService.getDashboard();
  }
}
