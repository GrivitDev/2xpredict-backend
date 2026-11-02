import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { BonusesService } from '../bonuses.service';
import { GrantPointsBonusDto } from '../dto/grant-points-bonus.dto';
import { GrantSubscriptionBonusDto } from '../dto/grant-subscription-bonus.dto';
import { RevokeBonusDto } from '../dto/revoke-bonus.dto';
import { BonusQueryDto } from '../dto/bonus-query.dto';
import { BulkGrantPointsBonusDto } from '../dto/bulk-grant-points-bonus.dto';
import { BulkGrantSubscriptionBonusDto } from '../dto/bulk-grant-subscription-bonus.dto';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

class BonusRecipientsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsString() search?: string;
}

@Controller('admin/bonuses')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class BonusesAdminController {
  constructor(private readonly bonusesService: BonusesService) {}

  @Post('points')
  grantPoints(@Body() dto: GrantPointsBonusDto, @GetUser() admin: { _id: string }) {
    return this.bonusesService.grantPoints(dto, admin._id);
  }

  @Post('subscription')
  grantSubscription(@Body() dto: GrantSubscriptionBonusDto, @GetUser() admin: { _id: string }) {
    return this.bonusesService.grantSubscription(dto, admin._id);
  }

  /** Queues a durable, throttled points grant for all active and pending accounts. */
  @Post('points/all')
  grantPointsToAll(@Body() dto: BulkGrantPointsBonusDto, @GetUser() admin: { _id: string }) {
    return this.bonusesService.grantPointsToAll(dto, admin._id);
  }

  /** Queues a durable subscription entitlement grant for all active and pending accounts. */
  @Post('subscription/all')
  grantSubscriptionToAll(@Body() dto: BulkGrantSubscriptionBonusDto, @GetUser() admin: { _id: string }) {
    return this.bonusesService.grantSubscriptionToAll(dto, admin._id);
  }

  @Get('recipients')
  listRecipients(@Query() query: BonusRecipientsQueryDto) {
    return this.bonusesService.getAdminBonusRecipients(query);
  }

  @Get('bulk-jobs')
  listBulkGrantJobs(@Query('limit') limit?: string) {
    return this.bonusesService.getBulkGrantJobs(limit ? Number(limit) : undefined);
  }

  @Get('bulk-jobs/:id')
  getBulkGrantJob(@Param('id') id: string) {
    return this.bonusesService.getBulkGrantJob(id);
  }

  @Get()
  list(@Query() query: BonusQueryDto) {
    return this.bonusesService.getAdminBonuses(query);
  }

  @Patch(':id/revoke')
  revoke(
    @Param('id') id: string,
    @Body() dto: RevokeBonusDto,
    @GetUser() admin: { _id: string },
  ) {
    return this.bonusesService.revokeBonus(id, admin._id, dto.reason);
  }
}
