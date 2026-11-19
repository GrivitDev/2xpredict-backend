import { SportsQueueService } from './sports-queue.service';
import { SportsQueueJobStatus, SportsQueueJobType } from '../interfaces/sports-queue.interface';

describe('SportsQueueService YouTube highlight priority migration', () => {
  it('updates pending YouTube jobs by league without touching other job types or statuses', async () => {
    const exec = jest.fn().mockResolvedValue({ modifiedCount: 12 });
    const updateMany = jest.fn(() => ({ exec }));
    const service = new SportsQueueService({ updateMany } as any);

    await expect(
      service.reprioritizePendingYoutubeHighlightJobs({
        'eng.1': 40,
        'usa.1': 30,
      }),
    ).resolves.toBe(12);

    expect(updateMany).toHaveBeenCalledWith(
      {
        type: SportsQueueJobType.YOUTUBE_HIGHLIGHT,
        status: SportsQueueJobStatus.PENDING,
        'scope.leagueId': { $in: ['eng.1', 'usa.1'] },
      },
      [
        {
          $set: {
            priority: {
              $switch: {
                branches: [
                  { case: { $eq: ['$scope.leagueId', 'eng.1'] }, then: 40 },
                  { case: { $eq: ['$scope.leagueId', 'usa.1'] }, then: 30 },
                ],
                default: '$priority',
              },
            },
          },
        },
      ],
    );
  });
});
