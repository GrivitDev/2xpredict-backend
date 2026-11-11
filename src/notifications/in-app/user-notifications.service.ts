import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  UserNotification,
  UserNotificationDocument,
} from './schemas/user-notification.schema';
import { NotificationCategory } from './enums/notification-category.enum';
import { NotificationType } from './enums/notification-type.enum';
import { NotificationQueryDto } from './dto/notification-query.dto';
import { UserNotificationsGateway } from './user-notifications.gateway';

export interface CreateUserNotificationInput {
  recipientId: string;
  type: NotificationType;
  category: NotificationCategory;
  title: string;
  message: string;
  actionUrl?: string | null;
  data?: Record<string, unknown>;
  /** Stable business-event identifier. Required for idempotent retries. */
  dedupeKey: string;
}

const RETENTION_MONTHS = 18;
const SENSITIVE_DATA_KEY =
  /(password|secret|token|authorization|cookie|otp|verification.?code|account.?number|bank.?details)/i;

@Injectable()
export class UserNotificationsService implements OnModuleInit {
  private readonly logger = new Logger(UserNotificationsService.name);

  constructor(
    @InjectModel(UserNotification.name)
    private readonly notificationModel: Model<UserNotificationDocument>,
    private readonly gateway: UserNotificationsGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    // Explicitly ensure the declared notification indexes exist even when
    // production disables Mongoose autoIndex. This only indexes this collection.
    try {
      await this.notificationModel.createIndexes();
    } catch (error) {
      this.logger.error(
        `Could not ensure notification retention index: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Persists first, then emits a best-effort real-time event.
   * A duplicate business event returns the existing record and is not emitted again.
   */
  async create(
    input: CreateUserNotificationInput,
  ): Promise<Record<string, unknown>> {
    if (!Types.ObjectId.isValid(input.recipientId)) {
      throw new BadRequestException('Invalid notification recipient.');
    }

    const title = String(input.title ?? '').trim();
    const message = String(input.message ?? '').trim();
    const dedupeKey = String(input.dedupeKey ?? '').trim();
    if (!title || title.length > 120) {
      throw new BadRequestException('Notification title must be 1–120 characters.');
    }
    if (!message || message.length > 1200) {
      throw new BadRequestException('Notification message must be 1–1200 characters.');
    }
    if (!dedupeKey || dedupeKey.length > 180) {
      throw new BadRequestException('A valid notification deduplication key is required.');
    }

    const recipientId = new Types.ObjectId(input.recipientId);
    const existing = await this.notificationModel
      .findOne({ recipientId, dedupeKey })
      .exec();
    if (existing) return this.present(existing);

    const now = new Date();
    const notification = new this.notificationModel({
      recipientId,
      type: input.type,
      category: input.category,
      title,
      message,
      actionUrl: this.validateActionUrl(input.actionUrl),
      data: this.sanitizeData(input.data ?? {}),
      dedupeKey,
      readAt: null,
      expiresAt: addCalendarMonths(now, RETENTION_MONTHS),
    });

    try {
      await notification.save();
    } catch (error) {
      // A concurrent retry may win the unique-index race. Return its record.
      if (isDuplicateKeyError(error)) {
        const raced = await this.notificationModel
          .findOne({ recipientId, dedupeKey })
          .exec();
        if (raced) return this.present(raced);
      }
      throw error;
    }

    const presented = this.present(notification);
    try {
      this.gateway.emitToUser(input.recipientId, 'notification:new', presented);
    } catch (error) {
      // Persistence is authoritative. A socket failure must never undo it.
      this.logger.warn(
        `Real-time notification delivery failed: ${errorMessage(error)}`,
      );
    }

    return presented;
  }

  async listForUser(userId: string, query: NotificationQueryDto) {
    this.assertUserId(userId);
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const limit = Math.min(50, Math.max(1, Math.floor(Number(query.limit) || 20)));
    const filter: Record<string, unknown> = {
      recipientId: new Types.ObjectId(userId),
    };

    if (query.category) filter.category = query.category;
    if (query.unreadOnly) filter.readAt = null;

    const [items, total, unreadCount] = await Promise.all([
      this.notificationModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.notificationModel.countDocuments(filter).exec(),
      this.notificationModel
        .countDocuments({ recipientId: new Types.ObjectId(userId), readAt: null })
        .exec(),
    ]);

    return {
      items: items.map((item) => this.present(item)),
      unreadCount,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getUnreadCount(userId: string): Promise<{ unreadCount: number }> {
    this.assertUserId(userId);
    const unreadCount = await this.notificationModel
      .countDocuments({ recipientId: new Types.ObjectId(userId), readAt: null })
      .exec();
    return { unreadCount };
  }

  async markAsRead(userId: string, notificationId: string) {
    this.assertUserId(userId);
    if (!Types.ObjectId.isValid(notificationId)) {
      throw new BadRequestException('Invalid notification ID.');
    }

    const notification = await this.notificationModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(notificationId),
          recipientId: new Types.ObjectId(userId),
          readAt: null,
        },
        { $set: { readAt: new Date() } },
        { returnDocument: 'after' },
      )
      .exec();

    if (!notification) {
      const existing = await this.notificationModel
        .findOne({
          _id: new Types.ObjectId(notificationId),
          recipientId: new Types.ObjectId(userId),
        })
        .exec();
      if (!existing) throw new NotFoundException('Notification not found.');
      return this.present(existing);
    }

    const presented = this.present(notification);
    this.gateway.emitToUser(userId, 'notification:read', {
      notificationId,
      readAt: notification.readAt,
    });
    return presented;
  }

  async markAllAsRead(userId: string) {
    this.assertUserId(userId);
    const readAt = new Date();
    const result = await this.notificationModel
      .updateMany(
        { recipientId: new Types.ObjectId(userId), readAt: null },
        { $set: { readAt } },
      )
      .exec();

    this.gateway.emitToUser(userId, 'notification:read-all', { readAt });
    return { modifiedCount: result.modifiedCount ?? 0, readAt };
  }

  private assertUserId(userId: string): void {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('Invalid authenticated user.');
    }
  }

  private validateActionUrl(value?: string | null): string | null {
    if (!value) return null;
    const path = value.trim();
    // Only local application paths are allowed; do not store arbitrary redirect URLs.
    if (!path.startsWith('/') || path.startsWith('//') || path.length > 300) {
      throw new BadRequestException('Notification action URL must be a local path.');
    }
    return path;
  }

  private sanitizeData(value: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      if (SENSITIVE_DATA_KEY.test(key)) continue;
      if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) {
        output[key.slice(0, 80)] =
          typeof item === 'string' ? item.slice(0, 500) : item;
      } else if (Array.isArray(item)) {
        output[key.slice(0, 80)] = item.slice(0, 20).map((entry) =>
          typeof entry === 'string' ? entry.slice(0, 200) :
            typeof entry === 'number' || typeof entry === 'boolean' ? entry : null,
        );
      } else if (typeof item === 'object') {
        const nested = item as Record<string, unknown>;
        const safeNested: Record<string, unknown> = {};
        for (const [nestedKey, nestedValue] of Object.entries(nested).slice(0, 20)) {
          if (SENSITIVE_DATA_KEY.test(nestedKey)) continue;
          if (
            nestedValue === null ||
            ['string', 'number', 'boolean'].includes(typeof nestedValue)
          ) {
            safeNested[nestedKey.slice(0, 80)] =
              typeof nestedValue === 'string' ? nestedValue.slice(0, 300) : nestedValue;
          }
        }
        output[key.slice(0, 80)] = safeNested;
      }
    }
    return output;
  }

  private present(value: any): Record<string, unknown> {
    const item = typeof value?.toObject === 'function' ? value.toObject() : value;
    return {
      id: String(item._id),
      type: item.type,
      category: item.category,
      title: item.title,
      message: item.message,
      data: item.data ?? {},
      actionUrl: item.actionUrl ?? null,
      readAt: item.readAt ?? null,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
    };
  }
}

function addCalendarMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: number }).code === 11000,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
