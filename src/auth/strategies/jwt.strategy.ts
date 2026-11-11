import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

import { UsersService } from '../../users/users.service';
import { UserSessionService } from '../../user-session/user-session.service';
import { UserStatus } from '../../users/schemas/user.schema';

interface AuthTokenPayload {
  userId: string;
  sessionId?: string;
  authVersion?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
    private readonly userSessionService: UserSessionService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: AuthTokenPayload) {
    const user = await this.usersService.findByIdForAuth(payload.userId);
    if (!user) throw new UnauthorizedException('User not found.');

    if (user.isDeleted || user.status === UserStatus.DELETED) {
      throw new UnauthorizedException('Account deleted.');
    }

    const allowedStatus =
      user.status === UserStatus.ACTIVE ||
      (!user.isVerified && user.status === UserStatus.PENDING);
    if (!allowedStatus) {
      throw new UnauthorizedException('Account not active.');
    }

    // Older tokens without this claim are treated as version zero. Password
    // changes increment the persisted version and invalidate every old token.
    const tokenVersion = Number(payload.authVersion ?? 0);
    const currentVersion = Number(user.authVersion ?? 0);
    if (!Number.isSafeInteger(tokenVersion) || tokenVersion !== currentVersion) {
      throw new UnauthorizedException('Session is no longer valid.');
    }

    // All current login flows create a server-side session. Requiring the
    // session claim prevents legacy stateless tokens from bypassing revocation.
    if (!payload.sessionId) {
      throw new UnauthorizedException('Session is no longer valid.');
    }

    const session = await this.userSessionService.findSessionById(payload.sessionId);
    if (!session || !session.isActive || String(session.userId) !== String(user._id)) {
      throw new UnauthorizedException('Session expired.');
    }

    await this.userSessionService.updateActivity(payload.sessionId);

    return {
      _id: String(user._id),
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
