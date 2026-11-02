import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomInt } from 'node:crypto';
import { Model } from 'mongoose';
import { Otp, OtpPurpose } from './schemas/otp.schema';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { UsersService } from '../users/users.service';
import { EmailService } from '../notifications/email.service';
import { TelegramService } from '../telegram/telegram.service';
import { ReferralsService } from '../referrals/referrals.service';
import { PromoEngineService } from '../promos/promo-engine.service';

const OTP_TTL_MS = 20 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

@Injectable()
export class OtpService {
  constructor(
    @InjectModel(Otp.name)
    private readonly otpModel: Model<Otp>,
    private readonly usersService: UsersService,
    private readonly emailService: EmailService,
    private readonly telegramService: TelegramService,
    private readonly referralsService: ReferralsService,
    private readonly promoEngineService: PromoEngineService,
  ) {}

  private generateOtp(): string {
    return randomInt(100000, 1000000).toString();
  }

  async createOtp(email: string) {
    return this.createPurposeOtp(email, OtpPurpose.ACCOUNT_VERIFICATION);
  }

  private async createPurposeOtp(
    email: string,
    purpose: OtpPurpose,
    options: { userId?: string; targetEmail?: string } = {},
  ) {
    const normalizedEmail = email.trim().toLowerCase();
    const scopedFilter = {
      email: normalizedEmail,
      purpose,
      ...(options.userId ? { userId: options.userId } : {}),
    };
    const existingOtp = await this.otpModel
      .findOne(scopedFilter)
      .sort({ createdAt: -1 })
      .exec();

    if (existingOtp && Date.now() - existingOtp.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      throw new BadRequestException('Please wait before requesting another OTP.');
    }

    await this.otpModel.deleteMany(scopedFilter).exec();
    const otpCode = this.generateOtp();
    await this.otpModel.create({
      email: normalizedEmail,
      code: otpCode,
      purpose,
      ...(options.userId ? { userId: options.userId } : {}),
      ...(options.targetEmail ? { targetEmail: options.targetEmail.trim().toLowerCase() } : {}),
    });

    await this.emailService.sendOtpEmail(normalizedEmail, otpCode);
    return { message: 'OTP sent successfully.' };
  }

  async verifyOtp(verifyOtpDto: VerifyOtpDto) {
    const normalizedEmail = verifyOtpDto.email.trim().toLowerCase();
    const otp = await this.otpModel.findOne({
      email: normalizedEmail,
      code: verifyOtpDto.code,
      purpose: OtpPurpose.ACCOUNT_VERIFICATION,
      createdAt: { $gt: new Date(Date.now() - OTP_TTL_MS) },
    }).exec();
    if (!otp) throw new BadRequestException('Invalid or expired OTP.');

    const pendingUser = await this.usersService.findByEmail(normalizedEmail);
    const pendingPromoCode = pendingUser?.pendingPromoCode;
    const user = await this.usersService.verifyUser(normalizedEmail);
    if (!user) throw new BadRequestException('Account could not be verified. Please request a new OTP.');

    await this.otpModel.deleteMany({ email: normalizedEmail, purpose: OtpPurpose.ACCOUNT_VERIFICATION }).exec();
    await this.completeFirstVerification(user, pendingPromoCode);
    return { message: 'Account verified successfully.' };
  }

  async resendOtp(resendOtpDto: ResendOtpDto) {
    const email = resendOtpDto.email.trim().toLowerCase();
    const user = await this.usersService.findByEmail(email);
    if (!user) throw new NotFoundException('User not found.');
    if (user.isVerified) throw new BadRequestException('Account is already verified.');

    // Unverified accounts do not expire: users can log in, update their email,
    // and request a fresh OTP until verification is completed.
    return this.createOtp(email);
  }

  async createEmailChangeIdentityOtp(userId: string, currentEmail: string, targetEmail: string) {
    const normalizedCurrent = currentEmail.trim().toLowerCase();
    const normalizedTarget = targetEmail.trim().toLowerCase();
    if (normalizedCurrent === normalizedTarget) {
      throw new BadRequestException('The new email must differ from the current email.');
    }

    await this.createPurposeOtp(normalizedCurrent, OtpPurpose.EMAIL_CHANGE_CURRENT, {
      userId,
      targetEmail: normalizedTarget,
    });
    // Invalidate an old second-stage code only after the current-address code
    // was successfully issued and passed the resend cooldown.
    await this.otpModel.deleteMany({ userId, purpose: OtpPurpose.EMAIL_CHANGE_NEW }).exec();
    return { message: 'A verification code was sent to your current email address.' };
  }

