import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import { request as httpsRequest } from 'node:https';

export interface TelegramPublicBroadcastResult {
  success: boolean;
  messageId?: number;
  deliveryUnknown?: boolean;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  url: string;
}

interface TelegramPhotoMessage {
  message_id: number;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: {
    retry_after?: number;
  };
}

type ErrorRecord = Record<string, unknown>;

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);

  private readonly token: string;
  private readonly channelId: string;

  private readonly bot: Telegraf | null;

  constructor(private readonly config: ConfigService) {
    this.token = this.config.get<string>('TELEGRAM_BOT_TOKEN')?.trim() || '';

    this.channelId =
      this.config.get<string>('TELEGRAM_INFO_GROUP_ID')?.trim() || '';

    this.bot = this.token ? new Telegraf(this.token) : null;
  }

  // ======================================================
  // INITIALIZATION
  // ======================================================

  async onModuleInit(): Promise<void> {
    const bot = this.bot;

    if (!bot || !this.channelId) {
      this.logger.warn(
        'AI Telegram broadcasts are disabled until TELEGRAM_BOT_TOKEN and TELEGRAM_INFO_GROUP_ID are configured.',
      );
      return;
    }

    try {
      const identity = await bot.telegram.getMe();

      this.logger.log(
        `Telegram broadcast transport ready for @${identity.username || 'configured bot'}.`,
      );
    } catch (error) {
      this.logger.error(
        `Telegram startup connection check failed: ${this.formatError(error)}`,
      );
    }
  }

  // ======================================================
  // PUBLIC TEXT BROADCAST
  // ======================================================

  /**
   * Sends a standard HTML text broadcast.
   *
   * Promotion broadcasts continue to use this method.
   * The existing Telegraf text delivery path is retained.
   */
  async sendPublicChannelMessage(
    message: string,
  ): Promise<TelegramPublicBroadcastResult> {
    const bot = this.bot;
    const body = String(message ?? '').trim();

    if (!bot || !this.channelId) {
      this.logger.error(
        'Telegram broadcast rejected: bot token or channel ID is missing.',
      );

      return {
        success: false,
        deliveryUnknown: false,
      };
    }

    if (!body) {
      this.logger.error(
        'Telegram broadcast rejected: message content is empty.',
      );

      return {
        success: false,
        deliveryUnknown: false,
      };
    }

    if (body.length > 4096) {
      this.logger.error(
        `Telegram broadcast rejected: message contains ${body.length} characters; maximum is 4096.`,
      );

      return {
        success: false,
        deliveryUnknown: false,
      };
    }

    try {
      this.logger.log(
        `Sending public Telegram text broadcast (${body.length} characters).`,
      );

      const sent = await bot.telegram.sendMessage(this.channelId, body, {
        parse_mode: 'HTML',
        link_preview_options: {
          is_disabled: false,
        },
      });

      this.logger.log(
        `Telegram text broadcast successfully accepted. Message ID: ${sent.message_id}.`,
      );

      return {
        success: true,
        messageId: sent.message_id,
        deliveryUnknown: false,
      };
    } catch (error) {
      return this.handleDeliveryError(error, 'text');
    }
  }

  // ======================================================
  // PUBLIC PHOTO BROADCAST
  // ======================================================

  /**
   * Sends a branded photo post using a publicly accessible
   * HTTPS image URL.
   *
   * Uses Node.js native HTTPS with IPv4 forced for photo
   * delivery instead of Telegraf's node-fetch transport.
   *
   * Supports:
   * - HTML captions
   * - Inline keyboards
   * - Public HTTPS image URLs
   *
   * Telegram retrieves the image from the supplied URL.
   */
  async sendPublicChannelPhoto(
    photoUrl: string,
    caption: string,
    inlineKeyboard: TelegramInlineKeyboardButton[][] = [],
  ): Promise<TelegramPublicBroadcastResult> {
    const bot = this.bot;

    const photo = String(photoUrl ?? '').trim();
    const body = String(caption ?? '').trim();

    if (!bot || !this.channelId) {
      this.logger.error(
        'Telegram photo broadcast rejected: bot token or channel ID is missing.',
      );

      return {
        success: false,
        deliveryUnknown: false,
      };
    }

    if (!this.isPublicHttpsUrl(photo)) {
      this.logger.error(
        'Telegram photo broadcast rejected: the banner must be an absolute, public HTTPS URL.',
      );

      return {
        success: false,
        deliveryUnknown: false,
      };
    }

    if (!body) {
      this.logger.error(
        'Telegram photo broadcast rejected: caption content is empty.',
      );

      return {
        success: false,
        deliveryUnknown: false,
      };
    }

    // Telegram photo captions allow at most 1,024 characters.
    if (body.length > 1024) {
      this.logger.error(
        `Telegram photo broadcast rejected: caption contains ${body.length} characters; maximum is 1024.`,
      );

      return {
        success: false,
        deliveryUnknown: false,
      };
    }

    const keyboardRows = this.normaliseInlineKeyboard(inlineKeyboard);

    try {
      this.logger.log(
        `Sending public Telegram photo broadcast (caption: ${body.length} characters). Destination: ${this.channelId}.`,
      );

      // Direct HTTPS transport with IPv4.
      const sent = await this.sendPhotoDirect(photo, body, keyboardRows);

      this.logger.log(
        `Telegram photo broadcast successfully accepted. Message ID: ${sent.message_id}.`,
      );

      return {
        success: true,
        messageId: sent.message_id,
        deliveryUnknown: false,
      };
    } catch (error) {
      return this.handleDeliveryError(error, 'photo');
    }
  }

  // ======================================================
  // DIRECT TELEGRAM PHOTO TRANSPORT
  // ======================================================

  /**
   * Sends a photo directly through the Telegram Bot API.
   *
   * Uses Node.js native HTTPS and URL-encoded form data.
   *
   * IPv4 is explicitly enforced to avoid IPv6 connection
   * timeouts observed during local integration testing.
   *
   * A 45-second overall timeout covers connection,
   * request processing and response reception.
   */
  private sendPhotoDirect(
    photo: string,
    caption: string,
    keyboardRows: TelegramInlineKeyboardButton[][],
  ): Promise<TelegramPhotoMessage> {
    const endpoint = `/bot${this.token}/sendPhoto`;

    const form = new URLSearchParams();

    form.set('chat_id', this.channelId);
    form.set('photo', photo);
    form.set('caption', caption);
    form.set('parse_mode', 'HTML');

    if (keyboardRows.length > 0) {
      form.set(
        'reply_markup',
        JSON.stringify({
          inline_keyboard: keyboardRows,
        }),
      );
    }

    const body = Buffer.from(form.toString(), 'utf8');

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;

      const fail = (error: Error): void => {
        if (settled) return;

        settled = true;

        if (timeout) {
          clearTimeout(timeout);
        }

        reject(error);
      };

      const succeed = (result: TelegramPhotoMessage): void => {
        if (settled) return;

        settled = true;

        if (timeout) {
          clearTimeout(timeout);
        }

        resolve(result);
      };

      const request = httpsRequest(
        {
          hostname: 'api.telegram.org',
          port: 443,
          path: endpoint,
          method: 'POST',

          // Force IPv4.
          family: 4,

          // Use a fresh connection for this request.
          agent: false,

          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': body.length,
            Accept: 'application/json',
          },
        },
        (response) => {
          const chunks: Buffer[] = [];

          response.on('data', (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });

          response.on('aborted', () => {
            fail(
              Object.assign(new Error('Telegram response was aborted.'), {
                code: 'ECONNRESET',
              }),
            );
          });

          response.on('error', fail);

          response.on('end', () => {
            const responseText = Buffer.concat(chunks).toString('utf8');

            const statusCode = response.statusCode ?? 0;

            let result: TelegramApiResponse<TelegramPhotoMessage>;

            try {
              result = JSON.parse(
                responseText,
              ) as TelegramApiResponse<TelegramPhotoMessage>;
            } catch {
              const error = new Error(
                `Invalid Telegram response. HTTP status: ${statusCode}`,
              ) as Error & {
                response?: ErrorRecord;
              };

              error.response = {
                statusCode,
              };

              fail(error);
              return;
            }

            if (
              statusCode < 200 ||
              statusCode >= 300 ||
              !result.ok ||
              !result.result
            ) {
              const error = new Error(
                result.description ||
                  `Telegram photo delivery failed. HTTP status: ${statusCode}`,
              ) as Error & {
                response?: ErrorRecord;
              };

              error.response = {
                error_code: result.error_code,
                statusCode,
                description: result.description,
                parameters: result.parameters,
              };

              fail(error);
              return;
            }

            succeed(result.result);
          });
        },
      );

      request.on('error', fail);

      // Overall timeout, including connection establishment.
      timeout = setTimeout(() => {
        request.destroy(
          Object.assign(
            new Error('Telegram photo request timed out after 45 seconds.'),
            { code: 'ETIMEDOUT' },
          ),
        );
      }, 45_000);

      request.end(body);
    });
  }

  // ======================================================
  // INLINE KEYBOARD NORMALIZATION
  // ======================================================

  private normaliseInlineKeyboard(
    rows: TelegramInlineKeyboardButton[][],
  ): TelegramInlineKeyboardButton[][] {
    if (!Array.isArray(rows)) return [];

    return rows
      .slice(0, 8)
      .map((row) =>
        (Array.isArray(row) ? row : [])
          .slice(0, 8)
          .filter(
            (button) =>
              Boolean(button) &&
              typeof button.text === 'string' &&
              button.text.trim().length > 0 &&
              button.text.trim().length <= 64 &&
              this.isPublicHttpsUrl(button.url),
          )
          .map((button) => ({
            text: button.text.trim(),
            url: button.url.trim(),
          })),
      )
      .filter((row) => row.length > 0);
  }

  // ======================================================
  // URL VALIDATION
  // ======================================================

  private isPublicHttpsUrl(value: string): boolean {
    try {
      const parsed = new URL(value);

      return (
        parsed.protocol === 'https:' &&
        Boolean(parsed.hostname) &&
        !parsed.username &&
        !parsed.password
      );
    } catch {
      return false;
    }
  }

  // ======================================================
  // DELIVERY ERROR HANDLING
  // ======================================================

  private handleDeliveryError(
    error: unknown,
    deliveryType: 'text' | 'photo',
  ): TelegramPublicBroadcastResult {
    const statusCode = this.getStatusCode(error);

    // A transport failure or server-side failure may occur after
    // Telegram has received the request.
    //
    // Never retry an ambiguous delivery blindly because doing so
    // could produce duplicate public broadcasts.

    const deliveryUnknown =
      statusCode === undefined ||
      statusCode < 400 ||
      statusCode >= 500 ||
      statusCode === 408;

    this.logger.error(
      [
        `Public Telegram ${deliveryType} delivery failed.`,
        `HTTP/API status: ${statusCode ?? 'Unavailable'}.`,
        `Delivery outcome: ${deliveryUnknown ? 'UNKNOWN' : 'REJECTED'}.`,
        `Diagnostics: ${this.formatError(error)}`,
      ].join(' '),
    );

    return {
      success: false,
      deliveryUnknown,
    };
  }

  // ======================================================
  // HTTP STATUS EXTRACTION
  // ======================================================

  private getStatusCode(error: unknown): number | undefined {
    const record = asRecord(error);

    const response = asRecord(record?.response);

    const candidates = [
      response?.error_code,
      response?.statusCode,
      record?.code,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return candidate;
      }

      if (typeof candidate === 'string' && /^\d{3}$/.test(candidate)) {
        return Number(candidate);
      }
    }

    return undefined;
  }

  // ======================================================
  // ERROR DIAGNOSTICS
  // ======================================================

  private formatError(error: unknown): string {
    const record = asRecord(error);

    const response = asRecord(record?.response);

    const parameters = asRecord(response?.parameters);

    const cause = asRecord(record?.cause);

    const details = {
      name: safeString(record?.name, this.token),

      message: safeString(
        error instanceof Error ? error.message : (record?.message ?? error),
        this.token,
      ),

      code: record?.code,
      errno: record?.errno,

      syscall: safeString(record?.syscall, this.token),

      address: safeString(record?.address, this.token),

      port: record?.port,

      type: safeString(record?.type, this.token),

      cause: cause
        ? {
            name: safeString(cause.name, this.token),

            message: safeString(cause.message, this.token),

            code: cause.code,
            errno: cause.errno,

            syscall: safeString(cause.syscall, this.token),
          }
        : undefined,

      telegramResponse: response
        ? {
            errorCode: response.error_code,
            statusCode: response.statusCode,

            description: safeString(response.description, this.token),

            retryAfter: parameters?.retry_after,
          }
        : undefined,

      stack: safeString(record?.stack, this.token)?.slice(0, 3000),
    };

    return JSON.stringify(details);
  }
}

// ======================================================
// ERROR UTILITIES
// ======================================================

function asRecord(value: unknown): ErrorRecord | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  return value as ErrorRecord;
}

function safeString(value: unknown, token: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  let output: string;

  if (typeof value === 'string') {
    output = value;
  } else if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    output = String(value);
  } else if (typeof value === 'symbol') {
    output = value.description ?? '';
  } else {
    try {
      output = JSON.stringify(value) ?? '';
    } catch {
      output = '[Unserializable value]';
    }
  }

  // Prevent accidental bot-token exposure in logs.
  return token ? output.split(token).join('[REDACTED]') : output;
}
