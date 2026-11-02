import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { OtpService } from '../../otp/otp.service';
import { UsersService } from '../../users/users.service';
import { SupportActionAudit } from '../schemas/support-action-audit.schema';

export type SafeRepairAction = 'resend_account_verification';

@Injectable()
export class SupportActionService {
  constructor(
    private readonly usersService: UsersService,
    private readonly otpService: OtpService,
    @InjectModel(SupportActionAudit.name)
    private readonly auditModel: Model<SupportActionAudit>,
  ) {}

  /**
   * Explicit allowlist only. The AI cannot provide arbitrary collection names,
   * database filters, service methods, URLs, or executable commands.
   */
  async execute(
    userId: string,
    action: string,
    conversationId?: string,
  ): Promise<Record<string, unknown>> {
    if (!Types.ObjectId.isValid(userId)) throw new BadRequestException('Invalid authenticated user.');
    const startedAt = Date.now();

    if (action !== 'resend_account_verification') {
      await this.writeAudit(userId, conversationId, action, 'DENIED', 'Action is not in the approved repair allowlist.', startedAt);
      throw new BadRequestException('This support action is not approved for automatic execution.');
    }

    try {
      const user = await this.usersService.findById(userId);
      if (!user) throw new BadRequestException('The account could not be found.');
      if (user.isVerified) throw new BadRequestException('This account is already verified; no verification email was resent.');
      if (!user.email) throw new BadRequestException('No email address is recorded for this account.');

      // Reuse the existing OTP business logic so its cooldown, account lookup,
      // code creation and email delivery rules remain authoritative.
      const result = await this.otpService.resendOtp({ email: user.email });
      await this.writeAudit(userId, conversationId, action, 'SUCCEEDED', 'Verification resend requested through the existing OTP service.', startedAt);
      return { success: true, message: result?.message ?? 'Verification email request completed.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The repair failed.';
      await this.writeAudit(userId, conversationId, action, 'FAILED', message.slice(0, 800), startedAt);
      throw error;
    }
  }

  private async writeAudit(
    userId: string,
    conversationId: string | undefined,
    actionName: string,
    outcome: 'SUCCEEDED' | 'FAILED' | 'DENIED',
    summary: string,
    startedAt: number,
  ): Promise<void> {
    await this.auditModel.create({
      userId: new Types.ObjectId(userId),
      ...(conversationId && Types.ObjectId.isValid(conversationId) ? { conversationId: new Types.ObjectId(conversationId) } : {}),
      actionName: actionName.slice(0, 100),
      actionType: 'REPAIR',
      outcome,
      summary: redactActionText(summary).slice(0, 2000),
      details: { source: 'customer-care-ai', executionMode: 'allowlisted-existing-service' },
      durationMs: Math.max(0, Date.now() - startedAt),
    });
  }
}

function redactActionText(value: string): string {
  return String(value ?? '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:otp|verification code|one-time code)\s*[:#-]?\s*\d{4,8}\b/gi, '[verification code redacted]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[payment number redacted]');
}
