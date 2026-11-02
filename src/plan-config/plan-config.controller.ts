import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';

import { PlanConfigService } from './plan-config.service';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('plan-config')
export class PlanConfigController {
  constructor(private readonly service: PlanConfigService) {}

  // PUBLIC (frontend reads pricing + bank details)
  @Get()
  get() {
    return this.service.get();
  }

  // ADMIN ONLY
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch()
  update(@Body() body: unknown) {
    return this.service.update(body);
  }
}

