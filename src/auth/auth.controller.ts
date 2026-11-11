import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RequestEmailChangeDto } from './dto/request-email-change.dto';
import { VerifyEmailChangeDto } from './dto/verify-email-change.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { GetUser } from '../common/decorators/get-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60 * 60 * 1000 } })
  @Post('register')
  register(@Body() registerDto: RegisterDto, @Req() req: Request) {
    const ip = req.ip || req.socket.remoteAddress || '';

    return this.authService.register(registerDto, ip.toString());
  }

  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 15 * 60 * 1000 } })
  @Post('login')
  login(@Body() loginDto: LoginDto, @Req() req: Request) {
    const ip = req.ip || req.socket.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';

    return this.authService.login(loginDto, ip.toString(), userAgent);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  getCurrentUser(@GetUser() user: unknown) {
    return user;
  }

  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 3, ttl: 15 * 60 * 1000 } })
  @Post('request-password-reset')
  requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
    return this.authService.requestPasswordReset(dto.email);
  }

  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 8, ttl: 15 * 60 * 1000 } })
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(
      dto.email,
      dto.token,
      dto.newPassword,
    );
  }

  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 15 * 60 * 1000 } })
  @Post('email-change/request')
  requestEmailChange(
    @GetUser() user: { _id: string },
    @Body() dto: RequestEmailChangeDto,
  ) {
    return this.authService.requestEmailChange(user._id, dto);
  }

  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 8, ttl: 15 * 60 * 1000 } })
  @Post('email-change/verify-current')
  verifyCurrentEmailForChange(
    @GetUser() user: { _id: string },
    @Body() dto: VerifyEmailChangeDto,
  ) {
    return this.authService.verifyEmailChangeIdentity(user._id, dto.code);
  }

  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 8, ttl: 15 * 60 * 1000 } })
  @Post('email-change/verify-new')
  verifyNewEmailForChange(
    @GetUser() user: { _id: string },
    @Body() dto: VerifyEmailChangeDto,
  ) {
    return this.authService.verifyNewEmail(user._id, dto.code);
  }

  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 15 * 60 * 1000 } })
  @Post('change-password')
  changePassword(
    @GetUser() user: { _id: string },
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(
      user._id,
      dto.currentPassword,
      dto.newPassword,
    );
  }
}
