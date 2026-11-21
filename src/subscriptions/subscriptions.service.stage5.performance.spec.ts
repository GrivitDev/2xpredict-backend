import { SubscriptionsService } from './subscriptions.service';
import { BonusStatus } from '../bonuses/enums/bonus-status.enum';
import { BonusType } from '../bonuses/enums/bonus-type.enum';

describe('SubscriptionsService Stage 5 bonus entitlement lookup', () => {
  const userId = '507f1f77bcf86cd799439011';
  const startsAt = new Date('2026-11-01T00:00:00.000Z');
  const expiresAt = new Date('2026-12-01T00:00:00.000Z');

  const createService = (options?: {
    grants?: Array<Record<string, unknown>>;
    user?: { isVerified?: boolean } | null;
  }) => {
    const aggregateExec = jest
      .fn()
      .mockResolvedValue(options?.grants ?? []);
    const bonusGrantModel = {
      aggregate: jest.fn().mockReturnValue({ exec: aggregateExec }),
    };
    const usersService = {
      findById: jest.fn().mockResolvedValue(
        options && 'user' in options ? options.user : { isVerified: true },
      ),
    };

    const service = new SubscriptionsService(
      {} as any,
      bonusGrantModel as any,
      {} as any,
      usersService as any,
      {} as any,
      {} as any,
    );

    return { service, bonusGrantModel, aggregateExec, usersService };
  };

  it('uses one aggregation while preserving premium > vip > regular precedence and latest expiry within each tier', async () => {
    const { service, bonusGrantModel, usersService } = createService({
      grants: [{ plan: 'premium', startsAt, expiresAt }],
    });

    const result = await service.getActiveSubscriptionBonus(userId);

    expect(bonusGrantModel.aggregate).toHaveBeenCalledTimes(1);
    const pipeline = bonusGrantModel.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({
      $match: {
        userId,
        type: BonusType.SUBSCRIPTION,
        status: BonusStatus.GRANTED,
        startsAt: expect.objectContaining({ $lte: expect.any(Date) }),
        expiresAt: expect.objectContaining({ $gt: expect.any(Date) }),
        plan: { $in: ['premium', 'vip', 'regular'] },
      },
    });
    expect(pipeline[1]).toEqual({ $sort: { expiresAt: -1 } });
    expect(pipeline[2]).toEqual({
      $group: { _id: '$plan', grant: { $first: '$$ROOT' } },
    });
    expect(pipeline[3].$addFields.__planPriority.$switch.branches).toEqual([
      { case: { $eq: ['$_id', 'premium'] }, then: 3 },
      { case: { $eq: ['$_id', 'vip'] }, then: 2 },
      { case: { $eq: ['$_id', 'regular'] }, then: 1 },
    ]);
    expect(pipeline).toContainEqual({ $limit: 1 });
    expect(usersService.findById).toHaveBeenCalledTimes(1);
    expect(usersService.findById).toHaveBeenCalledWith(userId);
    expect(result).toEqual({ plan: 'premium', startsAt, expiresAt });
  });

  it('does not load the user when no active subscription bonus exists', async () => {
    const { service, usersService, bonusGrantModel } = createService({
      grants: [],
    });

    await expect(service.getActiveSubscriptionBonus(userId)).resolves.toBeNull();

    expect(bonusGrantModel.aggregate).toHaveBeenCalledTimes(1);
    expect(usersService.findById).not.toHaveBeenCalled();
  });

  it('does not grant an active bonus entitlement to an unverified account', async () => {
    const { service, usersService } = createService({
      grants: [{ plan: 'vip', startsAt, expiresAt }],
      user: { isVerified: false },
    });

    await expect(service.getActiveSubscriptionBonus(userId)).resolves.toBeNull();

    expect(usersService.findById).toHaveBeenCalledWith(userId);
  });
});
