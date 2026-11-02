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
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { SettlementEventQueryDto } from '../dto/settlement-event-query.dto';
import { SettlementJobQueryDto } from '../dto/settlement-job-query.dto';
import { SettlementRunQueryDto } from '../dto/settlement-run-query.dto';
import { SettlementMonitorService } from '../services/settlement-monitor.service';
import { SettlementQueueService } from '../services/settlement-queue.service';
import { BetLabSettlementService } from '../services/bet-lab-settlement.service';
import { ManualBetLabLegSettlementDto } from '../dto/manual-bet-lab-leg-settlement.dto';
import { OverdueBetLabLegsQueryDto } from '../dto/overdue-bet-lab-legs-query.dto';
import { ManualPredictionSelectionSettlementDto } from '../dto/manual-prediction-selection-settlement.dto';
import { PredictionSettlementService } from '../services/prediction-settlement.service';

@Controller('settlement/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class SettlementAdminController {
  constructor(
    private readonly monitor: SettlementMonitorService,
    private readonly queue: SettlementQueueService,
    private readonly betLabSettlement: BetLabSettlementService,
    private readonly predictionSettlement: PredictionSettlementService,
  ) {}

  @Get('monitor')
  getMonitor() {
    return this.monitor.getOverview();
  }

  @Get('jobs')
  getJobs(@Query() query: SettlementJobQueryDto) {
    return this.monitor.getJobs(query);
  }

  @Get('runs')
  getRuns(@Query() query: SettlementRunQueryDto) {
    return this.monitor.getRuns(query);
  }

  @Get('events')
  getEvents(@Query() query: SettlementEventQueryDto) {
    return this.monitor.getEvents(query);
  }

  @Post('fixtures/:eventId/requeue')
  async requeueFixture(
    @Param('eventId') eventId: string,
    @Query('leagueId') leagueId?: string,
  ) {
    const result = await this.queue.requeueFinishedFixture(eventId, leagueId);
    if (!result.queued) {
      return { success: false, ...result };
    }
    return { success: true, ...result };
  }

  @Post(
    'predictions/markets/:marketPredictionId/selections/:selectionKey/manual-settlement',
  )
  manualSettlePredictionSelection(
    @Param('marketPredictionId') marketPredictionId: string,
    @Param('selectionKey') selectionKey: string,
    @Body() dto: ManualPredictionSelectionSettlementDto,
    @Req() request: any,
  ) {
    const user = request?.user ?? {};
    const adminId = String(
      user.sub ?? user.id ?? user._id ?? user.email ?? '',
    ).trim();
    return this.predictionSettlement.manuallySettleSelection({
      marketPredictionId,
      selectionKey,
      outcome: dto.outcome,
      reason: dto.reason,
      adminId: adminId || undefined,
    });
  }

  @Get('bet-lab/overdue-legs')
  getOverdueBetLabLegs(@Query() query: OverdueBetLabLegsQueryDto) {
    return this.betLabSettlement.listOverdueOpenLegs(query);
  }

  @Post('bet-lab/tickets/:ticketId/legs/:legId/manual-settlement')
  manualSettleBetLabLeg(
    @Param('ticketId') ticketId: string,
    @Param('legId') legId: string,
    @Body() dto: ManualBetLabLegSettlementDto,
    @Req() request: any,
  ) {
    const user = request?.user ?? {};
    const adminId = String(
      user.sub ?? user.id ?? user._id ?? user.email ?? '',
    ).trim();
    return this.betLabSettlement.manuallySettleLeg({
      ticketId,
      legId,
      outcome: dto.outcome,
      reason: dto.reason,
      adminId: adminId || undefined,
    });
  }
}
