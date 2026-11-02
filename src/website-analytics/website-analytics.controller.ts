import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { Request } from 'express';

import { WebsiteAnalyticsService } from './website-analytics.service';

import { WebsiteAnalyticsSessionService } from './website-analytics-session.service';

import { WebsiteAnalyticsAggregationService } from './website-analytics-aggregation.service';

import { TrackEventsDto } from './dto/track-events.dto';

import { TrackSessionDto } from './dto/track-session.dto';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';

import { RolesGuard } from '../common/guards/roles.guard';

import { Roles } from '../common/decorators/roles.decorator';

@Controller('website-analytics')
export class WebsiteAnalyticsController {
  constructor(
    private readonly analyticsService: WebsiteAnalyticsService,

    private readonly sessionService: WebsiteAnalyticsSessionService,

    private readonly aggregationService: WebsiteAnalyticsAggregationService,
  ) {}

  // =========================================================
  // TRACK EVENTS
  // =========================================================

  @Post('events')
  @UseGuards(OptionalJwtAuthGuard)
  async trackEvents(
    @Body()
    payload: TrackEventsDto,

    @Req()
    request: Request,
  ) {
    const userId = (request as any).user?._id ?? undefined;

    return this.analyticsService.trackEvents(payload, userId);
  }

  // =========================================================
  // TRACK SESSION
  // =========================================================

  @Post('session')
  @UseGuards(OptionalJwtAuthGuard)
  async trackSession(
    @Body()
    payload: TrackSessionDto,

    @Req()
    request: Request,
  ) {
    const userId = (request as any).user?._id ?? undefined;

    return this.sessionService.trackSession(payload, userId);
  }

  // =========================================================
  // END SESSION
  // =========================================================

  @Post('session/end')
  @UseGuards(OptionalJwtAuthGuard)
  async endSession(
    @Body()
    payload: {
      sessionId: string;
      visitorId?: string;
      timestamp?: string;
      path?: string;
      durationMs?: number;
      activeTimeMs?: number;
      pageViews?: number;
      eventCount?: number;
      bounced?: boolean;
    },

    @Req()
    request: Request,
  ) {
    const userId = (request as any).user?._id ?? undefined;

    return this.sessionService.endSession(payload.sessionId, payload, userId, payload.visitorId);
  }

  // =========================================================
  // OVERVIEW
  // =========================================================

  @Get('overview')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getOverview(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,
  ) {
    return this.aggregationService.getOverview({
      from,
      to,
    });
  }

  // =========================================================
  // DASHBOARD
  // =========================================================

  @Get('dashboard')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getDashboard(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,
  ) {
    return this.aggregationService.getDashboardSummary({
      from,
      to,
    });
  }

  // =========================================================
  // PAGE ENGAGEMENT
  // =========================================================

  @Get('page-engagement')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getPageEngagement(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,

    @Query('limit')
    limit?: string,
  ) {
    return this.aggregationService.getPageEngagement(
      {
        from,
        to,
      },
      this.parseLimit(limit),
    );
  }

  // =========================================================
  // VISITOR TYPES
  // =========================================================

  @Get('visitor-types')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getVisitorTypes(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,
  ) {
    return this.aggregationService.getNewVsReturningVisitors({
      from,
      to,
    });
  }

  // =========================================================
  // CONVERSIONS
  // =========================================================

  @Get('conversions')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getConversions(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,
  ) {
    return this.aggregationService.getConversions({
      from,
      to,
    });
  }

  // =========================================================
  // TOP PAGES
  // =========================================================

  @Get('pages')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getPages(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,

    @Query('limit')
    limit?: string,
  ) {
    return this.aggregationService.getTopPages(
      {
        from,
        to,
      },
      this.parseLimit(limit),
    );
  }

  // =========================================================
  // ENTRY PAGES
  // =========================================================

  @Get('entry-pages')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getEntryPages(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,

    @Query('limit')
    limit?: string,
  ) {
    return this.aggregationService.getEntryPages(
      {
        from,
        to,
      },
      this.parseLimit(limit),
    );
  }

  // =========================================================
  // EXIT PAGES
  // =========================================================

  @Get('exit-pages')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getExitPages(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,

    @Query('limit')
    limit?: string,
  ) {
    return this.aggregationService.getExitPages(
      {
        from,
        to,
      },
      this.parseLimit(limit),
    );
  }

  // =========================================================
  // VISITORS
  // =========================================================

