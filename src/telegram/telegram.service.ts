// src/telegram/telegram.service.ts

import { Injectable, Logger } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { Telegraf } from 'telegraf';

import { UserHandler } from './handlers/user.handler';

import { PaymentHandler } from './handlers/payment.handler';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  private readonly bot: Telegraf;

  private readonly adminGroupId: string;

  /** Public channel destination; kept separate from the existing admin group. */
  private readonly infoGroupId: string;

  constructor(
    private readonly config: ConfigService,

    private readonly userHandler: UserHandler,

    private readonly paymentHandler: PaymentHandler,
  ) {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');

    this.adminGroupId =
      this.config.get<string>('TELEGRAM_ADMIN_GROUP_ID') || '';

    this.infoGroupId = this.config.get<string>('TELEGRAM_INFO_GROUP_ID') || '';

    this.bot = new Telegraf(token || '');
  }

  /**
   * Send a public broadcast without changing the destination of the existing
   * sendMessage() method. Customer-specific support details must never use this.
   */
  async sendPublicChannelMessage(message: string): Promise<{
    success: boolean;
    messageId?: number;
    deliveryUnknown?: boolean;
  }> {
    if (!this.infoGroupId) {
      this.logger.warn(
        'Public Telegram channel is not configured (TELEGRAM_INFO_GROUP_ID).',
      );
      return { success: false };
    }

    if (!this.config.get<string>('TELEGRAM_BOT_TOKEN')) {
      this.logger.error('Telegram bot token is not configured.');
      return { success: false };
    }

    try {
      const sent = await this.bot.telegram.sendMessage(
        this.infoGroupId,
        message,
        {
          link_preview_options: { is_disabled: false },
        },
      );
      return { success: true, messageId: sent.message_id };
    } catch (error) {
      this.logger.error(
        `Public Telegram channel delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const apiError = error as {
        response?: { error_code?: number; statusCode?: number };
      };
      const httpCode = Number(
        apiError?.response?.error_code ?? apiError?.response?.statusCode,
      );
      // A network timeout may occur after Telegram accepted the message. Avoid
      // an automatic duplicate in that ambiguous case; make an administrator verify.
      const deliveryUnknown = !Number.isFinite(httpCode) || httpCode >= 500;
      return { success: false, deliveryUnknown };
    }
  }

  // ==========================================================
  // SEND MESSAGE
  // ==========================================================

  async sendMessage(message: string): Promise<boolean> {
    try {
      await this.bot.telegram.sendMessage(this.adminGroupId, message);

      return true;
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));

      return false;
    }
  }

  // ==========================================================
  // SEND PHOTO
  // ==========================================================

  async sendPhoto(photoUrl: string, caption: string): Promise<boolean> {
    try {
      await this.bot.telegram.sendPhoto(this.adminGroupId, photoUrl, {
        caption,
      });

      return true;
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));

      return false;
    }
  }

  // ==========================================================
  // COMMUNITY DISCUSSION
  // ==========================================================

  async sendCommunityDiscussion(data: {
    title?: string;

    message?: string;

    category?: string;
  }): Promise<boolean> {
    const text = [
      '⚽ 2xPREDICT DISCUSSION',
      '',
      data.title ? `📌 ${data.title}` : '',
      '',
      data.message || '',
      '',
      data.category ? `#${this.formatHashtag(data.category)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return this.sendMessage(text.trim());
  }

  // ==========================================================
  // COMMUNITY NEWS POST
  // ==========================================================

  async sendCommunityNewsPost(data: {
    title?: string;

    message?: string;

    category?: string;

    imageUrl: string;
  }): Promise<boolean> {
    const caption = [
      '📰 2xPREDICT NEWS',
      '',
      data.title ? `📌 ${data.title}` : '',
      '',
      data.message || '',
      '',
      data.category ? `#${this.formatHashtag(data.category)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return this.sendPhoto(data.imageUrl, caption.trim());
  }

  // ==========================================================
  // FORMAT HASHTAG
  // ==========================================================

  private formatHashtag(value: string): string {
    return value.trim().replace(/[^a-zA-Z0-9]+/g, '');
  }

  // ==========================================================
  // NEW USER
  // ==========================================================

  async notifyNewUser(data: {
    fullName: string;

    username: string;

    email: string;

    phoneNumber: string;

    referred: boolean;

    referredBy?: {
      id: string;

      fullName: string;

      username: string;

      email: string;
    };
  }) {
    const message = this.userHandler.buildNewUserMessage(data);

    return this.sendMessage(message);
  }

  // ==========================================================
  // NEW REGISTRATION
  // ==========================================================

  async notifyNewRegistration(data: {
    fullName: string;

    username: string;

    email: string;

    phoneNumber: string;

    referred: boolean;
  }) {
    const message = this.userHandler.buildNewRegistrationMessage(data);

    return this.sendMessage(message);
  }

  // ==========================================================
  // NEW PAYMENT
  // ==========================================================

  async notifyNewPayment(data: {
    fullName: string;

    email: string;

    type: string;

    amount: number;

    currency: string;

    target: string;

    proofImageUrl?: string;
  }) {
    const message = this.paymentHandler.buildPaymentMessage(data);

    if (data.proofImageUrl) {
      return this.sendPhoto(data.proofImageUrl, message);
    }

    return this.sendMessage(message);
  }

  // ==========================================================
  // GATEWAY PAYMENT
  // ==========================================================

  async notifyGatewayPaymentReceived(data: {
    gateway: 'paystack';

    fullName: string;

    email: string;

    amount: number;

    currency: string;

    type: 'subscription' | 'vip_upgrade' | 'premium_upgrade';

    target: string;

    reference: string;

    transactionId: string;
  }) {
    const symbol = data.currency === 'USD' ? '$' : '₦';

    const message = `
💳 GATEWAY PAYMENT RECEIVED

━━━━━━━━━━━━━━━━━━━━

👤 CUSTOMER

Name:
${data.fullName}

Email:
${data.email}

━━━━━━━━━━━━━━━━━━━━

💰 PAYMENT

Gateway:
${data.gateway.toUpperCase()}

Type:
${data.type.replace('_', ' ').toUpperCase()}

Target:
${data.target.toUpperCase()}

Amount:
${symbol}${data.amount.toLocaleString()}

Reference:
${data.reference}

Transaction ID:
${data.transactionId}

━━━━━━━━━━━━━━━━━━━━

Status:
⏳ AWAITING VERIFICATION

The payment gateway has reported a successful payment.

━━━━━━━━━━━━━━━━━━━━
`;

    return this.sendMessage(message.trim());
  }
}
