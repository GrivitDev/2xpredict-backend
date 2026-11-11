import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { NotificationCategory } from '../in-app/enums/notification-category.enum';
import {
  NotificationPreference,
  NotificationPreferenceDocument,
} from './schemas/notification-preference.schema';

const ESSENTIAL_EMAIL_CATEGORIES = new Set<NotificationCategory>([
  NotificationCategory.ACCOUNT,
  NotificationCategory.PAYMENTS,
  NotificationCategory.SUBSCRIPTIONS,
]);

const DEFAULT_DISABLED_CATEGORIES = new Set<NotificationCategory>([
  NotificationCategory.PROMOTIONS,
  NotificationCategory.SYSTEM,
]);

export interface UpdateNotificationPreferencesInput {
  emailEnabled?: boolean;
  categories?: Record<string, boolean>;
}

@Injectable()
export class NotificationPreferencesService implements OnModuleInit {
  private readonly logger = new Logger(NotificationPreferencesService.name);

  constructor(
    @InjectModel(NotificationPreference.name)
    private readonly preferenceModel: Model<NotificationPreferenceDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.preferenceModel.createIndexes();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not ensure notification-preference indexes: ${message}`);
    }
  }

  async getForUser(recipientId: string) {
    this.assertRecipient(recipientId);
    const preference = await this.preferenceModel
      .findOne({ recipientId: new Types.ObjectId(recipientId) })
      .exec();

    const categories = Object.values(NotificationCategory).reduce(
      (result, category) => {
        result[category] = this.readCategory(preference, category);
        return result;
      },
      {} as Record<NotificationCategory, boolean>,
    );

    return {
      emailEnabled: preference?.emailEnabled ?? true,
      emailCategories: categories,
      essentialCategoriesLocked: [...ESSENTIAL_EMAIL_CATEGORIES],
      note: 'Essential account-security, payment and subscription emails cannot be disabled. Email preferences do not affect in-app notifications.',
    };
  }

  async updateForUser(
    recipientId: string,
    input: UpdateNotificationPreferencesInput,
  ) {
    this.assertRecipient(recipientId);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new BadRequestException('A valid preferences object is required.');
    }

    const updates: Record<string, unknown> = {};
    if (input.emailEnabled !== undefined) {
      if (typeof input.emailEnabled !== 'boolean') {
        throw new BadRequestException('emailEnabled must be a boolean.');
      }
      updates.emailEnabled = input.emailEnabled;
    }

    if (input.categories !== undefined) {
      if (
        !input.categories ||
        typeof input.categories !== 'object' ||
        Array.isArray(input.categories)
      ) {
        throw new BadRequestException('categories must be an object of boolean values.');
      }

      const validCategories = new Set<string>(Object.values(NotificationCategory));
      for (const [category, enabled] of Object.entries(input.categories)) {
        if (!validCategories.has(category)) {
          throw new BadRequestException(`Unknown notification category: ${category}.`);
        }
        if (typeof enabled !== 'boolean') {
          throw new BadRequestException(`The ${category} preference must be a boolean.`);
        }
        if (ESSENTIAL_EMAIL_CATEGORIES.has(category as NotificationCategory) && !enabled) {
          throw new BadRequestException(
            `${category} emails are essential and cannot be disabled.`,
          );
        }
        updates[`emailCategories.${category}`] = enabled;
      }
    }

    if (!Object.keys(updates).length) {
      return this.getForUser(recipientId);
    }

    await this.preferenceModel
      .findOneAndUpdate(
        { recipientId: new Types.ObjectId(recipientId) },
        { $set: updates },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true },
      )
      .exec();

    return this.getForUser(recipientId);
  }

  async isEmailAllowed(
    recipientId: string,
    category: NotificationCategory,
    essential: boolean,
  ): Promise<boolean> {
    if (essential || ESSENTIAL_EMAIL_CATEGORIES.has(category)) return true;
    this.assertRecipient(recipientId);

    const preference = await this.preferenceModel
      .findOne({ recipientId: new Types.ObjectId(recipientId) })
      .exec();

    if (preference?.emailEnabled === false) return false;
    return this.readCategory(preference, category);
  }

  private readCategory(
    preference: NotificationPreferenceDocument | null,
    category: NotificationCategory,
  ): boolean {
    const values = preference?.emailCategories as unknown;
    let stored: boolean | undefined;

    if (values instanceof Map) {
      stored = values.get(category);
    } else if (values && typeof values === 'object') {
      stored = (values as Record<string, boolean>)[category];
    }

    if (typeof stored === 'boolean') return stored;
    return !DEFAULT_DISABLED_CATEGORIES.has(category);
  }

  private assertRecipient(recipientId: string): void {
    if (!Types.ObjectId.isValid(recipientId)) {
      throw new BadRequestException('Invalid notification preference recipient.');
    }
  }
}
