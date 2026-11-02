import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from './schemas/user.schema';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { UserSessionModule } from '../user-session/user-session.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: User.name,
        schema: UserSchema,
      },
    ]),
    UserSessionModule,
  ],
  controllers: [UsersController],
  providers: [
    UsersService,
    JwtAuthGuard,
  ],
  exports: [UsersService],
})
export class UsersModule {}

