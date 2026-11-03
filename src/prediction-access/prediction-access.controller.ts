import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { PredictionAccessService } from './prediction-access.service';

type PredictionAccessRequest = {
  user?: Parameters<PredictionAccessService['listManualPredictions']>[0];
};

@Controller('prediction-access')
@UseGuards(OptionalJwtAuthGuard)
export class PredictionAccessController {
  constructor(private readonly access: PredictionAccessService) {}

  @Get('policy')
  getPolicy() {
    return this.access.getPolicy();
  }

  @Get('predictions')
  // Prediction Center: returns the separately persisted curated predictions.
  listManualPredictions(
    @Req() request: PredictionAccessRequest,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.access.listManualPredictions(request?.user ?? null, {
      league: query.league,
      page: this.optionalNumber(query.page),
      pageSize: this.optionalNumber(query.pageSize),
    });
  }

  @Get('predictions/:id')
  // The legacy :id segment accepts a curated prediction Mongo ID or predictionCode.
  getManualPrediction(
    @Param('id') id: string,
    @Req() request: PredictionAccessRequest,
  ) {
    return this.access.getManualPrediction(request?.user ?? null, id);
  }

  @Get('settled')
  listSettled(
    @Req() request: PredictionAccessRequest,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.access.listSettledMarkets(
      {
        eventId: query.eventId,
        leagueId: query.leagueId,
        marketKey: query.marketKey,
        from: query.from,
        to: query.to,
        page: this.optionalNumber(query.page),
        pageSize: this.optionalNumber(query.pageSize),
        includePast: true,
      },
      request?.user ?? null,
    );
  }

  @Get('markets')
  listMarkets(
    @Req() request: PredictionAccessRequest,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.access.listMarkets(
      {
        eventId: query.eventId,
        leagueId: query.leagueId,
        marketKey: query.marketKey,
        selectionKey: query.selectionKey,
        from: query.from,
        to: query.to,
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
    @Req() request: PredictionAccessRequest,
  ) {
    return this.access.getFixtureMarkets(eventId, request?.user ?? null);
  }

  @Get('pick-center')
  listPickCenter(
    @Req() request: PredictionAccessRequest,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.access.listPickCenter(
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
    @Req() request: PredictionAccessRequest,
  ) {
    return this.access.getPickCenter(eventId, request?.user ?? null);
  }

  @Get('curated-predictions')
  listCuratedPredictions(
    @Req() request: PredictionAccessRequest,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.access.listCuratedPredictions(request?.user ?? null, {
      from: query.from,
      to: query.to,
      league: query.league,
      page: this.optionalNumber(query.page),
      pageSize: this.optionalNumber(query.pageSize),
    });
  }

  @Get('slips')
  listSlips(
    @Req() request: PredictionAccessRequest,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.access.listSlips(
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
      },
      request?.user ?? null,
    );
  }

  @Get('slips/:slipId')
  getSlip(
    @Param('slipId') slipId: string,
    @Req() request: PredictionAccessRequest,
  ) {
    return this.access.getSlip(slipId, request?.user ?? null);
  }

  @Get('sure-odds')
  listSureOdds(
    @Req() request: PredictionAccessRequest,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.access.listSureOdds(
      {
        from: query.from,
        to: query.to,
        page: this.optionalNumber(query.page),
        pageSize: this.optionalNumber(query.pageSize),
      },
      request?.user ?? null,
    );
  }

  private optionalNumber(value: string | undefined): number | undefined {
    if (value === undefined || value.trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}
