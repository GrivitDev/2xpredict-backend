import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { GetUser } from '../common/decorators/get-user.decorator';
import { AdminUsersService } from './admin-users.service';
import { AdminUserQueryDto } from './dto/admin-user-query.dto';
import { SuspendUserDto } from './dto/suspend-user.dto';

@Controller('admin/users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Get()
  getUsers(@Query() query: AdminUserQueryDto) {
    return this.adminUsersService.getUsers(query);
  }

  @Get(':id/details')
  getUserDetails(@Param('id') id: string) {
    this.assertObjectId(id);
    return this.adminUsersService.getUserDetails(id);
  }

  @Get(':id/payments')
  getPaymentHistory(@Param('id') id: string, @Query() query: AdminUserQueryDto) {
    this.assertObjectId(id);
    return this.adminUsersService.getPaymentHistory(id, query.page, query.limit);
  }

  @Get(':id/subscriptions')
  getSubscriptionHistory(@Param('id') id: string, @Query() query: AdminUserQueryDto) {
    this.assertObjectId(id);
    return this.adminUsersService.getSubscriptionHistory(id, query.page, query.limit);
  }

  @Get(':id/bet-lab/tickets')
  getBetLabTickets(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    this.assertObjectId(id);
    return this.adminUsersService.getBetLabTickets(id, page, limit, status);
  }

  @Get(':id/bet-lab/ledger')
  getBetLabLedger(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    this.assertObjectId(id);
    return this.adminUsersService.getBetLabLedger(id, page, limit);
  }

  @Get(':id/referrals')
  getReferrals(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    this.assertObjectId(id);
    return this.adminUsersService.getReferrals(id, page, limit);
  }

  @Get(':id/promotions/rewards')
  getPromotionRewards(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    this.assertObjectId(id);
    return this.adminUsersService.getPromotionRewards(id, page, limit);
  }

  @Get(':id/bonuses')
  getBonuses(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    this.assertObjectId(id);
    return this.adminUsersService.getBonuses(id, page, limit);
  }

  @Get(':id/audit')
  getAuditHistory(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    this.assertObjectId(id);
    return this.adminUsersService.getAuditHistory(id, Number(page) || 1, Number(limit) || 20);
  }

  @Patch(':id/suspend')
  suspend(
    @Param('id') id: string,
    @Body() body: SuspendUserDto,
    @GetUser() admin: { _id: string },
  ) {
    this.assertObjectId(id);
    return this.adminUsersService.suspendUser(id, body, admin._id);
  }

  @Patch(':id/activate')
  activate(@Param('id') id: string, @GetUser() admin: { _id: string }) {
    this.assertObjectId(id);
    return this.adminUsersService.activateUser(id, admin._id);
  }

  @Patch(':id/delete')
  delete(@Param('id') id: string, @GetUser() admin: { _id: string }) {
    this.assertObjectId(id);
    return this.adminUsersService.deleteUser(id, admin._id);
  }

  @Patch(':id/logout-all')
  logoutAll(@Param('id') id: string, @GetUser() admin: { _id: string }) {
    this.assertObjectId(id);
    return this.adminUsersService.logoutAll(id, admin._id);
  }

  @Get(':id/sessions')
  getUserSessions(@Param('id') id: string) {
    this.assertObjectId(id);
    return this.adminUsersService.getUserSessions(id);
  }

  @Patch(':id/sessions/:sessionId/revoke')
  revokeSession(
    @Param('id') userId: string,
    @Param('sessionId') sessionId: string,
    @GetUser() admin: { _id: string },
  ) {
    this.assertObjectId(userId);
    this.assertObjectId(sessionId);
    return this.adminUsersService.revokeSession(sessionId, userId, admin._id);
  }

  private assertObjectId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid user ID.');
    }
  }
}
