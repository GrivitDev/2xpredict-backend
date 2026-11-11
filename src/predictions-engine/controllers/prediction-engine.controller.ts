import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { PredictionEngineMonitorService } from '../services/prediction-engine-monitor.service';
import { PredictionTriggerService } from '../services/prediction-trigger.service';
import { SlipCenterService } from '../services/slip-center.service';
import { CuratedPredictionService } from '../services/curated-prediction.service';
import { MarketCalibrationService } from '../services/market-calibration.service';
import { PredictionReadService } from '../services/prediction-read.service';
import { PredictionAccessService } from '../../prediction-access/prediction-access.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { SlipProductType } from '../enums/slip-product-type.enum';

/**
 * Administrative operations for the prediction engine.
 *
 * Administrative operations are protected by the backend's existing JWT and
 * admin-role guards. Public prediction reads are handled separately.
 */
@Controller('predictions-engine')
@Roles('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PredictionEngineController {
  constructor(
    private readonly monitor: PredictionEngineMonitorService,
    private readonly trigger: PredictionTriggerService,
    private readonly slips: SlipCenterService,
    private readonly curatedPredictions: CuratedPredictionService,
    private readonly calibration: MarketCalibrationService,
    private readonly reads: PredictionReadService,
    private readonly access: PredictionAccessService,
  ) {}

  @Get('catalog')
  getCatalog() {
    return this.reads.getMarketCatalog();
  }

  @Get('monitor')
  getDashboard() {
    return this.monitor.dashboard();
  }

  @Get('monitor/runs')
  getRuns(@Query('limit') limit?: string) {
    return this.monitor.getRecentRuns(this.numberOr(limit, 50));
  }

  @Get('monitor/queue')
  getQueue(@Query('status') status?: string, @Query('limit') limit?: string) {
    return this.monitor.getQueueItems(status, this.numberOr(limit, 100));
  }

  @Get('monitor/events')
  getEvents(@Query('limit') limit?: string, @Query('level') level?: string) {
    return this.monitor.getEvents(this.numberOr(limit, 100), level);
  }

  @Get('monitor/markets/:eventId')
  getEventMarkets(@Param('eventId') eventId: string) {
    return this.monitor.getMarketDocuments(eventId);
  }

  @Get('monitor/market-coverage/:eventId')
  getMarketCoverage(@Param('eventId') eventId: string) {
    return this.monitor.getMarketCoverageAudit(eventId);
  }

  @Get('monitor/market-coverage')
  getMarketCoverageInventory(
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.monitor.getMarketCoverageInventory({
      from: query.from,
      to: query.to,
      leagueId: query.leagueId,
      page: this.numberOr(query.page, 1),
      pageSize: this.numberOr(query.pageSize, 50),
    });
  }

  @Post('queue/sync')
  syncQueue(@Body() body: { force?: boolean } = {}) {
    return this.trigger.synchronizeQueue(body.force === true);
  }

  @Post('queue/recover-stale')
  recoverStaleQueue() {
    return this.trigger.recoverStaleQueueItems();
  }

  @Post('queue/run-next')
  runNextQueueItem() {
    return this.trigger.runNextQueueItem();
  }

  @Post('generate/:eventId')
  generateFixture(@Param('eventId') eventId: string) {
    return this.trigger.generateFixture(eventId);
  }

  @Post('slips')
  buildSlip(@Body() body: Record<string, unknown>) {
    return this.slips.buildSlip({
      eventIds: Array.isArray(body.eventIds)
        ? body.eventIds.map((eventId: unknown) => String(eventId))
        : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
      selectionCount: this.optionalNumber(body.selectionCount),
      minimumProbability: this.optionalNumber(body.minimumProbability),
      minimumConfidence: this.optionalNumber(body.minimumConfidence),
      fixtureFrom: this.optionalDate(body.fixtureFrom),
      fixtureTo: this.optionalDate(body.fixtureTo),
      createdBy:
        typeof body.createdBy === 'string' ? body.createdBy : undefined,
      publish: body.publish === true,
      productType:
        typeof body.productType === 'string' && body.productType
          ? (body.productType.toUpperCase() as SlipProductType)
          : undefined,
      sureOddsTier:
        body.sureOddsTier === 'PREMIUM'
          ? 'PREMIUM'
          : body.sureOddsTier === 'VIP'
            ? 'VIP'
            : undefined,
      sureOddsProduct:
        body.sureOddsProduct === 'SURE_2' || body.sureOddsProduct === 'SURE_5' || body.sureOddsProduct === 'SURE_7'
          ? body.sureOddsProduct
          : undefined,
    });
  }

  @Patch('slips/:slipId/sportybet')
  updateSportyBet(
    @Param('slipId') slipId: string,
    @Body()
    body: {
      sportyBetSlipCode?: string | null;
      sportyBetSlipLink?: string | null;
      adminId?: string;
    },
  ) {
    return this.slips.updateSportyBet(
      slipId,
      {
        sportyBetSlipCode: body?.sportyBetSlipCode,
        sportyBetSlipLink: body?.sportyBetSlipLink,
      },
      body?.adminId,
    );
  }

  @Get('admin/pick-center')
  listAdminPickCenter(@Query() query: Record<string, string | undefined>) {
    return this.access.listPickCenterAdmin({
      leagueId: query.leagueId,
      from: query.from,
      to: query.to,
      page: this.optionalNumber(query.page),
      pageSize: this.optionalNumber(query.pageSize),
      includePast: query.includePast === 'true',
    });
  }

  @Get('admin/slips')
  listAdminSlips(@Query() query: Record<string, string | undefined>) {
    return this.access.listSlipsAdmin({
      from: query.from,
      to: query.to,
      productType: query.productType,
      automatic: query.automatic === undefined ? undefined : query.automatic === 'true',
      page: this.optionalNumber(query.page),
      pageSize: this.optionalNumber(query.pageSize),
      status: query.status,
    });
  }

  @Patch('slips/:slipId/legs')
  updateSlipLegs(
    @Param('slipId') slipId: string,
    @Body() body: { legs?: Array<{ eventId?: string; marketPredictionId?: string; marketKey?: string; selectionKey?: string }> },
  ) {
    return this.slips.updateSlipLegs(slipId, Array.isArray(body?.legs) ? body.legs : []);
  }

  @Post('slips/:slipId/publish')
  publishSlip(@Param('slipId') slipId: string) {
    return this.slips.publishSlip(slipId);
  }

  @Get('admin/predictions')
  listAdminCuratedPredictions(@Query() query: Record<string, string | undefined>) {
    return this.curatedPredictions.listAdmin({
      page: this.optionalNumber(query.page),
      pageSize: this.optionalNumber(query.pageSize),
      status: query.status,
    });
  }

  @Post('predictions/refresh')
  refreshCuratedPredictions() {
    return this.curatedPredictions.refreshFromPickCenter(true);
  }

  @Post('predictions/:predictionId/publish')
  publishCuratedPrediction(@Param('predictionId') predictionId: string) {
    return this.curatedPredictions.setPublicationStatus(predictionId, true);
  }

  @Post('predictions/:predictionId/unpublish')
  unpublishCuratedPrediction(@Param('predictionId') predictionId: string) {
    return this.curatedPredictions.setPublicationStatus(predictionId, false);
  }

  @Post('slips/refresh')
  refreshSlips() {
    return this.slips.refreshAutomaticSlips();
  }

  @Get('slips/:slipId')
  getSlip(@Param('slipId') slipId: string) {
    return this.slips.getSlip(slipId);
  }

  @Post('calibration/rebuild')
  rebuildCalibration(@Body() body: { marketKey?: string } = {}) {
    return body.marketKey
      ? this.calibration.rebuildMarket(body.marketKey)
      : this.calibration.rebuildAll();
  }

  @Get('calibration')
  listCalibration() {
    return this.calibration.list();
  }

  private numberOr(value: string | undefined, fallback: number): number {
    if (value === undefined || value.trim() === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private optionalNumber(value: unknown): number | undefined {
    if (value === null || value === undefined || value === '') {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private optionalDate(value: unknown): Date | undefined {
    if (typeof value !== 'string' && typeof value !== 'number')
      return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
}





