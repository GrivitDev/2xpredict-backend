import { YoutubeService } from './youtube.service';

describe('YoutubeService channel lookup quota accounting', () => {
  it('does not consume the reserved daily search allowance for channels.list', async () => {
    const service = Object.create(YoutubeService.prototype) as any;
    service.channelIdByHandle = new Map();
    service.logger = { debug: jest.fn(), warn: jest.fn() };
    service.request = jest.fn().mockResolvedValue({
      items: [{ id: 'UCarsenal-channel' }],
    });

    await expect(service.resolveChannelId('@arsenal')).resolves.toBe(
      'UCarsenal-channel',
    );
    expect(service.request).toHaveBeenCalledWith(
      '/channels',
      'channel-lookup',
      expect.objectContaining({ forHandle: '@arsenal' }),
      { countTowardProviderQuota: false, minimumIntervalSeconds: 1 },
    );
  });
});
