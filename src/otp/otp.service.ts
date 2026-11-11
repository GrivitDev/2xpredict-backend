import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import { Model } from 'mongoose';

import { Otp, OtpDocument, OtpPurpose } from './schemas/otp.schema';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { UsersService } from '../users/users.service';
import { NotificationEmailDeliveryService } from '../notifications/email-delivery/email-delivery.service';
import { EmailDeliveryTemplate } from '../notifications/email-delivery/schemas/email-delivery.schema';
import { ReferralsService } from '../referrals/referrals.service';
import { PromoEngineService } from '../promos/promo-engine.service';
import { NotificationEventsService } from '../notifications/in-app/notification-events.service';

const OTP_TTL_MS = 20 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_PROCESSING_LEASE_MS = 5 * 60 * 1000;
const OTP_GENERIC_ERROR = 'Invalid, expired or already-used verification code.';
const RESEND_GENERIC_RESPONSE =
  'If an eligible unverified account exists, a verification code will be sent.';

@Injectable()
export class OtpService implements OnModuleInit {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    @InjectModel(Otp.name)
    private readonly otpModel: Model<Otp>,
    private readonly usersService: UsersService,
    private readonly emailDelivery: NotificationEmailDeliveryService,
    private readonly notificationEvents: NotificationEventsService,
    private readonly referralsService: ReferralsService,
    private readonly promoEngineService: PromoEngineService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    await this.otpModel.collection.createIndex(
      { activeKey: 1 },
      { unique: true, sparse: true, name: 'uniq_otp_active_key' },
    );
  }

  private generateOtp(): string {
    return randomInt(100000, 1000000).toString();
  }

  private hashOtp(code: string): string {
    const secret = this.configService.get<string>('OTP_HASH_SECRET')
      || this.configService.getOrThrow<string>('JWT_SECRET');
    return createHmac('sha256', secret).update(code).digest('hex');
  }

  private makeActiveKey(purpose: OtpPurpose, userId: string, email: string): string {
    const identity = userId || createHash('sha256').update(email).digest('hex').slice(0, 32);
    return `${purpose}:${identity}`;
  }

  async createOtp(email: string, userId?: string) {
    return this.createPurposeOtp(
      email,
      OtpPurpose.ACCOUNT_VERIFICATION,
      userId ? { userId } : {},
    );
  }

  private async createPurposeOtp(
    email: string,
    purpose: OtpPurpose,
    options: { userId?: string; targetEmail?: string } = {},
  ) {
    const normalizedEmail = email.trim().toLowerCase();
    const recipient = options.userId
      ? await this.usersService.findById(options.userId)
      : await this.usersService.findByEmail(normalizedEmail);
    const recipientId = recipient ? String(recipient._id) : '';
    if (!recipientId) throw new NotFoundException('Account not found for OTP delivery.');

    const activeKey = this.makeActiveKey(purpose, recipientId, normalizedEmail);
    const now = new Date();
    const cooldownCutoff = new Date(now.getTime() - OTP_RESEND_COOLDOWN_MS);
    const otpCode = this.generateOtp();
    const codeHash = this.hashOtp(otpCode);

    // Remove only pre-upgrade records. New records are protected by the unique
    // activeKey index and are replaced atomically after the resend cooldown.
    await this.otpModel.deleteMany({
      email: normalizedEmail,
      purpose,
      ...(options.userId ? { userId: options.userId } : {}),
      activeKey: { $exists: false },
    }).exec();

    let otpRecord: OtpDocument;
    try {
      // Release an expired-cooldown OTP's unique key, then insert a fresh
      // document. We do not rewrite createdAt because Mongoose treats the
      // timestamp as immutable and MongoDB TTL must start from the new issue.
      await this.otpModel.updateOne(
        {
          activeKey,
          createdAt: { $lte: cooldownCutoff },
          $or: [
            { processingUntil: { $exists: false } },
            { processingUntil: null },
            { processingUntil: { $lte: now } },
          ],
        },
        { $unset: { activeKey: 1 } },
      ).exec();

      const [created] = await this.otpModel.create([{
        activeKey,
        email: normalizedEmail,
        codeHash,
        purpose,
        userId: recipientId,
        ...(options.targetEmail
          ? { targetEmail: options.targetEmail.trim().toLowerCase() }
          : {}),
        attempts: 0,
        createdAt: now,
      }]);
      if (!created) throw new Error('OTP record could not be created.');
      otpRecord = created;
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw new BadRequestException('Please wait before requesting another verification code.');
      }
      throw error;
    }

    const otpScopeKey = `${purpose}:${createHash('sha256')
      .update(normalizedEmail)
      .digest('hex')
      .slice(0, 32)}`;

    let emailQueued = false;
    try {
      await this.emailDelivery.cancelPendingForUser(
        recipientId,
        EmailDeliveryTemplate.OTP,
        'Superseded by a newer OTP request.',
        otpScopeKey,
      );
      emailQueued = await this.emailDelivery.enqueueOtp({
        recipientId,
        email: normalizedEmail,
        otp: otpCode,
        dedupeKey: `otp:${String(otpRecord._id)}:${now.getTime()}`,
        scopeKey: otpScopeKey,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`OTP was stored but email delivery could not be queued: ${message}`);
    }

    return {
      message: emailQueued
        ? 'Verification email queued successfully.'
        : 'Verification code created, but email delivery could not be queued. Please request a new code if it does not arrive.',
    };
  }

  private async claimOtp(input: {
    email: string;
    userId: string;
    purpose: OtpPurpose;
    code: string;
  }): Promise<OtpDocument> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const activeKey = this.makeActiveKey(input.purpose, input.userId, normalizedEmail);
    const now = new Date();
    const otpHash = this.hashOtp(input.code);
    const processingToken = randomUUID();
    const processingUntil = new Date(now.getTime() + OTP_PROCESSING_LEASE_MS);
    const available = [
      {
        $or: [
          { processingUntil: { $exists: false } },
          { processingUntil: null },
          { processingUntil: { $lte: now } },
        ],
      },
      {
        $or: [
          { lockedUntil: { $exists: false } },
          { lockedUntil: null },
          { lockedUntil: { $lte: now } },
        ],
      },
    ];

    const claimed = await this.otpModel.findOneAndUpdate(
      {
        activeKey,
        codeHash: otpHash,
        createdAt: { $gt: new Date(now.getTime() - OTP_TTL_MS) },
        attempts: { $lt: OTP_MAX_ATTEMPTS },
        $and: available,
      },
      { $set: { processingUntil, processingToken } },
      { returnDocument: 'after' },
    ).exec();
    if (claimed) {
      claimed.processingToken = processingToken;
      return claimed;
    }

    // One-release compatibility: an OTP created before this deployment has a
    // plaintext `code` field and no activeKey. It can finish once, then all new
    // codes use HMAC digests and processing leases.
    const legacyScope = {
      ...(input.purpose === OtpPurpose.EMAIL_CHANGE_NEW ? {} : { email: normalizedEmail }),
      purpose: input.purpose,
      userId: input.userId,
      activeKey: { $exists: false },
      createdAt: { $gt: new Date(now.getTime() - OTP_TTL_MS) },
      consumedAt: { $exists: false },
      $or: [{ attempts: { $exists: false } }, { attempts: { $lt: OTP_MAX_ATTEMPTS } }],
      $and: available,
    };
    const legacyCandidate = await this.otpModel
      .findOne(legacyScope as any)
      .sort({ createdAt: -1 })
      .select('+code')
      .exec();

    if (legacyCandidate?.code === input.code) {
      const legacyClaim = await this.otpModel.findOneAndUpdate(
        {
          _id: legacyCandidate._id,
          code: input.code,
          consumedAt: { $exists: false },
          $or: [{ attempts: { $exists: false } }, { attempts: { $lt: OTP_MAX_ATTEMPTS } }],
          $and: available,
        },
        { $set: { processingUntil, processingToken } },
        { returnDocument: 'after' },
      ).select('+code').exec();
      if (legacyClaim) {
        legacyClaim.processingToken = processingToken;
        return legacyClaim;
      }
    } else if (legacyCandidate && legacyCandidate.code !== input.code) {
      const failedLegacyAttempt = await this.otpModel.findOneAndUpdate(
        {
          _id: legacyCandidate._id,
          $or: [{ attempts: { $exists: false } }, { attempts: { $lt: OTP_MAX_ATTEMPTS } }],
          $and: available,
        },
        { $inc: { attempts: 1 } },
        { returnDocument: 'after' },
      ).exec();
      if (failedLegacyAttempt && failedLegacyAttempt.attempts >= OTP_MAX_ATTEMPTS) {
        await this.otpModel.updateOne(
          { _id: failedLegacyAttempt._id },
          { $set: { lockedUntil: new Date(failedLegacyAttempt.createdAt.getTime() + OTP_TTL_MS) } },
        ).exec();
      }
    }

    const failedAttempt = await this.otpModel.findOneAndUpdate(
      {
        activeKey,
        codeHash: { $exists: true, $ne: otpHash },
        createdAt: { $gt: new Date(now.getTime() - OTP_TTL_MS) },
        attempts: { $lt: OTP_MAX_ATTEMPTS },
        $and: available,
      },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    ).exec();

    if (failedAttempt && failedAttempt.attempts >= OTP_MAX_ATTEMPTS) {
      await this.otpModel.updateOne(
        { _id: failedAttempt._id },
        { $set: { lockedUntil: new Date(failedAttempt.createdAt.getTime() + OTP_TTL_MS) } },
      ).exec();
    }

    throw new BadRequestException(OTP_GENERIC_ERROR);
  }

  private async completeOtp(otp: OtpDocument): Promise<void> {
    const result = await this.otpModel.updateOne(
      {
        _id: otp._id,
        consumedAt: { $exists: false },
        processingUntil: { $gt: new Date() },
        processingToken: otp.processingToken,
      },
      {
        $set: { consumedAt: new Date() },
        $unset: { activeKey: 1, processingUntil: 1, processingToken: 1, code: 1 },
      },
    ).exec();

    if (result.modifiedCount !== 1) {
      throw new ConflictException('Verification request expired. Please request a new code.');
    }
    otp.consumedAt = new Date();
  }

  private async releaseOtpClaim(otp: OtpDocument): Promise<void> {
    await this.otpModel.updateOne(
      {
        _id: otp._id,
        consumedAt: { $exists: false },
        processingToken: otp.processingToken,
      },
      { $unset: { processingUntil: 1, processingToken: 1 } },
    ).exec();
  }

  async verifyOtp(verifyOtpDto: VerifyOtpDto) {
    const normalizedEmail = verifyOtpDto.email.trim().toLowerCase();
    const pendingUser = await this.usersService.findByEmail(normalizedEmail);
    if (!pendingUser) throw new BadRequestException(OTP_GENERIC_ERROR);

    const otp = await this.claimOtp({
      email: normalizedEmail,
      userId: String(pendingUser._id),
      purpose: OtpPurpose.ACCOUNT_VERIFICATION,
      code: verifyOtpDto.code,
    });

    try {
      const user = await this.usersService.verifyUser(normalizedEmail);
      if (!user) {
        throw new BadRequestException('Account could not be verified. Please request a new code.');
      }

      if (user.verificationOnboardingPending) {
        await this.completeFirstVerification(user, pendingUser.pendingPromoCode);
        await this.usersService.clearPendingPromoCode(String(user._id));
        await this.usersService.completeVerificationOnboarding(String(user._id));
      }
      await this.completeOtp(otp);

      try {
        await this.notificationEvents.accountEmailVerified({ userId: String(user._id) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Account verified, but the verification notification could not be queued: ${message}`);
      }

      return { message: 'Account verified successfully.' };
    } catch (error) {
      await this.releaseOtpClaim(otp);
      throw error;
    }
  }

  async resendOtp(resendOtpDto: ResendOtpDto) {
    const email = resendOtpDto.email.trim().toLowerCase();
    const user = await this.usersService.findByEmail(email);
    if (!user || user.isVerified) {
      return { message: RESEND_GENERIC_RESPONSE };
    }

    try {
      await this.createOtp(email, String(user._id));
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        return { message: RESEND_GENERIC_RESPONSE };
      }
      throw error;
    }

    return { message: RESEND_GENERIC_RESPONSE };
  }

  async createEmailChangeIdentityOtp(
    userId: string,
    currentEmail: string,
    targetEmail: string,
  ) {
    const normalizedCurrent = currentEmail.trim().toLowerCase();
    const normalizedTarget = targetEmail.trim().toLowerCase();
    if (normalizedCurrent === normalizedTarget) {
      throw new BadRequestException('The new email must differ from the current email.');
    }

    const issuedOtp = await this.createPurposeOtp(
      normalizedCurrent,
      OtpPurpose.EMAIL_CHANGE_CURRENT,
      { userId, targetEmail: normalizedTarget },
    );
    await this.otpModel.deleteMany({
      userId,
      purpose: OtpPurpose.EMAIL_CHANGE_NEW,
    }).exec();

    return {
      message: issuedOtp.message.startsWith('Verification email queued')
        ? 'A verification code was sent to your current email address.'
        : 'The verification code was created, but the email could not be queued. Please restart the email-change request if it does not arrive.',
    };
  }

  async verifyEmailChangeIdentity(userId: string, code: string) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException('Account not found.');

    const otp = await this.claimOtp({
      email: user.email,
      userId,
      purpose: OtpPurpose.EMAIL_CHANGE_CURRENT,
      code,
    });

    try {
      if (!otp.targetEmail) {
        throw new BadRequestException(OTP_GENERIC_ERROR);
      }

      const targetEmail = otp.targetEmail.trim().toLowerCase();
      const existing = await this.usersService.findByEmail(targetEmail);
      if (existing && String(existing._id) !== String(user._id)) {
        await this.completeOtp(otp);
        await this.otpModel.deleteMany({
          userId,
          purpose: OtpPurpose.EMAIL_CHANGE_NEW,
        }).exec();
        throw new ConflictException('The requested email address is already in use. Start the email-change process again.');
      }

      const issuedOtp = await this.createPurposeOtp(
        targetEmail,
        OtpPurpose.EMAIL_CHANGE_NEW,
        { userId, targetEmail },
      );
      await this.completeOtp(otp);
      return {
        message: issuedOtp.message.startsWith('Verification email queued')
          ? 'Your identity is verified. A second code was sent to the new email address.'
          : 'Your identity is verified, but the second verification email could not be queued. Restart the email-change request if it does not arrive.',
      };
    } catch (error) {
      if (!otp.consumedAt) await this.releaseOtpClaim(otp);
      throw error;
    }
  }

  async verifyEmailChangeNewEmail(userId: string, code: string) {
    const currentUser = await this.usersService.findByIdForVerification(userId);
    if (!currentUser) throw new NotFoundException('Account not found.');

    const otp = await this.claimOtp({
      email: currentUser.email,
      userId,
      purpose: OtpPurpose.EMAIL_CHANGE_NEW,
      code,
    });

    try {
      if (!otp.targetEmail) throw new BadRequestException(OTP_GENERIC_ERROR);
      const targetEmail = otp.targetEmail.trim().toLowerCase();
      const existing = await this.usersService.findByEmail(targetEmail);
      if (existing && String(existing._id) !== String(currentUser._id)) {
        throw new ConflictException('The new email address is already in use.');
      }

      const needsFirstVerification =
        !currentUser.isVerified || currentUser.verificationOnboardingPending;
      const pendingPromoCode = currentUser.pendingPromoCode;
      let updatedUser: Awaited<ReturnType<UsersService['changeEmailAndVerify']>>;
      try {
        updatedUser = await this.usersService.changeEmailAndVerify(
          userId,
          targetEmail,
          needsFirstVerification,
        );
      } catch (error) {
        if (this.isDuplicateKeyError(error)) {
          throw new ConflictException('The new email address is already in use.');
        }
        throw error;
      }
      if (!updatedUser) throw new NotFoundException('Account could not be updated.');

      if (needsFirstVerification) {
        await this.completeFirstVerification(updatedUser, pendingPromoCode);
        await this.usersService.clearPendingPromoCode(userId);
        await this.usersService.completeVerificationOnboarding(userId);
      }

      await this.completeOtp(otp);
      try {
        await this.notificationEvents.accountEmailChanged({
          userId: String(updatedUser._id),
          email: updatedUser.email,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Email changed, but the account notification could not be queued: ${message}`);
      }

      await this.otpModel.deleteMany({
        userId,
        purpose: OtpPurpose.EMAIL_CHANGE_CURRENT,
      }).exec();

      return {
        message: 'Email changed and verified successfully.',
        email: updatedUser.email,
        isVerified: true,
      };
    } catch (error) {
      await this.releaseOtpClaim(otp);
      throw error;
    }
  }

  private async queueWelcomeEmailSafely(user: {
    _id: unknown;
    email: string;
    fullName: string;
  }) {
    try {
      await this.emailDelivery.enqueueWelcome({
        recipientId: String(user._id),
        email: user.email,
        fullName: user.fullName,
        dedupeKey: `welcome:${String(user._id)}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Welcome email could not be queued; account verification remains complete: ${message}`);
    }
  }

  private async completeFirstVerification(
    user: {
      _id: unknown;
      email: string;
      fullName: string;
      username: string;
      phoneNumber?: string;
      referredBy?: string;
    },
    pendingPromoCode?: string,
  ) {
    if (user.referredBy) {
      const referral = await this.referralsService.createReferral(
        String(user.referredBy),
        String(user._id),
      );
      if (referral) {
        await this.promoEngineService.checkUserPromos(
          String(referral.referrerId),
        );
      }
    }
    if (pendingPromoCode) {
      await this.promoEngineService.joinDirectCampaign(
        pendingPromoCode,
        String(user._id),
      );
      // Also resumes any direct-campaign reward that was persisted but not
      // completed during an earlier verification-onboarding attempt.
      await this.promoEngineService.checkUserPromos(String(user._id));
    }
    await this.queueWelcomeEmailSafely(user);
    try {
      await this.notificationEvents.accountWelcome({ userId: String(user._id) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Welcome notification could not be queued: ${message}`);
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