  async verifyEmailChangeIdentity(userId: string, code: string) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException('Account not found.');

    const otp = await this.otpModel.findOne({
      userId,
      email: user.email.trim().toLowerCase(),
      code,
      purpose: OtpPurpose.EMAIL_CHANGE_CURRENT,
      createdAt: { $gt: new Date(Date.now() - OTP_TTL_MS) },
    }).exec();
    if (!otp?.targetEmail) throw new BadRequestException('Invalid or expired identity verification code.');

    const targetEmail = otp.targetEmail.trim().toLowerCase();
    const existing = await this.usersService.findByEmail(targetEmail);
    if (existing && String(existing._id) !== String(user._id)) {
      await this.otpModel.deleteMany({ userId, purpose: { $in: [OtpPurpose.EMAIL_CHANGE_CURRENT, OtpPurpose.EMAIL_CHANGE_NEW] } }).exec();
      throw new ConflictException('The requested email address is already in use. Start the email-change process again.');
    }

    await this.createPurposeOtp(targetEmail, OtpPurpose.EMAIL_CHANGE_NEW, {
      userId,
      targetEmail,
    });
    await this.otpModel.deleteMany({ userId, purpose: OtpPurpose.EMAIL_CHANGE_CURRENT }).exec();
    return { message: 'Your identity is verified. A second code was sent to the new email address.' };
  }

  async verifyEmailChangeNewEmail(userId: string, code: string) {
    const otp = await this.otpModel.findOne({
      userId,
      code,
      purpose: OtpPurpose.EMAIL_CHANGE_NEW,
      createdAt: { $gt: new Date(Date.now() - OTP_TTL_MS) },
    }).sort({ createdAt: -1 }).exec();
    if (!otp?.targetEmail) throw new BadRequestException('Invalid or expired new-email verification code.');

    const targetEmail = otp.targetEmail.trim().toLowerCase();
    const currentUser = await this.usersService.findById(userId);
    if (!currentUser) throw new NotFoundException('Account not found.');

    const existing = await this.usersService.findByEmail(targetEmail);
    if (existing && String(existing._id) !== String(currentUser._id)) {
      throw new ConflictException('The new email address is already in use.');
    }

    const wasVerified = currentUser.isVerified;
    const pendingPromoCode = currentUser.pendingPromoCode;
    let updatedUser: Awaited<ReturnType<UsersService['changeEmailAndVerify']>>;
    try {
      updatedUser = await this.usersService.changeEmailAndVerify(userId, targetEmail);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 11000) {
        throw new ConflictException('The new email address is already in use.');
      }
      throw error;
    }
    if (!updatedUser) throw new NotFoundException('Account could not be updated.');

    if (!wasVerified) {
      if (updatedUser.referredBy) {
        await this.referralsService.createReferral(String(updatedUser.referredBy), String(updatedUser._id));
      }
      if (pendingPromoCode) {
        await this.promoEngineService.joinDirectCampaign(pendingPromoCode, String(updatedUser._id));
      }
      await this.emailService.sendWelcomeEmail({ email: updatedUser.email, fullName: updatedUser.fullName });
      await this.telegramService.notifyNewUser({
        fullName: updatedUser.fullName,
        username: updatedUser.username,
        email: updatedUser.email,
        phoneNumber: updatedUser.phoneNumber,
        referred: Boolean(updatedUser.referredBy),
      });
      await this.usersService.clearPendingPromoCode(userId);
    }

    await this.otpModel.deleteMany({
      userId,
      purpose: { $in: [OtpPurpose.EMAIL_CHANGE_CURRENT, OtpPurpose.EMAIL_CHANGE_NEW] },
    }).exec();

    return {
      message: 'Email changed and verified successfully.',
      email: updatedUser.email,
      isVerified: true,
    };
  }

  private async completeFirstVerification(
    user: { _id: unknown; email: string; fullName: string; username: string; phoneNumber?: string; referredBy?: string },
    pendingPromoCode?: string,
  ) {
    if (user.referredBy) {
      await this.referralsService.createReferral(String(user.referredBy), String(user._id));
    }
    if (pendingPromoCode) {
      await this.promoEngineService.joinDirectCampaign(pendingPromoCode, String(user._id));
    }
    await this.emailService.sendWelcomeEmail({ email: user.email, fullName: user.fullName });
    await this.telegramService.notifyNewUser({
      fullName: user.fullName,
      username: user.username,
      email: user.email,
      phoneNumber: user.phoneNumber ?? '',
      referred: Boolean(user.referredBy),
    });
  }
}
