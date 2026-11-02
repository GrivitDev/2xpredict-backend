import { Body, Controller, Get, Post, UseGuards, Req } from '@nestjs/common';

import type { Request } from 'express';

import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RequestEmailChangeDto } from './dto/request-email-change.dto';
import { VerifyEmailChangeDto } from './dto/verify-email-change.dto';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { GetUser } from '../common/decorators/get-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ======================
  // REGISTER
  // ======================
  @Post('register')
  register(@Body() registerDto: RegisterDto, @Req() req: Request) {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.ip ||
      req.socket.remoteAddress ||
      '';

    return this.authService.register(registerDto, ip.toString());
  }

  // ======================
  // LOGIN (SESSION ENABLED)
  // ======================
  @Post('login')
  login(@Body() loginDto: LoginDto, @Req() req: Request) {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.ip ||
      req.socket.remoteAddress ||
      '';

    const userAgent = req.headers['user-agent'] || '';

    return this.authService.login(loginDto, ip.toString(), userAgent);
  }

  // ======================
  // CURRENT USER
  // ======================
  @UseGuards(JwtAuthGuard)
  @Get('me')
  getCurrentUser(@GetUser() user: any) {
    return user;
  }

  // ======================
  // PASSWORD RESET REQUEST
  // ======================
  @Post('request-password-reset')
  requestPasswordReset(@Body('email') email: string) {
    return this.authService.requestPasswordReset(email);
  }

  // ======================
  // RESET PASSWORD
  // ======================
  @Post('reset-password')
  resetPassword(
    @Body()
    body: {
      email: string;
      token: string;
      newPassword: string;
    },
  ) {
    return this.authService.resetPassword(
      body.email,
      body.token,
      body.newPassword,
    );
  }
  @UseGuards(JwtAuthGuard)
  @Post('email-change/request')
  requestEmailChange(
    @GetUser() user: { _id: string },
    @Body() dto: RequestEmailChangeDto,
  ) {
    return this.authService.requestEmailChange(user._id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('email-change/verify-current')
  verifyCurrentEmailForChange(
    @GetUser() user: { _id: string },
    @Body() dto: VerifyEmailChangeDto,
  ) {
    return this.authService.verifyEmailChangeIdentity(user._id, dto.code);
  }

  @UseGuards(JwtAuthGuard)
  @Post('email-change/verify-new')
  verifyNewEmailForChange(
    @GetUser() user: { _id: string },
    @Body() dto: VerifyEmailChangeDto,
  ) {
    return this.authService.verifyNewEmail(user._id, dto.code);
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  changePassword(
    @GetUser() user: any,
    @Body()
    body: {
      currentPassword: string;
      newPassword: string;
    },
  ) {
    return this.authService.changePassword(
      user._id,
      body.currentPassword,
      body.newPassword,
    );
  }
}
