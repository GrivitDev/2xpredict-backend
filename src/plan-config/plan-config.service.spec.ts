import { PlanConfigService, PAID_SUBSCRIPTION_DURATION_DAYS } from './plan-config.service';

const query = (value: any, error?: Error) => {
  const result: any = {
    exec: jest.fn().mockImplementation(() =>
      error ? Promise.reject(error) : Promise.resolve(value),
    ),
    sort: jest.fn().mockReturnThis(),
  };
  return result;
};

const configDocument = (overrides: Record<string, unknown> = {}) => ({
  configKey: 'primary',
  regularPrice: 10000,
  vipPrice: 50000,
  premiumPrice: 100000,
  regularPriceUSD: 10,
  vipPriceUSD: 50,
  premiumPriceUSD: 100,
  subscriptionDurationDays: 30,
  planLabels: {
    free: 'Free Plan',
    regular: 'Regular Plan',
    vip: 'VIP Plan',
    premium: 'Premium Plan',
  },
  save: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe('PlanConfigService singleton initialization', () => {
  const createService = (model: Record<string, any>) =>
    new PlanConfigService(model as any);

  it('creates the unique partial singleton index once', async () => {
    const model = {
      collection: { createIndex: jest.fn().mockResolvedValue('index-created') },
      findOne: jest.fn().mockReturnValue(query(configDocument())),
    };
    const service = createService(model);
    await service.onModuleInit();
    await service.get();
    expect(model.collection.createIndex).toHaveBeenCalledTimes(1);
    expect(model.collection.createIndex).toHaveBeenCalledWith(
      { configKey: 1 },
      expect.objectContaining({
        unique: true,
        partialFilterExpression: { configKey: { $type: 'string' } },
        name: 'plan_config_singleton_key_unique',
      }),
    );
  });

  it('uses a fixed-key upsert instead of an unconstrained create for first initialization', async () => {
    const created = configDocument();
    const model = {
      collection: { createIndex: jest.fn().mockResolvedValue('ok') },
      findOne: jest.fn()
        .mockReturnValueOnce(query(null))
        .mockReturnValueOnce(query(null)),
      findOneAndUpdate: jest.fn().mockReturnValue(query(created)),
    };
    const service = createService(model);
    const result = await service.get();

    expect(result).toBe(created);
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { configKey: 'primary' },
      {
        $setOnInsert: expect.objectContaining({
          configKey: 'primary',
          subscriptionDurationDays: PAID_SUBSCRIPTION_DURATION_DAYS,
        }),
      },
      expect.objectContaining({ upsert: true, returnDocument: 'after' }),
    );
  });

  it('adopts the oldest unkeyed legacy configuration instead of creating a second one', async () => {
    const legacy = configDocument({ configKey: undefined, _id: 'legacy-id' });
    const adopted = configDocument({ _id: 'legacy-id' });
    const model = {
      collection: { createIndex: jest.fn().mockResolvedValue('ok') },
      findOne: jest.fn()
        .mockReturnValueOnce(query(null))
        .mockReturnValueOnce(query(legacy)),
      findOneAndUpdate: jest.fn().mockReturnValue(query(adopted)),
    };
    const service = createService(model);
    const result = await service.get();

    expect(result).toBe(adopted);
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'legacy-id' }),
      { $set: { configKey: 'primary' } },
      { returnDocument: 'after' },
    );
    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('recovers from a duplicate-key race by reading the winning singleton', async () => {
    const duplicateKey = Object.assign(new Error('duplicate key'), { code: 11000 });
    const winner = configDocument();
    const model = {
      collection: { createIndex: jest.fn().mockResolvedValue('ok') },
      findOne: jest.fn()
        .mockReturnValueOnce(query(null))
        .mockReturnValueOnce(query(null))
        .mockReturnValueOnce(query(winner)),
      findOneAndUpdate: jest.fn().mockReturnValue(query(null, duplicateKey)),
    };
    const service = createService(model);
    await expect(service.get()).resolves.toBe(winner);
    expect(model.findOne).toHaveBeenLastCalledWith({ configKey: 'primary' });
  });
});
