import { Module } from '@nestjs/common';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

@Module({
  controllers: [UploadsController],

  providers: [UploadsService, JwtAuthGuard, RolesGuard],

  exports: [UploadsService],
})
export class UploadsModule {}
