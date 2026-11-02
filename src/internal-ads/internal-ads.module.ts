import { Module } from '@nestjs/common';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

import { MongooseModule } from '@nestjs/mongoose';

import { InternalAdsController } from './internal-ads.controller';
import { InternalAdsService } from './internal-ads.service';

import { InternalAd, InternalAdSchema } from './schemas/internal-ad.schema';

import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: InternalAd.name,
        schema: InternalAdSchema,
      },
    ]),

    UploadsModule,
  ],

  controllers: [InternalAdsController],

  providers: [
    InternalAdsService,
    JwtAuthGuard,
    RolesGuard,
  ],

  exports: [InternalAdsService],
})
export class InternalAdsModule {}

