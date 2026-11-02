import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { BonusesService } from '../bonuses.service';

@Controller('bonuses')
@UseGuards(JwtAuthGuard)
export class BonusesController {
  constructor(private readonly bonusesService: BonusesService) {}

  @Get('my')
  getMyBonuses(
    @GetUser() user: { _id: string },
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.bonusesService.getMyBonuses(
      user._id,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }
}
