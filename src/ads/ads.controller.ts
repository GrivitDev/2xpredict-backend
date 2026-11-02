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
import { AdsService } from './ads.service';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { AdDeliveryQueryDto } from './dto/ad-delivery-query.dto';
import { TrackAdEventDto } from './dto/track-ad-event.dto';

function getUserId(request: Request): string | undefined {
  const id = (request as Request & { user?: { _id?: unknown } }).user?._id;
  if (typeof id === 'string') return id || undefined;
  if (typeof id === 'number' || typeof id === 'bigint') {
    return String(id) || undefined;
  }
  if (
    typeof id === 'object' &&
    id !== null &&
    'toHexString' in id &&
    typeof id.toHexString === 'function'
  ) {
    const hexId = id as { toHexString: () => string };
    return hexId.toHexString() || undefined;
  }
  return undefined;
}

@Controller('ads')
export class AdsController {
  constructor(private readonly ads: AdsService) {}

  /** External-provider policy only. It never disables in-app campaigns or InternalAdsModule content. */
  @Get('policy')
  @UseGuards(OptionalJwtAuthGuard)
  getPolicy(@Req() request: Request) {
    return this.ads.getPolicy(getUserId(request));
  }

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  getAds(@Query() query: AdDeliveryQueryDto, @Req() request: Request) {
    return this.ads.getPageAds(query, getUserId(request));
  }

  @Post(':id/events')
  @UseGuards(OptionalJwtAuthGuard)
  track(
    @Param('id') id: string,
    @Body() dto: TrackAdEventDto,
    @Req() request: Request,
  ) {
    return this.ads.trackEvent(id, dto, getUserId(request));
  }

  /** Backward-compatible endpoint for existing clients. */
  @Post(':id/impression')
  @UseGuards(OptionalJwtAuthGuard)
  impression(
    @Param('id') id: string,
    @Body() body: Partial<TrackAdEventDto>,
    @Req() request: Request,
  ) {
    return this.ads.recordImpression(
      id,
      body.eventKey,
      body.visitorKey,
      getUserId(request),
      body.sessionKey,
    );
  }

  /** Backward-compatible endpoint for existing clients. */
  @Post(':id/click')
  @UseGuards(OptionalJwtAuthGuard)
  click(
    @Param('id') id: string,
    @Body() body: Partial<TrackAdEventDto>,
    @Req() request: Request,
  ) {
    return this.ads.recordClick(
      id,
      body.eventKey,
      body.visitorKey,
      getUserId(request),
      body.sessionKey,
    );
  }
}
