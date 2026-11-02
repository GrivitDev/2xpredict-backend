import { Module } from '@nestjs/common';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { MongooseModule } from '@nestjs/mongoose';

import { PlanConfigService } from './plan-config.service';
import { PlanConfigController } from './plan-config.controller';

import { PlanConfig, PlanConfigSchema } from './schemas/plan-config.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PlanConfig.name, schema: PlanConfigSchema },
    ]),
  ],
  controllers: [PlanConfigController],
  providers: [
    PlanConfigService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [PlanConfigService],
})
export class PlanConfigModule {}

