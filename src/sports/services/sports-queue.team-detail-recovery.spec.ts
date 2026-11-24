import { SportsQueueJobType } from '../interfaces/sports-queue.interface';
import { SportsQueueService } from './sports-queue.service';

describe('SportsQueueService team-detail recovery lookup', () => {
  it('returns team IDs with a recent detail attempt across queue states', async () => {
    const query = {
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([
        { scope: { teamId: '21540' } },
        { scope: { teamId: 'team:359' } },
        { scope: {} },
      ]),
    };
    const find = jest.fn().mockReturnValue(query);
    const service = new SportsQueueService({ find } as any);
    const since = new Date('2026-10-25T00:00:00.000Z');

    await expect(
      service.getRecentTeamDetailJobTeamIds(
        ' ENG.1 ',
        ['team:21540', '359'],
        since,
      ),
    ).resolves.toEqual(new Set(['21540', '359']));

    expect(find).toHaveBeenCalledWith({
      type: SportsQueueJobType.TEAM_DETAIL_REFRESH,
      'scope.leagueId': 'eng.1',
      'scope.teamId': { $in: ['21540', '359', 'team:21540', 'team:359'] },
      updatedAt: { $gte: since },
    });
  });

  it('avoids a database query for an empty team set', async () => {
    const find = jest.fn();
    const service = new SportsQueueService({ find } as any);

    await expect(
      service.getRecentTeamDetailJobTeamIds('eng.1', [], new Date()),
    ).resolves.toEqual(new Set());
    expect(find).not.toHaveBeenCalled();
  });
});