  @Get('visitors')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getVisitors(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,
  ) {
    return this.aggregationService.getVisitorBreakdown({
      from,
      to,
    });
  }

  // =========================================================
  // TRAFFIC SOURCES
  // =========================================================

  @Get('sources')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getSources(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,

    @Query('limit')
    limit?: string,
  ) {
    return this.aggregationService.getTrafficSources(
      {
        from,
        to,
      },
      this.parseLimit(limit),
    );
  }

  // =========================================================
  // COUNTRIES
  // =========================================================

  @Get('locations')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getLocations(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,

    @Query('limit')
    limit?: string,
  ) {
    return this.aggregationService.getCountries(
      {
        from,
        to,
      },
      this.parseLimit(limit),
    );
  }

  // =========================================================
  // CITIES
  // =========================================================

  @Get('cities')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getCities(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,

    @Query('limit')
    limit?: string,
  ) {
    return this.aggregationService.getCities(
      {
        from,
        to,
      },
      this.parseLimit(limit),
    );
  }

  // =========================================================
  // DEVICES
  // =========================================================

  @Get('devices')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getDevices(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,
  ) {
    return this.aggregationService.getDevices({
      from,
      to,
    });
  }

  // =========================================================
  // BROWSERS
  // =========================================================

  @Get('browsers')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getBrowsers(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,
  ) {
    return this.aggregationService.getBrowsers({
      from,
      to,
    });
  }

  // =========================================================
  // OPERATING SYSTEMS
  // =========================================================

  @Get('operating-systems')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getOperatingSystems(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,
  ) {
    return this.aggregationService.getOperatingSystems({
      from,
      to,
    });
  }

  // =========================================================
  // EVENT TYPES
  // =========================================================

  @Get('events')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getEventTypes(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,

    @Query('limit')
    limit?: string,
  ) {
    return this.aggregationService.getEventTypes(
      {
        from,
        to,
      },
      this.parseLimit(limit),
    );
  }

  // =========================================================
  // EVENT NAMES
  // =========================================================

  @Get('event-names')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getEventNames(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,

    @Query('limit')
    limit?: string,
  ) {
    return this.aggregationService.getEventNames(
      {
        from,
        to,
      },
      this.parseLimit(limit),
    );
  }

  // =========================================================
  // SEARCHES
  // =========================================================

  @Get('searches')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getSearches(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,

    @Query('limit')
    limit?: string,
  ) {
    return this.aggregationService.getSearches(
      {
        from,
        to,
      },
      this.parseLimit(limit),
    );
  }

  // =========================================================
  // FILTERS
  // =========================================================

  @Get('filters')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getFilters(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,

    @Query('limit')
    limit?: string,
  ) {
    return this.aggregationService.getFilters(
      {
        from,
        to,
      },
      this.parseLimit(limit),
    );
  }

  // =========================================================
  // HOURLY TREND
  // =========================================================

  @Get('trend/hourly')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getHourlyTrend(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,
  ) {
    return this.aggregationService.getHourlyTrend({
      from,
      to,
    });
  }

  // =========================================================
  // DAILY TREND
  // =========================================================

  @Get('trend/daily')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getDailyTrend(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,
  ) {
    return this.aggregationService.getDailyTrend({
      from,
      to,
    });
  }

  // =========================================================
  // MONTHLY TREND
  // =========================================================

  @Get('trend/monthly')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getMonthlyTrend(
    @Query('from')
    from?: string,

    @Query('to')
    to?: string,
  ) {
    return this.aggregationService.getMonthlyTrend({
      from,
      to,
    });
  }

  // =========================================================
  // REALTIME
  // =========================================================

  @Get('realtime')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getRealtime() {
    return this.aggregationService.getRealtime();
  }

  // =========================================================
  // INDIVIDUAL USER
  // =========================================================

  @Get('users/:userId')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getUserAnalytics(
    @Param('userId')
    userId: string,
  ) {
    return this.aggregationService.getUserAnalytics(userId);
  }

  // =========================================================
  // INDIVIDUAL VISITOR
  // =========================================================

  @Get('visitors/:visitorId')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async getVisitorAnalytics(
    @Param('visitorId')
    visitorId: string,
  ) {
    return this.aggregationService.getVisitorAnalytics(visitorId);
  }

  // =========================================================
  // HELPERS
  // =========================================================

  private parseLimit(value?: string): number {
    const parsed = Number(value);

    if (!Number.isFinite(parsed)) {
      return 20;
    }

    return Math.min(Math.max(Math.floor(parsed), 1), 100);
  }
}

