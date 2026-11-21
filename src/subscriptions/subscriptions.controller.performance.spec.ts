import { SubscriptionsController } from './subscriptions.controller';
import { getSubscriptionEntitlements } from './config/subscription-entitlements.config';

describe('SubscriptionsController status entitlement resolution', () => {
  it('resolves the effective subscription entitlement once and reuses its plan and subscription', async () => {
    const subscription = { _id: 'subscription-1', plan: 'vip' };
    const service = {
      getEffectiveEntitlement: jest.fn().mockResolvedValue({
        plan: 'vip',
        source: 'paid_subscription',
        subscription,
        bonus: null,
        startsAt: new Date('2026-11-01T00:00:00.000Z'),
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
      }),
    };
    const controller = new SubscriptionsController(
      service as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await controller.getStatus({ _id: 'user-1' });

    expect(service.getEffectiveEntitlement).toHaveBeenCalledTimes(1);
    expect(service.getEffectiveEntitlement).toHaveBeenCalledWith('user-1');
    expect(result).toEqual({
      plan: 'vip',
      subscription,
      entitlements: getSubscriptionEntitlements('vip'),
    });
  });
});
