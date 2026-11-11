import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { OtpService } from './otp.service';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';

@Controller('otp')
export class OtpController {
  constructor(private readonly otpService: OtpService) {}

  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 6, ttl: 5 * 60 * 1000 } })
  @Post('verify')
  verifyOtp(@Body() verifyOtpDto: VerifyOtpDto) {
    return this.otpService.verifyOtp(verifyOtpDto);
  }

  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 3, ttl: 15 * 60 * 1000 } })
  @Post('resend')
  resendOtp(@Body() resendOtpDto: ResendOtpDto) {
    return this.otpService.resendOtp(resendOtpDto);
  }
}
