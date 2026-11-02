import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdsService } from './ads.service';
import { AdsMonitorService } from './ads-monitor.service';
import { CreateAdDto } from './dto/create-ad.dto';
import { UpdateAdDto } from './dto/update-ad.dto';
import { ExternalAdPolicyDto } from './dto/external-ad-policy.dto';
import { AdListQueryDto } from './dto/ad-list-query.dto';
import { AdAnalyticsQueryDto } from './dto/ad-analytics-query.dto';
import { AdEventQueryDto } from './dto/ad-event-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

function isObjectIdLike(
  value: unknown,
): value is { toHexString: () => string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'toHexString' in value &&
    typeof value.toHexString === 'function'
  );
}

function getRequestUserId(request: Request): string {
  const user: unknown = request.user;
  if (typeof user !== 'object' || user === null || !('_id' in user)) {
    return '';
  }

  const id = (user as { _id?: unknown })._id;
  if (typeof id === 'string') {
    return id;
  }
  if (typeof id === 'number' || typeof id === 'bigint') {
    return String(id);
  }
  return isObjectIdLike(id) ? id.toHexString() : '';
}

@Controller('admin/ads')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminAdsController {
  constructor(
    private readonly ads: AdsService,
    private readonly monitor: AdsMonitorService,
  ) {}

  @Post()
  create(@Body() dto: CreateAdDto, @Req() request: Request) {
    return this.ads.create(dto, getRequestUserId(request));
  }

  @Get()
  findAll(@Query() query: AdListQueryDto) {
    return this.ads.findAll(query);
  }

  @Get('monitor')
  monitorOverview() {
    return this.monitor.getOverview();
  }

  @Get('analytics/overview')
  analytics(@Query() query: AdAnalyticsQueryDto) {
    return this.ads.getAnalytics(query);
  }

  @Get('analytics/:id')
  analyticsOne(@Param('id') id: string, @Query() query: AdAnalyticsQueryDto) {
    return this.ads.getAdAnalytics(id, query);
  }

  @Get('events')
  events(@Query() query: AdEventQueryDto) {
    return this.ads.getAdminEvents(query);
  }

  @Get('automation-options')
  automationOptions() {
    return this.ads.getAutomationOptions();
  }

  @Get('discover')
  discover(@Query('kind') kind?: string) {
    return this.ads.discoverContent(kind);
  }

  @Get('external-policy')
  externalPolicy() {
    return this.ads.getExternalPolicyAdmin();
  }

  @Patch('external-policy')
  updateExternalPolicy(
    @Body() dto: ExternalAdPolicyDto,
    @Req() request: Request,
  ) {
    return this.ads.updateExternalPolicy(dto, getRequestUserId(request));
  }

  @Get(':id/preview')
  preview(
    @Param('id') id: string,
    @Query('audience') audience: Parameters<AdsService['preview']>[1] = 'GUEST',
  ) {
    return this.ads.preview(id, audience);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ads.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAdDto,
    @Req() request: Request,
  ) {
    return this.ads.update(id, dto, getRequestUserId(request));
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.ads.remove(id);
  }

  @Patch(':id/status')
  toggle(@Param('id') id: string, @Req() request: Request) {
    return this.ads.toggleStatus(id, getRequestUserId(request));
  }
}