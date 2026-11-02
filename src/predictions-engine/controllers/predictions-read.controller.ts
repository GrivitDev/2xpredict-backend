import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { PredictionReadService } from '../services/prediction-read.service';

type PredictionRequest = {
  user?: Parameters<PredictionReadService['listMarkets']>[1];
};

@Controller('predictions')
@UseGuards(OptionalJwtAuthGuard)
export class PredictionsReadController {
  constructor(private readonly reads: PredictionReadService) {}

  @Get('markets')
  listMarkets(
    @Req() request: PredictionRequest,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.reads.listMarkets(
      {
        eventId: query.eventId,
        leagueId: query.leagueId,
        marketKey: query.marketKey,
        status: query.status,
        from: query.from,
        to: query.to,
        selectionKey: query.selectionKey,
        minimumProbability: this.optionalNumber(query.minimumProbability),
        minimumConfidence: this.optionalNumber(query.minimumConfidence),
        page: this.optionalNumber(query.page),
        pageSize: this.optionalNumber(query.pageSize),
        includePast: query.includePast === 'true',
      },
      request?.user ?? null,
    );
  }

  @Get('markets/:eventId')
  getFixtureMarkets(
    @Param('eventId') eventId: string,
    @Req() request: PredictionRequest,
  ) {
    return this.reads.getFixtureMarkets(eventId, request?.user ?? null);
  }

  @Get('pick-center')
  listPickCenter(
    @Req() request: PredictionRequest,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.reads.listPickCenter(
      {
        leagueId: query.leagueId,
        from: query.from,
        to: query.to,
        page: this.optionalNumber(query.page),
        pageSize: this.optionalNumber(query.pageSize),
        includePast: query.includePast === 'true',
      },
      request?.user ?? null,
    );
  }

  @Get('pick-center/:eventId')
  getPickCenter(
    @Param('eventId') eventId: string,
    @Req() request: PredictionRequest,
  ) {
    return this.reads.getPickCenter(eventId, request?.user ?? null);
  }

  @Get('slips')
  listSlips(
    @Req() request: PredictionRequest,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.reads.listSlips(
      {
        from: query.from,
        to: query.to,
        productType: query.productType,
        automatic:
          query.automatic === undefined
            ? undefined
            : query.automatic === 'true',
        page: this.optionalNumber(query.page),
        pageSize: this.optionalNumber(query.pageSize),
        status: query.status,
        includeDrafts: false,
      },
      request?.user ?? null,
    );
  }

  @Get('slips/:slipId')
  getSlip(@Param('slipId') slipId: string, @Req() request: PredictionRequest) {
    return this.reads.getSlip(slipId, request?.user ?? null);
  }

  private optionalNumber(value: string | undefined): number | undefined {
    if (value === undefined || value.trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}


