import { BadRequestException, Injectable, InternalServerErrorException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { PlanConfig, PlanConfigDocument } from './schemas/plan-config.schema';

export const PAID_SUBSCRIPTION_DURATION_DAYS = 30;

const DEFAULT_PLAN_LABELS = {
  free: 'Free Plan',
  regular: 'Regular Plan',
  vip: 'VIP Plan',
  premium: 'Premium Plan',
};

const EDITABLE_FIELDS = [
  'regularPrice',
  'vipPrice',
  'premiumPrice',
  'bankDetails',
  'regularPriceUSD',
  'vipPriceUSD',
  'premiumPriceUSD',
  'bankDetailsUSD',
] as const;

@Injectable()
export class PlanConfigService implements OnModuleInit {
  private indexReady?: Promise<void>;
  private static readonly SINGLETON_KEY = 'primary' as const;
  constructor(
    @InjectModel(PlanConfig.name)
    private readonly model: Model<PlanConfigDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureSingletonIndex();
  }

  private ensureSingletonIndex(): Promise<void> {
    if (!this.indexReady) {
      this.indexReady = this.model.collection
        .createIndex(
          { configKey: 1 },
          {
            unique: true,
            partialFilterExpression: { configKey: { $type: 'string' } },
            name: 'plan_config_singleton_key_unique',
          },
        )
        .then(() => undefined);
    }
    return this.indexReady;
  }

  private async getOrCreateSingleton() {
    await this.ensureSingletonIndex();

    const singletonKey = PlanConfigService.SINGLETON_KEY;
    let config = await this.model.findOne({ configKey: singletonKey }).exec();
    if (config) return config;

    // Adopt the oldest legacy configuration instead of creating a second one.
    // The conditional update means concurrent adopters converge on one record.
    const legacy = await this.model
      .findOne({
        $or: [{ configKey: { $exists: false } }, { configKey: null }],
      })
      .sort({ createdAt: 1, _id: 1 })
      .exec();

    if (legacy) {
      config = await this.model
        .findOneAndUpdate(
          {
            _id: legacy._id,
            $or: [{ configKey: { $exists: false } }, { configKey: null }],
          },
          { $set: { configKey: singletonKey } },
          { returnDocument: 'after' },
        )
        .exec();
      if (config) return config;

      // Another process may have adopted the same legacy document first.
      config = await this.model.findOne({ configKey: singletonKey }).exec();
      if (config) return config;
    }

    // A fixed selector plus the unique partial index makes concurrent first
    // creation deterministic across application instances.
    try {
      config = await this.model
        .findOneAndUpdate(
          { configKey: singletonKey },
          {
            $setOnInsert: {
              configKey: singletonKey,
              subscriptionDurationDays: PAID_SUBSCRIPTION_DURATION_DAYS,
              planLabels: DEFAULT_PLAN_LABELS,
            },
          },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
        )
        .exec();
    } catch (error) {
      // Two application instances can race on the first upsert. The unique
      // index elects one winner; the other instance reads that committed row.
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? Number((error as { code?: unknown }).code)
          : 0;
      if (code !== 11000) throw error;
      config = await this.model.findOne({ configKey: singletonKey }).exec();
    }

    if (!config) {
      throw new InternalServerErrorException(
        'Plan configuration could not be initialized.',
      );
    }
    return config;
  }

  async get() {
    let config = await this.getOrCreateSingleton();
    let changed = false;

    // Existing configuration documents predate the Premium tier.
    if (!Number.isFinite(config.premiumPrice)) {
      config.premiumPrice = 100000;
      changed = true;
    }
    if (!Number.isFinite(config.premiumPriceUSD)) {
      config.premiumPriceUSD = 100;
      changed = true;
    }

    const currentLabels = (config.planLabels ?? {}) as Record<string, string>;
    const labels = {
      ...DEFAULT_PLAN_LABELS,
      ...currentLabels,
    };
    if (
      !currentLabels.free ||
      !currentLabels.regular ||
      !currentLabels.vip ||
      !currentLabels.premium
    ) {
      config.planLabels = labels;
      changed = true;
    }

    // Paid plans are always 30-day subscriptions; Free is represented by
    // the absence of an active paid subscription and never expires.
    if (config.subscriptionDurationDays !== PAID_SUBSCRIPTION_DURATION_DAYS) {
      config.subscriptionDurationDays = PAID_SUBSCRIPTION_DURATION_DAYS;
      changed = true;
    }

    if (changed) await config.save();
    return config;
  }

  async update(data: unknown) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new BadRequestException('A valid plan configuration object is required.');
    }

    const input = data as Record<string, unknown>;
    const allowed = new Set<string>([...EDITABLE_FIELDS, 'planLabels', 'subscriptionDurationDays']);
    const unsupported = Object.keys(input).filter((key) => !allowed.has(key));
    if (unsupported.length) {
      throw new BadRequestException(`Unsupported plan configuration field: ${unsupported[0]}.`);
    }

    for (const field of ['regularPrice', 'vipPrice', 'premiumPrice', 'regularPriceUSD', 'vipPriceUSD', 'premiumPriceUSD']) {
      if (Object.prototype.hasOwnProperty.call(input, field)) {
        const value = input[field];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
          throw new BadRequestException(`${field} must be a finite, non-negative number within the supported range.`);
        }
      }
    }

    for (const field of ['bankDetails', 'bankDetailsUSD']) {
      if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
      const value = input[field];
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BadRequestException(`${field} must be an object.`);
      }
      const bank = value as Record<string, unknown>;
      const allowedBankFields = new Set(['bankName', 'accountName', 'accountNumber', 'instructions']);
      const unknownBankFields = Object.keys(bank).filter((key) => !allowedBankFields.has(key));
      if (unknownBankFields.length) throw new BadRequestException(`Unsupported ${field} field: ${unknownBankFields[0]}.`);
      for (const key of allowedBankFields) {
        if (bank[key] !== undefined && (typeof bank[key] !== 'string' || bank[key].length > (key === 'instructions' ? 2000 : 160))) {
          throw new BadRequestException(`${field}.${key} must be a string within the supported length.`);
        }
      }
    }

    if (Object.prototype.hasOwnProperty.call(input, 'planLabels')) {
      const value = input.planLabels;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BadRequestException('planLabels must be an object.');
      }
      const labels = value as Record<string, unknown>;
      const allowedLabels = new Set(['free', 'regular', 'vip', 'premium']);
      const unknownLabels = Object.keys(labels).filter((key) => !allowedLabels.has(key));
      if (unknownLabels.length) throw new BadRequestException(`Unsupported plan label: ${unknownLabels[0]}.`);
      for (const [key, label] of Object.entries(labels)) {
        if (typeof label !== 'string' || !label.trim() || label.length > 80) {
          throw new BadRequestException(`planLabels.${key} must be a non-empty string of at most 80 characters.`);
        }
      }
    }

    const config = await this.get();
    for (const field of EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(input, field)) {
        Object.assign(config, { [field]: input[field] });
      }
    }

    if (input.planLabels && typeof input.planLabels === 'object') {
      config.planLabels = {
        ...DEFAULT_PLAN_LABELS,
        ...config.planLabels,
        ...(input.planLabels as Record<string, string>),
      };
    }

    // Ignore caller-provided durations so all paid plans remain 30 days.
    config.subscriptionDurationDays = PAID_SUBSCRIPTION_DURATION_DAYS;
    return config.save();
  }
}

