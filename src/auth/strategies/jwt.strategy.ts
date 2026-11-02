import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

import { UsersService } from '../../users/users.service';
import { UserSessionService } from '../../user-session/user-session.service';
import { UserStatus } from '../../users/schemas/user.schema';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
    private userSessionService: UserSessionService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: any) {
    // 1. Validate user exists
    const user = await this.usersService.findById(payload.userId);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // 2. Basic account checks
    if (user.isDeleted) {
      throw new UnauthorizedException('Account deleted');
    }

    const allowedStatus =
      user.status === UserStatus.ACTIVE ||
      (!user.isVerified && user.status === UserStatus.PENDING);
    if (!allowedStatus) {
      throw new UnauthorizedException('Account not active');
    }

    // 3. SESSION CHECK
    if (payload.sessionId) {
      const session = await this.userSessionService.findSessionById(
        payload.sessionId,
      );

      if (!session || !session.isActive) {
        throw new UnauthorizedException('Session expired');
      }

      await this.userSessionService.updateActivity(payload.sessionId);
    }

    // 4. Return authenticated user
    return {
      _id: user._id.toString(),

      fullName: user.fullName,

      username: user.username,

      email: user.email,

      role: user.role,

      country: user.country,

      countryCode: user.countryCode,

      currency: user.currency,

      isVerified: user.isVerified,

      status: user.status,

      sessionId: payload.sessionId,
    };
  }
}
