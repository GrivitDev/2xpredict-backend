import { Types } from 'mongoose';
import { UserSessionService } from './user-session.service';

describe('UserSessionService admin summary performance', () => {
  const userId = '64b000000000000000000001';
  let aggregate: jest.Mock;
  let countDocuments: jest.Mock;
  let service: UserSessionService;

  beforeEach(() => {
    aggregate = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue([
        {
          latestSessions: [
            {
              _id: 'session-latest',
              isActive: true,
              expiresAt: new Date(Date.now() + 60_000),
              lastActiveAt: new Date('2026-11-21T08:00:00.000Z'),
              device: 'Desktop',
            },
          ],
          // This candidate is outside the latest 10, but within the legacy
          // latest-100 window. The result must continue to expose it.
          currentSession: [
            {
              _id: 'session-current',
              isActive: true,
              expiresAt: new Date(Date.now() + 60_000),
              lastActiveAt: new Date('2026-11-20T08:00:00.000Z'),
              device: 'Mobile',
            },
          ],
          totalSessions: [{ count: 135 }],
          activeSessions: [{ count: 3 }],
        },
      ]),
    });
    countDocuments = jest.fn();
    service = new UserSessionService(
      { aggregate, countDocuments } as any,
      {} as any,
    );
  });

  it('returns the existing response shape and preserves latest-100 current-session selection', async () => {
    const result = await service.getSessionSummary(userId);

    expect(result).toEqual(
      expect.objectContaining({
        latestSessions: [
          expect.objectContaining({
            _id: 'session-latest',
            isActive: true,
            expired: false,
          }),
        ],
        totalSessions: 135,
        activeSessions: 3,
        lastLogin: new Date('2026-11-21T08:00:00.000Z'),
        currentSession: expect.objectContaining({
          _id: 'session-current',
          isActive: true,
          expired: false,
        }),
      }),
    );
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(countDocuments).not.toHaveBeenCalled();

    const pipeline = aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({ $match: { userId: new Types.ObjectId(userId) } });
    expect(pipeline[2].$facet.latestSessions).toEqual([{ $limit: 10 }]);
    expect(pipeline[2].$facet.currentSession[0]).toEqual({ $limit: 100 });
  });

  it('returns safe empty defaults when a user has no sessions', async () => {
    aggregate.mockReturnValue({ exec: jest.fn().mockResolvedValue([]) });

    await expect(service.getSessionSummary(userId)).resolves.toEqual({
      latestSessions: [],
      totalSessions: 0,
      activeSessions: 0,
      lastLogin: null,
      currentSession: null,
    });
  });
});
