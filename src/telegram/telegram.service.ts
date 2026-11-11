import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';

export interface TelegramPublicBroadcastResult {
  success: boolean;
  messageId?: number;
  deliveryUnknown?: boolean;
}

/**
 * Telegram is intentionally restricted to the existing AI-generated public
 * channel broadcasts. User linking, private notifications and admin alerts are
 * not part of the 2xPredict notification system.
 */
@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private readonly token: string;
  private readonly channelId: string;
  private readonly bot: Telegraf;

  constructor(private readonly config: ConfigService) {
    this.token = this.config.get<string>('TELEGRAM_BOT_TOKEN')?.trim() || '';
    this.channelId = this.config.get<string>('TELEGRAM_INFO_GROUP_ID')?.trim() || '';
    this.bot = new Telegraf(this.token);
  }

  async onModuleInit(): Promise<void> {
    if (!this.token || !this.channelId) {
      this.logger.warn(
        'AI Telegram broadcasts are disabled until TELEGRAM_BOT_TOKEN and TELEGRAM_INFO_GROUP_ID are configured.',
      );
      return;
    }
    try {
      const bot = await this.bot.telegram.getMe();
      this.logger.log(`AI Telegram broadcast transport ready for @${bot.username || 'configured bot'}.`);
    } catch (error) {
      this.logger.error(`Telegram broadcast transport could not initialise: ${errorMessage(error)}`);
    }
  }

  async sendPublicChannelMessage(message: string): Promise<TelegramPublicBroadcastResult> {
    const body = String(message ?? '').trim();
    if (!this.token || !this.channelId) {
      this.logger.warn('Telegram broadcast skipped: channel credentials are not configured.');
      return { success: false, deliveryUnknown: false };
    }
    if (!body) return { success: false, deliveryUnknown: false };
    if (body.length > 4096) {
      this.logger.error(`Telegram broadcast rejected because its HTML message is ${body.length} characters (maximum 4096).`);
      return { success: false, deliveryUnknown: false };
    }

    try {
      const sent = await this.bot.telegram.sendMessage(this.channelId, body, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: false },
      });
      return { success: true, messageId: sent.message_id, deliveryUnknown: false };
    } catch (error) {
      const response = (error as {
        response?: { error_code?: number; statusCode?: number; parameters?: { retry_after?: number } };
      })?.response;
      const code = Number(response?.error_code ?? response?.statusCode);
      const deliveryUnknown = !Number.isFinite(code) || code >= 500;
      this.logger.error(
        `Public Telegram channel delivery failed${Number.isFinite(code) ? ` (${code})` : ''}: ${errorMessage(error)}`,
      );
      return { success: false, deliveryUnknown };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
