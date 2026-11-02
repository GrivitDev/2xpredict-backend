import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module';
import { UserSessionModule } from '../user-session/user-session.module';
import { AdminGateway } from './admin.gateway';

@Global()
@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
    UsersModule,
    UserSessionModule,
  ],
  providers: [AdminGateway],
  exports: [AdminGateway],
})
export class RealtimeModule {}

