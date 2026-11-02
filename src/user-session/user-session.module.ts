import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { MongooseModule } from '@nestjs/mongoose';

import { UserSession, UserSessionSchema } from './schemas/user-session.schema';

import { UserSessionService } from './user-session.service';
import { UserSessionController } from './user-session.controller';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: UserSession.name,
        schema: UserSessionSchema,
      },
    ]),
    CommonModule,
  ],
  providers: [
    UserSessionService,
    JwtAuthGuard,
  ],
  controllers: [UserSessionController],
  exports: [UserSessionService],
})
export class UserSessionModule {}

