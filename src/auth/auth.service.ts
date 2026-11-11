import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'node:crypto';

import { UsersService } from '../users/users.service';
import { UserSessionService } from '../user-session/user-session.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RequestEmailChangeDto } from './dto/request-email-change.dto';
import { OtpService } from '../otp/otp.service';
import { NotificationEmailDeliveryService } from '../notifications/email-delivery/email-delivery.service';
import { EmailDeliveryTemplate } from '../notifications/email-delivery/schemas/email-delivery.schema';
import { PromosService } from '../promos/promos.service';
import { UserStatus } from '../users/schemas/user.schema';
import { GeoLocationService } from '../common/services/geo-location.service';
import { NotificationEventsService } from '../notifications/in-app/notification-events.service';
import { assertPasswordPolicy } from './password-policy.util';

const BCRYPT_ROUNDS = 12;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const PASSWORD_RESET_RESPONSE =
  'If an account exists for that email address, password reset instructions have been sent.';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly userSessionService: UserSessionService,
    private readonly jwtService: JwtService,
    private readonly otpService: OtpService,
    private readonly emailDelivery: NotificationEmailDeliveryService,
    private readonly notificationEvents: NotificationEventsService,
    private readonly promosService: PromosService,
    private readonly geoLocationService: GeoLocationService,
    private readonly configService: ConfigService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async register(registerDto: RegisterDto, ip?: string) {
    assertPasswordPolicy(registerDto.password);

    const fullName = registerDto.fullName.trim();
    const normalizedUsername = registerDto.username.trim().toLowerCase();
    const normalizedEmail = registerDto.email.trim().toLowerCase();
    const phoneNumber = registerDto.phoneNumber.trim();

    if (await this.usersService.findByEmail(normalizedEmail)) {
      throw new ConflictException('Email already exists.');
    }
    if (await this.usersService.findByUsername(normalizedUsername)) {
      throw new ConflictException('Username already exists.');
    }

    const hashedPassword = await bcrypt.hash(registerDto.password, BCRYPT_ROUNDS);
    let referredBy: string | undefined;

    if (registerDto.referralCode) {
      const normalizedReferralCode = registerDto.referralCode.trim().toLowerCase();
      const referrer = await this.usersService.findByUsername(normalizedReferralCode);

      if (!referrer) {
        throw new BadRequestException('Invalid referral code.');
      }
      if (referrer.username === normalizedUsername) {
        throw new BadRequestException('You cannot use your own referral code.');
      }
      referredBy = String(referrer._id);
    }

    const promoCode = registerDto.promoCode?.trim();
    if (promoCode) {
      const promo = await this.promosService.findActivePromoByCode(promoCode);
      if (!promo) {
        throw new BadRequestException('Invalid or expired promo code.');
      }
    }

    const location = await this.geoLocationService.lookup(ip || '');
    const country = location?.country || '';
    const countryCode = location?.countryCode || '';
    const currency = countryCode === 'NG' ? 'NGN' : 'USD';

    let user: Awaited<ReturnType<UsersService['create']>>;
    try {
      user = await this.usersService.create({
        fullName,
        username: normalizedUsername,
        phoneNumber,
        email: normalizedEmail,
        password: hashedPassword,
        country,
        countryCode,
        currency,
        referredBy,
        pendingPromoCode: promoCode,
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw new ConflictException('Email or username already exists.');
      }
      throw error;
    }

    const otpResult = await this.otpService.createOtp(
      user.email,
      String(user._id),
    );

    return {
      message: otpResult.message.startsWith('Verification email queued')
        ? 'Registration successful. Your verification email has been queued.'
        : 'Registration successful. The verification code was created, but its email could not be queued. Please request a new code if it does not arrive.',
    };
  }

  async login(loginDto: LoginDto, ip?: string, userAgent?: string) {
    const normalizedEmail = loginDto.email.trim().toLowerCase();
    const user = await this.usersService.findByEmailWithPassword(normalizedEmail);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const now = new Date();
    if (user.loginLockedUntil && user.loginLockedUntil > now) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const passwordMatches = await this.comparePassword(loginDto.password, user.password);
    if (!passwordMatches) {
      await this.usersService.recordLoginFailure(String(user._id));
      throw new UnauthorizedException('Invalid credentials.');
    }

    if (user.isDeleted || user.status === UserStatus.DELETED) {
      throw new UnauthorizedException('Account has been deleted.');
    }

    // Unverified registrations remain PENDING and may authenticate so users
    // can browse and complete email verification later.
    const allowedStatus =
      user.status === UserStatus.ACTIVE ||
      (!user.isVerified && user.status === UserStatus.PENDING);
    if (!allowedStatus) {
      throw new UnauthorizedException('Account is not active.');
    }

    if (user.bannedUntil && user.bannedUntil > now) {
      throw new UnauthorizedException('Account is temporarily banned.');
    }

    const authVersion = Number(user.authVersion ?? 0);
    const loginUpdate = await this.usersService.updateLoginInfo(
      String(user._id),
      authVersion,
      user.password,
    );

    // This compare-and-update prevents a login that started with an old
    // password from creating a fresh session after a concurrent password reset.
    if (!loginUpdate) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    await this.userSessionService.cleanupUserSessions(String(user._id));
    const session = await this.userSessionService.createSession({
      userId: user._id,
      userAgent: userAgent || 'unknown',
      ipAddress: ip || 'unknown',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const token = this.jwtService.sign({
      userId: String(user._id),
      fullName: user.fullName,
      username: user.username,
      email: user.email,
      role: user.role,
      country: user.country,
      countryCode: user.countryCode,
      currency: user.currency,
      sessionId: String(session._id),
      authVersion,
    });

    return {
      message: 'Login successful',
      token,
      user: {
        id: String(user._id),
        fullName: user.fullName,
        username: user.username,
        email: user.email,
        role: user.role,
        country: user.country,
        countryCode: user.countryCode,
        currency: user.currency,
        isVerified: user.isVerified,
      },
    };
  }

  async requestEmailChange(userId: string, dto: RequestEmailChangeDto) {
    const user = await this.usersService.findByIdWithPassword(userId);
    if (!user) throw new UnauthorizedException('Account not found.');

    const passwordMatches = await this.comparePassword(dto.currentPassword, user.password);
    if (!passwordMatches) {
      throw new UnauthorizedException('Current password is incorrect.');
    }

    const newEmail = dto.newEmail.trim().toLowerCase();
    if (newEmail === user.email.trim().toLowerCase()) {
      throw new BadRequestException('The new email must be different from your current email.');
    }

    const existing = await this.usersService.findByEmail(newEmail);
    if (existing && String(existing._id) !== String(user._id)) {
      throw new ConflictException('This email address is already in use.');
    }

    return this.otpService.createEmailChangeIdentityOtp(
      String(user._id),
      user.email,
      newEmail,
    );
  }

  async verifyEmailChangeIdentity(userId: string, code: string) {
    return this.otpService.verifyEmailChangeIdentity(userId, code);
  }

  async verifyNewEmail(userId: string, code: string) {
    return this.otpService.verifyEmailChangeNewEmail(userId, code);
  }

  async requestPasswordReset(email: string) {
    if (typeof email !== 'string' || !email.trim()) {
      throw new BadRequestException('Enter a valid email address.');
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Do not reveal whether the account exists or whether its reset flow is locked.
    const now = new Date();
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashPasswordResetToken(rawToken);
    const user = await this.usersService.claimPasswordResetRequest(
      normalizedEmail,
      tokenHash,
      new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
      now,
      new Date(now.getTime() - 60_000),
    );
    if (!user) return { message: PASSWORD_RESET_RESPONSE };

    const frontendUrl = (
      this.configService.get<string>('FRONTEND_URL') || 'https://www.2xpredict.com'
    ).replace(/\/$/, '');
    const resetLink =
      `${frontendUrl}/reset-password` +
      `?email=${encodeURIComponent(user.email)}` +
      `&token=${encodeURIComponent(rawToken)}`;

    const resetRequestKey = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex')
      .slice(0, 24);

    try {
      await this.emailDelivery.cancelPendingForUser(
        String(user._id),
        EmailDeliveryTemplate.PASSWORD_RESET,
        'Superseded by a newer password-reset request.',
      );
      await this.emailDelivery.enqueuePasswordReset({
        recipientId: String(user._id),
        email: user.email,
        resetLink,
        dedupeKey: `password-reset:${String(user._id)}:${resetRequestKey}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Password reset token was saved but its email could not be queued: ${message}`);
    }

    return { message: PASSWORD_RESET_RESPONSE };
  }

  async resetPassword(email: string, token: string, newPassword: string) {
    assertPasswordPolicy(newPassword);

    const user = await this.usersService.findByEmailForPasswordReset(email);
    if (!user || !user.passwordResetToken || !user.passwordResetExpires) {
      throw new BadRequestException('Invalid or expired reset request.');
    }

    const now = new Date();
    if (
      user.passwordResetExpires <= now ||
      (user.passwordResetLockedUntil && user.passwordResetLockedUntil > now)
    ) {
      throw new BadRequestException('Invalid or expired reset request.');
    }

    const storedTokenHash = user.passwordResetToken;
    const validToken = storedTokenHash.startsWith('$2')
      ? await bcrypt.compare(token, storedTokenHash) // legacy token compatibility during rollout
      : this.safeHexCompare(this.hashPasswordResetToken(token), storedTokenHash);

    if (!validToken) {
      await this.usersService.recordPasswordResetFailure(
        String(user._id),
        storedTokenHash,
      );
      throw new BadRequestException('Invalid or expired reset request.');
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const updatedUser = await this.usersService.consumePasswordResetToken(
          String(user._id),
          storedTokenHash,
          passwordHash,
          now,
          session,
        );
        if (!updatedUser) {
          throw new BadRequestException('Invalid or expired reset request.');
        }

        await this.userSessionService.deactivateAllUserSessions(
          String(user._id),
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    await this.notifyPasswordChangeSafely(String(user._id), 'PASSWORD_RESET');
    return {
      message: 'Password reset successful. Please login again on all devices.',
    };
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    assertPasswordPolicy(newPassword);

    const user = await this.usersService.findByIdWithPassword(userId);
    if (!user) throw new UnauthorizedException('Account not found.');

    const currentMatches = await this.comparePassword(currentPassword, user.password);
    if (!currentMatches) {
      throw new BadRequestException('Current password is incorrect.');
    }

    if (await this.comparePassword(newPassword, user.password)) {
      throw new BadRequestException('New password must be different from current password.');
    }

    const newPasswordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const updatedUser = await this.usersService.updatePasswordIfCurrent(
          userId,
          user.password,
          newPasswordHash,
          session,
        );
        if (!updatedUser) {
          throw new ConflictException('Your password changed during this request. Please sign in again.');
        }

        await this.userSessionService.deactivateAllUserSessions(userId, session);
      });
    } finally {
      await session.endSession();
    }

    await this.notifyPasswordChangeSafely(userId, 'PASSWORD_CHANGED');
    return {
      message: 'Password changed successfully. Please login again on all devices.',
    };
  }

  /**
   * bcrypt only authenticates the first 72 bytes. Explicitly applying the same
   * byte boundary preserves login for accounts created before this password
   * policy was introduced, including legacy multibyte input.
   */
  private comparePassword(input: string, passwordHash: string): Promise<boolean> {
    const bcryptInput = Buffer.from(input, 'utf8').subarray(0, 72);
    return bcrypt.compare(bcryptInput, passwordHash);
  }

  private hashPasswordResetToken(token: string): string {
    const secret = this.configService.get<string>('PASSWORD_RESET_TOKEN_SECRET')
      || this.configService.getOrThrow<string>('JWT_SECRET');
    return crypto.createHmac('sha256', secret).update(token).digest('hex');
  }

  private safeHexCompare(left: string, right: string): boolean {
    if (!/^[a-fA-F0-9]{64}$/.test(left) || !/^[a-fA-F0-9]{64}$/.test(right)) {
      return false;
    }
    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
  }

  private async notifyPasswordChangeSafely(
    userId: string,
    source: 'PASSWORD_RESET' | 'PASSWORD_CHANGED',
  ) {
    try {
      await this.notificationEvents.accountPasswordChanged({ userId, source });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Password changed successfully, but its notification could not be queued: ${message}`);
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 11000,
    );
  }
}
