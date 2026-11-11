import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

@Module({
  imports: [ConfigModule],
  controllers: [UploadsController],
  providers: [
    adminRealtimeRegistrationProvider(
      'uploads',
      'Media upload integration: Cloudinary upload and deletion operations; provider credentials are checked when an operation is requested.',
    ),
    UploadsService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [UploadsService],
})
export class UploadsModule {}
